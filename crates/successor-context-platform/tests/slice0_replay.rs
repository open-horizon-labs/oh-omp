//! B4 (`PlatformProjectionReplay`) fixture-driven proof.
//!
//! Exercises the public `replay`/`projection`/`trace_index` surface against the
//! canonical Slice 0 fixtures over a real `SQLite`-backed
//! `RawEventAppendStore` + `SqliteArtifactStore`, per the lane's binding
//! reuse seam: ordered events via B2's store -> accepted A4
//! `project_session` -> platform `SessionSnapshotV0` / `trace_index`.

use std::collections::HashMap;

use successor_context_platform::{
	artifacts::SqliteArtifactStore,
	error::PlatformError,
	replay::{read_ordered_session_events, replay_session_projection, replay_session_snapshot},
	sqlite::SqliteAppendStore,
	store::RawEventAppendStore,
	trace_index::build_trace_index,
};
use successor_protocol::{
	artifact::ArtifactV0,
	error::ProtocolViolationCode,
	ids::{AssembleId, EventId, SessionId},
	platform_api::{
		CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, SessionSnapshotV0, WorkspaceV0,
	},
	raw_event::RawEventType,
};

/// A unique temporary `SQLite` file path. Two independently pooled
/// connections to this same path observe the same physical database
/// (unlike `sqlite::memory:`, which is private per connection). Mirrors the
/// helper already established in B3's `artifacts.rs` test module.
struct TempDbPath(String);

impl TempDbPath {
	fn new(label: &str) -> Self {
		let unique = uuid::Uuid::new_v4();
		let path = std::env::temp_dir().join(format!("b4-replay-{label}-{unique}.sqlite3"));
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
/// JSON objects (each carries `session_seq`, unlike
/// `RawEventAppendRequestV0`).
const SUCCESSFUL_TURN_FIXTURE: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-successful-turn.\
	 json"
);

/// The unsupported-tool fixture stream: `tool_call.requested` /
/// `tool_call.rejected` / `error.recorded`. Accepted A4 `project_session`
/// rejects any stream carrying `error.recorded` outright (see
/// `successor_protocol::replay::project_session`); this crate does not
/// implement platform-local projection semantics to work around that,
/// per the dissent ruling. See the `replay_of_unsupported_tool_fixture_*`
/// test below for the routed A4-reopen note.
const UNSUPPORTED_TOOL_FIXTURE: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-unsupported-tool.\
	 json"
);

/// The canonical `session-snapshot.json` fixture, as an owned string, for
/// exact per-field comparison against replay output.
const EXPECTED_SESSION_SNAPSHOT: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/session-snapshot.json"
);

async fn create_session(append_store: &SqliteAppendStore, label: &str) -> SessionId {
	append_store
		.create_session(CreateSessionRequestV0 {
			workspace:  WorkspaceV0 {
				id:        format!("workspace_{label}"),
				label:     format!("b4-{label}"),
				root_hint: format!("/tmp/b4-{label}"),
			},
			title:      format!("B4 replay tests ({label})"),
			created_by: CreatedByV0 { client_kind: "test".to_owned(), client_id: "b4".to_owned() },
		})
		.await
		.expect("create_session must succeed")
		.session_id
}

/// Appends a fixture event stream (full `RawEventV0` JSON, `session_seq`
/// present) into a fresh session on `append_store`, rewriting `session_id`
/// to match and stripping `session_seq` so the platform assigns it densely.
/// Mirrors the seeding helper already established in B2/B3's test modules.
async fn seed_fixture_stream(
	append_store: &SqliteAppendStore,
	label: &str,
	fixture: &str,
) -> SessionId {
	let session_id = create_session(append_store, label).await;

	let mut events: Vec<serde_json::Value> =
		serde_json::from_str(fixture).expect("fixture must parse as JSON array");
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
/// fixture into `artifact_store`, so artifact-backed replay finds them.
/// Mirrors B3's `fixture_artifacts` helper.
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

/// Builds the expected `SessionSnapshotV0` from the canonical fixture,
/// substituting `session_id` for the freshly created test session (the
/// fixture's `session_id` is a fixed placeholder; every other field is
/// asserted verbatim against the fixture).
fn expected_snapshot_for(session_id: &SessionId) -> SessionSnapshotV0 {
	let mut value: serde_json::Value =
		serde_json::from_str(EXPECTED_SESSION_SNAPSHOT).expect("fixture must parse");
	if let serde_json::Value::Object(map) = &mut value {
		map.insert(
			"session_id".to_owned(),
			serde_json::Value::String(session_id.as_str().to_owned()),
		);
	}
	serde_json::from_value(value)
		.expect("fixture must deserialize as SessionSnapshotV0 once session_id is patched")
}

#[tokio::test]
async fn replay_of_successful_turn_matches_canonical_session_snapshot() {
	let db = TempDbPath::new("snapshot");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

	let session_id = seed_fixture_stream(&append_store, "snapshot", SUCCESSFUL_TURN_FIXTURE).await;
	store_fixture_artifacts(&append_store, &artifact_store, &session_id).await;

	let snapshot = replay_session_snapshot(&append_store, &artifact_store, &session_id)
		.await
		.expect("replay of the canonical successful-turn fixture must succeed");

	let expected = expected_snapshot_for(&session_id);

	// Field-by-field per the packet's requirement to assert semantic
	// equality on every field the fixture carries (a single struct-level
	// assert_eq gives the same coverage but worse failure messages, so we
	// spell out the fields that matter for diagnosis).
	assert_eq!(snapshot.session_id, expected.session_id);
	assert_eq!(snapshot.created_at, expected.created_at);
	assert_eq!(snapshot.updated_at, expected.updated_at);
	assert_eq!(snapshot.last_raw_event_seq, expected.last_raw_event_seq);
	assert_eq!(snapshot.raw_event_ids, expected.raw_event_ids);
	assert_eq!(snapshot.source_envelope_ids, expected.source_envelope_ids);
	assert_eq!(snapshot.artifact_ids, expected.artifact_ids);
	assert_eq!(snapshot.assemble_ids, expected.assemble_ids);
	assert_eq!(snapshot.last_turn_id, expected.last_turn_id);
	assert_eq!(snapshot.last_assistant_summary, expected.last_assistant_summary);
	assert_eq!(snapshot.sharing, expected.sharing);
	assert_eq!(snapshot, expected, "full snapshot must match the canonical fixture exactly");
}

#[tokio::test]
async fn replay_of_successful_turn_is_deterministic() {
	let db = TempDbPath::new("determinism");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

	let session_id =
		seed_fixture_stream(&append_store, "determinism", SUCCESSFUL_TURN_FIXTURE).await;
	store_fixture_artifacts(&append_store, &artifact_store, &session_id).await;

	let first = replay_session_snapshot(&append_store, &artifact_store, &session_id)
		.await
		.unwrap();
	let second = replay_session_snapshot(&append_store, &artifact_store, &session_id)
		.await
		.unwrap();

	assert_eq!(first, second, "replaying the same session twice must produce an identical snapshot");
	let first_bytes = serde_json::to_vec(&first).unwrap();
	let second_bytes = serde_json::to_vec(&second).unwrap();
	assert_eq!(
		first_bytes, second_bytes,
		"serialized snapshot bytes must be identical across replays"
	);
}

#[tokio::test]
async fn replay_of_empty_session_returns_typed_error_not_panic() {
	let db = TempDbPath::new("empty-session");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

	// Session exists (created) but has zero appended events.
	let session_id = create_session(&append_store, "empty").await;

	let err = replay_session_snapshot(&append_store, &artifact_store, &session_id)
		.await
		.unwrap_err();
	assert_eq!(
		err.envelope().code,
		ProtocolViolationCode::ReplayMismatch.as_str(),
		"an empty raw-event stream must surface A4's typed ReplayMismatch, not panic"
	);
}

#[tokio::test]
async fn replay_of_unknown_session_returns_typed_not_found_error() {
	let db = TempDbPath::new("unknown-session");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

	let unknown =
		SessionId::try_from("ses_00000000-0000-4000-8000-00000000dead".to_owned()).unwrap();

	let err = replay_session_snapshot(&append_store, &artifact_store, &unknown)
		.await
		.unwrap_err();
	assert_eq!(
		err.envelope().code,
		ProtocolViolationCode::NotFound.as_str(),
		"a session that was never created must surface B2's typed NotFound, not panic"
	);

	// Distinct from the empty-session case: NotFound (session absent) vs.
	// ReplayMismatch (session present, stream empty) are different typed
	// errors, as required by the edge-case checklist.
	assert_ne!(
		ProtocolViolationCode::NotFound.as_str(),
		ProtocolViolationCode::ReplayMismatch.as_str()
	);
}

/// Routed A4-reopen candidate: accepted A4 `project_session` rejects any
/// stream containing an `error.recorded` event (see
/// `crates/successor-protocol/src/replay.rs`, the `ErrorRecorded` match arm).
/// The unsupported-tool fixture is exactly such a stream. Per the dissent
/// ruling, B4 does not implement platform-local projection semantics to
/// route around this narrow A4 gap; instead this test pins the current,
/// correct behavior (a typed error, not a panic) and records the gap as a
/// candidate for a future narrow A4 reopen (teaching `project_session` to
/// represent rejected/errored tool turns instead of refusing the whole
/// stream).
#[tokio::test]
async fn replay_of_unsupported_tool_fixture_surfaces_typed_error_pending_a4_reopen() {
	let db = TempDbPath::new("unsupported-tool");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();

	let session_id =
		seed_fixture_stream(&append_store, "unsupported-tool", UNSUPPORTED_TOOL_FIXTURE).await;

	let err = replay_session_projection(&append_store, &session_id)
		.await
		.unwrap_err();
	assert_eq!(
		err.envelope().code,
		ProtocolViolationCode::ReplayMismatch.as_str(),
		"accepted A4 rejects error.recorded streams; replay must surface that as a typed error, not \
		 a panic"
	);
}

#[tokio::test]
async fn replay_of_session_with_artifact_missing_from_b3_store_surfaces_typed_integrity_error() {
	let db = TempDbPath::new("missing-artifact");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

	// Raw events reference two artifacts via entity_ids.artifact_id, but we
	// deliberately never call put_inline_artifact -- the contract requires
	// artifact-backed replay to catch exactly this integrity gap.
	let session_id =
		seed_fixture_stream(&append_store, "missing-artifact", SUCCESSFUL_TURN_FIXTURE).await;

	let err = replay_session_snapshot(&append_store, &artifact_store, &session_id)
		.await
		.unwrap_err();
	assert_eq!(
		err.envelope().code,
		ProtocolViolationCode::NotFound.as_str(),
		"a projection-referenced artifact absent from B3's store must surface a typed integrity \
		 error, not panic"
	);
}

#[tokio::test]
async fn trace_index_over_canonical_stream_yields_correct_assembly_event_associations() {
	let db = TempDbPath::new("trace-index");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();

	let session_id =
		seed_fixture_stream(&append_store, "trace-index", SUCCESSFUL_TURN_FIXTURE).await;
	let events = read_ordered_session_events(&append_store, &session_id)
		.await
		.unwrap();
	let index = build_trace_index(&events);

	// Ambiguity note (recorded, not silently resolved): the lane packet's
	// edge-case text says trace_index "yields the two assembly phases", but
	// the canonical fixture carries three assemble_ids (pre_tool,
	// post_locator, post_read), each tagged on exactly three raw events
	// (assembly.requested, assembly.completed, provider_request.built).
	// This test asserts fixture ground truth rather than the packet's
	// phrasing; see completion notes.
	assert_eq!(index.len(), 3, "canonical stream carries exactly three assemble_ids");

	let event_id =
		|seq: u64| EventId::try_from(format!("evt_00000000-0000-4000-8000-{seq:012}")).unwrap();

	let mut expected: HashMap<String, Vec<(EventId, u64, RawEventType)>> = HashMap::new();
	expected.insert("asm_00000000-0000-4000-8000-000000000001".to_owned(), vec![
		(event_id(3), 3, RawEventType::AssemblyRequested),
		(event_id(4), 4, RawEventType::AssemblyCompleted),
		(event_id(5), 5, RawEventType::ProviderRequestBuilt),
	]);
	expected.insert("asm_00000000-0000-4000-8000-000000000002".to_owned(), vec![
		(event_id(11), 11, RawEventType::AssemblyRequested),
		(event_id(12), 12, RawEventType::AssemblyCompleted),
		(event_id(13), 13, RawEventType::ProviderRequestBuilt),
	]);
	expected.insert("asm_00000000-0000-4000-8000-000000000003".to_owned(), vec![
		(event_id(19), 19, RawEventType::AssemblyRequested),
		(event_id(20), 20, RawEventType::AssemblyCompleted),
		(event_id(21), 21, RawEventType::ProviderRequestBuilt),
	]);

	for (asm_id_str, expected_entries) in expected {
		let asm_id = AssembleId::try_from(asm_id_str.clone()).unwrap();
		let entries = index
			.get(&asm_id)
			.unwrap_or_else(|| panic!("trace_index must contain {asm_id_str}"));
		let actual: Vec<(EventId, u64, RawEventType)> = entries
			.iter()
			.map(|entry| (entry.event_id.clone(), entry.session_seq, entry.event_type.clone()))
			.collect();
		assert_eq!(
			actual, expected_entries,
			"assembly {asm_id_str} must associate exactly its three raw events"
		);
	}
}

/// Confirms `PlatformError` is a genuine typed variant, not a stringly-typed
/// escape hatch, for the error paths exercised above.
#[tokio::test]
async fn typed_errors_are_distinguishable_platform_errors() {
	let db = TempDbPath::new("typed-errors");
	let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
	let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();
	let session_id = create_session(&append_store, "typed").await;

	let err: PlatformError = replay_session_snapshot(&append_store, &artifact_store, &session_id)
		.await
		.unwrap_err();
	assert_eq!(err.envelope().code, ProtocolViolationCode::ReplayMismatch.as_str());
}
