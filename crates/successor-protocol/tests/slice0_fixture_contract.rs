use std::collections::BTreeSet;

use successor_protocol::{
	canonical_json::{to_canonical_json_bytes, to_canonical_projection_json_bytes},
	error::ProtocolViolationCode,
	fixtures,
	ids::{
		ArtifactId, ErrorId, EventId, MessageId, RequestId, SessionId, SourceEnvelopeId, ToolCallId,
		TurnId,
	},
	kernel_frame::KernelFrameKindV0,
	platform_api::{AssemblePhaseV0, AssemblyResponseV0},
	projection::{SessionProjectionV0, ToolCallStatus},
	provider::ProviderApiShapeV0,
	raw_event::{EntityIdsV0, RawEventType, RawEventV0},
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
	assert_eq!(frames.len(), 11);
	assert_eq!(frames.first().expect("non-empty").kind, KernelFrameKindV0::TurnStarted);
	assert_eq!(
		frames
			.iter()
			.filter(|frame| frame.kind == KernelFrameKindV0::ProviderDelta)
			.count(),
		1
	);
	assert_eq!(frames[9].kind, KernelFrameKindV0::ProviderDelta);
	assert_eq!(frames[10].kind, KernelFrameKindV0::TurnCompleted);
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
	assert_eq!(catalog.tools.len(), 35);
	let executable_count = catalog
		.tools
		.iter()
		.filter(|tool| tool.status == ToolStatusV0::Executable)
		.count();
	assert_eq!(executable_count, 9);
	let stub_rejected_count = catalog
		.tools
		.iter()
		.filter(|tool| tool.status == ToolStatusV0::StubRejected)
		.count();
	assert_eq!(stub_rejected_count, 26);
}

#[test]
fn assemble_response_pre_tool_parses_as_typed_assembly_response() {
	let response = fixtures::assemble_response_pre_tool();
	assert_eq!(response.schema_version, "platform.assembly_response.v0");
	assert_eq!(response.phase, AssemblePhaseV0::PreTool);
	assert!(response.context_items.is_empty());
	assert_eq!(response.degradation.len(), 2);
	assert_eq!(response.degradation[0].code, "embeddings_unavailable");
	assert_eq!(response.degradation[0].severity, "warning");
	assert_eq!(response.degradation[1].code, "no_context");
	assert_eq!(response.degradation[1].severity, "info");

	assert_eq!(response.trace.stages.len(), 1);
	let stage = &response.trace.stages[0];
	assert_eq!(stage.name, "retrieve_recent_sources");
	assert_eq!(stage.started_at, "2026-06-23T12:00:02Z");
	assert_eq!(stage.completed_at, "2026-06-23T12:00:02Z");
	assert_eq!(stage.input_count, 1);
	assert_eq!(stage.output_count, 0);
	assert_eq!(stage.notes, vec!["No prior tool artifacts for this session.".to_owned()]);

	// `DegradationV0` carries `message`/`severity`, not the old `reason` field.
	let value = serde_json::to_value(&response).unwrap();
	assert!(value["degradation"][0].get("reason").is_none());
	assert!(value["degradation"][0].get("message").is_some());
	assert_eq!(serde_json::from_value::<AssemblyResponseV0>(value).unwrap(), response);
}

#[test]
fn assemble_response_post_read_parses_as_typed_assembly_response() {
	let response = fixtures::assemble_response_post_read();
	assert_eq!(response.schema_version, "platform.assembly_response.v0");
	assert_eq!(response.phase, AssemblePhaseV0::PostRead);
	assert_eq!(response.context_items.len(), 1);
	let item = &response.context_items[0];
	assert_eq!(item.source_kind, "tool_result");
	assert!(item.included);
	assert_eq!(item.token_estimate, 32);
	assert_eq!(item.recovery.method, "platform_artifact");
	assert_eq!(response.degradation.len(), 1);
	assert_eq!(response.degradation[0].code, "embeddings_unavailable");

	assert_eq!(response.trace.stages.len(), 1);
	let stage = &response.trace.stages[0];
	assert_eq!(stage.name, "required_sources");
	assert_eq!(stage.started_at, "2026-06-23T12:00:19Z");
	assert_eq!(stage.completed_at, "2026-06-23T12:00:19Z");
	assert_eq!(stage.input_count, 1);
	assert_eq!(stage.output_count, 1);
	assert_eq!(stage.notes, vec!["Included required read artifact.".to_owned()]);

	// `ContextItemV0` carries `source_kind`/`title`/`rendered_text`/`recovery`,
	// not the old `kind`/`content` fields.
	let value = serde_json::to_value(&response).unwrap();
	assert!(value["context_items"][0].get("kind").is_none());
	assert!(value["context_items"][0].get("content").is_none());
	assert!(value["context_items"][0].get("source_kind").is_some());
	assert_eq!(serde_json::from_value::<AssemblyResponseV0>(value).unwrap(), response);
}

#[test]
fn assembly_response_stages_round_trip_typed_parsing_byte_exactly() {
	for response in [fixtures::assemble_response_pre_tool(), fixtures::assemble_response_post_read()]
	{
		let canonical = to_canonical_json_bytes(&response).expect("response must serialize");
		let reparsed: AssemblyResponseV0 =
			serde_json::from_slice(&canonical).expect("canonical bytes must reparse");
		assert_eq!(
			to_canonical_json_bytes(&reparsed).expect("reparsed response must serialize"),
			canonical,
			"a typed round trip must reproduce identical bytes, including trace.stages"
		);
		assert_eq!(reparsed.trace.stages, response.trace.stages);
	}
}

#[test]
fn assembly_trace_stage_rejects_unknown_fields() {
	for response in [fixtures::assemble_response_pre_tool(), fixtures::assemble_response_post_read()]
	{
		let mut value = serde_json::to_value(&response).unwrap();
		value["trace"]["stages"][0]["detail"] = serde_json::json!(null);
		let result: Result<AssemblyResponseV0, _> = serde_json::from_value(value);
		assert!(
			result.is_err(),
			"an unrecognized field on a trace stage must be rejected, not silently dropped"
		);
	}
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
		.find(|tool| tool.name == "ssh")
		.expect("unsupported-tool fixture references the 'ssh' tool");
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

#[test]
fn stale_degradation_reason_field_is_rejected_by_assembly_response_deserializer() {
	let mut value = serde_json::to_value(fixtures::assemble_response_pre_tool()).expect("serialize");
	let degradation = value["degradation"]
		.as_array_mut()
		.expect("degradation array");
	assert!(!degradation.is_empty(), "pre-tool fixture must carry degradation entries");
	degradation[0]["reason"] = serde_json::Value::String("stale".into());
	assert!(
		serde_json::from_value::<AssemblyResponseV0>(value).is_err(),
		"stale degradation reason field must be rejected"
	);
}

#[test]
fn stale_context_item_kind_field_is_rejected_by_assembly_response_deserializer() {
	let mut value =
		serde_json::to_value(fixtures::assemble_response_post_read()).expect("serialize");
	let items = value["context_items"]
		.as_array_mut()
		.expect("context_items array");
	assert!(!items.is_empty(), "post-read fixture must carry context items");
	items[0]["kind"] = serde_json::Value::String("stale".into());
	assert!(
		serde_json::from_value::<AssemblyResponseV0>(value).is_err(),
		"stale context item kind field must be rejected"
	);
}

#[test]
fn credential_like_field_on_assembly_response_root_is_rejected() {
	let mut value = serde_json::to_value(fixtures::assemble_response_pre_tool()).expect("serialize");
	value["api_key"] = serde_json::Value::String("sk-test-not-a-real-key".into());
	assert!(
		serde_json::from_value::<AssemblyResponseV0>(value).is_err(),
		"unknown credential-like root field must be rejected"
	);
}

fn recoverable_failure_session_id() -> SessionId {
	SessionId::try_from("ses_recoverable-failure-test".to_owned()).expect("valid session id")
}

fn recoverable_failure_request_id() -> RequestId {
	RequestId::try_from("req_recoverable-failure-test".to_owned()).expect("valid request id")
}

fn recoverable_failure_turn_id() -> TurnId {
	TurnId::try_from("turn_recoverable-failure-test".to_owned()).expect("valid turn id")
}

fn recoverable_failure_event_id(n: u32) -> EventId {
	EventId::try_from(format!("evt_recoverable-failure-test-{n:02}")).expect("valid event id")
}

fn recoverable_failure_tool_call_id(suffix: &str) -> ToolCallId {
	ToolCallId::try_from(format!("tool_recoverable-failure-test-{suffix}"))
		.expect("valid tool call id")
}

fn recoverable_failure_error_id(suffix: &str) -> ErrorId {
	ErrorId::try_from(format!("err_recoverable-failure-test-{suffix}")).expect("valid error id")
}

fn recoverable_failure_message_id(n: u32) -> MessageId {
	MessageId::try_from(format!("msg_recoverable-failure-test-{n:02}")).expect("valid message id")
}

fn recoverable_failure_source_envelope_id(n: u32) -> successor_protocol::ids::SourceEnvelopeId {
	SourceEnvelopeId::try_from(format!("src_recoverable-failure-test-{n:02}"))
		.expect("valid source envelope id")
}

fn recoverable_failure_artifact_id() -> ArtifactId {
	ArtifactId::try_from("art_recoverable-failure-test".to_owned()).expect("valid artifact id")
}

/// Builds one raw event for the recoverable-failure test streams below.
/// `occurred_at` and `idempotency_key` are fixed since the projection under
/// test never inspects them.
fn recoverable_failure_event(
	seq: u64,
	event_type: RawEventType,
	causation: Option<EventId>,
	entity_ids: EntityIdsV0,
	payload: serde_json::Value,
) -> RawEventV0 {
	let mut event = RawEventV0::new(
		recoverable_failure_session_id(),
		recoverable_failure_event_id(seq as u32),
		event_type,
		seq,
		format!("idem-{seq:02}"),
		recoverable_failure_request_id(),
		recoverable_failure_turn_id(),
		payload,
		"2026-01-01T00:00:00Z",
	);
	event.causation_event_id = causation;
	event.entity_ids = entity_ids;
	event
}

/// A minimal, complete recoverable-executor-failure raw-event stream:
/// `tool_call.requested` -> `tool_call.started` -> `error.recorded` ->
/// `tool_call.failed`, bracketed by a user turn and an assistant turn so
/// the projection also has a transcript and a `last_assistant_summary`.
fn recoverable_failure_events() -> Vec<RawEventV0> {
	let tool_call = recoverable_failure_tool_call_id("a");
	let error = recoverable_failure_error_id("a");

	let user_turn = recoverable_failure_event(
		1,
		RawEventType::UserTurnRecorded,
		None,
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(1)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(1)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "run the flaky tool" }),
	);
	let requested = recoverable_failure_event(
		2,
		RawEventType::ToolCallRequested,
		Some(user_turn.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "flaky_tool" }),
	);
	let started = recoverable_failure_event(
		3,
		RawEventType::ToolCallStarted,
		Some(requested.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({}),
	);
	let error_recorded = recoverable_failure_event(
		4,
		RawEventType::ErrorRecorded,
		Some(started.event_id.clone()),
		EntityIdsV0 {
			tool_call_id: Some(tool_call.clone()),
			error_id: Some(error.clone()),
			..EntityIdsV0::default()
		},
		serde_json::json!({
			"schema_version": "platform.error.v0",
			"error_id": error.as_str(),
			"code": "executor_timeout",
			"message": "executor timed out after 30s",
			"recoverable": true,
			"retryable": false,
			"correlation_id": recoverable_failure_request_id().as_str(),
			"details": { "failure_class": "executor_timeout", "tool_name": "flaky_tool" },
		}),
	);
	let failed = recoverable_failure_event(
		5,
		RawEventType::ToolCallFailed,
		Some(error_recorded.event_id.clone()),
		EntityIdsV0 {
			tool_call_id: Some(tool_call),
			error_id: Some(error.clone()),
			..EntityIdsV0::default()
		},
		serde_json::json!({
			"status": "failed",
			"tool_name": "flaky_tool",
			"error_id": error.as_str(),
			"code": "executor_timeout",
			"message": "executor timed out after 30s",
		}),
	);
	let assistant_turn = recoverable_failure_event(
		6,
		RawEventType::AssistantTurnRecorded,
		Some(failed.event_id.clone()),
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(2)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(2)),
			..EntityIdsV0::default()
		},
		serde_json::json!({
			"text": "the flaky tool failed and could not be retried in this turn",
			"summary": "flaky_tool failed",
		}),
	);

	vec![user_turn, requested, started, error_recorded, failed, assistant_turn]
}

#[test]
fn recoverable_tool_failure_projects_one_failed_tool_and_one_typed_error() {
	let events = recoverable_failure_events();
	let projection =
		project_session(&events).expect("a valid recoverable-failure chain must project cleanly");

	assert_eq!(projection.tools.len(), 1, "exactly one tool call row expected");
	let tool = &projection.tools[0];
	assert_eq!(tool.status, ToolCallStatus::Failed);
	assert!(tool.result_event_id.is_none());
	assert!(tool.completed_event_id.is_none());
	assert!(tool.artifact_id.is_none());
	assert!(tool.started_event_id.is_some());
	assert!(tool.error_event_id.is_some());
	assert!(tool.failed_event_id.is_some());
	assert!(tool.error_id.is_some());

	assert_eq!(projection.errors.len(), 1, "exactly one typed error row expected");
	let error = &projection.errors[0];
	assert_eq!(error.tool_call_id, tool.tool_call_id);
	assert_eq!(error.error_id, tool.error_id.clone().expect("failed row carries error_id"));
	assert_eq!(error.code, "executor_timeout");
	assert!(error.recoverable);
	assert!(!error.retryable);

	assert!(projection.artifacts.is_empty(), "a failed dispatch must never create an artifact");

	let bytes =
		to_canonical_projection_json_bytes(&projection).expect("canonical projection must serialize");
	let text = String::from_utf8(bytes).expect("canonical projection bytes must be utf8");
	assert!(text.contains("\"status\": \"failed\""));
	assert!(text.contains("\"recoverable\": true"));
	assert!(text.contains("\"retryable\": false"));
	let reparsed: SessionProjectionV0 =
		serde_json::from_str(&text).expect("canonical projection bytes must parse back");
	assert_eq!(reparsed, projection);
}

#[test]
fn error_recorded_without_failed_at_end_of_stream_is_rejected() {
	let tool_call = recoverable_failure_tool_call_id("error-only");
	let user_turn = recoverable_failure_event(
		1,
		RawEventType::UserTurnRecorded,
		None,
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(1)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(1)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "run the flaky tool" }),
	);
	let requested = recoverable_failure_event(
		2,
		RawEventType::ToolCallRequested,
		Some(user_turn.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "flaky_tool" }),
	);
	let started = recoverable_failure_event(
		3,
		RawEventType::ToolCallStarted,
		Some(requested.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({}),
	);
	let error_recorded = recoverable_failure_event(
		4,
		RawEventType::ErrorRecorded,
		Some(started.event_id.clone()),
		EntityIdsV0 {
			tool_call_id: Some(tool_call),
			error_id: Some(recoverable_failure_error_id("error-only")),
			..EntityIdsV0::default()
		},
		serde_json::json!({
			"schema_version": "platform.error.v0",
			"error_id": recoverable_failure_error_id("error-only").as_str(),
			"code": "executor_timeout",
			"message": "executor timed out after 30s",
			"recoverable": true,
			"retryable": false,
			"correlation_id": recoverable_failure_request_id().as_str(),
			"details": {},
		}),
	);
	// No tool_call.failed: the chain never reaches a terminal state. The
	// trailing assistant turn keeps every *other* invariant satisfied so
	// this test isolates the end-of-stream terminal-state check.
	let assistant_turn = recoverable_failure_event(
		5,
		RawEventType::AssistantTurnRecorded,
		Some(error_recorded.event_id.clone()),
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(2)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(2)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "still waiting on the flaky tool", "summary": "pending" }),
	);

	let events = vec![user_turn, requested, started, error_recorded, assistant_turn];
	let err = project_session(&events)
		.expect_err("an error.recorded chain without a terminal tool_call.failed must be rejected");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn tool_call_requested_only_is_rejected_by_project_session() {
	let tool_call = recoverable_failure_tool_call_id("requested-only");
	let user_turn = recoverable_failure_event(
		1,
		RawEventType::UserTurnRecorded,
		None,
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(1)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(1)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "queue a tool" }),
	);
	let requested = recoverable_failure_event(
		2,
		RawEventType::ToolCallRequested,
		Some(user_turn.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "queued_tool" }),
	);
	let assistant_turn = recoverable_failure_event(
		3,
		RawEventType::AssistantTurnRecorded,
		Some(requested.event_id.clone()),
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(2)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(2)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "still queued", "summary": "pending" }),
	);

	let events = vec![user_turn, requested, assistant_turn];
	let err = project_session(&events)
		.expect_err("a requested-only tool call must never reach a terminal state");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn tool_call_started_only_is_rejected_by_project_session() {
	let tool_call = recoverable_failure_tool_call_id("started-only");
	let user_turn = recoverable_failure_event(
		1,
		RawEventType::UserTurnRecorded,
		None,
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(1)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(1)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "start a tool" }),
	);
	let requested = recoverable_failure_event(
		2,
		RawEventType::ToolCallRequested,
		Some(user_turn.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "stalled_tool" }),
	);
	let started = recoverable_failure_event(
		3,
		RawEventType::ToolCallStarted,
		Some(requested.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call), ..EntityIdsV0::default() },
		serde_json::json!({}),
	);
	let assistant_turn = recoverable_failure_event(
		4,
		RawEventType::AssistantTurnRecorded,
		Some(started.event_id.clone()),
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(2)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(2)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "still running", "summary": "pending" }),
	);

	let events = vec![user_turn, requested, started, assistant_turn];
	let err = project_session(&events)
		.expect_err("a started-only tool call must never reach a terminal state");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn tool_result_without_completed_is_rejected_by_project_session() {
	let tool_call = recoverable_failure_tool_call_id("result-only");
	let user_turn = recoverable_failure_event(
		1,
		RawEventType::UserTurnRecorded,
		None,
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(1)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(1)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "run a tool" }),
	);
	let requested = recoverable_failure_event(
		2,
		RawEventType::ToolCallRequested,
		Some(user_turn.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "stable_tool" }),
	);
	let started = recoverable_failure_event(
		3,
		RawEventType::ToolCallStarted,
		Some(requested.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_call.clone()), ..EntityIdsV0::default() },
		serde_json::json!({}),
	);
	let result = recoverable_failure_event(
		4,
		RawEventType::ToolResultRecorded,
		Some(started.event_id.clone()),
		EntityIdsV0 {
			tool_call_id: Some(tool_call),
			artifact_id: Some(recoverable_failure_artifact_id()),
			..EntityIdsV0::default()
		},
		serde_json::json!({}),
	);
	let assistant_turn = recoverable_failure_event(
		5,
		RawEventType::AssistantTurnRecorded,
		Some(result.event_id.clone()),
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(2)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(2)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "result received, not yet completed", "summary": "pending" }),
	);

	let events = vec![user_turn, requested, started, result, assistant_turn];
	let err = project_session(&events)
		.expect_err("a result-without-completed tool call must never reach a terminal state");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn tool_result_followed_by_error_and_failed_is_rejected_by_project_session() {
	let mut events = recoverable_failure_events();
	let tool_call_id = events[1]
		.entity_ids
		.tool_call_id
		.clone()
		.expect("requested event has tool call id");
	let started_event_id = events[2].event_id.clone();
	for event in &mut events[3..] {
		event.session_seq += 1;
	}
	let mut result = recoverable_failure_event(
		99,
		RawEventType::ToolResultRecorded,
		Some(started_event_id),
		EntityIdsV0 {
			tool_call_id: Some(tool_call_id),
			artifact_id: Some(recoverable_failure_artifact_id()),
			..EntityIdsV0::default()
		},
		serde_json::json!({}),
	);
	result.session_seq = 4;
	events.insert(3, result);

	let err = project_session(&events)
		.expect_err("a tool call cannot transition to failed after recording a successful result");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn error_followed_by_result_and_completed_is_rejected_by_project_session() {
	let mut events = recoverable_failure_events();
	let tool_call_id = events[1]
		.entity_ids
		.tool_call_id
		.clone()
		.expect("requested event has tool call id");
	let started_event_id = events[2].event_id.clone();
	events.remove(4);
	let artifact_id = recoverable_failure_artifact_id();
	let mut result = recoverable_failure_event(
		99,
		RawEventType::ToolResultRecorded,
		Some(started_event_id),
		EntityIdsV0 {
			tool_call_id: Some(tool_call_id.clone()),
			artifact_id: Some(artifact_id.clone()),
			..EntityIdsV0::default()
		},
		serde_json::json!({}),
	);
	result.session_seq = 5;
	let mut completed = recoverable_failure_event(
		100,
		RawEventType::ToolCallCompleted,
		Some(result.event_id.clone()),
		EntityIdsV0 {
			tool_call_id: Some(tool_call_id),
			artifact_id: Some(artifact_id),
			..EntityIdsV0::default()
		},
		serde_json::json!({}),
	);
	completed.session_seq = 6;
	events[4].session_seq = 7;
	events[4].causation_event_id = Some(completed.event_id.clone());
	events.insert(4, result);
	events.insert(5, completed);

	let err = project_session(&events)
		.expect_err("a tool call cannot transition to successful after recording an error");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn tool_call_failed_with_wrong_causation_is_rejected() {
	let mut events = recoverable_failure_events();
	// events[4] is tool_call.failed; rewrite its causation to point at
	// tool_call.started (events[2]) instead of error.recorded (events[3]).
	events[4].causation_event_id = Some(events[2].event_id.clone());
	let err =
		project_session(&events).expect_err("tool_call.failed with wrong causation must be rejected");
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn tool_call_failed_with_mismatched_error_id_is_rejected() {
	let mut events = recoverable_failure_events();
	events[4].entity_ids.error_id = Some(recoverable_failure_error_id("mismatched"));
	let err = project_session(&events).expect_err(
		"tool_call.failed with an error_id that does not match error.recorded must be rejected",
	);
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn error_recorded_with_causation_from_a_different_tool_call_is_rejected() {
	let tool_a = recoverable_failure_tool_call_id("cross-a");
	let tool_b = recoverable_failure_tool_call_id("cross-b");

	let user_turn = recoverable_failure_event(
		1,
		RawEventType::UserTurnRecorded,
		None,
		EntityIdsV0 {
			message_id: Some(recoverable_failure_message_id(1)),
			source_envelope_id: Some(recoverable_failure_source_envelope_id(1)),
			..EntityIdsV0::default()
		},
		serde_json::json!({ "text": "run two tools" }),
	);
	let requested_a = recoverable_failure_event(
		2,
		RawEventType::ToolCallRequested,
		Some(user_turn.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_a.clone()), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "tool_a" }),
	);
	let started_a = recoverable_failure_event(
		3,
		RawEventType::ToolCallStarted,
		Some(requested_a.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_a.clone()), ..EntityIdsV0::default() },
		serde_json::json!({}),
	);
	let requested_b = recoverable_failure_event(
		4,
		RawEventType::ToolCallRequested,
		Some(started_a.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_b.clone()), ..EntityIdsV0::default() },
		serde_json::json!({ "tool_name": "tool_b" }),
	);
	let started_b = recoverable_failure_event(
		5,
		RawEventType::ToolCallStarted,
		Some(requested_b.event_id.clone()),
		EntityIdsV0 { tool_call_id: Some(tool_b), ..EntityIdsV0::default() },
		serde_json::json!({}),
	);
	// error.recorded for tool_a but causally chained to tool_b's
	// tool_call.started instead of tool_a's own.
	let error_recorded = recoverable_failure_event(
		6,
		RawEventType::ErrorRecorded,
		Some(started_b.event_id.clone()),
		EntityIdsV0 {
			tool_call_id: Some(tool_a),
			error_id: Some(recoverable_failure_error_id("cross")),
			..EntityIdsV0::default()
		},
		serde_json::json!({
			"schema_version": "platform.error.v0",
			"error_id": recoverable_failure_error_id("cross").as_str(),
			"code": "executor_timeout",
			"message": "executor timed out after 30s",
			"recoverable": true,
			"retryable": false,
			"correlation_id": recoverable_failure_request_id().as_str(),
			"details": {},
		}),
	);

	let events = vec![user_turn, requested_a, started_a, requested_b, started_b, error_recorded];
	let err = project_session(&events).expect_err(
		"error.recorded causally chained to a different tool call's started event must be rejected",
	);
	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}
