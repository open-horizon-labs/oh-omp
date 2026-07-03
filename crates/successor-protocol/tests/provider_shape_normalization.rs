//! Integration tests for provider shape normalization.
//!
//! Deserializes the canonical `provider-shape-normalization.json` fixture,
//! asserts schema versions, provider shape coverage, normalized semantics,
//! and round-trip serialization. Also proves validation passes for the
//! canonical fixture and fails for injected violations.

use serde_json::json;
use successor_protocol::{
	provider::{
		NormalizedProviderRequestV0, NormalizedResponseV0, NormalizedToolCallV0,
		NormalizedToolResultV0, PROVIDER_NORMALIZED_SCHEMA_VERSION,
		PROVIDER_REQUEST_BUILT_EVENT_TYPE, ProviderApiShapeV0, ProviderObservationMetadataV0,
	},
	provider_shape_fixture::{
		EXPECTED_RESPONSE_EVENT_TYPE, EXPECTED_TOOL_CALL_EVENT_TYPE, EXPECTED_TOOL_RESULT_EVENT_TYPE,
		PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION, ProviderShapeNormalizationFixtureV0,
	},
};

/// Canonical fixture JSON, loaded at compile time.
const FIXTURE_JSON: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/provider-shape-normalization.\
	 json"
);

fn load_fixture() -> ProviderShapeNormalizationFixtureV0 {
	serde_json::from_str(FIXTURE_JSON).expect("canonical fixture must deserialize")
}

// ── Deserialization
// ───────────────────────────────────────────────────────────

#[test]
fn fixture_deserializes_without_error() {
	let _fixture = load_fixture();
}

// ── Schema version assertions
// ─────────────────────────────────────────────────

#[test]
fn schema_versions_match_constants() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.schema_version, PROVIDER_SHAPE_NORMALIZATION_FIXTURE_SCHEMA_VERSION,
		"fixture schema_version must match the module constant"
	);
	assert_eq!(
		fixture.normalized_schema_version, PROVIDER_NORMALIZED_SCHEMA_VERSION,
		"fixture normalized_schema_version must match the provider module constant"
	);
}

// ── Provider shape set assertions
// ─────────────────────────────────────────────

#[test]
fn all_three_provider_shapes_present_exactly_once() {
	let fixture = load_fixture();
	let shapes: Vec<&ProviderApiShapeV0> = fixture
		.wire_shapes
		.iter()
		.map(|ws| &ws.provider_api_shape)
		.collect();

	assert_eq!(shapes.len(), 3, "exactly three wire shapes are required");

	assert!(
		shapes.contains(&&ProviderApiShapeV0::AnthropicMessages),
		"anthropic_messages wire shape must be present"
	);
	assert!(
		shapes.contains(&&ProviderApiShapeV0::OpenAiChatCompletions),
		"openai_chat_completions wire shape must be present"
	);
	assert!(
		shapes.contains(&&ProviderApiShapeV0::OpenAiResponses),
		"openai_responses wire shape must be present"
	);

	let anthropic_count = shapes
		.iter()
		.filter(|s| ***s == ProviderApiShapeV0::AnthropicMessages)
		.count();
	let oai_chat_count = shapes
		.iter()
		.filter(|s| ***s == ProviderApiShapeV0::OpenAiChatCompletions)
		.count();
	let oai_resp_count = shapes
		.iter()
		.filter(|s| ***s == ProviderApiShapeV0::OpenAiResponses)
		.count();

	assert_eq!(anthropic_count, 1, "anthropic_messages must appear exactly once");
	assert_eq!(oai_chat_count, 1, "openai_chat_completions must appear exactly once");
	assert_eq!(oai_resp_count, 1, "openai_responses must appear exactly once");
}

// ── Normalized event type assertions ─────────────────────────────────────────

#[test]
fn normalized_tool_call_event_type_is_provider_tool_call_observed() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_tool_call.event_type, EXPECTED_TOOL_CALL_EVENT_TYPE,
		"normalized_tool_call.event_type must be `provider_tool_call.observed`"
	);
}

#[test]
fn normalized_tool_result_event_type_is_tool_result_recorded() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_tool_result.event_type, EXPECTED_TOOL_RESULT_EVENT_TYPE,
		"normalized_tool_result.event_type must be `tool_result.recorded`"
	);
}

#[test]
fn normalized_response_event_type_is_provider_response_recorded() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_response.event_type, EXPECTED_RESPONSE_EVENT_TYPE,
		"normalized_response.event_type must be `provider_response.recorded`"
	);
}

#[test]
fn normalized_provider_dtos_reject_wrong_event_type_on_deserialization() {
	assert!(
		serde_json::from_value::<NormalizedToolCallV0>(json!({
			 "event_type": "provider_response.recorded",
			 "tool_call_id": "tool_test",
			 "tool_name": "read",
			 "arguments": {}
		}))
		.is_err(),
		"NormalizedToolCallV0 must reject mismatched event_type"
	);

	assert!(
		serde_json::from_value::<NormalizedToolResultV0>(json!({
			 "event_type": "provider_tool_call.observed",
			 "tool_call_id": "tool_test",
			 "tool_name": "read",
			 "status": "ok",
			 "artifact_id": "art_test"
		}))
		.is_err(),
		"NormalizedToolResultV0 must reject mismatched event_type"
	);

	assert!(
		serde_json::from_value::<NormalizedResponseV0>(json!({
			 "event_type": "tool_result.recorded",
			 "message_id": "msg_test",
			 "finish_reason": "stop",
			 "text": "done"
		}))
		.is_err(),
		"NormalizedResponseV0 must reject mismatched event_type"
	);

	assert!(
		serde_json::from_value::<NormalizedProviderRequestV0>(json!({
			 "event_type": "provider_response.recorded",
			 "request_id": "req_test",
			 "turn_id": "turn_test",
			 "provider_api_shape": "anthropic_messages",
			 "content_preview": null,
			 "source_artifact_id": null,
			 "source_ref": null
		}))
		.is_err(),
		"NormalizedProviderRequestV0 must reject mismatched event_type"
	);
}

// ── Canonical successor ID cross-field consistency
// ────────────────────────────

#[test]
fn normalized_tool_call_uses_canonical_tool_call_id() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_tool_call.tool_call_id, fixture.canonical_successor_ids.tool_call_id,
		"normalized_tool_call.tool_call_id must equal canonical_successor_ids.tool_call_id"
	);
}

#[test]
fn normalized_tool_result_uses_canonical_tool_call_id() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_tool_result.tool_call_id, fixture.canonical_successor_ids.tool_call_id,
		"normalized_tool_result.tool_call_id must equal canonical_successor_ids.tool_call_id"
	);
}

#[test]
fn normalized_response_uses_canonical_message_id() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_response.message_id, fixture.canonical_successor_ids.message_id,
		"normalized_response.message_id must equal canonical_successor_ids.message_id"
	);
}

// ── Canonical ID prefix checks
// ────────────────────────────────────────────────

#[test]
fn canonical_successor_ids_carry_correct_prefixes() {
	let fixture = load_fixture();
	let ids = &fixture.canonical_successor_ids;
	assert!(
		ids.request_id.as_str().starts_with("req_"),
		"request_id must carry `req_` prefix, got `{}`",
		ids.request_id.as_str()
	);
	assert!(
		ids.turn_id.as_str().starts_with("turn_"),
		"turn_id must carry `turn_` prefix, got `{}`",
		ids.turn_id.as_str()
	);
	assert!(
		ids.tool_call_id.as_str().starts_with("tool_"),
		"tool_call_id must carry `tool_` prefix, got `{}`",
		ids.tool_call_id.as_str()
	);
	assert!(
		ids.provider_event_id.as_str().starts_with("pevt_"),
		"provider_event_id must carry `pevt_` prefix, got `{}`",
		ids.provider_event_id.as_str()
	);
	assert!(
		ids.message_id.as_str().starts_with("msg_"),
		"message_id must carry `msg_` prefix, got `{}`",
		ids.message_id.as_str()
	);
}

// ── Provider-specific IDs are metadata, not successor identity
// ────────────────

#[test]
fn provider_specific_tool_call_ids_are_metadata_not_successor_identity() {
	let fixture = load_fixture();
	let canonical_tool_call_id = fixture.canonical_successor_ids.tool_call_id.as_str();

	for ws in &fixture.wire_shapes {
		// Provider-specific IDs must differ from the canonical successor ID.
		assert_ne!(
			ws.provider_specific_tool_call_id, canonical_tool_call_id,
			"provider_specific_tool_call_id `{}` for shape `{:?}` must differ from the canonical \
			 successor tool_call_id (provider IDs are metadata, not identity)",
			ws.provider_specific_tool_call_id, ws.provider_api_shape
		);
		// Provider-specific IDs must not carry the `tool_` successor prefix.
		assert!(
			!ws.provider_specific_tool_call_id.starts_with("tool_"),
			"provider_specific_tool_call_id `{}` for shape `{:?}` must not carry the `tool_` \
			 successor prefix",
			ws.provider_specific_tool_call_id,
			ws.provider_api_shape
		);
	}
}

#[test]
fn provider_observation_metadata_rejects_unknown_credential_fields() {
	let value = json!({
		 "provider_api_shape": "anthropic_messages",
		 "provider_tool_call_id": "toolu_test",
		 "authorization": "Bearer not-real",
	});

	let result = serde_json::from_value::<ProviderObservationMetadataV0>(value);
	assert!(result.is_err(), "provider metadata with unknown credential field must be rejected");
}

// ── Round-trip serialization
// ──────────────────────────────────────────────────

#[test]
fn fixture_round_trips_to_same_json_value() {
	// Compare as JSON values (structural equality, not byte order).
	let original_value: serde_json::Value =
		serde_json::from_str(FIXTURE_JSON).expect("fixture JSON must parse");
	let fixture: ProviderShapeNormalizationFixtureV0 =
		serde_json::from_value(original_value.clone()).expect("fixture must deserialize");
	let round_tripped: serde_json::Value =
		serde_json::to_value(&fixture).expect("fixture must serialize");
	assert_eq!(original_value, round_tripped, "fixture must round-trip to the same JSON value");
}

// ── Validation report: canonical fixture passes
// ───────────────────────────────

#[test]
fn validation_report_passes_for_canonical_fixture() {
	let fixture = load_fixture();
	let report = fixture.validate();
	assert!(
		report.is_ok(),
		"canonical fixture must pass all validation checks; errors: {:?}",
		report.errors
	);
}

// ── Validation report: failures on injected violations ───────────────────────

#[test]
fn validation_report_fails_for_missing_provider_shape() {
	let mut fixture = load_fixture();
	// Remove the OpenAI Responses wire shape.
	fixture
		.wire_shapes
		.retain(|ws| ws.provider_api_shape != ProviderApiShapeV0::OpenAiResponses);

	let report = fixture.validate();
	assert!(
		!report.all_three_shapes_present,
		"validation must detect missing openai_responses wire shape"
	);
	assert!(!report.is_ok(), "validation must not pass when a required provider shape is missing");
	assert!(
		report.errors.iter().any(|e| e.contains("openai_responses")),
		"error list must name the missing shape; errors: {:?}",
		report.errors
	);
}

#[test]
fn validation_report_fails_for_duplicate_provider_shape() {
	let mut fixture = load_fixture();
	// Duplicate the first wire shape.
	let first = fixture.wire_shapes[0].clone();
	fixture.wire_shapes.push(first);

	let report = fixture.validate();
	assert!(
		!report.each_shape_exactly_once,
		"validation must detect a shape that appears more than once"
	);
	assert!(!report.is_ok(), "validation must not pass when a shape appears more than once");
}

#[test]
fn validation_report_fails_for_credential_looking_key_in_projection() {
	let mut fixture = load_fixture();
	// Inject a credential-looking key into the first wire shape's
	// request_projection.
	let ws = fixture
		.wire_shapes
		.first_mut()
		.expect("wire_shapes must not be empty");
	if let serde_json::Value::Object(map) = &mut ws.request_projection {
		map.insert(
			"api_key".to_owned(),
			serde_json::Value::String("sk-test-placeholder-not-real".to_owned()),
		);
	} else {
		ws.request_projection = json!({ "api_key": "sk-test-placeholder-not-real" });
	}

	let report = fixture.validate();
	assert!(
		!report.no_credential_keys,
		"validation must detect credential-looking key `api_key` in wire shape projection"
	);
	assert!(!report.is_ok(), "validation must not pass when a credential-looking key is present");
	assert!(
		report.errors.iter().any(|e| e.contains("api_key")),
		"error list must name the offending key; errors: {:?}",
		report.errors
	);
}

// ── ProviderApiShapeV0 enum serde invariants
// ──────────────────────────────────

#[test]
fn provider_api_shape_enum_serializes_to_exact_wire_strings() {
	let anthropic = serde_json::to_value(ProviderApiShapeV0::AnthropicMessages).unwrap();
	let oai_chat = serde_json::to_value(ProviderApiShapeV0::OpenAiChatCompletions).unwrap();
	let oai_resp = serde_json::to_value(ProviderApiShapeV0::OpenAiResponses).unwrap();

	assert_eq!(
		anthropic,
		serde_json::Value::String("anthropic_messages".to_owned()),
		"AnthropicMessages must serialize to `anthropic_messages`"
	);
	assert_eq!(
		oai_chat,
		serde_json::Value::String("openai_chat_completions".to_owned()),
		"OpenAiChatCompletions must serialize to `openai_chat_completions`"
	);
	assert_eq!(
		oai_resp,
		serde_json::Value::String("openai_responses".to_owned()),
		"OpenAiResponses must serialize to `openai_responses`"
	);
}

#[test]
fn provider_api_shape_enum_rejects_unknown_strings() {
	let result = serde_json::from_str::<ProviderApiShapeV0>(r#""anthropic_bedrock""#);
	assert!(result.is_err(), "unknown provider shape string must be rejected by deserialization");
}

#[test]
fn provider_api_shape_enum_rejects_empty_string() {
	let result = serde_json::from_str::<ProviderApiShapeV0>(r#""""#);
	assert!(result.is_err(), "empty string must be rejected as a provider shape");
}

// ── Wire projection encoding invariants ──────────────────────────────────────

#[test]
fn openai_chat_completions_encodes_arguments_as_json_string() {
	let fixture = load_fixture();
	let oai_chat = fixture
		.wire_shapes
		.iter()
		.find(|ws| ws.provider_api_shape == ProviderApiShapeV0::OpenAiChatCompletions)
		.expect("openai_chat_completions shape must be present");

	// OpenAI Chat encodes function call arguments as a stringified JSON value.
	let function = oai_chat
		.observed_tool_call_projection
		.get("function")
		.expect("openai_chat_completions observed tool call must have `function` field");
	let arguments = function
		.get("arguments")
		.expect("`function` must have `arguments` field");
	assert!(
		arguments.is_string(),
		"openai_chat_completions encodes arguments as a JSON string, not an object; got: \
		 {arguments:?}"
	);
}

#[test]
fn openai_responses_encodes_arguments_as_json_string() {
	let fixture = load_fixture();
	let oai_resp = fixture
		.wire_shapes
		.iter()
		.find(|ws| ws.provider_api_shape == ProviderApiShapeV0::OpenAiResponses)
		.expect("openai_responses shape must be present");

	// OpenAI Responses encodes function call arguments as a stringified JSON value.
	let arguments = oai_resp
		.observed_tool_call_projection
		.get("arguments")
		.expect("openai_responses observed tool call must have `arguments` field");
	assert!(
		arguments.is_string(),
		"openai_responses encodes arguments as a JSON string, not an object; got: {arguments:?}"
	);
}

#[test]
fn anthropic_messages_encodes_arguments_as_object() {
	let fixture = load_fixture();
	let anthropic = fixture
		.wire_shapes
		.iter()
		.find(|ws| ws.provider_api_shape == ProviderApiShapeV0::AnthropicMessages)
		.expect("anthropic_messages shape must be present");

	// Anthropic Messages encodes tool input as a JSON object under `input`.
	let input = anthropic
		.observed_tool_call_projection
		.get("input")
		.expect("anthropic_messages observed tool call must have `input` field");
	assert!(
		input.is_object(),
		"anthropic_messages encodes tool arguments as a JSON object (`input`); got: {input:?}"
	);
}

// ── All three shapes normalize to the same tool name ─────────────────────────

#[test]
fn normalized_tool_name_is_read_across_all_shapes() {
	let fixture = load_fixture();
	assert_eq!(
		fixture.normalized_tool_call.tool_name, "read",
		"normalized_tool_call.tool_name must be `read`"
	);
	assert_eq!(
		fixture.normalized_tool_result.tool_name, "read",
		"normalized_tool_result.tool_name must be `read`"
	);
}

// ── NormalizedProviderRequestV0 ─────────────────────────────────────────────

#[test]
fn normalized_provider_request_event_type_constant() {
	assert_eq!(
		PROVIDER_REQUEST_BUILT_EVENT_TYPE, "provider_request.built",
		"PROVIDER_REQUEST_BUILT_EVENT_TYPE must equal `provider_request.built`"
	);
}

#[test]
fn normalized_provider_request_serializes_expected_fields() {
	let req: NormalizedProviderRequestV0 = serde_json::from_value(json!({
		 "event_type": "provider_request.built",
		 "request_id": "req_test_00000000-0000-4000-8000-000000000099",
		 "turn_id": "turn_test_00000000-0000-4000-8000-000000000099",
		 "provider_api_shape": "anthropic_messages",
		 "content_preview": "Read packages/foo/bar.ts",
		 "source_artifact_id": null,
		 "source_ref": null
	}))
	.expect("NormalizedProviderRequestV0 must deserialize from valid JSON");

	assert_eq!(
		req.event_type, PROVIDER_REQUEST_BUILT_EVENT_TYPE,
		"event_type must equal PROVIDER_REQUEST_BUILT_EVENT_TYPE"
	);
	assert_eq!(
		req.provider_api_shape,
		ProviderApiShapeV0::AnthropicMessages,
		"provider_api_shape must deserialize correctly"
	);
	assert_eq!(
		req.content_preview.as_deref(),
		Some("Read packages/foo/bar.ts"),
		"content_preview must round-trip"
	);
	assert!(req.source_artifact_id.is_none(), "source_artifact_id must be None");
	assert!(req.source_ref.is_none(), "source_ref must be None");

	let serialized = serde_json::to_value(&req).expect("must serialize");
	let obj = serialized.as_object().expect("must serialize to object");
	assert!(obj.contains_key("event_type"), "serialized form must have event_type");
	assert!(obj.contains_key("request_id"), "serialized form must have request_id");
	assert!(obj.contains_key("turn_id"), "serialized form must have turn_id");
	assert!(obj.contains_key("provider_api_shape"), "serialized form must have provider_api_shape");
}

#[test]
fn normalized_provider_request_does_not_expose_wire_projection_fields() {
	// Verify that NormalizedProviderRequestV0 serializes without wire projection
	// fields.
	let req: NormalizedProviderRequestV0 = serde_json::from_value(json!({
		 "event_type": "provider_request.built",
		 "request_id": "req_test_00000000-0000-4000-8000-000000000099",
		 "turn_id": "turn_test_00000000-0000-4000-8000-000000000099",
		 "provider_api_shape": "openai_chat_completions",
		 "content_preview": null,
		 "source_artifact_id": null,
		 "source_ref": null
	}))
	.expect("must deserialize");

	let serialized = serde_json::to_value(&req).expect("must serialize");
	let obj = serialized.as_object().expect("must serialize to object");

	// Wire projection fields must not be present.
	assert!(
		!obj.contains_key("request_projection"),
		"NormalizedProviderRequestV0 must not expose request_projection"
	);
	assert!(
		!obj.contains_key("messages"),
		"NormalizedProviderRequestV0 must not expose wire body field `messages`"
	);
	assert!(
		!obj.contains_key("tools"),
		"NormalizedProviderRequestV0 must not expose wire body field `tools`"
	);

	// deny_unknown_fields: injecting a wire field must cause deserialization to
	// fail.
	let with_wire_field = json!({
		 "event_type": "provider_request.built",
		 "request_id": "req_test_00000000-0000-4000-8000-000000000099",
		 "turn_id": "turn_test_00000000-0000-4000-8000-000000000099",
		 "provider_api_shape": "anthropic_messages",
		 "content_preview": null,
		 "source_artifact_id": null,
		 "source_ref": null,
		 "request_projection": {}
	});
	let result = serde_json::from_value::<NormalizedProviderRequestV0>(with_wire_field);
	assert!(
		result.is_err(),
		"NormalizedProviderRequestV0 must reject unknown field `request_projection`"
	);
}

#[test]
fn normalized_provider_request_carries_source_ref_fields() {
	let req: NormalizedProviderRequestV0 = serde_json::from_value(json!({
		 "event_type": "provider_request.built",
		 "request_id": "req_test_00000000-0000-4000-8000-000000000099",
		 "turn_id": "turn_test_00000000-0000-4000-8000-000000000099",
		 "provider_api_shape": "openai_responses",
		 "content_preview": "What is the capital of France?",
		 "source_artifact_id": "art_test_00000000-0000-4000-8000-000000000099",
		 "source_ref": "sha256:abc123"
	}))
	.expect("must deserialize with source ref fields");

	assert!(req.source_artifact_id.is_some(), "source_artifact_id must be Some");
	assert_eq!(req.source_ref.as_deref(), Some("sha256:abc123"), "source_ref must round-trip");
	assert_eq!(
		req.content_preview.as_deref(),
		Some("What is the capital of France?"),
		"content_preview must round-trip"
	);
}

// ── Credential value scanning
// ─────────────────────────────────────────────────

#[test]
fn validation_fails_for_credential_looking_string_value_in_known_field() {
	let mut fixture = load_fixture();
	// Inject a high-confidence credential pattern as a string value in a typed
	// field.
	fixture.normalized_response.text = "MEMEX_LICENSE=sentinel-test-value-not-real".to_owned();

	let report = fixture.validate();
	assert!(
		!report.no_credential_keys,
		"validation must detect credential-looking string value in normalized_response.text"
	);
	assert!(
		!report.is_ok(),
		"validation must not pass when a credential-looking string value is present"
	);
	assert!(
		report.errors.iter().any(|e| e.contains("memex_license")),
		"error list must identify the offending pattern; errors: {:?}",
		report.errors
	);
}

#[test]
fn validation_fails_for_required_high_confidence_credential_value_sentinels() {
	for sentinel in [
		"refresh_token=not-real",
		"access_token=not-real",
		"client_secret=not-real",
		"Authorization: Bearer not-real",
	] {
		let mut fixture = load_fixture();
		fixture.normalized_response.text = sentinel.to_owned();

		let report = fixture.validate();
		assert!(
			!report.no_credential_keys,
			"validation must detect high-confidence credential-looking value: {sentinel}"
		);
		assert!(
			!report.is_ok(),
			"validation must fail for high-confidence credential-looking value: {sentinel}"
		);
	}
}

#[test]
fn top_level_unknown_credential_field_rejected_at_deserialization() {
	let mut raw: serde_json::Value =
		serde_json::from_str(FIXTURE_JSON).expect("fixture JSON must parse");
	raw.as_object_mut()
		.expect("fixture must be an object")
		.insert(
			"api_key".to_owned(),
			serde_json::Value::String("sk-top-level-test-not-real".to_owned()),
		);

	let result = serde_json::from_value::<ProviderShapeNormalizationFixtureV0>(raw);
	assert!(
		result.is_err(),
		"fixture with top-level unknown credential field must be rejected (deny_unknown_fields)"
	);
}

#[test]
fn unknown_credential_field_in_canonical_dto_rejected_at_deserialization() {
	// Parse the fixture to a raw JSON value, then inject an unknown
	// credential-looking field into canonical_successor_ids before deserializing.
	// CanonicalSuccessorIdsV0 carries deny_unknown_fields, so this must fail.
	let mut raw: serde_json::Value =
		serde_json::from_str(FIXTURE_JSON).expect("fixture JSON must parse");

	if let Some(ids) = raw.get_mut("canonical_successor_ids")
		&& let Some(obj) = ids.as_object_mut()
	{
		obj.insert(
			"anthropic_api_key".to_owned(),
			serde_json::Value::String("sk-ant-test-not-real".to_owned()),
		);
	}

	let result = serde_json::from_value::<ProviderShapeNormalizationFixtureV0>(raw);
	assert!(
		result.is_err(),
		"fixture with unknown field in canonical_successor_ids must be rejected \
		 (deny_unknown_fields)"
	);
}
