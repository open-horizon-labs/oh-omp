//! Platform error mapping onto the protocol `ErrorEnvelopeV0` shape.
//!
//! Every Context Platform HTTP error is surfaced as an `ErrorEnvelopeV0`
//! body with the HTTP status mapping from `SLICE-0-CONTRACT.md` §4.2.
//! Callers construct a [`PlatformError`] with a [`ProtocolViolationCode`]
//! and a diagnostic message; [`PlatformError::into_response`] builds the
//! envelope and assigns fresh `err_`/`req_` identifiers.
//!
//! Diagnostic messages must never contain raw bearer tokens, `MEMEX_LICENSE`
//! values, or other credential material. See `auth.rs` for the redaction
//! contract enforced at the auth boundary.

use axum::{
	Json,
	http::StatusCode,
	response::{IntoResponse, Response},
};
use successor_protocol::{
	error::{ErrorEnvelopeV0, ProtocolViolationCode},
	ids::{ErrorId, RequestId},
};

/// A platform-local error that maps directly onto `ErrorEnvelopeV0`.
///
/// `message` is a diagnostic string surfaced to the caller; it must never
/// contain raw bearer tokens, `MEMEX_LICENSE` values, or other credential
/// material.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct PlatformError {
	code:    ProtocolViolationCode,
	message: String,
}

impl PlatformError {
	pub fn new(code: ProtocolViolationCode, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}

	/// HTTP 401: missing or invalid platform entitlement auth.
	pub fn auth_required(message: impl Into<String>) -> Self {
		Self::new(ProtocolViolationCode::AuthRequired, message)
	}

	/// HTTP 404: no route/resource at this path.
	pub fn not_found(message: impl Into<String>) -> Self {
		Self::new(ProtocolViolationCode::NotFound, message)
	}

	/// Maps this error's code to the minimum HTTP status from
	/// `SLICE-0-CONTRACT.md` §4.2. Codes without an explicit contract row map
	/// to the closest semantic bucket (422 for structural/semantic protocol
	/// violations not covered by plain 400 validation).
	const fn http_status(&self) -> StatusCode {
		match self.code {
			ProtocolViolationCode::ValidationFailed => StatusCode::BAD_REQUEST,
			ProtocolViolationCode::AuthRequired => StatusCode::UNAUTHORIZED,
			ProtocolViolationCode::Forbidden => StatusCode::FORBIDDEN,
			ProtocolViolationCode::NotFound => StatusCode::NOT_FOUND,
			ProtocolViolationCode::Conflict | ProtocolViolationCode::DuplicateIdempotencyKey => {
				StatusCode::CONFLICT
			},
			ProtocolViolationCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
			ProtocolViolationCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
			ProtocolViolationCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
			ProtocolViolationCode::InvalidIdPrefix
			| ProtocolViolationCode::MalformedHash
			| ProtocolViolationCode::CredentialLeakage
			| ProtocolViolationCode::UnknownEventType
			| ProtocolViolationCode::CausationViolation
			| ProtocolViolationCode::FutureReference
			| ProtocolViolationCode::MissingProviderApiShape
			| ProtocolViolationCode::UnsupportedProviderApiShape
			| ProtocolViolationCode::ReplayMismatch => StatusCode::UNPROCESSABLE_ENTITY,
		}
	}

	/// Builds the `ErrorEnvelopeV0` payload for this error, assigning fresh
	/// `err_`/`req_` identifiers.
	pub fn envelope(&self) -> ErrorEnvelopeV0 {
		let error_id = ErrorId::from_raw(format!("err_{}", uuid::Uuid::new_v4()));
		let correlation_id = RequestId::from_raw(format!("req_{}", uuid::Uuid::new_v4()));
		ErrorEnvelopeV0::new(
			error_id,
			correlation_id,
			self.code.as_str(),
			self.message.clone(),
			self.code.is_recoverable(),
			self.code.is_recoverable(),
		)
	}
}

impl IntoResponse for PlatformError {
	fn into_response(self) -> Response {
		let status = self.http_status();
		(status, Json(self.envelope())).into_response()
	}
}

/// Result alias for platform-internal operations that surface as
/// `ErrorEnvelopeV0` HTTP responses.
pub type PlatformResult<T> = Result<T, PlatformError>;

#[cfg(test)]
mod tests {
	use axum::body::to_bytes;
	use successor_protocol::error::ERROR_SCHEMA_VERSION;

	use super::*;

	#[tokio::test]
	async fn auth_required_maps_to_401_error_envelope() {
		let response = PlatformError::auth_required("missing Authorization header").into_response();
		assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

		let body = to_bytes(response.into_body(), usize::MAX)
			.await
			.expect("body");
		let envelope: ErrorEnvelopeV0 =
			serde_json::from_slice(&body).expect("valid ErrorEnvelopeV0 JSON");
		assert_eq!(envelope.schema_version, ERROR_SCHEMA_VERSION);
		assert_eq!(envelope.code, ProtocolViolationCode::AuthRequired.as_str());
		assert!(envelope.error_id.as_str().starts_with("err_"));
		assert!(envelope.correlation_id.as_str().starts_with("req_"));
	}

	#[tokio::test]
	async fn not_found_maps_to_404() {
		let response = PlatformError::not_found("no route implemented yet").into_response();
		assert_eq!(response.status(), StatusCode::NOT_FOUND);
	}
}
