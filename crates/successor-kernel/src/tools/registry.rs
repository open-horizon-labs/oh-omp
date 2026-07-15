use std::{collections::HashSet, path::Path};

use serde_json::{Value as WireJson, json};
use successor_protocol::{
	artifact::ArtifactHash,
	raw_event::RawEventArtifactRef,
	tool_catalog::{ToolAuthorityClassV0, ToolAuthorityRequestV0, ToolCatalogV0, ToolStatusV0},
};

use super::{
	ast_grep, bash, bash::TrustedExecutableAllowlist, catalog, edit, find, grep, list_dir, mutation,
	read, search_files, write,
};

#[derive(Debug, Clone)]
pub struct ToolExecution {
	pub payload:              WireJson,
	pub artifact:             RawEventArtifactRef,
	pub provider_result_text: String,
}

/// Borrowed execution context threaded into every registered adapter.
/// `process_allowlist` is only consulted by `bash`; the read/discovery and
/// workspace-mutation adapters ignore it.
pub struct ToolExecutionContext<'a> {
	pub workspace_root:    &'a Path,
	pub process_allowlist: &'a TrustedExecutableAllowlist,
}

type ToolAdapter = fn(&ToolExecutionContext<'_>, &WireJson) -> Result<ToolExecution, String>;
type AvailabilityRule = fn(&TrustedExecutableAllowlist) -> bool;
type SchemaFn = fn() -> WireJson;

struct RegisteredTool {
	name:            &'static str,
	adapter:         ToolAdapter,
	schema:          SchemaFn,
	authority_class: ToolAuthorityClassV0,
	available:       AvailabilityRule,
}

const fn always_available(_allowlist: &TrustedExecutableAllowlist) -> bool {
	true
}

/// `bash` becomes available once at least one trusted executable is
/// configured in the process allowlist. An empty allowlist keeps `bash`
/// unavailable; this is the only availability rule `bash` relies on.
fn bash_available(allowlist: &TrustedExecutableAllowlist) -> bool {
	!allowlist.is_empty()
}

/// Narrows a `bash` JSON schema's `executable` property to an explicit
/// enum of the allowlist's trusted logical names, sourced directly from
/// [`TrustedExecutableAllowlist::logical_names`] (already sorted/deduped
/// by the underlying `BTreeMap`); no filesystem path is ever exposed
/// through the schema. Returns `schema` unchanged when the allowlist is
/// empty.
fn narrow_bash_executable_schema(
	mut schema: WireJson,
	allowlist: &TrustedExecutableAllowlist,
) -> WireJson {
	if allowlist.is_empty() {
		return schema;
	}
	if let Some(executable_property) = schema.pointer_mut("/properties/executable") {
		*executable_property = json!({
			"type": "string",
			"enum": allowlist.logical_names().collect::<Vec<_>>(),
		});
	}
	schema
}

fn schema_search_files() -> WireJson {
	serde_json::to_value(schemars::schema_for!(search_files::SearchFilesArgs))
		.expect("search_files schema serializes")
}

fn schema_read() -> WireJson {
	serde_json::to_value(schemars::schema_for!(read::ReadArgs)).expect("read schema serializes")
}

fn schema_find() -> WireJson {
	serde_json::to_value(schemars::schema_for!(find::FindArgs)).expect("find schema serializes")
}

fn schema_grep() -> WireJson {
	serde_json::to_value(schemars::schema_for!(grep::GrepArgs)).expect("grep schema serializes")
}

fn schema_list_dir() -> WireJson {
	serde_json::to_value(schemars::schema_for!(list_dir::ListDirArgs))
		.expect("list_dir schema serializes")
}

fn schema_ast_grep() -> WireJson {
	serde_json::to_value(schemars::schema_for!(ast_grep::AstGrepArgs))
		.expect("ast_grep schema serializes")
}

fn schema_edit() -> WireJson {
	serde_json::to_value(edit::EditArgs::schema()).expect("edit schema serializes")
}

fn schema_write() -> WireJson {
	serde_json::to_value(write::WriteArgs::schema()).expect("write schema serializes")
}

fn schema_bash() -> WireJson {
	serde_json::to_value(bash::BashArgs::schema()).expect("bash schema serializes")
}

const REGISTERED_TOOLS: &[RegisteredTool] = &[
	RegisteredTool {
		name:            "search_files",
		adapter:         execute_search_files,
		schema:          schema_search_files,
		authority_class: ToolAuthorityClassV0::SafeRead,
		available:       always_available,
	},
	RegisteredTool {
		name:            "read",
		adapter:         execute_read,
		schema:          schema_read,
		authority_class: ToolAuthorityClassV0::SafeRead,
		available:       always_available,
	},
	RegisteredTool {
		name:            "find",
		adapter:         execute_find,
		schema:          schema_find,
		authority_class: ToolAuthorityClassV0::SafeRead,
		available:       always_available,
	},
	RegisteredTool {
		name:            "grep",
		adapter:         execute_grep,
		schema:          schema_grep,
		authority_class: ToolAuthorityClassV0::SafeRead,
		available:       always_available,
	},
	RegisteredTool {
		name:            "list_dir",
		adapter:         execute_list_dir,
		schema:          schema_list_dir,
		authority_class: ToolAuthorityClassV0::SafeRead,
		available:       always_available,
	},
	RegisteredTool {
		name:            "ast_grep",
		adapter:         execute_ast_grep,
		schema:          schema_ast_grep,
		authority_class: ToolAuthorityClassV0::SafeRead,
		available:       always_available,
	},
	RegisteredTool {
		name:            "edit",
		adapter:         execute_edit,
		schema:          schema_edit,
		authority_class: ToolAuthorityClassV0::WorkspaceMutation,
		available:       always_available,
	},
	RegisteredTool {
		name:            "write",
		adapter:         execute_write,
		schema:          schema_write,
		authority_class: ToolAuthorityClassV0::WorkspaceMutation,
		available:       always_available,
	},
	RegisteredTool {
		name:            "bash",
		adapter:         execute_bash,
		schema:          schema_bash,
		authority_class: ToolAuthorityClassV0::LocalProcess,
		available:       bash_available,
	},
];

pub const fn slice0_registry() -> ToolRegistry {
	ToolRegistry
}

pub struct ToolRegistry;

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
		REGISTERED_TOOLS
			.iter()
			.map(|tool| tool.name)
			.filter(|name| catalog::tool_status(name) == Some(ToolStatusV0::Executable))
	}

	pub fn is_dispatchable(&self, tool_name: &str) -> bool {
		Self::executable(tool_name).is_some()
	}

	pub fn effective_catalog(
		&self,
		authority: &EffectiveToolAuthority,
		allowlist: &TrustedExecutableAllowlist,
	) -> ToolCatalogV0 {
		Self::apply_effective_catalog(catalog::slice0_catalog(), authority, allowlist)
	}

	/// Applies registered-metadata + authority + runtime-availability
	/// policy to `base`, republishing each tool that remains effectively
	/// executable with its live registered JSON schema (narrowed by
	/// `allowlist` for `bash`). A base `StubRejected` entry is left
	/// untouched. Factored out of [`Self::effective_catalog`] so a
	/// synthetic base catalog can exercise sovereign-activation branches
	/// (a tool promoted past `StubRejected`, or missing registered
	/// metadata) without depending on the live base-catalog fixture.
	fn apply_effective_catalog(
		mut base: ToolCatalogV0,
		authority: &EffectiveToolAuthority,
		allowlist: &TrustedExecutableAllowlist,
	) -> ToolCatalogV0 {
		for tool in &mut base.tools {
			if tool.status != ToolStatusV0::Executable {
				continue;
			}
			let Some(schema) = Self::registered_schema(&tool.name, allowlist) else {
				// No registered adapter/schema for a base-Executable entry:
				// fail closed rather than publish a schema-less executable.
				tool.status = ToolStatusV0::PolicyRejected;
				continue;
			};
			let permitted = authority.permits_executable_tool(&tool.name)
				&& Self::tool_available(&tool.name, allowlist);
			if !permitted {
				tool.status = ToolStatusV0::PolicyRejected;
				continue;
			}
			tool.input_schema = Some(schema);
		}
		base
	}

	pub fn effective_executable_names<'a>(
		&'a self,
		authority: &'a EffectiveToolAuthority,
		allowlist: &'a TrustedExecutableAllowlist,
	) -> impl Iterator<Item = &'static str> + 'a {
		self.executable_names().filter(move |tool_name| {
			authority.permits_executable_tool(tool_name) && Self::tool_available(tool_name, allowlist)
		})
	}

	pub fn execute(
		&self,
		ctx: &ToolExecutionContext<'_>,
		tool_name: &str,
		arguments: &WireJson,
	) -> Result<ToolExecution, String> {
		let Some(tool) = Self::executable(tool_name) else {
			return Err(format!(
				"tool `{tool_name}` is executable per the catalog but has no dispatch wiring"
			));
		};
		(tool.adapter)(ctx, arguments)
	}

	pub fn execute_authorized(
		&self,
		ctx: &ToolExecutionContext<'_>,
		tool_name: &str,
		arguments: &WireJson,
		authority: &EffectiveToolAuthority,
	) -> Result<ToolExecution, String> {
		if !authority.permits_executable_tool(tool_name) {
			return Err(format!("tool `{tool_name}` is not permitted by effective tool authority"));
		}
		if !Self::tool_available(tool_name, ctx.process_allowlist) {
			return Err(format!("tool `{tool_name}` is not available in this session"));
		}
		self.execute(ctx, tool_name, arguments)
	}

	fn executable(tool_name: &str) -> Option<&'static RegisteredTool> {
		let status = catalog::tool_status(tool_name)?;
		if status != ToolStatusV0::Executable {
			return None;
		}
		REGISTERED_TOOLS.iter().find(|tool| tool.name == tool_name)
	}

	/// Returns the registered authority class for `tool_name` regardless of
	/// its base catalog status. This lets authority resolution consult
	/// metadata for tools that are not yet dispatchable without granting
	/// them dispatch: `execute`/`execute_authorized` still gate on
	/// [`Self::executable`], which requires `ToolStatusV0::Executable`.
	fn tool_authority_class(tool_name: &str) -> Option<ToolAuthorityClassV0> {
		REGISTERED_TOOLS
			.iter()
			.find(|tool| tool.name == tool_name)
			.map(|tool| tool.authority_class)
	}

	fn tool_available(tool_name: &str, allowlist: &TrustedExecutableAllowlist) -> bool {
		REGISTERED_TOOLS
			.iter()
			.find(|tool| tool.name == tool_name)
			.is_some_and(|tool| (tool.available)(allowlist))
	}

	/// Returns the registered JSON schema for `tool_name` regardless of its
	/// base catalog status. Consulting this metadata grants no dispatch: it
	/// exists so [`Self::apply_effective_catalog`] can republish a
	/// registered adapter's live argument schema without duplicating it
	/// outside the registry. `allowlist` narrows `bash`'s `executable`
	/// schema property to the live set of trusted logical names; every
	/// other tool ignores it.
	fn registered_schema(
		tool_name: &str,
		allowlist: &TrustedExecutableAllowlist,
	) -> Option<WireJson> {
		let tool = REGISTERED_TOOLS
			.iter()
			.find(|tool| tool.name == tool_name)?;
		let schema = (tool.schema)();
		Some(if tool_name == "bash" {
			narrow_bash_executable_schema(schema, allowlist)
		} else {
			schema
		})
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
		preview: Some(bound_provider_visible_text(preview)),
		content: Some(String::from_utf8_lossy(bytes).into_owned()),
	}
}

const MAX_PROVIDER_VISIBLE_READ_BYTES: usize = 200_000;

fn bound_provider_visible_text(text: &str) -> String {
	if text.len() <= MAX_PROVIDER_VISIBLE_READ_BYTES {
		return text.to_owned();
	}
	let mut end = MAX_PROVIDER_VISIBLE_READ_BYTES;
	while !text.is_char_boundary(end) {
		end -= 1;
	}
	text[..end].to_owned()
}

fn execute_search_files(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: search_files::SearchFilesArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result = search_files::search_files(ctx.workspace_root, &args.query, args.max_matches)
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

fn execute_read(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: read::ReadArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let content = read::read(ctx.workspace_root, &args.path, args.offset, args.limit)
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

fn execute_list_dir(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: list_dir::ListDirArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result =
		list_dir::list_dir(ctx.workspace_root, &args.path).map_err(|err| err.to_string())?;
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

fn execute_find(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: find::FindArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result = find::find(ctx.workspace_root, &args.glob, 2_000).map_err(|err| err.to_string())?;
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

fn execute_grep(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: grep::GrepArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let result =
		grep::grep(ctx.workspace_root, &args.pattern, 2_000).map_err(|err| err.to_string())?;
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

/// Private registry-only adapter. `ast_grep` is `Executable` in the base
/// catalog fixture and dispatches through
/// [`ToolRegistry::execute`]/`execute_authorized`, which gate on catalog
/// status through [`ToolRegistry::executable`].
fn execute_ast_grep(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let args: ast_grep::AstGrepArgs =
		serde_json::from_value(arguments.clone()).map_err(|err| err.to_string())?;
	let content = ast_grep::ast_grep(ctx.workspace_root, &args).map_err(|err| err.to_string())?;
	// Use the substrate's canonical bytes/hash/length directly: re-serializing
	// `content` (which also carries `lang`/`matches`/`stats`/`truncated`) would
	// drift from the pinned `content.bytes`/`sha256`/`byte_length` triple.
	let provider_result_text =
		String::from_utf8(content.bytes.clone()).expect("ast_grep artifact payload is valid UTF-8");
	let payload: WireJson =
		serde_json::from_slice(&content.bytes).expect("ast_grep artifact payload round-trips");
	Ok(ToolExecution {
		payload,
		artifact: artifact_ref(
			content.sha256.clone(),
			content.byte_length,
			"application/json",
			&provider_result_text,
			&content.bytes,
		),
		provider_result_text,
	})
}

/// Private registry-only adapter. `edit` is `Executable` in the base
/// catalog fixture; see [`execute_ast_grep`] for the catalog dispatch-gating
/// mechanism, which applies identically here.
fn execute_edit(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let receipt = edit::execute(ctx.workspace_root, arguments).map_err(|err| err.to_string())?;
	Ok(mutation_tool_execution(&receipt))
}

/// Private registry-only adapter. `write` is `Executable` in the base
/// catalog fixture; see [`execute_ast_grep`] for the catalog dispatch-gating
/// mechanism, which applies identically here.
fn execute_write(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let receipt = write::execute(ctx.workspace_root, arguments).map_err(|err| err.to_string())?;
	Ok(mutation_tool_execution(&receipt))
}

/// `edit` and `write` both publish the same canonical, bounded
/// `MutationReceipt` JSON bytes as payload, provider text, and the
/// persisted `application/json` artifact — hashed and measured from those
/// exact bytes, never from workspace file bytes.
fn mutation_tool_execution(receipt: &mutation::MutationReceipt) -> ToolExecution {
	let artifact = receipt.artifact();
	let provider_result_text =
		String::from_utf8(artifact.bytes.clone()).expect("MutationReceipt JSON is valid UTF-8");
	let payload: WireJson =
		serde_json::from_slice(&artifact.bytes).expect("MutationReceipt JSON round-trips");
	ToolExecution {
		payload,
		artifact: artifact_ref(
			artifact.sha256,
			artifact.byte_length,
			"application/json",
			&provider_result_text,
			&artifact.bytes,
		),
		provider_result_text,
	}
}

/// Private registry-only adapter. `bash` is `Executable` in the base
/// catalog fixture; see [`execute_ast_grep`] for the catalog dispatch-gating
/// mechanism, which applies identically here.
/// Resolution is delegated entirely to `bash::execute`'s allowlist lookup:
/// no PATH search, provider-host path, shell, or ambient environment is
/// consulted here. A nonzero exit or timeout is a successful `Ok` receipt,
/// not an adapter error.
fn execute_bash(
	ctx: &ToolExecutionContext<'_>,
	arguments: &WireJson,
) -> Result<ToolExecution, String> {
	let receipt = bash::execute(ctx.workspace_root, ctx.process_allowlist, arguments.clone())
		.map_err(|err| err.to_string())?;
	// Provider text/payload: bounded `ProcessReceipt` JSON, which already
	// omits `artifact` via `#[serde(skip)]`.
	let provider_result_text = receipt.provider_result_text();
	let payload: WireJson =
		serde_json::from_str(&provider_result_text).expect("ProcessReceipt JSON round-trips");
	// Persisted artifact: canonical `ProcessArtifact` bytes/hash/length, never
	// the receipt bytes above.
	let artifact_bytes = receipt.artifact.canonical_bytes();
	let (sha256, byte_length) = super::compute_artifact_bytes(&artifact_bytes);
	Ok(ToolExecution {
		payload,
		artifact: artifact_ref(
			sha256,
			byte_length,
			"application/json",
			&provider_result_text,
			&artifact_bytes,
		),
		provider_result_text,
	})
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use successor_protocol::tool_catalog::{
		ToolAuthorityClassV0, ToolAuthorityRequestV0, ToolCatalogV0, ToolDefinitionV0, ToolStatusV0,
	};

	use super::{
		EffectiveToolAuthority, ToolAuthorityResolutionError, ToolExecutionContext, ToolRegistry,
		bash::{TrustedExecutable, TrustedExecutableAllowlist},
		bash_available, catalog, execute_ast_grep, execute_bash, execute_edit, execute_write,
		narrow_bash_executable_schema, resolve_tool_authority_classes, schema_bash, slice0_registry,
	};

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

	fn full_authority() -> EffectiveToolAuthority {
		let request = ToolAuthorityRequestV0 {
			classes: vec![
				ToolAuthorityClassV0::SafeRead,
				ToolAuthorityClassV0::WorkspaceMutation,
				ToolAuthorityClassV0::LocalProcess,
			],
		};
		EffectiveToolAuthority::resolve(Some(&request), FULL_CEILING)
			.expect("full authority resolves")
	}

	fn unique_temp_dir(label: &str) -> std::path::PathBuf {
		let root = std::env::temp_dir().join(format!(
			"successor-kernel-registry-test-{label}-{}-{:?}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.expect("system clock after epoch")
		));
		std::fs::create_dir_all(&root).expect("create temp workspace root");
		root
	}

	// --- Registered roster: uniqueness and authority-class mapping ---

	#[test]
	fn registered_tool_names_are_unique() {
		let mut names: Vec<&'static str> = super::REGISTERED_TOOLS
			.iter()
			.map(|tool| tool.name)
			.collect();
		let before = names.len();
		names.sort_unstable();
		names.dedup();
		assert_eq!(names.len(), before, "REGISTERED_TOOLS must not contain duplicate names");
	}

	#[test]
	fn registered_tool_authority_classes_match_the_slice0_registry_context_ruling() {
		let expected: &[(&str, ToolAuthorityClassV0)] = &[
			("search_files", ToolAuthorityClassV0::SafeRead),
			("read", ToolAuthorityClassV0::SafeRead),
			("find", ToolAuthorityClassV0::SafeRead),
			("grep", ToolAuthorityClassV0::SafeRead),
			("list_dir", ToolAuthorityClassV0::SafeRead),
			("ast_grep", ToolAuthorityClassV0::SafeRead),
			("edit", ToolAuthorityClassV0::WorkspaceMutation),
			("write", ToolAuthorityClassV0::WorkspaceMutation),
			("bash", ToolAuthorityClassV0::LocalProcess),
		];
		for (name, class) in expected {
			assert_eq!(
				ToolRegistry::tool_authority_class(name),
				Some(*class),
				"registered authority class metadata for `{name}` must be consultable independent of \
				 catalog status"
			);
		}
	}

	// --- Public roster is exactly the nine base-executable tools, in catalog
	// order ---

	#[test]
	fn public_executable_names_are_exactly_the_nine_base_tools_in_catalog_order() {
		let registry = slice0_registry();
		assert_eq!(
			registry.executable_names().collect::<Vec<_>>(),
			vec![
				"search_files",
				"read",
				"find",
				"grep",
				"list_dir",
				"ast_grep",
				"edit",
				"write",
				"bash"
			],
			"the S6-promoted roster (ast_grep/edit/write/bash) must dispatch in exact catalog order"
		);
	}

	#[test]
	fn still_stub_tool_cannot_dispatch_through_execute_or_execute_authorized() {
		let registry = slice0_registry();
		let root = unique_temp_dir("still-stub");
		let allowlist = TrustedExecutableAllowlist::default();
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let authority = full_authority();
		assert!(
			!registry.is_dispatchable("ssh"),
			"`ssh` must not report as dispatchable while the base catalog fixture pins it to \
			 stub_rejected"
		);
		assert!(
			registry
				.execute(&ctx, "ssh", &serde_json::json!({}))
				.is_err(),
			"`ssh` must not be dispatchable through ToolRegistry::execute while the base catalog \
			 fixture pins it to stub_rejected"
		);
		assert!(
			registry
				.execute_authorized(&ctx, "ssh", &serde_json::json!({}), &authority)
				.is_err(),
			"`ssh` must not be dispatchable through execute_authorized even with full authority, \
			 because the base catalog fixture pins it to stub_rejected"
		);
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn forged_calls_to_workspace_mutation_and_local_process_tools_are_rejected_without_sufficient_authority()
	 {
		let registry = slice0_registry();
		let root = unique_temp_dir("forged-insufficient-authority");
		let allowlist = TrustedExecutableAllowlist::default();
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let safe_read_only = EffectiveToolAuthority::default_safe_read();
		for elevated in ["edit", "write", "bash"] {
			assert!(
				registry
					.execute_authorized(&ctx, elevated, &serde_json::json!({}), &safe_read_only)
					.is_err(),
				"`{elevated}` must not dispatch through execute_authorized under safe_read-only \
				 authority"
			);
		}
		assert!(
			registry
				.execute_authorized(&ctx, "bash", &serde_json::json!({}), &full_authority())
				.is_err(),
			"bash must stay unavailable through execute_authorized when the trusted allowlist is \
			 empty, even under full authority"
		);
		std::fs::remove_dir_all(&root).ok();
	}

	// --- effective_catalog / effective_executable_names: authority x availability
	// ---

	#[test]
	fn effective_catalog_under_safe_read_keeps_only_safe_read_tools_executable() {
		let registry = slice0_registry();
		let authority = EffectiveToolAuthority::default_safe_read();
		let allowlist = TrustedExecutableAllowlist::default();
		let catalog = registry.effective_catalog(&authority, &allowlist);
		let executable: Vec<&str> = catalog
			.tools
			.iter()
			.filter(|tool| tool.status == ToolStatusV0::Executable)
			.map(|tool| tool.name.as_str())
			.collect();
		assert_eq!(executable, vec!["search_files", "read", "find", "grep", "list_dir", "ast_grep"]);
	}

	#[test]
	fn effective_catalog_under_explicit_empty_authority_has_zero_executable_tools() {
		let registry = slice0_registry();
		let request = ToolAuthorityRequestV0 { classes: Vec::new() };
		let authority = EffectiveToolAuthority::resolve(Some(&request), FULL_CEILING)
			.expect("empty explicit authority resolves");
		let allowlist = TrustedExecutableAllowlist::default();
		let catalog = registry.effective_catalog(&authority, &allowlist);
		assert!(
			catalog
				.tools
				.iter()
				.all(|tool| tool.status != ToolStatusV0::Executable)
		);
	}

	#[test]
	fn effective_catalog_under_workspace_mutation_authority_exposes_exact_eight_tools_excluding_bash()
	 {
		let registry = slice0_registry();
		let request = ToolAuthorityRequestV0 {
			classes: vec![ToolAuthorityClassV0::SafeRead, ToolAuthorityClassV0::WorkspaceMutation],
		};
		let authority = EffectiveToolAuthority::resolve(Some(&request), FULL_CEILING)
			.expect("workspace_mutation authority resolves");
		let allowlist = TrustedExecutableAllowlist::default();
		let catalog = registry.effective_catalog(&authority, &allowlist);
		let bash_status = catalog
			.tools
			.iter()
			.find(|tool| tool.name == "bash")
			.map(|tool| tool.status);
		assert_eq!(
			bash_status,
			Some(ToolStatusV0::PolicyRejected),
			"bash is base-Executable but must fail closed without local_process authority"
		);
		let executable: Vec<&str> = catalog
			.tools
			.iter()
			.filter(|tool| tool.status == ToolStatusV0::Executable)
			.map(|tool| tool.name.as_str())
			.collect();
		assert_eq!(
			executable,
			vec!["search_files", "read", "find", "grep", "list_dir", "ast_grep", "edit", "write"],
			"workspace_mutation authority must expose exactly the eight non-bash executable tools"
		);
	}

	#[test]
	fn effective_catalog_under_local_process_with_empty_allowlist_leaves_bash_policy_rejected() {
		let registry = slice0_registry();
		let authority = full_authority();
		let allowlist = TrustedExecutableAllowlist::default();
		let catalog = registry.effective_catalog(&authority, &allowlist);
		let bash_status = catalog
			.tools
			.iter()
			.find(|tool| tool.name == "bash")
			.map(|tool| tool.status);
		assert_eq!(
			bash_status,
			Some(ToolStatusV0::PolicyRejected),
			"an empty allowlist must never make bash executable, even under full authority"
		);
	}

	#[test]
	fn effective_catalog_under_local_process_with_populated_allowlist_makes_bash_executable() {
		let registry = slice0_registry();
		let authority = full_authority();
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("echo", Path::new("/bin/echo"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let catalog = registry.effective_catalog(&authority, &allowlist);
		let bash_status = catalog
			.tools
			.iter()
			.find(|tool| tool.name == "bash")
			.map(|tool| tool.status);
		assert_eq!(
			bash_status,
			Some(ToolStatusV0::Executable),
			"full authority plus a populated trusted-executable allowlist must make bash executable"
		);
	}

	#[test]
	fn effective_executable_names_under_local_process_with_populated_allowlist_includes_bash() {
		let registry = slice0_registry();
		let authority = full_authority();
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("echo", Path::new("/bin/echo"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let names: Vec<&str> = registry
			.effective_executable_names(&authority, &allowlist)
			.collect();
		assert_eq!(
			names,
			vec![
				"search_files",
				"read",
				"find",
				"grep",
				"list_dir",
				"ast_grep",
				"edit",
				"write",
				"bash"
			],
			"full local_process authority with a populated allowlist must expose exactly the nine \
			 base-executable tools in catalog order"
		);
	}

	// --- Private adapters: canonical payload/provider/artifact bytes ---

	#[test]
	fn edit_adapter_reuses_exact_receipt_bytes_for_payload_provider_and_artifact() {
		let root = unique_temp_dir("edit-adapter");
		let seed_content = "hello world\n";
		std::fs::write(root.join("target.txt"), seed_content).expect("seed file");
		let expected_sha256 =
			successor_protocol::artifact::ArtifactHash::compute(seed_content.as_bytes());
		let allowlist = TrustedExecutableAllowlist::default();
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let arguments = serde_json::json!({
			"path": "target.txt",
			"expected_sha256": expected_sha256,
			"edits": [{
				"start": { "line": 1, "column": 0 },
				"end": { "line": 1, "column": 5 },
				"replacement": "howdy",
			}],
		});
		let execution = execute_edit(&ctx, &arguments).expect("edit adapter succeeds");
		assert_eq!(
			execution.provider_result_text.as_bytes(),
			execution
				.artifact
				.content
				.as_deref()
				.expect("artifact content present")
				.as_bytes(),
			"provider text and artifact content must be byte-identical to the canonical receipt"
		);
		let recomputed_sha256 = successor_protocol::artifact::ArtifactHash::compute(
			execution.provider_result_text.as_bytes(),
		);
		assert_eq!(execution.artifact.sha256, recomputed_sha256);
		assert_eq!(execution.artifact.byte_length, execution.provider_result_text.len() as u64);
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn write_adapter_reuses_exact_receipt_bytes_for_payload_provider_and_artifact() {
		let root = unique_temp_dir("write-adapter");
		let allowlist = TrustedExecutableAllowlist::default();
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let arguments = serde_json::json!({ "path": "new.txt", "mode": "create", "content": "hi\n" });
		let execution = execute_write(&ctx, &arguments).expect("write adapter succeeds");
		let recomputed_sha256 = successor_protocol::artifact::ArtifactHash::compute(
			execution.provider_result_text.as_bytes(),
		);
		assert_eq!(execution.artifact.sha256, recomputed_sha256);
		assert_eq!(
			execution.provider_result_text.as_bytes(),
			execution
				.artifact
				.content
				.as_deref()
				.expect("artifact content present")
				.as_bytes(),
		);
	}

	#[test]
	fn mutation_rejection_messages_never_leak_workspace_paths_or_content() {
		let root = unique_temp_dir("mutation-redaction");
		let allowlist = TrustedExecutableAllowlist::default();
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let arguments = serde_json::json!({
			"path": "../escape/target.txt",
			"edits": [{ "range": { "start_line": 1, "start_col": 0, "end_line": 1, "end_col": 0 }, "text": "x" }],
		});
		let err = execute_edit(&ctx, &arguments).expect_err("parent traversal must be rejected");
		assert!(
			!err.contains(root.to_string_lossy().as_ref()),
			"rejection must not echo the workspace root"
		);
		assert!(
			!err.contains("escape"),
			"rejection must not echo the rejected relative path segment"
		);
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn ast_grep_adapter_reuses_substrate_canonical_bytes_without_reserialization() {
		let root = unique_temp_dir("ast-grep-adapter");
		std::fs::write(root.join("lib.rs"), "fn alpha() {}\n").expect("seed file");
		let allowlist = TrustedExecutableAllowlist::default();
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let arguments = serde_json::json!({ "pat": ["fn $NAME() {}"], "lang": "rust" });
		let execution = execute_ast_grep(&ctx, &arguments).expect("ast_grep adapter succeeds");
		assert_eq!(
			execution.provider_result_text.as_bytes(),
			execution
				.artifact
				.content
				.as_deref()
				.expect("artifact content present")
				.as_bytes(),
		);
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn bash_adapter_treats_nonzero_exit_as_a_successful_receipt() {
		let root = unique_temp_dir("bash-adapter-nonzero");
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("false", Path::new("/usr/bin/false"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let arguments = serde_json::json!({ "executable": "false", "argv": [] });
		let execution = execute_bash(&ctx, &arguments);
		assert!(execution.is_ok(), "a nonzero exit must be an Ok receipt, not an adapter error");
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn bash_adapter_artifact_hash_and_length_come_from_process_artifact_bytes() {
		let root = unique_temp_dir("bash-adapter-artifact-identity");
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("true", Path::new("/usr/bin/true"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let ctx = ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
		let arguments = serde_json::json!({ "executable": "true", "argv": [] });
		let execution = execute_bash(&ctx, &arguments).expect("bash adapter succeeds");
		// The receipt (provider text) and the persisted artifact are
		// deliberately different documents for bash: the artifact must be
		// hashed from its own canonical bytes, not the receipt bytes.
		assert_ne!(
			execution.provider_result_text.as_bytes(),
			execution
				.artifact
				.content
				.as_deref()
				.expect("artifact content present")
				.as_bytes(),
		);
		let artifact_bytes = execution
			.artifact
			.content
			.as_deref()
			.expect("artifact content present")
			.as_bytes();
		let recomputed_sha256 = successor_protocol::artifact::ArtifactHash::compute(artifact_bytes);
		assert_eq!(execution.artifact.sha256, recomputed_sha256);
		assert_eq!(execution.artifact.byte_length, artifact_bytes.len() as u64);
		std::fs::remove_dir_all(&root).ok();
	}

	// --- bash availability and schema narrowing: allowlist-driven ---

	#[test]
	fn bash_available_is_false_for_an_empty_allowlist() {
		let allowlist = TrustedExecutableAllowlist::default();
		assert!(!bash_available(&allowlist));
	}

	#[test]
	fn bash_available_is_true_once_any_trusted_executable_is_present() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		assert!(bash_available(&allowlist));
	}

	#[test]
	fn allowlist_is_empty_and_logical_names_reflect_the_configured_roster() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		assert!(allowlist.is_empty());
		assert_eq!(allowlist.logical_names().len(), 0);
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		assert!(!allowlist.is_empty());
		assert_eq!(allowlist.logical_names().collect::<Vec<_>>(), vec!["git"]);
	}

	#[test]
	fn narrow_bash_executable_schema_is_a_no_op_for_an_empty_allowlist() {
		let allowlist = TrustedExecutableAllowlist::default();
		let base = schema_bash();
		let narrowed = narrow_bash_executable_schema(base.clone(), &allowlist);
		assert_eq!(narrowed, base);
	}

	#[test]
	fn narrow_bash_executable_schema_sorts_and_dedupes_logical_names() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("make", Path::new("/usr/bin/make"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let base = schema_bash();
		let narrowed = narrow_bash_executable_schema(base, &allowlist);
		let executable_enum = narrowed
			.pointer("/properties/executable/enum")
			.and_then(serde_json::Value::as_array)
			.expect("narrowed schema carries an executable enum");
		let values: Vec<&str> = executable_enum
			.iter()
			.filter_map(serde_json::Value::as_str)
			.collect();
		assert_eq!(values, vec!["git", "make"], "must be sorted and deduped");
	}

	#[test]
	fn narrow_bash_executable_schema_never_exposes_a_filesystem_path() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let narrowed = narrow_bash_executable_schema(schema_bash(), &allowlist);
		let serialized = narrowed.to_string();
		assert!(
			!serialized.contains("/usr/bin/git"),
			"narrowed schema must expose only the trusted logical name, never the executable path"
		);
	}

	#[test]
	fn catalog_tool_status_now_pins_all_four_promoted_tools_to_executable() {
		for name in ["ast_grep", "edit", "write", "bash"] {
			assert_eq!(
				catalog::tool_status(name),
				Some(ToolStatusV0::Executable),
				"`{name}` must be executable in the base catalog fixture after the S6 cutover"
			);
		}
	}

	#[test]
	fn registered_schema_is_retrievable_for_every_registered_tool() {
		let allowlist = TrustedExecutableAllowlist::default();
		for name in
			["search_files", "read", "find", "grep", "list_dir", "ast_grep", "edit", "write", "bash"]
		{
			assert!(
				ToolRegistry::registered_schema(name, &allowlist).is_some(),
				"`{name}` must expose a registered schema regardless of catalog status"
			);
		}
		assert_eq!(ToolRegistry::registered_schema("not_a_real_tool", &allowlist), None);
	}

	#[test]
	fn registered_schema_for_bash_narrows_to_the_live_allowlists_logical_names() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let schema = ToolRegistry::registered_schema("bash", &allowlist).expect("bash has a schema");
		let executable_enum = schema
			.pointer("/properties/executable/enum")
			.and_then(serde_json::Value::as_array)
			.expect("bash schema carries a narrowed executable enum once the allowlist is populated");
		let values: Vec<&str> = executable_enum
			.iter()
			.filter_map(serde_json::Value::as_str)
			.collect();
		assert_eq!(values, vec!["git"]);
	}

	#[test]
	fn registered_schema_for_bash_is_unnarrowed_for_an_empty_allowlist() {
		let allowlist = TrustedExecutableAllowlist::default();
		let schema = ToolRegistry::registered_schema("bash", &allowlist).expect("bash has a schema");
		assert!(schema.pointer("/properties/executable/enum").is_none());
	}

	#[test]
	fn tool_available_for_bash_is_driven_by_the_live_allowlist() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		assert!(
			!ToolRegistry::tool_available("bash", &allowlist),
			"an empty allowlist must leave bash unavailable at the registered-metadata level"
		);
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		assert!(
			ToolRegistry::tool_available("bash", &allowlist),
			"a populated allowlist must make bash available at the registered-metadata level, \
			 independent of catalog status"
		);
	}

	// --- `apply_effective_catalog`: authority x availability x schema
	// narrowing on the live base catalog, plus branch coverage for a
	// synthetic entry not covered by the live fixture ---

	fn bash_tool(catalog: &ToolCatalogV0) -> &ToolDefinitionV0 {
		catalog
			.tools
			.iter()
			.find(|tool| tool.name == "bash")
			.expect("bash entry present")
	}

	fn only_authority(class: ToolAuthorityClassV0) -> EffectiveToolAuthority {
		let request = ToolAuthorityRequestV0 { classes: vec![class] };
		EffectiveToolAuthority::resolve(Some(&request), FULL_CEILING).expect("authority resolves")
	}

	#[test]
	fn apply_effective_catalog_narrows_bashs_schema_to_the_exact_live_allowlist_enum() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("make", Path::new("/usr/bin/make"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let authority = only_authority(ToolAuthorityClassV0::LocalProcess);
		let catalog =
			ToolRegistry::apply_effective_catalog(catalog::slice0_catalog(), &authority, &allowlist);
		let bash = bash_tool(&catalog);
		assert_eq!(bash.status, ToolStatusV0::Executable);
		let schema = bash
			.input_schema
			.as_ref()
			.expect("executable bash carries a live schema");
		let enum_values: Vec<&str> = schema
			.pointer("/properties/executable/enum")
			.and_then(serde_json::Value::as_array)
			.expect("executable schema carries an enum")
			.iter()
			.filter_map(serde_json::Value::as_str)
			.collect();
		assert_eq!(enum_values, vec!["git", "make"]);
		assert!(
			!schema.to_string().contains("/usr/bin/"),
			"a republished schema must never leak a trusted executable's filesystem path"
		);
	}

	#[test]
	fn apply_effective_catalog_under_local_process_with_empty_allowlist_rejects_bash() {
		let allowlist = TrustedExecutableAllowlist::default();
		let authority = only_authority(ToolAuthorityClassV0::LocalProcess);
		let base = catalog::slice0_catalog();
		let base_schema = bash_tool(&base).input_schema.clone();
		let catalog = ToolRegistry::apply_effective_catalog(base, &authority, &allowlist);
		let bash = bash_tool(&catalog);
		assert_eq!(bash.status, ToolStatusV0::PolicyRejected);
		assert_eq!(
			bash.input_schema, base_schema,
			"a denied tool's schema must never be dynamically narrowed or replaced"
		);
	}

	#[test]
	fn apply_effective_catalog_under_safe_read_rejects_bash_even_with_a_populated_allowlist() {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let authority = only_authority(ToolAuthorityClassV0::SafeRead);
		let catalog =
			ToolRegistry::apply_effective_catalog(catalog::slice0_catalog(), &authority, &allowlist);
		assert_eq!(
			bash_tool(&catalog).status,
			ToolStatusV0::PolicyRejected,
			"runtime availability never substitutes for a missing authority grant"
		);
	}

	#[test]
	fn apply_effective_catalog_leaves_the_nine_effective_schemas_equal_to_their_canonical_registered_schemas()
	 {
		let mut allowlist = TrustedExecutableAllowlist::default();
		allowlist
			.insert(
				TrustedExecutable::new("git", Path::new("/usr/bin/git"), Vec::new())
					.expect("valid trusted executable"),
			)
			.expect("insert trusted executable");
		let authority = full_authority();
		let catalog =
			ToolRegistry::apply_effective_catalog(catalog::slice0_catalog(), &authority, &allowlist);
		for name in
			["search_files", "read", "find", "grep", "list_dir", "ast_grep", "edit", "write", "bash"]
		{
			let tool = catalog
				.tools
				.iter()
				.find(|tool| tool.name == name)
				.expect("tool present");
			assert_eq!(tool.status, ToolStatusV0::Executable);
			assert_eq!(
				tool.input_schema,
				ToolRegistry::registered_schema(name, &allowlist),
				"`{name}`'s republished schema must equal its canonical registered schema"
			);
		}
	}

	#[test]
	fn apply_effective_catalog_fails_closed_when_a_base_executable_has_no_registered_metadata() {
		let mut catalog = catalog::slice0_catalog();
		catalog.tools.push(ToolDefinitionV0::executable(
			"totally_untracked_tool",
			"diagnostic",
			"synthetic entry with no registered adapter or schema",
		));
		let allowlist = TrustedExecutableAllowlist::default();
		let authority = full_authority();
		let catalog = ToolRegistry::apply_effective_catalog(catalog, &authority, &allowlist);
		let tool = catalog
			.tools
			.iter()
			.find(|tool| tool.name == "totally_untracked_tool")
			.expect("synthetic entry present");
		assert_eq!(
			tool.status,
			ToolStatusV0::PolicyRejected,
			"a base-Executable entry with no registered metadata must fail closed, never dispatchable"
		);
	}

	#[test]
	fn apply_effective_catalog_preserves_a_base_stub_rejected_entry_untouched() {
		let allowlist = TrustedExecutableAllowlist::default();
		let authority = full_authority();
		let base = catalog::slice0_catalog();
		let stub_before = base
			.tools
			.iter()
			.find(|tool| tool.name == "ssh")
			.cloned()
			.expect("ssh present");
		let catalog = ToolRegistry::apply_effective_catalog(base, &authority, &allowlist);
		let stub_after = catalog
			.tools
			.iter()
			.find(|tool| tool.name == "ssh")
			.expect("ssh present");
		assert_eq!(&stub_before, stub_after, "a base StubRejected entry must pass through unchanged");
	}

	#[test]
	fn effective_catalog_is_the_transform_applied_to_the_live_base_catalog() {
		let allowlist = TrustedExecutableAllowlist::default();
		let authority = full_authority();
		let registry = slice0_registry();
		assert_eq!(
			registry.effective_catalog(&authority, &allowlist),
			ToolRegistry::apply_effective_catalog(catalog::slice0_catalog(), &authority, &allowlist)
		);
	}
}
