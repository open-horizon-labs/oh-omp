//! Canonical JSON helpers for deterministic replay fixtures.

use serde::Serialize;

use crate::{
	error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode},
	projection::{SessionProjectionV0, ToolCallStatus},
};

/// Serialize any DTO as deterministic pretty JSON with a final newline.
pub fn to_canonical_json_bytes<T: Serialize>(value: &T) -> ProtocolResult<Vec<u8>> {
	Ok(to_canonical_json_string(value)?.into_bytes())
}

/// Serialize any DTO as deterministic pretty JSON with a final newline.
pub fn to_canonical_json_string<T: Serialize>(value: &T) -> ProtocolResult<String> {
	let mut json = serde_json::to_string_pretty(value).map_err(|err| {
		ProtocolViolation::new(
			ProtocolViolationCode::ReplayMismatch,
			format!("failed to serialize canonical JSON: {err}"),
		)
	})?;
	json.push('\n');
	Ok(json)
}

/// Serialize the Slice 0 expected projection with the exact fixture formatting.
pub fn to_canonical_projection_json_bytes(value: &SessionProjectionV0) -> ProtocolResult<Vec<u8>> {
	Ok(to_canonical_projection_json_string(value).into_bytes())
}

/// Serialize the Slice 0 expected projection with the exact fixture formatting.
pub fn to_canonical_projection_json_string(value: &SessionProjectionV0) -> String {
	let mut out = String::new();
	out.push_str("{\n");
	line_str(&mut out, 2, "schema_version", &value.schema_version, true);
	line_str(&mut out, 2, "projection_version", &value.projection_version, true);

	out.push_str("  \"session\": {\n");
	line_str(&mut out, 4, "session_id", value.session.session_id.as_str(), true);
	line_u64(&mut out, 4, "last_raw_event_seq", value.session.last_raw_event_seq, true);
	line_str(&mut out, 4, "last_turn_id", value.session.last_turn_id.as_str(), true);
	line_str(&mut out, 4, "last_assistant_summary", &value.session.last_assistant_summary, false);
	out.push_str("  },\n");

	out.push_str("  \"transcript\": [\n");
	for (index, entry) in value.transcript.iter().enumerate() {
		out.push_str("    {\n");
		line_str(&mut out, 6, "message_id", entry.message_id.as_str(), true);
		line_str(&mut out, 6, "role", entry.role.as_str(), true);
		line_str(&mut out, 6, "source_event_id", entry.source_event_id.as_str(), true);
		line_str(&mut out, 6, "source_envelope_id", entry.source_envelope_id.as_str(), true);
		line_str(&mut out, 6, "text", &entry.text, false);
		out.push_str("    }");
		comma_newline(&mut out, index + 1 != value.transcript.len());
	}
	out.push_str("  ],\n");

	out.push_str("  \"tools\": [\n");
	for (index, tool) in value.tools.iter().enumerate() {
		out.push_str("    {\n");
		line_str(&mut out, 6, "tool_call_id", tool.tool_call_id.as_str(), true);
		line_str(&mut out, 6, "tool_name", &tool.tool_name, true);
		line_str(&mut out, 6, "status", tool.status.as_str(), true);
		line_str(&mut out, 6, "requested_event_id", tool.requested_event_id.as_str(), true);
		match tool.status {
			ToolCallStatus::Completed => {
				line_str(
					&mut out,
					6,
					"result_event_id",
					tool
						.result_event_id
						.as_ref()
						.expect("validate_structure guarantees a completed row carries result_event_id")
						.as_str(),
					true,
				);
				line_str(
					&mut out,
					6,
					"completed_event_id",
					tool
						.completed_event_id
						.as_ref()
						.expect(
							"validate_structure guarantees a completed row carries completed_event_id",
						)
						.as_str(),
					true,
				);
				line_str(
					&mut out,
					6,
					"artifact_id",
					tool
						.artifact_id
						.as_ref()
						.expect("validate_structure guarantees a completed row carries artifact_id")
						.as_str(),
					false,
				);
			},
			ToolCallStatus::Failed => {
				line_str(
					&mut out,
					6,
					"started_event_id",
					tool
						.started_event_id
						.as_ref()
						.expect("validate_structure guarantees a failed row carries started_event_id")
						.as_str(),
					true,
				);
				line_str(
					&mut out,
					6,
					"error_event_id",
					tool
						.error_event_id
						.as_ref()
						.expect("validate_structure guarantees a failed row carries error_event_id")
						.as_str(),
					true,
				);
				line_str(
					&mut out,
					6,
					"failed_event_id",
					tool
						.failed_event_id
						.as_ref()
						.expect("validate_structure guarantees a failed row carries failed_event_id")
						.as_str(),
					true,
				);
				line_str(
					&mut out,
					6,
					"error_id",
					tool
						.error_id
						.as_ref()
						.expect("validate_structure guarantees a failed row carries error_id")
						.as_str(),
					false,
				);
			},
		}
		out.push_str("    }");
		comma_newline(&mut out, index + 1 != value.tools.len());
	}
	out.push_str("  ],\n");

	if value.errors.is_empty() {
		out.push_str("  \"errors\": []");
	} else {
		out.push_str("  \"errors\": [\n");
		for (index, error) in value.errors.iter().enumerate() {
			out.push_str("    {\n");
			line_str(&mut out, 6, "error_id", error.error_id.as_str(), true);
			line_str(&mut out, 6, "tool_call_id", error.tool_call_id.as_str(), true);
			line_str(&mut out, 6, "error_event_id", error.error_event_id.as_str(), true);
			line_str(&mut out, 6, "code", &error.code, true);
			line_str(&mut out, 6, "message", &error.message, true);
			line_bool(&mut out, 6, "recoverable", error.recoverable, true);
			line_bool(&mut out, 6, "retryable", error.retryable, true);
			line_str(&mut out, 6, "correlation_id", error.correlation_id.as_str(), true);
			line_json(&mut out, 6, "details", &error.details, false);
			out.push_str("    }");
			comma_newline(&mut out, index + 1 != value.errors.len());
		}
		out.push_str("  ]");
	}
	comma_newline(&mut out, true);

	out.push_str("  \"artifacts\": [\n");
	for (index, artifact) in value.artifacts.iter().enumerate() {
		out.push_str("    {\n");
		line_str(&mut out, 6, "artifact_id", artifact.artifact_id.as_str(), true);
		line_str(&mut out, 6, "source_event_id", artifact.source_event_id.as_str(), true);
		line_str(&mut out, 6, "sha256", artifact.sha256.as_str(), true);
		line_u64(&mut out, 6, "byte_length", artifact.byte_length, false);
		out.push_str("    }");
		comma_newline(&mut out, index + 1 != value.artifacts.len());
	}
	out.push_str("  ],\n");

	out.push_str("  \"assemblies\": [\n");
	for (index, assembly) in value.assemblies.iter().enumerate() {
		out.push_str("    { \"assemble_id\": ");
		out.push_str(&json_string(assembly.assemble_id.as_str()));
		out.push_str(", \"phase\": ");
		out.push_str(&json_string(&assembly.phase));
		out.push_str(", \"context_item_ids\": ");
		out.push_str(&compact_string_array(assembly.context_item_ids.iter().map(|id| id.as_str())));
		out.push_str(" }");
		comma_newline(&mut out, index + 1 != value.assemblies.len());
	}
	out.push_str("  ],\n");

	out.push_str("  \"provider_traces\": [\n");
	for (index, trace) in value.provider_traces.iter().enumerate() {
		out.push_str("    { \"trace_id\": ");
		out.push_str(&json_string(trace.trace_id.as_str()));
		out.push_str(", \"phase\": ");
		out.push_str(&json_string(&trace.phase));
		out.push_str(", \"provider_id\": ");
		out.push_str(&json_string(&trace.provider_id));
		out.push_str(", \"provider_api_shape\": ");
		out.push_str(&json_string(&trace.provider_api_shape));
		out.push_str(", \"context_item_ids\": ");
		out.push_str(&compact_string_array(trace.context_item_ids.iter().map(|id| id.as_str())));
		out.push_str(" }");
		comma_newline(&mut out, index + 1 != value.provider_traces.len());
	}
	out.push_str("  ]\n");
	out.push_str("}\n");
	out
}

fn line_str(out: &mut String, indent: usize, key: &str, value: &str, comma: bool) {
	out.push_str(&" ".repeat(indent));
	out.push_str(&json_string(key));
	out.push_str(": ");
	out.push_str(&json_string(value));
	comma_newline(out, comma);
}

fn line_u64(out: &mut String, indent: usize, key: &str, value: u64, comma: bool) {
	out.push_str(&" ".repeat(indent));
	out.push_str(&json_string(key));
	out.push_str(": ");
	out.push_str(&value.to_string());
	comma_newline(out, comma);
}

fn line_bool(out: &mut String, indent: usize, key: &str, value: bool, comma: bool) {
	out.push_str(&" ".repeat(indent));
	out.push_str(&json_string(key));
	out.push_str(": ");
	out.push_str(if value { "true" } else { "false" });
	comma_newline(out, comma);
}

fn line_json(out: &mut String, indent: usize, key: &str, value: &serde_json::Value, comma: bool) {
	out.push_str(&" ".repeat(indent));
	out.push_str(&json_string(key));
	out.push_str(": ");
	out.push_str(&serde_json::to_string(value).expect("serializing a JSON value cannot fail"));
	comma_newline(out, comma);
}

fn comma_newline(out: &mut String, comma: bool) {
	if comma {
		out.push(',');
	}
	out.push('\n');
}

fn compact_string_array<'a>(values: impl Iterator<Item = &'a str>) -> String {
	let values = values.map(json_string).collect::<Vec<_>>();
	format!("[{}]", values.join(", "))
}

fn json_string(value: &str) -> String {
	serde_json::to_string(value).expect("serializing a string cannot fail")
}
