//! Owned by Lane C3 `KernelProviderAuth`.
//!
//! Secret credential custody for provider API keys. `AnthropicApiKey` is the
//! only credential type Slice 0 defines (Dissent ruling 3: Anthropic-only
//! env resolution behind an internal registry seam in
//! `crate::provider::auth`). It is a distinct type from
//! `crate::platform_http::EntitlementToken` (Dissent ruling 5): there is no
//! `From`/`Into`/`As` conversion between the two, by construction, so a
//! provider credential can never be substituted where an `EntitlementToken`
//! is required and vice versa (see the `plane_separation_is_type_level`
//! test in `provider/auth.rs`, which is the module able to construct both
//! sides).
//!
//! Custody rules (Dissent ruling 4):
//! - `Debug`/`Display` are manually implemented and always print a fixed
//!   `<redacted>` marker; neither ever formats the key material.
//! - `Serialize` is never derived or implemented. This is proved below via a
//!   `compile_fail` doc test: `serde_json::to_string` cannot accept an
//!   `AnthropicApiKey` because it has no `Serialize` impl to satisfy that
//!   function's trait bound. Because it can never serialize, it can never leak
//!   into raw events/traces/fixtures/platform DTOs through a serialization
//!   path.
//! - The header-materialization method (`header_value`) is `pub(in
//!   crate::provider)`: visible to the provider boundary (C4's
//!   projection/adapter code under `crate::provider::*`) but not to the rest of
//!   the crate, since nothing outside the provider boundary should ever need
//!   the raw key material. This is the tightest visibility Rust offers short of
//!   module-private (`pub(crate)` would leak it to every module in the kernel,
//!   including ones with no business reading it).
//! - The constructor is likewise `pub(in crate::provider)`: only
//!   `crate::provider::auth` (same lane, same boundary) may mint one, from a
//!   freshly resolved environment value.
//! - `Clone` is allowed (Dissent ruling 4): callers may hold their own copy for
//!   the lifetime of a turn; nothing in this crate persists it to disk.

use std::fmt;

/// A resolved Anthropic API key, held in kernel-local memory only.
///
/// Constructed exclusively by [`crate::provider::auth::resolve_provider_auth`]
/// from an environment lookup. Never constructed from platform/protocol
/// input, and never round-trips through JSON (see the module-level docs and
/// the compile-fail proof below).
///
/// # Compile-fail proof: not `Serialize`
///
/// ```compile_fail
/// use successor_kernel::provider::auth::{ProviderAuthOutcome, ProviderSlot, resolve_provider_auth};
///
/// let outcome = resolve_provider_auth(ProviderSlot::Anthropic, |_| Some("sk-ant-doctest".to_owned()));
/// let ProviderAuthOutcome::Resolved(key) = outcome else { panic!("expected Resolved") };
///
/// // `AnthropicApiKey` implements no `Serialize`, so this fails to compile
/// // with a trait-bound error, not a runtime panic.
/// let _ = serde_json::to_string(&key).unwrap();
/// ```
// Both the tuple field and `header_value` below have no production caller
// yet: C4 `KernelProviderProjection` (which sends the header on the wire)
// has not landed. This is the same "shell stub pending lane" situation
// `lib.rs` already documents crate-wide; both are exercised by this file's
// own tests (see `header_value_round_trips_the_resolved_key`) and by the
// crate-level compile-fail doc test above.
#[allow(
	dead_code,
	reason = "reserved for C4 KernelProviderProjection; exercised by this module's tests"
)]
#[derive(Clone)]
pub struct AnthropicApiKey(String);

impl AnthropicApiKey {
	/// Builds a credential from a resolved environment value.
	///
	/// Callers (`crate::provider::auth`) are responsible for treating an
	/// empty string as absent before calling this constructor; this
	/// constructor does not re-validate emptiness, so the one absence rule
	/// lives in exactly one place (the resolver, not the credential type).
	pub(in crate::provider) fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	/// The literal header value for Anthropic's Messages API
	/// (`x-api-key: <value>`), materialized only at the provider request
	/// boundary. `pub(in crate::provider)`: visible to C4's provider
	/// projection/adapter code under `crate::provider::*`, not to the rest
	/// of the crate — see the module-level custody rules.
	#[allow(
		dead_code,
		reason = "reserved for C4 KernelProviderProjection; exercised by this module's tests"
	)]
	pub(in crate::provider) fn header_value(&self) -> &str {
		&self.0
	}
}

impl fmt::Debug for AnthropicApiKey {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("AnthropicApiKey")
			.field(&"<redacted>")
			.finish()
	}
}

impl fmt::Display for AnthropicApiKey {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("<redacted>")
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const SENTINEL: &str = "sk-ant-sentinel-do-not-leak-9f3c1a2b";

	#[test]
	fn debug_never_contains_key_material() {
		let key = AnthropicApiKey::new(SENTINEL);
		let debug = format!("{key:?}");
		assert!(!debug.contains(SENTINEL));
		assert!(debug.contains("redacted"));
	}

	#[test]
	fn display_never_contains_key_material() {
		let key = AnthropicApiKey::new(SENTINEL);
		let display = format!("{key}");
		assert!(!display.contains(SENTINEL));
		assert!(display.contains("redacted"));
	}

	#[test]
	fn header_value_round_trips_the_resolved_key() {
		// This is the one place in the crate allowed to read the raw
		// material back out — the provider boundary itself.
		let key = AnthropicApiKey::new(SENTINEL);
		assert_eq!(key.header_value(), SENTINEL);
	}

	#[test]
	fn clone_produces_an_independent_equally_redacted_copy() {
		let key = AnthropicApiKey::new(SENTINEL);
		let cloned = key.clone();
		// Both the original and the clone remain independently usable.
		assert_eq!(key.header_value(), SENTINEL);
		assert_eq!(cloned.header_value(), SENTINEL);
		assert!(!format!("{cloned:?}").contains(SENTINEL));
	}
}
