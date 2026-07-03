//! Deterministic session projection DTOs.
//!
//! These types model
//! `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/
//! expected-session-projection.json`.

use serde::{Deserialize, Serialize};

use crate::{
	artifact::ArtifactHash,
	ids::{
		ArtifactId, AssembleId, ContextItemId, EventId, MessageId, SessionId, SourceEnvelopeId,
		ToolCallId, TraceId, TurnId,
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
	pub errors:             Vec<serde_json::Value>,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallProjectionV0 {
	pub tool_call_id:       ToolCallId,
	pub tool_name:          String,
	pub status:             ToolCallStatus,
	pub requested_event_id: EventId,
	pub result_event_id:    EventId,
	pub completed_event_id: EventId,
	pub artifact_id:        ArtifactId,
}

/// Tool lifecycle terminal status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
	Completed,
}

impl ToolCallStatus {
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::Completed => "completed",
		}
	}
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
