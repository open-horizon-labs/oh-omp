use serde_json::json;
use successor_protocol::{
	ids::{
		ArtifactId, AssembleId, ContextItemId, EventId, FrameId, RequestId, SessionId,
		SourceEnvelopeId, TraceId, TurnId,
	},
	kernel_frame::{
		KERNEL_FRAME_SCHEMA_VERSION, KERNEL_FRAME_SSE_EVENT_NAME, KernelFrameKindV0, KernelFrameV0,
	},
	platform_api::{
		ASSEMBLE_REQUEST_SCHEMA_VERSION, ASSEMBLY_RESPONSE_SCHEMA_VERSION, AssembleIntentV0,
		AssemblePhaseV0, AssembleRequestV0, AssembleWorkspaceV0, AssemblyBudgetV0,
		AssemblyResponseV0, AssemblyTraceV0, CreatedByV0, EVENT_PAGE_SCHEMA_VERSION, EventPageV0,
		PolicyV0, RawEventAppendRequestV0, RawEventAppendResponseV0, SESSION_SNAPSHOT_SCHEMA_VERSION,
		SessionSnapshotV0, SharingV0, WorkspaceV0,
	},
	raw_event::{EntityIdsV0, RawEventProducerV0, RawEventType, RedactionLevelV0, VisibilityV0},
	tool_catalog::{TOOL_CATALOG_SCHEMA_VERSION, ToolCatalogV0, ToolStatusV0},
};

fn frame_id() -> FrameId {
	FrameId::try_from("frame_test".to_owned()).unwrap()
}

fn session_id() -> SessionId {
	SessionId::try_from("ses_test".to_owned()).unwrap()
}

fn turn_id() -> TurnId {
	TurnId::try_from("turn_test".to_owned()).unwrap()
}

fn request_id() -> RequestId {
	RequestId::try_from("req_test".to_owned()).unwrap()
}

fn event_id() -> EventId {
	EventId::try_from("evt_test".to_owned()).unwrap()
}

fn source_envelope_id() -> SourceEnvelopeId {
	SourceEnvelopeId::try_from("src_test".to_owned()).unwrap()
}

fn artifact_id() -> ArtifactId {
	ArtifactId::try_from("art_test".to_owned()).unwrap()
}

fn assemble_id() -> AssembleId {
	AssembleId::try_from("asm_test".to_owned()).unwrap()
}

fn trace_id() -> TraceId {
	TraceId::try_from("trace_test".to_owned()).unwrap()
}

fn context_item_id() -> ContextItemId {
	ContextItemId::try_from("ctx_test".to_owned()).unwrap()
}

#[test]
fn kernel_frame_schema_and_sse_constants_are_stable() {
	assert_eq!(KERNEL_FRAME_SCHEMA_VERSION, "kernel.frame.v0");
	assert_eq!(KERNEL_FRAME_SSE_EVENT_NAME, "kernel_frame");
}

#[test]
fn kernel_frame_serialized_field_names_match_contract() {
	let frame = KernelFrameV0::new(
		frame_id(),
		1,
		session_id(),
		turn_id(),
		request_id(),
		KernelFrameKindV0::TurnStarted,
		"2026-06-23T12:00:00Z",
		json!({ "phase": "pre_tool" }),
	);

	let value = serde_json::to_value(&frame).unwrap();
	assert_eq!(value["schema_version"], "kernel.frame.v0");
	assert_eq!(value["kind"], "turn_started");
	assert_eq!(value["ts"], "2026-06-23T12:00:00Z");
	assert!(value.get("frame_kind").is_none());
	assert!(value.get("occurred_at").is_none());
	assert!(value.get("payload").is_some());
}

#[test]
fn kernel_frame_kind_serializes_as_contract_underscore_strings() {
	let cases = [
		(KernelFrameKindV0::TurnStarted, "turn_started"),
		(KernelFrameKindV0::RawEventAppendStarted, "raw_event_append_started"),
		(KernelFrameKindV0::RawEventAppended, "raw_event_appended"),
		(KernelFrameKindV0::PlatformAssembleStarted, "platform_assemble_started"),
		(KernelFrameKindV0::PlatformAssembleCompleted, "platform_assemble_completed"),
		(KernelFrameKindV0::ProviderRequestBuilt, "provider_request_built"),
		(KernelFrameKindV0::ProviderDelta, "provider_delta"),
		(KernelFrameKindV0::ToolCallRequested, "tool_call_requested"),
		(KernelFrameKindV0::ToolCallStarted, "tool_call_started"),
		(KernelFrameKindV0::ToolCallCompleted, "tool_call_completed"),
		(KernelFrameKindV0::ToolCallRejected, "tool_call_rejected"),
		(KernelFrameKindV0::TurnCompleted, "turn_completed"),
		(KernelFrameKindV0::TurnFailed, "turn_failed"),
	];

	for (kind, expected) in cases {
		assert_eq!(serde_json::to_value(&kind).unwrap(), expected);
		assert_eq!(kind.as_str(), expected);
	}
}

#[test]
fn kernel_frame_raw_event_reference_sets_both_contract_fields() {
	let frame = KernelFrameV0::new(
		frame_id(),
		2,
		session_id(),
		turn_id(),
		request_id(),
		KernelFrameKindV0::RawEventAppended,
		"2026-06-23T12:00:01Z",
		json!({}),
	)
	.with_raw_event(event_id(), 42);

	let value = serde_json::to_value(&frame).unwrap();
	assert_eq!(value["raw_event_id"], "evt_test");
	assert_eq!(value["raw_event_session_seq"], 42);
	assert!(frame.validate_dto().is_empty());
}

#[test]
fn kernel_frame_dto_validation_detects_unpaired_raw_event_reference() {
	let frame = KernelFrameV0::new(
		frame_id(),
		3,
		session_id(),
		turn_id(),
		request_id(),
		KernelFrameKindV0::RawEventAppended,
		"2026-06-23T12:00:01Z",
		json!({}),
	)
	.with_raw_event_id(event_id());

	assert_eq!(frame.validate_dto().len(), 1);
}

#[test]
fn create_session_request_matches_contract_shape() {
	let request = successor_protocol::platform_api::CreateSessionRequestV0 {
		workspace:  WorkspaceV0 {
			id:        "workspace_oh_omp".to_owned(),
			label:     "oh-oh-my-pi".to_owned(),
			root_hint: "/tmp/oh-oh-my-pi".to_owned(),
		},
		title:      "Read-only coding Q&A".to_owned(),
		created_by: CreatedByV0 {
			client_kind: "kernel".to_owned(),
			client_id:   "local-dev-kernel".to_owned(),
		},
	};

	let value = serde_json::to_value(&request).unwrap();
	assert_eq!(value["workspace"]["id"], "workspace_oh_omp");
	assert_eq!(value["title"], "Read-only coding Q&A");
	assert_eq!(value["created_by"]["client_kind"], "kernel");
	assert!(value.get("label").is_none());
	assert!(value.get("metadata").is_none());
}

#[test]
fn append_request_omits_platform_assigned_session_seq() {
	let request = RawEventAppendRequestV0 {
		schema_version:     "platform.raw_event.v0".to_owned(),
		event_id:           event_id(),
		idempotency_key:    "idem_test".to_owned(),
		event_type:         RawEventType::UserTurnRecorded,
		session_id:         session_id(),
		turn_id:            Some(turn_id()),
		request_id:         request_id(),
		occurred_at:        "2026-06-23T12:00:00Z".to_owned(),
		producer:           RawEventProducerV0::default(),
		causation_event_id: None,
		correlation_id:     request_id(),
		entity_ids:         EntityIdsV0::default(),
		visibility:         VisibilityV0::default(),
		redaction:          RedactionLevelV0::Sensitive,
		payload:            json!({}),
		artifact:           None,
	};

	let value = serde_json::to_value(&request).unwrap();
	assert_eq!(value["schema_version"], "platform.raw_event.v0");
	assert_eq!(value["request_id"], "req_test");
	assert_eq!(value["correlation_id"], "req_test");
	assert_eq!(value["turn_id"], "turn_test");
	assert!(value.get("session_seq").is_none());
}

#[test]
fn append_request_deserialize_rejects_null_turn_for_turn_scoped_events() {
	let value = json!({
		 "schema_version": "platform.raw_event.v0",
		 "event_id": "evt_test",
		 "idempotency_key": "idem_test",
		 "event_type": "user_turn.recorded",
		 "session_id": "ses_test",
		 "turn_id": null,
		 "request_id": "req_test",
		 "occurred_at": "2026-01-01T00:00:00Z",
		 "producer": { "kind": "kernel", "id": "local-dev-kernel" },
		 "causation_event_id": null,
		 "correlation_id": "req_test",
		 "entity_ids": { "context_item_ids": [] },
		 "visibility": {
			  "model": true,
			  "transcript": true,
			  "recall": true,
			  "assemble": true,
			  "share": false,
			  "debug": true
		 },
		 "redaction": "sensitive",
		 "payload": { "text": "hello" },
		 "artifact": null
	});

	let result = serde_json::from_value::<RawEventAppendRequestV0>(value);
	assert!(
		result.is_err(),
		"turn-scoped append requests must reject null turn_id at deserialization"
	);
}

#[test]
fn append_request_deserialize_rejects_platform_assigned_session_seq() {
	let value = json!({
		 "schema_version": "platform.raw_event.v0",
		 "event_id": "evt_test",
		 "session_seq": 42,
		 "idempotency_key": "idem_test",
		 "event_type": "user_turn.recorded",
		 "session_id": "ses_test",
		 "turn_id": "turn_test",
		 "request_id": "req_test",
		 "occurred_at": "2026-01-01T00:00:00Z",
		 "producer": { "kind": "kernel", "id": "local-dev-kernel" },
		 "causation_event_id": null,
		 "correlation_id": "req_test",
		 "entity_ids": { "context_item_ids": [] },
		 "visibility": { "model": true, "transcript": true, "recall": true, "assemble": true, "share": false, "debug": true },
		 "redaction": "sensitive",
		 "payload": { "text": "hello" },
		 "artifact": null
	});

	let result = serde_json::from_value::<RawEventAppendRequestV0>(value);
	assert!(result.is_err(), "append requests must reject platform-assigned session_seq");
}

#[test]
fn append_request_deserialize_rejects_invalid_schema_and_empty_idempotency_key() {
	let mut value = json!({
		 "schema_version": "wrong.raw_event.v0",
		 "event_id": "evt_test",
		 "idempotency_key": "idem_test",
		 "event_type": "user_turn.recorded",
		 "session_id": "ses_test",
		 "turn_id": "turn_test",
		 "request_id": "req_test",
		 "occurred_at": "2026-01-01T00:00:00Z",
		 "producer": { "kind": "kernel", "id": "local-dev-kernel" },
		 "causation_event_id": null,
		 "correlation_id": "req_test",
		 "entity_ids": { "context_item_ids": [] },
		 "visibility": { "model": true, "transcript": true, "recall": true, "assemble": true, "share": false, "debug": true },
		 "redaction": "sensitive",
		 "payload": { "text": "hello" },
		 "artifact": null
	});

	assert!(
		serde_json::from_value::<RawEventAppendRequestV0>(value.clone()).is_err(),
		"append requests must reject invalid schema_version"
	);

	value["schema_version"] = json!("platform.raw_event.v0");
	value["idempotency_key"] = json!("");
	assert!(
		serde_json::from_value::<RawEventAppendRequestV0>(value).is_err(),
		"append requests must reject empty idempotency_key"
	);
}

#[test]
fn append_response_matches_contract_shape_and_optional_ids() {
	let response = RawEventAppendResponseV0 {
		event_id:           event_id(),
		session_seq:        42,
		duplicate:          false,
		stored_at:          "2026-06-23T12:00:01Z".to_owned(),
		source_envelope_id: Some(source_envelope_id()),
		artifact_id:        Some(artifact_id()),
	};

	let value = serde_json::to_value(&response).unwrap();
	assert_eq!(value["event_id"], "evt_test");
	assert_eq!(value["session_seq"], 42);
	assert_eq!(value["duplicate"], false);
	assert_eq!(value["stored_at"], "2026-06-23T12:00:01Z");
	assert_eq!(value["source_envelope_id"], "src_test");
	assert_eq!(value["artifact_id"], "art_test");
}

#[test]
fn event_page_matches_contract_pagination_fields() {
	let page = EventPageV0::new(session_id(), Vec::new(), 42, false);
	let value = serde_json::to_value(&page).unwrap();

	assert_eq!(value["schema_version"], EVENT_PAGE_SCHEMA_VERSION);
	assert_eq!(value["session_id"], "ses_test");
	assert_eq!(value["events"].as_array().unwrap().len(), 0);
	assert_eq!(value["next_after_seq"], 42);
	assert_eq!(value["has_more"], false);
	assert!(value.get("next_cursor").is_none());
	assert!(value.get("total_count").is_none());
}

#[test]
fn session_snapshot_is_projection_summary_not_embedded_events() {
	let mut snapshot = SessionSnapshotV0::new(
		session_id(),
		"2026-06-23T12:00:00Z",
		"2026-06-23T12:05:00Z",
		20,
		turn_id(),
		SharingV0::private(),
	);
	snapshot.raw_event_ids.push(event_id());
	snapshot.source_envelope_ids.push(source_envelope_id());
	snapshot.artifact_ids.push(artifact_id());
	snapshot.assemble_ids.push(assemble_id());
	snapshot.last_assistant_summary = Some("summary".to_owned());

	let value = serde_json::to_value(&snapshot).unwrap();
	assert_eq!(value["schema_version"], SESSION_SNAPSHOT_SCHEMA_VERSION);
	assert_eq!(value["last_raw_event_seq"], 20);
	assert_eq!(value["raw_event_ids"], json!(["evt_test"]));
	assert_eq!(value["sharing"]["visibility"], "private");
	assert!(value.get("events").is_none());
}

#[test]
fn assemble_phase_uses_contract_strings() {
	let cases = [
		(AssemblePhaseV0::PreTool, "pre_tool"),
		(AssemblePhaseV0::PostLocator, "post_locator"),
		(AssemblePhaseV0::PostRead, "post_read"),
		(AssemblePhaseV0::Final, "final"),
	];

	for (phase, expected) in cases {
		assert_eq!(serde_json::to_value(phase).unwrap(), expected);
		assert_eq!(phase.as_str(), expected);
	}
}

#[test]
fn assemble_request_matches_contract_and_omits_old_fields() {
	let request = AssembleRequestV0::new(
		session_id(),
		turn_id(),
		request_id(),
		AssemblePhaseV0::PreTool,
		AssembleIntentV0 {
			query:         "concept graph resolver".to_owned(),
			raw_user_text: "find context".to_owned(),
			confidence:    "explicit".to_owned(),
		},
		AssembleWorkspaceV0 {
			root_hint: "/tmp/oh-oh-my-pi".to_owned(),
			repo_id:   "oh-oh-my-pi".to_owned(),
		},
		AssemblyBudgetV0 { max_context_tokens: 12_000, max_items: 20 },
	);

	let value = serde_json::to_value(&request).unwrap();
	assert_eq!(value["schema_version"], ASSEMBLE_REQUEST_SCHEMA_VERSION);
	assert_eq!(value["phase"], "pre_tool");
	assert_eq!(value["intent"]["confidence"], "explicit");
	assert_eq!(value["workspace"]["repo_id"], "oh-oh-my-pi");
	assert_eq!(value["budget"]["max_context_tokens"], 12_000);
	assert_eq!(value["required_source_envelope_ids"], json!([]));
	assert_eq!(value["exclude_source_envelope_ids"], json!([]));
	assert!(value.get("candidate_item_ids").is_none());
	assert!(value.get("token_budget").is_none());
	assert!(value.get("hints").is_none());
}

#[test]
fn assembly_response_matches_contract_and_has_no_provider_messages() {
	let trace = AssemblyTraceV0 {
		trace_id:           trace_id(),
		assemble_id:        assemble_id(),
		query:              "concept graph resolver".to_owned(),
		projection_version: "slice0.projection.v0".to_owned(),
		stages:             Vec::new(),
		dropped:            Vec::new(),
	};
	let response = AssemblyResponseV0::new(
		assemble_id(),
		session_id(),
		turn_id(),
		request_id(),
		AssemblePhaseV0::PreTool,
		"2026-06-23T12:00:02Z",
		trace,
		PolicyV0 {
			enabled_sources:  vec!["user_turn".to_owned(), "tool_result".to_owned()],
			disabled_sources: Vec::new(),
			weights:          json!({}),
		},
	);

	let value = serde_json::to_value(&response).unwrap();
	assert_eq!(value["schema_version"], ASSEMBLY_RESPONSE_SCHEMA_VERSION);
	assert_eq!(value["phase"], "pre_tool");
	assert_eq!(value["created_at"], "2026-06-23T12:00:02Z");
	assert_eq!(value["context_items"], json!([]));
	assert_eq!(value["trace"]["projection_version"], "slice0.projection.v0");
	assert_eq!(value["degradation"], json!([]));
	assert_eq!(value["policy"]["enabled_sources"], json!(["user_turn", "tool_result"]));
	assert!(value.get("provider_messages").is_none());
	assert!(value.get("items").is_none());
	assert!(value.get("degradations").is_none());
	assert!(value.get("assembled_at").is_none());
	assert!(value.get("trace_id").is_none());
}

#[test]
fn tool_status_serializes_contract_values() {
	assert_eq!(serde_json::to_value(ToolStatusV0::Executable).unwrap(), "executable");
	assert_eq!(serde_json::to_value(ToolStatusV0::StubRejected).unwrap(), "stub_rejected");
	assert_eq!(ToolStatusV0::StubRejected.as_str(), "stub_rejected");
}

#[test]
fn tool_catalog_matches_canonical_fixture_shape() {
	let fixture = include_str!(
		"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/tool-catalog.json"
	);
	let fixture_value: serde_json::Value = serde_json::from_str(fixture).unwrap();
	let catalog: ToolCatalogV0 = serde_json::from_str(fixture).unwrap();
	let serialized = serde_json::to_value(&catalog).unwrap();

	assert_eq!(catalog.schema_version, TOOL_CATALOG_SCHEMA_VERSION);
	assert_eq!(catalog.schema_version, "kernel.tool_catalog.v0");
	assert_eq!(catalog.catalog_id, "catalog_00000000-0000-4000-8000-000000000001");
	assert_eq!(catalog.projection_version, "slice0.projection.v0");
	assert_eq!(catalog.tools.len(), 35);
	assert_eq!(catalog.tools[0].name, "search_files");
	assert_eq!(catalog.tools[0].category, "safe_read_discovery");
	assert_eq!(catalog.tools[0].status, ToolStatusV0::Executable);
	assert_eq!(catalog.tools[5].name, "ast_grep");
	assert_eq!(catalog.tools[5].status, ToolStatusV0::Executable);
	assert_eq!(catalog.tools[6].name, "ast_edit");
	assert_eq!(catalog.tools[6].status, ToolStatusV0::StubRejected);
	assert_eq!(catalog.tools[7].name, "lsp");
	assert_eq!(catalog.tools[7].status, ToolStatusV0::StubRejected);
	assert_eq!(catalog.tools[8].name, "edit");
	assert_eq!(catalog.tools[8].status, ToolStatusV0::Executable);
	assert_eq!(catalog.tools[9].name, "write");
	assert_eq!(catalog.tools[9].status, ToolStatusV0::Executable);
	assert_eq!(catalog.tools[11].name, "bash");
	assert_eq!(catalog.tools[11].status, ToolStatusV0::Executable);
	assert_eq!(catalog.tools[13].name, "ssh");
	assert_eq!(catalog.tools[13].status, ToolStatusV0::StubRejected);
	assert_eq!(serialized, fixture_value);
	assert!(serialized.get("session_id").is_none());
	assert!(serialized.get("tool_count").is_none());
	assert!(serialized.get("metadata").is_none());
	assert!(serialized["tools"][5].get("input_schema").is_some());
	assert!(serialized["tools"][8].get("input_schema").is_some());
	assert!(serialized["tools"][9].get("input_schema").is_some());
	assert!(serialized["tools"][11].get("input_schema").is_some());
	assert!(serialized["tools"][6].get("input_schema").is_none());
	assert!(serialized["tools"][13].get("input_schema").is_none());
}

#[test]
fn context_item_id_helper_is_available_for_assemble_context_items() {
	assert_eq!(context_item_id().as_str(), "ctx_test");
}
