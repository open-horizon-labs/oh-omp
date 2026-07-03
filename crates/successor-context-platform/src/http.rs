//! Context Platform HTTP shell: a single authenticated `/v0` surface.
//!
//! `SLICE-0-DISPATCH-MAP.md` §4.2 owns the `/v0` route contract
//! (`POST /sessions`, `POST /events`, `GET /sessions/{id}/events`, etc.);
//! those handlers are added by lanes B2-B6. This lane (B1) lands only the
//! auth-gated skeleton: every request under `/v0` — including unmatched
//! paths — must present a valid `Authorization: Bearer <MEMEX_LICENSE>`
//! header before reaching any handler.

use axum::{Router, middleware};

use crate::{
	auth::{PlatformLicense, require_platform_license},
	error::PlatformError,
};

/// Build the Context Platform HTTP router.
///
/// The `/v0` surface is gated end-to-end by [`require_platform_license`],
/// applied via [`Router::layer`] so it also covers the fallback route (axum
/// route-level middleware such as `route_layer` does not run for
/// fallbacks). Route handlers for the Context Platform API
/// (`SLICE-0-CONTRACT.md` §6) are owned by later platform lanes (B2-B6).
pub fn build_router(license: PlatformLicense) -> Router {
	let v0 = Router::new()
		.fallback(no_route_implemented)
		.layer(middleware::from_fn_with_state(license, require_platform_license));
	Router::new().nest("/v0", v0)
}

/// Placeholder for the not-yet-implemented `/v0` route surface. Reached only
/// after auth succeeds; later lanes replace this with real handlers.
async fn no_route_implemented() -> PlatformError {
	PlatformError::not_found("no Context Platform route implemented for this path yet")
}

#[cfg(test)]
mod tests {
	use axum::{
		body::{Body, to_bytes},
		http::{Request, StatusCode, header},
	};
	use successor_protocol::error::ErrorEnvelopeV0;
	use tower::ServiceExt;

	use super::*;

	fn router() -> Router {
		build_router(PlatformLicense::new("dev-license-abc123"))
	}

	async fn error_envelope(response: axum::response::Response) -> ErrorEnvelopeV0 {
		let body = to_bytes(response.into_body(), usize::MAX)
			.await
			.expect("body");
		serde_json::from_slice(&body).expect("valid ErrorEnvelopeV0 JSON")
	}

	#[tokio::test]
	async fn missing_auth_header_is_rejected_with_401() {
		let request = Request::builder()
			.uri("/v0/sessions")
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
		let envelope = error_envelope(response).await;
		assert_eq!(envelope.code, "auth_required");
	}

	#[tokio::test]
	async fn malformed_scheme_is_rejected_with_401() {
		let request = Request::builder()
			.uri("/v0/sessions")
			.header(header::AUTHORIZATION, "Basic dev-license-abc123")
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
	}

	#[tokio::test]
	async fn empty_bearer_token_is_rejected_with_401() {
		let request = Request::builder()
			.uri("/v0/sessions")
			.header(header::AUTHORIZATION, "Bearer ")
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
	}

	#[tokio::test]
	async fn provider_shaped_token_is_rejected_on_unknown_v0_path() {
		let request = Request::builder()
			.uri("/v0/anything/not/yet/implemented")
			.header(
				header::AUTHORIZATION,
				"Bearer sk-ant-api03-fake0000000000000000000000000000000000000",
			)
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
	}

	#[tokio::test]
	async fn valid_entitlement_reaches_the_fallback_as_404() {
		let request = Request::builder()
			.uri("/v0/sessions")
			.header(header::AUTHORIZATION, "Bearer dev-license-abc123")
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		// Auth succeeded; no real route exists yet (owned by B2-B6), so the
		// gated fallback returns 404, not 401/403.
		assert_eq!(response.status(), StatusCode::NOT_FOUND);
		let envelope = error_envelope(response).await;
		assert_eq!(envelope.code, "not_found");
	}

	#[tokio::test]
	async fn auth_failure_applies_to_unknown_v0_paths() {
		let request = Request::builder()
			.uri("/v0/totally/unknown/path")
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
	}

	#[tokio::test]
	async fn error_body_never_contains_presented_or_expected_license() {
		let secret_token = "sk-ant-api03-super-secret-should-never-leak-anywhere-at-all";
		let request = Request::builder()
			.uri("/v0/sessions")
			.header(header::AUTHORIZATION, format!("Bearer {secret_token}"))
			.body(Body::empty())
			.unwrap();
		let response = router().oneshot(request).await.unwrap();
		let body = to_bytes(response.into_body(), usize::MAX)
			.await
			.expect("body");
		let text = String::from_utf8(body.to_vec()).expect("utf8 body");
		assert!(!text.contains(secret_token));
		assert!(!text.contains("dev-license-abc123"));
	}
}
