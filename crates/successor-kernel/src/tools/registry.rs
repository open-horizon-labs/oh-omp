use std::path::Path;

use serde_json::{Value as WireJson, json};
use successor_protocol::{
	artifact::ArtifactHash, raw_event::RawEventArtifactRef, tool_catalog::ToolStatusV0,
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

impl ToolRegistry {
	pub fn executable_names(&self) -> impl Iterator<Item = &'static str> + '_ {
		EXECUTABLE_TOOLS.iter().map(|tool| tool.name)
	}

	pub fn is_dispatchable(&self, tool_name: &str) -> bool {
		Self::executable(tool_name).is_some()
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

	fn executable(tool_name: &str) -> Option<&'static ExecutableTool> {
		let status = catalog::tool_status(tool_name)?;
		if status != ToolStatusV0::Executable {
			return None;
		}
		EXECUTABLE_TOOLS.iter().find(|tool| tool.name == tool_name)
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
