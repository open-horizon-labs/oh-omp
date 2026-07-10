//! Owned by Lane C8 `KernelLocalRpc`: local RPC/SSE application wiring.
//!
//! `build_router`/`serve` are the only entry points this lane exposes
//! (Dissent ruling 2, LIB-ONLY): no `[[bin]]`, no daemon lifecycle, no CLI
//! flags. Wave D owns process/CLI composition and calls these directly.

use std::{path::PathBuf, sync::Arc};

use axum::{
	Router,
	routing::{get, post},
};
use successor_protocol::tool_catalog::ToolAuthorityClassV0;

use crate::{
	id_factory::{Clock, IdFactory},
	platform_client::KernelPlatformClient,
	provider::{
		anthropic::AnthropicAdapter,
		auth::{ProviderSlot, resolve_provider_auth},
	},
	routes,
	runner::{AnthropicProviderExecutor, ProviderExecutor, require_provider_credential},
	state_machine::TurnFailure,
};

/// Shared application state for the kernel's local RPC/SSE surface.
///
/// `provider_factory` is called fresh for every `POST /v0/turns` request and
/// by `GET /v0/resume/{session_id}` (never cached): it re-resolves provider
/// auth and builds a brand-new [`ProviderExecutor`] per attempt, matching the
/// accepted C7 runner's own "resolve auth, then build a `TurnRunner` for that
/// attempt" contract (see the doc comment on
/// [`crate::runner::require_provider_credential`]) and Dissent ruling 5's
/// "fresh local state" requirement.
pub struct AppState<P: ProviderExecutor + Send + Sync + 'static> {
	pub(crate) platform: KernelPlatformClient,
	pub(crate) ids: Arc<dyn IdFactory>,
	pub(crate) clock: Arc<dyn Clock>,
	pub(crate) workspace_root: PathBuf,
	pub(crate) provider_slot: ProviderSlot,
	pub(crate) trusted_tool_authority_ceiling: Vec<ToolAuthorityClassV0>,
	pub(crate) provider_factory: Arc<dyn Fn() -> Result<P, TurnFailure> + Send + Sync>,
}

impl<P: ProviderExecutor + Send + Sync + 'static> Clone for AppState<P> {
	fn clone(&self) -> Self {
		Self {
			platform: self.platform.clone(),
			ids: Arc::clone(&self.ids),
			clock: Arc::clone(&self.clock),
			workspace_root: self.workspace_root.clone(),
			provider_slot: self.provider_slot,
			trusted_tool_authority_ceiling: self.trusted_tool_authority_ceiling.clone(),
			provider_factory: Arc::clone(&self.provider_factory),
		}
	}
}

impl<P: ProviderExecutor + Send + Sync + 'static> AppState<P> {
	/// Builds app state around an arbitrary per-attempt provider factory.
	/// Test seams (e.g. a scripted provider, mirroring the C7 contract test
	/// pattern) use this directly; production wiring should prefer
	/// [`AppState::with_anthropic`].
	pub fn new(
		platform: KernelPlatformClient,
		ids: Arc<dyn IdFactory>,
		clock: Arc<dyn Clock>,
		workspace_root: impl Into<PathBuf>,
		provider_slot: ProviderSlot,
		provider_factory: impl Fn() -> Result<P, TurnFailure> + Send + Sync + 'static,
	) -> Self {
		Self {
			platform,
			ids,
			clock,
			workspace_root: workspace_root.into(),
			provider_slot,
			trusted_tool_authority_ceiling: vec![ToolAuthorityClassV0::SafeRead],
			provider_factory: Arc::new(provider_factory),
		}
	}

	pub fn with_trusted_tool_authority_ceiling(
		mut self,
		trusted_tool_authority_ceiling: impl Into<Vec<ToolAuthorityClassV0>>,
	) -> Self {
		self.trusted_tool_authority_ceiling = trusted_tool_authority_ceiling.into();
		self
	}
}

impl AppState<AnthropicProviderExecutor> {
	/// Builds app state wired to the accepted Anthropic provider executor.
	/// `provider_auth_lookup` is normally
	/// [`crate::config::process_env_lookup`]; tests may inject a map lookup
	/// instead.
	/// The same lookup also resolves the optional
	/// [`crate::config::ANTHROPIC_BASE_URL_ENV`] gateway override; when set,
	/// the per-attempt adapter posts to `{base}/v1/messages`.
	#[allow(
		clippy::too_many_arguments,
		reason = "one required field per production wiring input; a config struct would just move \
		          the same fields one level down"
	)]
	pub fn with_anthropic(
		platform: KernelPlatformClient,
		ids: Arc<dyn IdFactory>,
		clock: Arc<dyn Clock>,
		workspace_root: impl Into<PathBuf>,
		model: impl Into<String>,
		max_tokens: u32,
		provider_auth_lookup: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
	) -> Self {
		let model = model.into();
		Self::new(platform, ids, clock, workspace_root, ProviderSlot::Anthropic, move || {
			let outcome =
				resolve_provider_auth(ProviderSlot::Anthropic, |name| provider_auth_lookup(name));
			let credential = require_provider_credential(&outcome)?.clone();
			let messages_url = provider_auth_lookup(crate::config::ANTHROPIC_BASE_URL_ENV)
				.filter(|base| !base.trim().is_empty())
				.map_or_else(
					|| crate::provider::anthropic::DEFAULT_ANTHROPIC_MESSAGES_URL.to_owned(),
					|base| format!("{}/v1/messages", base.trim_end_matches('/')),
				);
			Ok(AnthropicProviderExecutor::new(
				AnthropicAdapter::with_base_url(messages_url, credential),
				model.clone(),
				max_tokens,
			))
		})
	}
}

/// Builds the kernel's local RPC/SSE router (Dissent ruling 8: replaces the
/// C8 shell stub). LIB-ONLY: no `[[bin]]`, no daemon lifecycle (Dissent
/// ruling 2) — Wave D composes this into a process.
pub fn build_router<P: ProviderExecutor + Send + Sync + 'static>(state: AppState<P>) -> Router {
	Router::new()
		.route("/v0/sessions", post(routes::create_session::<P>))
		.route("/v0/sessions/{session_id}", get(routes::attach_session::<P>))
		.route("/v0/turns", post(routes::submit_turn::<P>))
		.route("/v0/resume/{session_id}", get(routes::resume::<P>))
		.with_state(state)
}

/// Serves the kernel's local RPC/SSE router on an already-bound listener.
/// LIB-ONLY (Dissent ruling 2): does not bind the listener itself and does
/// not manage process lifecycle — Wave D owns both.
pub async fn serve<P: ProviderExecutor + Send + Sync + 'static>(
	listener: tokio::net::TcpListener,
	state: AppState<P>,
) -> std::io::Result<()> {
	axum::serve(listener, build_router(state)).await
}
