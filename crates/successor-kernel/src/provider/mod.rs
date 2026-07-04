//! Owned by Lane C4 `KernelProviderProjection`, jointly with C3
//! `KernelProviderAuth` (`auth`, `credentials`).
//!
//! This is the provider trust boundary: `auth`/`credentials` (C3) own
//! secret custody for provider API keys; `projection` (C4) owns the pure,
//! offline mapping between kernel turn inputs and A3's normalized provider
//! DTOs (`successor_protocol::provider`); `anthropic` (C4) owns the
//! live-capable Anthropic Messages API adapter that materializes a
//! normalized request into an HTTP request via `credentials`' header
//! materialization. Nothing outside this module tree should construct an
//! `AnthropicApiKey` or read its header value directly — see the custody
//! rules documented on `credentials::AnthropicApiKey`.
pub mod anthropic;
pub mod auth;
pub mod credentials;
pub mod projection;
