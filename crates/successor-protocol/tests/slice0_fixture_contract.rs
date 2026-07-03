use std::collections::BTreeSet;

use successor_protocol::{
	canonical_json::to_canonical_projection_json_bytes,
	error::ProtocolViolationCode,
	fixtures,
	ids::EventId,
	kernel_frame::KernelFrameKindV0,
	platform_api::{AssemblePhaseV0, AssemblyResponseV0},
	provider::ProviderApiShapeV0,
	raw_event::{RawEventType, RawEventV0},
	replay::project_session,
	tool_catalog::ToolStatusV0,
	validation,
};

#[test]
fn raw_events_successful_turn_parses_full_session_sequence() {
	let events = fixtures::raw_events_successful_turn();
	assert_eq!(events.len(), 23);
	assert_eq!(events.first().expect("non-empty").session_seq, 1);
	assert_eq!(events.last().expect("non-empty").session_seq, 23);
}

#[test]
fn expected_session_projection_parses_with_full_turn_summary() {
	let projection = fixtures::expected_session_projection();
	assert_eq!(projection.session.last_raw_event_seq, 23);
	assert_eq!(projection.transcript.len(), 2);
	assert_eq!(projection.tools.len(), 2);
	assert_eq!(projection.artifacts.len(), 2);
	assert_eq!(projection.assemblies.len(), 3);
	assert_eq!(projection.provider_traces.len(), 4);
	assert!(projection.errors.is_empty());
}

#[test]
fn provider_shape_normalization_parses_with_three_required_wire_shapes() {
	let fixture = fixtures::provider_shape_normalization();
	assert_eq!(fixture.wire_shapes.len(), 3);
	let shapes: BTreeSet<String> = fixture
		.wire_shapes
		.iter()
		.map(|shape| serde_json::to_string(&shape.provider_api_shape).expect("shape serializes"))
		.collect();
	for expected in [
		ProviderApiShapeV0::AnthropicMessages,
		ProviderApiShapeV0::OpenAiChatCompletions,
		ProviderApiShapeV0::OpenAiResponses,
	] {
		let expected_json = serde_json::to_string(&expected).expect("shape serializes");
		assert!(shapes.contains(&expected_json), "missing wire shape {expected_json} in fixture");
	}
}

#[test]
fn kernel_frame_stream_parses_full_turn_lifecycle() {
	let frames = fixtures::kernel_frame_stream();
	assert_eq!(frames.len(), 10);
	assert_eq!(frames.first().expect("non-empty").kind, KernelFrameKindV0::TurnStarted);
	assert_eq!(frames.last().expect("non-empty").kind, KernelFrameKindV0::TurnCompleted);
	assert_eq!(
		frames
			.iter()
			.filter(|frame| frame.kind == KernelFrameKindV0::ToolCallRequested)
			.count(),
		2
	);
}

#[test]
fn session_snapshot_parses_with_full_session_index() {
	let snapshot = fixtures::session_snapshot();
	assert_eq!(snapshot.last_raw_event_seq, 23);
	assert_eq!(snapshot.raw_event_ids.len(), 23);
	assert_eq!(snapshot.source_envelope_ids.len(), 4);
	assert_eq!(snapshot.artifact_ids.len(), 2);
	assert_eq!(snapshot.assemble_ids.len(), 3);
}

#[test]
fn assemble_request_pre_tool_parses_with_no_required_sources() {
	let request = fixtures::assemble_request_pre_tool();
	assert_eq!(request.phase, AssemblePhaseV0::PreTool);
	assert!(request.required_source_envelope_ids.is_empty());
	assert_eq!(request.budget.max_context_tokens, 12000);
	assert_eq!(request.budget.max_items, 20);
}

#[test]
fn assemble_request_post_read_parses_with_one_required_source() {
	let request = fixtures::assemble_request_post_read();
	assert_eq!(request.phase, AssemblePhaseV0::PostRead);
	assert_eq!(request.required_source_envelope_ids.len(), 1);
	assert_eq!(
		request.required_source_envelope_ids[0].as_str(),
		"src_00000000-0000-4000-8000-000000000003"
	);
}

#[test]
fn raw_events_unsupported_tool_parses_rejected_tool_lifecycle() {
	let events = fixtures::raw_events_unsupported_tool();
	assert_eq!(events.len(), 4);
	assert!(events.iter().all(|event| event.turn_id.is_some()));
	// This fixture is intentionally excluded from replay coverage: the last
	// event is `error.recorded`, which `project_session` hard-rejects (see
	// `raw_events_unsupported_tool_is_rejected_by_project_session` below).
}

#[test]
fn raw_events_unsupported_tool_is_rejected_by_project_session() {
	let events = fixtures::raw_events_unsupported_tool();
	let result = project_session(&events);
	assert!(
		result.is_err(),
		"error.recorded lifecycle events must not be accepted by the successful-turn projector"
	);
}

#[test]
fn tool_catalog_parses_with_full_slice0_tool_roster() {
	let catalog = fixtures::tool_catalog();
	assert_eq!(catalog.tools.len(), 34);
	let executable_count = catalog
		.tools
		.iter()
		.filter(|tool| tool.status == ToolStatusV0::Executable)
		.count();
	assert_eq!(executable_count, 4);
	let stub_rejected_count = catalog
		.tools
		.iter()
		.filter(|tool| tool.status == ToolStatusV0::StubRejected)
		.count();
	assert_eq!(stub_rejected_count, 30);
}

#[test]
fn assemble_response_pre_tool_raw_is_exposed_as_a5_pending_text() {
	let raw = fixtures::assemble_response_pre_tool_raw();
	let value: serde_json::Value =
		serde_json::from_str(raw).expect("fixture must still be valid JSON");
	assert_eq!(value["schema_version"], "platform.assembly_response.v0");

	// Confirms the precise A5-pending mismatch: `DegradationV0` requires a
	// `reason` field, but this fixture's degradation entries carry `message`
	// instead, which is why this fixture is not exposed as a typed
	// `AssemblyResponseV0` accessor.
	assert!(value["degradation"][0].get("reason").is_none());
	assert!(value["degradation"][0].get("message").is_some());

	let parsed: Result<AssemblyResponseV0, _> = serde_json::from_str(raw);
	let err = parsed.expect_err("AssemblyResponseV0 must reject this fixture's degradation shape");
	assert!(
		err.to_string().contains("reason"),
		"expected a missing-field error mentioning `reason`, got: {err}"
	);
}

#[test]
fn assemble_response_post_read_raw_is_exposed_as_a5_pending_text() {
	let raw = fixtures::assemble_response_post_read_raw();
	let value: serde_json::Value =
		serde_json::from_str(raw).expect("fixture must still be valid JSON");
	assert_eq!(value["schema_version"], "platform.assembly_response.v0");

	// Confirms the precise A5-pending mismatch: `ContextItemV0` requires
	// `kind`/`content` fields that this fixture's context_items do not
	// carry (it uses `source_kind`/`rendered_text` instead).
	assert!(value["context_items"][0].get("kind").is_none());
	assert!(value["context_items"][0].get("content").is_none());
	assert!(value["context_items"][0].get("source_kind").is_some());

	let parsed: Result<AssemblyResponseV0, _> = serde_json::from_str(raw);
	let err = parsed.expect_err("AssemblyResponseV0 must reject this fixture's context_item shape");
	assert!(
		err.to_string().contains("kind") || err.to_string().contains("reason"),
		"expected a missing-field error mentioning `kind` or `reason`, got: {err}"
	);
}

#[test]
fn raw_events_successful_turn_replays_to_expected_session_projection_bytes() {
	let events = fixtures::raw_events_successful_turn();
	let projection =
		project_session(&events).expect("canonical successful-turn events must replay cleanly");
	let expected = fixtures::expected_session_projection();
	assert_eq!(projection, expected);

	let actual_bytes =
		to_canonical_projection_json_bytes(&projection).expect("projection must serialize");
	let expected_bytes =
		to_canonical_projection_json_bytes(&expected).expect("projection must serialize");
	assert_eq!(actual_bytes, expected_bytes);
}

#[test]
fn duplicated_session_seq_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let first_seq = events[0].session_seq;
	events[1].session_seq = first_seq;

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a duplicated session_seq to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ReplayMismatch),
		"expected a replay_mismatch violation for duplicated session_seq, got: {violations}"
	);
}

#[test]
fn gapped_session_seq_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let last = events.len() - 1;
	events[last].session_seq += 5;

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a gapped session_seq to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ReplayMismatch),
		"expected a replay_mismatch violation for gapped session_seq, got: {violations}"
	);
}

#[test]
fn wrong_schema_version_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	events[0].schema_version = "not.the.right.version".to_owned();

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a wrong schema_version to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ValidationFailed),
		"expected a validation_failed violation for wrong schema_version, got: {violations}"
	);
}

#[test]
fn invalid_id_prefix_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	events[0].event_id = EventId::from_raw("not_an_event_id".to_owned());

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected an invalid event_id prefix to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::InvalidIdPrefix),
		"expected an invalid_id_prefix violation, got: {violations}"
	);
}

#[test]
fn corrupted_sha256_is_rejected_when_reparsed_through_the_accepted_deserializer() {
	let events = fixtures::raw_events_successful_turn();
	let with_artifact = events
		.iter()
		.find(|event| event.artifact.is_some())
		.expect("canonical successful-turn fixture must carry at least one artifact reference")
		.clone();

	let mut value = serde_json::to_value(&with_artifact).expect("event must serialize");
	value["artifact"]["sha256"] = serde_json::Value::String("sha256:not-valid-hex".to_owned());

	let err =
		serde_json::from_value::<RawEventV0>(value).expect_err("corrupted sha256 must be rejected");
	assert!(
		err.to_string()
			.contains(ProtocolViolationCode::MalformedHash.as_str()),
		"expected a malformed_hash rejection, got: {err}"
	);
}

#[test]
fn wrong_byte_length_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let index = events
		.iter()
		.position(|event| event.artifact.as_ref().is_some_and(|a| a.content.is_some()))
		.expect("canonical successful-turn fixture must carry inline artifact content");
	events[index]
		.artifact
		.as_mut()
		.expect("checked above")
		.byte_length += 1;

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a byte_length mismatch to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ValidationFailed),
		"expected a validation_failed violation for byte_length mismatch, got: {violations}"
	);
}

#[test]
fn unsupported_provider_api_shape_is_rejected_by_successful_turn_replay_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let index = events
		.iter()
		.position(|event| {
			matches!(
				event.event_type,
				RawEventType::ProviderRequestBuilt | RawEventType::ProviderResponseRecorded
			) && event.payload.get("provider_api_shape").is_some()
		})
		.expect("canonical successful-turn fixture must carry a provider_api_shape payload field");
	events[index].payload["provider_api_shape"] =
		serde_json::Value::String("made_up_shape".to_owned());

	let result = validation::validate_successful_turn_replay(
		&events,
		&fixtures::expected_session_projection(),
	);
	let Err(violations) = result else {
		panic!("expected an unsupported provider_api_shape to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::UnsupportedProviderApiShape),
		"expected an unsupported_provider_api_shape violation, got: {violations}"
	);
}

#[test]
fn mutated_expected_projection_bytes_cause_replay_mismatch() {
	let events = fixtures::raw_events_successful_turn();
	let mut expected = fixtures::expected_session_projection();
	expected
		.session
		.last_assistant_summary
		.push_str(" (mutated)");

	let result = validation::validate_successful_turn_replay(&events, &expected);
	let Err(violations) = result else {
		panic!("expected mutated projection bytes to cause a replay mismatch");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ReplayMismatch),
		"expected a replay_mismatch violation, got: {violations}"
	);
}

#[test]
fn unknown_field_injection_is_rejected_by_the_accepted_deserializer() {
	let events = fixtures::raw_events_successful_turn();
	let mut value = serde_json::to_value(&events[0]).expect("event must serialize");
	value["unexpected_top_level_field"] = serde_json::Value::Bool(true);

	let err = serde_json::from_value::<RawEventV0>(value)
		.expect_err("unknown top-level field must be rejected");
	assert!(
		err.to_string().contains("unknown field"),
		"expected an unknown-field rejection, got: {err}"
	);
}

#[test]
fn causation_pointing_forward_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let last_event_id = events.last().expect("non-empty").event_id.clone();
	events[1].causation_event_id = Some(last_event_id);

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a forward-pointing causation_event_id to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::CausationViolation),
		"expected a causation_violation for forward-pointing causation_event_id, got: {violations}"
	);
}

#[test]
fn causation_pointing_to_nonexistent_event_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	events[2].causation_event_id =
		Some(EventId::from_raw(format!("{}ffffffff-ffff-4fff-8fff-ffffffffffff", EventId::PREFIX)));

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a dangling causation_event_id to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::CausationViolation),
		"expected a causation_violation for a dangling causation_event_id, got: {violations}"
	);
}

#[test]
fn duplicated_idempotency_key_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let first_key = events[0].idempotency_key.clone();
	events[1].idempotency_key = first_key;

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a duplicated idempotency_key to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::DuplicateIdempotencyKey),
		"expected a duplicate_idempotency_key violation, got: {violations}"
	);
}

#[test]
fn credential_shaped_key_in_payload_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let index = events
		.iter()
		.position(|event| event.payload.is_object())
		.expect("canonical successful-turn fixture must carry an object payload");
	events[index].payload["injected_api_key"] =
		serde_json::Value::String("sk-ant-api03-not-a-real-key".to_owned());

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a credential-shaped payload key to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::CredentialLeakage),
		"expected a credential_leakage violation, got: {violations}"
	);
}

#[test]
fn unsupported_tool_lifecycle_wrong_event_type_is_rejected_by_lifecycle_validator() {
	let mut events = fixtures::raw_events_unsupported_tool();
	let catalog = fixtures::tool_catalog();
	let rejected_index = events
		.iter()
		.position(|event| event.event_type == RawEventType::ToolCallRejected)
		.expect("unsupported-tool fixture must carry a tool_call.rejected event");
	events[rejected_index].event_type = RawEventType::ToolCallCompleted;

	let Err(violations) = validation::validate_unsupported_tool_lifecycle(&events, &catalog) else {
		panic!("expected a completed-instead-of-rejected lifecycle event to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ValidationFailed),
		"expected a validation_failed violation for the wrong lifecycle event order, got: \
		 {violations}"
	);
}

#[test]
fn unsupported_tool_lifecycle_with_executable_catalog_tool_is_rejected_by_lifecycle_validator() {
	let events = fixtures::raw_events_unsupported_tool();
	let mut catalog = fixtures::tool_catalog();
	let tool = catalog
		.tools
		.iter_mut()
		.find(|tool| tool.name == "bash")
		.expect("unsupported-tool fixture references the 'bash' tool");
	tool.status = ToolStatusV0::Executable;

	let Err(violations) = validation::validate_unsupported_tool_lifecycle(&events, &catalog) else {
		panic!("expected an executable-per-catalog tool to be rejected by the lifecycle validator");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ValidationFailed),
		"expected a validation_failed violation for an executable catalog tool, got: {violations}"
	);
}

#[test]
fn unsupported_tool_lifecycle_out_of_order_events_are_rejected_by_lifecycle_validator() {
	let mut events = fixtures::raw_events_unsupported_tool();
	let catalog = fixtures::tool_catalog();
	let rejected_index = events
		.iter()
		.position(|event| event.event_type == RawEventType::ToolCallRejected)
		.expect("unsupported-tool fixture must carry a tool_call.rejected event");
	let error_index = events
		.iter()
		.position(|event| event.event_type == RawEventType::ErrorRecorded)
		.expect("unsupported-tool fixture must carry an error.recorded event");
	assert!(rejected_index < error_index, "fixture must order rejected before error");
	// Swap both positions and session_seqs so the stream stays dense while the
	// lifecycle order becomes error.recorded -> tool_call.rejected.
	let rejected_seq = events[rejected_index].session_seq;
	let error_seq = events[error_index].session_seq;
	events[rejected_index].session_seq = error_seq;
	events[error_index].session_seq = rejected_seq;
	events.swap(rejected_index, error_index);

	let Err(violations) = validation::validate_unsupported_tool_lifecycle(&events, &catalog) else {
		panic!("expected out-of-order lifecycle events to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::ValidationFailed),
		"expected a validation_failed violation for out-of-order lifecycle events, got: {violations}"
	);
}

#[test]
fn forward_artifact_reference_is_rejected_by_raw_event_stream_validator() {
	let mut events = fixtures::raw_events_successful_turn();
	let producer_index = events
		.iter()
		.position(|event| event.artifact.is_some())
		.expect("successful-turn fixture must carry an inline artifact producer event");
	let artifact_id = events[producer_index]
		.entity_ids
		.artifact_id
		.clone()
		.expect("artifact producer event must carry entity_ids.artifact_id");
	assert!(producer_index > 1, "producer must come after the injection point");
	events[1].entity_ids.artifact_id = Some(artifact_id);

	let Err(violations) = validation::validate_raw_event_stream(&events) else {
		panic!("expected a forward artifact reference to be rejected");
	};
	assert!(
		violations
			.violations()
			.iter()
			.any(|v| v.code == ProtocolViolationCode::FutureReference),
		"expected a future_reference violation for a forward artifact reference, got: {violations}"
	);
}
