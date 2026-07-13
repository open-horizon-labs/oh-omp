//! Deterministic session projection DTOs.
//!
//! These types model
//! `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/
//! expected-session-projection.json`.

use serde::{Deserialize, Serialize, de::Error as _};

use crate::{
	artifact::ArtifactHash,
	error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode},
	ids::{
		ArtifactId, AssembleId, ContextItemId, ErrorId, EventId, MessageId, RequestId, SessionId,
		SourceEnvelopeId, ToolCallId, TraceId, TurnId,
	},
};

/// Schema version for [`SessionProjectionV0`].
pub const EXPECTED_PROJECTION_SCHEMA_VERSION: &str = "platform.expected_projection.v0";

/// Deterministic projection implementation version.
pub const PROJECTION_VERSION: &str = "slice0.projection.v0";

/// Full deterministic projection used by the Slice 0 replay gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionProjectionV0 {
	pub schema_version:     String,
	pub projection_version: String,
	pub session:            SessionSummaryV0,
	pub transcript:         Vec<TranscriptEntryV0>,
	pub tools:              Vec<ToolCallProjectionV0>,
	pub errors:             Vec<ErrorProjectionV0>,
	pub artifacts:          Vec<ArtifactProjectionV0>,
	pub assemblies:         Vec<AssemblyProjectionV0>,
	pub provider_traces:    Vec<ProviderTraceProjectionV0>,
}

/// Session-level replay summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSummaryV0 {
	pub session_id:             SessionId,
	pub last_raw_event_seq:     u64,
	pub last_turn_id:           TurnId,
	pub last_assistant_summary: String,
}

/// Transcript message projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptEntryV0 {
	pub message_id:         MessageId,
	pub role:               MessageRole,
	pub source_event_id:    EventId,
	pub source_envelope_id: SourceEnvelopeId,
	pub text:               String,
}

/// Transcript role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
	User,
	Assistant,
}

impl MessageRole {
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::User => "user",
			Self::Assistant => "assistant",
		}
	}
}

/// Tool lifecycle projection.
///
/// `status` determines which optional fields are populated:
/// - [`ToolCallStatus::Completed`] rows always carry `result_event_id`,
///   `completed_event_id`, and `artifact_id`, and never carry any of the
///   failure-chain fields below.
/// - [`ToolCallStatus::Failed`] rows always carry `started_event_id`,
///   `error_event_id`, `failed_event_id`, and `error_id`, and never carry a
///   result, completion, or artifact.
///   [`ToolCallProjectionV0::validate_structure`] enforces this split on every
///   deserialize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolCallProjectionV0 {
	pub tool_call_id:       ToolCallId,
	pub tool_name:          String,
	pub status:             ToolCallStatus,
	pub requested_event_id: EventId,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub result_event_id:    Option<EventId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub completed_event_id: Option<EventId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub artifact_id:        Option<ArtifactId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub started_event_id:   Option<EventId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error_event_id:     Option<EventId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub failed_event_id:    Option<EventId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error_id:           Option<ErrorId>,
}

/// Wire payload for [`ToolCallProjectionV0`], checked by
/// [`ToolCallProjectionV0::validate_structure`] before being accepted.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCallProjectionV0Unchecked {
	tool_call_id:       ToolCallId,
	tool_name:          String,
	status:             ToolCallStatus,
	requested_event_id: EventId,
	#[serde(default)]
	result_event_id:    Option<EventId>,
	#[serde(default)]
	completed_event_id: Option<EventId>,
	#[serde(default)]
	artifact_id:        Option<ArtifactId>,
	#[serde(default)]
	started_event_id:   Option<EventId>,
	#[serde(default)]
	error_event_id:     Option<EventId>,
	#[serde(default)]
	failed_event_id:    Option<EventId>,
	#[serde(default)]
	error_id:           Option<ErrorId>,
}

impl From<ToolCallProjectionV0Unchecked> for ToolCallProjectionV0 {
	fn from(value: ToolCallProjectionV0Unchecked) -> Self {
		Self {
			tool_call_id:       value.tool_call_id,
			tool_name:          value.tool_name,
			status:             value.status,
			requested_event_id: value.requested_event_id,
			result_event_id:    value.result_event_id,
			completed_event_id: value.completed_event_id,
			artifact_id:        value.artifact_id,
			started_event_id:   value.started_event_id,
			error_event_id:     value.error_event_id,
			failed_event_id:    value.failed_event_id,
			error_id:           value.error_id,
		}
	}
}

impl<'de> Deserialize<'de> for ToolCallProjectionV0 {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		let value = Self::from(ToolCallProjectionV0Unchecked::deserialize(deserializer)?);
		value.validate_structure().map_err(D::Error::custom)?;
		Ok(value)
	}
}

impl ToolCallProjectionV0 {
	/// Validate that the optional fields are populated consistently with
	/// `status`: a completed row must carry exactly the success fields, and
	/// a failed row must carry exactly the failure-chain fields.
	pub fn validate_structure(&self) -> ProtocolResult<()> {
		match &self.status {
			ToolCallStatus::Completed => {
				if self.result_event_id.is_none()
					|| self.completed_event_id.is_none()
					|| self.artifact_id.is_none()
				{
					return Err(ProtocolViolation::new(
						ProtocolViolationCode::ValidationFailed,
						"a completed tool call projection row must carry result_event_id, \
						 completed_event_id, and artifact_id",
					));
				}
				if self.started_event_id.is_some()
					|| self.error_event_id.is_some()
					|| self.failed_event_id.is_some()
					|| self.error_id.is_some()
				{
					return Err(ProtocolViolation::new(
						ProtocolViolationCode::ValidationFailed,
						"a completed tool call projection row must not carry failure-chain fields",
					));
				}
			},
			ToolCallStatus::Failed => {
				if self.started_event_id.is_none()
					|| self.error_event_id.is_none()
					|| self.failed_event_id.is_none()
					|| self.error_id.is_none()
				{
					return Err(ProtocolViolation::new(
						ProtocolViolationCode::ValidationFailed,
						"a failed tool call projection row must carry started_event_id, error_event_id, \
						 failed_event_id, and error_id",
					));
				}
				if self.result_event_id.is_some()
					|| self.completed_event_id.is_some()
					|| self.artifact_id.is_some()
				{
					return Err(ProtocolViolation::new(
						ProtocolViolationCode::ValidationFailed,
						"a failed tool call projection row must never carry a result, completion, or \
						 artifact",
					));
				}
			},
		}
		Ok(())
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
	Completed,
	Failed,
}

impl ToolCallStatus {
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::Completed => "completed",
			Self::Failed => "failed",
		}
	}
}

/// Typed projection of a persisted `error.recorded` envelope, retained only
/// once its owning tool call reaches the `failed` terminal state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorProjectionV0 {
	pub error_id:       ErrorId,
	pub tool_call_id:   ToolCallId,
	pub error_event_id: EventId,
	pub code:           String,
	pub message:        String,
	pub recoverable:    bool,
	pub retryable:      bool,
	pub correlation_id: RequestId,
	pub details:        serde_json::Value,
}

/// Artifact index projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactProjectionV0 {
	pub artifact_id:     ArtifactId,
	pub source_event_id: EventId,
	pub sha256:          ArtifactHash,
	pub byte_length:     u64,
}

/// Assembly trace projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssemblyProjectionV0 {
	pub assemble_id:      AssembleId,
	pub phase:            String,
	pub context_item_ids: Vec<ContextItemId>,
}

/// Provider request trace projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTraceProjectionV0 {
	pub trace_id:           TraceId,
	pub phase:              String,
	pub provider_id:        String,
	pub provider_api_shape: String,
	pub context_item_ids:   Vec<ContextItemId>,
}

#[cfg(test)]
mod tests {
	use super::*;

	fn completed_row_json() -> serde_json::Value {
		serde_json::json!({
			"tool_call_id": "tool_00000000-0000-4000-8000-000000000001",
			"tool_name": "read_file",
			"status": "completed",
			"requested_event_id": "evt_00000000-0000-4000-8000-000000000001",
			"result_event_id": "evt_00000000-0000-4000-8000-000000000002",
			"completed_event_id": "evt_00000000-0000-4000-8000-000000000003",
			"artifact_id": "art_00000000-0000-4000-8000-000000000001",
		})
	}

	fn failed_row_json() -> serde_json::Value {
		serde_json::json!({
			"tool_call_id": "tool_00000000-0000-4000-8000-000000000001",
			"tool_name": "read_file",
			"status": "failed",
			"requested_event_id": "evt_00000000-0000-4000-8000-000000000001",
			"started_event_id": "evt_00000000-0000-4000-8000-000000000002",
			"error_event_id": "evt_00000000-0000-4000-8000-000000000003",
			"failed_event_id": "evt_00000000-0000-4000-8000-000000000004",
			"error_id": "err_00000000-0000-4000-8000-000000000001",
		})
	}

	#[test]
	fn completed_row_round_trips() {
		let row: ToolCallProjectionV0 = serde_json::from_value(completed_row_json())
			.expect("a well-formed completed row must parse");
		assert_eq!(row.status, ToolCallStatus::Completed);
		assert!(row.result_event_id.is_some());
		assert!(row.completed_event_id.is_some());
		assert!(row.artifact_id.is_some());
	}

	#[test]
	fn completed_row_with_a_failure_chain_field_is_rejected() {
		let mut json = completed_row_json();
		json["error_id"] =
			serde_json::Value::String("err_00000000-0000-4000-8000-000000000001".to_owned());
		assert!(
			serde_json::from_value::<ToolCallProjectionV0>(json).is_err(),
			"a completed row must never carry a failure-chain field"
		);
	}

	#[test]
	fn failed_row_round_trips() {
		let row: ToolCallProjectionV0 =
			serde_json::from_value(failed_row_json()).expect("a well-formed failed row must parse");
		assert_eq!(row.status, ToolCallStatus::Failed);
		assert!(row.started_event_id.is_some());
		assert!(row.error_event_id.is_some());
		assert!(row.failed_event_id.is_some());
		assert!(row.error_id.is_some());
	}

	#[test]
	fn failed_row_with_a_result_field_is_rejected() {
		let mut json = failed_row_json();
		json["result_event_id"] =
			serde_json::Value::String("evt_00000000-0000-4000-8000-000000000099".to_owned());
		assert!(
			serde_json::from_value::<ToolCallProjectionV0>(json).is_err(),
			"a failed row must never carry a result, completion, or artifact"
		);
	}

	#[test]
	fn failed_row_missing_a_required_failure_chain_field_is_rejected() {
		let mut json = failed_row_json();
		json
			.as_object_mut()
			.expect("object")
			.remove("failed_event_id");
		assert!(
			serde_json::from_value::<ToolCallProjectionV0>(json).is_err(),
			"a failed row missing failed_event_id must be rejected"
		);
	}
}
