//! Owned by Lane C3 `KernelProviderAuth`.
//!
//! Local provider-auth resolver (Dissent ruling 3): an internal registry
//! seam over exactly one provider slot for Slice 0 — Anthropic, resolved
//! from `ANTHROPIC_API_KEY`. This is deliberately not a public
//! provider-generic contract (no `ProviderRegistry` trait, no plugin
//! surface): it is the smallest internal switch that lets a future lane add
//! a second provider slot by extending [`ProviderSlot`] and the `match` in
//! [`resolve_provider_auth`], not by inventing a new abstraction layer.
//!
//! A missing or empty-string credential is [`ProviderAuthOutcome::Unavailable`]
//! — a typed local provider-auth degradation for C4 (provider projection)
//! and C7 (turn runner) to consume, for example by emitting a degraded-turn
//! frame or rejecting a live provider call. It is never a kernel-start hard
//! error and is never conflated with
//! [`crate::config::PlatformEntitlementConfigError`] (the platform
//! entitlement plane, config.rs) — see that module's docs for the
//! plane-separation rationale (Dissent ruling 5).
//!
//! Resolution is stateless (Dissent ruling 6): [`resolve_provider_auth`]
//! takes an injectable `lookup` closure and re-reads it on every call.
//! Nothing here caches a resolved credential to disk or to any
//! process-lifetime static; resume is simply calling this function again.
//! `lookup` is injectable specifically so tests never mutate real process
//! environment variables (`std::env::set_var`/`remove_var` are
//! process-global mutable state and are not safe to touch from tests that
//! `cargo test` may run in parallel within the same process).

use crate::provider::credentials::AnthropicApiKey;

/// The provider slot this resolver knows how to resolve.
///
/// Slice 0 defines exactly one variant (Anthropic-only env resolution,
/// Dissent ruling 3). Adding a provider is adding a variant here plus a
/// `match` arm in [`resolve_provider_auth`] — not adding a generic registry
/// trait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSlot {
	/// Anthropic, resolved from [`ANTHROPIC_API_KEY_ENV`].
	Anthropic,
}

/// The env var Slice 0 resolves the Anthropic credential from.
pub const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";

/// Outcome of a local provider-auth resolution attempt for one
/// [`ProviderSlot`] (Dissent ruling 3).
///
/// This is a degradation signal, not an error type: an unresolved provider
/// credential is an expected, typed local condition (dev machine with no
/// key configured, key temporarily unset, etc.), never a kernel-start
/// failure. Deliberately not `Serialize` (nothing in it should ever reach a
/// platform record, raw event, artifact, trace, or fixture — Dissent ruling
/// 4/contract §2.4) and deliberately distinct from
/// [`crate::config::PlatformEntitlementConfigError`]: there is no
/// `From`/`Into` between the two, so a caller cannot accidentally treat a
/// missing provider key as a platform config failure or vice versa.
#[derive(Debug, Clone)]
pub enum ProviderAuthOutcome {
	/// A non-empty credential was resolved from the environment.
	Resolved(AnthropicApiKey),
	/// `slot`'s env var was unset or resolved to an empty string. Empty
	/// string is deliberately treated the same as unset: an operator who
	/// clears a variable's value (rather than unsetting it) should degrade
	/// the same way, not silently authenticate with an empty key.
	Unavailable { slot: ProviderSlot },
}

impl ProviderAuthOutcome {
	/// `true` when a credential was resolved.
	pub const fn is_resolved(&self) -> bool {
		matches!(self, Self::Resolved(_))
	}

	/// The resolved credential, if any. `None` for
	/// [`ProviderAuthOutcome::Unavailable`] — callers that need to react to
	/// the absence itself (e.g. to read `slot`) should match on the enum
	/// directly instead.
	pub const fn credential(&self) -> Option<&AnthropicApiKey> {
		match self {
			Self::Resolved(key) => Some(key),
			Self::Unavailable { .. } => None,
		}
	}
}

/// Resolves provider auth for `slot` by calling `lookup` fresh.
///
/// Dissent ruling 6: stateless re-resolution — a fresh call always
/// re-reads the environment; resume is just calling this again, nothing is
/// cached.
///
/// `lookup` mirrors [`std::env::var`]'s shape but returns `Option<String>`
/// directly (callers pass `|name| std::env::var(name).ok()` in production,
/// or an injected closure/map in tests). Holding the resolved
/// [`ProviderAuthOutcome`] in memory across a turn or a resume is the
/// caller's concern; this function never retains anything itself.
pub fn resolve_provider_auth(
	slot: ProviderSlot,
	lookup: impl Fn(&str) -> Option<String>,
) -> ProviderAuthOutcome {
	match slot {
		ProviderSlot::Anthropic => match lookup(ANTHROPIC_API_KEY_ENV) {
			Some(value) if !value.is_empty() => {
				ProviderAuthOutcome::Resolved(AnthropicApiKey::new(value))
			},
			_ => ProviderAuthOutcome::Unavailable { slot },
		},
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use super::*;

	/// Builds an injectable lookup closure over an in-memory map, never
	/// touching real process env (Dissent ruling 6 / test isolation).
	fn map_lookup<'a>(entries: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
		let map: HashMap<&str, &str> = entries.iter().copied().collect();
		move |name| map.get(name).map(|value| (*value).to_owned())
	}

	#[test]
	fn resolves_from_injected_env() {
		let lookup = map_lookup(&[(ANTHROPIC_API_KEY_ENV, "sk-ant-injected-value")]);
		let outcome = resolve_provider_auth(ProviderSlot::Anthropic, lookup);
		assert!(outcome.is_resolved());
		assert!(outcome.credential().is_some());
	}

	#[test]
	fn unset_env_var_is_a_typed_unavailable_not_an_error() {
		let lookup = map_lookup(&[]);
		let outcome = resolve_provider_auth(ProviderSlot::Anthropic, lookup);
		match outcome {
			ProviderAuthOutcome::Unavailable { slot: ProviderSlot::Anthropic } => {},
			ProviderAuthOutcome::Resolved(_) => panic!("expected Unavailable for an unset env var"),
		}
	}

	#[test]
	fn empty_string_env_var_is_treated_as_unavailable() {
		// Documented behavior: an operator clearing ANTHROPIC_API_KEY to ""
		// (rather than unsetting it) must degrade identically to unset,
		// never resolve an empty-string credential.
		let lookup = map_lookup(&[(ANTHROPIC_API_KEY_ENV, "")]);
		let outcome = resolve_provider_auth(ProviderSlot::Anthropic, lookup);
		assert!(!outcome.is_resolved());
	}

	#[test]
	fn resume_re_resolution_reflects_a_changed_env_value_with_no_hidden_caching() {
		// First resolve sees no key.
		let first = resolve_provider_auth(ProviderSlot::Anthropic, map_lookup(&[]));
		assert!(!first.is_resolved());

		// A later resolve call (simulating resume) sees a since-set key.
		// This is a fresh call with a fresh lookup, not a cached result —
		// there is no shared state between the two calls.
		let second = resolve_provider_auth(
			ProviderSlot::Anthropic,
			map_lookup(&[(ANTHROPIC_API_KEY_ENV, "sk-ant-set-after-first-resolve")]),
		);
		assert!(second.is_resolved());
	}

	#[test]
	fn plane_separation_is_type_level() {
		// `ProviderAuthOutcome`/`AnthropicApiKey` and
		// `crate::platform_http::EntitlementToken` are unrelated types with
		// no shared trait, no `From`/`Into` conversion, and no field of one
		// type inside the other. This test demonstrates the API shape: the
		// only way to obtain an `AnthropicApiKey` is through
		// `resolve_provider_auth`, and the only way to obtain an
		// `EntitlementToken` is through
		// `crate::config::resolve_platform_entitlement_config` (or its own
		// `new`/`From` impls) — neither path can produce the other type.
		use crate::platform_http::EntitlementToken;

		let outcome = resolve_provider_auth(
			ProviderSlot::Anthropic,
			map_lookup(&[(ANTHROPIC_API_KEY_ENV, "sk-ant-plane-test")]),
		);
		let ProviderAuthOutcome::Resolved(provider_key) = outcome else {
			panic!("expected Resolved");
		};

		// A provider credential and a platform entitlement token are
		// constructed independently and have disjoint APIs: there is no
		// function in this crate that takes one and returns the other.
		let entitlement_token = EntitlementToken::new("dev-license-plane-test");

		// The only assertion available at the type level without a
		// trybuild dependency (forbidden by ruling 1) is that both values
		// exist side by side with no conversion path between them; if a
		// `From<AnthropicApiKey> for EntitlementToken` (or the reverse)
		// were ever added, this test would still compile and pass, so the
		// true enforcement is the absence of such impls in this crate,
		// verified by `cargo doc`/compilation succeeding without them.
		let _ = (provider_key, entitlement_token);
	}
}
