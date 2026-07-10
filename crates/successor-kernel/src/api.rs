//! Owned by Lane C8 `KernelLocalRpc`: local RPC request/response wrappers.
//!
//! Every type here embeds an accepted protocol or kernel DTO by reference
//! (Dissent ruling 3): no duplicate `RawEvent`/`KernelFrame`/platform/provider
//! shape is invented, and no provider-secret inspection surface exists
//! (Dissent ruling 6). JSON deserialization boundaries deny unknown fields
//! (Slice 0 durable law).

use axum::{
	Json,
	http::StatusCode,
	response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use successor_protocol::{
	error::ErrorEnvelopeV0,
	ids::{ErrorId, RequestId, SessionId},
	platform_api::{CreateSessionResponseV0, EventPageV0, SessionSnapshotV0},
	tool_catalog::ToolAuthorityRequestV0,
};

use crate::{platform_error::PlatformClientError, runner::TurnInput, state_machine::TurnFailure};

/// Request body for `POST /v0/sessions` — the "create" half of the ruled
/// create/attach-session route.
///
/// [`successor_protocol::platform_api::CreateSessionRequestV0`] is built at the
/// call site from this plus fixed per-instance workspace identity; this wrapper
/// only carries what the caller actually chooses.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSessionRequest {
	pub title: String,
}

/// Response body for `POST /v0/sessions`: the platform's own DTO, unchanged.
pub type CreateSessionResponse = CreateSessionResponseV0;

/// Response body for `GET /v0/sessions/{session_id}` — the "attach" half:
/// the platform's own snapshot DTO, unchanged.
pub type SessionAttachResponse = SessionSnapshotV0;

/// Request body for `POST /v0/turns`. Converts into the accepted C7
/// [`TurnInput`] while keeping authority negotiation route-local during F3a.
///
/// `session_id` is optional (contract §9/§11 continuation amendment, ruling
/// 270): absent, `POST /v0/turns` starts a fresh runner-owned session,
/// byte-identical to pre-continuation Slice 0 behaviour. Present, it names an
/// existing session to continue -- the runner reuses that session, continues
/// its raw-event `session_seq`, and chains this turn's first event's
/// `causation_event_id` from the session's prior tail. This is never resume
/// or attach (those stay read-only): it drives a genuine new turn lifecycle,
/// appended to the same session stream.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmitTurnRequest {
	pub user_text:      String,
	#[serde(default)]
	pub assembly_query: Option<String>,
	#[serde(default)]
	pub session_id:     Option<SessionId>,
	#[serde(default)]
	pub tool_authority: Option<ToolAuthorityRequestV0>,
}

impl From<SubmitTurnRequest> for TurnInput {
	/// Drops `session_id`: it never enters `TurnInput` (which stays
	/// byte-identical to pre-continuation Slice 0), it is threaded directly
	/// from the route handler into [`crate::runner::TurnRunner::continue_turn`]
	/// instead, to avoid rippling a new mandatory field into every existing
	/// `TurnInput` construction site across the workspace.
	fn from(value: SubmitTurnRequest) -> Self {
		Self { user_text: value.user_text, assembly_query: value.assembly_query }
	}
}

/// Query parameters for `GET /v0/resume/{session_id}`, forwarded verbatim to
/// [`crate::platform_client::KernelPlatformClient::read_session_events`].
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResumeQuery {
	#[serde(default)]
	pub after_seq: Option<u64>,
	#[serde(default)]
	pub limit:     Option<u32>,
}

/// Response body for `GET /v0/resume/{session_id}` (Dissent ruling 5).
///
/// A fresh platform snapshot/event page and a fresh provider-auth resolution on
/// every call; no local session cache/file, no second store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeResponse {
	pub session_id:             SessionId,
	pub snapshot:               SessionSnapshotV0,
	pub events:                 EventPageV0,
	/// Whether the provider credential currently resolves. Never the
	/// credential material itself (Dissent ruling 6: no provider-secret
	/// inspection route exists anywhere in this lane).
	pub provider_auth_resolved: bool,
}

/// A local-RPC error response: an HTTP status paired with an already-built,
/// redaction-safe [`ErrorEnvelopeV0`].
///
/// Callers build the envelope (which needs an [`ErrorId`]/[`RequestId`] from
/// the kernel's id factory) at the error site; this type only carries it to the
/// HTTP layer.
#[derive(Debug, Clone)]
pub struct KernelRpcError {
	status:   StatusCode,
	envelope: ErrorEnvelopeV0,
}

impl KernelRpcError {
	pub const fn new(status: StatusCode, envelope: ErrorEnvelopeV0) -> Self {
		Self { status, envelope }
	}

	pub const fn envelope(&self) -> &ErrorEnvelopeV0 {
		&self.envelope
	}
}

impl IntoResponse for KernelRpcError {
	fn into_response(self) -> Response {
		(self.status, Json(self.envelope)).into_response()
	}
}

pub type KernelRpcResult<T> = Result<T, KernelRpcError>;

/// Builds a redaction-safe [`ErrorEnvelopeV0`] for a local RPC failure.
///
/// `code`/`message` are local RPC-level strings (not a platform
/// `ProtocolViolationCode`); they MUST NOT ever include provider credential or
/// `MEMEX_LICENSE` material (Dissent ruling 6).
pub fn build_envelope(
	error_id: ErrorId,
	correlation_id: &RequestId,
	code: impl Into<String>,
	message: impl Into<String>,
	recoverable: bool,
	retryable: bool,
) -> ErrorEnvelopeV0 {
	ErrorEnvelopeV0::new(error_id, correlation_id.clone(), code, message, recoverable, retryable)
}

/// Maps a malformed-request-body failure onto a redacted local RPC error.
/// The raw body is never echoed back (it may contain arbitrary user text).
pub fn malformed_body_error(
	error_id: ErrorId,
	correlation_id: &RequestId,
	detail: &str,
) -> KernelRpcError {
	KernelRpcError::new(
		StatusCode::BAD_REQUEST,
		build_envelope(
			error_id,
			correlation_id,
			"kernel_rpc.malformed_request",
			format!("request body did not match the expected shape: {detail}"),
			false,
			false,
		),
	)
}

/// Maps an invalid path/query parameter (e.g. a session id that fails
/// [`successor_protocol::ids::SessionId`]'s prefix validation) onto a
/// redacted local RPC error.
pub fn invalid_parameter_error(
	error_id: ErrorId,
	correlation_id: &RequestId,
	detail: &str,
) -> KernelRpcError {
	KernelRpcError::new(
		StatusCode::BAD_REQUEST,
		build_envelope(
			error_id,
			correlation_id,
			"kernel_rpc.invalid_parameter",
			detail.to_owned(),
			false,
			false,
		),
	)
}

/// Maps a platform transport/HTTP failure onto a redacted local RPC error.
///
/// Kept distinct from [`turn_failure_to_rpc_error`] so a rejected/missing
/// `MEMEX_LICENSE` and a missing provider credential never share one error
/// shape (edge case: "distinct, redacted error envelopes").
pub fn platform_error_to_rpc_error(
	error_id: ErrorId,
	correlation_id: &RequestId,
	err: &PlatformClientError,
) -> KernelRpcError {
	let retryable = err.is_retryable();
	let status = match err.http_status() {
		Some(401 | 403) => StatusCode::BAD_GATEWAY,
		Some(status) => StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
		None => StatusCode::SERVICE_UNAVAILABLE,
	};
	let message = match err.envelope() {
		Some(envelope) => format!("platform rejected the request: {}", envelope.code),
		None => "platform request failed".to_owned(),
	};
	KernelRpcError::new(
		status,
		build_envelope(
			error_id,
			correlation_id,
			"kernel_rpc.platform_unavailable",
			message,
			retryable,
			retryable,
		),
	)
}

/// Maps a [`TurnFailure`] onto a redacted local RPC error.
///
/// `ProviderAuthUnavailable` gets its own distinct code (never conflated with a
/// platform failure); every other variant's `Display` text is already
/// redaction-safe by the state machine's own durable law and is
/// forwarded as-is.
pub fn turn_failure_to_rpc_error(
	error_id: ErrorId,
	correlation_id: &RequestId,
	err: &TurnFailure,
) -> KernelRpcError {
	if let TurnFailure::ProviderAuthUnavailable { slot } = err {
		return KernelRpcError::new(
			StatusCode::UNPROCESSABLE_ENTITY,
			build_envelope(
				error_id,
				correlation_id,
				"kernel_rpc.provider_auth_unavailable",
				format!("provider credential unavailable for slot {slot:?}"),
				true,
				false,
			),
		);
	}
	KernelRpcError::new(
		StatusCode::UNPROCESSABLE_ENTITY,
		build_envelope(
			error_id,
			correlation_id,
			"kernel_rpc.turn_failed",
			err.to_string(),
			true,
			false,
		),
	)
}
