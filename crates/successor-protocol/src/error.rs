//! Protocol error types and stable violation codes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::ids::{ErrorId, RequestId};

/// Schema version for [`ErrorEnvelopeV0`].
///
/// Always `"platform.error.v0"`.
pub const ERROR_SCHEMA_VERSION: &str = "platform.error.v0";

/// Shared error envelope returned by HTTP errors, tool rejections, provider
/// failures, validation failures, and turn failures.
///
/// The `schema_version` field is always `"platform.error.v0"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorEnvelopeV0 {
	/// Always `"platform.error.v0"`.
	pub schema_version: String,
	/// Unique identifier for this error instance.
	pub error_id:       ErrorId,
	/// Stable machine-readable error code.
	pub code:           String,
	/// Human-readable diagnostic message. Not API-stable; do not assert prose in
	/// tests.
	pub message:        String,
	/// Whether the caller may retry without modifying the request.
	pub recoverable:    bool,
	/// Whether the caller may retry this exact request without modification.
	pub retryable:      bool,
	/// Correlation identifier for the originating request.
	pub correlation_id: RequestId,
	/// Structured detail specific to the error case. Empty object when unused.
	pub details:        serde_json::Value,
}

impl ErrorEnvelopeV0 {
	/// Construct a new envelope with the canonical schema version.
	pub fn new(
		error_id: ErrorId,
		correlation_id: RequestId,
		code: impl Into<String>,
		message: impl Into<String>,
		recoverable: bool,
		retryable: bool,
	) -> Self {
		Self {
			schema_version: ERROR_SCHEMA_VERSION.to_owned(),
			error_id,
			code: code.into(),
			message: message.into(),
			recoverable,
			retryable,
			correlation_id,
			details: serde_json::Value::Object(Default::default()),
		}
	}

	/// Attach structured details to this envelope.
	pub fn with_details(mut self, details: serde_json::Value) -> Self {
		self.details = details;
		self
	}
}

/// Stable protocol violation error codes.
///
/// The `snake_case` serialization of each variant is the stable API value.
/// English messages carried in [`ProtocolViolation`] are not API-stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolViolationCode {
	/// An ID value did not carry the required stable prefix, or had an empty
	/// suffix.
	InvalidIdPrefix,
	/// A hash value was malformed (wrong format, wrong length, or non-lowercase
	/// hex).
	MalformedHash,
	/// A credential or auth token was detected in a payload that must not carry
	/// one.
	CredentialLeakage,
	/// An idempotency key was reused with a different payload.
	DuplicateIdempotencyKey,
	/// An event type string is not in the stable event-type registry.
	UnknownEventType,
	/// `causation_event_id` references an event that is not strictly earlier in
	/// the session.
	CausationViolation,
	/// A reference points to an event that has not yet been produced in the
	/// sequence.
	FutureReference,
	/// A `provider_request.built` event is missing the required
	/// `provider_api_shape` field.
	MissingProviderApiShape,
	/// The `provider_api_shape` value is not in the enumerated set.
	UnsupportedProviderApiShape,
	/// Deterministic replay produced output that does not match the accepted
	/// projection.
	ReplayMismatch,
	/// Generic structured validation failed; see detail for specifics.
	ValidationFailed,
	/// The requested resource was not found.
	NotFound,
	/// The request requires authentication.
	AuthRequired,
	/// The authenticated principal is not permitted to perform this operation.
	Forbidden,
	/// The resource state conflicts with the request.
	Conflict,
	/// The caller has been rate-limited; retry after back-off.
	RateLimited,
	/// The service or dependency is temporarily unavailable.
	Unavailable,
	/// An unexpected internal error occurred.
	Internal,
}

impl ProtocolViolationCode {
	/// Return the stable `snake_case` string representation.
	///
	/// Matches the serde serialization produced by `#[serde(rename_all =
	/// "snake_case")]`.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::InvalidIdPrefix => "invalid_id_prefix",
			Self::MalformedHash => "malformed_hash",
			Self::CredentialLeakage => "credential_leakage",
			Self::DuplicateIdempotencyKey => "duplicate_idempotency_key",
			Self::UnknownEventType => "unknown_event_type",
			Self::CausationViolation => "causation_violation",
			Self::FutureReference => "future_reference",
			Self::MissingProviderApiShape => "missing_provider_api_shape",
			Self::UnsupportedProviderApiShape => "unsupported_provider_api_shape",
			Self::ReplayMismatch => "replay_mismatch",
			Self::ValidationFailed => "validation_failed",
			Self::NotFound => "not_found",
			Self::AuthRequired => "auth_required",
			Self::Forbidden => "forbidden",
			Self::Conflict => "conflict",
			Self::RateLimited => "rate_limited",
			Self::Unavailable => "unavailable",
			Self::Internal => "internal",
		}
	}

	/// Whether this violation code typically indicates a retryable condition.
	pub const fn is_recoverable(self) -> bool {
		matches!(self, Self::RateLimited | Self::Unavailable)
	}
}

impl std::fmt::Display for ProtocolViolationCode {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

/// A single protocol rule violation with a stable code and a diagnostic
/// message.
///
/// The `message` field is not API-stable; tests must assert `code`, not prose.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{code}: {message}")]
pub struct ProtocolViolation {
	/// Stable violation code.
	pub code:    ProtocolViolationCode,
	/// Diagnostic message. Not API-stable.
	pub message: String,
}

impl ProtocolViolation {
	/// Construct a new protocol violation.
	pub fn new(code: ProtocolViolationCode, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}
}

/// A collection of protocol violations accumulated during a validation pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolViolationSet {
	violations: Vec<ProtocolViolation>,
}

impl ProtocolViolationSet {
	/// Construct a set from a single initial violation.
	pub fn from_one(v: ProtocolViolation) -> Self {
		Self { violations: vec![v] }
	}

	/// Append a violation to this set.
	pub fn push(&mut self, v: ProtocolViolation) {
		self.violations.push(v);
	}

	/// Return all accumulated violations.
	pub fn violations(&self) -> &[ProtocolViolation] {
		&self.violations
	}

	/// Return `true` if the set contains no violations.
	pub const fn is_empty(&self) -> bool {
		self.violations.is_empty()
	}

	/// Return the number of violations in this set.
	pub const fn len(&self) -> usize {
		self.violations.len()
	}
}

impl std::fmt::Display for ProtocolViolationSet {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		for (i, v) in self.violations.iter().enumerate() {
			if i > 0 {
				write!(f, "; ")?;
			}
			write!(f, "{v}")?;
		}
		Ok(())
	}
}

impl std::error::Error for ProtocolViolationSet {}

/// Convenience result type for protocol validation operations.
pub type ProtocolResult<T> = Result<T, ProtocolViolation>;

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ids::{ErrorId, RequestId};

	#[test]
	fn error_envelope_schema_version() {
		let env = ErrorEnvelopeV0::new(
			ErrorId::try_from("err_test1".to_owned()).unwrap(),
			RequestId::try_from("req_test1".to_owned()).unwrap(),
			"internal",
			"something failed",
			false,
			false,
		);
		assert_eq!(env.schema_version, ERROR_SCHEMA_VERSION);
		assert_eq!(ERROR_SCHEMA_VERSION, "platform.error.v0");
	}

	#[test]
	fn violation_code_serializes_to_snake_case() {
		let json = serde_json::to_string(&ProtocolViolationCode::InvalidIdPrefix).unwrap();
		assert_eq!(json, r#""invalid_id_prefix""#);

		let json =
			serde_json::to_string(&ProtocolViolationCode::UnsupportedProviderApiShape).unwrap();
		assert_eq!(json, r#""unsupported_provider_api_shape""#);
	}

	#[test]
	fn violation_code_as_str_matches_serde() {
		// as_str() must match the serde serialization for stable string API consumers.
		let cases = [
			(ProtocolViolationCode::InvalidIdPrefix, "invalid_id_prefix"),
			(ProtocolViolationCode::MalformedHash, "malformed_hash"),
			(ProtocolViolationCode::CredentialLeakage, "credential_leakage"),
			(ProtocolViolationCode::DuplicateIdempotencyKey, "duplicate_idempotency_key"),
			(ProtocolViolationCode::Internal, "internal"),
		];
		for (code, expected) in cases {
			assert_eq!(code.as_str(), expected, "mismatch for {code:?}");
			let json = serde_json::to_string(&code).unwrap();
			assert_eq!(json, format!("\"{expected}\""));
		}
	}

	#[test]
	fn violation_set_accumulates() {
		let v1 = ProtocolViolation::new(ProtocolViolationCode::InvalidIdPrefix, "bad prefix");
		let v2 = ProtocolViolation::new(ProtocolViolationCode::MalformedHash, "bad hash");
		let mut set = ProtocolViolationSet::from_one(v1);
		assert_eq!(set.len(), 1);
		assert!(!set.is_empty());
		set.push(v2);
		assert_eq!(set.len(), 2);
		assert_eq!(set.violations().len(), 2);
	}

	#[test]
	fn violation_code_recoverability() {
		assert!(ProtocolViolationCode::RateLimited.is_recoverable());
		assert!(ProtocolViolationCode::Unavailable.is_recoverable());
		assert!(!ProtocolViolationCode::InvalidIdPrefix.is_recoverable());
		assert!(!ProtocolViolationCode::Internal.is_recoverable());
	}

	#[test]
	fn error_envelope_with_detail() {
		let env = ErrorEnvelopeV0::new(
			ErrorId::try_from("err_test2".to_owned()).unwrap(),
			RequestId::try_from("req_test2".to_owned()).unwrap(),
			"not_found",
			"resource missing",
			false,
			false,
		)
		.with_details(serde_json::json!({"resource": "ses_abc"}));
		assert_eq!(env.details, serde_json::json!({"resource": "ses_abc"}));
		assert_eq!(env.schema_version, ERROR_SCHEMA_VERSION);
		assert!(!env.recoverable);
	}
}
