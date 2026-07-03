//! Platform entitlement auth: `Authorization: Bearer <MEMEX_LICENSE>`.
//!
//! This module enforces the `/v0` auth boundary described in
//! `SLICE-0-CONTRACT.md` §2.4/§6 and the dispatch gate in
//! `SLICE-0-DISPATCH-MAP.md` §4.2: every request under `/v0` must present a
//! bearer token matching the platform's configured `MEMEX_LICENSE`
//! entitlement value.
//!
//! Scope, per the B1 pre-execution dissent binding conditions:
//! - Inspection is in-memory-only and syntactic: no credential store, no
//!   persistence, no logging of presented values.
//! - Provider-key-shaped bearer tokens (Anthropic/OpenAI-style API keys,
//!   OAuth-style access tokens) are rejected as platform auth.
//! - Rejections always return a redacted `ErrorEnvelopeV0` (401); the presented
//!   token and the configured `MEMEX_LICENSE` value are never echoed into error
//!   messages, logs, or traces.
//! - The British-spelled `MEMEX_LICENCE` alias is explicitly out of scope (not
//!   implemented, not tested) per orchestrator ruling.

use axum::{
	extract::{Request, State},
	http::HeaderMap,
	middleware::Next,
	response::Response,
};

use crate::error::PlatformError;

const BEARER_PREFIX: &str = "Bearer ";

/// Provider-key/OAuth-access-token prefixes that identify a bearer value as
/// belonging to the provider-auth plane rather than platform entitlement
/// auth. These are specific, high-confidence literal prefixes (not the bare
/// word "token") to avoid false positives against `MEMEX_LICENSE` values.
const PROVIDER_KEY_PREFIXES: &[&str] = &[
	"sk-ant-",     // Anthropic API key
	"sk-proj-",    // OpenAI project API key
	"sk-svcacct-", // OpenAI service account API key
	"ya29.",       // Google OAuth access token
	"gho_",
	"ghp_",
	"ghu_",
	"ghs_",
	"ghr_", // GitHub OAuth/PAT tokens
	"xoxb-",
	"xoxp-",
	"xoxa-", // Slack OAuth tokens
];

/// Minimum length for a bare `sk-` prefix to be treated as an `OpenAI` legacy
/// API key shape (real keys are `sk-` + 48 chars). This avoids false
/// positives against short `MEMEX_LICENSE` dev tokens that happen to start
/// with `sk-`.
const OPENAI_LEGACY_KEY_MIN_LEN: usize = 40;

/// The `MEMEX_LICENSE` entitlement value the platform accepts.
///
/// The raw value is never exposed through `Debug`; only constant-time
/// equality against a presented bearer token is supported.
#[derive(Clone)]
pub struct PlatformLicense {
	value: String,
}

impl PlatformLicense {
	pub fn new(value: impl Into<String>) -> Self {
		Self { value: value.into() }
	}

	/// Reads `MEMEX_LICENSE` from the process environment.
	///
	/// Returns an error if the variable is unset or empty: the platform must
	/// not start with an unconfigured entitlement.
	pub fn from_env() -> Result<Self, std::env::VarError> {
		let value = std::env::var("MEMEX_LICENSE")?;
		if value.is_empty() {
			return Err(std::env::VarError::NotPresent);
		}
		Ok(Self::new(value))
	}

	/// Constant-time equality check against a presented bearer token.
	fn matches(&self, candidate: &str) -> bool {
		let expected = self.value.as_bytes();
		let actual = candidate.as_bytes();
		if expected.len() != actual.len() {
			return false;
		}
		let mut diff = 0u8;
		for (a, b) in expected.iter().zip(actual.iter()) {
			diff |= a ^ b;
		}
		diff == 0
	}
}

impl std::fmt::Debug for PlatformLicense {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("PlatformLicense")
			.field("value", &"<redacted>")
			.finish()
	}
}

/// Returns true if `token` has the shape of a known provider API key or
/// OAuth-style access token rather than a `MEMEX_LICENSE` entitlement value.
fn looks_like_provider_credential(token: &str) -> bool {
	if PROVIDER_KEY_PREFIXES
		.iter()
		.any(|prefix| token.starts_with(prefix))
	{
		return true;
	}
	if token.starts_with("sk-") && token.len() >= OPENAI_LEGACY_KEY_MIN_LEN {
		return true;
	}
	is_jwt_shaped(token)
}

/// JWT-shaped OAuth bearer token: exactly three non-empty base64url segments
/// separated by `.`.
fn is_jwt_shaped(token: &str) -> bool {
	let mut parts = token.split('.');
	let (Some(header), Some(payload), Some(signature), None) =
		(parts.next(), parts.next(), parts.next(), parts.next())
	else {
		return false;
	};
	[header, payload, signature].into_iter().all(|part| {
		!part.is_empty()
			&& part
				.chars()
				.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
	})
}

/// Extracts and syntactically validates the bearer token from the
/// `Authorization` header. Never includes the header value in any error
/// message.
fn parse_bearer_token(headers: &HeaderMap) -> Result<&str, PlatformError> {
	let Some(value) = headers.get(axum::http::header::AUTHORIZATION) else {
		return Err(PlatformError::auth_required("missing Authorization header"));
	};
	let Ok(value) = value.to_str() else {
		return Err(PlatformError::auth_required("Authorization header is not valid UTF-8"));
	};
	let Some(token) = value.strip_prefix(BEARER_PREFIX) else {
		return Err(PlatformError::auth_required("Authorization header must use the Bearer scheme"));
	};
	if token.is_empty() {
		return Err(PlatformError::auth_required("empty bearer token"));
	}
	Ok(token)
}

/// Validates a request's `Authorization` header against the configured
/// platform entitlement. Never returns or logs the presented token.
fn authorize(license: &PlatformLicense, headers: &HeaderMap) -> Result<(), PlatformError> {
	let token = parse_bearer_token(headers)?;
	if looks_like_provider_credential(token) {
		return Err(PlatformError::auth_required("bearer token is not a platform entitlement"));
	}
	if !license.matches(token) {
		return Err(PlatformError::auth_required("invalid platform entitlement"));
	}
	Ok(())
}

/// Axum middleware enforcing platform entitlement auth. Applied at the
/// router level (see `http.rs`) so it covers every route under `/v0`,
/// including the fallback for unmatched paths.
pub async fn require_platform_license(
	State(license): State<PlatformLicense>,
	request: Request,
	next: Next,
) -> Response {
	match authorize(&license, request.headers()) {
		Ok(()) => next.run(request).await,
		Err(err) => {
			use axum::response::IntoResponse;
			err.into_response()
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn headers_with_auth(value: &str) -> HeaderMap {
		let mut headers = HeaderMap::new();
		headers.insert(axum::http::header::AUTHORIZATION, value.parse().unwrap());
		headers
	}

	#[test]
	fn missing_header_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let err = authorize(&license, &HeaderMap::new()).unwrap_err();
		assert_eq!(err.envelope().code, "auth_required");
	}

	#[test]
	fn wrong_scheme_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth("Basic dev-license-abc123");
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn empty_bearer_token_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth("Bearer ");
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn valid_entitlement_is_accepted() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth("Bearer dev-license-abc123");
		assert!(authorize(&license, &headers).is_ok());
	}

	#[test]
	fn mismatched_entitlement_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth("Bearer dev-license-xyz999");
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn anthropic_shaped_key_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers =
			headers_with_auth("Bearer sk-ant-api03-fake0000000000000000000000000000000000000");
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn openai_project_shaped_key_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth("Bearer sk-proj-fake00000000000000000000000000000000");
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn openai_legacy_shaped_key_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth("Bearer sk-0000000000000000000000000000000000000000000");
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn jwt_shaped_oauth_token_is_rejected() {
		let license = PlatformLicense::new("dev-license-abc123");
		let headers = headers_with_auth(
			"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.dGhpc19pc19hX2Zha2Vfc2ln",
		);
		assert!(authorize(&license, &headers).is_err());
	}

	#[test]
	fn short_sk_prefixed_license_is_not_a_false_positive() {
		// A short dev entitlement value that happens to start with "sk-" but
		// is far shorter than any real OpenAI key shape must not be rejected
		// as provider-shaped.
		let license = PlatformLicense::new("sk-dev");
		assert!(!looks_like_provider_credential("sk-dev"));
		let headers = headers_with_auth("Bearer sk-dev");
		assert!(authorize(&license, &headers).is_ok());
	}

	#[test]
	fn bare_word_token_is_not_treated_as_provider_shaped() {
		assert!(!looks_like_provider_credential("token"));
		assert!(!looks_like_provider_credential("my-token-value"));
	}

	#[test]
	fn error_messages_never_contain_presented_token_or_license() {
		let license = PlatformLicense::new("dev-license-abc123");
		let secret_token = "sk-ant-api03-super-secret-value-should-not-leak-anywhere";
		let headers = headers_with_auth(&format!("Bearer {secret_token}"));
		let err = authorize(&license, &headers).unwrap_err();
		let envelope = err.envelope();
		assert!(!envelope.message.contains(secret_token));
		assert!(!envelope.message.contains("dev-license-abc123"));
		assert!(!format!("{err:?}").contains(secret_token));
		assert!(!format!("{err:?}").contains("dev-license-abc123"));
	}

	#[test]
	fn license_debug_redacts_value() {
		let license = PlatformLicense::new("dev-license-abc123");
		let debug = format!("{license:?}");
		assert!(!debug.contains("dev-license-abc123"));
	}
}
