//! B5 (`PlatformAssembly`) fixture-driven proof.
//!
//! Exercises `AssemblyServiceV0::assemble`/`get_trace` against the canonical
//! Slice 0 fixtures over a real `SQLite`-backed `RawEventAppendStore` +
//! `SqliteArtifactStore`, mirroring the seeding helpers already established
//! in B4's `slice0_replay.rs`.
//!
//! # Fixture-vs-platform id comparison approach
//!
//! `AssembleRequestV0` carries no `assemble_id`/`trace_id`, and
//! `ContextItemV0::context_item_id` is minted per call: these are
//! platform-assigned, not fixture-supplied, so byte-exact equality against
//! the canonical `assemble-response-*.json` fixtures is impossible (and
//! wrong to expect) for `assemble_id`, `trace.trace_id`, `created_at`, and
//! `context_items[].context_item_id`. `assert_response_matches_fixture`
//! below asserts:
//! - those four fields are well-formed (correct id prefix / RFC3339 shape) and
//!   internally self-consistent (`response.assemble_id ==
//!   response.trace.assemble_id`);
//! - every other field (`session_id`, `turn_id`, `request_id`, `phase`,
//!   `context_items` minus their id, `trace.{query,projection_version,
//!   stages,dropped}`, `degradation`, `policy`) matches the canonical fixture
//!   exactly.
//!
//! `session_id` itself is compared against the freshly created test
//! session, not the fixture's fixed placeholder, for the same reason
//! `slice0_replay.rs` patches `session_id` before comparing
//! `SessionSnapshotV0`.

use successor_context_platform::{
	artifacts::SqliteArtifactStore, assembly::AssemblyServiceV0, sqlite::SqliteAppendStore,
	store::RawEventAppendStore,
};
use successor_protocol::{
	artifact::ArtifactV0,
	error::ProtocolViolationCode,
	fixtures,
	ids::{AssembleId, SessionId, SourceEnvelopeId},
	platform_api::{
		AssembleRequestV0, AssemblyResponseV0, AssemblyTraceV0, ContextItemV0,
		CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0,
	},
};

/// A unique temporary `SQLite` file path. Two independently pooled
/// connections to this same path observe the same physical database (unlike
/// `sqlite::memory:`, which is private per connection). Mirrors the helper
/// already established in B3/B4's test modules.
struct TempDbPath(String);

impl TempDbPath {
	fn new(label: &str) -> Self {
		let unique = uuid::Uuid::new_v4();
		let path = std::env::temp_dir().join(format!("b5-assembly-{label}-{unique}.sqlite3"));
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

/// The canonical successful-turn raw-event fixture, as full `RawEventV0`
/// JSON objects (each carries `session_seq`, unlike `RawEventAppendRequestV0`).
const SUCCESSFUL_TURN_FIXTURE: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-successful-turn.\
	 json"
);

async fn create_session(append_store: &SqliteAppendStore, label: &str) -> SessionId {
	append_store
		.create_session(CreateSessionRequestV0 {
			workspace:  WorkspaceV0 {
				id:        format!("workspace_{label}"),
				label:     format!("b5-{label}"),
				root_hint: format!("/tmp/b5-{label}"),
			},
			title:      format!("B5 assembly tests ({label})"),
			created_by: CreatedByV0 { client_kind: "test".to_owned(), client_id: "b5".to_owned() },
		})
		.await
		.expect("create_session must succeed")
		.session_id
}

/// Appends the canonical fixture stream into a fresh session, rewriting
/// `session_id` to match and stripping `session_seq` so the platform
/// assigns it densely. Every other id (`evt_`/`src_`/`art_`/`asm_`/...) is
/// left as the fixture's fixed placeholder, since those are exactly what
/// `required_source_envelope_ids` in the canonical request fixtures name.
async fn seed_successful_turn(append_store: &SqliteAppendStore, label: &str) -> SessionId {
	let session_id = create_session(append_store, label).await;

	let mut events: Vec<serde_json::Value> =
		serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture must parse as JSON array");
	for event in &mut events {
		if let serde_json::Value::Object(map) = event {
			map.remove("session_seq");
			map.insert(
				"session_id".to_owned(),
				serde_json::Value::String(session_id.as_str().to_owned()),
			);
		}
	}

	for event in events {
		let request: RawEventAppendRequestV0 = serde_json::from_value(event)
			.expect("fixture event must deserialize as an append request");
		append_store
			.append_event(request)
			.await
			.expect("fixture append must succeed");
	}

	session_id
}

/// Stores every inline artifact carried by the canonical successful-turn
/// fixture into `artifact_store`, so required-source resolution finds them.
/// Mirrors B3's `fixture_artifacts` / B4's `store_fixture_artifacts` helper.
async fn store_fixture_artifacts(
	append_store: &SqliteAppendStore,
	artifact_store: &SqliteArtifactStore,
	session_id: &SessionId,
) {
	let mut after_seq = 0u64;
	let mut stored = 0;
	loop {
		let page = append_store
			.read_session_events(session_id, after_seq, 100)
			.await
			.expect("read_session_events");
		for event in &page.events {
			let Some(artifact_ref) = &event.artifact else {
				continue;
			};
			let Some(content) = &artifact_ref.content else {
				continue;
			};
			let Some(artifact_id) = event.entity_ids.artifact_id.clone() else {
				continue;
			};
			let artifact = ArtifactV0::new(
				artifact_id,
				artifact_ref.media_type.clone(),
				artifact_ref
					.encoding
					.clone()
					.unwrap_or_else(|| "identity".to_owned()),
				artifact_ref.sha256.as_str(),
				artifact_ref.byte_length,
			)
			.expect("fixture artifact hash must be well-formed")
			.with_content(serde_json::Value::String(content.clone()));
			artifact_store
				.put_inline_artifact(&event.event_id, session_id, artifact)
				.await
				.expect("put_inline_artifact must succeed for a valid fixture artifact");
			stored += 1;
		}
		after_seq = page.next_after_seq;
		if !page.has_more {
			break;
		}
	}
	assert_eq!(
		stored, 2,
		"canonical successful-turn fixture must carry exactly two inline artifacts"
	);
}

/// A ready-to-use service over a freshly seeded copy of the canonical
/// successful-turn stream (events + artifacts), plus the session it was
/// seeded into.
async fn seeded_service(label: &str) -> (AssemblyServiceV0<SqliteAppendStore>, SessionId) {
	let db = TempDbPath::new(label);
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

	let session_id = seed_successful_turn(&append_store, label).await;
	store_fixture_artifacts(&append_store, &artifact_store, &session_id).await;

	// Leak `db` for the lifetime of the test process instead of threading a
	// guard through the return type: the OS temp dir is cleaned up
	// independently, and every test uses a unique-per-label path so leaked
	// files never collide across test runs within a single process.
	std::mem::forget(db);

	(AssemblyServiceV0::new(append_store, artifact_store), session_id)
}

/// Clones a canonical request fixture, retargeting `session_id` at the
/// freshly seeded test session. Every other field (`turn_id`, `request_id`,
/// `intent`, `budget`, `required_source_envelope_ids`,
/// `exclude_source_envelope_ids`) names ids that are fixture-fixed and
/// remain valid after seeding, so they are left untouched.
fn request_for(fixture: AssembleRequestV0, session_id: &SessionId) -> AssembleRequestV0 {
	AssembleRequestV0 { session_id: session_id.clone(), ..fixture }
}

fn assert_context_items_match(actual: &[ContextItemV0], expected: &[ContextItemV0]) {
	assert_eq!(actual.len(), expected.len(), "context item count must match the canonical fixture");
	for (actual_item, expected_item) in actual.iter().zip(expected.iter()) {
		assert!(
			actual_item.context_item_id.as_str().starts_with("ctx_"),
			"context_item_id must carry the ctx_ prefix"
		);
		assert_eq!(actual_item.source_envelope_id, expected_item.source_envelope_id);
		assert_eq!(actual_item.artifact_id, expected_item.artifact_id);
		assert_eq!(actual_item.source_kind, expected_item.source_kind);
		assert_eq!(actual_item.title, expected_item.title);
		assert_eq!(actual_item.rendered_text, expected_item.rendered_text);
		// Scores are exact literals (`1.0`) on both sides, never computed, so
		// exact float comparison is intentional here.
		#[allow(clippy::float_cmp, reason = "both sides are the exact literal 1.0, never computed")]
		{
			assert_eq!(actual_item.score, expected_item.score);
		}
		assert_eq!(actual_item.token_estimate, expected_item.token_estimate);
		assert_eq!(actual_item.included, expected_item.included);
		assert_eq!(actual_item.recovery, expected_item.recovery);
	}
}

fn assert_trace_matches_fixture(
	actual: &AssemblyTraceV0,
	expected: &AssemblyTraceV0,
	assemble_id: &AssembleId,
) {
	assert!(actual.trace_id.as_str().starts_with("trace_"), "trace_id must carry the trace_ prefix");
	assert_eq!(
		&actual.assemble_id, assemble_id,
		"trace.assemble_id must match the response's own assemble_id"
	);
	assert_eq!(actual.query, expected.query);
	assert_eq!(actual.projection_version, expected.projection_version);
	assert_eq!(actual.stages, expected.stages);
	assert_eq!(actual.dropped, expected.dropped);
}

fn assert_response_matches_fixture(
	actual: &AssemblyResponseV0,
	expected: &AssemblyResponseV0,
	session_id: &SessionId,
) {
	assert!(
		actual.assemble_id.as_str().starts_with("asm_"),
		"assemble_id must carry the asm_ prefix"
	);
	assert_eq!(actual.schema_version, expected.schema_version);
	assert_eq!(&actual.session_id, session_id);
	assert_eq!(actual.turn_id, expected.turn_id);
	assert_eq!(actual.request_id, expected.request_id);
	assert_eq!(actual.phase, expected.phase);
	assert!(
		actual.created_at.contains('T') && actual.created_at.ends_with('Z'),
		"created_at must be an RFC3339 UTC timestamp, got {:?}",
		actual.created_at
	);
	assert_context_items_match(&actual.context_items, &expected.context_items);
	assert_trace_matches_fixture(&actual.trace, &expected.trace, &actual.assemble_id);
	assert_eq!(actual.degradation, expected.degradation);
	assert_eq!(actual.policy, expected.policy);
}

#[tokio::test]
async fn assemble_pre_tool_matches_canonical_fixture_modulo_platform_assigned_ids() {
	let (service, session_id) = seeded_service("pre-tool").await;

	let request = request_for(fixtures::assemble_request_pre_tool(), &session_id);
	let response = service
		.assemble(&request)
		.await
		.expect("pre_tool assemble must succeed");

	assert_response_matches_fixture(&response, &fixtures::assemble_response_pre_tool(), &session_id);
	assert!(response.context_items.is_empty(), "pre_tool must yield zero context items");
}

#[tokio::test]
async fn assemble_post_read_matches_canonical_fixture_modulo_platform_assigned_ids() {
	let (service, session_id) = seeded_service("post-read").await;

	let request = request_for(fixtures::assemble_request_post_read(), &session_id);
	let response = service
		.assemble(&request)
		.await
		.expect("post_read assemble must succeed");

	assert_response_matches_fixture(
		&response,
		&fixtures::assemble_response_post_read(),
		&session_id,
	);
	assert_eq!(
		response.context_items.len(),
		1,
		"post_read must yield exactly the one required-source item"
	);
	assert!(
		response.context_items[0].included,
		"the sole required-source item must fit the default budget"
	);
}

#[tokio::test]
async fn assemble_is_deterministic_across_repeated_calls() {
	let (service, session_id) = seeded_service("determinism").await;
	let request = request_for(fixtures::assemble_request_post_read(), &session_id);

	let first = service
		.assemble(&request)
		.await
		.expect("first assemble must succeed");
	let second = service
		.assemble(&request)
		.await
		.expect("second assemble must succeed");

	// assemble_id/trace_id/context_item_id/created_at are freshly minted per
	// call by design (see the module doc comment), so two calls over
	// identical input are compared the same way as against the fixture:
	// everything except those platform-assigned fields must be identical.
	assert_eq!(first.session_id, second.session_id);
	assert_eq!(first.turn_id, second.turn_id);
	assert_eq!(first.request_id, second.request_id);
	assert_eq!(first.phase, second.phase);
	assert_context_items_match(&first.context_items, &second.context_items);
	assert_eq!(first.trace.query, second.trace.query);
	assert_eq!(first.trace.projection_version, second.trace.projection_version);
	assert_eq!(first.trace.stages, second.trace.stages);
	assert_eq!(first.trace.dropped, second.trace.dropped);
	assert_eq!(first.degradation, second.degradation);
	assert_eq!(first.policy, second.policy);
}

#[tokio::test]
async fn assemble_unknown_session_returns_typed_not_found() {
	let (service, session_id) = seeded_service("unknown-session").await;
	// A syntactically valid but never-created session.
	let unknown_session_id = SessionId::from_raw(format!("ses_{}", uuid::Uuid::new_v4()));
	assert_ne!(unknown_session_id, session_id);

	let request = request_for(fixtures::assemble_request_pre_tool(), &unknown_session_id);
	let error = service
		.assemble(&request)
		.await
		.expect_err("unknown session must be rejected");

	assert_eq!(error.envelope().code, ProtocolViolationCode::NotFound.as_str());
}

#[tokio::test]
async fn assemble_unknown_required_source_degrades_instead_of_failing() {
	let (service, session_id) = seeded_service("unknown-source").await;
	let unknown_source = SourceEnvelopeId::from_raw(format!("src_{}", uuid::Uuid::new_v4()));

	let mut request = request_for(fixtures::assemble_request_post_read(), &session_id);
	request.required_source_envelope_ids = vec![unknown_source.clone()];

	let response = service
		.assemble(&request)
		.await
		.expect("unknown required source must not be fatal");

	assert!(
		response.context_items.is_empty(),
		"an unresolvable required source yields no context item"
	);
	assert!(
		response
			.degradation
			.iter()
			.any(|d| d.code == "unknown_required_source"),
		"must report an unknown_required_source degradation, got {:?}",
		response.degradation
	);
	assert_eq!(response.trace.dropped.len(), 1);
	assert_eq!(
		response.trace.dropped[0]["source_envelope_id"].as_str(),
		Some(unknown_source.as_str())
	);
	assert_eq!(response.trace.dropped[0]["reason"].as_str(), Some("unknown_source_envelope_id"));
}

#[tokio::test]
async fn assemble_excludes_a_required_source_that_is_also_excluded() {
	let (service, session_id) = seeded_service("exclude-wins").await;

	let mut request = request_for(fixtures::assemble_request_post_read(), &session_id);
	request.exclude_source_envelope_ids = request.required_source_envelope_ids.clone();

	let response = service
		.assemble(&request)
		.await
		.expect("assemble must still succeed");

	assert!(response.context_items.is_empty(), "an excluded required source yields no context item");
	assert_eq!(response.trace.dropped.len(), 1);
	assert_eq!(response.trace.dropped[0]["reason"].as_str(), Some("excluded"));
	// Excluding the only required source removes context, but embeddings
	// are still unavailable and this is not the zero-required-sources path,
	// so only the one degradation applies.
	assert_eq!(response.degradation.len(), 1);
	assert_eq!(response.degradation[0].code, "embeddings_unavailable");
}

#[tokio::test]
async fn assemble_max_items_zero_marks_the_required_item_not_included() {
	let (service, session_id) = seeded_service("max-items-zero").await;

	let mut request = request_for(fixtures::assemble_request_post_read(), &session_id);
	request.budget.max_items = 0;

	let response = service
		.assemble(&request)
		.await
		.expect("assemble must still succeed");

	assert_eq!(response.context_items.len(), 1, "the source is still resolved and reported");
	assert!(
		!response.context_items[0].included,
		"max_items: 0 must exclude every item deterministically"
	);
}

#[tokio::test]
async fn assemble_small_max_context_tokens_marks_the_required_item_not_included() {
	let (service, session_id) = seeded_service("max-tokens-small").await;

	let mut request = request_for(fixtures::assemble_request_post_read(), &session_id);
	request.budget.max_context_tokens = 4; // below the 32-token canonical item cost

	let response = service
		.assemble(&request)
		.await
		.expect("assemble must still succeed");

	assert_eq!(response.context_items.len(), 1);
	assert!(
		!response.context_items[0].included,
		"a token budget below the item cost must exclude it"
	);
}

#[tokio::test]
async fn get_trace_returns_the_fixture_pinned_stage_for_a_known_assemble_id() {
	let (service, session_id) = seeded_service("get-trace-pre-tool").await;
	let request = request_for(fixtures::assemble_request_pre_tool(), &session_id);
	let response = service
		.assemble(&request)
		.await
		.expect("assemble must succeed");

	let trace = service
		.get_trace(&response.assemble_id)
		.expect("trace must be present for a just-produced id");

	assert_eq!(trace.assemble_id, response.assemble_id);
	assert_eq!(trace.trace_id, response.trace.trace_id);
	assert_eq!(trace.query, request.intent.query);
	assert_eq!(trace.stages.len(), 1);
	assert_eq!(trace.stages[0].name, "retrieve_recent_sources");
}

#[tokio::test]
async fn get_trace_returns_the_required_sources_stage_for_post_read() {
	let (service, session_id) = seeded_service("get-trace-post-read").await;
	let request = request_for(fixtures::assemble_request_post_read(), &session_id);
	let response = service
		.assemble(&request)
		.await
		.expect("assemble must succeed");

	let trace = service
		.get_trace(&response.assemble_id)
		.expect("trace must be present for a just-produced id");

	assert_eq!(trace.stages.len(), 1);
	assert_eq!(trace.stages[0].name, "required_sources");
}

#[tokio::test]
async fn get_trace_returns_none_for_an_unknown_assemble_id() {
	let (service, _session_id) = seeded_service("get-trace-unknown").await;
	let never_produced = AssembleId::from_raw(format!("asm_{}", uuid::Uuid::new_v4()));

	assert!(service.get_trace(&never_produced).is_none());
}
