//! Protocol DTOs for the successor context-platform HTTP boundary.
//!
//! These types describe JSON payloads under `/v0`. They intentionally contain
//! no HTTP server/client, entitlement, storage, replay, or provider-auth logic.
//!
//! `/assemble` returns structured context items and assembly trace data. It
//! does not expose provider message arrays; provider-specific request
//! construction is a downstream projection.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::Error as _};

use crate::{
	artifact::ArtifactV0,
	ids::{
		ArtifactId, AssembleId, ContextItemId, EventId, RequestId, SessionId, SourceEnvelopeId,
		TraceId, TurnId,
	},
	raw_event::{
		EntityIdsV0, RAW_EVENT_SCHEMA_VERSION, RawEventArtifactRef, RawEventProducerV0, RawEventType,
		RawEventV0, RedactionLevelV0, VisibilityV0,
	},
};

pub const EVENT_PAGE_SCHEMA_VERSION: &str = "platform.event_page.v0";
pub const SESSION_SNAPSHOT_SCHEMA_VERSION: &str = "platform.session_snapshot.v0";
pub const ASSEMBLE_REQUEST_SCHEMA_VERSION: &str = "platform.assemble_request.v0";
pub const ASSEMBLY_RESPONSE_SCHEMA_VERSION: &str = "platform.assembly_response.v0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceV0 {
	pub id:        String,
	pub label:     String,
	pub root_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CreatedByV0 {
	pub client_kind: String,
	pub client_id:   String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CreateSessionRequestV0 {
	pub workspace:  WorkspaceV0,
	pub title:      String,
	pub created_by: CreatedByV0,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CreateSessionResponseV0 {
	pub session_id: SessionId,
	pub created_at: String,
}

/// Append request DTO for `/v0/events`.
///
/// This mirrors the A1 raw-event wire shape but intentionally omits
/// `session_seq`, which the platform assigns when the event is persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct RawEventAppendRequestV0 {
	pub schema_version:     String,
	pub event_id:           EventId,
	pub idempotency_key:    String,
	pub event_type:         RawEventType,
	pub session_id:         SessionId,
	pub turn_id:            Option<TurnId>,
	pub request_id:         RequestId,
	pub occurred_at:        String,
	pub producer:           RawEventProducerV0,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub causation_event_id: Option<EventId>,
	pub correlation_id:     RequestId,
	#[serde(default)]
	pub entity_ids:         EntityIdsV0,
	#[serde(default)]
	pub visibility:         VisibilityV0,
	#[serde(default = "default_redaction_level")]
	pub redaction:          RedactionLevelV0,
	#[serde(default)]
	pub payload:            serde_json::Value,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub artifact:           Option<RawEventArtifactRef>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEventAppendRequestV0Unchecked {
	schema_version:     String,
	event_id:           EventId,
	idempotency_key:    String,
	event_type:         RawEventType,
	session_id:         SessionId,
	turn_id:            Option<TurnId>,
	request_id:         RequestId,
	occurred_at:        String,
	producer:           RawEventProducerV0,
	causation_event_id: Option<EventId>,
	correlation_id:     RequestId,
	entity_ids:         EntityIdsV0,
	visibility:         VisibilityV0,
	redaction:          RedactionLevelV0,
	payload:            serde_json::Value,
	artifact:           Option<RawEventArtifactRef>,
}

impl From<RawEventAppendRequestV0Unchecked> for RawEventAppendRequestV0 {
	fn from(value: RawEventAppendRequestV0Unchecked) -> Self {
		Self {
			schema_version:     value.schema_version,
			event_id:           value.event_id,
			idempotency_key:    value.idempotency_key,
			event_type:         value.event_type,
			session_id:         value.session_id,
			turn_id:            value.turn_id,
			request_id:         value.request_id,
			occurred_at:        value.occurred_at,
			producer:           value.producer,
			causation_event_id: value.causation_event_id,
			correlation_id:     value.correlation_id,
			entity_ids:         value.entity_ids,
			visibility:         value.visibility,
			redaction:          value.redaction,
			payload:            value.payload,
			artifact:           value.artifact,
		}
	}
}

impl<'de> Deserialize<'de> for RawEventAppendRequestV0 {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		let request = Self::from(RawEventAppendRequestV0Unchecked::deserialize(deserializer)?);
		if request.schema_version != RAW_EVENT_SCHEMA_VERSION {
			return Err(D::Error::custom(
				"append request schema_version must be platform.raw_event.v0",
			));
		}
		if request.idempotency_key.is_empty() {
			return Err(D::Error::custom("append request idempotency_key must not be empty"));
		}
		if request.turn_id.is_none() && request.event_type != RawEventType::ToolCatalogPublished {
			return Err(D::Error::custom("turn_id must be present for turn-scoped append requests"));
		}
		Ok(request)
	}
}

const fn default_redaction_level() -> RedactionLevelV0 {
	RedactionLevelV0::Sensitive
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RawEventAppendResponseV0 {
	pub event_id:           EventId,
	pub session_seq:        u64,
	pub duplicate:          bool,
	pub stored_at:          String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub source_envelope_id: Option<SourceEnvelopeId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub artifact_id:        Option<ArtifactId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EventPageV0 {
	pub schema_version: String,
	pub session_id:     SessionId,
	pub events:         Vec<RawEventV0>,
	pub next_after_seq: u64,
	pub has_more:       bool,
}

impl EventPageV0 {
	pub fn new(
		session_id: SessionId,
		events: Vec<RawEventV0>,
		next_after_seq: u64,
		has_more: bool,
	) -> Self {
		Self {
			schema_version: EVENT_PAGE_SCHEMA_VERSION.to_owned(),
			session_id,
			events,
			next_after_seq,
			has_more,
		}
	}
}

pub type ReadArtifactResponseV0 = ArtifactV0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionSnapshotV0 {
	pub schema_version:         String,
	pub session_id:             SessionId,
	pub created_at:             String,
	pub updated_at:             String,
	pub last_raw_event_seq:     u64,
	pub raw_event_ids:          Vec<EventId>,
	pub source_envelope_ids:    Vec<SourceEnvelopeId>,
	pub artifact_ids:           Vec<ArtifactId>,
	pub assemble_ids:           Vec<AssembleId>,
	pub last_turn_id:           TurnId,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub last_assistant_summary: Option<String>,
	pub sharing:                SharingV0,
}

impl SessionSnapshotV0 {
	pub fn new(
		session_id: SessionId,
		created_at: impl Into<String>,
		updated_at: impl Into<String>,
		last_raw_event_seq: u64,
		last_turn_id: TurnId,
		sharing: SharingV0,
	) -> Self {
		Self {
			schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION.to_owned(),
			session_id,
			created_at: created_at.into(),
			updated_at: updated_at.into(),
			last_raw_event_seq,
			raw_event_ids: Vec::new(),
			source_envelope_ids: Vec::new(),
			artifact_ids: Vec::new(),
			assemble_ids: Vec::new(),
			last_turn_id,
			last_assistant_summary: None,
			sharing,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SharingV0 {
	pub visibility: String,
	pub grants:     Vec<serde_json::Value>,
}

impl SharingV0 {
	pub fn private() -> Self {
		Self { visibility: "private".to_owned(), grants: Vec::new() }
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ContextItemV0 {
	pub context_item_id:    ContextItemId,
	pub kind:               String,
	pub content:            serde_json::Value,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub source_envelope_id: Option<SourceEnvelopeId>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub artifact_id:        Option<ArtifactId>,
	#[serde(default)]
	pub metadata:           serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DegradationV0 {
	pub code:            String,
	pub reason:          String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub context_item_id: Option<ContextItemId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum AssemblePhaseV0 {
	#[serde(rename = "pre_tool")]
	PreTool,
	#[serde(rename = "post_locator")]
	PostLocator,
	#[serde(rename = "post_read")]
	PostRead,
	#[serde(rename = "final")]
	Final,
}

impl AssemblePhaseV0 {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::PreTool => "pre_tool",
			Self::PostLocator => "post_locator",
			Self::PostRead => "post_read",
			Self::Final => "final",
		}
	}
}

impl std::fmt::Display for AssemblePhaseV0 {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssembleIntentV0 {
	pub query:         String,
	pub raw_user_text: String,
	pub confidence:    String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssembleWorkspaceV0 {
	pub root_hint: String,
	pub repo_id:   String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssemblyBudgetV0 {
	pub max_context_tokens: u64,
	pub max_items:          u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssembleRequestV0 {
	pub schema_version: String,
	pub session_id: SessionId,
	pub turn_id: TurnId,
	pub request_id: RequestId,
	pub phase: AssemblePhaseV0,
	pub intent: AssembleIntentV0,
	pub workspace: AssembleWorkspaceV0,
	pub budget: AssemblyBudgetV0,
	pub required_source_envelope_ids: Vec<SourceEnvelopeId>,
	pub exclude_source_envelope_ids: Vec<SourceEnvelopeId>,
}

impl AssembleRequestV0 {
	pub fn new(
		session_id: SessionId,
		turn_id: TurnId,
		request_id: RequestId,
		phase: AssemblePhaseV0,
		intent: AssembleIntentV0,
		workspace: AssembleWorkspaceV0,
		budget: AssemblyBudgetV0,
	) -> Self {
		Self {
			schema_version: ASSEMBLE_REQUEST_SCHEMA_VERSION.to_owned(),
			session_id,
			turn_id,
			request_id,
			phase,
			intent,
			workspace,
			budget,
			required_source_envelope_ids: Vec::new(),
			exclude_source_envelope_ids: Vec::new(),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssemblyTraceStageV0 {
	pub name:   String,
	#[serde(default)]
	pub detail: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssemblyTraceV0 {
	pub trace_id:           TraceId,
	pub assemble_id:        AssembleId,
	pub query:              String,
	pub projection_version: String,
	pub stages:             Vec<AssemblyTraceStageV0>,
	pub dropped:            Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyV0 {
	pub enabled_sources:  Vec<String>,
	pub disabled_sources: Vec<String>,
	#[serde(default)]
	pub weights:          serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssemblyResponseV0 {
	pub schema_version: String,
	pub assemble_id:    AssembleId,
	pub session_id:     SessionId,
	pub turn_id:        TurnId,
	pub request_id:     RequestId,
	pub phase:          AssemblePhaseV0,
	pub created_at:     String,
	pub context_items:  Vec<ContextItemV0>,
	pub trace:          AssemblyTraceV0,
	pub degradation:    Vec<DegradationV0>,
	pub policy:         PolicyV0,
}

impl AssemblyResponseV0 {
	#[expect(
		clippy::too_many_arguments,
		reason = "constructor mirrors the flat assembly-response envelope; a parameter object would \
		          only relocate the field list"
	)]
	pub fn new(
		assemble_id: AssembleId,
		session_id: SessionId,
		turn_id: TurnId,
		request_id: RequestId,
		phase: AssemblePhaseV0,
		created_at: impl Into<String>,
		trace: AssemblyTraceV0,
		policy: PolicyV0,
	) -> Self {
		Self {
			schema_version: ASSEMBLY_RESPONSE_SCHEMA_VERSION.to_owned(),
			assemble_id,
			session_id,
			turn_id,
			request_id,
			phase,
			created_at: created_at.into(),
			context_items: Vec::new(),
			trace,
			degradation: Vec::new(),
			policy,
		}
	}
}
