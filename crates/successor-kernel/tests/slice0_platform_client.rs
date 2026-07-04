//! Owned by Lane C1 `KernelPlatformClient`.
//!
//! Integration coverage for `KernelPlatformClient` against the accepted
//! platform router (`successor_context_platform::http::build_router`),
//! bound on `127.0.0.1:0` with a real temporary `SQLite` database and
//! exercised over real TCP (Dissent ruling 2). This file never uses
//! `tower::ServiceExt::oneshot` and never stands up a mock platform
//! server: every request in this file crosses a real socket into the real
//! accepted router.

use std::sync::{
	Arc,
	atomic::{AtomicU64, Ordering},
};

use successor_context_platform::{
	auth::PlatformLicense, http::build_router, routes::PlatformState,
};
use successor_kernel::{
	platform_client::{EntitlementToken, KernelPlatformClient},
	platform_error::PlatformClientError,
};
use successor_protocol::{
	fixtures,
	ids::{ArtifactId, AssembleId, EventId, SessionId},
	platform_api::{
		AssembleIntentV0, AssembleRequestV0, AssembleWorkspaceV0, AssemblyBudgetV0,
		CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0,
	},
	raw_event::{RawEventType, RawEventV0},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LICENSE: &str = "dev-license-c1-integration-abc123";

/// Generates a unique temporary sqlite path using only the standard
/// library (no `uuid` dependency: ruling 1 permits exactly one new
/// dev-dependency, `successor-context-platform`).
fn temp_db_path(label: &str) -> std::path::PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("system clock is after the unix epoch")
		.as_nanos();
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-kernel-c1-{label}-{}-{n}-{nanos}.sqlite3", std::process::id()))
}

/// A live instance of the accepted platform router, bound on
/// `127.0.0.1:0` with a real temporary `SQLite` database, served over a real
/// TCP listener for the lifetime of the test.
struct TestServer {
	base_url: String,
	db_path:  std::path::PathBuf,
	handle:   tokio::task::JoinHandle<()>,
}

impl TestServer {
	async fn start(label: &str) -> Self {
		let db_path = temp_db_path(label);
		let state = PlatformState::connect(db_path.to_str().expect("temp path is valid utf-8"))
			.await
			.expect("connect real temp sqlite db");
		let router = build_router(PlatformLicense::new(LICENSE), Arc::new(state));
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
			.await
			.expect("bind ephemeral tcp port");
		let addr = listener
			.local_addr()
			.expect("bound listener has a local addr");
		let handle = tokio::spawn(async move {
			axum::serve(listener, router)
				.await
				.expect("accepted platform router serves");
		});
		// Contract-faithful base URL: the platform's `/v0` API base (contract
		// §6), not the router root.
		Self { base_url: format!("http://{addr}/v0"), db_path, handle }
	}

	fn client(&self) -> KernelPlatformClient {
		KernelPlatformClient::new(self.base_url.clone(), EntitlementToken::new(LICENSE))
	}

	fn client_with_token(&self, token: &str) -> KernelPlatformClient {
		KernelPlatformClient::new(self.base_url.clone(), EntitlementToken::new(token))
	}
}

impl Drop for TestServer {
	fn drop(&mut self) {
		self.handle.abort();
		let _ = std::fs::remove_file(&self.db_path);
	}
}

fn create_session_request(label: &str) -> CreateSessionRequestV0 {
	CreateSessionRequestV0 {
		workspace:  WorkspaceV0 {
			id:        format!("ws-{label}"),
			label:     format!("workspace-{label}"),
			root_hint: "/workspace".to_owned(),
		},
		title:      format!("session-{label}"),
		created_by: CreatedByV0 {
			client_kind: "kernel".to_owned(),
			client_id:   "c1-integration-test".to_owned(),
		},
	}
}

/// Rebinds a canonical fixture `RawEventV0` onto a freshly created session:
/// every field is carried through verbatim except `session_seq` (assigned
/// by the platform, dropped here) and `session_id` (overridden to the
/// session created by this test — the fixture's own `ses_...0001` does not
/// exist in this test's database).
fn rebind_to_session(event: RawEventV0, session_id: &SessionId) -> RawEventAppendRequestV0 {
	RawEventAppendRequestV0 {
		schema_version:     event.schema_version,
		event_id:           event.event_id,
		idempotency_key:    event.idempotency_key,
		event_type:         event.event_type,
		session_id:         session_id.clone(),
		turn_id:            event.turn_id,
		request_id:         event.request_id,
		occurred_at:        event.occurred_at,
		producer:           event.producer,
		causation_event_id: event.causation_event_id,
		correlation_id:     event.correlation_id,
		entity_ids:         event.entity_ids,
		visibility:         event.visibility,
		redaction:          event.redaction,
		payload:            event.payload,
		artifact:           event.artifact,
	}
}

/// Full happy path: create session, append the canonical fixture events,
/// page through them with `after_seq`/`limit`, fetch a single event, fetch
/// the artifact one of those events carries, read the snapshot, assemble
/// twice, and fetch the resulting traces.
#[tokio::test]
async fn happy_path_covers_every_v0_endpoint() {
	let server = TestServer::start("happy-path").await;
	let client = server.client();

	// 1. create session
	let session = client
		.create_session(&create_session_request("happy-path"))
		.await
		.expect("create_session succeeds");

	// 2. append canonical fixture events, rebound onto the created session
	let fixture_events = fixtures::raw_events_successful_turn();
	assert!(fixture_events.len() > 1, "fixture must carry more than one event to exercise paging");
	let mut appended_event_ids = Vec::new();
	let mut artifact_id: Option<ArtifactId> = None;
	for event in fixture_events.clone() {
		let has_artifact = event.artifact.is_some();
		let request = rebind_to_session(event, &session.session_id);
		let response = client
			.append_event(&request)
			.await
			.expect("append_event succeeds");
		assert!(
			!response.duplicate,
			"first append of a fresh idempotency_key must not be a duplicate"
		);
		appended_event_ids.push(response.event_id.clone());
		if has_artifact {
			artifact_id = response.artifact_id.clone();
		}
	}
	let artifact_id = artifact_id.expect("fixture carries at least one inline artifact");

	// 3. page through events with after_seq/limit, accumulating pages
	let mut collected = Vec::new();
	let mut after_seq = 0u64;
	loop {
		let page = client
			.read_session_events(&session.session_id, Some(after_seq), Some(2))
			.await
			.expect("read_session_events succeeds");
		assert_eq!(page.session_id, session.session_id);
		assert!(page.events.len() <= 2, "limit=2 must be honored");
		let has_more = page.has_more;
		after_seq = page.next_after_seq;
		collected.extend(page.events);
		if !has_more {
			break;
		}
	}
	assert_eq!(
		collected.len(),
		fixture_events.len(),
		"paging must surface every appended event exactly once"
	);
	for (expected, actual) in fixture_events.iter().zip(collected.iter()) {
		assert_eq!(actual.event_id, expected.event_id);
		assert_eq!(actual.event_type, expected.event_type);
		assert_eq!(actual.payload, expected.payload);
		assert_eq!(actual.session_id, session.session_id);
	}

	// 4. fetch a single event
	let first_event_id = appended_event_ids
		.first()
		.expect("at least one event was appended")
		.clone();
	let fetched = client
		.read_event(&first_event_id)
		.await
		.expect("read_event succeeds");
	assert_eq!(fetched.event_id, first_event_id);
	assert_eq!(fetched.session_id, session.session_id);

	// 5. fetch the artifact one of the events carried
	let artifact = client
		.read_artifact(&artifact_id)
		.await
		.expect("read_artifact succeeds");
	assert_eq!(artifact.artifact_id, artifact_id);
	artifact
		.validate_sha256()
		.expect("stored artifact content matches its declared sha256");

	// 6. read the session snapshot
	let snapshot = client
		.read_snapshot(&session.session_id)
		.await
		.expect("read_snapshot succeeds");
	assert_eq!(snapshot.session_id, session.session_id);
	assert_eq!(snapshot.raw_event_ids, appended_event_ids);
	assert_eq!(snapshot.last_raw_event_seq, fixture_events.len() as u64);
	assert!(snapshot.artifact_ids.contains(&artifact_id));

	// 7. assemble twice (pre_tool, then post_read), each against the same
	//    session/turn
	let last_turn_id = snapshot.last_turn_id.clone();
	let pre_tool_request = AssembleRequestV0::new(
		session.session_id.clone(),
		last_turn_id.clone(),
		fixture_events[0].request_id.clone(),
		successor_protocol::platform_api::AssemblePhaseV0::PreTool,
		AssembleIntentV0 {
			query:         "read the config file".to_owned(),
			raw_user_text: "please read the config file".to_owned(),
			confidence:    "high".to_owned(),
		},
		AssembleWorkspaceV0 { root_hint: "/workspace".to_owned(), repo_id: "repo-c1".to_owned() },
		AssemblyBudgetV0 { max_context_tokens: 8_000, max_items: 20 },
	);
	let pre_tool_response = client
		.assemble(&pre_tool_request)
		.await
		.expect("assemble(pre_tool) succeeds");
	assert_eq!(pre_tool_response.session_id, session.session_id);
	assert_eq!(pre_tool_response.turn_id, last_turn_id);
	assert_eq!(pre_tool_response.phase, successor_protocol::platform_api::AssemblePhaseV0::PreTool);

	let post_read_request = AssembleRequestV0::new(
		session.session_id.clone(),
		last_turn_id.clone(),
		fixture_events[0].request_id.clone(),
		successor_protocol::platform_api::AssemblePhaseV0::PostRead,
		AssembleIntentV0 {
			query:         "read the config file".to_owned(),
			raw_user_text: "please read the config file".to_owned(),
			confidence:    "high".to_owned(),
		},
		AssembleWorkspaceV0 { root_hint: "/workspace".to_owned(), repo_id: "repo-c1".to_owned() },
		AssemblyBudgetV0 { max_context_tokens: 8_000, max_items: 20 },
	);
	let post_read_response = client
		.assemble(&post_read_request)
		.await
		.expect("assemble(post_read) succeeds");
	assert_eq!(
		post_read_response.phase,
		successor_protocol::platform_api::AssemblePhaseV0::PostRead
	);

	// 8. fetch both assembly traces
	let pre_tool_trace = client
		.read_trace(&pre_tool_response.assemble_id)
		.await
		.expect("read_trace(pre_tool) succeeds");
	assert_eq!(pre_tool_trace.assemble_id, pre_tool_response.assemble_id);
	assert_eq!(pre_tool_trace, pre_tool_response.trace);

	let post_read_trace = client
		.read_trace(&post_read_response.assemble_id)
		.await
		.expect("read_trace(post_read) succeeds");
	assert_eq!(post_read_trace.assemble_id, post_read_response.assemble_id);
	assert_ne!(
		pre_tool_response.assemble_id, post_read_response.assemble_id,
		"two assemble calls must mint distinct assemble ids"
	);
}

/// Idempotent replay through the client: appending the same event
/// (identical `idempotency_key` + `session_id`) twice returns
/// `duplicate=true` the second time and never creates a second record.
#[tokio::test]
async fn idempotent_append_replay_returns_duplicate_true() {
	let server = TestServer::start("idempotent-replay").await;
	let client = server.client();
	let session = client
		.create_session(&create_session_request("idempotent-replay"))
		.await
		.expect("create_session succeeds");

	let event = fixtures::raw_events_successful_turn()
		.into_iter()
		.next()
		.expect("fixture has events");
	let request = rebind_to_session(event, &session.session_id);

	let first = client
		.append_event(&request)
		.await
		.expect("first append succeeds");
	assert!(!first.duplicate);

	let second = client
		.append_event(&request)
		.await
		.expect("replayed append succeeds");
	assert!(second.duplicate, "replaying the same idempotency_key must return duplicate=true");
	assert_eq!(second.event_id, first.event_id);
	assert_eq!(second.session_seq, first.session_seq, "a duplicate must not advance session_seq");

	let page = client
		.read_session_events(&session.session_id, None, None)
		.await
		.expect("read_session_events succeeds");
	assert_eq!(page.events.len(), 1, "the duplicate append must not create a second stored event");
}

/// A wrong bearer surfaces the typed 401 `ErrorEnvelopeV0` through the
/// client, and neither the presented nor the expected credential ever
/// appears in the error's `Debug`/`Display` output.
#[tokio::test]
async fn wrong_bearer_surfaces_typed_401_without_echoing_credentials() {
	let server = TestServer::start("wrong-bearer").await;
	let wrong_token = "wrong-license-should-never-be-echoed-xyz987";
	let client = server.client_with_token(wrong_token);

	let err = client
		.create_session(&create_session_request("wrong-bearer"))
		.await
		.expect_err("wrong bearer must be rejected");

	assert_eq!(err.http_status(), Some(401));
	let envelope = err
		.envelope()
		.expect("401 must carry a typed ErrorEnvelopeV0");
	assert!(!envelope.retryable, "an auth failure must not be marked retryable");

	let debug = format!("{err:?}");
	let display = format!("{err}");
	for secret in [wrong_token, LICENSE] {
		assert!(!debug.contains(secret), "Debug output must never echo a credential");
		assert!(!display.contains(secret), "Display output must never echo a credential");
	}
}

/// A well-formed but nonexistent id maps to a typed 404 `ErrorEnvelopeV0`,
/// distinct from the 401 auth-failure and 400 validation-failure cases.
#[tokio::test]
async fn unknown_id_surfaces_typed_404() {
	let server = TestServer::start("unknown-id").await;
	let client = server.client();

	let missing = EventId::try_from("evt_00000000-0000-4000-8000-0000000000ff".to_owned())
		.expect("well-formed evt_ id");
	let err = client
		.read_event(&missing)
		.await
		.expect_err("nonexistent event id must 404");
	assert_eq!(err.http_status(), Some(404));
	assert!(err.envelope().is_some(), "404 must carry a typed ErrorEnvelopeV0");

	let missing_assemble =
		AssembleId::try_from("asm_00000000-0000-4000-8000-0000000000ff".to_owned())
			.expect("well-formed asm_ id");
	let trace_err = client
		.read_trace(&missing_assemble)
		.await
		.expect_err("nonexistent trace must 404");
	assert_eq!(trace_err.http_status(), Some(404));
}

/// A syntactically valid request whose typed content violates a
/// server-side invariant (a turn-scoped event with no `turn_id`) maps to a
/// typed 400-class `ErrorEnvelopeV0` — distinct from the 401/404 cases
/// above.
#[tokio::test]
async fn invalid_turn_scoped_event_surfaces_typed_400_class_error() {
	let server = TestServer::start("invalid-turn-scope").await;
	let client = server.client();
	let session = client
		.create_session(&create_session_request("invalid-turn-scope"))
		.await
		.expect("create_session succeeds");

	let mut event = fixtures::raw_events_successful_turn()
		.into_iter()
		.next()
		.expect("fixture has events");
	event.event_type = RawEventType::UserTurnRecorded;
	let mut request = rebind_to_session(event, &session.session_id);
	request.turn_id = None;

	let err = client
		.append_event(&request)
		.await
		.expect_err("a turn-scoped event with no turn_id must be rejected");
	let status = err
		.http_status()
		.expect("validation failure must carry an http status");
	assert!((400..500).contains(&status), "expected a 4xx validation failure, got {status}");
	assert!(err.envelope().is_some(), "validation failure must carry a typed ErrorEnvelopeV0");
}

/// A malformed / non-JSON response body (e.g. hitting a listener that is
/// not the platform) produces the redacted `MalformedResponse` transport
/// error, and the response bytes are never echoed anywhere in the error.
#[tokio::test]
async fn malformed_response_body_produces_redacted_error_without_echoing_bytes() {
	let secret_marker = "SHOULD-NEVER-BE-ECHOED-body-marker-42";
	let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind ephemeral tcp port");
	let addr = listener
		.local_addr()
		.expect("bound listener has a local addr");

	let server_task = tokio::spawn(async move {
		let (mut stream, _) = listener.accept().await.expect("accept one connection");
		let mut buf = [0_u8; 1024];
		let _ = stream.read(&mut buf).await;
		let body = format!("not json at all: {secret_marker}");
		let response = format!(
			"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: \
			 close\r\n\r\n{body}",
			body.len()
		);
		let _ = stream.write_all(response.as_bytes()).await;
		let _ = stream.shutdown().await;
	});

	let client = KernelPlatformClient::new(format!("http://{addr}"), EntitlementToken::new(LICENSE));
	let err = client
		.create_session(&create_session_request("malformed-body"))
		.await
		.expect_err("a non-JSON body must not decode as a CreateSessionResponseV0");

	assert!(matches!(err, PlatformClientError::MalformedResponse));
	let debug = format!("{err:?}");
	let display = format!("{err}");
	assert!(!debug.contains(secret_marker), "Debug output must never echo response bytes");
	assert!(!display.contains(secret_marker), "Display output must never echo response bytes");

	server_task.await.expect("raw listener task completes");
}

/// `Debug` on the client (and therefore on anything embedding it) never
/// contains the bearer token, even though the client authenticates every
/// request with it.
#[tokio::test]
async fn client_debug_never_contains_the_bearer_token() {
	let server = TestServer::start("debug-redaction").await;
	let secret_token = "debug-redaction-should-never-leak-secret";
	let client = server.client_with_token(secret_token);
	// Exercise the client so any accidental logging path would have fired.
	let _ = client
		.create_session(&create_session_request("debug-redaction"))
		.await;

	let debug = format!("{client:?}");
	assert!(!debug.contains(secret_token));
	assert!(debug.contains(&server.base_url), "base url is not secret and aids debugging");
}
