//! Owned by Lane C4 `KernelProviderProjection`.
//!
//! Live-capable Anthropic Messages API adapter. Materializes a normalized
//! provider request (`crate::provider::projection`) into an HTTP request
//! against Anthropic's Messages API using C3's header materialization
//! (`AnthropicApiKey::header_value`, `pub(in crate::provider)` -- this
//! module is inside that boundary), and parses the wire JSON response back
//! into A3's normalized DTOs. Wire JSON never escapes this module as
//! canonical kernel state: every public method here returns a normalized
//! DTO or a typed, redacted [`AnthropicAdapterError`], never a
//! `serde_json::Value`.
//!
//! No SDK: Dissent ruling 2 prohibits provider SDK dependencies. This
//! adapter is hand-rolled over the kernel's existing `reqwest` substrate
//! (see `crate::platform_http` for the sibling pattern used against the
//! local platform).
//!
//! The `live_smoke_*` test at the bottom of this module is strictly
//! opt-in -- see its doc comment -- and is never required by the default
//! suite or CI (Dissent ruling 3).

use serde_json::Value as WireJson;
use successor_protocol::{
	ids::{MessageId, ToolCallId},
	provider::{
		NormalizedResponseV0, NormalizedToolCallV0, ProviderApiShapeV0, ProviderObservationMetadataV0,
	},
	tool_catalog::ToolCatalogV0,
};

use crate::provider::{
	credentials::AnthropicApiKey,
	projection::{self, ProjectionError},
};

/// Default Anthropic Messages API endpoint.
pub const DEFAULT_ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";

/// The Anthropic API version this adapter speaks. Anthropic requires this
/// header on every Messages API request.
pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";

/// Local transport failure classification.
///
/// Mirrors `crate::platform_error::TransportFailureCategory`'s shape for the
/// provider boundary: coarse enough to log safely, never the underlying
/// `reqwest::Error` (which can echo request internals).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnthropicTransportFailure {
	Timeout,
	Connect,
	Decode,
	Other,
}

impl std::fmt::Display for AnthropicTransportFailure {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let label = match self {
			Self::Timeout => "timed out",
			Self::Connect => "connection failed",
			Self::Decode => "response could not be decoded",
			Self::Other => "transport failure",
		};
		f.write_str(label)
	}
}

fn classify_transport_error(err: &reqwest::Error) -> AnthropicTransportFailure {
	if err.is_timeout() {
		AnthropicTransportFailure::Timeout
	} else if err.is_connect() {
		AnthropicTransportFailure::Connect
	} else if err.is_body() || err.is_decode() {
		AnthropicTransportFailure::Decode
	} else {
		AnthropicTransportFailure::Other
	}
}

/// Typed, redacted Anthropic adapter failure.
///
/// Never carries a `serde_json::Value`, an `AnthropicApiKey`, or a raw
/// only classifications and status codes safe to log (custody rule: no
/// secret material, no wire body echo).
#[derive(Debug, thiserror::Error)]
pub enum AnthropicAdapterError {
	#[error("anthropic messages request transport failure: {0}")]
	Transport(AnthropicTransportFailure),
	#[error("anthropic messages endpoint returned HTTP {status}")]
	HttpStatus { status: u16 },
	#[error("anthropic messages response body was not valid JSON")]
	InvalidJson,
	#[error(transparent)]
	Projection(#[from] ProjectionError),
}

/// The outcome of one Anthropic Messages API call: the normalized response,
/// plus a normalized tool call and its observation metadata when the model
/// emitted a `tool_use` block.
#[derive(Debug, Clone)]
pub struct AnthropicMessageOutcome {
	pub response:  NormalizedResponseV0,
	pub tool_call: Option<(NormalizedToolCallV0, ProviderObservationMetadataV0)>,
}

/// Live-capable Anthropic Messages API adapter.
///
/// Holds a resolved [`AnthropicApiKey`] for the lifetime of the adapter.
/// Deliberately not `Serialize`: this type derives no `Serialize` impl, and
/// `AnthropicApiKey` (its credential field) has none to derive from either,
/// so `serde_json::to_string(&adapter)` fails to compile (proof below).
///
/// # Compile-fail proof: not `Serialize`
///
/// ```compile_fail
/// use successor_kernel::provider::anthropic::AnthropicAdapter;
/// use successor_kernel::provider::auth::{ProviderAuthOutcome, ProviderSlot, resolve_provider_auth};
///
/// let outcome = resolve_provider_auth(ProviderSlot::Anthropic, |_| Some("sk-ant-doctest".to_owned()));
/// let ProviderAuthOutcome::Resolved(key) = outcome else { panic!("expected Resolved") };
/// let adapter = AnthropicAdapter::new(key);
///
/// // `AnthropicAdapter` implements no `Serialize`, so this fails to compile
/// // with a trait-bound error, not a runtime panic.
/// let _ = serde_json::to_string(&adapter).unwrap();
/// ```
#[derive(Clone)]
pub struct AnthropicAdapter {
	http:     reqwest::Client,
	base_url: String,
	api_key:  AnthropicApiKey,
}

impl std::fmt::Debug for AnthropicAdapter {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("AnthropicAdapter")
			// `base_url` is env/caller-sourced and may carry userinfo or
			// token query params (gateway URLs); never print it verbatim.
			.field("base_url", &"<redacted>")
			.field("api_key", &self.api_key)
			.finish_non_exhaustive()
	}
}

impl AnthropicAdapter {
	/// Builds an adapter against the default Anthropic Messages endpoint.
	pub fn new(api_key: AnthropicApiKey) -> Self {
		Self::with_base_url(DEFAULT_ANTHROPIC_MESSAGES_URL, api_key)
	}

	/// Builds an adapter against `base_url` (test/proxy override).
	pub fn with_base_url(base_url: impl Into<String>, api_key: AnthropicApiKey) -> Self {
		Self { http: reqwest::Client::new(), base_url: base_url.into(), api_key }
	}

	/// Materializes a normalized request into the Anthropic Messages API
	/// wire body, via `crate::provider::projection::project_request_body`
	/// for the `anthropic_messages` shape, plus the transport-level `model`
	/// and `max_tokens` fields the projection layer does not own.
	fn request_body(
		user_text: &str,
		catalog: &ToolCatalogV0,
		model: &str,
		max_tokens: u32,
	) -> WireJson {
		let mut body = projection::project_request_body(
			&ProviderApiShapeV0::AnthropicMessages,
			user_text,
			catalog,
		);
		let object = body
			.as_object_mut()
			.expect("project_request_body always returns a JSON object");
		object.insert("model".to_owned(), serde_json::json!(model));
		object.insert("max_tokens".to_owned(), serde_json::json!(max_tokens));
		body
	}

	/// Sends `user_text` to the Anthropic Messages API and normalizes the
	/// response. `tool_call_id` is the successor tool-call ID to attach if
	/// and only if the model emits a `tool_use` block; it is unused
	/// otherwise.
	pub async fn send_message(
		&self,
		user_text: &str,
		catalog: &ToolCatalogV0,
		model: &str,
		max_tokens: u32,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<AnthropicMessageOutcome, AnthropicAdapterError> {
		let body = Self::request_body(user_text, catalog, model, max_tokens);

		let response = self
			.http
			.post(self.base_url.as_str())
			.header("x-api-key", self.api_key.header_value())
			.header("anthropic-version", ANTHROPIC_API_VERSION)
			.header("content-type", "application/json")
			.json(&body)
			.send()
			.await
			.map_err(|err| AnthropicAdapterError::Transport(classify_transport_error(&err)))?;

		let status = response.status();
		let payload = response
			.bytes()
			.await
			.map_err(|err| AnthropicAdapterError::Transport(classify_transport_error(&err)))?;

		if !status.is_success() {
			return Err(AnthropicAdapterError::HttpStatus { status: status.as_u16() });
		}

		let wire: WireJson =
			serde_json::from_slice(&payload).map_err(|_err| AnthropicAdapterError::InvalidJson)?;

		let response =
			projection::normalize_response(&ProviderApiShapeV0::AnthropicMessages, &wire, message_id)?;

		let tool_call = wire
			.get("content")
			.and_then(WireJson::as_array)
			.and_then(|blocks| {
				blocks
					.iter()
					.find(|block| block.get("type").and_then(WireJson::as_str) == Some("tool_use"))
			})
			.map(|block| {
				projection::normalize_tool_call(
					&ProviderApiShapeV0::AnthropicMessages,
					block,
					tool_call_id,
				)
			})
			.transpose()?;

		Ok(AnthropicMessageOutcome { response, tool_call })
	}
}

#[cfg(test)]
mod tests {
	use successor_protocol::fixtures;

	use super::*;
	use crate::provider::auth::{ProviderAuthOutcome, ProviderSlot, resolve_provider_auth};

	fn test_key() -> AnthropicApiKey {
		let outcome = resolve_provider_auth(ProviderSlot::Anthropic, |_| {
			Some("sk-ant-test-sentinel-do-not-leak".to_owned())
		});
		let ProviderAuthOutcome::Resolved(key) = outcome else {
			panic!("expected Resolved for an injected non-empty env value")
		};
		key
	}

	#[test]
	fn adapter_debug_never_contains_the_api_key_material() {
		let adapter = AnthropicAdapter::new(test_key());
		let debug = format!("{adapter:?}");
		assert!(!debug.contains("sk-ant-test-sentinel-do-not-leak"));
	}

	#[test]
	fn adapter_debug_never_contains_the_base_url_material() {
		let adapter = AnthropicAdapter::with_base_url(
			"http://user:sentinel-token@gw.example:8888/path?key=sentinel-q",
			test_key(),
		);
		let debug = format!("{adapter:?}");
		assert!(!debug.contains("sentinel-token"));
		assert!(!debug.contains("sentinel-q"));
		assert!(!debug.contains("gw.example"));
		assert!(!debug.contains("user:"));
		assert!(debug.contains("<redacted>"));
	}

	#[test]
	fn request_body_carries_model_and_max_tokens_alongside_the_projected_shape() {
		let catalog = fixtures::tool_catalog();
		let body = AnthropicAdapter::request_body("hello", &catalog, "claude-x", 256);
		assert_eq!(body["model"], "claude-x");
		assert_eq!(body["max_tokens"], 256);
		assert!(body["messages"].is_array());
	}

	/// Opt-in live smoke test against the real Anthropic Messages API.
	///
	/// Skipped unless both `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` and a non-empty
	/// `ANTHROPIC_API_KEY` are present in the environment. Never runs in the
	/// default `cargo test` suite or in CI (Dissent ruling 3): this
	/// function always returns early -- a pass, not a failure or a skip
	/// marker -- unless an operator explicitly opts in on a machine with
	/// real credentials. It exercises only the normalized DTO interfaces
	/// (`AnthropicAdapter::send_message`), never a bespoke wire path.
	#[tokio::test]
	async fn live_smoke_against_real_anthropic_messages_api() {
		if std::env::var("SUCCESSOR_LIVE_PROVIDER_SMOKE")
			.ok()
			.as_deref()
			!= Some("1")
		{
			eprintln!(
				"skipping live_smoke_against_real_anthropic_messages_api: set \
				 SUCCESSOR_LIVE_PROVIDER_SMOKE=1 and ANTHROPIC_API_KEY to opt in"
			);
			return;
		}
		let Some(raw_key) = std::env::var("ANTHROPIC_API_KEY")
			.ok()
			.filter(|value| !value.is_empty())
		else {
			eprintln!(
				"skipping live_smoke_against_real_anthropic_messages_api: ANTHROPIC_API_KEY unset"
			);
			return;
		};

		let outcome = resolve_provider_auth(ProviderSlot::Anthropic, move |_| Some(raw_key.clone()));
		let ProviderAuthOutcome::Resolved(key) = outcome else {
			panic!("ANTHROPIC_API_KEY was non-empty but resolution reported unavailable");
		};

		let adapter = AnthropicAdapter::new(key);
		let catalog = fixtures::tool_catalog();
		let message_id =
			MessageId::from_raw("msg_live_smoke_00000000-0000-4000-8000-000000000001".to_owned());
		let tool_call_id =
			ToolCallId::from_raw("tool_live_smoke_00000000-0000-4000-8000-000000000001".to_owned());

		let outcome = adapter
			.send_message(
				"Say the single word: ack",
				&catalog,
				"claude-3-5-haiku-20241022",
				16,
				message_id,
				tool_call_id,
			)
			.await
			.expect("live Anthropic Messages API call failed");

		assert!(
			!outcome.response.text.is_empty(),
			"expected a non-empty response text from a live call"
		);
	}
}
