//! Canonical Slice 0 fixture bundle for `successor-protocol`.
//!
//! Every fixture under
//! `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/` is embedded at
//! compile time via `include_str!` and exposed through one typed accessor
//! per fixture, deserializing through the accepted A1-A4 protocol DTOs.
//!
//! Fixture inventory:
//! - `raw-events-successful-turn.json` -> [`raw_events_successful_turn`]: typed
//!   `Vec<RawEventV0>`.
//! - `expected-session-projection.json` -> [`expected_session_projection`]:
//!   typed `SessionProjectionV0`.
//! - `provider-shape-normalization.json` -> [`provider_shape_normalization`]:
//!   typed `ProviderShapeNormalizationFixtureV0`.
//! - `kernel-frame-stream.json` -> [`kernel_frame_stream`]: typed
//!   `Vec<KernelFrameV0>`.
//! - `session-snapshot.json` -> [`session_snapshot`]: typed
//!   `SessionSnapshotV0`.
//! - `assemble-request-pre-tool.json` -> [`assemble_request_pre_tool`]: typed
//!   `AssembleRequestV0`.
//! - `assemble-request-post-read.json` -> [`assemble_request_post_read`]: typed
//!   `AssembleRequestV0`.
//! - `raw-events-unsupported-tool.json` -> [`raw_events_unsupported_tool`]:
//!   typed `Vec<RawEventV0>`, but not replay-eligible (see accessor doc).
//! - `tool-catalog.json` -> [`tool_catalog`]: typed `ToolCatalogV0`.
//! - `assemble-response-pre-tool.json` -> [`assemble_response_pre_tool`]: typed
//!   `AssemblyResponseV0`.
//! - `assemble-response-post-read.json` -> [`assemble_response_post_read`]:
//!   typed `AssemblyResponseV0`.

use crate::{
	kernel_frame::KernelFrameV0,
	platform_api::{AssembleRequestV0, AssemblyResponseV0, SessionSnapshotV0},
	projection::SessionProjectionV0,
	provider_shape_fixture::ProviderShapeNormalizationFixtureV0,
	raw_event::RawEventV0,
	tool_catalog::ToolCatalogV0,
};

const RAW_EVENTS_SUCCESSFUL_TURN_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-successful-turn.\
	 json"
);

const EXPECTED_SESSION_PROJECTION_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/expected-session-projection.\
	 json"
);

const PROVIDER_SHAPE_NORMALIZATION_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/provider-shape-normalization.\
	 json"
);

const KERNEL_FRAME_STREAM_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/kernel-frame-stream.json"
);

const SESSION_SNAPSHOT_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/session-snapshot.json"
);

const ASSEMBLE_REQUEST_PRE_TOOL_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-request-pre-tool.\
	 json"
);

const ASSEMBLE_REQUEST_POST_READ_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-request-post-read.\
	 json"
);

const RAW_EVENTS_UNSUPPORTED_TOOL_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-unsupported-tool.\
	 json"
);

const TOOL_CATALOG_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/tool-catalog.json"
);

/// Canonical backing bytes for the `pre_tool`-phase assembly response
/// (`assemble-response-pre-tool.json`).
const ASSEMBLE_RESPONSE_PRE_TOOL_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-response-pre-tool.\
	 json"
);

/// Canonical backing bytes for the `post_read`-phase assembly response
/// (`assemble-response-post-read.json`).
const ASSEMBLE_RESPONSE_POST_READ_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-response-post-read.\
	 json"
);

/// Canonical successful-turn raw event stream
/// (`raw-events-successful-turn.json`).
///
/// Feeds `replay::project_session` to produce the projection asserted
/// against [`expected_session_projection`].
pub fn raw_events_successful_turn() -> Vec<RawEventV0> {
	serde_json::from_str(RAW_EVENTS_SUCCESSFUL_TURN_JSON)
		.expect("raw-events-successful-turn.json must deserialize as Vec<RawEventV0>")
}

/// Canonical expected projection for the successful-turn replay
/// (`expected-session-projection.json`).
pub fn expected_session_projection() -> SessionProjectionV0 {
	serde_json::from_str(EXPECTED_SESSION_PROJECTION_JSON)
		.expect("expected-session-projection.json must deserialize as SessionProjectionV0")
}

/// Canonical provider wire-shape normalization fixture
/// (`provider-shape-normalization.json`).
pub fn provider_shape_normalization() -> ProviderShapeNormalizationFixtureV0 {
	serde_json::from_str(PROVIDER_SHAPE_NORMALIZATION_JSON).expect(
		"provider-shape-normalization.json must deserialize as ProviderShapeNormalizationFixtureV0",
	)
}

/// Canonical kernel-frame SSE stream for one full turn
/// (`kernel-frame-stream.json`).
pub fn kernel_frame_stream() -> Vec<KernelFrameV0> {
	serde_json::from_str(KERNEL_FRAME_STREAM_JSON)
		.expect("kernel-frame-stream.json must deserialize as Vec<KernelFrameV0>")
}

/// Canonical platform session snapshot (`session-snapshot.json`).
pub fn session_snapshot() -> SessionSnapshotV0 {
	serde_json::from_str(SESSION_SNAPSHOT_JSON)
		.expect("session-snapshot.json must deserialize as SessionSnapshotV0")
}

/// Canonical `pre_tool`-phase assemble request
/// (`assemble-request-pre-tool.json`).
pub fn assemble_request_pre_tool() -> AssembleRequestV0 {
	serde_json::from_str(ASSEMBLE_REQUEST_PRE_TOOL_JSON)
		.expect("assemble-request-pre-tool.json must deserialize as AssembleRequestV0")
}

/// Canonical `post_read`-phase assemble request
/// (`assemble-request-post-read.json`).
pub fn assemble_request_post_read() -> AssembleRequestV0 {
	serde_json::from_str(ASSEMBLE_REQUEST_POST_READ_JSON)
		.expect("assemble-request-post-read.json must deserialize as AssembleRequestV0")
}

/// Canonical unsupported-tool raw event stream
/// (`raw-events-unsupported-tool.json`).
///
/// Covers a catalog-visible, non-executable tool lifecycle:
/// `provider_tool_call.observed` -> `tool_call.requested` ->
/// `tool_call.rejected` -> `error.recorded`.
///
/// Deserializes cleanly as `Vec<RawEventV0>`. Do **not** feed this to
/// `replay::project_session`: `project_session` hard-rejects
/// `error.recorded` events, and rejected/error-lifecycle projection
/// semantics are A5 main-lane scope, not this slice.
pub fn raw_events_unsupported_tool() -> Vec<RawEventV0> {
	serde_json::from_str(RAW_EVENTS_UNSUPPORTED_TOOL_JSON)
		.expect("raw-events-unsupported-tool.json must deserialize as Vec<RawEventV0>")
}

/// Canonical kernel tool catalog (`tool-catalog.json`).
pub fn tool_catalog() -> ToolCatalogV0 {
	serde_json::from_str(TOOL_CATALOG_JSON)
		.expect("tool-catalog.json must deserialize as ToolCatalogV0")
}

/// Canonical `pre_tool`-phase assembly response
/// (`assemble-response-pre-tool.json`).
pub fn assemble_response_pre_tool() -> AssemblyResponseV0 {
	serde_json::from_str(ASSEMBLE_RESPONSE_PRE_TOOL_JSON)
		.expect("assemble-response-pre-tool.json must deserialize as AssemblyResponseV0")
}

/// Canonical `post_read`-phase assembly response
/// (`assemble-response-post-read.json`).
pub fn assemble_response_post_read() -> AssemblyResponseV0 {
	serde_json::from_str(ASSEMBLE_RESPONSE_POST_READ_JSON)
		.expect("assemble-response-post-read.json must deserialize as AssemblyResponseV0")
}
