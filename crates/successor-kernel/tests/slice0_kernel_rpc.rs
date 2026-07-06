//! Owned by Lane C8 `KernelLocalRpc` (Dissent ruling 4: disclosed test-file
//! ownership expansion). Contract tests for the kernel's local RPC/SSE
//! surface, built directly on the accepted C1-C7 seams: a real `TurnRunner`,
//! a real `KernelPlatformClient` against a live test double of the
//! platform's `/v0` surface (mirroring the C7 contract test's `TestServer`
//! pattern), and a scripted provider to keep turn outcomes deterministic
//! without any network call.

use std::sync::{
	Arc, Mutex,
	atomic::{AtomicBool, AtomicU64, Ordering},
};

use axum::{
	body::Body,
	http::{Request, StatusCode},
};
use successor_context_platform::{
	auth::PlatformLicense, http::build_router as build_platform_router, routes::PlatformState,
};
use successor_kernel::{
	api::{CreateSessionResponse, ResumeResponse, SessionAttachResponse, SubmitTurnRequest},
	config::ANTHROPIC_API_KEY_ENV,
	http::{AppState, build_router},
	id_factory::{RealClock, RealIdFactory},
	platform_client::{EntitlementToken, KernelPlatformClient},
	provider::{auth::ProviderSlot, projection},
	runner::{ProviderExecutor, ProviderRoundOutcome, ScriptedProviderExecutor, ScriptedRound},
	sse::render_kernel_frame_sse,
	state_machine::TurnFailure,
	stream::KernelFrameStream,
};
use successor_protocol::{
	error::ErrorEnvelopeV0,
	ids::{MessageId, ToolCallId},
	kernel_frame::{KernelFrameKindV0, KernelFrameV0},
	provider::ProviderApiShapeV0,
	raw_event::RawEventType,
	tool_catalog::ToolCatalogV0,
};
use tower::ServiceExt;

const LICENSE: &str = "dev-license-c8-rpc-abc123";
const SENTINEL_ANTHROPIC_KEY: &str = "sk-ant-sentinel-do-not-leak-c8rpc9f3c1a2b";

fn temp_db_path(label: &str) -> std::path::PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock after epoch")
		.as_nanos();
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-kernel-c8-rpc-{label}-{}-{n}-{nanos}.sqlite3", std::process::id()))
}

fn seed_workspace(label: &str) -> std::path::PathBuf {
	let root = std::env::temp_dir()
		.join(format!("successor-kernel-c8-rpc-workspace-{label}-{}", std::process::id()));
	std::fs::create_dir_all(&root).expect("create a temp workspace dir");
	root
}

fn cleanup_workspace(root: &std::path::Path) {
	let _ = std::fs::remove_dir_all(root);
}

/// Mirrors `slice0_kernel_contract.rs`'s `TestServer`: a real accepted
/// platform router, bound on a real TCP port, backed by a real temp `SQLite`
/// DB. `KernelPlatformClient` talks to it exactly as it would talk to a real
/// deployment.
struct TestServer {
	base_url: String,
	db_path:  std::path::PathBuf,
	handle:   tokio::task::JoinHandle<()>,
}

impl TestServer {
	async fn start(label: &str) -> Self {
		let db_path = temp_db_path(label);
		let state = PlatformState::connect(db_path.to_str().expect("temp db path is valid utf-8"))
			.await
			.expect("connect the real temp sqlite db");
		let router = build_platform_router(PlatformLicense::new(LICENSE), Arc::new(state));
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
			.await
			.expect("bind an ephemeral tcp port");
		let addr = listener
			.local_addr()
			.expect("bound listener has a local addr");
		let handle = tokio::spawn(async move {
			let _ = axum::serve(listener, router).await;
		});
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

// Finding 230 (C8 review task 230): `AppState` no longer holds a
// `KernelFrameStream` at all — `submit_turn` constructs a fresh one per
// request (routes.rs), so this helper (and every other `AppState`
// constructor call in this file) drops the parameter entirely.
fn scripted_state(
	platform: KernelPlatformClient,
	workspace_root: std::path::PathBuf,
	rounds: Vec<ScriptedRound>,
) -> AppState<ScriptedProviderExecutor> {
	AppState::new(
		platform,
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace_root,
		ProviderSlot::Anthropic,
		move || {
			Ok(ScriptedProviderExecutor::new(
				"scripted",
				ProviderApiShapeV0::AnthropicMessages,
				"scripted-model",
				rounds.clone(),
			))
		},
	)
}

/// Wraps a [`ScriptedProviderExecutor`] with a two-party rendezvous so two
/// concurrent turns can be driven to genuinely overlap inside
/// `execute_turn` — a deterministic barrier, not a sleep — exercising the
/// exact race the per-turn `KernelFrameStream` fix (finding 230) closes:
/// before that fix, both turns' `submit_turn` calls subscribed to and
/// published on the one `AppState`-level stream.
struct BarrierGatedExecutor {
	inner:   ScriptedProviderExecutor,
	barrier: Arc<tokio::sync::Barrier>,
}

impl ProviderExecutor for BarrierGatedExecutor {
	fn provider_id(&self) -> &str {
		self.inner.provider_id()
	}

	fn api_shape(&self) -> ProviderApiShapeV0 {
		self.inner.api_shape()
	}

	fn model(&self) -> &str {
		self.inner.model()
	}

	async fn send_round(
		&self,
		user_text: &str,
		completed_rounds: &[projection::CompletedToolRoundV0],
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		self.barrier.wait().await;
		self
			.inner
			.send_round(user_text, completed_rounds, catalog, message_id, tool_call_id)
			.await
	}
}

fn barrier_gated_state(
	platform: KernelPlatformClient,
	workspace_root: std::path::PathBuf,
	barrier: Arc<tokio::sync::Barrier>,
) -> AppState<BarrierGatedExecutor> {
	AppState::new(
		platform,
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace_root,
		ProviderSlot::Anthropic,
		move || {
			Ok(BarrierGatedExecutor {
				inner:   ScriptedProviderExecutor::new(
					"scripted",
					ProviderApiShapeV0::AnthropicMessages,
					"scripted-model",
					vec![ScriptedRound::Final {
						text:    "concurrent-turn-text".to_owned(),
						summary: "concurrent-turn-text".to_owned(),
					}],
				),
				barrier: Arc::clone(&barrier),
			})
		},
	)
}

/// Wraps a [`ScriptedProviderExecutor`] and records the exact `user_text`
/// each `send_round` call receives, in call order, so a test can inspect
/// what actually reached the provider boundary for a given round -- for
/// example, to prove the assembled-context block ruled by
/// `agent://277-ContextInjectionDissent` reaches round 1 of a continuation
/// turn's provider request.
struct RecordingProviderExecutor {
	inner: ScriptedProviderExecutor,
	log:   Arc<Mutex<Vec<String>>>,
}

impl ProviderExecutor for RecordingProviderExecutor {
	fn provider_id(&self) -> &str {
		self.inner.provider_id()
	}

	fn api_shape(&self) -> ProviderApiShapeV0 {
		self.inner.api_shape()
	}

	fn model(&self) -> &str {
		self.inner.model()
	}

	async fn send_round(
		&self,
		user_text: &str,
		completed_rounds: &[projection::CompletedToolRoundV0],
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		self
			.log
			.lock()
			.expect("recording log mutex")
			.push(user_text.to_owned());
		self
			.inner
			.send_round(user_text, completed_rounds, catalog, message_id, tool_call_id)
			.await
	}
}

/// Runs one real scripted turn directly against the accepted C7 runner (not
/// through this lane's own routes) and returns the resulting session id.
/// `TurnRunner::execute_turn` always creates its own platform session, so a
/// bare `create_session` call produces a session with zero raw events — not
/// enough for the platform's own snapshot replay to succeed. This seeds a
/// session the way the accepted runner actually populates one.
async fn seed_populated_session(
	server: &TestServer,
	workspace: &std::path::Path,
) -> successor_protocol::ids::SessionId {
	let frame_stream = KernelFrameStream::new();
	let runner = successor_kernel::runner::TurnRunner::new(
		server.client(),
		successor_kernel::frame_sink::FrameSink::new(frame_stream),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		ScriptedProviderExecutor::new(
			"scripted",
			ProviderApiShapeV0::AnthropicMessages,
			"scripted-model",
			vec![ScriptedRound::Final { text: "seed".to_owned(), summary: "seed".to_owned() }],
		),
		workspace,
	);
	let attempt = runner
		.execute_turn(successor_kernel::runner::TurnInput {
			user_text:      "seed a populated session".to_owned(),
			assembly_query: None,
		})
		.await;
	assert!(attempt.outcome.is_ok(), "the seeding turn must succeed: {attempt:?}");
	attempt
		.trace
		.frames()
		.first()
		.expect("the seeding turn published at least one frame")
		.session_id
		.clone()
}

/// Distinctive marker written into the seeded workspace and read back by
/// [`seed_session_with_a_read_artifact`]'s scripted `read` tool round, so a
/// later continuation turn's hydrated context can be recognized by content
/// rather than by id.
const CONTEXT_INJECTION_MARKER: &str = "marker-4f9c2a-turn-one-file-contents";

fn seed_workspace_with_marker(label: &str) -> std::path::PathBuf {
	let root = seed_workspace(label);
	std::fs::write(root.join("marker.txt"), CONTEXT_INJECTION_MARKER)
		.expect("write the marker file");
	root
}

/// Runs one real scripted turn (a `read` tool round over `marker.txt`,
/// followed by a `Final` round) directly against the accepted C7 runner, so
/// the session has a real platform artifact a later continuation turn's
/// recency retrieval can hydrate. Unlike [`seed_populated_session`], this
/// turn's raw events carry a backing artifact.
async fn seed_session_with_a_read_artifact(
	server: &TestServer,
	workspace: &std::path::Path,
) -> successor_protocol::ids::SessionId {
	let frame_stream = KernelFrameStream::new();
	let runner = successor_kernel::runner::TurnRunner::new(
		server.client(),
		successor_kernel::frame_sink::FrameSink::new(frame_stream),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		ScriptedProviderExecutor::new(
			"scripted",
			ProviderApiShapeV0::AnthropicMessages,
			"scripted-model",
			vec![
				ScriptedRound::ToolUse {
					tool_name:             "read".to_owned(),
					arguments:             serde_json::json!({ "path": "marker.txt" }),
					provider_tool_call_id: "call_seed_read".to_owned(),
				},
				ScriptedRound::Final {
					text:    "read the marker file".to_owned(),
					summary: "read the marker file".to_owned(),
				},
			],
		),
		workspace,
	);
	let attempt = runner
		.execute_turn(successor_kernel::runner::TurnInput {
			user_text:      "please read marker.txt".to_owned(),
			assembly_query: None,
		})
		.await;
	assert!(attempt.outcome.is_ok(), "the artifact-seeding turn must succeed: {attempt:?}");
	attempt
		.trace
		.frames()
		.first()
		.expect("the artifact-seeding turn published at least one frame")
		.session_id
		.clone()
}

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
	axum::body::to_bytes(response.into_body(), usize::MAX)
		.await
		.expect("collect the response body")
		.to_vec()
}

// ---------------------------------------------------------------------
// 1. Route surface exists and rejects malformed bodies.
// ---------------------------------------------------------------------

#[tokio::test]
async fn malformed_request_bodies_are_rejected_with_a_kernel_rpc_error_envelope() {
	let server = TestServer::start("malformed").await;
	let workspace = seed_workspace("malformed");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "hi".to_owned(),
		summary: "hi".to_owned(),
	}]);
	let router = build_router(state);

	for (method, path) in [("POST", "/v0/sessions"), ("POST", "/v0/turns")] {
		let request = Request::builder()
			.method(method)
			.uri(path)
			.header("content-type", "application/json")
			.body(Body::from("{ not json"))
			.expect("build a malformed request");
		let response = router
			.clone()
			.oneshot(request)
			.await
			.expect("router handles a malformed body without panicking");
		assert_eq!(
			response.status(),
			StatusCode::BAD_REQUEST,
			"{method} {path} must reject malformed JSON with 400"
		);
		let envelope: ErrorEnvelopeV0 = serde_json::from_slice(&body_bytes(response).await)
			.expect("error body is a valid ErrorEnvelopeV0");
		assert_eq!(envelope.code, "kernel_rpc.malformed_request");
	}

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// 2. SSE emits byte-exact C2-rendered `event: kernel_frame` records.
// ---------------------------------------------------------------------

#[tokio::test]
async fn submit_turn_streams_byte_exact_c2_rendered_kernel_frame_records() {
	let server = TestServer::start("sse").await;
	let workspace = seed_workspace("sse");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "hello".to_owned(),
		summary: "hello".to_owned(),
	}]);
	let router = build_router(state);

	let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind the kernel listener");
	let addr = listener
		.local_addr()
		.expect("kernel listener has a local addr");
	let serve_handle = tokio::spawn(async move {
		let _ = axum::serve(listener, router).await;
	});

	let http = reqwest::Client::new();
	let response = http
		.post(format!("http://{addr}/v0/turns"))
		.header(reqwest::header::CONTENT_TYPE, "application/json")
		.body(serde_json::json!({ "user_text": "hi" }).to_string())
		.send()
		.await
		.expect("submit turn request");
	assert_eq!(response.status(), reqwest::StatusCode::OK);
	assert_eq!(
		response
			.headers()
			.get(reqwest::header::CONTENT_TYPE)
			.and_then(|value| value.to_str().ok()),
		Some("text/event-stream")
	);
	let body = String::from_utf8(
		response
			.bytes()
			.await
			.expect("collect the full sse body")
			.to_vec(),
	)
	.expect("sse body is utf8");

	// Finding 230 (C8 review task 230): `submit_turn` now builds a fresh,
	// request-local `KernelFrameStream` per turn, so this test can no longer
	// observe an externally-subscribed twin of the exact stream the route
	// drives. Instead, decode every `event: kernel_frame` record on the wire
	// back into a `KernelFrameV0` and re-render it through the same C2
	// function the route calls: if the route ever emitted anything other
	// than `render_kernel_frame_sse`'s own canonical output (a second,
	// hand-rolled schema), this round trip would not reproduce the wire
	// bytes exactly (Dissent ruling 7: no second schema).
	let records: Vec<&str> = body
		.split("\n\n")
		.filter(|record| !record.is_empty())
		.collect();
	assert!(!records.is_empty(), "the runner must have published at least one frame");
	let mut saw_terminal = false;
	for record in &records {
		let data_line = record
			.lines()
			.find_map(|line| line.strip_prefix("data: "))
			.expect("every kernel_frame record carries a data: line");
		let frame: KernelFrameV0 =
			serde_json::from_str(data_line).expect("data payload decodes as a KernelFrameV0");
		let rerendered = render_kernel_frame_sse(&frame).expect("re-render the decoded frame");
		assert_eq!(
			format!("{record}\n\n"),
			rerendered,
			"SSE wire bytes must be byte-identical to C2's own rendering of the decoded frame"
		);
		if frame.kind == KernelFrameKindV0::TurnCompleted
			|| frame.kind == KernelFrameKindV0::TurnFailed
		{
			saw_terminal = true;
		}
	}
	assert!(saw_terminal, "the SSE stream must terminate on a turn's own terminal frame");

	serve_handle.abort();
	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// 3. A mid-turn `TurnFailure` surfaces as a terminal frame without dropping the
//    frames already published for that attempt.
// ---------------------------------------------------------------------

#[tokio::test]
async fn submit_turn_surfaces_turn_failure_as_a_terminal_frame_without_dropping_earlier_frames() {
	let server = TestServer::start("failure").await;
	let workspace = seed_workspace("failure");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::ToolUse {
		tool_name:             "not_a_real_tool".to_owned(),
		arguments:             serde_json::json!({}),
		provider_tool_call_id: "call_1".to_owned(),
	}]);
	let router = build_router(state);

	let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind the kernel listener");
	let addr = listener
		.local_addr()
		.expect("kernel listener has a local addr");
	let serve_handle = tokio::spawn(async move {
		let _ = axum::serve(listener, router).await;
	});

	let http = reqwest::Client::new();
	let response = http
		.post(format!("http://{addr}/v0/turns"))
		.header(reqwest::header::CONTENT_TYPE, "application/json")
		.body(serde_json::json!({ "user_text": "use a bad tool" }).to_string())
		.send()
		.await
		.expect("submit turn request");
	assert_eq!(
		response.status(),
		reqwest::StatusCode::OK,
		"a mid-turn failure still streams as SSE, not a JSON error, once real frames exist"
	);
	let body = String::from_utf8(
		response
			.bytes()
			.await
			.expect("collect the sse body")
			.to_vec(),
	)
	.expect("sse body is utf8");

	// Finding 230 (C8 review task 230): with a request-local `KernelFrameStream`,
	// there is no external observer to independently count "genuine" frames
	// against; the SSE body itself is the only source of truth for what the
	// route emitted.
	//
	// Task 232 (C8 review round 2, P2): a bare record count would still pass
	// if every pre-terminal frame were dropped and only the synthesized
	// terminal frame survived. Decode every record into a `KernelFrameV0` and
	// assert the exact pre-terminal kind sequence this scripted failure path
	// produces: the turn starts, the user's turn is appended as a raw event,
	// one `pre_tool`-phase assembly round runs (started + completed), and
	// only then does dispatch reject `not_a_real_tool`, terminating with
	// `turn_failed`. If any pre-terminal frame were dropped or reordered, or
	// the body carried only the terminal frame, this comparison fails.
	let records: Vec<&str> = body
		.split("\n\n")
		.filter(|record| !record.is_empty())
		.collect();
	let kinds: Vec<KernelFrameKindV0> = records
		.iter()
		.map(|record| {
			let data = record
				.strip_prefix("event: kernel_frame\ndata: ")
				.unwrap_or_else(|| panic!("every SSE record is a kernel_frame event: {record}"));
			let frame: KernelFrameV0 = serde_json::from_str(data).unwrap_or_else(|err| {
				panic!("SSE record data decodes as a KernelFrameV0: {err}: {data}")
			});
			frame.kind
		})
		.collect();
	assert_eq!(
		kinds,
		vec![
			KernelFrameKindV0::TurnStarted,
			KernelFrameKindV0::RawEventAppended,
			KernelFrameKindV0::PlatformAssembleStarted,
			KernelFrameKindV0::PlatformAssembleCompleted,
			KernelFrameKindV0::TurnFailed,
		],
		"the scripted failure path's pre-terminal frames (turn start, the user-turn append, and the \
		 single pre_tool assembly round) must survive intact and in order, terminated by \
		 turn_failed; body: {body}"
	);

	let last = *records.last().expect("at least the terminal record exists");
	assert!(
		last.contains("event: kernel_frame"),
		"the terminal record uses the same C2 event name as every other frame: {last}"
	);
	assert!(
		last.contains(r#""kind":"turn_failed""#),
		"the terminal record's kind is turn_failed: {last}"
	);
	assert!(
		last.contains("not present in the published tool catalog"),
		"the terminal record's payload carries the real TurnFailure detail: {last}"
	);

	serve_handle.abort();
	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// 4. Resume queries the platform fresh every time; no local cache.
// ---------------------------------------------------------------------

#[tokio::test]
async fn resume_queries_the_platform_fresh_and_never_caches_provider_auth() {
	let server = TestServer::start("resume").await;
	let workspace = seed_workspace("resume");
	let session_id = seed_populated_session(&server, &workspace).await;

	let resolved = Arc::new(AtomicBool::new(false));
	let flag = Arc::clone(&resolved);
	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			if flag.load(Ordering::SeqCst) {
				Ok(ScriptedProviderExecutor::new(
					"scripted",
					ProviderApiShapeV0::AnthropicMessages,
					"scripted-model",
					Vec::new(),
				))
			} else {
				Err(TurnFailure::ProviderAuthUnavailable { slot: ProviderSlot::Anthropic })
			}
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("GET")
		.uri(format!("/v0/resume/{}", session_id.as_str()))
		.body(Body::empty())
		.expect("build resume request 1");
	let response = router
		.clone()
		.oneshot(request)
		.await
		.expect("resume request 1");
	assert_eq!(response.status(), StatusCode::OK);
	let first: ResumeResponse =
		serde_json::from_slice(&body_bytes(response).await).expect("parse resume response 1");
	assert!(!first.provider_auth_resolved, "provider auth starts unresolved in this test");
	assert_eq!(first.session_id.as_str(), session_id.as_str());

	resolved.store(true, Ordering::SeqCst);

	let request = Request::builder()
		.method("GET")
		.uri(format!("/v0/resume/{}", session_id.as_str()))
		.body(Body::empty())
		.expect("build resume request 2");
	let response = router.oneshot(request).await.expect("resume request 2");
	assert_eq!(response.status(), StatusCode::OK);
	let second: ResumeResponse =
		serde_json::from_slice(&body_bytes(response).await).expect("parse resume response 2");
	assert!(
		second.provider_auth_resolved,
		"the exact same AppState must reflect the new auth state on the very next call, with no \
		 caching"
	);

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// 5. No secret leak: rejected platform tokens and resolved provider credentials
//    never appear in a response body.
// ---------------------------------------------------------------------

#[tokio::test]
async fn error_bodies_and_resume_responses_never_contain_injected_sentinel_credentials() {
	let server = TestServer::start("secrets").await;
	let workspace = seed_workspace("secrets");
	const REJECTED_TOKEN: &str = "definitely-wrong-license-token-sentinel";

	// A rejected platform token exercises the platform-auth failure path
	// through this lane's own error mapping.
	let bad_client = server.client_with_token(REJECTED_TOKEN);
	let state = AppState::new(
		bad_client,
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		|| {
			Ok(ScriptedProviderExecutor::new(
				"scripted",
				ProviderApiShapeV0::AnthropicMessages,
				"scripted-model",
				Vec::new(),
			))
		},
	);
	let router = build_router(state);
	let request = Request::builder()
		.method("POST")
		.uri("/v0/sessions")
		.header("content-type", "application/json")
		.body(Body::from(serde_json::json!({ "title": "secret-test" }).to_string()))
		.expect("build create-session request");
	let response = router
		.oneshot(request)
		.await
		.expect("create session over a rejected platform token");
	assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
	let body = body_bytes(response).await;
	let text = String::from_utf8_lossy(&body);
	assert!(
		!text.contains(REJECTED_TOKEN),
		"the rejected platform token must never leak into an error body: {text}"
	);
	assert!(
		!text.contains(SENTINEL_ANTHROPIC_KEY),
		"no provider credential material ever appears in an error body: {text}"
	);

	// A provider-auth-unavailable failure exercises this lane's own
	// distinct, redacted envelope for that case (never conflated with a
	// platform failure).
	let state2 = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		|| {
			Err::<ScriptedProviderExecutor, _>(TurnFailure::ProviderAuthUnavailable {
				slot: ProviderSlot::Anthropic,
			})
		},
	);
	let router2 = build_router(state2);
	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(serde_json::json!({ "user_text": "hi" }).to_string()))
		.expect("build submit-turn request");
	let response = router2
		.oneshot(request)
		.await
		.expect("submit turn with unavailable provider auth");
	assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
	let body = body_bytes(response).await;
	let envelope: ErrorEnvelopeV0 =
		serde_json::from_slice(&body).expect("provider-auth-unavailable error is a valid envelope");
	assert_eq!(envelope.code, "kernel_rpc.provider_auth_unavailable");
	assert_ne!(
		envelope.code, "kernel_rpc.platform_unavailable",
		"provider-auth and platform failures must never share one error shape"
	);

	// A genuinely *resolved* provider credential (through the real C3 seam)
	// must still never appear anywhere in a response body.
	let session_id = seed_populated_session(&server, &workspace).await;
	let sentinel_state = AppState::with_anthropic(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		"claude-sentinel-test-model",
		64,
		|name| {
			if name == ANTHROPIC_API_KEY_ENV {
				Some(SENTINEL_ANTHROPIC_KEY.to_owned())
			} else {
				None
			}
		},
	);
	let sentinel_router = build_router(sentinel_state);
	let request = Request::builder()
		.method("GET")
		.uri(format!("/v0/resume/{}", session_id.as_str()))
		.body(Body::empty())
		.expect("build sentinel resume request");
	let response = sentinel_router
		.oneshot(request)
		.await
		.expect("resume with a resolved (sentinel) anthropic credential");
	assert_eq!(response.status(), StatusCode::OK);
	let body = body_bytes(response).await;
	let text = String::from_utf8_lossy(&body);
	assert!(
		!text.contains(SENTINEL_ANTHROPIC_KEY),
		"a resolved provider credential must never appear in a resume response body: {text}"
	);
	let resumed: ResumeResponse =
		serde_json::from_slice(&body).expect("parse sentinel resume response");
	assert!(
		resumed.provider_auth_resolved,
		"the sentinel credential really did resolve, so this exercised the intended code path"
	);

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// 6. Two concurrent `POST /v0/turns` requests never cross-talk on the frame
//    stream (C8 review task 230).
// ---------------------------------------------------------------------

#[tokio::test]
async fn concurrent_submit_turn_requests_never_cross_talk_on_the_frame_stream() {
	let server = TestServer::start("concurrency").await;
	let workspace = seed_workspace("concurrency");
	let barrier = Arc::new(tokio::sync::Barrier::new(2));
	let state = barrier_gated_state(server.client(), workspace.clone(), Arc::clone(&barrier));
	let router = build_router(state);

	let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind the kernel listener");
	let addr = listener
		.local_addr()
		.expect("kernel listener has a local addr");
	let serve_handle = tokio::spawn(async move {
		let _ = axum::serve(listener, router).await;
	});

	// Both requests must genuinely overlap inside `execute_turn` for this
	// test to exercise anything real: the shared two-party barrier inside
	// `BarrierGatedExecutor::send_round` forces exactly that (a deterministic
	// rendezvous, not a sleep). Before the per-turn stream fix (finding 230),
	// both turns subscribing to and publishing on one AppState-level
	// `KernelFrameStream` meant either SSE response could observe the other's
	// frames or terminate on the other's terminal frame.
	let http = reqwest::Client::new();
	let submit = |addr: std::net::SocketAddr| {
		let http = http.clone();
		async move {
			http
				.post(format!("http://{addr}/v0/turns"))
				.header(reqwest::header::CONTENT_TYPE, "application/json")
				.body(serde_json::json!({ "user_text": "hi" }).to_string())
				.send()
				.await
				.expect("submit turn request")
				.bytes()
				.await
				.expect("collect the full sse body")
		}
	};
	let (body_a, body_b) = tokio::join!(submit(addr), submit(addr));

	let frame_session_ids = |body: &[u8]| -> Vec<String> {
		let text = String::from_utf8(body.to_vec()).expect("sse body is utf8");
		text
			.split("\n\n")
			.filter(|record| !record.is_empty())
			.map(|record| {
				let data_line = record
					.lines()
					.find_map(|line| line.strip_prefix("data: "))
					.expect("every kernel_frame record carries a data: line");
				let frame: KernelFrameV0 =
					serde_json::from_str(data_line).expect("data payload decodes as a KernelFrameV0");
				frame.session_id.as_str().to_owned()
			})
			.collect()
	};
	let sessions_a = frame_session_ids(&body_a);
	let sessions_b = frame_session_ids(&body_b);

	assert!(!sessions_a.is_empty(), "turn A must have published at least one frame");
	assert!(!sessions_b.is_empty(), "turn B must have published at least one frame");

	let unique_a: std::collections::HashSet<&String> = sessions_a.iter().collect();
	let unique_b: std::collections::HashSet<&String> = sessions_b.iter().collect();
	assert_eq!(
		unique_a.len(),
		1,
		"turn A's SSE response must carry only its own turn's frames, never turn B's: {sessions_a:?}"
	);
	assert_eq!(
		unique_b.len(),
		1,
		"turn B's SSE response must carry only its own turn's frames, never turn A's: {sessions_b:?}"
	);
	assert_ne!(
		unique_a.iter().next(),
		unique_b.iter().next(),
		"two concurrent turns must never be assigned the same session identity in this test"
	);

	serve_handle.abort();
	cleanup_workspace(&workspace);
}

/// Exercises [`SubmitTurnRequest`]'s conversion path exists and is total.
#[test]
fn submit_turn_request_converts_into_a_turn_input() {
	let request = SubmitTurnRequest {
		user_text:      "hello".to_owned(),
		assembly_query: Some("hello, but override".to_owned()),
		session_id:     None,
	};
	let input: successor_kernel::runner::TurnInput = request.into();
	assert_eq!(input.user_text, "hello");
	assert_eq!(input.assembly_query.as_deref(), Some("hello, but override"));
}

// ---------------------------------------------------------------------
// GET /v0/sessions/{session_id} (attach) is a thin C1 wrapper over
// KernelPlatformClient::read_snapshot: inspection of an existing platform
// session, never turn continuation. Nothing on this path touches
// TurnRunner, FrameSink, or any provider seam.
// ---------------------------------------------------------------------

#[tokio::test]
async fn attach_session_returns_the_platforms_own_snapshot_for_a_created_session() {
	let server = TestServer::start("attach").await;
	let workspace = seed_workspace("attach");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "hi".to_owned(),
		summary: "hi".to_owned(),
	}]);
	let router = build_router(state);

	// The "create" half: POST /v0/sessions must succeed and hand back a
	// platform-assigned id.
	let create_request = Request::builder()
		.method("POST")
		.uri("/v0/sessions")
		.header("content-type", "application/json")
		.body(Body::from(serde_json::json!({ "title": "attach-test" }).to_string()))
		.expect("build a create-session request");
	let create_response = router
		.clone()
		.oneshot(create_request)
		.await
		.expect("router handles create-session without panicking");
	assert_eq!(create_response.status(), StatusCode::OK, "create-session must succeed");
	let created: CreateSessionResponse = serde_json::from_slice(&body_bytes(create_response).await)
		.expect("create-session body is a valid CreateSessionResponse");
	assert!(
		!created.session_id.as_str().is_empty(),
		"create-session must hand back a platform-assigned session id"
	);

	// The "attach" half: inspect a session the real C7 runner actually
	// populated -- not the bare session created above (the platform cannot
	// replay a snapshot for a session with zero raw events, see
	// `seed_populated_session`'s doc comment). Attach must not run a turn:
	// no runner, no provider, no frame stream is involved on this path.
	let populated_session_id = seed_populated_session(&server, &workspace).await;
	let attach_request = Request::builder()
		.method("GET")
		.uri(format!("/v0/sessions/{}", populated_session_id.as_str()))
		.body(Body::empty())
		.expect("build an attach-session request");
	let attach_response = router
		.clone()
		.oneshot(attach_request)
		.await
		.expect("router handles attach-session without panicking");
	assert_eq!(attach_response.status(), StatusCode::OK, "attach must find a populated session");
	let snapshot: SessionAttachResponse = serde_json::from_slice(&body_bytes(attach_response).await)
		.expect("attach body is a valid SessionSnapshotV0");

	assert_eq!(
		snapshot.session_id, populated_session_id,
		"attach must return the exact platform-assigned session id, unchanged"
	);
	assert!(
		snapshot.last_raw_event_seq > 0,
		"the seeded session had a real turn run against it, so attach's snapshot must reflect at \
		 least one raw event -- proving attach reads the platform's own state rather than \
		 fabricating an empty response"
	);

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// GET /v0/sessions/{session_id} for a session the platform has never seen
// surfaces the platform's own not-found through the C1 error seam, not a
// silent empty snapshot or a panic.
// ---------------------------------------------------------------------

#[tokio::test]
async fn attach_session_maps_an_unknown_session_id_to_a_kernel_rpc_error_envelope() {
	let server = TestServer::start("attach-unknown").await;
	let workspace = seed_workspace("attach-unknown");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "hi".to_owned(),
		summary: "hi".to_owned(),
	}]);
	let router = build_router(state);

	let request = Request::builder()
		.method("GET")
		.uri("/v0/sessions/ses_does-not-exist-0000")
		.body(Body::empty())
		.expect("build an attach-session request for a well-formed but unknown id");
	let response = router
		.clone()
		.oneshot(request)
		.await
		.expect("router handles an unknown session id without panicking");

	assert_eq!(
		response.status(),
		StatusCode::NOT_FOUND,
		"a well-formed session id the platform has never seen must surface the platform's own \
		 not-found status, not a 200 with an empty body or a 5xx"
	);
	let envelope: ErrorEnvelopeV0 = serde_json::from_slice(&body_bytes(response).await)
		.expect("error body is a valid ErrorEnvelopeV0");
	assert_eq!(
		envelope.code, "kernel_rpc.platform_unavailable",
		"attach maps every platform-rejected read_snapshot call through the same C1 error seam as \
		 the other routes -- there is no attach-specific error code"
	);

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// Continuation (contract §9/§11 amendment, ruling 270): `session_id` on
// `SubmitTurnRequest` reuses an existing session's raw-event stream instead
// of minting a fresh one. `session_seq` continues monotonically and the new
// turn's first event chains its `causation_event_id` to the prior tail;
// `tool_catalog.published` still fires once for the new turn, never
// suppressed.
// ---------------------------------------------------------------------

#[tokio::test]
async fn submit_turn_with_session_id_continues_the_existing_session_and_chains_causation() {
	let server = TestServer::start("continuation").await;
	let workspace = seed_workspace("continuation");
	let session_id = seed_populated_session(&server, &workspace).await;

	let client = server.client();
	let page_before = client
		.read_session_events(&session_id, None, None)
		.await
		.expect("read the seeded session's events");
	assert!(!page_before.events.is_empty(), "the seeded session must already have raw events");
	let prior_tail = page_before
		.events
		.last()
		.expect("seeded session has a tail event")
		.clone();
	let prior_turn_id = prior_tail
		.turn_id
		.clone()
		.expect("seeded turn's tail event is turn-scoped");

	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "continuation reply".to_owned(),
		summary: "continuation reply".to_owned(),
	}]);
	let router = build_router(state);

	let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind the kernel listener");
	let addr = listener
		.local_addr()
		.expect("bound listener has a local addr");
	let serve_handle = tokio::spawn(async move {
		let _ = axum::serve(listener, router).await;
	});

	let http = reqwest::Client::new();
	let response = http
		.post(format!("http://{addr}/v0/turns"))
		.header(reqwest::header::CONTENT_TYPE, "application/json")
		.body(
			serde_json::json!({ "user_text": "continue please", "session_id": session_id })
				.to_string(),
		)
		.send()
		.await
		.expect("submit the continuation turn");
	assert_eq!(response.status(), reqwest::StatusCode::OK);
	let body = String::from_utf8(
		response
			.bytes()
			.await
			.expect("collect the full sse body")
			.to_vec(),
	)
	.expect("sse body is utf8");

	let mut saw_terminal = false;
	for record in body.split("\n\n").filter(|record| !record.is_empty()) {
		let data_line = record
			.lines()
			.find_map(|line| line.strip_prefix("data: "))
			.expect("every kernel_frame record carries a data: line");
		let frame: KernelFrameV0 =
			serde_json::from_str(data_line).expect("data payload decodes as a KernelFrameV0");
		assert_eq!(
			frame.session_id, session_id,
			"a continuation turn's frames must carry the continued session's id, never a new one"
		);
		assert_ne!(
			frame.turn_id, prior_turn_id,
			"a continuation turn must mint its own turn_id, distinct from the turn it continues"
		);
		if frame.kind == KernelFrameKindV0::TurnCompleted
			|| frame.kind == KernelFrameKindV0::TurnFailed
		{
			saw_terminal = true;
		}
	}
	assert!(saw_terminal, "the continuation turn must reach its own terminal frame");

	let page_after = client
		.read_session_events(&session_id, None, None)
		.await
		.expect("read the session's events after continuation");
	assert!(
		page_after.events.len() > page_before.events.len(),
		"continuation must append new raw events to the same session stream"
	);
	let new_events = &page_after.events[page_before.events.len()..];
	let first_new_event = new_events
		.first()
		.expect("continuation appended at least one event");
	assert_eq!(
		first_new_event.session_seq,
		prior_tail.session_seq + 1,
		"raw-event session_seq must continue monotonically across the turn boundary, never reset"
	);
	assert_eq!(
		first_new_event.causation_event_id,
		Some(prior_tail.event_id.clone()),
		"the first event of a continuation turn must chain its causation_event_id to the prior \
		 session's tail event, not start a fresh causation chain"
	);
	assert!(
		new_events
			.iter()
			.any(|event| event.event_type == RawEventType::ToolCatalogPublished),
		"tool_catalog.published must still be emitted once per submitted turn on continuation, \
		 never suppressed"
	);
	assert!(
		new_events
			.iter()
			.filter_map(|event| event.turn_id.as_ref())
			.all(|turn_id| *turn_id != prior_turn_id),
		"every new event must belong to the new turn, not the continued turn"
	);

	serve_handle.abort();
	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// Ruling agent://277-ContextInjectionDissent (PROCEED-WITH-CONDITIONS): a
// continuation turn's round 1 provider request must actually carry the
// prior turn's hydrated assembled context inside the first user message,
// not merely reference it by id. `provider_request.built`'s reported
// `context_item_ids` must never diverge from what was actually injected.
// ---------------------------------------------------------------------

#[tokio::test]
async fn continuation_turn_round_one_injects_the_prior_turns_hydrated_context_into_the_first_user_message()
 {
	let server = TestServer::start("ctx-injection").await;
	let workspace = seed_workspace_with_marker("ctx-injection");
	let session_id = seed_session_with_a_read_artifact(&server, &workspace).await;

	let page_before = server
		.client()
		.read_session_events(&session_id, None, None)
		.await
		.expect("read the session's events after seeding");

	let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
	let runner = successor_kernel::runner::TurnRunner::new(
		server.client(),
		successor_kernel::frame_sink::FrameSink::new(KernelFrameStream::new()),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		RecordingProviderExecutor {
			inner: ScriptedProviderExecutor::new(
				"scripted",
				ProviderApiShapeV0::AnthropicMessages,
				"scripted-model",
				vec![ScriptedRound::Final {
					text:    "continuation reply".to_owned(),
					summary: "continuation reply".to_owned(),
				}],
			),
			log:   Arc::clone(&log),
		},
		&workspace,
	);
	let attempt = runner
		.continue_turn(
			successor_kernel::runner::TurnInput {
				user_text:      "continue please".to_owned(),
				assembly_query: None,
			},
			session_id.clone(),
		)
		.await;
	assert!(attempt.outcome.is_ok(), "the continuation turn must succeed: {attempt:?}");

	let page_after = server
		.client()
		.read_session_events(&session_id, None, None)
		.await
		.expect("read the session's events after the continuation turn");
	let new_events = &page_after.events[page_before.events.len()..];
	let provider_request_built = new_events
		.iter()
		.find(|event| event.event_type == RawEventType::ProviderRequestBuilt)
		.expect("turn 2 must append a provider_request.built raw event");
	let context_item_ids: Vec<String> = provider_request_built
		.entity_ids
		.context_item_ids
		.iter()
		.map(|id| id.as_str().to_owned())
		.collect();
	assert!(
		!context_item_ids.is_empty(),
		"turn 2 round 1's provider_request.built must report the ids it actually injected, not an \
		 empty set, once the seeded session has a real prior-turn artifact to hydrate"
	);

	let round_one_user_text = {
		let recorded = log.lock().expect("recording log mutex");
		recorded
			.first()
			.expect("round 1 of turn 2 must call send_round at least once")
			.clone()
	};
	assert!(
		round_one_user_text.contains(CONTEXT_INJECTION_MARKER),
		"turn 2 round 1's provider user text must carry turn 1's hydrated context (the marker \
		 file's rendered_text), proving the assembled context actually reached the provider request \
		 instead of dying at the runner/provider seam (agent://277-ContextInjectionDissent); got: \
		 {round_one_user_text:?}"
	);
	assert!(
		round_one_user_text.ends_with("continue please"),
		"the assembled context block must be prepended before the user's own turn text, never \
		 replacing or following it; got: {round_one_user_text:?}"
	);
	for id in &context_item_ids {
		assert!(
			round_one_user_text.contains(&format!("id={id}")),
			"every id reported on provider_request.built must actually appear in the injected \
			 context block, never diverge from what was injected; missing {id:?} in \
			 {round_one_user_text:?}"
		);
	}

	cleanup_workspace(&workspace);
}

#[tokio::test]
async fn submit_turn_with_an_unknown_session_id_fails_closed_without_creating_a_session() {
	let server = TestServer::start("continuation-unknown").await;
	let workspace = seed_workspace("continuation-unknown");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "hi".to_owned(),
		summary: "hi".to_owned(),
	}]);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::json!({
				"user_text": "continue please",
				"session_id": "ses_does-not-exist-0000",
			})
			.to_string(),
		))
		.expect("build a continuation request against an unknown session id");
	let response = router
		.oneshot(request)
		.await
		.expect("router handles the request");
	// Unlike a mid-stream turn failure (surfaced as a terminal SSE frame within
	// an already-committed 200), continuing into a session that does not
	// exist fails before the turn's first frame -- the Gate in `submit_turn`
	// converts it straight into an HTTP-level `KernelRpcError` (contract §9/
	// §11 continuation amendment, ruling 270), exactly like any other
	// pre-stream failure.
	assert_eq!(
		response.status(),
		StatusCode::UNPROCESSABLE_ENTITY,
		"continuing into an unknown session must fail closed as a typed HTTP error before any frame \
		 streams, not silently create a fresh session"
	);
	let envelope: ErrorEnvelopeV0 =
		serde_json::from_slice(&body_bytes(response).await).expect("body decodes as an envelope");
	assert_eq!(envelope.code, "kernel_rpc.turn_failed");

	cleanup_workspace(&workspace);
}

#[tokio::test]
async fn submit_turn_with_session_id_into_a_zero_event_session_fails_closed() {
	let server = TestServer::start("continuation-zero-event").await;
	let workspace = seed_workspace("continuation-zero-event");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "hi".to_owned(),
		summary: "hi".to_owned(),
	}]);
	let router = build_router(state);

	// A session created via `POST /v0/sessions` (C1) and never submitted to
	// has zero raw events -- a real instance of the shape ruling 270 requires
	// continuation to reject, distinct from an unknown session id entirely.
	let create_request = Request::builder()
		.method("POST")
		.uri("/v0/sessions")
		.header("content-type", "application/json")
		.body(Body::from(serde_json::json!({ "title": "zero event session" }).to_string()))
		.expect("build a create-session request");
	let create_response = router
		.clone()
		.oneshot(create_request)
		.await
		.expect("router handles it");
	assert_eq!(create_response.status(), StatusCode::OK);
	let created: successor_protocol::platform_api::CreateSessionResponseV0 =
		serde_json::from_slice(&body_bytes(create_response).await)
			.expect("decodes as CreateSessionResponseV0");

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::json!({ "user_text": "continue please", "session_id": created.session_id })
				.to_string(),
		))
		.expect("build a continuation request against a zero-event session");
	let response = router
		.oneshot(request)
		.await
		.expect("router handles the request");
	assert_eq!(
		response.status(),
		StatusCode::UNPROCESSABLE_ENTITY,
		"continuing into a session with no prior raw events must fail closed as a typed error \
		 (contract §9/§11 continuation amendment, ruling 270)"
	);
	let envelope: ErrorEnvelopeV0 =
		serde_json::from_slice(&body_bytes(response).await).expect("body decodes as an envelope");
	assert_eq!(envelope.code, "kernel_rpc.turn_failed");
	// The platform's own snapshot replay already fails closed on a
	// zero-event session (a pre-existing, already-recorded residual: task
	// 235's "bare zero-event sessions 422 on snapshot replay") before
	// `run_turn`'s own `raw_event_ids.is_empty()` guard is ever reached. Either
	// path satisfies ruling 270's "fail closed, typed error" requirement; this
	// asserts the one actually observed, rather than the one the kernel-level
	// guard would produce if the platform ever stopped erroring here first.
	assert!(
		envelope.message.contains("empty raw-event stream"),
		"continuing into a zero-event session must fail with a message identifying the empty \
		 stream, not a generic failure: {envelope:?}"
	);

	cleanup_workspace(&workspace);
}

#[tokio::test]
async fn replaying_a_two_turn_session_stream_is_deterministic_and_spans_both_turns() {
	// Contract §9/§11 continuation amendment (ruling 270): replay/projection
	// is turn-agnostic already (`project_session` validates only that
	// `session_seq` is dense from 1, and derives `last_turn_id` from the
	// last turn-scoped event) -- this asserts that invariant actually holds
	// across a real two-turn continuation stream, not just in isolation.
	let server = TestServer::start("replay-two-turn").await;
	let workspace = seed_workspace("replay-two-turn");
	let session_id = seed_populated_session(&server, &workspace).await;
	let client = server.client();
	let page_before = client
		.read_session_events(&session_id, None, None)
		.await
		.expect("read the seeded session's events");
	let prior_turn_id = page_before
		.events
		.last()
		.expect("seeded tail event")
		.turn_id
		.clone()
		.expect("turn-scoped");

	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "second turn reply".to_owned(),
		summary: "second turn reply".to_owned(),
	}]);
	let router = build_router(state);
	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::json!({ "user_text": "continue please", "session_id": session_id })
				.to_string(),
		))
		.expect("build the continuation request");
	let response = router
		.oneshot(request)
		.await
		.expect("router handles the request");
	assert_eq!(response.status(), StatusCode::OK);
	let _ = body_bytes(response).await;

	let page_after = client
		.read_session_events(&session_id, None, None)
		.await
		.expect("read the session's events after continuation");
	assert!(page_after.events.len() > page_before.events.len());

	let first_projection = successor_protocol::replay::project_session(&page_after.events).expect(
		"projecting the combined two-turn stream must succeed, not hit the empty-stream path",
	);
	let second_projection = successor_protocol::replay::project_session(&page_after.events)
		.expect("a second, independent projection of the same stream must also succeed");
	assert_eq!(
		first_projection, second_projection,
		"projecting the same combined raw-event stream twice must be byte-for-byte deterministic"
	);

	assert_ne!(
		first_projection.session.last_turn_id, prior_turn_id,
		"last_turn_id must be the continuation's own turn, not the turn it continued"
	);
	let user_messages = first_projection
		.transcript
		.iter()
		.filter(|entry| entry.role == successor_protocol::projection::MessageRole::User)
		.count();
	let assistant_messages = first_projection
		.transcript
		.iter()
		.filter(|entry| entry.role == successor_protocol::projection::MessageRole::Assistant)
		.count();
	assert_eq!(
		user_messages, 2,
		"the accumulated transcript must include both turns' user messages: {:?}",
		first_projection.transcript
	);
	assert_eq!(
		assistant_messages, 2,
		"the accumulated transcript must include both turns' assistant messages: {:?}",
		first_projection.transcript
	);

	cleanup_workspace(&workspace);
}
