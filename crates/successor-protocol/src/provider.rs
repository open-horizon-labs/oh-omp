//! Provider API shape normalization protocol types.
//!
//! Defines the stable [`ProviderApiShapeV0`] discriminant, canonical successor
//! ID container, and normalized protocol DTOs for tool calls, tool results, and
//! responses.
//!
//! # Invariants
//!
//! - Provider wire objects never become canonical state.
//! - All types here are protocol data only.
//! - Provider credentials must not appear in any value of these types.
//! - Provider-specific tool call IDs (e.g., `toolu_…`, `call_…`) are metadata;
//!   they must not be used as successor identity. Use
//!   [`CanonicalSuccessorIdsV0::tool_call_id`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::Error as _};

use crate::ids::{ArtifactId, MessageId, ProviderEventId, RequestId, ToolCallId, TurnId};

/// Schema version for normalized provider traces.
///
/// Always `"kernel.provider_normalized.v0"`.
pub const PROVIDER_NORMALIZED_SCHEMA_VERSION: &str = "kernel.provider_normalized.v0";

/// Event type discriminant for a `provider_request.built` trace record.
pub const PROVIDER_REQUEST_BUILT_EVENT_TYPE: &str = "provider_request.built";
/// Event type discriminant for a `provider_tool_call.observed` trace record.
pub const PROVIDER_TOOL_CALL_OBSERVED_EVENT_TYPE: &str = "provider_tool_call.observed";

/// Event type discriminant for a `tool_result.recorded` trace record.
pub const TOOL_RESULT_RECORDED_EVENT_TYPE: &str = "tool_result.recorded";

/// Event type discriminant for a `provider_response.recorded` trace record.
pub const PROVIDER_RESPONSE_RECORDED_EVENT_TYPE: &str = "provider_response.recorded";

fn deserialize_provider_request_built_event_type<'de, D>(
	deserializer: D,
) -> Result<String, D::Error>
where
	D: serde::Deserializer<'de>,
{
	deserialize_fixed_event_type(deserializer, PROVIDER_REQUEST_BUILT_EVENT_TYPE)
}

fn deserialize_provider_tool_call_observed_event_type<'de, D>(
	deserializer: D,
) -> Result<String, D::Error>
where
	D: serde::Deserializer<'de>,
{
	deserialize_fixed_event_type(deserializer, PROVIDER_TOOL_CALL_OBSERVED_EVENT_TYPE)
}

fn deserialize_tool_result_recorded_event_type<'de, D>(deserializer: D) -> Result<String, D::Error>
where
	D: serde::Deserializer<'de>,
{
	deserialize_fixed_event_type(deserializer, TOOL_RESULT_RECORDED_EVENT_TYPE)
}

fn deserialize_provider_response_recorded_event_type<'de, D>(
	deserializer: D,
) -> Result<String, D::Error>
where
	D: serde::Deserializer<'de>,
{
	deserialize_fixed_event_type(deserializer, PROVIDER_RESPONSE_RECORDED_EVENT_TYPE)
}

fn deserialize_fixed_event_type<'de, D>(
	deserializer: D,
	expected: &'static str,
) -> Result<String, D::Error>
where
	D: serde::Deserializer<'de>,
{
	let actual = String::deserialize(deserializer)?;
	if actual == expected {
		Ok(actual)
	} else {
		Err(D::Error::custom(format!("expected event_type `{expected}`, got `{actual}`")))
	}
}

/// Stable discriminant for provider API shape.
///
/// Serializes to/from the exact strings `anthropic_messages`,
/// `openai_chat_completions`, and `openai_responses`.
/// No other values are accepted; unknown variants will fail deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum ProviderApiShapeV0 {
	/// Anthropic Messages API (`POST /v1/messages`).
	#[serde(rename = "anthropic_messages")]
	AnthropicMessages,
	/// `OpenAI` Chat Completions API (`POST /v1/chat/completions`).
	#[serde(rename = "openai_chat_completions")]
	OpenAiChatCompletions,
	/// `OpenAI` Responses API (`POST /v1/responses`).
	#[serde(rename = "openai_responses")]
	OpenAiResponses,
}

/// Canonical successor IDs for a normalized provider interaction.
///
/// These IDs are stable replay identity. Provider-specific IDs (e.g.,
/// `toolu_…`, `call_…`) are metadata only and must not be stored here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CanonicalSuccessorIdsV0 {
	/// Successor request identifier. Stable prefix: `req_`.
	pub request_id:        RequestId,
	/// Successor turn identifier. Stable prefix: `turn_`.
	pub turn_id:           TurnId,
	/// Successor tool call identifier. Assigned by the kernel; stable across
	/// providers. Stable prefix: `tool_`.
	pub tool_call_id:      ToolCallId,
	/// Successor provider event identifier for replay. Stable prefix: `pevt_`.
	pub provider_event_id: ProviderEventId,
	/// Successor message identifier for the assistant response. Stable prefix:
	/// `msg_`.
	pub message_id:        MessageId,
}

/// Normalized tool call observation, independent of provider wire shape.
///
/// `event_type` is always `"provider_tool_call.observed"`.
/// `tool_call_id` is the canonical successor ID assigned by the kernel,
/// not the provider-specific wire identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NormalizedToolCallV0 {
	/// Event type discriminator. Expected value:
	/// `"provider_tool_call.observed"`.
	#[serde(deserialize_with = "deserialize_provider_tool_call_observed_event_type")]
	pub event_type:   String,
	/// Canonical successor tool call ID. Must carry the `tool_` prefix.
	/// This is distinct from any provider-specific wire ID.
	pub tool_call_id: ToolCallId,
	/// Tool name as normalized from the provider response.
	pub tool_name:    String,
	/// Parsed tool arguments as a JSON value.
	/// `OpenAI` Chat and Responses shapes encode arguments as JSON strings on
	/// the wire; normalization parses them into a structured value.
	pub arguments:    serde_json::Value,
}

/// Normalized tool result record, independent of provider wire shape.
///
/// `event_type` is always `"tool_result.recorded"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NormalizedToolResultV0 {
	/// Event type discriminator. Expected value: `"tool_result.recorded"`.
	#[serde(deserialize_with = "deserialize_tool_result_recorded_event_type")]
	pub event_type:   String,
	/// Canonical successor tool call ID. Must match the originating
	/// [`NormalizedToolCallV0`].
	pub tool_call_id: ToolCallId,
	/// Tool name. Must match the originating [`NormalizedToolCallV0`].
	pub tool_name:    String,
	/// Execution status. `"ok"` for successful results.
	pub status:       String,
	/// Artifact identifier for the stored result content. Stable prefix: `art_`.
	pub artifact_id:  ArtifactId,
}

/// Normalized provider response record.
///
/// `event_type` is always `"provider_response.recorded"`.
/// Streaming token deltas are KernelFrame-only; only coarse provider
/// observations are recorded as raw events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NormalizedResponseV0 {
	/// Event type discriminator. Expected value: `"provider_response.recorded"`.
	#[serde(deserialize_with = "deserialize_provider_response_recorded_event_type")]
	pub event_type:    String,
	/// Canonical successor message identifier. Stable prefix: `msg_`.
	pub message_id:    MessageId,
	/// Provider finish reason (e.g., `"stop"`, `"tool_use"`, `"tool_calls"`).
	pub finish_reason: String,
	/// Assistant response text, or a content preview/source reference for large
	/// responses.
	pub text:          String,
}

/// Stable trace DTO for a built provider request (`provider_request.built`).
///
/// This is the normalization boundary between kernel request assembly and the
/// provider wire transport. Downstream lanes (A4 replay, A5 validation) use
/// this as the stable `provider_request.built` event payload.
///
/// Provider wire objects (raw body, auth headers, transport metadata) must not
/// appear here. Use [`ProviderWireShapeV0`] for fixture-level wire projections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NormalizedProviderRequestV0 {
	/// Event type discriminator. Expected value: `"provider_request.built"`.
	#[serde(deserialize_with = "deserialize_provider_request_built_event_type")]
	pub event_type:         String,
	/// Canonical successor request identifier. Stable prefix: `req_`.
	pub request_id:         RequestId,
	/// Canonical successor turn identifier. Stable prefix: `turn_`.
	pub turn_id:            TurnId,
	/// Provider API shape this request was built for.
	pub provider_api_shape: ProviderApiShapeV0,
	/// Bounded preview of the request content (e.g., the last user message
	/// text, truncated). Must not include credentials, auth headers, or raw
	/// wire body. `None` when no preview is available or applicable.
	pub content_preview:    Option<String>,
	/// Artifact identifier for the stored request content, if persisted.
	/// Stable prefix: `art_`. `None` when no artifact was stored.
	pub source_artifact_id: Option<ArtifactId>,
	/// Human-readable source reference (e.g., a content address, commit SHA,
	/// or file path). For tracing only; not a successor ID.
	pub source_ref:         Option<String>,
}

/// Provider wire-shape projection for a single API shape case.
///
/// Holds the raw JSON projections as they would appear on the wire for the
/// request body, observed tool call, and tool result. These are protocol data
/// only and must never become canonical state.
///
/// `provider_specific_tool_call_id` is a wire-level metadata string. It must
/// not be promoted to successor identity; use
/// [`CanonicalSuccessorIdsV0::tool_call_id`] for replay identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderWireShapeV0 {
	/// Identifies which provider API shape this projection belongs to.
	pub provider_api_shape:             ProviderApiShapeV0,
	/// Provider-specific tool call ID as it appears on the wire
	/// (e.g., `"toolu_…"` for Anthropic, `"call_…"` for `OpenAI`).
	/// This is metadata only; it is never used as successor identity.
	pub provider_specific_tool_call_id: String,
	/// Raw provider request body projection (messages, tools, etc.) as a JSON
	/// value.
	pub request_projection:             serde_json::Value,
	/// Raw provider tool call observation projection as a JSON value.
	/// For Anthropic: a `tool_use` content block.
	/// For `OpenAI` Chat: a function call object in `tool_calls`.
	/// For `OpenAI` Responses: a `function_call` item.
	pub observed_tool_call_projection:  serde_json::Value,
	/// Raw provider tool result projection as a JSON value.
	/// For Anthropic: a `tool_result` content block.
	/// For `OpenAI` Chat: a `tool` role message.
	/// For `OpenAI` Responses: a `function_call_output` item.
	pub tool_result_projection:         serde_json::Value,
}

/// Provider-specific observation metadata.
///
/// Captures provider-assigned IDs alongside a protocol event as metadata.
/// These values must never be substituted for canonical successor IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderObservationMetadataV0 {
	/// Provider API shape this observation came from.
	pub provider_api_shape:    ProviderApiShapeV0,
	/// Provider-assigned tool call ID (wire-only; not a successor identity).
	/// Examples: `"toolu_…"` (Anthropic), `"call_…"` (`OpenAI` Chat/Responses).
	pub provider_tool_call_id: String,
}
