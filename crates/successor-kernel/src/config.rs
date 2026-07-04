//! Owned by Lane C3 `KernelProviderAuth`.
//!
//! Kernel config seam (Dissent ruling 5): sources `MEMEX_LICENSE` and the
//! platform `/v0` base URL for
//! [`crate::platform_client::KernelPlatformClient::new`]'s constructor
//! injection. This is the one place these two env vars are read;
//! `platform_client.rs`/`platform_http.rs` (C1) and
//! `provider::auth`/`provider::credentials` (this lane) never read the
//! process environment themselves — see `platform_client.rs`'s own docs,
//! which state the client "never reads environment variables" and defers
//! that to this module.
//!
//! ## Auth planes are distinct types (Dissent ruling 5)
//!
//! A missing `MEMEX_LICENSE` is [`PlatformEntitlementConfigError`] (this
//! module) — the kernel cannot reach the context platform at all without
//! it, so this is a hard config error at kernel start.
//!
//! A missing provider credential is
//! [`crate::provider::auth::ProviderAuthOutcome::Unavailable`] — a typed
//! local degradation for C4/C7 to react to per turn, never a kernel-start
//! error.
//!
//! There is no `From`/`Into` conversion between
//! `PlatformEntitlementConfigError` and `ProviderAuthOutcome`, and no
//! conversion between [`crate::platform_http::EntitlementToken`] and
//! [`crate::provider::credentials::AnthropicApiKey`]: a caller cannot
//! accidentally treat one auth plane's failure (or credential) as the
//! other's.

pub use crate::provider::auth::ANTHROPIC_API_KEY_ENV;
use crate::platform_http::EntitlementToken;

/// Env var carrying the platform entitlement token (contract §2.4).
///
/// A British-spelled `MEMEX_LICENCE` alias is mentioned in contract §2.4 as
/// a possible future alias for the same platform entitlement plane ("if
/// ever accepted"). Slice 0 does not implement that alias; recorded as an
/// ambiguity, not resolved here (see completion notes).
pub const MEMEX_LICENSE_ENV: &str = "MEMEX_LICENSE";

/// Env var carrying the platform `/v0` base URL.
///
/// Named consistently with `successor-context-platform`'s own
/// `SUCCESSOR_CONTEXT_PLATFORM_DB` / `SUCCESSOR_CONTEXT_PLATFORM_ADDR`
/// convention (see `crates/successor-context-platform/src/main.rs`).
pub const PLATFORM_URL_ENV: &str = "SUCCESSOR_CONTEXT_PLATFORM_URL";

/// The platform `/v0` base URL used when `SUCCESSOR_CONTEXT_PLATFORM_URL`
/// is unset, matching contract §6's documented default listener
/// (`http://127.0.0.1:7332/v0`).
pub const DEFAULT_PLATFORM_URL: &str = "http://127.0.0.1:7332/v0";

/// Config error for the platform entitlement plane (Dissent ruling 5).
///
/// Distinct by construction from
/// [`crate::provider::auth::ProviderAuthOutcome`]: there is no shared type
/// or conversion between the two auth planes. A missing `MEMEX_LICENSE`
/// fails kernel start; a missing provider credential never does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PlatformEntitlementConfigError {
	/// `MEMEX_LICENSE` was unset or resolved to an empty string. Empty
	/// string is treated the same as unset: an operator clearing the
	/// variable's value should fail kernel start the same way as never
	/// setting it, not authenticate to the platform with an empty bearer
	/// token.
	#[error(
		"MEMEX_LICENSE is not set (or is empty); the kernel cannot authenticate to the context \
		 platform"
	)]
	MissingLicense,
}

/// The platform base URL + entitlement token pair that
/// [`crate::platform_client::KernelPlatformClient::new`] consumes directly
/// as `new(config.base_url, config.token)`.
#[derive(Debug, Clone)]
pub struct PlatformEntitlementConfig {
	pub base_url: String,
	pub token:    EntitlementToken,
}

/// Resolves the platform entitlement config from `lookup` (Dissent ruling
/// 6: stateless — a fresh call re-reads the environment; there is no cache
/// to invalidate on resume).
///
/// `lookup` mirrors [`std::env::var`]'s shape but returns `Option<String>`
/// directly; tests inject a closure/map so they never mutate real process
/// environment variables (`std::env::set_var`/`remove_var` are
/// process-global and unsafe to touch from parallel `cargo test` runs).
/// Production callers pass [`process_env_lookup`] (or `std::env::var(_).ok()`
/// directly) — the same `lookup` value can be reused for
/// [`crate::provider::auth::resolve_provider_auth`], since both take the
/// identical closure shape.
///
/// `MEMEX_LICENSE` is required
/// ([`PlatformEntitlementConfigError::MissingLicense`] if unset/empty);
/// `SUCCESSOR_CONTEXT_PLATFORM_URL` is optional and falls back to
/// [`DEFAULT_PLATFORM_URL`].
pub fn resolve_platform_entitlement_config(
	lookup: impl Fn(&str) -> Option<String>,
) -> Result<PlatformEntitlementConfig, PlatformEntitlementConfigError> {
	let license = lookup(MEMEX_LICENSE_ENV)
		.filter(|value| !value.is_empty())
		.ok_or(PlatformEntitlementConfigError::MissingLicense)?;
	let base_url = lookup(PLATFORM_URL_ENV)
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| DEFAULT_PLATFORM_URL.to_owned());
	Ok(PlatformEntitlementConfig { base_url, token: EntitlementToken::from(license) })
}

/// Thin production wrapper over [`std::env::var`] for the real process
/// environment.
///
/// For callers that want the real process environment (e.g. kernel
/// start-up wiring). Never used by this crate's own tests: tests always
/// inject a closure/map instead, so parallel `cargo test` runs never race
/// on shared process env.
pub fn process_env_lookup(name: &str) -> Option<String> {
	std::env::var(name).ok()
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use super::*;
	use crate::provider::auth::{ProviderSlot, resolve_provider_auth};

	fn map_lookup<'a>(entries: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
		let map: HashMap<&str, &str> = entries.iter().copied().collect();
		move |name| map.get(name).map(|value| (*value).to_owned())
	}

	#[test]
	fn resolves_license_and_default_url_when_url_env_unset() {
		let lookup = map_lookup(&[(MEMEX_LICENSE_ENV, "dev-license-abc123")]);
		let config = resolve_platform_entitlement_config(lookup).expect("license was set");
		assert_eq!(config.base_url, DEFAULT_PLATFORM_URL);
	}

	#[test]
	fn resolves_overridden_platform_url_when_set() {
		let lookup = map_lookup(&[
			(MEMEX_LICENSE_ENV, "dev-license-abc123"),
			(PLATFORM_URL_ENV, "http://example.test/v0"),
		]);
		let config = resolve_platform_entitlement_config(lookup).expect("license was set");
		assert_eq!(config.base_url, "http://example.test/v0");
	}

	#[test]
	fn missing_license_is_a_typed_config_error_not_a_panic() {
		let lookup = map_lookup(&[]);
		let err = resolve_platform_entitlement_config(lookup).expect_err("license was unset");
		assert_eq!(err, PlatformEntitlementConfigError::MissingLicense);
	}

	#[test]
	fn empty_string_license_is_treated_as_missing() {
		let lookup = map_lookup(&[(MEMEX_LICENSE_ENV, "")]);
		let err = resolve_platform_entitlement_config(lookup)
			.expect_err("empty license must not authenticate");
		assert_eq!(err, PlatformEntitlementConfigError::MissingLicense);
	}

	#[test]
	fn platform_config_error_is_distinct_from_provider_auth_outcome() {
		// Type-level plane separation (Dissent ruling 5): a missing
		// MEMEX_LICENSE and a missing provider key are unrelated error
		// types. There is no function anywhere in this crate that turns a
		// `PlatformEntitlementConfigError` into a `ProviderAuthOutcome` or
		// vice versa; this test demonstrates both are independently
		// producible from the same kind of "nothing set" environment
		// without collapsing into one type.
		let platform_err = resolve_platform_entitlement_config(map_lookup(&[]))
			.expect_err("license unset in this test");
		let provider_outcome = resolve_provider_auth(ProviderSlot::Anthropic, map_lookup(&[]));

		assert_eq!(platform_err, PlatformEntitlementConfigError::MissingLicense);
		assert!(!provider_outcome.is_resolved());
	}
}
