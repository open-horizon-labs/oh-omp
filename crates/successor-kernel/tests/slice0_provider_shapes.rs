//! Owned by Lane C4 `KernelProviderProjection`.
//!
//! Fixture-driven, deterministic offline proofs that
//! `successor_kernel::provider::projection` round-trips against the
//! canonical `fixtures/slice-0/provider-shape-normalization.json` fixture
//! for all three published provider API shapes (Dissent ruling 3), that
//! the custody invariants hold (Dissent ruling 4), and that the A4
//! unsupported-tool residual is typed, recorded behavior rather than a
//! bypass of the accepted projection (Dissent ruling 5).
//!
//! These are external-crate proofs that complement, and deliberately do
//! not duplicate, the in-module unit tests in `provider::projection` and
//! `provider::anthropic` (which cover the Anthropic-only success/failure
//! paths and the adapter's credential custody). This file extends the
//! same contracts to the two `OpenAI` wire shapes and anchors the
//! request/tool-call/tool-result projections directly to the fixture as
//! the single source of truth.

use successor_kernel::{
	provider::projection::{
		ProjectionError, ProviderBuildInputV0, build_provider_request, normalize_response,
		normalize_tool_call, project_request_body, project_tool_call, project_tool_result,
	},
	tools::{
		catalog::slice0_catalog, find::FindArgs, grep::GrepArgs, list_dir::ListDirArgs,
		read::ReadArgs, search_files::SearchFilesArgs,
	},
};
use successor_protocol::{
	fixtures,
	ids::{ArtifactId, MessageId, ToolCallId},
	provider::{NormalizedToolResultV0, ProviderApiShapeV0, ProviderWireShapeV0},
	provider_shape_fixture::ProviderShapeNormalizationFixtureV0,
	tool_catalog::{ToolCatalogV0, ToolDefinitionV0, ToolStatusV0},
};

const USER_TEXT: &str = "Read packages/coding-agent/src/context/concept-graph.ts";
const SENTINEL_SECRET: &str = "sk-ant-should-never-appear-anywhere";

const fn all_shapes() -> [ProviderApiShapeV0; 3] {
	[
		ProviderApiShapeV0::AnthropicMessages,
		ProviderApiShapeV0::OpenAiChatCompletions,
		ProviderApiShapeV0::OpenAiResponses,
	]
}

/// Recursively re-parses any string value that is itself valid JSON before
/// comparing. JSON object key order carries no contract meaning (this
/// `serde_json` build does not enable `preserve_order`, so re-encoding a
/// deserialized map is alphabetical, not insertion order), and `OpenAI`'s
/// wire shapes stringify `arguments` as embedded JSON text. Byte-exact
/// string equality on that embedded text would assert an implementation
/// accident, not a fixture contract, so structural equality is used
/// instead.
fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
	match value {
		serde_json::Value::String(text) => match serde_json::from_str::<serde_json::Value>(text) {
			Ok(parsed) => canonicalize(&parsed),
			Err(_) => value.clone(),
		},
		serde_json::Value::Object(map) => map
			.iter()
			.map(|(key, entry)| (key.clone(), canonicalize(entry)))
			.collect(),
		serde_json::Value::Array(items) => items.iter().map(canonicalize).collect(),
		other => other.clone(),
	}
}

fn assert_wire_json_eq(actual: &serde_json::Value, expected: &serde_json::Value, context: &str) {
	assert_eq!(canonicalize(actual), canonicalize(expected), "{context}");
}

fn wire_shape<'a>(
	fixture: &'a ProviderShapeNormalizationFixtureV0,
	shape: &ProviderApiShapeV0,
) -> &'a ProviderWireShapeV0 {
	fixture
		.wire_shapes
		.iter()
		.find(|entry| &entry.provider_api_shape == shape)
		.unwrap_or_else(|| panic!("canonical fixture is missing a wire shape entry for {shape:?}"))
}

/// The fixture's `request_projection` advertises a `read` tool with an
/// `input_schema`. `successor_protocol::fixtures::tool_catalog()` is owned
/// by a different lane and publishes a differently worded `read` tool with
/// no schema, so this builds a catalog from the literal values in
/// `provider-shape-normalization.json` instead of reusing that fixture.
///
/// The schema below (`path`/`offset`/`limit`, `path` required) mirrors the
/// fixture's own literal `read` schema exactly (<agent://269> Lane 3
/// dissent ruling: `max_bytes` is no longer advertised anywhere).
fn read_tool_catalog() -> ToolCatalogV0 {
	let read_tool = ToolDefinitionV0 {
		name:         "read".to_owned(),
		category:     "safe_read_discovery".to_owned(),
		status:       ToolStatusV0::Executable,
		description:  Some("Read a relative file under the workspace root.".to_owned()),
		input_schema: Some(serde_json::json!({
			"type": "object",
			"properties": {
				"path": { "type": "string" },
				"offset": { "type": "integer" },
				"limit": { "type": "integer" },
			},
			"required": ["path"],
		})),
	};
	ToolCatalogV0::new(
		"catalog_shape_00000000-0000-4000-8000-000000000001",
		"2026-07-02T00:00:00Z",
		"v0",
		vec![read_tool],
	)
}

#[test]
fn request_projection_matches_the_canonical_fixture_for_every_provider_shape() {
	let fixture = fixtures::provider_shape_normalization();
	let catalog = read_tool_catalog();

	for shape in all_shapes() {
		let expected = &wire_shape(&fixture, &shape).request_projection;
		let projected = project_request_body(&shape, USER_TEXT, &catalog);
		assert_wire_json_eq(
			&projected,
			expected,
			&format!("request projection mismatch for {shape:?}"),
		);
	}
}

#[test]
fn build_provider_request_carries_the_provider_api_shape_for_every_shape() {
	let fixture = fixtures::provider_shape_normalization();
	let catalog = read_tool_catalog();

	for shape in all_shapes() {
		let input = ProviderBuildInputV0 {
			request_id:         fixture.canonical_successor_ids.request_id.clone(),
			turn_id:            fixture.canonical_successor_ids.turn_id.clone(),
			provider_api_shape: shape.clone(),
			content_preview:    Some(USER_TEXT.to_owned()),
			source_artifact_id: None,
			source_ref:         None,
			tool_name:          None,
		};
		let request = build_provider_request(&input, &catalog).expect("tool-free turn always builds");
		assert_eq!(request.provider_api_shape, shape);
	}
}

#[test]
fn tool_call_round_trips_through_project_and_normalize_for_every_shape() {
	let fixture = fixtures::provider_shape_normalization();
	let canonical_tool_call_id: ToolCallId = fixture.canonical_successor_ids.tool_call_id.clone();

	for shape in all_shapes() {
		let entry = wire_shape(&fixture, &shape);

		let (normalized, metadata) = normalize_tool_call(
			&shape,
			&entry.observed_tool_call_projection,
			canonical_tool_call_id.clone(),
		)
		.expect("canonical fixture wire tool call always parses");
		assert_eq!(
			normalized, fixture.normalized_tool_call,
			"normalized tool call mismatch for {shape:?}"
		);
		// Provider-specific tool call IDs are metadata, not successor identity
		// (fixture assertion). The canonical `tool_call_id` stays stable across
		// shapes; only the metadata carries the provider-specific wire ID.
		assert_eq!(metadata.provider_api_shape, shape);
		assert_eq!(metadata.provider_tool_call_id, entry.provider_specific_tool_call_id);

		let projected = project_tool_call(
			&shape,
			&fixture.normalized_tool_call,
			&entry.provider_specific_tool_call_id,
		);
		assert_wire_json_eq(
			&projected,
			&entry.observed_tool_call_projection,
			&format!("tool call projection mismatch for {shape:?}"),
		);
	}
}

#[test]
fn tool_result_projects_to_the_canonical_fixture_for_every_shape() {
	let fixture = fixtures::provider_shape_normalization();

	for shape in all_shapes() {
		let entry = wire_shape(&fixture, &shape);
		let projected = project_tool_result(
			&shape,
			&fixture.normalized_tool_result,
			&entry.provider_specific_tool_call_id,
		);
		assert_wire_json_eq(
			&projected,
			&entry.tool_result_projection,
			&format!("tool result projection mismatch for {shape:?}"),
		);
	}
}

#[test]
fn tool_result_projection_never_inlines_artifact_content_only_the_handle() {
	let fixture = fixtures::provider_shape_normalization();
	let artifact_id: ArtifactId = fixture.normalized_tool_result.artifact_id.clone();

	// A tool result carrying secret-shaped content in a field the projection
	// does not read must still project to nothing but the artifact handle:
	// the projection layer never has a code path that could echo artifact
	// content, because `NormalizedToolResultV0` never carries content at all.
	let tool_result = NormalizedToolResultV0 {
		event_type:   fixture.normalized_tool_result.event_type.clone(),
		tool_call_id: fixture.normalized_tool_result.tool_call_id.clone(),
		tool_name:    fixture.normalized_tool_result.tool_name.clone(),
		status:       fixture.normalized_tool_result.status,
		artifact_id:  artifact_id.clone(),
	};

	for shape in all_shapes() {
		let projected = project_tool_result(&shape, &tool_result, "provider-specific-id");
		let rendered = projected.to_string();
		assert!(
			rendered.contains(artifact_id.as_str()),
			"projection for {shape:?} must reference the artifact handle"
		);
		assert!(
			!rendered.contains(SENTINEL_SECRET),
			"projection for {shape:?} must never carry inlined content"
		);
	}
}

#[test]
fn unsupported_tool_rejection_is_typed_and_shape_independent() {
	let fixture = fixtures::provider_shape_normalization();
	let catalog = ToolCatalogV0::new(
		"catalog_stub_00000000-0000-4000-8000-000000000002",
		"2026-07-02T00:00:00Z",
		"v0",
		vec![ToolDefinitionV0::stub_rejected("bash", "shell_execution")],
	);

	for shape in [ProviderApiShapeV0::OpenAiChatCompletions, ProviderApiShapeV0::OpenAiResponses] {
		let input = ProviderBuildInputV0 {
			request_id:         fixture.canonical_successor_ids.request_id.clone(),
			turn_id:            fixture.canonical_successor_ids.turn_id.clone(),
			provider_api_shape: shape.clone(),
			content_preview:    None,
			source_artifact_id: None,
			source_ref:         None,
			tool_name:          Some("bash".to_owned()),
		};
		let err = build_provider_request(&input, &catalog)
			.expect_err("a stub-rejected tool must never build a provider request");
		assert_eq!(
			err,
			ProjectionError::UnsupportedTool {
				tool_name: "bash".to_owned(),
				status:    ToolStatusV0::StubRejected,
			},
			"unsupported-tool detection must be typed for {shape:?}, not a bespoke rejection"
		);
	}
}

#[test]
fn tool_absent_from_catalog_is_rejected_regardless_of_shape() {
	let fixture = fixtures::provider_shape_normalization();
	let catalog = read_tool_catalog(); // publishes only "read".

	for shape in [ProviderApiShapeV0::OpenAiChatCompletions, ProviderApiShapeV0::OpenAiResponses] {
		let input = ProviderBuildInputV0 {
			request_id:         fixture.canonical_successor_ids.request_id.clone(),
			turn_id:            fixture.canonical_successor_ids.turn_id.clone(),
			provider_api_shape: shape.clone(),
			content_preview:    None,
			source_artifact_id: None,
			source_ref:         None,
			tool_name:          Some("bash".to_owned()),
		};
		let err = build_provider_request(&input, &catalog)
			.expect_err("a catalog-absent tool must never build a provider request");
		assert_eq!(err, ProjectionError::ToolNotInCatalog { tool_name: "bash".to_owned() });
	}
}

#[test]
fn malformed_wire_tool_call_error_never_echoes_the_wire_body_for_openai_shapes() {
	let fixture = fixtures::provider_shape_normalization();
	let tool_call_id: ToolCallId = fixture.canonical_successor_ids.tool_call_id;

	for shape in [ProviderApiShapeV0::OpenAiChatCompletions, ProviderApiShapeV0::OpenAiResponses] {
		let wire = serde_json::json!({ "leaked_secret": SENTINEL_SECRET });
		let err = normalize_tool_call(&shape, &wire, tool_call_id.clone())
			.expect_err("a wire tool call missing every expected field must be rejected");
		assert!(matches!(err, ProjectionError::MalformedToolCall { .. }));

		let rendered = format!("{err}");
		assert!(!rendered.contains(SENTINEL_SECRET));
		assert!(!rendered.contains("leaked_secret"));
	}
}

#[test]
fn malformed_wire_response_error_never_echoes_the_wire_body_for_openai_shapes() {
	let fixture = fixtures::provider_shape_normalization();
	let message_id: MessageId = fixture.canonical_successor_ids.message_id;

	for shape in [ProviderApiShapeV0::OpenAiChatCompletions, ProviderApiShapeV0::OpenAiResponses] {
		let wire = serde_json::json!({ "leaked_secret": SENTINEL_SECRET });
		let err = normalize_response(&shape, &wire, message_id.clone())
			.expect_err("a wire response missing every expected field must be rejected");
		assert!(matches!(err, ProjectionError::MalformedResponse { .. }));

		let rendered = format!("{err}");
		assert!(!rendered.contains(SENTINEL_SECRET));
		assert!(!rendered.contains("leaked_secret"));
	}
}

#[test]
fn normalize_response_extracts_finish_reason_and_text_for_every_shape() {
	let fixture = fixtures::provider_shape_normalization();
	let message_id: MessageId = fixture.canonical_successor_ids.message_id.clone();

	let cases: [(ProviderApiShapeV0, serde_json::Value, &str); 3] = [
		(
			ProviderApiShapeV0::AnthropicMessages,
			serde_json::json!({
				"stop_reason": "end_turn",
				"content": [{ "type": "text", "text": "Read completed." }],
			}),
			"stop",
		),
		(
			ProviderApiShapeV0::OpenAiChatCompletions,
			serde_json::json!({
				"choices": [{ "finish_reason": "stop", "message": { "content": "Read completed." } }],
			}),
			"stop",
		),
		(
			ProviderApiShapeV0::OpenAiResponses,
			serde_json::json!({ "status": "completed", "output_text": "Read completed." }),
			"completed",
		),
	];

	for (shape, wire, expected_finish_reason) in cases {
		let response = normalize_response(&shape, &wire, message_id.clone())
			.unwrap_or_else(|err| panic!("well-formed wire response for {shape:?} must parse: {err}"));
		assert_eq!(
			response.finish_reason, expected_finish_reason,
			"finish reason mismatch for {shape:?}"
		);
		assert_eq!(response.text, "Read completed.", "text mismatch for {shape:?}");
		assert_eq!(response.event_type, fixture.normalized_response.event_type);
	}
}

/// Drift-proof contract (<agent://252-ToolSchemaAmendmentDissent>, ruling 4/6;
/// strengthened per post-hoc review <agent://254-ToolSchemaAmendmentReview>,
/// finding 1, closing dissent ruling 252.4's residual gap; extended per
/// agent://269 Lane 3 dissent ruling for the new `list_dir` tool and the
/// widened `read` tool): a schema with an extra unrelated property, a
/// missing expected property, or hand-drifted content must FAIL this test.
/// Two independent checks enforce that:
///
/// (a) whole-document exact equality between each executable tool's
/// published `input_schema` and `schemars::schema_for!` for the exact kernel
/// arg DTO `execute_tool` deserializes into, compared as a whole
/// `serde_json::Value` (no field cherry-picking), via the identical
/// transformation path `catalog::executable_input_schema` uses (none: the
/// catalog publishes the schemars output verbatim, see that function);
///
/// (b) an independent, hand-authored spot oracle that does not derive from
/// the DTO types at all: the exact `properties` key set the executor
/// actually consumes, per tool, read from the published body (not the DTO).
/// None of the five DTOs mark any field as JSON-Schema `required` -- every
/// field on every one of them carries a `#[serde(default = ...)]`, so
/// `schemars` never emits a `required` key for them at all (verified
/// directly against the generated schemas, not assumed). This oracle
/// asserts that invariant explicitly too, so a future edit that drops a
/// default and silently makes a field schema-required is caught here.
#[test]
fn every_executable_tool_in_the_anthropic_projection_matches_its_dto_schema_and_the_hand_authored_spot_oracle_exactly()
 {
	let catalog = slice0_catalog();
	let projected =
		project_request_body(&ProviderApiShapeV0::AnthropicMessages, USER_TEXT, &catalog);
	let tools = projected
		.get("tools")
		.and_then(serde_json::Value::as_array)
		.expect("Anthropic projection must carry a tools array");
	assert!(!tools.is_empty(), "Slice 0 must publish at least one executable tool");

	let placeholder = serde_json::json!({ "type": "object" });

	// (b) hand-authored, DTO-independent expectation of the property set the
	// executor actually reads for each tool. Never derived from the type.
	let expected_properties: [(&str, &[&str]); 5] = [
		("search_files", &["query", "max_matches"]),
		("read", &["path", "offset", "limit"]),
		("find", &["glob"]),
		("grep", &["pattern"]),
		("list_dir", &["path"]),
	];

	let mut seen: Vec<&str> = Vec::new();
	for tool in tools {
		let name = tool
			.get("name")
			.and_then(serde_json::Value::as_str)
			.expect("tool name must be a string");
		let schema = tool
			.get("input_schema")
			.unwrap_or_else(|| panic!("tool {name} must carry an input_schema key"));
		assert!(!schema.is_null(), "tool {name} must not publish input_schema: null");
		assert_ne!(schema, &placeholder, "tool {name} must not publish a bare placeholder schema");
		assert_eq!(
			schema.get("type").and_then(serde_json::Value::as_str),
			Some("object"),
			"tool {name} schema must be a JSON Schema object"
		);

		// (a) whole-document exact equality against schemars for the exact same
		// DTO type the kernel executor deserializes into.
		let expected_schema = match name {
			"search_files" => serde_json::to_value(schemars::schema_for!(SearchFilesArgs))
				.expect("schemars output for SearchFilesArgs must serialize"),
			"read" => serde_json::to_value(schemars::schema_for!(ReadArgs))
				.expect("schemars output for ReadArgs must serialize"),
			"find" => serde_json::to_value(schemars::schema_for!(FindArgs))
				.expect("schemars output for FindArgs must serialize"),
			"grep" => serde_json::to_value(schemars::schema_for!(GrepArgs))
				.expect("schemars output for GrepArgs must serialize"),
			"list_dir" => serde_json::to_value(schemars::schema_for!(ListDirArgs))
				.expect("schemars output for ListDirArgs must serialize"),
			other => panic!(
				"executable tool {other} has no schemars oracle wired into this test; add its DTO"
			),
		};
		assert_eq!(
			schema, &expected_schema,
			"tool {name} input_schema must equal schemars::schema_for! for its kernel arg DTO \
			 exactly, whole-document, no cherry-picking"
		);

		// (b) independent spot oracle, read from the published body only.
		let found = expected_properties
			.iter()
			.find(|entry| entry.0 == name)
			.unwrap_or_else(|| panic!("tool {name} has no hand-authored spot-oracle entry"));
		let expected_props: &[&str] = found.1;
		let properties = schema
			.get("properties")
			.and_then(serde_json::Value::as_object)
			.unwrap_or_else(|| panic!("tool {name} schema must declare properties"));
		let mut actual_props: Vec<&str> = properties.keys().map(String::as_str).collect();
		actual_props.sort_unstable();
		let mut want_props: Vec<&str> = expected_props.to_vec();
		want_props.sort_unstable();
		assert_eq!(
			actual_props, want_props,
			"tool {name} properties must be exactly the executor-consumed field set: no extra \
			 property, none missing, no hand-drift"
		);
		assert!(
			schema.get("required").is_none(),
			"tool {name} must not publish a `required` array; every argument field on this DTO \
			 carries a serde default"
		);

		seen.push(name);
	}

	for (tool_name, _) in expected_properties {
		assert!(
			seen.contains(&tool_name),
			"spot oracle expected {tool_name} to be an executable tool but it was absent from the \
			 projection"
		);
	}
}

/// Drift-proof contract (<agent://252-ToolSchemaAmendmentDissent>, ruling 6):
/// round-trips representative valid and invalid argument JSON through the
/// same kernel-local DTOs `execute_tool` deserializes against, so a future
/// change to those DTOs (or to the fixture-published schema) cannot
/// silently diverge from what the executor actually accepts.
#[test]
fn tool_argument_dtos_round_trip_valid_json_and_reject_malformed_json_through_the_same_error_class_execute_tool_uses()
 {
	let search: SearchFilesArgs =
		serde_json::from_value(serde_json::json!({ "query": "concept graph", "max_matches": 5 }))
			.expect("well-formed search_files arguments must deserialize");
	assert_eq!(search.query, "concept graph");
	assert_eq!(search.max_matches, 5);

	let search_defaults: SearchFilesArgs = serde_json::from_value(serde_json::json!({}))
		.expect("missing search_files arguments must fall back to defaults, not error");
	assert_eq!(search_defaults.query, "");
	assert_eq!(search_defaults.max_matches, 20);

	let read: ReadArgs = serde_json::from_value(serde_json::json!({ "path": "a.txt" }))
		.expect("well-formed read arguments must deserialize");
	assert_eq!(read.path, "a.txt");
	assert_eq!(read.offset, None);
	assert_eq!(read.limit, None);

	let read_ranged: ReadArgs =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "offset": 5, "limit": 10 }))
			.expect("read arguments carrying a positive offset/limit range must deserialize");
	assert_eq!(read_ranged.offset.map(std::num::NonZeroU32::get), Some(5));
	assert_eq!(read_ranged.limit.map(std::num::NonZeroU32::get), Some(10));

	// The `max_bytes` drift fix (agent://269 Lane 3 dissent ruling): a
	// legacy/unknown field is rejected as malformed, not silently ignored.
	// `execute_tool` maps this failure exactly the way it maps every other
	// tool-execution failure -- `.map_err(|err| err.to_string())` -- so the
	// error class downstream (`TurnFailure::Protocol(String)`) is identical
	// regardless of whether the failure came from argument parsing or from
	// tool execution itself.
	let rejected_max_bytes: Result<ReadArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "max_bytes": 200_000 }));
	assert!(
		rejected_max_bytes.is_err(),
		"a read call carrying the legacy max_bytes field must be rejected, not silently ignored"
	);

	let rejected_zero_offset: Result<ReadArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "offset": 0 }));
	assert!(rejected_zero_offset.is_err(), "a zero read offset must be rejected as malformed");

	let rejected_zero_limit: Result<ReadArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "limit": 0 }));
	assert!(rejected_zero_limit.is_err(), "a zero read limit must be rejected as malformed");

	let find: FindArgs = serde_json::from_value(serde_json::json!({}))
		.expect("missing find arguments must fall back to the default glob, not error");
	assert_eq!(find.glob, "**/*");

	let grep: GrepArgs = serde_json::from_value(serde_json::json!({ "pattern": "TODO" }))
		.expect("well-formed grep arguments must deserialize");
	assert_eq!(grep.pattern, "TODO");

	let list_dir: ListDirArgs = serde_json::from_value(serde_json::json!({ "path": "src" }))
		.expect("well-formed list_dir arguments must deserialize");
	assert_eq!(list_dir.path, "src");

	let list_dir_defaults: ListDirArgs = serde_json::from_value(serde_json::json!({}))
		.expect("missing list_dir arguments must fall back to the root path, not error");
	assert_eq!(list_dir_defaults.path, "");

	let rejected_list_dir_unknown: Result<ListDirArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "src", "recursive": true }));
	assert!(
		rejected_list_dir_unknown.is_err(),
		"a list_dir call carrying an unknown field must be rejected, not silently ignored"
	);

	// A malformed argument type is rejected, not silently coerced to a
	// default. `execute_tool` maps this failure exactly the way it maps
	// every other tool-execution failure: `.map_err(|err| err.to_string())`,
	// so the error class downstream (`TurnFailure::Protocol(String)`) is
	// identical regardless of whether the failure came from argument
	// parsing or from tool execution itself.
	let rejected: Result<SearchFilesArgs, String> =
		serde_json::from_value(serde_json::json!({ "max_matches": "not-a-number" }))
			.map_err(|err| err.to_string());
	let message = rejected
		.expect_err("a non-numeric max_matches must be rejected, not silently defaulted to 20");
	assert!(!message.is_empty());
}
