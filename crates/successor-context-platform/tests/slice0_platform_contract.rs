//! Route-contract tests for the live `/v0` HTTP surface (lane B6, Wave B
//! gate 3).
//!
//! Exercises the mounted router end to end via `tower::ServiceExt::oneshot`
//! against `successor_context_platform::http::build_router`, proving the
//! full `SLICE-0-CONTRACT.md` §6 endpoint set is wired to the accepted
//! B2-B5 stores and services behind one `SQLite` database identity (Dissent
//! ruling 3).

use std::sync::Arc;

use axum::{
	Router,
	body::{Body, to_bytes},
	http::{Request, StatusCode, header, request},
};
use serde::de::DeserializeOwned;
use successor_context_platform::{
	auth::PlatformLicense, http::build_router, routes::PlatformState,
};
use successor_protocol::{
	artifact::ArtifactV0,
	error::ErrorEnvelopeV0,
	fixtures,
	ids::{ArtifactId, SessionId},
	platform_api::{
		AssembleRequestV0, AssemblyResponseV0, AssemblyTraceV0, CreateSessionRequestV0,
		CreateSessionResponseV0, CreatedByV0, EventPageV0, RawEventAppendResponseV0,
		SessionSnapshotV0, WorkspaceV0,
	},
	raw_event::RawEventV0,
};
use tower::ServiceExt;

const LICENSE: &str = "dev-license-abc123";

const SUCCESSFUL_TURN_FIXTURE: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-successful-turn.\
	 json"
);
const EXPECTED_SESSION_SNAPSHOT: &str = include_str!(
	"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/session-snapshot.json"
);

/// A unique-per-test `SQLite` file path, cleaned up on drop. Every store and
/// service `PlatformState::connect` builds points at this one path, which
/// is the single-database-identity mechanism (Dissent ruling 3) — see
/// `routes.rs`'s module doc for the full rationale.
struct TempDbPath(String);

impl TempDbPath {
	fn new(label: &str) -> Self {
		Self(
			std::env::temp_dir()
				.join(format!("successor-platform-contract-{label}-{}.sqlite3", uuid::Uuid::new_v4()))
				.to_string_lossy()
				.into_owned(),
		)
	}

	fn as_str(&self) -> &str {
		&self.0
	}
}

impl Drop for TempDbPath {
	fn drop(&mut self) {
		for suffix in ["", "-wal", "-shm", "-journal"] {
			let _ = std::fs::remove_file(format!("{}{suffix}", self.0));
		}
	}
}

async fn test_router(label: &str) -> (Router, TempDbPath) {
	let db = TempDbPath::new(label);
	let state = PlatformState::connect(db.as_str())
		.await
		.expect("connect platform state");
	(build_router(PlatformLicense::new(LICENSE), Arc::new(state)), db)
}

fn authorized(builder: request::Builder) -> request::Builder {
	builder.header(header::AUTHORIZATION, format!("Bearer {LICENSE}"))
}

async fn send_json<T: serde::Serialize + Sync>(
	router: &Router,
	method: &str,
	uri: &str,
	body: &T,
) -> axum::response::Response {
	let request = authorized(Request::builder().method(method).uri(uri))
		.header(header::CONTENT_TYPE, "application/json")
		.body(Body::from(serde_json::to_vec(body).expect("serialize body")))
		.expect("build request");
	router
		.clone()
		.oneshot(request)
		.await
		.expect("router call must not fail")
}

async fn send_raw(
	router: &Router,
	method: &str,
	uri: &str,
	raw_body: &str,
) -> axum::response::Response {
	let request = authorized(Request::builder().method(method).uri(uri))
		.header(header::CONTENT_TYPE, "application/json")
		.body(Body::from(raw_body.to_owned()))
		.expect("build request");
	router
		.clone()
		.oneshot(request)
		.await
		.expect("router call must not fail")
}

async fn get(router: &Router, uri: &str) -> axum::response::Response {
	let request = authorized(Request::builder().method("GET").uri(uri))
		.body(Body::empty())
		.expect("build request");
	router
		.clone()
		.oneshot(request)
		.await
		.expect("router call must not fail")
}

async fn json_body<T: DeserializeOwned>(response: axum::response::Response) -> T {
	let status = response.status();
	let bytes = to_bytes(response.into_body(), usize::MAX)
		.await
		.expect("buffer body");
	serde_json::from_slice(&bytes).unwrap_or_else(|err| {
		panic!(
			"body did not deserialize as expected (status {status}): {err}\n{}",
			String::from_utf8_lossy(&bytes)
		)
	})
}

async fn error_envelope(response: axum::response::Response) -> ErrorEnvelopeV0 {
	json_body(response).await
}

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
	to_bytes(response.into_body(), usize::MAX)
		.await
		.expect("buffer body")
		.to_vec()
}

/// B6 drift-hardening (task 157): the reusable assertion that an error
/// response's raw body — not just the parsed `ErrorEnvelopeV0`'s `message`
/// field — never echoes a caller-supplied secret. `serde_json`'s native
/// error text (before `routes.rs::decode_body` redacts it) can embed raw
/// field names and values, so this checks the full byte stream the caller
/// receives, not just one struct field.
fn assert_body_never_contains(body: &[u8], secrets: &[&str]) {
	let text = String::from_utf8_lossy(body);
	for secret in secrets {
		assert!(
			!text.contains(secret),
			"error envelope body leaked a caller-supplied secret {secret:?}: {text}"
		);
	}
}

fn create_session_request(label: &str) -> CreateSessionRequestV0 {
	CreateSessionRequestV0 {
		workspace:  WorkspaceV0 {
			id:        format!("ws_{label}"),
			label:     format!("workspace-{label}"),
			root_hint: "/tmp/workspace".to_owned(),
		},
		title:      format!("session-{label}"),
		created_by: CreatedByV0 {
			client_kind: "cli".to_owned(),
			client_id:   "route-contract-test".to_owned(),
		},
	}
}

async fn create_session(router: &Router, label: &str) -> SessionId {
	let response = send_json(router, "POST", "/v0/sessions", &create_session_request(label)).await;
	assert_eq!(response.status(), StatusCode::OK, "create session must succeed");
	let body: CreateSessionResponseV0 = json_body(response).await;
	body.session_id
}

/// Posts every event in the canonical successful-turn fixture to
/// `POST /v0/events` for `session_id`, rewriting `session_id` and dropping
/// the platform-assigned `session_seq` field (present on the fixture's
/// `RawEventV0` shape, absent from the `RawEventAppendRequestV0` request
/// shape) — the same fixture-to-request transform the B4/B5 test suites
/// already use. Returns the append responses plus every
/// `(artifact_id, original_inline_content)` pair the fixture carries, for
/// the byte-exact artifact-fetch assertion.
async fn append_fixture_stream(
	router: &Router,
	session_id: &SessionId,
) -> (Vec<RawEventAppendResponseV0>, Vec<(ArtifactId, String)>) {
	let events: Vec<serde_json::Value> =
		serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture must parse");
	let mut responses = Vec::with_capacity(events.len());
	let mut stored_artifacts = Vec::new();
	for mut event in events {
		let original_content = event
			.get("artifact")
			.and_then(|artifact| artifact.get("content"))
			.and_then(|c| c.as_str())
			.map(str::to_owned);
		if let serde_json::Value::Object(map) = &mut event {
			map.remove("session_seq");
			map.insert(
				"session_id".to_owned(),
				serde_json::Value::String(session_id.as_str().to_owned()),
			);
		}
		let response = send_json(router, "POST", "/v0/events", &event).await;
		assert_eq!(response.status(), StatusCode::OK, "append must succeed for {event}");
		let response: RawEventAppendResponseV0 = json_body(response).await;
		if let (Some(artifact_id), Some(content)) = (response.artifact_id.clone(), original_content) {
			stored_artifacts.push((artifact_id, content));
		}
		responses.push(response);
	}
	(responses, stored_artifacts)
}

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

fn assemble_request_for(fixture: AssembleRequestV0, session_id: &SessionId) -> AssembleRequestV0 {
	AssembleRequestV0 { session_id: session_id.clone(), ..fixture }
}

/// Compares an actual assemble response to its canonical fixture response,
/// tolerant of the identifiers/timestamps the platform freshly mints on
/// every call (`assemble_id`, `context_item_id`, `trace_id`, `created_at`,
/// stage timestamps) — the same tolerance the B5 `slice0_assembly.rs` suite
/// already establishes for the underlying `AssemblyServiceV0::assemble`
/// this route wraps unmodified.
fn assert_assemble_response_matches_fixture(
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
	assert_eq!(
		actual.context_items.len(),
		expected.context_items.len(),
		"context item count must match the fixture"
	);
	for (actual_item, expected_item) in actual.context_items.iter().zip(&expected.context_items) {
		assert!(
			actual_item.context_item_id.as_str().starts_with("ctx_"),
			"context_item_id must carry the ctx_ prefix"
		);
		assert_eq!(actual_item.source_envelope_id, expected_item.source_envelope_id);
		assert_eq!(actual_item.artifact_id, expected_item.artifact_id);
		assert_eq!(actual_item.source_kind, expected_item.source_kind);
		assert_eq!(actual_item.title, expected_item.title);
		assert_eq!(actual_item.rendered_text, expected_item.rendered_text);
		assert_eq!(actual_item.token_estimate, expected_item.token_estimate);
		assert_eq!(actual_item.included, expected_item.included);
		assert_eq!(actual_item.recovery, expected_item.recovery);
	}
	assert!(
		actual.trace.trace_id.as_str().starts_with("trace_"),
		"trace_id must carry the trace_ prefix"
	);
	assert_eq!(actual.trace.assemble_id, actual.assemble_id);
	assert_eq!(actual.trace.query, expected.trace.query);
	assert_eq!(actual.trace.projection_version, expected.trace.projection_version);
	assert_eq!(
		actual.trace.stages.len(),
		expected.trace.stages.len(),
		"stage count must match the fixture"
	);
	for (actual_stage, expected_stage) in actual.trace.stages.iter().zip(&expected.trace.stages) {
		assert_eq!(actual_stage.name, expected_stage.name);
		assert_eq!(actual_stage.input_count, expected_stage.input_count);
		assert_eq!(actual_stage.output_count, expected_stage.output_count);
		assert_eq!(actual_stage.notes, expected_stage.notes);
	}
	assert_eq!(actual.trace.dropped, expected.trace.dropped);
	assert_eq!(actual.degradation, expected.degradation);
	assert_eq!(actual.policy, expected.policy);
}

/// Every one of the eight contract §6 endpoints must reject both a missing
/// bearer and a wrong bearer with 401, before any handler logic runs — the
/// mount must not weaken the B1 auth layer.
#[tokio::test]
async fn every_endpoint_401s_without_and_with_wrong_bearer() {
	let (router, _db) = test_router("auth-matrix").await;
	let endpoints: &[(&str, &str)] = &[
		("POST", "/v0/sessions"),
		("POST", "/v0/events"),
		("GET", "/v0/sessions/ses_00000000000000000000000000000000/events"),
		("GET", "/v0/events/evt_00000000000000000000000000000000"),
		("GET", "/v0/artifacts/art_00000000000000000000000000000000"),
		("GET", "/v0/sessions/ses_00000000000000000000000000000000/snapshot"),
		("POST", "/v0/assemble"),
		("GET", "/v0/traces/asm_00000000000000000000000000000000"),
	];

	for (method, uri) in endpoints {
		let request = Request::builder()
			.method(*method)
			.uri(*uri)
			.body(Body::empty())
			.unwrap();
		let response = router.clone().oneshot(request).await.unwrap();
		assert_eq!(
			response.status(),
			StatusCode::UNAUTHORIZED,
			"{method} {uri} without any Authorization header"
		);

		let request = Request::builder()
			.method(*method)
			.uri(*uri)
			.header(header::AUTHORIZATION, "Bearer not-the-configured-license")
			.body(Body::empty())
			.unwrap();
		let response = router.clone().oneshot(request).await.unwrap();
		assert_eq!(
			response.status(),
			StatusCode::UNAUTHORIZED,
			"{method} {uri} with a wrong bearer token"
		);
	}
}

/// The single end-to-end proof for Dissent ruling 3: one `PlatformState`
/// serving append, artifact storage, event paging, single-event fetch,
/// snapshot replay, and assemble all observes the same underlying data.
#[tokio::test]
async fn full_pipeline_observes_one_database_identity_across_append_artifact_replay_and_assemble() {
	let (router, _db) = test_router("full-pipeline").await;

	let session_id = create_session(&router, "full-pipeline").await;
	let (append_responses, stored_artifacts) = append_fixture_stream(&router, &session_id).await;
	assert!(!append_responses.is_empty(), "fixture must carry at least one event");
	assert!(
		append_responses.iter().all(|response| !response.duplicate),
		"first append of every event must not be a replay"
	);

	// --- event page paging: after_seq / limit (contract §6.3) ---
	let first_page: EventPageV0 = json_body(
		get(&router, &format!("/v0/sessions/{}/events?limit=1", session_id.as_str())).await,
	)
	.await;
	assert_eq!(first_page.events.len(), 1);
	assert_eq!(first_page.session_id, session_id);
	assert!(first_page.has_more, "the fixture stream carries more than one event");

	let full_page: EventPageV0 = json_body(
		get(&router, &format!("/v0/sessions/{}/events?after_seq=0&limit=1000", session_id.as_str()))
			.await,
	)
	.await;
	assert_eq!(full_page.events.len(), append_responses.len());
	assert!(!full_page.has_more);

	// --- single event fetch (contract §6.4) ---
	let first_event_id = full_page.events[0].event_id.clone();
	let fetched_event: RawEventV0 =
		json_body(get(&router, &format!("/v0/events/{}", first_event_id.as_str())).await).await;
	assert_eq!(fetched_event.event_id, first_event_id);
	assert_eq!(fetched_event.session_id, session_id);

	// --- artifact fetch byte-exact (contract §6.5) ---
	let (artifact_id, expected_content) = stored_artifacts
		.first()
		.expect("the successful-turn fixture stores at least one inline artifact");
	let stored_artifact: ArtifactV0 =
		json_body(get(&router, &format!("/v0/artifacts/{}", artifact_id.as_str())).await).await;
	assert_eq!(&stored_artifact.artifact_id, artifact_id);
	assert_eq!(
		stored_artifact.content,
		Some(serde_json::Value::String(expected_content.clone())),
		"artifact content served through the route must round-trip byte-exact"
	);

	// --- snapshot equals the canonical fixture modulo session_id (contract §6.6)
	// ---
	let snapshot: SessionSnapshotV0 =
		json_body(get(&router, &format!("/v0/sessions/{}/snapshot", session_id.as_str())).await)
			.await;
	assert_eq!(snapshot, expected_snapshot_for(&session_id));

	// --- assemble: both canonical fixture requests (contract §6.7) ---
	let pre_tool_request = assemble_request_for(fixtures::assemble_request_pre_tool(), &session_id);
	let pre_tool_response: AssemblyResponseV0 =
		json_body(send_json(&router, "POST", "/v0/assemble", &pre_tool_request).await).await;
	assert_assemble_response_matches_fixture(
		&pre_tool_response,
		&fixtures::assemble_response_pre_tool(),
		&session_id,
	);
	assert!(pre_tool_response.context_items.is_empty(), "pre_tool must yield zero context items");

	let post_read_request =
		assemble_request_for(fixtures::assemble_request_post_read(), &session_id);
	let post_read_response: AssemblyResponseV0 =
		json_body(send_json(&router, "POST", "/v0/assemble", &post_read_request).await).await;
	assert_assemble_response_matches_fixture(
		&post_read_response,
		&fixtures::assemble_response_post_read(),
		&session_id,
	);

	// --- trace fetch is consistent with the assemble response's own trace
	// (contract §6.8) ---
	let fetched_trace: AssemblyTraceV0 = json_body(
		get(&router, &format!("/v0/traces/{}", post_read_response.assemble_id.as_str())).await,
	)
	.await;
	assert_eq!(
		fetched_trace, post_read_response.trace,
		"GET /v0/traces/{{assemble_id}} must match the trace returned inline by assemble"
	);
}

/// Replaying the identical append request (same idempotency key, same
/// payload) must surface `duplicate: true` through the route, not error
/// and not silently create a second event.
#[tokio::test]
async fn idempotent_append_replay_returns_duplicate_true_through_the_route() {
	let (router, _db) = test_router("idempotent-replay").await;
	let session_id = create_session(&router, "idempotent-replay").await;

	let events: Vec<serde_json::Value> =
		serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture must parse");
	let mut first_event = events
		.into_iter()
		.next()
		.expect("fixture has at least one event");
	if let serde_json::Value::Object(map) = &mut first_event {
		map.remove("session_seq");
		map.insert(
			"session_id".to_owned(),
			serde_json::Value::String(session_id.as_str().to_owned()),
		);
	}

	let first_response: RawEventAppendResponseV0 =
		json_body(send_json(&router, "POST", "/v0/events", &first_event).await).await;
	assert!(!first_response.duplicate, "first append must not be reported as a replay");

	let second_response: RawEventAppendResponseV0 =
		json_body(send_json(&router, "POST", "/v0/events", &first_event).await).await;
	assert!(
		second_response.duplicate,
		"replaying the identical append request must be reported as a duplicate"
	);
	assert_eq!(second_response.event_id, first_response.event_id);
	assert_eq!(second_response.session_seq, first_response.session_seq);
}

/// `CreateSessionRequestV0` and `AssembleRequestV0` reject an unknown
/// top-level field with a 400-class `ErrorEnvelopeV0` (the A2 reopen);
/// `RawEventAppendRequestV0` already rejects unknown fields via its
/// hand-rolled `Deserialize` (no reopen needed there).
#[tokio::test]
async fn unknown_top_level_fields_are_rejected_with_a_400_class_error_envelope_on_every_post_body()
{
	let (router, _db) = test_router("unknown-fields").await;
	let session_id = create_session(&router, "unknown-fields-seed").await;

	let mut session_value =
		serde_json::to_value(create_session_request("unknown-fields-2")).unwrap();
	session_value
		.as_object_mut()
		.unwrap()
		.insert("unexpected".to_owned(), serde_json::json!(true));
	let response = send_json(&router, "POST", "/v0/sessions", &session_value).await;
	assert_eq!(
		response.status(),
		StatusCode::BAD_REQUEST,
		"unknown field on CreateSessionRequestV0"
	);
	error_envelope(response).await;

	let events: Vec<serde_json::Value> =
		serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture must parse");
	let mut event = events
		.into_iter()
		.next()
		.expect("fixture has at least one event");
	if let serde_json::Value::Object(map) = &mut event {
		map.remove("session_seq");
		map.insert(
			"session_id".to_owned(),
			serde_json::Value::String(session_id.as_str().to_owned()),
		);
		map.insert("unexpected".to_owned(), serde_json::json!(true));
	}
	let response = send_json(&router, "POST", "/v0/events", &event).await;
	assert_eq!(
		response.status(),
		StatusCode::BAD_REQUEST,
		"unknown field on RawEventAppendRequestV0"
	);
	error_envelope(response).await;

	let mut assemble_value = serde_json::to_value(assemble_request_for(
		fixtures::assemble_request_pre_tool(),
		&session_id,
	))
	.unwrap();
	assemble_value
		.as_object_mut()
		.unwrap()
		.insert("unexpected".to_owned(), serde_json::json!(true));
	let response = send_json(&router, "POST", "/v0/assemble", &assemble_value).await;
	assert_eq!(response.status(), StatusCode::BAD_REQUEST, "unknown field on AssembleRequestV0");
	error_envelope(response).await;
}

/// Unknown but well-formed session/event/artifact/assemble ids return a
/// typed `ErrorEnvelopeV0` with the contract §4.2 not-found status, on
/// every endpoint that can be asked about an id that doesn't exist.
#[tokio::test]
async fn unknown_ids_return_typed_not_found_envelopes() {
	let (router, _db) = test_router("not-found").await;

	let response = get(&router, "/v0/events/evt_00000000000000000000000000000000").await;
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");

	let response = get(&router, "/v0/artifacts/art_00000000000000000000000000000000").await;
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");

	let response = get(&router, "/v0/sessions/ses_00000000000000000000000000000000/snapshot").await;
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");

	let response = get(&router, "/v0/sessions/ses_00000000000000000000000000000000/events").await;
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");

	let response = get(&router, "/v0/traces/asm_00000000000000000000000000000000").await;
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");

	let unknown_session =
		SessionId::try_from("ses_00000000000000000000000000000000".to_owned()).unwrap();
	let unknown_session_assemble =
		assemble_request_for(fixtures::assemble_request_pre_tool(), &unknown_session);
	let response = send_json(&router, "POST", "/v0/assemble", &unknown_session_assemble).await;
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");
}

/// A malformed JSON body must never hang the request or fall through to
/// axum's untyped default rejection — every POST body decode path in
/// `routes.rs` uses the same `PlatformError` / `ErrorEnvelopeV0` shape.
#[tokio::test]
async fn malformed_json_body_returns_a_typed_error_envelope_not_a_hang_or_default_error() {
	let (router, _db) = test_router("malformed-json").await;

	let response = send_raw(&router, "POST", "/v0/sessions", "{ this is not valid json").await;
	assert_eq!(response.status(), StatusCode::BAD_REQUEST);
	let body = body_bytes(response).await;
	assert_body_never_contains(&body, &["this is not valid json"]);
	assert_eq!(
		serde_json::from_slice::<ErrorEnvelopeV0>(&body)
			.expect("typed error envelope")
			.code,
		"validation_failed"
	);

	let response = send_raw(&router, "POST", "/v0/events", "not even a json value").await;
	assert_eq!(response.status(), StatusCode::BAD_REQUEST);
	let body = body_bytes(response).await;
	assert_body_never_contains(&body, &["not even a json value"]);
	assert_eq!(
		serde_json::from_slice::<ErrorEnvelopeV0>(&body)
			.expect("typed error envelope")
			.code,
		"validation_failed"
	);

	let response = send_raw(&router, "POST", "/v0/assemble", "[1, 2, 3]").await;
	assert_eq!(response.status(), StatusCode::BAD_REQUEST);
	assert_eq!(error_envelope(response).await.code, "validation_failed");
}

/// Mounting the full §6 endpoint set must not weaken the B1 auth/fallback
/// layer for genuinely unmatched `/v0` paths.
#[tokio::test]
async fn unknown_v0_path_401s_unauthenticated_and_404s_authenticated() {
	let (router, _db) = test_router("unknown-path").await;

	let request = Request::builder()
		.uri("/v0/not/a/real/route")
		.body(Body::empty())
		.unwrap();
	let response = router.clone().oneshot(request).await.unwrap();
	assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

	let request = authorized(Request::builder().uri("/v0/not/a/real/route"))
		.body(Body::empty())
		.unwrap();
	let response = router.clone().oneshot(request).await.unwrap();
	assert_eq!(response.status(), StatusCode::NOT_FOUND);
	assert_eq!(error_envelope(response).await.code, "not_found");
}

/// B6 drift-hardening (task 157): an unknown field nested under a request's
/// `workspace` or `budget` object — not just a top-level field — must be
/// rejected (the A2 reopen extends `#[serde(deny_unknown_fields)]` onto
/// `WorkspaceV0`, `CreatedByV0`, `AssembleIntentV0`, `AssembleWorkspaceV0`,
/// and `AssemblyBudgetV0`). Because a credential pasted as a JSON key or
/// value nested that deeply is exactly the shape a leaked provider token
/// would take, the rejection's `ErrorEnvelopeV0` body must never echo the
/// field name or its value (task 155 P1/P2: `decode_body` must not embed
/// `serde_json`'s raw error text).
#[tokio::test]
async fn nested_unknown_credential_shaped_field_is_rejected_without_echoing_the_secret() {
	let (router, _db) = test_router("nested-unknown-fields").await;
	let session_id = create_session(&router, "nested-unknown-fields-seed").await;

	let secret_key = "api_key";
	let secret_value = "sk-test-nested-secret-should-never-echo";

	let mut session_value =
		serde_json::to_value(create_session_request("nested-unknown-fields-2")).unwrap();
	session_value["workspace"]
		.as_object_mut()
		.expect("workspace object")
		.insert(secret_key.to_owned(), serde_json::json!(secret_value));
	let response = send_json(&router, "POST", "/v0/sessions", &session_value).await;
	assert_eq!(response.status(), StatusCode::BAD_REQUEST, "unknown field nested under workspace");
	let body = body_bytes(response).await;
	assert_body_never_contains(&body, &[secret_key, secret_value]);
	serde_json::from_slice::<ErrorEnvelopeV0>(&body).expect("typed error envelope");

	let mut assemble_value = serde_json::to_value(assemble_request_for(
		fixtures::assemble_request_pre_tool(),
		&session_id,
	))
	.unwrap();
	assemble_value["budget"]
		.as_object_mut()
		.expect("budget object")
		.insert(secret_key.to_owned(), serde_json::json!(secret_value));
	let response = send_json(&router, "POST", "/v0/assemble", &assemble_value).await;
	assert_eq!(response.status(), StatusCode::BAD_REQUEST, "unknown field nested under budget");
	let body = body_bytes(response).await;
	assert_body_never_contains(&body, &[secret_key, secret_value]);
	serde_json::from_slice::<ErrorEnvelopeV0>(&body).expect("typed error envelope");
}

/// B6 drift-hardening (task 157): a provider-key-shaped bearer token — the
/// shape `auth.rs::looks_like_provider_credential` rejects on the platform
/// auth boundary — must 401 without ever echoing the presented token into
/// the error body.
#[tokio::test]
async fn provider_key_shaped_bearer_is_rejected_401_without_echoing_the_token() {
	let (router, _db) = test_router("provider-key-bearer").await;
	let token = "sk-ant-api03-nested-secret-should-never-echo-0000000000000000";

	let request = Request::builder()
		.method("POST")
		.uri("/v0/sessions")
		.header(header::AUTHORIZATION, format!("Bearer {token}"))
		.header(header::CONTENT_TYPE, "application/json")
		.body(Body::from(serde_json::to_vec(&create_session_request("provider-key-bearer")).unwrap()))
		.unwrap();
	let response = router.clone().oneshot(request).await.unwrap();
	assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "provider-key-shaped bearer");
	let body = body_bytes(response).await;
	assert_body_never_contains(&body, &[token]);
	serde_json::from_slice::<ErrorEnvelopeV0>(&body).expect("typed error envelope");
}
