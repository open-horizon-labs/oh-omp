use std::collections::HashSet;

use serde_json::json;
use successor_context_platform::{
	artifacts::SqliteArtifactStore, assembly::AssemblyServiceV0, sqlite::SqliteAppendStore,
	store::RawEventAppendStore,
};
use successor_protocol::{
	artifact::{ArtifactHash, ArtifactV0},
	ids::{ArtifactId, EventId, RequestId, SessionId, SourceEnvelopeId, ToolCallId, TurnId},
	platform_api::{
		AssembleIntentV0, AssemblePhaseV0, AssembleRequestV0, AssembleWorkspaceV0, AssemblyBudgetV0,
		ContextItemV0, CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0,
	},
	raw_event::{
		EntityIdsV0, RawEventArtifactRef, RawEventProducerV0, RawEventType, RedactionLevelV0,
		VisibilityV0,
	},
};

const WORKSPACE_ID: &str = "ws-long-context-main";
const OTHER_WORKSPACE_ID: &str = "ws-long-context-other";
const CURRENT_BYTES: &str =
	"current bytes contain F4_CURRENT_ALPHA_SENTINEL and fresh implementation";
const STALE_BYTES: &str = "stale bytes contain F4_STALE_ALPHA_SENTINEL and obsolete implementation";
const RELEVANT_TOOL_SENTINEL: &str = "F4_RELEVANT_PRIOR_TOOL_SENTINEL";
const USER_TURN_SENTINEL: &str = "F4_UNRELATED_USER_TURN_SENTINEL";
const ARTIFACT_LEXICAL_SENTINEL: &str = "F4_ARTIFACT_LEXICAL_COLLISION_SENTINEL";
const CURRENT_TURN_SENTINEL: &str = "F4_CURRENT_TURN_SENTINEL";
const OTHER_SESSION_SENTINEL: &str = "F4_OTHER_SESSION_SENTINEL";

#[derive(Clone, Copy)]
enum EventKind {
	ToolResult,
	UserTurn,
	AssistantTurn,
}

struct TempDbPath(String);

impl TempDbPath {
	fn new(label: &str) -> Self {
		let path = std::env::temp_dir()
			.join(format!("successor-context-platform-{label}-{}.sqlite", uuid::Uuid::new_v4()));
		Self(path.to_string_lossy().into_owned())
	}

	fn as_str(&self) -> &str {
		&self.0
	}
}

impl Drop for TempDbPath {
	fn drop(&mut self) {
		for suffix in ["", "-wal", "-shm"] {
			let _ = std::fs::remove_file(format!("{}{suffix}", self.0));
		}
	}
}

fn id<T>(raw: &str) -> T
where
	T: std::str::FromStr,
	<T as std::str::FromStr>::Err: std::fmt::Debug,
{
	raw.parse().expect("static test id is valid")
}

async fn create_session(
	append_store: &SqliteAppendStore,
	label: &str,
	workspace_id: &str,
) -> SessionId {
	let response = append_store
		.create_session(CreateSessionRequestV0 {
			workspace:  WorkspaceV0 {
				id:        workspace_id.to_owned(),
				label:     format!("long-context-{label}"),
				root_hint: "/workspace".to_owned(),
			},
			title:      format!("long-context-{label}"),
			created_by: CreatedByV0 {
				client_kind: "test".to_owned(),
				client_id:   format!("long-session-context-evaluation-{label}"),
			},
		})
		.await
		.expect("session creation succeeds");
	response.session_id
}

fn artifact_for(artifact_id: &ArtifactId, text: &str) -> ArtifactV0 {
	let content = json!(text);
	let bytes = text.as_bytes();
	ArtifactV0::new(
		artifact_id.clone(),
		"application/json",
		"utf-8",
		ArtifactHash::compute(bytes).to_string(),
		bytes.len() as u64,
	)
	.expect("artifact is valid")
	.with_preview(text)
	.with_content(content)
}

fn artifact_ref(artifact: &ArtifactV0) -> RawEventArtifactRef {
	RawEventArtifactRef {
		artifact_id: Some(artifact.artifact_id.clone()),
		sha256:      artifact.sha256.clone(),
		byte_length: artifact.byte_length,
		media_type:  artifact.media_type.clone(),
		encoding:    Some(artifact.encoding.clone()),
		preview:     artifact.preview.clone(),
		content:     None,
	}
}

#[expect(
	clippy::too_many_arguments,
	reason = "test event factory mirrors the platform append envelope"
)]
async fn append_event(
	append_store: &SqliteAppendStore,
	artifact_store: &SqliteArtifactStore,
	session_id: &SessionId,
	seq: u64,
	turn: u64,
	kind: EventKind,
	text: &str,
	source_envelope_id: Option<&str>,
	artifact_id: Option<&str>,
) {
	let event_type = match kind {
		EventKind::ToolResult => RawEventType::ToolResultRecorded,
		EventKind::UserTurn => RawEventType::UserTurnRecorded,
		EventKind::AssistantTurn => RawEventType::AssistantTurnRecorded,
	};
	let event_id: EventId = id(&format!("evt_{seq:032x}"));
	let request_id: RequestId = id(&format!("req_{seq:032x}"));
	let turn_id: TurnId = id(&format!("turn_{turn:032x}"));
	let artifact = artifact_id.map(|raw_id| artifact_for(&id(raw_id), text));
	let artifact_ref = artifact.as_ref().map(artifact_ref);
	let mut entity_ids = EntityIdsV0::default();
	if let Some(artifact) = &artifact {
		entity_ids.artifact_id = Some(artifact.artifact_id.clone());
	}
	if let Some(source_id) = source_envelope_id {
		entity_ids.source_envelope_id = Some(id(source_id));
	}
	let mut payload = json!({ "text": text });
	if let Some(source_id) = source_envelope_id {
		payload["source_envelope_id"] = json!(source_id);
	}
	// These fixture values model two successful reads of one path so F5 pins
	// same-path freshness deduplication for optional retrieval.
	if text == STALE_BYTES || text == CURRENT_BYTES {
		payload["tool_name"] = json!("read");
		payload["path"] = json!("src/target.rs");
	}
	append_store
		.append_event(RawEventAppendRequestV0 {
			schema_version: "platform.raw_event.v0".to_owned(),
			event_id: event_id.clone(),
			idempotency_key: format!("long-session-context-evaluation-{seq}"),
			event_type,
			session_id: session_id.clone(),
			turn_id: Some(turn_id),
			request_id: request_id.clone(),
			occurred_at: format!("2026-01-01T00:{:02}:00Z", seq % 60),
			producer: RawEventProducerV0::default(),
			causation_event_id: None,
			correlation_id: request_id,
			entity_ids,
			visibility: VisibilityV0::default(),
			redaction: RedactionLevelV0::Sensitive,
			payload,
			artifact: artifact_ref,
		})
		.await
		.expect("event append succeeds");
	if let Some(artifact) = artifact {
		artifact_store
			.put_inline_artifact(&event_id, session_id, artifact)
			.await
			.expect("artifact storage succeeds");
	}
}

#[expect(
	clippy::too_many_arguments,
	reason = "test read event factory mirrors the platform append envelope"
)]
async fn append_read_event(
	append_store: &SqliteAppendStore,
	artifact_store: &SqliteArtifactStore,
	session_id: &SessionId,
	seq: u64,
	turn: u64,
	text: &str,
	source_envelope_id: &str,
	artifact_id: Option<&str>,
	path: &str,
	offset: Option<u64>,
	limit: Option<u64>,
) {
	let request_event_id: EventId = id(&format!("evt_{:032x}", seq * 2));
	let result_event_id: EventId = id(&format!("evt_{:032x}", seq * 2 + 1));
	let request_id: RequestId = id(&format!("req_{seq:032x}"));
	let turn_id: TurnId = id(&format!("turn_{turn:032x}"));
	let tool_call_id: ToolCallId = id(&format!("tool_{seq:032x}"));
	let artifact = artifact_id.map(|raw_id| artifact_for(&id(raw_id), text));
	let artifact_ref = artifact.as_ref().map(artifact_ref);
	let mut arguments = json!({ "path": path });
	if let Some(offset) = offset {
		arguments["offset"] = json!(offset);
	}
	if let Some(limit) = limit {
		arguments["limit"] = json!(limit);
	}
	append_store
		.append_event(RawEventAppendRequestV0 {
			schema_version:     "platform.raw_event.v0".to_owned(),
			event_id:           request_event_id.clone(),
			idempotency_key:    format!("long-session-context-read-request-{seq}"),
			event_type:         RawEventType::ToolCallRequested,
			session_id:         session_id.clone(),
			turn_id:            Some(turn_id.clone()),
			request_id:         request_id.clone(),
			occurred_at:        format!("2026-01-01T00:{:02}:00Z", (seq * 2) % 60),
			producer:           RawEventProducerV0::default(),
			causation_event_id: None,
			correlation_id:     request_id.clone(),
			entity_ids:         EntityIdsV0 {
				tool_call_id: Some(tool_call_id.clone()),
				..EntityIdsV0::default()
			},
			visibility:         VisibilityV0::default(),
			redaction:          RedactionLevelV0::Sensitive,
			payload:            json!({ "tool_name": "read", "arguments": arguments }),
			artifact:           None,
		})
		.await
		.expect("read request event append succeeds");
	let mut entity_ids = EntityIdsV0 {
		tool_call_id: Some(tool_call_id),
		source_envelope_id: Some(id(source_envelope_id)),
		..EntityIdsV0::default()
	};
	if let Some(artifact) = &artifact {
		entity_ids.artifact_id = Some(artifact.artifact_id.clone());
	}
	append_store
		.append_event(RawEventAppendRequestV0 {
			schema_version: "platform.raw_event.v0".to_owned(),
			event_id: result_event_id.clone(),
			idempotency_key: format!("long-session-context-read-result-{seq}"),
			event_type: RawEventType::ToolResultRecorded,
			session_id: session_id.clone(),
			turn_id: Some(turn_id),
			request_id: request_id.clone(),
			occurred_at: format!("2026-01-01T00:{:02}:01Z", (seq * 2) % 60),
			producer: RawEventProducerV0::default(),
			causation_event_id: Some(request_event_id),
			correlation_id: request_id,
			entity_ids,
			visibility: VisibilityV0::default(),
			redaction: RedactionLevelV0::Sensitive,
			payload: json!({
				"source_kind": "tool_result",
				"source_envelope_id": source_envelope_id,
				"tool_name": "read",
				"path": path,
				"truncated": false,
				"preview": text,
			}),
			artifact: artifact_ref,
		})
		.await
		.expect("read result event append succeeds");
	if let Some(artifact) = artifact {
		artifact_store
			.put_inline_artifact(&result_event_id, session_id, artifact)
			.await
			.expect("read artifact storage succeeds");
	}
}

fn turn_id_string(turn: u64) -> String {
	format!("turn_{turn:032x}")
}

fn assemble_request(
	session_id: &SessionId,
	turn_id: &str,
	max_items: u64,
	max_context_tokens: u64,
) -> AssembleRequestV0 {
	AssembleRequestV0::new(
		session_id.clone(),
		id(turn_id),
		id("req_00000000000000000000000000abcdef"),
		AssemblePhaseV0::PreTool,
		AssembleIntentV0 {
			query:         "target relevant grep filler".to_owned(),
			raw_user_text: "target relevant grep filler".to_owned(),
			confidence:    "explicit".to_owned(),
		},
		AssembleWorkspaceV0 {
			root_hint: "/workspace".to_owned(),
			repo_id:   WORKSPACE_ID.to_owned(),
		},
		AssemblyBudgetV0 { max_context_tokens, max_items },
	)
}

fn assemble_request_with_query(
	session_id: &SessionId,
	turn_id: &str,
	max_items: u64,
	max_context_tokens: u64,
	query: &str,
) -> AssembleRequestV0 {
	let mut request = assemble_request(session_id, turn_id, max_items, max_context_tokens);
	query.clone_into(&mut request.intent.query);
	query.clone_into(&mut request.intent.raw_user_text);
	request
}

fn included_titles(items: &[ContextItemV0]) -> Vec<&str> {
	items
		.iter()
		.filter(|item| item.included)
		.map(|item| item.title.as_str())
		.collect()
}

fn rendered_texts(items: &[ContextItemV0]) -> Vec<&str> {
	items
		.iter()
		.map(|item| item.rendered_text.as_str())
		.collect()
}

fn assert_no_sentinel(items: &[ContextItemV0], sentinel: &str) {
	assert!(
		!rendered_texts(items)
			.iter()
			.any(|text| text.contains(sentinel)),
		"unexpected sentinel {sentinel} was injection-eligible"
	);
}

#[tokio::test]
async fn long_session_context_evaluation_pins_retrieval_isolation_and_budget_metrics() {
	let append_db = TempDbPath::new("f4-long-session-append");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "main", WORKSPACE_ID).await;
	let other_session_id = create_session(&append_store, "other", OTHER_WORKSPACE_ID).await;

	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		1,
		1,
		EventKind::ToolResult,
		STALE_BYTES,
		Some("src_00000000000000000000000000000001"),
		Some("art_00000000000000000000000000000001"),
	)
	.await;
	for seq in 2..=18 {
		append_event(
			&append_store,
			&artifact_store,
			&session_id,
			seq,
			seq,
			EventKind::ToolResult,
			&format!("older filler artifact F4_FILLER_{seq:02}"),
			Some(&format!("src_{seq:032x}")),
			Some(&format!("art_{seq:032x}")),
		)
		.await;
	}
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		19,
		19,
		EventKind::UserTurn,
		&format!("unrelated user question with {USER_TURN_SENTINEL}"),
		None,
		None,
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		20,
		20,
		EventKind::AssistantTurn,
		"assistant claim/report that must not become context bytes",
		None,
		None,
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		21,
		21,
		EventKind::ToolResult,
		"command manual text with grep usage, intentionally outside final five",
		Some("src_00000000000000000000000000000021"),
		Some("art_00000000000000000000000000000021"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		22,
		22,
		EventKind::ToolResult,
		&format!("prior tool output with {RELEVANT_TOOL_SENTINEL}"),
		Some("src_00000000000000000000000000000022"),
		Some("art_00000000000000000000000000000022"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		23,
		23,
		EventKind::ToolResult,
		CURRENT_BYTES,
		Some("src_00000000000000000000000000000023"),
		Some("art_00000000000000000000000000000023"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		24,
		24,
		EventKind::ToolResult,
		&format!("same turn draft artifact with {CURRENT_TURN_SENTINEL}"),
		Some("src_00000000000000000000000000000024"),
		Some("art_00000000000000000000000000000024"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&other_session_id,
		25,
		25,
		EventKind::ToolResult,
		&format!("other session contaminant {OTHER_SESSION_SENTINEL}"),
		Some("src_00000000000000000000000000000025"),
		Some("art_00000000000000000000000000000025"),
	)
	.await;

	let service = AssemblyServiceV0::new(append_store, artifact_store);
	let response = service
		.assemble(&assemble_request(&session_id, &turn_id_string(24), 5, 4_000))
		.await
		.expect("assembly succeeds");

	assert_eq!(
		response.context_items.len(),
		21,
		"corpus metric: prior-turn artifact candidates remain visible for auditability"
	);
	assert_eq!(
		response
			.context_items
			.iter()
			.filter(|item| item.included)
			.count(),
		5,
		"max_items gates exactly five injection-eligible candidates"
	);
	assert_eq!(
		included_titles(&response.context_items),
		vec![
			"read src/target.rs",
			"prior tool output with F4_RELEVANT_PRIOR_TOOL_SENTINEL",
			"command manual text with grep usage, intentionally outside final five",
			"older filler artifact F4_FILLER_18",
			"older filler artifact F4_FILLER_17",
		],
		"deterministic equal-score tie order is current accepted recency order"
	);
	assert!(
		rendered_texts(&response.context_items)
			.iter()
			.any(|text| text.contains(RELEVANT_TOOL_SENTINEL))
	);
	assert!(
		rendered_texts(&response.context_items)
			.iter()
			.any(|text| text.contains(CURRENT_BYTES))
	);
	let included_items: Vec<ContextItemV0> = response
		.context_items
		.iter()
		.filter(|item| item.included)
		.cloned()
		.collect();
	assert_no_sentinel(&included_items, STALE_BYTES);
	assert_no_sentinel(&included_items, USER_TURN_SENTINEL);
	assert_no_sentinel(&included_items, "assistant claim/report");
	assert_no_sentinel(&included_items, OTHER_SESSION_SENTINEL);
	assert_no_sentinel(&response.context_items, CURRENT_TURN_SENTINEL);

	let trace = service
		.get_trace(&response.assemble_id)
		.expect("trace is retained");
	let retrieve_stage = trace
		.stages
		.iter()
		.find(|stage| stage.name == "retrieve_recent_sources")
		.expect("recent-source retrieval stage exists");
	assert_eq!(retrieve_stage.input_count, 21, "eligible prior-turn candidates are evaluated");
	assert_eq!(retrieve_stage.output_count, 21, "metric gate pins exact candidate count");
}

#[tokio::test]
async fn long_session_context_evaluation_pins_current_turn_and_budget_exclusion_flags() {
	let append_db = TempDbPath::new("f4-current-turn-append");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "current-turn", WORKSPACE_ID).await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		101,
		101,
		EventKind::ToolResult,
		"tiny prior artifact that should remain budget eligible",
		Some("src_00000000000000000000000000000101"),
		Some("art_00000000000000000000000000000101"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		102,
		102,
		EventKind::ToolResult,
		&format!("current turn artifact {CURRENT_TURN_SENTINEL}"),
		Some("src_00000000000000000000000000000102"),
		Some("art_00000000000000000000000000000102"),
	)
	.await;

	let service = AssemblyServiceV0::new(append_store, artifact_store);
	let response = service
		.assemble(&assemble_request(&session_id, &turn_id_string(102), 2, 1))
		.await
		.expect("assembly succeeds");

	assert_eq!(
		response.context_items.len(),
		1,
		"the prior candidate is surfaced while the same-turn candidate is excluded before budget \
		 scoring"
	);
	let included_count = response
		.context_items
		.iter()
		.filter(|item| item.included)
		.count();
	assert_eq!(
		included_count, 0,
		"token budget gate marks the remaining oversize candidate included:false"
	);
	assert_no_sentinel(&response.context_items, CURRENT_TURN_SENTINEL);
	assert!(
		response.context_items.iter().all(|item| !item.included),
		"included:false items are not injection-eligible"
	);
	let injection_eligible: HashSet<&str> = response
		.context_items
		.iter()
		.filter(|item| item.included)
		.map(|item| item.rendered_text.as_str())
		.collect();
	assert!(
		!injection_eligible
			.iter()
			.any(|text| text.contains(CURRENT_TURN_SENTINEL)),
		"excluded current-turn bytes are never injection-eligible"
	);
}

#[tokio::test]
async fn long_session_context_evaluation_required_source_path_pins_exact_inclusion_and_exclusion() {
	let append_db = TempDbPath::new("f4-required-source-append");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "required-source", WORKSPACE_ID).await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		201,
		201,
		EventKind::ToolResult,
		"required source artifact bytes",
		Some("src_00000000000000000000000000000201"),
		Some("art_00000000000000000000000000000201"),
	)
	.await;

	let service = AssemblyServiceV0::new(append_store, artifact_store);
	let mut request =
		assemble_request(&session_id, "turn_00000000000000000000000000000202", 10, 4_000);
	request.required_source_envelope_ids =
		vec![id::<SourceEnvelopeId>("src_00000000000000000000000000000201")];
	request.exclude_source_envelope_ids = request.required_source_envelope_ids.clone();
	let response = service.assemble(&request).await.expect("assembly succeeds");

	assert!(response.context_items.is_empty(), "excluded required source yields no context item");
	assert_eq!(response.trace.dropped.len(), 1);
	assert_eq!(response.trace.dropped[0]["reason"].as_str(), Some("excluded"));
	assert_eq!(
		response
			.context_items
			.iter()
			.filter(|item| item.included)
			.count(),
		0,
		"excluded required-source bytes are never injection-eligible"
	);
}

#[tokio::test]
async fn long_session_context_evaluation_excludes_generic_artifact_collision_when_discriminating_terms_exist()
 {
	let append_db = TempDbPath::new("f4-artifact-lexical-contamination");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "artifact-lexical", WORKSPACE_ID).await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		301,
		301,
		EventKind::ToolResult,
		"relevant implementation context",
		Some("src_00000000000000000000000000000301"),
		Some("art_00000000000000000000000000000301"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		302,
		302,
		EventKind::ToolResult,
		&format!(
			"irrelevant command manual that collides with deterministic context assembly terms: \
			 {ARTIFACT_LEXICAL_SENTINEL}"
		),
		Some("src_00000000000000000000000000000302"),
		Some("art_00000000000000000000000000000302"),
	)
	.await;

	let response = AssemblyServiceV0::new(append_store, artifact_store)
		.assemble(&assemble_request_with_query(
			&session_id,
			&turn_id_string(303),
			10,
			4_000,
			"implementation",
		))
		.await
		.expect("assembly succeeds");
	assert_eq!(
		response.context_items.len(),
		2,
		"both artifact-bearing candidates are retrieval-eligible"
	);
	let lexical_contaminant = response
		.context_items
		.iter()
		.find(|item| item.rendered_text.contains(ARTIFACT_LEXICAL_SENTINEL))
		.expect("artifact-bearing lexical contaminant is surfaced");
	assert!(
		!lexical_contaminant.included,
		"generic/manual lexical collision stays audit-visible but is not injection-eligible"
	);
	let relevant = response
		.context_items
		.iter()
		.find(|item| item.rendered_text == "relevant implementation context")
		.expect("relevant artifact is surfaced");
	assert!(relevant.included, "discriminating relevant artifact is included");
	assert!(
		relevant.score > lexical_contaminant.score,
		"deterministic lexical scorer ranks the discriminating artifact first"
	);
}

#[tokio::test]
async fn long_session_context_evaluation_excludes_stale_same_path_read_but_keeps_it_audit_visible()
{
	let append_db = TempDbPath::new("f4-same-path-stale-content");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "same-path", WORKSPACE_ID).await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		401,
		401,
		EventKind::ToolResult,
		STALE_BYTES,
		Some("src_00000000000000000000000000000401"),
		Some("art_00000000000000000000000000000401"),
	)
	.await;
	append_event(
		&append_store,
		&artifact_store,
		&session_id,
		402,
		402,
		EventKind::ToolResult,
		CURRENT_BYTES,
		Some("src_00000000000000000000000000000402"),
		Some("art_00000000000000000000000000000402"),
	)
	.await;

	let response = AssemblyServiceV0::new(append_store, artifact_store)
		.assemble(&assemble_request(&session_id, &turn_id_string(403), 10, 4_000))
		.await
		.expect("assembly succeeds");
	assert_eq!(
		response.context_items.len(),
		2,
		"fresh and stale same-path candidates remain audit-visible"
	);
	assert_eq!(included_titles(&response.context_items), vec!["read src/target.rs"]);
	assert_eq!(
		rendered_texts(&response.context_items),
		vec![CURRENT_BYTES, STALE_BYTES],
		"fresh read is ordered first while stale read remains included:false"
	);
	let stale = response
		.context_items
		.iter()
		.find(|item| item.rendered_text == STALE_BYTES)
		.expect("stale same-path read remains audit-visible");
	assert!(!stale.included, "older same-path range is not injection-eligible");
}

#[tokio::test]
async fn long_session_context_evaluation_empty_stopword_and_zero_overlap_queries_fall_back_to_recency()
 {
	for (label, query) in [
		("empty-query", ""),
		("stopword-query", "the and of to"),
		("zero-overlap-query", "quasar nebula"),
	] {
		let append_db = TempDbPath::new(label);
		let append_store = SqliteAppendStore::connect(append_db.as_str())
			.await
			.expect("append store opens");
		let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
			.await
			.expect("artifact store opens");
		let session_id = create_session(&append_store, label, WORKSPACE_ID).await;
		append_event(
			&append_store,
			&artifact_store,
			&session_id,
			501,
			501,
			EventKind::ToolResult,
			"older alpha content",
			Some("src_00000000000000000000000000000501"),
			Some("art_00000000000000000000000000000501"),
		)
		.await;
		append_event(
			&append_store,
			&artifact_store,
			&session_id,
			502,
			502,
			EventKind::ToolResult,
			"newer beta content",
			Some("src_00000000000000000000000000000502"),
			Some("art_00000000000000000000000000000502"),
		)
		.await;

		let response = AssemblyServiceV0::new(append_store, artifact_store)
			.assemble(&assemble_request_with_query(
				&session_id,
				&turn_id_string(503),
				10,
				4_000,
				query,
			))
			.await
			.expect("assembly succeeds");

		assert_eq!(included_titles(&response.context_items), vec![
			"newer beta content",
			"older alpha content"
		]);
		assert!(response.context_items.iter().all(|item| item.included));
	}
}

#[tokio::test]
async fn long_session_context_evaluation_pins_read_path_normalization_range_identity_and_failure() {
	let append_db = TempDbPath::new("f5-read-identity");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "read-identity", WORKSPACE_ID).await;

	append_read_event(
		&append_store,
		&artifact_store,
		&session_id,
		601,
		601,
		"stale path-normalized target sentinel",
		"src_00000000000000000000000000000601",
		Some("art_00000000000000000000000000000601"),
		"/workspace/src/./target.rs",
		Some(1),
		Some(5),
	)
	.await;
	append_read_event(
		&append_store,
		&artifact_store,
		&session_id,
		602,
		602,
		"current path-normalized target sentinel",
		"src_00000000000000000000000000000602",
		Some("art_00000000000000000000000000000602"),
		"src/target.rs",
		Some(1),
		Some(5),
	)
	.await;
	append_read_event(
		&append_store,
		&artifact_store,
		&session_id,
		603,
		603,
		"distinct offset target sentinel",
		"src_00000000000000000000000000000603",
		Some("art_00000000000000000000000000000603"),
		"src/target.rs",
		Some(2),
		Some(5),
	)
	.await;
	append_read_event(
		&append_store,
		&artifact_store,
		&session_id,
		604,
		604,
		"failed later target read without artifact",
		"src_00000000000000000000000000000604",
		None,
		"src/target.rs",
		Some(2),
		Some(5),
	)
	.await;

	let response = AssemblyServiceV0::new(append_store, artifact_store)
		.assemble(&assemble_request_with_query(
			&session_id,
			&turn_id_string(605),
			10,
			4_000,
			"target",
		))
		.await
		.expect("assembly succeeds");

	let included_items = response
		.context_items
		.iter()
		.filter(|item| item.included)
		.cloned()
		.collect::<Vec<_>>();
	let included = rendered_texts(&included_items);
	assert_eq!(
		included,
		vec!["distinct offset target sentinel", "current path-normalized target sentinel"],
		"range identity is offset/limit-sensitive and a failed later read does not supersede success"
	);
	let stale = response
		.context_items
		.iter()
		.find(|item| item.rendered_text == "stale path-normalized target sentinel")
		.expect("stale normalized path candidate remains audit-visible");
	assert!(!stale.included);
}

#[tokio::test]
async fn long_session_context_evaluation_required_source_bypasses_freshness_and_relevance() {
	let append_db = TempDbPath::new("f5-required-bypass");
	let append_store = SqliteAppendStore::connect(append_db.as_str())
		.await
		.expect("append store opens");
	let artifact_store = SqliteArtifactStore::connect(append_db.as_str())
		.await
		.expect("artifact store opens");
	let session_id = create_session(&append_store, "required-bypass", WORKSPACE_ID).await;

	append_read_event(
		&append_store,
		&artifact_store,
		&session_id,
		701,
		701,
		"required stale low score bytes",
		"src_00000000000000000000000000000701",
		Some("art_00000000000000000000000000000701"),
		"src/target.rs",
		None,
		None,
	)
	.await;
	append_read_event(
		&append_store,
		&artifact_store,
		&session_id,
		702,
		702,
		"current optional replacement bytes",
		"src_00000000000000000000000000000702",
		Some("art_00000000000000000000000000000702"),
		"src/target.rs",
		None,
		None,
	)
	.await;

	let mut request = assemble_request_with_query(
		&session_id,
		&turn_id_string(703),
		10,
		4_000,
		"discriminating absent",
	);
	request.required_source_envelope_ids =
		vec![id::<SourceEnvelopeId>("src_00000000000000000000000000000701")];
	let response = AssemblyServiceV0::new(append_store, artifact_store)
		.assemble(&request)
		.await
		.expect("assembly succeeds");

	assert_eq!(included_titles(&response.context_items), vec!["read src/target.rs"]);
	assert_eq!(rendered_texts(&response.context_items), vec!["required stale low score bytes"]);
	assert!(response.context_items[0].included);
}
