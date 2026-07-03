//! Fixture DTO and validator for provider shape normalization.
//!
//! [`ProviderShapeNormalizationFixtureV0`] deserializes the canonical
//! `provider-shape-normalization.json` fixture exactly. The validator proves
//! all three required provider shapes are present exactly once, normalized
//! semantics match expected event types, and no credential-looking keys or
//! high-confidence credential string values appear anywhere in the fixture
//! JSON.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::{
	CanonicalSuccessorIdsV0, NormalizedResponseV0, NormalizedToolCallV0, NormalizedToolResultV0,
	PROVIDER_NORMALIZED_SCHEMA_VERSION, ProviderApiShapeV0, ProviderWireShapeV0,
};

/// Schema version for the provider shape normalization fixture.
///
/// Always `"kernel.provider_shape_normalization_fixture.v0"`.
pub const PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION: &str =
	"kernel.provider_shape_normalization_fixture.v0";

/// Expected `event_type` value for normalized tool call observations.
pub const EXPECTED_TOOL_CALL_EVENT_TYPE: &str = "provider_tool_call.observed";

/// Expected `event_type` value for normalized tool result records.
pub const EXPECTED_TOOL_RESULT_EVENT_TYPE: &str = "tool_result.recorded";

/// Expected `event_type` value for normalized provider response records.
pub const EXPECTED_RESPONSE_EVENT_TYPE: &str = "provider_response.recorded";

/// The three required provider API shape strings, used for presence checks.
pub const REQUIRED_PROVIDER_SHAPES: [&str; 3] =
	["anthropic_messages", "openai_chat_completions", "openai_responses"];

/// Credential-looking key substrings (lowercase) that must not appear as object
/// field names anywhere in the fixture JSON.
///
/// This list targets high-confidence credential key names. It avoids overly
/// broad patterns (e.g., `"token"`) that would match legitimate fields such as
/// `max_context_tokens`.
const CREDENTIAL_KEY_PATTERNS: &[&str] = &[
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"secret",
	"password",
	"memex_license",
	"memex_licence",
	"refresh_token",
	"access_token",
	"auth_token",
	"client_secret",
];

/// High-confidence credential substrings that must not appear as string
/// values anywhere in the fixture JSON.
///
/// More specific than [`CREDENTIAL_KEY_PATTERNS`] to avoid false positives
/// on benign descriptions or tool argument text. Comparison is
/// case-insensitive.
const CREDENTIAL_VALUE_PATTERNS: &[&str] = &[
	"memex_license",
	"memex_licence",
	"authorization: bearer",
	"sk-ant-api",
	"sk-proj-",
	"refresh_token",
	"access_token",
	"client_secret",
];

/// Fixture DTO matching `provider-shape-normalization.json` exactly.
///
/// Deserializes the canonical fixture for validation and round-trip testing.
/// No provider credentials may appear in any field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderShapeNormalizationFixtureV0 {
	/// Must equal [`PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION`].
	pub schema_version:            String,
	/// Must equal [`PROVIDER_NORMALIZED_SCHEMA_VERSION`].
	pub normalized_schema_version: String,
	/// Human-readable description of what this fixture proves.
	pub description:               String,
	/// Canonical successor IDs shared across all wire shape cases.
	pub canonical_successor_ids:   CanonicalSuccessorIdsV0,
	/// Normalized tool call semantics, provider-shape-independent.
	pub normalized_tool_call:      NormalizedToolCallV0,
	/// Normalized tool result semantics, provider-shape-independent.
	pub normalized_tool_result:    NormalizedToolResultV0,
	/// Normalized provider response semantics, provider-shape-independent.
	pub normalized_response:       NormalizedResponseV0,
	/// Wire-shape projections, one entry per supported provider API shape.
	/// The canonical fixture contains exactly three entries.
	pub wire_shapes:               Vec<ProviderWireShapeV0>,
	/// Human-readable statements proving normalization invariants hold.
	pub assertions:                Vec<String>,
}

/// Validation report produced by
/// [`ProviderShapeNormalizationFixtureV0::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderShapeFixtureValidationReport {
	/// `schema_version` matches
	/// [`PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION`].
	pub schema_version_ok: bool,
	/// `normalized_schema_version` matches
	/// [`PROVIDER_NORMALIZED_SCHEMA_VERSION`].
	pub normalized_schema_version_ok: bool,
	/// All three required provider shapes are present in `wire_shapes`.
	pub all_three_shapes_present: bool,
	/// Each required shape appears exactly once in `wire_shapes`.
	pub each_shape_exactly_once: bool,
	/// `normalized_tool_call.event_type` equals
	/// [`EXPECTED_TOOL_CALL_EVENT_TYPE`].
	pub tool_call_event_type_ok: bool,
	/// `normalized_tool_result.event_type` equals
	/// [`EXPECTED_TOOL_RESULT_EVENT_TYPE`].
	pub tool_result_event_type_ok: bool,
	/// `normalized_response.event_type` equals [`EXPECTED_RESPONSE_EVENT_TYPE`].
	pub response_event_type_ok: bool,
	/// No credential-looking field names or high-confidence credential string
	/// values were found anywhere in the fixture JSON.
	pub no_credential_keys: bool,
	/// Collected validation error messages; empty when all checks pass.
	pub errors: Vec<String>,
}

impl ProviderShapeFixtureValidationReport {
	/// Returns `true` when every check passes and no errors were recorded.
	pub const fn is_ok(&self) -> bool {
		self.errors.is_empty()
			&& self.schema_version_ok
			&& self.normalized_schema_version_ok
			&& self.all_three_shapes_present
			&& self.each_shape_exactly_once
			&& self.tool_call_event_type_ok
			&& self.tool_result_event_type_ok
			&& self.response_event_type_ok
			&& self.no_credential_keys
	}
}

impl ProviderShapeNormalizationFixtureV0 {
	/// Validate the fixture and return a
	/// [`ProviderShapeFixtureValidationReport`].
	///
	/// The validator is deterministic and fixture-level only. It does not
	/// implement live projection algorithms or touch external resources.
	pub fn validate(&self) -> ProviderShapeFixtureValidationReport {
		let mut errors: Vec<String> = Vec::new();

		// ── Schema version checks ─────────────────────────────────────────────
		let schema_version_ok =
			self.schema_version == PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION;
		if !schema_version_ok {
			errors.push(format!(
				"schema_version: expected `{}`, got `{}`",
				PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION, self.schema_version
			));
		}

		let normalized_schema_version_ok =
			self.normalized_schema_version == PROVIDER_NORMALIZED_SCHEMA_VERSION;
		if !normalized_schema_version_ok {
			errors.push(format!(
				"normalized_schema_version: expected `{}`, got `{}`",
				PROVIDER_NORMALIZED_SCHEMA_VERSION, self.normalized_schema_version
			));
		}

		// ── Normalized event type checks ──────────────────────────────────────
		let tool_call_event_type_ok =
			self.normalized_tool_call.event_type == EXPECTED_TOOL_CALL_EVENT_TYPE;
		if !tool_call_event_type_ok {
			errors.push(format!(
				"normalized_tool_call.event_type: expected `{}`, got `{}`",
				EXPECTED_TOOL_CALL_EVENT_TYPE, self.normalized_tool_call.event_type
			));
		}

		let tool_result_event_type_ok =
			self.normalized_tool_result.event_type == EXPECTED_TOOL_RESULT_EVENT_TYPE;
		if !tool_result_event_type_ok {
			errors.push(format!(
				"normalized_tool_result.event_type: expected `{}`, got `{}`",
				EXPECTED_TOOL_RESULT_EVENT_TYPE, self.normalized_tool_result.event_type
			));
		}

		let response_event_type_ok =
			self.normalized_response.event_type == EXPECTED_RESPONSE_EVENT_TYPE;
		if !response_event_type_ok {
			errors.push(format!(
				"normalized_response.event_type: expected `{}`, got `{}`",
				EXPECTED_RESPONSE_EVENT_TYPE, self.normalized_response.event_type
			));
		}

		// ── Provider shape presence checks ────────────────────────────────────
		let shapes_present: Vec<&str> = self
			.wire_shapes
			.iter()
			.map(|ws| match &ws.provider_api_shape {
				ProviderApiShapeV0::AnthropicMessages => "anthropic_messages",
				ProviderApiShapeV0::OpenAiChatCompletions => "openai_chat_completions",
				ProviderApiShapeV0::OpenAiResponses => "openai_responses",
			})
			.collect();

		let all_three_shapes_present = REQUIRED_PROVIDER_SHAPES
			.iter()
			.all(|&required| shapes_present.contains(&required));
		if !all_three_shapes_present {
			for &required in &REQUIRED_PROVIDER_SHAPES {
				if !shapes_present.contains(&required) {
					errors.push(format!("wire_shapes missing required provider shape: `{required}`"));
				}
			}
		}

		let each_shape_exactly_once = REQUIRED_PROVIDER_SHAPES
			.iter()
			.all(|&required| shapes_present.iter().filter(|&&s| s == required).count() == 1);
		if !each_shape_exactly_once {
			for &required in &REQUIRED_PROVIDER_SHAPES {
				let count = shapes_present.iter().filter(|&&s| s == required).count();
				if count != 1 {
					errors.push(format!(
						"wire_shapes: `{required}` appears {count} time(s), expected exactly 1"
					));
				}
			}
		}

		// ── Credential key scan over full fixture JSON ────────────────────────
		let fixture_value = serde_json::to_value(self)
			.expect("ProviderShapeNormalizationFixtureV0 must serialize to JSON");
		let cred_errors = scan_credential_keys(&fixture_value, "");
		let no_credential_keys = cred_errors.is_empty();
		errors.extend(cred_errors);

		ProviderShapeFixtureValidationReport {
			schema_version_ok,
			normalized_schema_version_ok,
			all_three_shapes_present,
			each_shape_exactly_once,
			tool_call_event_type_ok,
			tool_result_event_type_ok,
			response_event_type_ok,
			no_credential_keys,
			errors,
		}
	}
}

/// Recursively scan a JSON value for credential-looking field names and
/// high-confidence credential string values.
///
/// Object keys are checked against [`CREDENTIAL_KEY_PATTERNS`]. String values
/// are checked against [`CREDENTIAL_VALUE_PATTERNS`] using case-insensitive
/// substring matching. Returns one error string per offending key or value.
fn scan_credential_keys(value: &serde_json::Value, path: &str) -> Vec<String> {
	let mut errors = Vec::new();
	match value {
		serde_json::Value::Object(map) => {
			for (key, child) in map {
				let key_lower = key.to_lowercase();
				let full_path = if path.is_empty() {
					key.clone()
				} else {
					format!("{path}.{key}")
				};
				for &pattern in CREDENTIAL_KEY_PATTERNS {
					if key_lower.contains(pattern) {
						errors
							.push(format!("credential-looking key `{key}` found at path `{full_path}`"));
						// Report once per key, not once per pattern.
						break;
					}
				}
				errors.extend(scan_credential_keys(child, &full_path));
			}
		},
		serde_json::Value::Array(items) => {
			for (i, item) in items.iter().enumerate() {
				let child_path = format!("{path}[{i}]");
				errors.extend(scan_credential_keys(item, &child_path));
			}
		},
		serde_json::Value::String(s) => {
			let s_lower = s.to_lowercase();
			for &pattern in CREDENTIAL_VALUE_PATTERNS {
				if s_lower.contains(pattern) {
					errors.push(format!(
						"credential-looking value containing `{pattern}` found at path `{path}`"
					));
					// Report once per string value.
					break;
				}
			}
		},
		_ => {},
	}
	errors
}
