//! Owned by Lane C1 `KernelPlatformClient`.
//!
//! HTTP transport mechanics for the platform `/v0` client: base URL
//! composition, bearer injection, JSON encode/decode, and status
//! classification onto `PlatformClientError`. Endpoint-specific request and
//! response shapes live in `platform_client.rs`; this module never names an
//! individual `/v0` route.

use std::fmt;

use serde::{Serialize, de::DeserializeOwned};
use successor_protocol::error::ErrorEnvelopeV0;

use crate::platform_error::{PlatformClientError, TransportFailureCategory};

/// Bearer entitlement token used to authenticate against the platform
/// `/v0` surface (the `MEMEX_LICENSE` value — contract §2.4).
///
/// `Debug` is redacted: the token value never appears in logs, panics, or
/// error output (Dissent ruling 4). This type does not read the
/// environment itself; the kernel config seam (owned by lane C3) is
/// responsible for sourcing `MEMEX_LICENSE` and constructing this type.
#[derive(Clone)]
pub struct EntitlementToken(String);

impl EntitlementToken {
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	fn authorization_header(&self) -> String {
		format!("Bearer {}", self.0)
	}
}

impl fmt::Debug for EntitlementToken {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("EntitlementToken")
			.field(&"<redacted>")
			.finish()
	}
}

impl From<String> for EntitlementToken {
	fn from(value: String) -> Self {
		Self::new(value)
	}
}

impl From<&str> for EntitlementToken {
	fn from(value: &str) -> Self {
		Self::new(value)
	}
}

/// Low-level HTTP mechanics for the platform `/v0` surface.
///
/// Owns the `reqwest::Client`, base URL, and bearer token; encodes request
/// bodies, decodes response bodies, and classifies non-2xx responses and
/// transport failures onto `PlatformClientError`. Typed per-endpoint calls
/// live in `platform_client.rs`.
#[derive(Clone)]
pub struct PlatformHttpClient {
	http:     reqwest::Client,
	base_url: String,
	token:    EntitlementToken,
}

impl fmt::Debug for PlatformHttpClient {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("PlatformHttpClient")
			.field("base_url", &self.base_url)
			.field("token", &self.token)
			.finish()
	}
}

impl PlatformHttpClient {
	pub fn new(base_url: impl Into<String>, token: impl Into<EntitlementToken>) -> Self {
		Self {
			http:     reqwest::Client::new(),
			base_url: base_url.into().trim_end_matches('/').to_owned(),
			token:    token.into(),
		}
	}

	fn url(&self, path: &str) -> String {
		format!("{}{path}", self.base_url)
	}

	pub(crate) async fn get<Resp: DeserializeOwned>(
		&self,
		path: &str,
		query: &[(&str, String)],
	) -> Result<Resp, PlatformClientError> {
		let payload = self
			.execute(reqwest::Method::GET, path, query, None)
			.await?;
		decode_response(&payload)
	}

	pub(crate) async fn post<Req: Serialize + Sync, Resp: DeserializeOwned>(
		&self,
		path: &str,
		body: &Req,
	) -> Result<Resp, PlatformClientError> {
		let encoded = serde_json::to_vec(body).expect("protocol DTOs are always JSON-serializable");
		let payload = self
			.execute(reqwest::Method::POST, path, &[], Some(encoded))
			.await?;
		decode_response(&payload)
	}

	async fn execute(
		&self,
		method: reqwest::Method,
		path: &str,
		query: &[(&str, String)],
		json_body: Option<Vec<u8>>,
	) -> Result<Vec<u8>, PlatformClientError> {
		let mut request = self
			.http
			.request(method, self.url(path))
			.header(reqwest::header::AUTHORIZATION, self.token.authorization_header());
		if !query.is_empty() {
			request = request.query(query);
		}
		if let Some(body) = json_body {
			request = request
				.header(reqwest::header::CONTENT_TYPE, "application/json")
				.body(body);
		}

		let response = request.send().await.map_err(classify_transport_error)?;
		let status = response.status();
		let bytes = response.bytes().await.map_err(classify_transport_error)?;
		let payload = bytes.to_vec();

		if status.is_success() {
			Ok(payload)
		} else {
			Err(classify_error_status(status, &payload))
		}
	}
}

fn decode_response<Resp: DeserializeOwned>(payload: &[u8]) -> Result<Resp, PlatformClientError> {
	serde_json::from_slice(payload).map_err(|_| PlatformClientError::MalformedResponse)
}

fn classify_transport_error(err: reqwest::Error) -> PlatformClientError {
	let category = if err.is_timeout() {
		TransportFailureCategory::Timeout
	} else if err.is_connect() {
		TransportFailureCategory::Connect
	} else if err.is_body() || err.is_decode() {
		TransportFailureCategory::Body
	} else {
		TransportFailureCategory::Other
	};
	PlatformClientError::Transport { category }
}

fn classify_error_status(status: reqwest::StatusCode, payload: &[u8]) -> PlatformClientError {
	match serde_json::from_slice::<ErrorEnvelopeV0>(payload) {
		Ok(envelope) => {
			PlatformClientError::Protocol { status: status.as_u16(), envelope: Box::new(envelope) }
		},
		Err(_) => PlatformClientError::UnrecognizedStatus { status: status.as_u16() },
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn entitlement_token_debug_is_redacted() {
		let token = EntitlementToken::new("dev-license-super-secret");
		let debug = format!("{token:?}");
		assert!(!debug.contains("dev-license-super-secret"));
		assert!(debug.contains("redacted"));
	}

	#[test]
	fn platform_http_client_debug_never_contains_the_token() {
		let client = PlatformHttpClient::new("http://127.0.0.1:1", "super-secret-token");
		let debug = format!("{client:?}");
		assert!(!debug.contains("super-secret-token"));
		assert!(debug.contains("127.0.0.1:1"));
	}

	#[test]
	fn base_url_trailing_slash_is_normalized() {
		let client = PlatformHttpClient::new("http://127.0.0.1:1/", "token");
		assert_eq!(client.url("/v0/sessions"), "http://127.0.0.1:1/v0/sessions");
	}
}
