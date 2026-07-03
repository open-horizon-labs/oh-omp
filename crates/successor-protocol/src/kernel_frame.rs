//! Kernel frame protocol types.
//!
//! [`KernelFrameV0`] is the **live-only** delivery and progress projection
//! emitted over SSE. It is never the canonical persisted truth; that role
//! belongs exclusively to [`crate::raw_event::RawEventV0`].
//!
//! SSE wire event name: `kernel_frame`.
//! Data field: JSON-encoded [`KernelFrameV0`].
//!
//! Kernel stream ordering authority is [`KernelFrameV0::stream_seq`] —
//! kernel-assigned and total within a live request stream.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
	ids::{EventId, FrameId, RequestId, SessionId, TurnId},
	raw_event::EntityIdsV0,
};

/// Schema version for [`KernelFrameV0`].
///
/// Always `"kernel.frame.v0"`.
pub const KERNEL_FRAME_SCHEMA_VERSION: &str = "kernel.frame.v0";

/// SSE wire event name for kernel frames.
///
/// The SSE `event:` line value when streaming [`KernelFrameV0`] to clients.
pub const KERNEL_FRAME_SSE_EVENT_NAME: &str = "kernel_frame";

/// Frame-type-specific payload type.
///
/// Schema is determined by [`KernelFrameKindV0`]. Carries opaque JSON so that
/// new payload fields can be added without a protocol version bump.
/// Unrecognized keys must be tolerated by consumers.
pub type KernelFramePayloadV0 = serde_json::Value;

/// A live kernel stream frame.
///
/// `KernelFrameV0` is the live delivery and progress projection only.
/// It **must not** be stored as canonical persisted truth; use
/// [`crate::raw_event::RawEventV0`] for that purpose.
///
/// Frames may reference a persisted [`crate::raw_event::RawEventV0`] by
/// `raw_event_id` without embedding it. When `raw_event_id` is `Some`, the
/// frame acknowledges that a raw event was persisted and can be retrieved by
/// that [`EventId`].
///
/// `stream_seq` is kernel-assigned and total within a live request stream; it
/// is the ordering authority for frames in a stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct KernelFrameV0 {
	/// Always `"kernel.frame.v0"`.
	pub schema_version:        String,
	/// Unique identifier for this frame. Stable prefix: `frame_`. Not a raw
	/// event ID.
	pub frame_id:              FrameId,
	/// Kernel-assigned monotonically increasing sequence number within the live
	/// request stream.
	///
	/// Total ordering authority for frames in a stream. Do not use for
	/// cross-request ordering.
	pub stream_seq:            u64,
	/// Session this frame belongs to.
	pub session_id:            SessionId,
	/// Turn this frame belongs to.
	pub turn_id:               TurnId,
	/// Request that produced this frame.
	pub request_id:            RequestId,
	/// ISO 8601 occurrence timestamp. Stored as a string; no chrono dependency.
	pub ts:                    String,
	/// Kind discriminator for this frame.
	pub kind:                  KernelFrameKindV0,
	/// The persisted [`crate::raw_event::RawEventV0`] that this frame
	/// acknowledges, if any.
	///
	/// `None` for frames that do not correspond to a persisted raw event (e.g.,
	/// provider deltas, progress ticks). When set, the raw event is the
	/// canonical truth and can be retrieved by this [`EventId`].
	#[serde(skip_serializing_if = "Option::is_none")]
	pub raw_event_id:          Option<EventId>,
	/// Session-scoped sequence number of the raw event this frame acknowledges,
	/// if any.
	///
	/// Must be present when `raw_event_id` is present; must be absent when
	/// `raw_event_id` is absent. DTO-level validation via
	/// [`KernelFrameV0::validate_dto`] detects mismatches.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub raw_event_session_seq: Option<u64>,
	/// The frame that causally preceded this one, if any.
	///
	/// `None` for frames with no causal predecessor in the stream.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub causation_frame_id:    Option<FrameId>,
	/// Durable entity identifiers associated with this frame.
	///
	/// Defaults to empty/absent when not populated. `context_item_ids` is always
	/// an array (never null); all other sub-fields are omitted when absent.
	#[serde(default)]
	pub entity_ids:            EntityIdsV0,
	/// Frame-kind-specific payload. Schema is determined by `kind`.
	///
	/// For extensibility, unrecognized payload keys must be tolerated by
	/// consumers.
	pub payload:               KernelFramePayloadV0,
}

impl KernelFrameV0 {
	/// Construct a live [`KernelFrameV0`] with the canonical schema version.
	///
	/// Sets `schema_version` to [`KERNEL_FRAME_SCHEMA_VERSION`].
	/// `raw_event_id`, `raw_event_session_seq`, and `causation_frame_id` default
	/// to `None`; `entity_ids` defaults to empty. Use builder methods to
	/// populate optional fields.
	#[expect(
		clippy::too_many_arguments,
		reason = "constructor mirrors the flat kernel-frame envelope; a parameter object would only \
		          relocate the field list"
	)]
	pub fn new(
		frame_id: FrameId,
		stream_seq: u64,
		session_id: SessionId,
		turn_id: TurnId,
		request_id: RequestId,
		kind: KernelFrameKindV0,
		ts: impl Into<String>,
		payload: KernelFramePayloadV0,
	) -> Self {
		Self {
			schema_version: KERNEL_FRAME_SCHEMA_VERSION.to_owned(),
			frame_id,
			stream_seq,
			session_id,
			turn_id,
			request_id,
			ts: ts.into(),
			kind,
			raw_event_id: None,
			raw_event_session_seq: None,
			causation_frame_id: None,
			entity_ids: EntityIdsV0::default(),
			payload,
		}
	}

	/// Attach the raw event ID that this frame acknowledges (without session
	/// seq).
	///
	/// The contract requires `raw_event_id` and `raw_event_session_seq` to
	/// co-occur. Prefer [`Self::with_raw_event`] when both values are
	/// available. Calling this without a matching `raw_event_session_seq`
	/// produces a detectable DTO violation.
	pub fn with_raw_event_id(mut self, raw_event_id: EventId) -> Self {
		self.raw_event_id = Some(raw_event_id);
		self
	}

	/// Attach both the raw event ID and session sequence number for a
	/// persisted-fact frame.
	///
	/// The contract requires `raw_event_id` and `raw_event_session_seq` to be
	/// present together when a frame reports a persisted raw event. Use this
	/// builder to set both atomically.
	pub fn with_raw_event(mut self, raw_event_id: EventId, raw_event_session_seq: u64) -> Self {
		self.raw_event_id = Some(raw_event_id);
		self.raw_event_session_seq = Some(raw_event_session_seq);
		self
	}

	/// Attach a causal predecessor frame identifier.
	pub fn with_causation_frame_id(mut self, causation_frame_id: FrameId) -> Self {
		self.causation_frame_id = Some(causation_frame_id);
		self
	}

	/// Validate DTO-level invariants for this frame.
	///
	/// Returns a list of violation strings. An empty vec means the frame is
	/// structurally valid at the DTO level. Full stream-level validation
	/// (ordering, sequence gaps, etc.) is performed by the A5 validation lane.
	pub fn validate_dto(&self) -> Vec<String> {
		let mut violations = Vec::new();
		match (&self.raw_event_id, &self.raw_event_session_seq) {
			(Some(_), None) => violations
				.push("raw_event_id is present but raw_event_session_seq is absent".to_owned()),
			(None, Some(_)) => violations
				.push("raw_event_session_seq is present but raw_event_id is absent".to_owned()),
			_ => {},
		}
		violations
	}
}

/// Stable kind discriminator for a [`KernelFrameV0`].
///
/// Serialized as exact underscore-separated strings. Do not rename variants;
/// these are stable wire API consumed by SSE clients.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum KernelFrameKindV0 {
	/// A new turn started in the session.
	#[serde(rename = "turn_started")]
	TurnStarted,
	/// A raw event append operation started.
	#[serde(rename = "raw_event_append_started")]
	RawEventAppendStarted,
	/// A raw event was appended to the session log.
	///
	/// The corresponding `raw_event_id` field in the frame carries the
	/// [`EventId`] of the newly persisted event.
	#[serde(rename = "raw_event_appended")]
	RawEventAppended,
	/// Platform context assembly started.
	#[serde(rename = "platform_assemble_started")]
	PlatformAssembleStarted,
	/// Platform context assembly completed.
	#[serde(rename = "platform_assemble_completed")]
	PlatformAssembleCompleted,
	/// A provider request was built and is ready to dispatch.
	#[serde(rename = "provider_request_built")]
	ProviderRequestBuilt,
	/// A delta of provider content is available (text or structured).
	///
	/// `payload` carries the delta for incremental streaming.
	#[serde(rename = "provider_delta")]
	ProviderDelta,
	/// A tool call was requested by the kernel.
	#[serde(rename = "tool_call_requested")]
	ToolCallRequested,
	/// A tool call execution started.
	#[serde(rename = "tool_call_started")]
	ToolCallStarted,
	/// A tool call completed successfully.
	#[serde(rename = "tool_call_completed")]
	ToolCallCompleted,
	/// A tool call was rejected before execution (e.g., policy check failed).
	#[serde(rename = "tool_call_rejected")]
	ToolCallRejected,
	/// The turn completed successfully.
	///
	/// Consumers should close their SSE connection after receiving this frame.
	#[serde(rename = "turn_completed")]
	TurnCompleted,
	/// The turn failed with an error.
	///
	/// `payload` carries error detail; the stream terminates after this frame.
	#[serde(rename = "turn_failed")]
	TurnFailed,
}

impl KernelFrameKindV0 {
	/// Return the stable string representation of this frame kind.
	///
	/// Matches the serde serialization produced by `#[serde(rename = "...")]`.
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::TurnStarted => "turn_started",
			Self::RawEventAppendStarted => "raw_event_append_started",
			Self::RawEventAppended => "raw_event_appended",
			Self::PlatformAssembleStarted => "platform_assemble_started",
			Self::PlatformAssembleCompleted => "platform_assemble_completed",
			Self::ProviderRequestBuilt => "provider_request_built",
			Self::ProviderDelta => "provider_delta",
			Self::ToolCallRequested => "tool_call_requested",
			Self::ToolCallStarted => "tool_call_started",
			Self::ToolCallCompleted => "tool_call_completed",
			Self::ToolCallRejected => "tool_call_rejected",
			Self::TurnCompleted => "turn_completed",
			Self::TurnFailed => "turn_failed",
		}
	}
}

impl std::fmt::Display for KernelFrameKindV0 {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

/// Validation report for a kernel frame stream.
///
/// Produced by `validate_kernel_frame_stream` (owned by A5 validation lane).
/// This DTO is defined here so downstream crates can depend on the type without
/// importing the full validation crate.
///
/// An empty `violations` list and `valid = true` indicates the stream passed
/// all checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct KernelFrameValidationReportV0 {
	/// `true` when the frame stream passed all validation checks.
	pub valid:       bool,
	/// Total number of frames in the validated stream.
	pub frame_count: u64,
	/// Human-readable violation messages. Empty when `valid = true`.
	#[serde(default)]
	pub violations:  Vec<String>,
}

impl KernelFrameValidationReportV0 {
	/// Construct a passing validation report.
	pub const fn pass(frame_count: u64) -> Self {
		Self { valid: true, frame_count, violations: Vec::new() }
	}

	/// Construct a failing validation report.
	pub const fn fail(frame_count: u64, violations: Vec<String>) -> Self {
		Self { valid: false, frame_count, violations }
	}
}
