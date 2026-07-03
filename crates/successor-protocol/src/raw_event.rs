//! Raw event protocol types.
//!
//! [`RawEventV0`] is the canonical persisted truth for all Slice 0 session
//! events. `KernelFrame` is a live-only projection and is never modeled here.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::Error as _};

use crate::{
	artifact::ArtifactHash,
	error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode},
	ids::{
		ArtifactId, AssembleId, ContextItemId, ErrorId, EventId, MessageId, ProviderEventId,
		RequestId, SessionId, SourceEnvelopeId, ToolCallId, TraceId, TurnId,
	},
};

/// Schema version for [`RawEventV0`].
///
/// Always `"platform.raw_event.v0"`.
pub const RAW_EVENT_SCHEMA_VERSION: &str = "platform.raw_event.v0";

/// Stable Slice 0 event type discriminator.
///
/// The serialized string value (e.g., `"tool_catalog.published"`) is the
/// canonical event type used in [`RawEventV0::event_type`] and in persisted
/// storage.
///
/// Event type strings are stable API. Do not rename or reorder variants.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum RawEventType {
	/// A tool catalog snapshot was published to the session.
	#[serde(rename = "tool_catalog.published")]
	ToolCatalogPublished,
	/// A user turn message was recorded.
	#[serde(rename = "user_turn.recorded")]
	UserTurnRecorded,
	/// A context assembly was requested from `/assemble`.
	#[serde(rename = "assembly.requested")]
	AssemblyRequested,
	/// A context assembly completed successfully.
	#[serde(rename = "assembly.completed")]
	AssemblyCompleted,
	/// A provider request was built and is ready to dispatch.
	#[serde(rename = "provider_request.built")]
	ProviderRequestBuilt,
	/// A provider tool call was observed in the provider response stream.
	#[serde(rename = "provider_tool_call.observed")]
	ProviderToolCallObserved,
	/// A provider response was recorded (streaming complete or non-streaming
	/// reply).
	#[serde(rename = "provider_response.recorded")]
	ProviderResponseRecorded,
	/// A tool call was requested by the kernel.
	#[serde(rename = "tool_call.requested")]
	ToolCallRequested,
	/// A tool call execution started.
	#[serde(rename = "tool_call.started")]
	ToolCallStarted,
	/// A tool call completed successfully.
	#[serde(rename = "tool_call.completed")]
	ToolCallCompleted,
	/// A tool call was rejected before execution (e.g., policy check failed).
	#[serde(rename = "tool_call.rejected")]
	ToolCallRejected,
	/// A tool call execution failed with an error.
	#[serde(rename = "tool_call.failed")]
	ToolCallFailed,
	/// A tool result was recorded.
	#[serde(rename = "tool_result.recorded")]
	ToolResultRecorded,
	/// An assistant turn message was recorded.
	#[serde(rename = "assistant_turn.recorded")]
	AssistantTurnRecorded,
	/// An error condition was recorded.
	#[serde(rename = "error.recorded")]
	ErrorRecorded,
}

impl RawEventType {
	/// Return the stable string representation of this event type.
	///
	/// Matches the serde serialization produced by `#[serde(rename = "...")]`.
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::ToolCatalogPublished => "tool_catalog.published",
			Self::UserTurnRecorded => "user_turn.recorded",
			Self::AssemblyRequested => "assembly.requested",
			Self::AssemblyCompleted => "assembly.completed",
			Self::ProviderRequestBuilt => "provider_request.built",
			Self::ProviderToolCallObserved => "provider_tool_call.observed",
			Self::ProviderResponseRecorded => "provider_response.recorded",
			Self::ToolCallRequested => "tool_call.requested",
			Self::ToolCallStarted => "tool_call.started",
			Self::ToolCallCompleted => "tool_call.completed",
			Self::ToolCallRejected => "tool_call.rejected",
			Self::ToolCallFailed => "tool_call.failed",
			Self::ToolResultRecorded => "tool_result.recorded",
			Self::AssistantTurnRecorded => "assistant_turn.recorded",
			Self::ErrorRecorded => "error.recorded",
		}
	}
}

impl std::fmt::Display for RawEventType {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

/// Artifact metadata embedded in a raw event record.
///
/// Canonical fixtures may include either an ID-backed artifact reference or
/// inline artifact content metadata. `sha256` remains strictly validated at the
/// serde boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RawEventArtifactRef {
	/// The artifact's stable identifier when one has been assigned. Stable
	/// prefix: `art_`.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub artifact_id: Option<ArtifactId>,
	/// Content hash in `sha256:<64 lowercase hex>` format.
	pub sha256:      ArtifactHash,
	/// Byte length of the artifact content.
	pub byte_length: u64,
	/// MIME type of the artifact content.
	pub media_type:  String,
	/// Content encoding, when inline metadata records it.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub encoding:    Option<String>,
	/// Human-readable preview, when inline metadata records it.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub preview:     Option<String>,
	/// Inline fixture content, when canonical raw-event fixtures carry it.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub content:     Option<String>,
}

/// Identifies the kind of component that produced a raw event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProducerKind {
	/// The local kernel daemon produced the event.
	Kernel,
	/// The context platform produced the event.
	Platform,
}

/// Identifies the component that produced a [`RawEventV0`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RawEventProducerV0 {
	/// Kind of producer component.
	pub kind: ProducerKind,
	/// Stable identifier for the specific producer instance.
	pub id:   String,
}

impl Default for RawEventProducerV0 {
	fn default() -> Self {
		Self { kind: ProducerKind::Kernel, id: "local-dev-kernel".to_owned() }
	}
}

/// Durable entity identifiers associated with a [`RawEventV0`].
///
/// Optional identifier fields serialize as explicit nulls in canonical
/// raw-event fixtures. `context_item_ids` defaults to an empty vec and is never
/// null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct EntityIdsV0 {
	/// Message projection identifier.
	pub message_id:         Option<MessageId>,
	/// Tool call identifier.
	pub tool_call_id:       Option<ToolCallId>,
	/// Source envelope identifier.
	pub source_envelope_id: Option<SourceEnvelopeId>,
	/// Artifact identifier.
	pub artifact_id:        Option<ArtifactId>,
	/// Assembly identifier.
	pub assemble_id:        Option<AssembleId>,
	/// Context item identifiers for assembly candidates.
	#[serde(default)]
	pub context_item_ids:   Vec<ContextItemId>,
	/// Trace identifier.
	pub trace_id:           Option<TraceId>,
	/// Error identifier.
	pub error_id:           Option<ErrorId>,
	/// Provider event identifier.
	pub provider_event_id:  Option<ProviderEventId>,
}

/// Visibility flags controlling which projection planes can observe an event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VisibilityV0 {
	/// Visible to model context (provider projection).
	pub model:      bool,
	/// Visible to transcript projection.
	pub transcript: bool,
	/// Visible to recall/memory projection.
	pub recall:     bool,
	/// Visible to context assembly (`/assemble`).
	pub assemble:   bool,
	/// Shareable to external users.
	pub share:      bool,
	/// Visible in debug/inspection projections.
	pub debug:      bool,
}

impl Default for VisibilityV0 {
	fn default() -> Self {
		Self {
			model:      true,
			transcript: true,
			recall:     true,
			assemble:   true,
			share:      false,
			debug:      true,
		}
	}
}

/// Redaction classification for a [`RawEventV0`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RedactionLevelV0 {
	/// Event content is safe for public/debug projection.
	Public,
	/// Event contains potentially sensitive content.
	Sensitive,
}

/// The canonical persisted event record for all Slice 0 session events.
///
/// `RawEventV0` is the source-of-truth representation stored by the platform.
/// `KernelFrame` is a live-only stream projection and is never represented
/// here.
///
/// The `schema_version` field is always `"platform.raw_event.v0"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct RawEventV0 {
	/// Always `"platform.raw_event.v0"`.
	pub schema_version:     String,
	/// Unique identifier for this event.
	pub event_id:           EventId,
	/// Platform-assigned monotonically increasing sequence number within the
	/// session.
	///
	/// Must be unsigned. Do not use floats. Platform decides the final value.
	pub session_seq:        u64,
	/// Idempotency key for this event.
	///
	/// Preserved as-is at the protocol layer. Duplicate detection is performed
	/// by A5 validation.
	pub idempotency_key:    String,
	/// Stable event type discriminator.
	pub event_type:         RawEventType,
	/// Session this event belongs to.
	pub session_id:         SessionId,
	/// Turn this event belongs to, when the event is turn-scoped.
	pub turn_id:            Option<TurnId>,
	/// Request that produced this event.
	pub request_id:         RequestId,
	/// ISO 8601 occurrence timestamp. Stored as a string; no chrono dependency
	/// at this layer.
	pub occurred_at:        String,
	/// Component that produced this event.
	pub producer:           RawEventProducerV0,
	/// The event that causally preceded this one.
	///
	/// `None` for the first event in a causal chain (no prior causation).
	pub causation_event_id: Option<EventId>,
	/// Groups related events. Defaults to `request_id`.
	pub correlation_id:     RequestId,
	/// Durable entity identifiers associated with this event.
	pub entity_ids:         EntityIdsV0,
	/// Visibility flags for projection planes.
	pub visibility:         VisibilityV0,
	/// Redaction classification.
	pub redaction:          RedactionLevelV0,
	/// Event-specific payload. Schema is event-type-specific and validated in
	/// A3/A4/A5.
	pub payload:            serde_json::Value,
	/// Artifact reference embedded in this event, if any.
	pub artifact:           Option<RawEventArtifactRef>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEventV0Unchecked {
	schema_version:     String,
	event_id:           EventId,
	session_seq:        u64,
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

impl From<RawEventV0Unchecked> for RawEventV0 {
	fn from(value: RawEventV0Unchecked) -> Self {
		Self {
			schema_version:     value.schema_version,
			event_id:           value.event_id,
			session_seq:        value.session_seq,
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

impl<'de> Deserialize<'de> for RawEventV0 {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		let event = Self::from(RawEventV0Unchecked::deserialize(deserializer)?);
		event.validate_structure().map_err(D::Error::custom)?;
		Ok(event)
	}
}

impl RawEventV0 {
	/// Construct a [`RawEventV0`] with the canonical schema version and required
	/// fields.
	///
	/// Sets `schema_version` to [`RAW_EVENT_SCHEMA_VERSION`], uses `request_id`
	/// as `correlation_id` by default, initialises `entity_ids` to empty
	/// defaults, `visibility` to default flags, and `redaction` to
	/// [`RedactionLevelV0::Sensitive`]. `turn_id` is supplied for turn-scoped
	/// events and stored as `Some`. Session-level events may carry `null` at
	/// the JSON boundary. `causation_event_id` and `artifact` remain optional;
	/// use [`RawEventV0::with_causation`] and [`RawEventV0::with_artifact`]
	/// to populate them. [`RawEventV0::with_turn_id`] replaces the turn id after
	/// construction.
	#[expect(
		clippy::too_many_arguments,
		reason = "constructor mirrors the flat raw-event envelope; a parameter object would only \
		          relocate the field list"
	)]
	pub fn new(
		session_id: SessionId,
		event_id: EventId,
		event_type: RawEventType,
		session_seq: u64,
		idempotency_key: impl Into<String>,
		request_id: RequestId,
		turn_id: TurnId,
		payload: serde_json::Value,
		occurred_at: impl Into<String>,
	) -> Self {
		let correlation_id = request_id.clone();
		Self {
			schema_version: RAW_EVENT_SCHEMA_VERSION.to_owned(),
			event_id,
			session_seq,
			idempotency_key: idempotency_key.into(),
			event_type,
			session_id,
			turn_id: Some(turn_id),
			request_id,
			occurred_at: occurred_at.into(),
			producer: RawEventProducerV0::default(),
			causation_event_id: None,
			correlation_id,
			entity_ids: EntityIdsV0::default(),
			visibility: VisibilityV0::default(),
			redaction: RedactionLevelV0::Sensitive,
			payload,
			artifact: None,
		}
	}

	/// Replace the turn identifier for this event.
	pub fn with_turn_id(mut self, turn_id: TurnId) -> Self {
		self.turn_id = Some(turn_id);
		self
	}

	/// Set the causation event identifier.
	///
	/// Must be `None` (the default) for the first event in a causal chain.
	pub fn with_causation(mut self, causation_event_id: EventId) -> Self {
		self.causation_event_id = Some(causation_event_id);
		self
	}

	/// Attach a single artifact reference to this event.
	pub fn with_artifact(mut self, artifact: RawEventArtifactRef) -> Self {
		self.artifact = Some(artifact);
		self
	}

	/// Validate basic structural invariants without running full fixture
	/// validation.
	///
	/// Checks that `schema_version` is `"platform.raw_event.v0"` and that
	/// `idempotency_key` is non-empty. Also enforces that only session-level
	/// `tool_catalog.published` events may omit `turn_id`. Full fixture
	/// validation (causation ordering, duplicate idempotency keys, etc.) is
	/// performed by A5.
	pub fn validate_structure(&self) -> ProtocolResult<()> {
		if self.schema_version != RAW_EVENT_SCHEMA_VERSION {
			return Err(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!(
					"raw event schema_version must be `{RAW_EVENT_SCHEMA_VERSION}`, got `{}`",
					self.schema_version
				),
			));
		}
		if self.idempotency_key.is_empty() {
			return Err(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				"idempotency_key must not be empty",
			));
		}
		if self.turn_id.is_none() && self.event_type != RawEventType::ToolCatalogPublished {
			return Err(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				"turn_id must be present for turn-scoped raw events",
			));
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		artifact::ArtifactHash,
		error::ProtocolViolationCode,
		ids::{ArtifactId, EventId, RequestId, SessionId, TurnId},
	};

	fn make_session() -> SessionId {
		SessionId::try_from("ses_test1".to_owned()).unwrap()
	}

	fn make_event() -> EventId {
		EventId::try_from("evt_test1".to_owned()).unwrap()
	}

	fn make_request() -> RequestId {
		RequestId::try_from("req_test1".to_owned()).unwrap()
	}

	fn make_turn() -> TurnId {
		TurnId::try_from("turn_test1".to_owned()).unwrap()
	}
	#[test]
	fn raw_event_schema_version_constant() {
		assert_eq!(RAW_EVENT_SCHEMA_VERSION, "platform.raw_event.v0");
	}

	#[test]
	fn event_type_serializes_with_dot_notation() {
		let json = serde_json::to_string(&RawEventType::ToolCatalogPublished).unwrap();
		assert_eq!(json, r#""tool_catalog.published""#);

		let json = serde_json::to_string(&RawEventType::AssemblyRequested).unwrap();
		assert_eq!(json, r#""assembly.requested""#);

		let json = serde_json::to_string(&RawEventType::ErrorRecorded).unwrap();
		assert_eq!(json, r#""error.recorded""#);
	}

	#[test]
	fn event_type_as_str_matches_serde_for_all_variants() {
		let cases = [
			(RawEventType::ToolCatalogPublished, "tool_catalog.published"),
			(RawEventType::UserTurnRecorded, "user_turn.recorded"),
			(RawEventType::AssemblyRequested, "assembly.requested"),
			(RawEventType::AssemblyCompleted, "assembly.completed"),
			(RawEventType::ProviderRequestBuilt, "provider_request.built"),
			(RawEventType::ProviderToolCallObserved, "provider_tool_call.observed"),
			(RawEventType::ProviderResponseRecorded, "provider_response.recorded"),
			(RawEventType::ToolCallRequested, "tool_call.requested"),
			(RawEventType::ToolCallStarted, "tool_call.started"),
			(RawEventType::ToolCallCompleted, "tool_call.completed"),
			(RawEventType::ToolCallRejected, "tool_call.rejected"),
			(RawEventType::ToolCallFailed, "tool_call.failed"),
			(RawEventType::ToolResultRecorded, "tool_result.recorded"),
			(RawEventType::AssistantTurnRecorded, "assistant_turn.recorded"),
			(RawEventType::ErrorRecorded, "error.recorded"),
		];
		for (variant, expected) in cases {
			assert_eq!(variant.as_str(), expected, "as_str mismatch for {variant:?}");
			let json = serde_json::to_string(&variant).unwrap();
			assert_eq!(json, format!("\"{expected}\""), "serde mismatch for {variant:?}");
		}
	}

	#[test]
	fn event_type_deserializes_from_dot_string() {
		let ty: RawEventType = serde_json::from_str(r#""tool_call.completed""#).unwrap();
		assert_eq!(ty, RawEventType::ToolCallCompleted);
	}

	#[test]
	fn raw_event_construction_sets_schema_version_and_defaults() {
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::UserTurnRecorded,
			0,
			"idem_key_1",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:00Z",
		);
		assert_eq!(ev.schema_version, RAW_EVENT_SCHEMA_VERSION);
		assert_eq!(
			ev.turn_id.as_ref().map(|id| id.as_str()),
			Some(make_turn().as_str()),
			"turn_id must match constructor arg"
		);
		assert!(ev.causation_event_id.is_none(), "causation_event_id must default to None");
		assert!(ev.artifact.is_none(), "artifact must default to None");
		assert_eq!(ev.session_seq, 0);
		assert_eq!(ev.idempotency_key, "idem_key_1");
		assert!(
			ev.entity_ids.context_item_ids.is_empty(),
			"context_item_ids must default to empty vec"
		);
	}

	#[test]
	fn causation_event_id_is_optional_for_first_event() {
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ToolCatalogPublished,
			0,
			"idem_key_first",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:00Z",
		);
		assert!(ev.causation_event_id.is_none());
	}

	#[test]
	fn raw_event_with_causation_sets_causation_event_id() {
		let causation = EventId::try_from("evt_cause1".to_owned()).unwrap();
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::AssemblyCompleted,
			1,
			"idem_key_2",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:01Z",
		)
		.with_causation(causation.clone());
		assert_eq!(ev.causation_event_id.as_ref().map(|e| e.as_str()), Some(causation.as_str()));
	}

	#[test]
	fn raw_event_with_turn_id() {
		let turn = TurnId::try_from("turn_001".to_owned()).unwrap();
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::UserTurnRecorded,
			1,
			"idem_key_3",
			make_request(),
			turn.clone(),
			serde_json::json!({"text": "hello"}),
			"2026-01-01T00:00:02Z",
		);
		assert_eq!(ev.turn_id.as_ref().map(|id| id.as_str()), Some(turn.as_str()));
	}

	#[test]
	fn raw_event_deserializes_fixture_session_level_null_turn_and_public_redaction() {
		let json = r#"{
            "schema_version": "platform.raw_event.v0",
            "event_id": "evt_fixture_catalog",
            "session_seq": 1,
            "idempotency_key": "fixture:catalog:1",
            "event_type": "tool_catalog.published",
            "session_id": "ses_fixture",
            "turn_id": null,
            "request_id": "req_fixture",
            "occurred_at": "2026-06-23T12:00:00Z",
            "producer": { "kind": "kernel", "id": "local-dev-kernel" },
            "causation_event_id": null,
            "correlation_id": "req_fixture",
            "entity_ids": { "message_id": null, "tool_call_id": null, "source_envelope_id": null, "artifact_id": null, "assemble_id": null, "context_item_ids": [], "trace_id": null, "error_id": null, "provider_event_id": null },
            "visibility": { "model": true, "transcript": false, "recall": false, "assemble": false, "share": false, "debug": true },
            "redaction": "public",
            "payload": { "catalog_id": "catalog_fixture", "projection_version": "slice0.projection.v0", "tool_count": 34 },
            "artifact": null
        }"#;

		let event = serde_json::from_str::<RawEventV0>(json).unwrap();
		assert!(event.turn_id.is_none(), "session-level fixture event has null turn_id");
		assert_eq!(event.redaction, RedactionLevelV0::Public);
	}

	#[test]
	fn canonical_raw_event_fixtures_deserialize_and_reemit_exact_json_values() {
		let mut all_events = Vec::new();
		for fixture_json in [
			include_str!(
				"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
				 raw-events-successful-turn.json"
			),
			include_str!(
				"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
				 raw-events-unsupported-tool.json"
			),
		] {
			let expected = serde_json::from_str::<serde_json::Value>(fixture_json).unwrap();
			let events = serde_json::from_str::<Vec<RawEventV0>>(fixture_json).unwrap();
			assert!(!events.is_empty(), "fixture must contain raw events");
			assert_eq!(
				serde_json::to_value(&events).unwrap(),
				expected,
				"canonical raw-event fixture must deserialize and reserialize without shape drift"
			);
			all_events.extend(events);
		}

		assert!(
			all_events
				.iter()
				.any(|event| event.event_type == RawEventType::ToolCatalogPublished
					&& event.turn_id.is_none()),
			"canonical fixture set must exercise session-level null turn_id"
		);
		assert!(
			all_events
				.iter()
				.any(|event| event.producer.kind == ProducerKind::Platform),
			"canonical fixture set must exercise platform-produced raw events"
		);
		assert!(
			all_events.iter().any(|event| event
				.artifact
				.as_ref()
				.is_some_and(|artifact| artifact.artifact_id.is_none() && artifact.content.is_some())),
			"canonical fixture set must exercise inline artifact metadata without artifact_id"
		);
	}

	#[test]
	fn raw_event_deserializes_platform_producer_from_fixture() {
		let producer: RawEventProducerV0 =
			serde_json::from_str(r#"{ "kind": "platform", "id": "context-platform-dev" }"#).unwrap();

		assert_eq!(producer.kind, ProducerKind::Platform);
	}

	#[test]
	fn raw_event_deserialize_rejects_null_turn_for_turn_scoped_events() {
		let json = r#"{
            "schema_version": "platform.raw_event.v0",
            "event_id": "evt_fixture_user_turn",
            "session_seq": 2,
            "idempotency_key": "fixture:user:2",
            "event_type": "user_turn.recorded",
            "session_id": "ses_fixture",
            "turn_id": null,
            "request_id": "req_fixture",
            "occurred_at": "2026-06-23T12:00:01Z",
            "producer": { "kind": "kernel", "id": "local-dev-kernel" },
            "causation_event_id": null,
            "correlation_id": "req_fixture",
            "entity_ids": { "message_id": null, "tool_call_id": null, "source_envelope_id": null, "artifact_id": null, "assemble_id": null, "context_item_ids": [], "trace_id": null, "error_id": null, "provider_event_id": null },
            "visibility": { "model": true, "transcript": true, "recall": true, "assemble": true, "share": false, "debug": true },
            "redaction": "sensitive",
            "payload": { "text": "hello" },
            "artifact": null
        }"#;

		let result = serde_json::from_str::<RawEventV0>(json);
		assert!(
			result.is_err(),
			"turn-scoped raw events must reject null turn_id at deserialization"
		);
	}

	#[test]
	fn raw_event_deserialize_rejects_unknown_top_level_and_nested_fields() {
		let base = serde_json::json!({
			 "schema_version": "platform.raw_event.v0",
			 "event_id": "evt_fixture_catalog",
			 "session_seq": 1,
			 "idempotency_key": "fixture:catalog:1",
			 "event_type": "tool_catalog.published",
			 "session_id": "ses_fixture",
			 "turn_id": null,
			 "request_id": "req_fixture",
			 "occurred_at": "2026-06-23T12:00:00Z",
			 "producer": { "kind": "kernel", "id": "local-dev-kernel" },
			 "causation_event_id": null,
			 "correlation_id": "req_fixture",
			 "entity_ids": { "message_id": null, "tool_call_id": null, "source_envelope_id": null, "artifact_id": null, "assemble_id": null, "context_item_ids": [], "trace_id": null, "error_id": null, "provider_event_id": null },
			 "visibility": { "model": true, "transcript": false, "recall": false, "assemble": false, "share": false, "debug": true },
			 "redaction": "public",
			 "payload": { "catalog_id": "catalog_fixture" },
			 "artifact": null
		});

		let mut top_level = base.clone();
		top_level["api_key"] = serde_json::json!("sk-not-real");
		assert!(
			serde_json::from_value::<RawEventV0>(top_level).is_err(),
			"raw events must reject unknown top-level fixture/security fields"
		);

		let mut nested_producer = base.clone();
		nested_producer["producer"]["api_key"] = serde_json::json!("sk-not-real");
		assert!(
			serde_json::from_value::<RawEventV0>(nested_producer).is_err(),
			"raw events must reject unknown producer fields"
		);

		let mut nested_visibility = base;
		nested_visibility["visibility"]["api_key"] = serde_json::json!("sk-not-real");
		assert!(
			serde_json::from_value::<RawEventV0>(nested_visibility).is_err(),
			"raw events must reject unknown visibility fields"
		);
	}

	#[test]
	fn raw_event_validate_structure_passes_for_valid_event() {
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::AssistantTurnRecorded,
			5,
			"idem_key_valid",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:05Z",
		);
		assert!(ev.validate_structure().is_ok());
	}

	#[test]
	fn raw_event_validate_structure_rejects_wrong_schema_version() {
		let mut ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ErrorRecorded,
			0,
			"idem_key_badschema",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:00Z",
		);
		ev.schema_version = "platform.raw_event.v1".to_owned();
		let err = ev.validate_structure().unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::ValidationFailed);
	}

	#[test]
	fn raw_event_validate_structure_rejects_empty_idempotency_key() {
		let mut ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ErrorRecorded,
			0,
			"will_be_cleared",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:00Z",
		);
		ev.idempotency_key = String::new();
		let err = ev.validate_structure().unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::ValidationFailed);
	}

	#[test]
	fn raw_event_with_artifact_sets_ref() {
		let art_id = ArtifactId::try_from("art_001".to_owned()).unwrap();
		let art_ref = RawEventArtifactRef {
			artifact_id: Some(art_id),
			sha256:      ArtifactHash::parse(
				"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			)
			.unwrap(),
			byte_length: 0,
			media_type:  "application/json".to_owned(),
			encoding:    None,
			preview:     None,
			content:     None,
		};
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ToolResultRecorded,
			2,
			"idem_key_art",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:02Z",
		)
		.with_artifact(art_ref);
		assert!(ev.artifact.is_some());
	}

	#[test]
	fn raw_event_validate_structure_rejects_null_turn_for_turn_scoped_events() {
		let mut ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::UserTurnRecorded,
			9,
			"idem_null_turn",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:09Z",
		);
		ev.turn_id = None;

		let err = ev.validate_structure().unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::ValidationFailed);
	}

	#[test]
	fn raw_event_validate_structure_allows_null_turn_for_tool_catalog_published() {
		let mut ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ToolCatalogPublished,
			1,
			"idem_catalog",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:01Z",
		);
		ev.turn_id = None;

		assert!(ev.validate_structure().is_ok());
	}

	#[test]
	fn raw_event_serializes_and_deserializes() {
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ProviderRequestBuilt,
			3,
			"idem_key_serde",
			make_request(),
			make_turn(),
			serde_json::json!({"model": "test-model"}),
			"2026-01-01T00:00:03Z",
		);
		let json = serde_json::to_string(&ev).unwrap();
		let back: RawEventV0 = serde_json::from_str(&json).unwrap();
		assert_eq!(ev, back);
		assert_eq!(back.event_type, RawEventType::ProviderRequestBuilt);
		assert!(json.contains("\"turn_id\""), "turn_id must be present in serialized JSON");
	}

	#[test]
	fn raw_event_serialized_field_names_match_contract() {
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::UserTurnRecorded,
			7,
			"idem_key_fields",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:07Z",
		);
		let json = serde_json::to_string(&ev).unwrap();
		assert!(json.contains("\"session_seq\""), "must use session_seq, not sequence");
		assert!(json.contains("\"occurred_at\""), "must use occurred_at, not created_at");
		assert!(!json.contains("\"sequence\""), "must not contain old field name sequence");
		assert!(!json.contains("\"created_at\""), "must not contain old field name created_at");
		assert!(!json.contains("\"artifacts\""), "must not contain old field name artifacts");
		assert!(json.contains("\"turn_id\""), "turn_id must be present in serialized JSON");
	}

	#[test]
	fn raw_event_artifact_field_is_singular() {
		let art_id = ArtifactId::try_from("art_002".to_owned()).unwrap();
		let art_ref = RawEventArtifactRef {
			artifact_id: Some(art_id),
			sha256:      ArtifactHash::compute(b"art002"),
			byte_length: 42,
			media_type:  "application/octet-stream".to_owned(),
			encoding:    None,
			preview:     None,
			content:     None,
		};
		let ev = RawEventV0::new(
			make_session(),
			make_event(),
			RawEventType::ToolResultRecorded,
			4,
			"idem_key_art2",
			make_request(),
			make_turn(),
			serde_json::Value::Null,
			"2026-01-01T00:00:04Z",
		)
		.with_artifact(art_ref);
		let json = serde_json::to_string(&ev).unwrap();
		assert!(json.contains("\"artifact\""), "must use singular artifact field");
		assert!(!json.contains("\"artifacts\""), "must not use plural artifacts field");
	}
	#[test]
	fn raw_event_artifact_ref_deserialize_rejects_malformed_sha256() {
		// ArtifactHash deserialization rejects malformed sha256 at the field level.
		let json = r#"{"artifact_id":"art_bad1","sha256":"not-a-hash","byte_length":0,"media_type":"text/plain"}"#;
		let result = serde_json::from_str::<RawEventArtifactRef>(json);
		assert!(
			result.is_err(),
			"malformed sha256 must be rejected during RawEventArtifactRef deserialization"
		);
	}

	#[test]
	fn raw_event_artifact_ref_deserializes_inline_fixture_artifact_without_artifact_id() {
		let json = r#"{"media_type":"application/json","encoding":"utf-8","sha256":"sha256:746d4aba680df9855ac47cd327b1addb2386df951b5dd00c72dc95ee3247beec","byte_length":139,"preview":"packages/coding-agent/src/context/concept-graph.ts","content":"{\"matches\":[]}"}"#;
		let artifact = serde_json::from_str::<RawEventArtifactRef>(json).unwrap();

		assert!(artifact.artifact_id.is_none());
		assert_eq!(artifact.encoding.as_deref(), Some("utf-8"));
		assert_eq!(
			artifact.preview.as_deref(),
			Some("packages/coding-agent/src/context/concept-graph.ts")
		);
		assert_eq!(artifact.content.as_deref(), Some("{\"matches\":[]}"));
	}
}
