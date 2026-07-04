//! Owned by Lane C3 `KernelProviderAuth`.
//!
//! Integration coverage for the kernel config seam
//! (`successor_kernel::config`) and the local provider-auth resolver
//! (`successor_kernel::provider::auth`), exercised together the way a kernel
//! wiring caller would use them: one injected `lookup` closure feeding both
//! `resolve_platform_entitlement_config` and `resolve_provider_auth`.
//!
//! Every test in this file injects an in-memory lookup (closure over a
//! `HashMap`) and never calls `std::env::set_var`/`remove_var`. Real process
//! environment variables are process-global mutable state; mutating them
//! from a test would race with every other test in the same `cargo test`
//! binary run in parallel. `successor_kernel::config::process_env_lookup`
//! exists for production callers only and is deliberately never exercised
//! here.

use std::collections::HashMap;

use successor_kernel::{
	config::{
		ANTHROPIC_API_KEY_ENV, DEFAULT_PLATFORM_URL, MEMEX_LICENSE_ENV, PLATFORM_URL_ENV,
		PlatformEntitlementConfigError, resolve_platform_entitlement_config,
	},
	platform_client::{EntitlementToken, KernelPlatformClient},
	provider::auth::{ProviderAuthOutcome, ProviderSlot, resolve_provider_auth},
};

/// Builds an injectable lookup over an in-memory map. Never touches real
/// process env — this is the one seam every test in this file uses instead
/// of `std::env::var`.
fn env_map<'a>(entries: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
	let map: HashMap<&str, &str> = entries.iter().copied().collect();
	move |name| map.get(name).map(|value| (*value).to_owned())
}

#[test]
fn provider_credential_resolves_from_injected_env() {
	let outcome = resolve_provider_auth(
		ProviderSlot::Anthropic,
		env_map(&[(ANTHROPIC_API_KEY_ENV, "sk-ant-integration-test")]),
	);
	assert!(outcome.is_resolved());
	assert!(outcome.credential().is_some());
}

#[test]
fn provider_credential_is_typed_absence_when_env_var_is_unset() {
	let outcome = resolve_provider_auth(ProviderSlot::Anthropic, env_map(&[]));
	match outcome {
		ProviderAuthOutcome::Unavailable { slot: ProviderSlot::Anthropic } => {},
		ProviderAuthOutcome::Resolved(_) => {
			panic!("expected Unavailable when ANTHROPIC_API_KEY is unset")
		},
	}
}

#[test]
fn empty_string_provider_credential_is_treated_as_absent() {
	// Documented behavior (provider/auth.rs): an operator clearing
	// ANTHROPIC_API_KEY to "" must degrade identically to unsetting it.
	let outcome =
		resolve_provider_auth(ProviderSlot::Anthropic, env_map(&[(ANTHROPIC_API_KEY_ENV, "")]));
	assert!(!outcome.is_resolved());
}

#[test]
fn provider_credential_debug_and_display_never_contain_the_key_material() {
	const SENTINEL: &str = "sk-ant-integration-sentinel-7d2f9a";
	let outcome =
		resolve_provider_auth(ProviderSlot::Anthropic, env_map(&[(ANTHROPIC_API_KEY_ENV, SENTINEL)]));
	let ProviderAuthOutcome::Resolved(credential) = &outcome else {
		panic!("expected Resolved");
	};

	let outcome_debug = format!("{outcome:?}");
	assert!(!outcome_debug.contains(SENTINEL), "ProviderAuthOutcome::Debug leaked the sentinel key");

	let credential_debug = format!("{credential:?}");
	assert!(!credential_debug.contains(SENTINEL), "AnthropicApiKey::Debug leaked the sentinel key");
	assert!(credential_debug.contains("redacted"));
}

#[test]
fn missing_provider_key_never_produces_a_kernel_start_error() {
	// Dissent ruling 3: a missing provider credential is a typed local
	// degradation for C4/C7 to consume, never a hard error at kernel start.
	// `ProviderAuthOutcome` has no `Result`/error variant to begin with —
	// this test demonstrates the outcome is always constructible and
	// inspectable, never a panic or an `Err`.
	let outcome = resolve_provider_auth(ProviderSlot::Anthropic, env_map(&[]));
	assert!(!outcome.is_resolved());
	assert!(outcome.credential().is_none());
}

#[test]
fn resume_re_resolution_picks_up_a_changed_env_value_with_no_hidden_caching() {
	// Simulates resume: the first "process" has no key, a later resume
	// re-resolves against an environment where the key is now present. Each
	// call is independent — there is no cache/static to invalidate.
	let before_resume = resolve_provider_auth(ProviderSlot::Anthropic, env_map(&[]));
	assert!(!before_resume.is_resolved());

	let after_resume = resolve_provider_auth(
		ProviderSlot::Anthropic,
		env_map(&[(ANTHROPIC_API_KEY_ENV, "sk-ant-set-during-resume")]),
	);
	assert!(after_resume.is_resolved());

	// And the reverse direction: a key that disappears between calls (e.g.
	// revoked) is reflected immediately, not masked by a stale resolution.
	let revoked = resolve_provider_auth(ProviderSlot::Anthropic, env_map(&[]));
	assert!(!revoked.is_resolved());
}

#[test]
fn platform_entitlement_config_resolves_license_and_default_url() {
	let config = resolve_platform_entitlement_config(env_map(&[(
		MEMEX_LICENSE_ENV,
		"dev-license-integration-test",
	)]))
	.expect("license was set");
	assert_eq!(config.base_url, DEFAULT_PLATFORM_URL);
}

#[test]
fn platform_entitlement_config_resolves_overridden_url() {
	let config = resolve_platform_entitlement_config(env_map(&[
		(MEMEX_LICENSE_ENV, "dev-license-integration-test"),
		(PLATFORM_URL_ENV, "http://platform.internal.test/v0"),
	]))
	.expect("license was set");
	assert_eq!(config.base_url, "http://platform.internal.test/v0");
}

#[test]
fn missing_memex_license_is_a_typed_platform_config_error_not_a_kernel_panic() {
	let err =
		resolve_platform_entitlement_config(env_map(&[])).expect_err("MEMEX_LICENSE was unset");
	assert_eq!(err, PlatformEntitlementConfigError::MissingLicense);
}

#[test]
fn empty_string_memex_license_is_treated_as_missing() {
	let err = resolve_platform_entitlement_config(env_map(&[(MEMEX_LICENSE_ENV, "")]))
		.expect_err("empty license must not authenticate to the platform");
	assert_eq!(err, PlatformEntitlementConfigError::MissingLicense);
}

#[test]
fn platform_entitlement_config_feeds_directly_into_kernel_platform_client_constructor() {
	// This is the C1 constructor-injection seam this lane must not modify:
	// `KernelPlatformClient::new(base_url, token)`. Proves config.rs's
	// output plugs in without any adapter/glue code.
	let config = resolve_platform_entitlement_config(env_map(&[(
		MEMEX_LICENSE_ENV,
		"dev-license-wiring-test",
	)]))
	.expect("license was set");
	let _client = KernelPlatformClient::new(config.base_url, config.token);
}

#[test]
fn platform_config_error_and_provider_auth_outcome_are_distinct_planes() {
	// Dissent ruling 5: the two auth planes never collapse. Resolving both
	// from the same "nothing set" environment produces two independent,
	// unrelated typed results — a config `Result::Err` for the platform
	// plane and a non-error `ProviderAuthOutcome::Unavailable` for the
	// provider plane. Neither can be constructed from the other.
	let lookup = env_map(&[]);
	let platform_result = resolve_platform_entitlement_config(&lookup);
	let provider_outcome = resolve_provider_auth(ProviderSlot::Anthropic, &lookup);

	assert!(platform_result.is_err());
	assert_eq!(platform_result.unwrap_err(), PlatformEntitlementConfigError::MissingLicense);
	assert!(!provider_outcome.is_resolved());
}

#[test]
fn provider_credential_cannot_be_substituted_for_an_entitlement_token() {
	// Type-level plane separation (Dissent ruling 5). `EntitlementToken`
	// (crate::platform_http, C1-owned) and `AnthropicApiKey`
	// (crate::provider::credentials, C3-owned) are constructed through
	// entirely separate public entry points below, and
	// `KernelPlatformClient::new` only accepts `impl Into<EntitlementToken>`
	// — there is no overload, `From` impl, or conversion path that lets a
	// resolved provider credential stand in for the platform token. If such
	// a conversion ever existed, this test would still compile; the actual
	// enforcement is structural (no such impl exists in this crate), which
	// is what the surrounding non-conversion API shape demonstrates.
	let provider_outcome = resolve_provider_auth(
		ProviderSlot::Anthropic,
		env_map(&[(ANTHROPIC_API_KEY_ENV, "sk-ant-plane-separation")]),
	);
	assert!(provider_outcome.is_resolved());

	let platform_config = resolve_platform_entitlement_config(env_map(&[(
		MEMEX_LICENSE_ENV,
		"dev-license-plane-test",
	)]))
	.expect("license was set");

	// `KernelPlatformClient::new` takes `impl Into<EntitlementToken>`;
	// `AnthropicApiKey` never implements that trait, so only the platform
	// config's own token type-checks here.
	let _client = KernelPlatformClient::new(platform_config.base_url, platform_config.token);
	let _: EntitlementToken = EntitlementToken::from("dev-license-independently-constructed");
}
