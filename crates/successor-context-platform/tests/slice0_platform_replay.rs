//! Lane D2 `BlackBoxIntegrationSmoke`: platform-store surfaces owned by this
//! file (per `agent://243-D2PreExecutionDissent`): raw `SQLite` DB/WAL/SHM
//! bytes, replay/snapshot JSON, artifact payloads, and trace-index bytes,
//! all scanned for the lane's two canonical credential sentinels; plus the
//! zero-event-session 422 inheritance held over real HTTP (complementing
//! `slice0_replay.rs`'s store-level-only assertion of the same invariant).
//!
//! The `PlatformLicense` used to authorize every write below is itself a
//! credential sentinel (the platform-side analogue of `MEMEX_LICENSE`): it
//! is presented on every single request in this file, so if it ever leaked
//! into persisted content or a read-surface, these scans would catch it.

use std::path::PathBuf;

use axum::{
	body::Body,
	http::{Request, StatusCode, header::AUTHORIZATION},
};
use successor_context_platform::{
	auth::PlatformLicense, http::build_router, routes::PlatformState, sqlite::SqliteAppendStore,
	store::RawEventAppendStore, trace_index::build_trace_index,
};
use successor_protocol::{
	ids::SessionId,
	platform_api::{CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0},
};
use tower::ServiceExt;

const SENTINEL_LICENSE: &str = "d2-memex-license-sentinel-do-not-leak-platform-replay";
const SENTINEL_ANTHROPIC_KEY: &str = "sk-ant-d2-sentinel-do-not-leak-platform-replay9f3c1a2b";

const SUCCESSFUL_TURN_FIXTURE: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-successful-turn.\
	 json"
);

/// A unique temporary `SQLite` file path. Mirrors the `TempDbPath` pattern
/// used throughout the accepted Slice 0 suites.
fn temp_db_path(label: &str) -> PathBuf {
	let unique = uuid::Uuid::new_v4();
	std::env::temp_dir().join(format!("d2-platform-replay-{label}-{unique}.sqlite3"))
}

fn cleanup_sqlite_files(path: &std::path::Path) {
	for suffix in ["", "-wal", "-shm"] {
		let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
	}
}

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
	axum::body::to_bytes(response.into_body(), usize::MAX)
		.await
		.expect("collect the response body")
		.to_vec()
}

fn assert_never_leaks(surface: &str, bytes: &[u8]) {
	let text = String::from_utf8_lossy(bytes);
	assert!(
		!text.contains(SENTINEL_LICENSE),
		"{surface} leaked the platform license sentinel: {text}"
	);
	assert!(
		!text.contains(SENTINEL_ANTHROPIC_KEY),
		"{surface} leaked the anthropic key sentinel: {text}"
	);
}

fn auth_request(method: &str, uri: &str, body: Vec<u8>) -> Request<Body> {
	Request::builder()
		.method(method)
		.uri(uri)
		.header("content-type", "application/json")
		.header(AUTHORIZATION, format!("Bearer {SENTINEL_LICENSE}"))
		.body(Body::from(body))
		.expect("build an authorized request")
}

// ---------------------------------------------------------------------
// Full platform-store surface leak scan: create a session, append the
// canonical fixture stream over real HTTP, persist its two inline artifacts
// directly against the same on-disk store (Slice 0 has no HTTP write path
// for artifact content), then read everything back over real HTTP -- and
// scan raw SQLite DB/WAL/SHM bytes after an explicit checkpoint. Everything
// above is authorized with the sentinel license on every single call.
// ---------------------------------------------------------------------

#[tokio::test]
async fn platform_http_and_raw_sqlite_surfaces_never_leak_the_sentinel_license_or_credential() {
	let db_path = temp_db_path("leak-scan");
	let db_str = db_path.to_str().expect("utf-8 temp db path").to_owned();
	let state = PlatformState::connect(&db_str)
		.await
		.expect("connect real temp sqlite store");
	let router = build_router(PlatformLicense::new(SENTINEL_LICENSE), std::sync::Arc::new(state));

	let mut all_bytes: Vec<u8> = Vec::new();

	// 1. create_session
	let create_body = serde_json::to_vec(&CreateSessionRequestV0 {
		workspace:  WorkspaceV0 {
			id:        "workspace_d2".to_owned(),
			label:     "d2-platform-replay".to_owned(),
			root_hint: "/tmp/d2-platform-replay".to_owned(),
		},
		title:      "D2 platform replay leak scan".to_owned(),
		created_by: CreatedByV0 { client_kind: "test".to_owned(), client_id: "d2".to_owned() },
	})
	.expect("serialize create_session body");
	let create_response = router
		.clone()
		.oneshot(auth_request("POST", "/v0/sessions", create_body))
		.await
		.expect("create_session does not panic");
	assert!(create_response.status().is_success(), "create_session must succeed");
	let create_bytes = body_bytes(create_response).await;
	all_bytes.extend_from_slice(&create_bytes);
	let created: serde_json::Value =
		serde_json::from_slice(&create_bytes).expect("create_session response is json");
	let session_id: SessionId = created["session_id"]
		.as_str()
		.expect("session_id is a string")
		.to_owned()
		.try_into()
		.expect("well-formed session_id");

	// 2. append the canonical fixture stream (rewriting session_id to match), over
	//    real HTTP, authorized with the sentinel license each time.
	let mut fixture_events: Vec<serde_json::Value> =
		serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture parses as a json array");
	for event in &mut fixture_events {
		if let serde_json::Value::Object(map) = event {
			map.remove("session_seq");
			map.insert(
				"session_id".to_owned(),
				serde_json::Value::String(session_id.as_str().to_owned()),
			);
		}
	}
	// `append_event`'s route handler atomically persists any inline
	// artifact content alongside the raw event itself (see
	// `routes.rs::append_event`): there is no separate HTTP write path for
	// artifact content, and no separate direct-store call is needed either.
	let mut artifact_ids: Vec<successor_protocol::ids::ArtifactId> = Vec::new();
	for event in fixture_events {
		let request: RawEventAppendRequestV0 = serde_json::from_value(event.clone())
			.expect("fixture event deserializes as an append request");
		if let Some(artifact_id) = request.entity_ids.artifact_id.clone() {
			artifact_ids.push(artifact_id);
		}

		let append_body = serde_json::to_vec(&event).expect("serialize fixture event");
		let append_response = router
			.clone()
			.oneshot(auth_request("POST", "/v0/events", append_body))
			.await
			.expect("append_event does not panic");
		assert!(append_response.status().is_success(), "fixture append must succeed");
		all_bytes.extend_from_slice(&body_bytes(append_response).await);
	}
	assert_eq!(
		artifact_ids.len(),
		2,
		"canonical successful-turn fixture must carry exactly two inline artifacts"
	);

	// 3. read_session_events
	let events_response = router
		.clone()
		.oneshot(
			Request::builder()
				.method("GET")
				.uri(format!("/v0/sessions/{}/events", session_id.as_str()))
				.header(AUTHORIZATION, format!("Bearer {SENTINEL_LICENSE}"))
				.body(Body::empty())
				.expect("build read_session_events request"),
		)
		.await
		.expect("read_session_events does not panic");
	assert!(events_response.status().is_success());
	all_bytes.extend_from_slice(&body_bytes(events_response).await);

	// 4. read_snapshot (exercises replay end to end over http)
	let snapshot_response = router
		.clone()
		.oneshot(
			Request::builder()
				.method("GET")
				.uri(format!("/v0/sessions/{}/snapshot", session_id.as_str()))
				.header(AUTHORIZATION, format!("Bearer {SENTINEL_LICENSE}"))
				.body(Body::empty())
				.expect("build read_snapshot request"),
		)
		.await
		.expect("read_snapshot does not panic");
	assert!(snapshot_response.status().is_success(), "snapshot of a populated session must succeed");
	all_bytes.extend_from_slice(&body_bytes(snapshot_response).await);

	// 5. read_artifact, for both persisted artifacts.
	for artifact_id in &artifact_ids {
		let artifact_response = router
			.clone()
			.oneshot(
				Request::builder()
					.method("GET")
					.uri(format!("/v0/artifacts/{}", artifact_id.as_str()))
					.header(AUTHORIZATION, format!("Bearer {SENTINEL_LICENSE}"))
					.body(Body::empty())
					.expect("build read_artifact request"),
			)
			.await
			.expect("read_artifact does not panic");
		assert!(artifact_response.status().is_success(), "read_artifact must succeed");
		all_bytes.extend_from_slice(&body_bytes(artifact_response).await);
	}

	// 6. an auth-failure path (wrong bearer token): the highest-risk surface for
	//    accidentally echoing the presented or expected credential.
	let auth_failure_response = router
		.clone()
		.oneshot(
			Request::builder()
				.method("GET")
				.uri(format!("/v0/sessions/{}/snapshot", session_id.as_str()))
				.header(AUTHORIZATION, "Bearer wrong-token")
				.body(Body::empty())
				.expect("build an unauthorized request"),
		)
		.await
		.expect("auth failure does not panic");
	assert_eq!(auth_failure_response.status(), StatusCode::UNAUTHORIZED);
	all_bytes.extend_from_slice(&body_bytes(auth_failure_response).await);

	assert_never_leaks("aggregate platform http surfaces", &all_bytes);

	// Force a WAL checkpoint via a fresh connection to the same on-disk
	// file, then read raw bytes. WAL/SHM sidecars may or may not survive a
	// checkpoint (SQLite may fully fold and remove them, or leave a
	// zero-length sidecar behind), so scan them conditionally.
	{
		let checkpoint_pool = sqlx::sqlite::SqlitePoolOptions::new()
			.max_connections(1)
			.connect(&db_str)
			.await
			.expect("open a raw checkpoint connection to the same db file");
		sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
			.execute(&checkpoint_pool)
			.await
			.expect("checkpoint the wal into the main db file");
		checkpoint_pool.close().await;
	}

	let db_bytes = std::fs::read(&db_path).expect("read the raw main sqlite db file");
	assert_never_leaks("raw sqlite db file bytes", &db_bytes);
	for suffix in ["-wal", "-shm"] {
		let sidecar_path = PathBuf::from(format!("{}{suffix}", db_path.display()));
		if let Ok(sidecar_bytes) = std::fs::read(&sidecar_path) {
			assert_never_leaks(&format!("raw sqlite {suffix} sidecar bytes"), &sidecar_bytes);
		}
	}

	cleanup_sqlite_files(&db_path);
}

// ---------------------------------------------------------------------
// Trace-index bytes: the pure `build_trace_index` projection over the same
// fixture stream, scanned independently of any HTTP surface.
// ---------------------------------------------------------------------

#[tokio::test]
async fn trace_index_bytes_never_leak_the_sentinel_license_or_credential() {
	let db_path = temp_db_path("trace-index");
	let db_str = db_path.to_str().expect("utf-8 temp db path").to_owned();
	let append_store = SqliteAppendStore::connect(&db_str)
		.await
		.expect("connect a real temp sqlite append store");

	let session = append_store
		.create_session(CreateSessionRequestV0 {
			workspace:  WorkspaceV0 {
				id:        "workspace_d2_trace".to_owned(),
				label:     "d2-trace-index".to_owned(),
				root_hint: "/tmp/d2-trace-index".to_owned(),
			},
			title:      "D2 trace index leak scan".to_owned(),
			created_by: CreatedByV0 { client_kind: "test".to_owned(), client_id: "d2".to_owned() },
		})
		.await
		.expect("create_session must succeed");

	let mut fixture_events: Vec<serde_json::Value> =
		serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture parses as a json array");
	for event in &mut fixture_events {
		if let serde_json::Value::Object(map) = event {
			map.remove("session_seq");
			map.insert(
				"session_id".to_owned(),
				serde_json::Value::String(session.session_id.as_str().to_owned()),
			);
		}
	}
	let mut persisted = Vec::new();
	for event in fixture_events {
		let request: RawEventAppendRequestV0 =
			serde_json::from_value(event).expect("fixture event deserializes as an append request");
		let response = append_store
			.append_event(request)
			.await
			.expect("fixture append must succeed");
		let page = append_store
			.read_session_events(&session.session_id, 0, 100)
			.await
			.expect("read back appended events");
		if let Some(found) = page
			.events
			.iter()
			.find(|e| e.session_seq == response.session_seq)
		{
			persisted.push(found.clone());
		}
	}

	let index = build_trace_index(&persisted);
	let rendered = format!("{index:?}");
	assert_never_leaks("trace-index debug rendering", rendered.as_bytes());

	cleanup_sqlite_files(&db_path);
}

// ---------------------------------------------------------------------
// Zero-event-session 422 inheritance, held over real HTTP (the store-level
// invariant of the same name is already covered by
// `slice0_replay.rs::replay_of_empty_session_returns_typed_error_not_panic`;
// this proves the HTTP status code itself inherits correctly).
// ---------------------------------------------------------------------

#[tokio::test]
async fn snapshot_of_a_zero_event_session_returns_422_over_http() {
	let db_path = temp_db_path("zero-event-422");
	let db_str = db_path.to_str().expect("utf-8 temp db path").to_owned();
	let state = PlatformState::connect(&db_str)
		.await
		.expect("connect real temp sqlite store");
	let router = build_router(PlatformLicense::new(SENTINEL_LICENSE), std::sync::Arc::new(state));

	let create_body = serde_json::to_vec(&CreateSessionRequestV0 {
		workspace:  WorkspaceV0 {
			id:        "workspace_d2_422".to_owned(),
			label:     "d2-zero-event".to_owned(),
			root_hint: "/tmp/d2-zero-event".to_owned(),
		},
		title:      "D2 zero-event 422 inheritance".to_owned(),
		created_by: CreatedByV0 { client_kind: "test".to_owned(), client_id: "d2".to_owned() },
	})
	.expect("serialize create_session body");
	let create_response = router
		.clone()
		.oneshot(auth_request("POST", "/v0/sessions", create_body))
		.await
		.expect("create_session does not panic");
	assert!(create_response.status().is_success());
	let created: serde_json::Value =
		serde_json::from_slice(&body_bytes(create_response).await).expect("create_session json");
	let session_id = created["session_id"]
		.as_str()
		.expect("session_id is a string")
		.to_owned();

	let snapshot_response = router
		.oneshot(
			Request::builder()
				.method("GET")
				.uri(format!("/v0/sessions/{session_id}/snapshot"))
				.header(AUTHORIZATION, format!("Bearer {SENTINEL_LICENSE}"))
				.body(Body::empty())
				.expect("build read_snapshot request"),
		)
		.await
		.expect("read_snapshot does not panic on a zero-event session");
	assert_eq!(
		snapshot_response.status(),
		StatusCode::UNPROCESSABLE_ENTITY,
		"snapshotting a zero-event session must inherit a 422, not panic or succeed"
	);
	let error_bytes = body_bytes(snapshot_response).await;
	let error_body: serde_json::Value =
		serde_json::from_slice(&error_bytes).expect("422 body is a typed error envelope");
	assert!(error_body["code"].is_string());
	assert_never_leaks("zero-event 422 error body", &error_bytes);

	cleanup_sqlite_files(&db_path);
}
