use std::{collections::HashSet, path::Path};

use serde_json::{Value as WireJson, json};
use successor_protocol::{
	artifact::ArtifactHash,
	raw_event::RawEventArtifactRef,
	tool_catalog::{ToolAuthorityClassV0, ToolAuthorityRequestV0, ToolCatalogV0, ToolStatusV0},
};

use super::{catalog, find, grep, list_dir, read, search_files};

pub struct ToolRegistry;

#[derive(Debug, Clone)]
pub struct ToolExecution {
	pub payload:              WireJson,
	pub artifact:             RawEventArtifactRef,
	pub provider_result_text: String,
}

type ToolExecutor = fn(&Path, &WireJson) -> Result<ToolExecution, String>;

struct ExecutableTool {
	name:    &'static str,
	execute: ToolExecutor,
}

const EXECUTABLE_TOOLS: &[ExecutableTool] = &[
	ExecutableTool { name: "search_files", execute: execute_search_files },
	ExecutableTool { name: "read", execute: execute_read },
	ExecutableTool { name: "find", execute: execute_find },
	ExecutableTool { name: "grep", execute: execute_grep },
	ExecutableTool { name: "list_dir", execute: execute_list_dir },
];

pub const fn slice0_registry() -> ToolRegistry {
	ToolRegistry
}

#[rustfmt::skip]
const AUTHORITY_CANONICAL_ORDER: &[ToolAuthorityClassV0] = &[
	ToolAuthorityClassV0::SafeRead,
	ToolAuthorityClassV0::WorkspaceMutation,
	ToolAuthorityClassV0::LocalProcess,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolAuthorityResolutionError {
	DuplicateClass { class: ToolAuthorityClassV0 },
	ClassOutsideTrustedCeiling { class: ToolAuthorityClassV0 },
}

impl std::fmt::Display for ToolAuthorityResolutionError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::DuplicateClass { class } => {
				write!(f, "duplicate requested tool authority class `{class}`")
			},
			Self::ClassOutsideTrustedCeiling { class } => {
				write!(f, "requested tool authority class `{class}` exceeds trusted ceiling")
			},
		}
	}
}

impl std::error::Error for ToolAuthorityResolutionError {}

pub fn resolve_tool_authority_classes(
	request: Option<&ToolAuthorityRequestV0>,
	trusted_ceiling: &[ToolAuthorityClassV0],
) -> Result<Vec<ToolAuthorityClassV0>, ToolAuthorityResolutionError> {
	let requested =
		request.map_or(&[ToolAuthorityClassV0::SafeRead][..], |request| request.classes.as_slice());

	let mut seen = HashSet::new();
	for class in requested {
		if !seen.insert(*class) {
			return Err(ToolAuthorityResolutionError::DuplicateClass { class: *class });
		}
	}

	let ceiling: HashSet<ToolAuthorityClassV0> = trusted_ceiling.iter().copied().collect();
	for class in requested {
		if !ceiling.contains(class) {
			return Err(ToolAuthorityResolutionError::ClassOutsideTrustedCeiling { class: *class });
		}
	}

	Ok(AUTHORITY_CANONICAL_ORDER
		.iter()
		.copied()
		.filter(|class| seen.contains(class))
		.collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveToolAuthority {
	requested:       Option<Vec<ToolAuthorityClassV0>>,
	trusted_ceiling: Vec<ToolAuthorityClassV0>,
	classes:         Vec<ToolAuthorityClassV0>,
}

impl EffectiveToolAuthority {
	pub fn resolve(
		request: Option<&ToolAuthorityRequestV0>,
		trusted_ceiling: &[ToolAuthorityClassV0],
	) -> Result<Self, ToolAuthorityResolutionError> {
		let classes = resolve_tool_authority_classes(request, trusted_ceiling)?;
		let requested = request.map(|request| canonical_classes(&request.classes));
		Ok(Self { requested, trusted_ceiling: canonical_classes(trusted_ceiling), classes })
	}

	pub fn default_safe_read() -> Self {
		Self {
			requested:       None,
			trusted_ceiling: vec![ToolAuthorityClassV0::SafeRead],
			classes:         vec![ToolAuthorityClassV0::SafeRead],
		}
	}

	pub fn classes(&self) -> &[ToolAuthorityClassV0] {
		&self.classes
	}

	pub fn permits_executable_tool(&self, tool_name: &str) -> bool {
		ToolRegistry::tool_authority_class(tool_name)
			.is_some_and(|class| self.classes.contains(&class))
	}

	pub fn conditional_decision_payload(&self) -> Option<WireJson> {
		let default_safe_read = self.requested.is_none()
			&& self.trusted_ceiling == [ToolAuthorityClassV0::SafeRead]
			&& self.classes == [ToolAuthorityClassV0::SafeRead];
		if default_safe_read {
			return None;
		}

		Some(json!({
			"requested": self.requested.as_ref().map(|classes| class_labels(classes)),
			"trusted_ceiling": class_labels(&self.trusted_ceiling),
			"effective": class_labels(&self.classes),
		}))
	}
}

fn canonical_classes(classes: &[ToolAuthorityClassV0]) -> Vec<ToolAuthorityClassV0> {
	AUTHORITY_CANONICAL_ORDER
		.iter()
		.copied()
		.filter(|class| classes.contains(class))
		.collect()
}

fn class_labels(classes: &[ToolAuthorityClassV0]) -> Vec<&'static str> {
	classes
		.iter()
		.copied()
		.map(ToolAuthorityClassV0::as_str)
		.collect()
}

impl ToolRegistry {
	pub fn executable_names(&self) -> impl Iterator<Item = &'static str> + '_ {
		EXECUTABLE_TOOLS.iter().map(|tool| tool.name)
	}

	pub fn is_dispatchable(&self, tool_name: &str) -> bool {
		Self::executable(tool_name).is_some()
	}

	pub fn effective_catalog(&self, authority: &EffectiveToolAuthority) -> ToolCatalogV0 {
		let mut catalog = catalog::slice0_catalog();
		for tool in &mut catalog.tools {
			if tool.status == ToolStatusV0::Executable
				&& !authority.permits_executable_tool(&tool.name)
			{
				tool.status = ToolStatusV0::PolicyRejected;
			}
		}
		catalog
	}

	pub fn effective_executable_names<'a>(
		&'a self,
		authority: &'a EffectiveToolAuthority,
	) -> impl Iterator<Item = &'static str> + 'a {
		self
			.executable_names()
			.filter(move |tool_name| authority.permits_executable_tool(tool_name))
	}

	pub fn execute(
		&self,
		workspace_root: &Path,
		tool_name: &str,
		arguments: &WireJson,
	) -> Result<ToolExecution, String> {
		let Some(tool) = Self::executable(tool_name) else {
			return Err(format!(
				"tool `{tool_name}` is executable per the catalog but has no dispatch wiring"
			));
		};
		(tool.execute)(workspace_root, arguments)
	}

	pub fn execute_authorized(
		&self,
		workspace_root: &Path,
		tool_name: &str,
		arguments: &WireJson,
		authority: &EffectiveToolAuthority,
	) -> Result<ToolExecution, String> {
		if !authority.permits_executable_tool(tool_name) {
			return Err(format!("tool `{tool_name}` is not permitted by effective tool authority"));
		}
		self.execute(workspace_root, tool_name, arguments)
	}

	fn executable(tool_name: &str) -> Option<&'static ExecutableTool> {
		let status = catalog::tool_status(tool_name)?;
		if status != ToolStatusV0::Executable {
			return None;
		}
		EXECUTABLE_TOOLS.iter().find(|tool| tool.name == tool_name)
	}

	fn tool_authority_class(tool_name: &str) -> Option<ToolAuthorityClassV0> {
		Self::executable(tool_name).map(|_| ToolAuthorityClassV0::SafeRead)
	}
}

fn artifact_ref(
	sha256: ArtifactHash,
	byte_length: u64,
	media_type: &str,
	preview: &str,
	bytes: &[u8],
) -> RawEventArtifactRef {
	RawEventArtifactRef {
		artifact_id: None,
		sha256,
		byte_length,
		media_type: media_type.to_owned(),
		encoding: Some("utf-8".to_owned()),
		preview: Some(preview.to_owned()),
		content: Some(String::from_utf8_lossy(bytes).into_owned()),
	}
}

const MAX_PROVIDER_VISIBLE_READ_BYTES: usize = 200_000;

fn bound_provider_visible_text(text: &str) -> String {
	if text.len() <= MAX_PROVIDER_VISIBLE_READ_BYTES {
		return text.to_owned();
	}

	let mut boundary = MAX_PROVIDER_VISIBLE_READ_BYTES;
	while !text.is_char_boundary(boundary) {
		boundary -= 1;
	}
	format!("{}\n...[truncated: showing {boundary} of {} bytes]", &text[..boundary], text.len())
}

fn execute_search_files(
	workspace_root: &Path,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: search_files::SearchFilesArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result = search_files::search_files(workspace_root, &args.query, args.max_matches)
		.map_err(|err| err.to_string())?;
	let preview = result
		.matches
		.first()
		.map_or_else(|| "no matches".to_owned(), |m| m.path.clone());
	let payload = json!({ "source_kind": "tool_result", "tool_name": "search_files", "matches": result.matches });
	let provider_result_text = payload.to_string();
	Ok(ToolExecution {
		payload,
		artifact: artifact_ref(
			result.sha256.clone(),
			result.byte_length,
			"application/json",
			&preview,
			&result.bytes,
		),
		provider_result_text,
	})
}

fn execute_read(workspace_root: &Path, arguments: &WireJson) -> Result<ToolExecution, String> {
	let args: read::ReadArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let content = read::read(workspace_root, &args.path, args.offset, args.limit)
		.map_err(|err| err.to_string())?;
	let text = String::from_utf8_lossy(&content.bytes).into_owned();
	let preview = text.strip_suffix('\n').unwrap_or(&text);
	let provider_result_text = bound_provider_visible_text(&text);
	Ok(ToolExecution {
		payload: json!({
			"source_kind": "tool_result",
			"tool_name": "read",
			"path": args.path,
			"truncated": false,
			"preview": preview,
		}),
		artifact: artifact_ref(
			content.sha256.clone(),
			content.byte_length,
			"text/plain",
			preview,
			&content.bytes,
		),
		provider_result_text,
	})
}

fn execute_list_dir(workspace_root: &Path, arguments: &WireJson) -> Result<ToolExecution, String> {
	let args: list_dir::ListDirArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result = list_dir::list_dir(workspace_root, &args.path).map_err(|err| err.to_string())?;
	let payload = json!({ "source_kind": "tool_result", "tool_name": "list_dir", "entries": result.entries, "truncated": result.truncated });
	let provider_result_text = payload.to_string();
	Ok(ToolExecution {
		payload,
		artifact: artifact_ref(
			result.sha256.clone(),
			result.byte_length,
			"application/json",
			"list_dir results",
			&result.bytes,
		),
		provider_result_text,
	})
}

fn execute_find(workspace_root: &Path, arguments: &WireJson) -> Result<ToolExecution, String> {
	let args: find::FindArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result = find::find(workspace_root, &args.glob, 2_000).map_err(|err| err.to_string())?;
	let payload =
		json!({ "source_kind": "tool_result", "tool_name": "find", "matches": result.entries });
	let provider_result_text = payload.to_string();
	Ok(ToolExecution {
		payload,
		artifact: artifact_ref(
			result.sha256.clone(),
			result.byte_length,
			"application/json",
			"find results",
			&result.bytes,
		),
		provider_result_text,
	})
}

fn execute_grep(workspace_root: &Path, arguments: &WireJson) -> Result<ToolExecution, String> {
	let args: grep::GrepArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result = grep::grep(workspace_root, &args.pattern, 2_000).map_err(|err| err.to_string())?;
	let payload =
		json!({ "source_kind": "tool_result", "tool_name": "grep", "matches": result.matches });
	let provider_result_text = payload.to_string();
	Ok(ToolExecution {
		payload,
		artifact: artifact_ref(
			result.sha256.clone(),
			result.byte_length,
			"application/json",
			"grep results",
			&result.bytes,
		),
		provider_result_text,
	})
}

#[cfg(test)]
mod tests {
	use successor_protocol::tool_catalog::{ToolAuthorityClassV0, ToolAuthorityRequestV0};

	use super::{ToolAuthorityResolutionError, resolve_tool_authority_classes};

	const SAFE_READ_CEILING: &[ToolAuthorityClassV0] = &[ToolAuthorityClassV0::SafeRead];
	const FULL_CEILING: &[ToolAuthorityClassV0] = &[
		ToolAuthorityClassV0::SafeRead,
		ToolAuthorityClassV0::WorkspaceMutation,
		ToolAuthorityClassV0::LocalProcess,
	];

	#[test]
	fn authority_absence_canonicalizes_to_safe_read() {
		assert_eq!(
			resolve_tool_authority_classes(None, SAFE_READ_CEILING).expect("absent request resolves"),
			vec![ToolAuthorityClassV0::SafeRead]
		);
	}

	#[test]
	fn explicit_safe_read_within_ceiling_resolves() {
		let request = ToolAuthorityRequestV0 { classes: vec![ToolAuthorityClassV0::SafeRead] };
		assert_eq!(
			resolve_tool_authority_classes(Some(&request), SAFE_READ_CEILING)
				.expect("safe_read request resolves"),
			vec![ToolAuthorityClassV0::SafeRead]
		);
	}

	#[test]
	fn explicit_request_is_deterministically_canonical_ordered() {
		let request = ToolAuthorityRequestV0 {
			classes: vec![
				ToolAuthorityClassV0::LocalProcess,
				ToolAuthorityClassV0::SafeRead,
				ToolAuthorityClassV0::WorkspaceMutation,
			],
		};
		assert_eq!(
			resolve_tool_authority_classes(Some(&request), FULL_CEILING)
				.expect("full request resolves"),
			vec![
				ToolAuthorityClassV0::SafeRead,
				ToolAuthorityClassV0::WorkspaceMutation,
				ToolAuthorityClassV0::LocalProcess,
			]
		);
	}

	#[test]
	fn duplicate_requested_classes_are_rejected_not_deduped() {
		let request = ToolAuthorityRequestV0 {
			classes: vec![ToolAuthorityClassV0::SafeRead, ToolAuthorityClassV0::SafeRead],
		};
		assert_eq!(
			resolve_tool_authority_classes(Some(&request), FULL_CEILING),
			Err(ToolAuthorityResolutionError::DuplicateClass {
				class: ToolAuthorityClassV0::SafeRead,
			})
		);
	}

	#[test]
	fn request_not_subset_of_ceiling_is_rejected() {
		let request =
			ToolAuthorityRequestV0 { classes: vec![ToolAuthorityClassV0::WorkspaceMutation] };
		assert_eq!(
			resolve_tool_authority_classes(Some(&request), SAFE_READ_CEILING),
			Err(ToolAuthorityResolutionError::ClassOutsideTrustedCeiling {
				class: ToolAuthorityClassV0::WorkspaceMutation,
			})
		);
	}

	#[test]
	fn empty_explicit_authority_request_resolves_to_no_tools() {
		let request = ToolAuthorityRequestV0 { classes: Vec::new() };
		assert_eq!(
			resolve_tool_authority_classes(Some(&request), SAFE_READ_CEILING)
				.expect("empty explicit request is valid"),
			Vec::<ToolAuthorityClassV0>::new()
		);
	}

	#[test]
	fn request_never_establishes_its_own_ceiling() {
		let request = ToolAuthorityRequestV0 { classes: vec![ToolAuthorityClassV0::LocalProcess] };
		assert_eq!(
			resolve_tool_authority_classes(Some(&request), &[ToolAuthorityClassV0::SafeRead]),
			Err(ToolAuthorityResolutionError::ClassOutsideTrustedCeiling {
				class: ToolAuthorityClassV0::LocalProcess,
			})
		);
	}
}
