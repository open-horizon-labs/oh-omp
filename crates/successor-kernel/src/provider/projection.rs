//! Owned by Lane C4 `KernelProviderProjection`.
//!
//! Pure, offline mapping between kernel-side turn inputs and A3's
//! normalized provider DTOs (`successor_protocol::provider`). Nothing in
//! this module performs network I/O -- that is `crate::provider::anthropic`'s
//! job for the Anthropic Messages shape specifically. Every function here
//! is deterministic and fixture-testable without a live provider (Dissent
//! ruling 3), and wire JSON (`serde_json::Value`) never crosses this
//! boundary as canonical kernel state (Dissent ruling 4) -- only the
//! normalized DTOs and `ProviderObservationMetadataV0` carry successor
//! identity forward.
//!
//! Canonical fixture: `fixtures/slice-0/provider-shape-normalization.json`,
//! loaded via `successor_protocol::fixtures::provider_shape_normalization`.
//! It fixes the wire-level equivalence of a single `read` tool call/result
//! across the three supported provider API shapes
//! (`ProviderApiShapeV0::{AnthropicMessages, OpenAiChatCompletions,
//! OpenAiResponses}`).
//!
//! Unsupported-tool residual (Dissent ruling 5 / contract A4): the accepted
//! detection and replay authority for
//! `fixtures/slice-0/raw-events-unsupported-tool.json` is
//! `successor_protocol::validation::{validate_unsupported_tool_lifecycle,
//! validate_unsupported_tool_projection_is_rejected}` plus
//! `successor_protocol::replay::project_session`. This module does not
//! reimplement or bypass any of those -- it adds the kernel-side gate that
//! must run *before* a provider request is ever built, using the same
//! `ToolCatalogV0`/`ToolStatusV0` facts those validators check downstream:
//! [`build_provider_request`] rejects a request naming a non-executable
//! tool with a typed [`ProjectionError`] instead of producing a
//! `NormalizedProviderRequestV0` that a provider adapter would otherwise be
//! asked to send.

use serde_json::Value as WireJson;
use successor_protocol::{
	ids::{ArtifactId, MessageId, RequestId, ToolCallId, TurnId},
	provider::{
		NormalizedProviderRequestV0, NormalizedResponseV0, NormalizedToolCallV0,
		NormalizedToolResultV0, PROVIDER_REQUEST_BUILT_EVENT_TYPE,
		PROVIDER_RESPONSE_RECORDED_EVENT_TYPE, PROVIDER_TOOL_CALL_OBSERVED_EVENT_TYPE,
		ProviderApiShapeV0, ProviderObservationMetadataV0,
	},
	tool_catalog::{ToolCatalogV0, ToolDefinitionV0, ToolStatusV0},
};

/// Stable wire label for a provider API shape, matching its
/// `#[serde(rename = ...)]`. Kept local: A3 does not expose a
/// `Display`/`as_str` for `ProviderApiShapeV0`, and typed error messages
/// must not depend on `{:?}` (Debug) formatting drifting independently of
/// the wire contract.
const fn shape_label(shape: &ProviderApiShapeV0) -> &'static str {
	match shape {
		ProviderApiShapeV0::AnthropicMessages => "anthropic_messages",
		ProviderApiShapeV0::OpenAiChatCompletions => "openai_chat_completions",
		ProviderApiShapeV0::OpenAiResponses => "openai_responses",
	}
}

/// Typed, redacted provider-projection failure.
///
/// Variants never carry the offending wire `serde_json::Value` -- only
/// shape labels, tool names, and catalog status. A malformed wire response
/// or tool call therefore never echoes its body through `Debug`/`Display`,
/// logs, or traces (contract custody requirement).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProjectionError {
	/// The turn named a tool that is absent from the published catalog.
	#[error("tool `{tool_name}` is not present in the published tool catalog")]
	ToolNotInCatalog { tool_name: String },

	/// The turn named a catalog-visible tool that Slice 0 does not execute
	/// (contract A4 residual / Dissent ruling 5).
	#[error(
		"tool `{tool_name}` is catalog-visible but not executable in Slice 0 (status: {status})"
	)]
	UnsupportedTool { tool_name: String, status: ToolStatusV0 },

	/// A wire tool-call observation could not be parsed for the given
	/// shape.
	#[error("wire tool call observation for provider shape `{shape}` is malformed")]
	MalformedToolCall { shape: &'static str },

	/// A wire provider response could not be parsed for the given shape.
	#[error("wire provider response for provider shape `{shape}` is malformed")]
	MalformedResponse { shape: &'static str },
}

/// Kernel-side input for building a `NormalizedProviderRequestV0`.
///
/// This is the projection surface C7 (`KernelTurnRunner`, not yet built) is
/// expected to populate once the turn lifecycle exists: canonical successor
/// IDs assigned up front by the turn runner's `id_factory`, the provider API
/// shape selected for the turn, an optional short content preview (never a
/// full message body -- previews only, per the DTO's documented intent), an
/// optional pointer at the assembled context item this request was built
/// from, and the name of the tool this turn intends to call, if any, so
/// [`build_provider_request`] can reject the request before it is ever sent
/// to a provider when that tool is not executable in Slice 0.
#[derive(Debug, Clone)]
pub struct ProviderBuildInputV0 {
	pub request_id:         RequestId,
	pub turn_id:            TurnId,
	pub provider_api_shape: ProviderApiShapeV0,
	pub content_preview:    Option<String>,
	pub source_artifact_id: Option<ArtifactId>,
	pub source_ref:         Option<String>,
	pub tool_name:          Option<String>,
}

/// Builds a `NormalizedProviderRequestV0` from kernel turn input, gating on
/// tool-catalog support.
///
/// Returns [`ProjectionError::ToolNotInCatalog`] when `tool_name` names a
/// tool absent from `catalog`, and [`ProjectionError::UnsupportedTool`] when
/// the catalog carries the tool but its `status` is not
/// `ToolStatusV0::Executable`. A turn with no `tool_name` (a pure text turn)
/// always succeeds.
pub fn build_provider_request(
	input: &ProviderBuildInputV0,
	catalog: &ToolCatalogV0,
) -> Result<NormalizedProviderRequestV0, ProjectionError> {
	if let Some(tool_name) = &input.tool_name {
		reject_unsupported_tool(tool_name, catalog)?;
	}

	Ok(NormalizedProviderRequestV0 {
		event_type:         PROVIDER_REQUEST_BUILT_EVENT_TYPE.to_owned(),
		request_id:         input.request_id.clone(),
		turn_id:            input.turn_id.clone(),
		provider_api_shape: input.provider_api_shape.clone(),
		content_preview:    input.content_preview.clone(),
		source_artifact_id: input.source_artifact_id.clone(),
		source_ref:         input.source_ref.clone(),
	})
}

/// The Slice-0 catalog gate shared by [`build_provider_request`] and any
/// future call site that must not bypass it (Dissent ruling 5).
fn reject_unsupported_tool(
	tool_name: &str,
	catalog: &ToolCatalogV0,
) -> Result<(), ProjectionError> {
	match catalog.tools.iter().find(|tool| tool.name == tool_name) {
		None => Err(ProjectionError::ToolNotInCatalog { tool_name: tool_name.to_owned() }),
		Some(tool) if tool.status != ToolStatusV0::Executable => {
			Err(ProjectionError::UnsupportedTool {
				tool_name: tool_name.to_owned(),
				status:    tool.status,
			})
		},
		Some(_) => Ok(()),
	}
}

/// Projects a user-turn preview plus the executable subset of the tool
/// catalog into a provider wire request body.
///
/// Matches the shape produced by
/// `fixtures/slice-0/provider-shape-normalization.json`'s
/// `wire_shapes[].request_projection` for each of the three supported
/// shapes. Non-executable tools are never advertised to a provider.
pub fn project_request_body(
	shape: &ProviderApiShapeV0,
	user_text: &str,
	catalog: &ToolCatalogV0,
) -> WireJson {
	let tools: Vec<&ToolDefinitionV0> = catalog
		.tools
		.iter()
		.filter(|tool| tool.status == ToolStatusV0::Executable)
		.collect();

	match shape {
		ProviderApiShapeV0::AnthropicMessages => serde_json::json!({
			"messages": [{ "role": "user", "content": [{ "type": "text", "text": user_text }] }],
			"tools": tools.iter().map(|tool| serde_json::json!({
				"name": tool.name,
				"description": tool.description,
				"input_schema": tool.input_schema,
			})).collect::<Vec<_>>(),
		}),
		ProviderApiShapeV0::OpenAiChatCompletions => serde_json::json!({
			"messages": [{ "role": "user", "content": user_text }],
			"tools": tools.iter().map(|tool| serde_json::json!({
				"type": "function",
				"function": {
					"name": tool.name,
					"description": tool.description,
					"parameters": tool.input_schema,
				},
			})).collect::<Vec<_>>(),
		}),
		ProviderApiShapeV0::OpenAiResponses => serde_json::json!({
			"input": [{ "role": "user", "content": [{ "type": "input_text", "text": user_text }] }],
			"tools": tools.iter().map(|tool| serde_json::json!({
				"type": "function",
				"name": tool.name,
				"description": tool.description,
				"parameters": tool.input_schema,
			})).collect::<Vec<_>>(),
		}),
	}
}

/// A tool round already completed within the current turn's provider
/// round-trip.
///
/// Carries the tool call the provider requested plus the bounded result
/// text produced for it, including the provider's own wire-level tool-call
/// identifier (see `ProviderObservationMetadataV0::provider_tool_call_id`)
/// so the echoed-back `tool_result`/`function_call_output` block round-trips
/// exactly what the provider itself emitted, not a successor-internal
/// `ToolCallId`.
#[derive(Debug, Clone)]
pub struct CompletedToolRoundV0 {
	pub provider_tool_call_id: String,
	pub tool_name:             String,
	pub arguments:             WireJson,
	pub result_text:           String,
}

/// Projects a full turn conversation -- the original user prompt plus
/// every tool round completed so far -- into a provider wire request body.
///
/// `completed_rounds` empty produces output identical to
/// [`project_request_body`] for the same `user_text`/`catalog`: this
/// function is additive, not a replacement. [`project_request_body`] itself
/// is unchanged and remains the byte-pinned surface validated against
/// `fixtures/slice-0/provider-shape-normalization.json`
/// (`tests/slice0_provider_shapes.rs::
/// request_projection_matches_the_canonical_fixture_for_every_provider_shape`).
///
/// Replaces the previous wholesale `round_text` replacement design
/// (<agent://256> `item_b_fix_ruling`; <agent://259> finding 2 /
/// `hydration_design_adjudication`): every prior round and the original
/// prompt stay present in every subsequent request instead of being
/// discarded after the first tool hop.
pub fn project_conversation_request_body(
	shape: &ProviderApiShapeV0,
	user_text: &str,
	completed_rounds: &[CompletedToolRoundV0],
	catalog: &ToolCatalogV0,
) -> WireJson {
	let mut body = project_request_body(shape, user_text, catalog);
	if completed_rounds.is_empty() {
		return body;
	}

	match shape {
		ProviderApiShapeV0::AnthropicMessages => {
			let messages = body["messages"]
				.as_array_mut()
				.expect("project_request_body always emits a `messages` array for this shape");
			for round in completed_rounds {
				messages.push(serde_json::json!({
					"role": "assistant",
					"content": [{
						"type": "tool_use",
						"id": round.provider_tool_call_id,
						"name": round.tool_name,
						"input": round.arguments,
					}],
				}));
				messages.push(serde_json::json!({
					"role": "user",
					"content": [{
						"type": "tool_result",
						"tool_use_id": round.provider_tool_call_id,
						"content": round.result_text,
					}],
				}));
			}
		},
		ProviderApiShapeV0::OpenAiChatCompletions => {
			let messages = body["messages"]
				.as_array_mut()
				.expect("project_request_body always emits a `messages` array for this shape");
			for round in completed_rounds {
				messages.push(serde_json::json!({
					"role": "assistant",
					"tool_calls": [{
						"id": round.provider_tool_call_id,
						"type": "function",
						"function": {
							"name": round.tool_name,
							"arguments": encode_arguments_as_string(&round.arguments),
						},
					}],
				}));
				messages.push(serde_json::json!({
					"role": "tool",
					"tool_call_id": round.provider_tool_call_id,
					"content": round.result_text,
				}));
			}
		},
		ProviderApiShapeV0::OpenAiResponses => {
			let input = body["input"]
				.as_array_mut()
				.expect("project_request_body always emits an `input` array for this shape");
			for round in completed_rounds {
				input.push(serde_json::json!({
					"type": "function_call",
					"call_id": round.provider_tool_call_id,
					"name": round.tool_name,
					"arguments": encode_arguments_as_string(&round.arguments),
				}));
				input.push(serde_json::json!({
					"type": "function_call_output",
					"call_id": round.provider_tool_call_id,
					"output": round.result_text,
				}));
			}
		},
	}

	body
}

/// `serde_json::Value` serialization is infallible; this documents that
/// invariant at the one call site depending on it instead of unwrapping
/// silently at each use.
fn encode_arguments_as_string(arguments: &WireJson) -> String {
	serde_json::to_string(arguments).expect("serializing a serde_json::Value never fails")
}

/// Projects a normalized tool call into its wire-shape observation JSON
/// (`wire_shapes[].observed_tool_call_projection` in the canonical
/// fixture).
pub fn project_tool_call(
	shape: &ProviderApiShapeV0,
	tool_call: &NormalizedToolCallV0,
	provider_tool_call_id: &str,
) -> WireJson {
	match shape {
		ProviderApiShapeV0::AnthropicMessages => serde_json::json!({
			"type": "tool_use",
			"id": provider_tool_call_id,
			"name": tool_call.tool_name,
			"input": tool_call.arguments,
		}),
		ProviderApiShapeV0::OpenAiChatCompletions => serde_json::json!({
			"id": provider_tool_call_id,
			"type": "function",
			"function": {
				"name": tool_call.tool_name,
				"arguments": encode_arguments_as_string(&tool_call.arguments),
			},
		}),
		ProviderApiShapeV0::OpenAiResponses => serde_json::json!({
			"type": "function_call",
			"call_id": provider_tool_call_id,
			"name": tool_call.tool_name,
			"arguments": encode_arguments_as_string(&tool_call.arguments),
		}),
	}
}

/// Parses a wire tool-call observation into a `NormalizedToolCallV0` plus
/// its `ProviderObservationMetadataV0`.
///
/// The metadata carries the provider-specific call ID as metadata rather
/// than successor identity (canonical fixture assertion:
/// "Provider-specific tool call IDs are metadata, not successor
/// identity").
pub fn normalize_tool_call(
	shape: &ProviderApiShapeV0,
	wire: &WireJson,
	tool_call_id: ToolCallId,
) -> Result<(NormalizedToolCallV0, ProviderObservationMetadataV0), ProjectionError> {
	let malformed = || ProjectionError::MalformedToolCall { shape: shape_label(shape) };

	let (provider_tool_call_id, tool_name, arguments) = match shape {
		ProviderApiShapeV0::AnthropicMessages => {
			let id = wire
				.get("id")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let name = wire
				.get("name")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let input = wire.get("input").ok_or_else(malformed)?.clone();
			(id.to_owned(), name.to_owned(), input)
		},
		ProviderApiShapeV0::OpenAiChatCompletions => {
			let id = wire
				.get("id")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let function = wire.get("function").ok_or_else(malformed)?;
			let name = function
				.get("name")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let args_str = function
				.get("arguments")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let arguments: WireJson = serde_json::from_str(args_str).map_err(|_err| malformed())?;
			(id.to_owned(), name.to_owned(), arguments)
		},
		ProviderApiShapeV0::OpenAiResponses => {
			let id = wire
				.get("call_id")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let name = wire
				.get("name")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let args_str = wire
				.get("arguments")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let arguments: WireJson = serde_json::from_str(args_str).map_err(|_err| malformed())?;
			(id.to_owned(), name.to_owned(), arguments)
		},
	};

	let normalized = NormalizedToolCallV0 {
		event_type: PROVIDER_TOOL_CALL_OBSERVED_EVENT_TYPE.to_owned(),
		tool_call_id,
		tool_name,
		arguments,
	};
	let metadata =
		ProviderObservationMetadataV0 { provider_api_shape: shape.clone(), provider_tool_call_id };
	Ok((normalized, metadata))
}

/// Projects a normalized tool result into its wire-shape JSON.
///
/// (`wire_shapes[].tool_result_projection` in the canonical fixture). The
/// result always references the artifact handle -- `artifact:<id>` -- never
/// inlined tool output, matching the canonical fixture assertion that "each
/// tool result projects from the same artifact handle and does not inline
/// provider credentials."
pub fn project_tool_result(
	shape: &ProviderApiShapeV0,
	tool_result: &NormalizedToolResultV0,
	provider_tool_call_id: &str,
) -> WireJson {
	let content = format!("artifact:{}", tool_result.artifact_id.as_str());
	match shape {
		ProviderApiShapeV0::AnthropicMessages => serde_json::json!({
			"type": "tool_result",
			"tool_use_id": provider_tool_call_id,
			"content": content,
		}),
		ProviderApiShapeV0::OpenAiChatCompletions => serde_json::json!({
			"role": "tool",
			"tool_call_id": provider_tool_call_id,
			"content": content,
		}),
		ProviderApiShapeV0::OpenAiResponses => serde_json::json!({
			"type": "function_call_output",
			"call_id": provider_tool_call_id,
			"output": content,
		}),
	}
}

/// Parses a wire provider response into a `NormalizedResponseV0`.
///
/// A malformed body -- missing the fields this shape requires -- yields
/// [`ProjectionError::MalformedResponse`], which carries only the shape
/// label, never the offending body.
pub fn normalize_response(
	shape: &ProviderApiShapeV0,
	wire: &WireJson,
	message_id: MessageId,
) -> Result<NormalizedResponseV0, ProjectionError> {
	let malformed = || ProjectionError::MalformedResponse { shape: shape_label(shape) };

	let (finish_reason, text) = match shape {
		ProviderApiShapeV0::AnthropicMessages => {
			let stop_reason = wire
				.get("stop_reason")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let content = wire
				.get("content")
				.and_then(WireJson::as_array)
				.ok_or_else(malformed)?;
			let text_block = content
				.iter()
				.find(|block| block.get("type").and_then(WireJson::as_str) == Some("text"));
			let has_tool_use = content
				.iter()
				.any(|block| block.get("type").and_then(WireJson::as_str) == Some("tool_use"));
			let text = if let Some(block) = text_block {
				block
					.get("text")
					.and_then(WireJson::as_str)
					.ok_or_else(malformed)?
					.to_owned()
			} else if has_tool_use {
				// Anthropic emits tool-use-only turns (`stop_reason: "tool_use"`) with no
				// text content block. `NormalizedResponseV0::text` is a required `String`
				// field (not `Option<String>`), so the least-inventive representation
				// consistent with fixture semantics is an empty string; the tool call
				// itself is extracted separately via `normalize_tool_call`.
				String::new()
			} else {
				return Err(malformed());
			};
			(normalize_anthropic_stop_reason(stop_reason), text)
		},
		ProviderApiShapeV0::OpenAiChatCompletions => {
			let choice = wire
				.get("choices")
				.and_then(WireJson::as_array)
				.and_then(|choices| choices.first())
				.ok_or_else(malformed)?;
			let finish_reason = choice
				.get("finish_reason")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let text = choice
				.get("message")
				.and_then(|message| message.get("content"))
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			(finish_reason.to_owned(), text.to_owned())
		},
		ProviderApiShapeV0::OpenAiResponses => {
			let text = wire
				.get("output_text")
				.and_then(WireJson::as_str)
				.ok_or_else(malformed)?;
			let status = wire
				.get("status")
				.and_then(WireJson::as_str)
				.unwrap_or("completed");
			(status.to_owned(), text.to_owned())
		},
	};

	Ok(NormalizedResponseV0 {
		event_type: PROVIDER_RESPONSE_RECORDED_EVENT_TYPE.to_owned(),
		message_id,
		finish_reason,
		text,
	})
}

/// Anthropic's `stop_reason` vocabulary collapsed into the smaller
/// finish-reason vocabulary shared across shapes by `NormalizedResponseV0`.
fn normalize_anthropic_stop_reason(stop_reason: &str) -> String {
	match stop_reason {
		"end_turn" | "stop_sequence" => "stop",
		"max_tokens" => "length",
		"tool_use" => "tool_calls",
		other => other,
	}
	.to_owned()
}

#[cfg(test)]
mod tests {
	use successor_protocol::{ids::ArtifactId, provider::TOOL_RESULT_RECORDED_EVENT_TYPE};

	use super::*;

	fn catalog_with(tools: Vec<ToolDefinitionV0>) -> ToolCatalogV0 {
		ToolCatalogV0::new(
			"catalog_test_00000000-0000-4000-8000-000000000001",
			"2026-07-02T00:00:00Z",
			"v0",
			tools,
		)
	}

	#[test]
	fn build_provider_request_succeeds_for_a_tool_free_turn() {
		let input = ProviderBuildInputV0 {
			request_id:         RequestId::from_raw(
				"req_00000000-0000-4000-8000-000000000001".to_owned(),
			),
			turn_id:            TurnId::from_raw(
				"turn_00000000-0000-4000-8000-000000000001".to_owned(),
			),
			provider_api_shape: ProviderApiShapeV0::AnthropicMessages,
			content_preview:    Some("hello".to_owned()),
			source_artifact_id: None,
			source_ref:         None,
			tool_name:          None,
		};
		let catalog = catalog_with(vec![]);

		let request = build_provider_request(&input, &catalog).expect("tool-free turn always builds");
		assert_eq!(request.event_type, PROVIDER_REQUEST_BUILT_EVENT_TYPE);
		assert_eq!(request.provider_api_shape, ProviderApiShapeV0::AnthropicMessages);
	}

	#[test]
	fn build_provider_request_rejects_a_tool_absent_from_the_catalog() {
		let input = ProviderBuildInputV0 {
			request_id:         RequestId::from_raw(
				"req_00000000-0000-4000-8000-000000000001".to_owned(),
			),
			turn_id:            TurnId::from_raw(
				"turn_00000000-0000-4000-8000-000000000001".to_owned(),
			),
			provider_api_shape: ProviderApiShapeV0::AnthropicMessages,
			content_preview:    None,
			source_artifact_id: None,
			source_ref:         None,
			tool_name:          Some("does_not_exist".to_owned()),
		};
		let catalog = catalog_with(vec![]);

		let err = build_provider_request(&input, &catalog).expect_err("absent tool must be rejected");
		assert_eq!(err, ProjectionError::ToolNotInCatalog { tool_name: "does_not_exist".to_owned() });
	}

	#[test]
	fn build_provider_request_rejects_a_stub_rejected_catalog_tool() {
		let input = ProviderBuildInputV0 {
			request_id:         RequestId::from_raw(
				"req_00000000-0000-4000-8000-000000000001".to_owned(),
			),
			turn_id:            TurnId::from_raw(
				"turn_00000000-0000-4000-8000-000000000001".to_owned(),
			),
			provider_api_shape: ProviderApiShapeV0::AnthropicMessages,
			content_preview:    None,
			source_artifact_id: None,
			source_ref:         None,
			tool_name:          Some("bash".to_owned()),
		};
		let catalog = catalog_with(vec![ToolDefinitionV0::stub_rejected("bash", "execution")]);

		let err =
			build_provider_request(&input, &catalog).expect_err("stub-rejected tool must be rejected");
		assert_eq!(err, ProjectionError::UnsupportedTool {
			tool_name: "bash".to_owned(),
			status:    ToolStatusV0::StubRejected,
		});
	}

	#[test]
	fn malformed_wire_tool_call_error_never_carries_the_wire_body() {
		let wire =
			serde_json::json!({ "unexpected": "shape", "secret": "sk-ant-should-never-appear" });
		let tool_call_id =
			ToolCallId::from_raw("tool_00000000-0000-4000-8000-000000000001".to_owned());

		let err = normalize_tool_call(&ProviderApiShapeV0::AnthropicMessages, &wire, tool_call_id)
			.expect_err("missing id/name/input must be malformed");
		let rendered = format!("{err}");
		assert!(!rendered.contains("sk-ant-should-never-appear"));
		assert_eq!(err, ProjectionError::MalformedToolCall { shape: "anthropic_messages" });
	}

	#[test]
	fn malformed_wire_response_error_never_carries_the_wire_body() {
		let wire = serde_json::json!({ "secret": "sk-ant-should-never-appear" });
		let message_id = MessageId::from_raw("msg_00000000-0000-4000-8000-000000000001".to_owned());

		let err = normalize_response(&ProviderApiShapeV0::AnthropicMessages, &wire, message_id)
			.expect_err("missing stop_reason/content must be malformed");
		let rendered = format!("{err}");
		assert!(!rendered.contains("sk-ant-should-never-appear"));
		assert_eq!(err, ProjectionError::MalformedResponse { shape: "anthropic_messages" });
	}

	#[test]
	fn project_tool_result_never_inlines_artifact_content_only_the_handle() {
		let tool_result = NormalizedToolResultV0 {
			event_type:   TOOL_RESULT_RECORDED_EVENT_TYPE.to_owned(),
			tool_call_id: ToolCallId::from_raw("tool_00000000-0000-4000-8000-000000000001".to_owned()),
			tool_name:    "read".to_owned(),
			status:       "ok".to_owned(),
			artifact_id:  ArtifactId::from_raw("art_00000000-0000-4000-8000-000000000001".to_owned()),
		};

		let wire = project_tool_result(&ProviderApiShapeV0::OpenAiResponses, &tool_result, "call_1");
		assert_eq!(wire["output"], "artifact:art_00000000-0000-4000-8000-000000000001");
	}
	#[test]
	fn normalize_response_succeeds_for_a_tool_use_only_anthropic_message() {
		let wire = serde_json::json!({
			"stop_reason": "tool_use",
			"content": [{
				"type": "tool_use",
				"id": "toolu_01",
				"name": "read",
				"input": { "path": "a.txt" },
			}],
		});
		let message_id = MessageId::from_raw("msg_00000000-0000-4000-8000-000000000002".to_owned());

		let response = normalize_response(&ProviderApiShapeV0::AnthropicMessages, &wire, message_id)
			.expect("a tool-use-only message must normalize, not be treated as malformed");
		assert_eq!(response.finish_reason, "tool_calls");
		assert_eq!(response.text, "");

		let tool_call_id =
			ToolCallId::from_raw("tool_00000000-0000-4000-8000-000000000002".to_owned());
		let block = &wire["content"][0];
		let (tool_call, _metadata) =
			normalize_tool_call(&ProviderApiShapeV0::AnthropicMessages, block, tool_call_id)
				.expect("the tool_use block must still normalize into a tool call");
		assert_eq!(tool_call.tool_name, "read");
	}

	#[test]
	fn normalize_response_keeps_the_text_block_when_content_is_mixed() {
		let wire = serde_json::json!({
			"stop_reason": "tool_use",
			"content": [
				{ "type": "text", "text": "thinking out loud" },
				{ "type": "tool_use", "id": "toolu_02", "name": "bash", "input": {} },
			],
		});
		let message_id = MessageId::from_raw("msg_00000000-0000-4000-8000-000000000003".to_owned());

		let response = normalize_response(&ProviderApiShapeV0::AnthropicMessages, &wire, message_id)
			.expect("mixed text + tool_use content must still normalize");
		assert_eq!(response.text, "thinking out loud");
		assert_eq!(response.finish_reason, "tool_calls");
	}

	#[test]
	fn normalize_response_still_rejects_content_with_neither_text_nor_tool_use() {
		let wire = serde_json::json!({
			"stop_reason": "end_turn",
			"content": [{ "type": "unknown_block_kind" }],
		});
		let message_id = MessageId::from_raw("msg_00000000-0000-4000-8000-000000000004".to_owned());

		let err = normalize_response(&ProviderApiShapeV0::AnthropicMessages, &wire, message_id)
			.expect_err("content with neither a text nor a tool_use block must stay malformed");
		assert_eq!(err, ProjectionError::MalformedResponse { shape: "anthropic_messages" });
	}

	#[test]
	fn first_tool_use_block_wins_when_a_message_carries_more_than_one() {
		// Pins Slice 0's single-call semantics: `AnthropicAdapter::send_message`
		// extracts a tool call by taking the first `tool_use` content block via
		// `.find()`. Mirrored here directly against the wire shape, since
		// `send_message` performs a live HTTP call and this crate has no
		// mock-HTTP dependency in scope for this fix.
		let wire = serde_json::json!({
			"stop_reason": "tool_use",
			"content": [
				{ "type": "tool_use", "id": "toolu_first", "name": "read", "input": {} },
				{ "type": "tool_use", "id": "toolu_second", "name": "bash", "input": {} },
			],
		});
		let first_block = wire["content"]
			.as_array()
			.expect("content is an array")
			.iter()
			.find(|block| block.get("type").and_then(WireJson::as_str) == Some("tool_use"))
			.expect("at least one tool_use block is present");

		let tool_call_id =
			ToolCallId::from_raw("tool_00000000-0000-4000-8000-000000000005".to_owned());
		let (tool_call, _metadata) =
			normalize_tool_call(&ProviderApiShapeV0::AnthropicMessages, first_block, tool_call_id)
				.expect("the first tool_use block normalizes");
		assert_eq!(tool_call.tool_name, "read");
	}
}
