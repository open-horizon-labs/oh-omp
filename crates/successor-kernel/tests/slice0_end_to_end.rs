//! Lane D2 `BlackBoxIntegrationSmoke`: non-duplicative full-stack coverage
//! against a real kernel router + a real platform (real `SQLite` store, real
//! TCP-bound platform router), per the binding dissent ruling
//! `agent://243-D2PreExecutionDissent`. `slice0_kernel_rpc.rs` (Lane C8)
//! already covers the kernel's own RPC contract in isolation; this file goes
//! one step further and proves the write path the kernel drives through
//! `KernelPlatformClient` actually persists to disk in a form that replays
//! deterministically once reconnected to fresh store handles -- a genuine
//! full-stack round trip, not a second copy of C8's route-level assertions.
//!
//! Also owns: an `#[ignore]`d live-provider smoke, opt-in via
//! `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` plus a non-empty `ANTHROPIC_API_KEY`,
//! exercising exactly one real Anthropic Messages round trip through the
//! real kernel. It asserts only stable, typed contracts (a valid normalized
//! terminal frame; persisted, replayable state) and never asserts on model
//! prose, token counts, or timing, per the ruling.

use std::{
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use axum::{body::Body, http::Request};
use successor_context_platform::{
	artifacts::SqliteArtifactStore, auth::PlatformLicense,
	http::build_router as build_platform_router, replay::replay_session_snapshot,
	routes::PlatformState, sqlite::SqliteAppendStore, store::RawEventAppendStore,
};
use successor_kernel::{
	http::{AppState, build_router},
	id_factory::{RealClock, RealIdFactory},
	platform_client::KernelPlatformClient,
	platform_http::EntitlementToken,
	provider::{
		anthropic::AnthropicAdapter,
		auth::{ProviderSlot, resolve_provider_auth},
	},
	runner::{AnthropicProviderExecutor, ScriptedProviderExecutor, ScriptedRound},
};
use successor_protocol::{
	ids::SessionId, kernel_frame::KernelFrameV0, provider::ProviderApiShapeV0,
};
use tower::ServiceExt;

const LICENSE: &str = "dev-license-d2-e2e-abc123";
const SENTINEL_ANTHROPIC_KEY: &str = "sk-ant-sentinel-do-not-leak-d2e2e9f3c1a2b";

fn temp_db_path(label: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock after epoch")
		.as_nanos();
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-d2-e2e-{label}-{}-{n}-{nanos}.sqlite3", std::process::id()))
}

fn cleanup_sqlite_files(path: &std::path::Path) {
	let _ = std::fs::remove_file(path);
	let _ = std::fs::remove_file(format!("{}-wal", path.display()));
	let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn seed_workspace(label: &str) -> PathBuf {
	let root = std::env::temp_dir()
		.join(format!("successor-d2-e2e-workspace-{label}-{}", std::process::id()));
	std::fs::create_dir_all(&root).expect("create a temp workspace dir");
	root
}

fn cleanup_workspace(root: &std::path::Path) {
	let _ = std::fs::remove_dir_all(root);
}

/// Mirrors `slice0_kernel_rpc.rs`'s `TestServer`: a real accepted platform
/// router, bound on a real TCP port, backed by a real temp `SQLite` DB.
struct TestServer {
	base_url: String,
	db_path:  PathBuf,
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
}

impl Drop for TestServer {
	fn drop(&mut self) {
		self.handle.abort();
		cleanup_sqlite_files(&self.db_path);
	}
}

fn scripted_state(
	platform: KernelPlatformClient,
	workspace_root: PathBuf,
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

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
	axum::body::to_bytes(response.into_body(), usize::MAX)
		.await
		.expect("collect the response body")
		.to_vec()
}

fn parse_sse_frames(raw: &[u8]) -> Vec<KernelFrameV0> {
	let text = String::from_utf8_lossy(raw);
	let mut frames = Vec::new();
	for record in text.split("\n\n") {
		let data_lines: Vec<&str> = record
			.split('\n')
			.filter_map(|line| line.strip_prefix("data: "))
			.collect();
		if data_lines.is_empty() {
			continue;
		}
		let joined = data_lines.join("\n");
		frames.push(serde_json::from_str(&joined).expect("sse data line is a valid KernelFrameV0"));
	}
	frames
}

/// Asserts `sentinel` never occurs in `text`. On failure, the panic message
/// names the surface and sentinel class and reports the match count plus
/// each match's byte offset/length -- it never echoes the scanned text or
/// the sentinel value itself (durable law: failure messages name surface +
/// sentinel class only, never payload bytes).
fn assert_sentinel_absent(surface: &str, sentinel_class: &str, sentinel: &str, text: &str) {
	let offsets: Vec<(usize, usize)> = text
		.match_indices(sentinel)
		.map(|(offset, matched)| (offset, matched.len()))
		.collect();
	assert!(
		offsets.is_empty(),
		"{surface} leaked the {sentinel_class} sentinel: {} occurrence(s) at byte offset/length \
		 {offsets:?}",
		offsets.len(),
	);
}

/// Scans `bytes` for both of this suite's sentinel classes: the platform
/// license (`LICENSE`, presented as the entitlement token authorizing every
/// kernel->platform call `TestServer` drives) and the provider credential
/// (`SENTINEL_ANTHROPIC_KEY`).
fn assert_never_leaks_either_sentinel(surface: &str, bytes: &[u8]) {
	let text = String::from_utf8_lossy(bytes);
	assert_sentinel_absent(surface, "platform license", LICENSE, &text);
	assert_sentinel_absent(surface, "anthropic key", SENTINEL_ANTHROPIC_KEY, &text);
}
// ---------------------------------------------------------------------
// Full-stack turn against the real platform, replayed from a reconnected
// store handle (real on-disk persistence, not in-memory carry-over).
// ---------------------------------------------------------------------

#[tokio::test]
async fn full_stack_turn_persists_events_that_replay_deterministically_from_a_reconnected_store() {
	let server = TestServer::start("full-stack").await;
	let workspace = seed_workspace("full-stack");
	let state = scripted_state(server.client(), workspace.clone(), vec![ScriptedRound::Final {
		text:    "full stack scripted answer".to_owned(),
		summary: "full stack scripted summary".to_owned(),
	}]);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "full stack prompt" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.clone()
		.oneshot(request)
		.await
		.expect("submit_turn does not panic");
	assert!(response.status().is_success(), "expected the turn to succeed end to end");
	let frames = parse_sse_frames(&body_bytes(response).await);
	assert!(!frames.is_empty(), "expected at least one kernel frame");
	assert_eq!(
		frames.last().expect("non-empty").kind.as_str(),
		"turn_completed",
		"expected the stream to end on turn_completed"
	);
	let session_id: SessionId = frames.first().expect("non-empty").session_id.clone();

	// Reconnect fresh store handles to the *same on-disk file* the kernel
	// just wrote through, proving genuine persistence rather than reusing
	// any in-memory state the write path happened to retain.
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let reconnected_artifact_store = SqliteArtifactStore::connect(db_str)
		.await
		.expect("reconnect an artifact store to the same on-disk sqlite file");

	let first_replay =
		replay_session_snapshot(&reconnected_append_store, &reconnected_artifact_store, &session_id)
			.await
			.expect("replay the session the kernel just wrote through a fresh connection");
	let second_replay =
		replay_session_snapshot(&reconnected_append_store, &reconnected_artifact_store, &session_id)
			.await
			.expect("replay again");

	assert_eq!(first_replay.session_id, session_id);
	assert_eq!(first_replay, second_replay, "replaying twice must be deterministic");
	assert_eq!(
		serde_json::to_vec(&first_replay).unwrap(),
		serde_json::to_vec(&second_replay).unwrap(),
		"serialized replay bytes must be identical across replays"
	);

	// Cross-check the reconnected store's own event log against
	// `RawEventAppendStore` directly (not just the higher-level replay
	// helper), tying the frames observed on the wire to what is actually on
	// disk.
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back the raw events the kernel appended");
	assert!(!page.events.is_empty(), "the kernel's write path must have persisted raw events");
	assert_eq!(page.events.first().expect("non-empty").session_id, session_id);

	// Kernel trace-surface sentinel scan (Ruling 243.4: kernel HTTP/SSE +
	// traces). Distinct from slice0_platform_replay.rs's own store-byte
	// scans (raw SQLite file bytes against a different on-disk database);
	// this scans the kernel-produced raw event payloads and replay-snapshot
	// payloads this suite already reads back through the reconnected store
	// handles above, for both sentinel classes.
	assert_never_leaks_either_sentinel(
		"kernel-persisted raw event payloads (reconnected store)",
		&serde_json::to_vec(&page.events).expect("serialize raw events for the scan"),
	);
	assert_never_leaks_either_sentinel(
		"kernel-persisted replay snapshot (reconnected store)",
		&serde_json::to_vec(&first_replay).expect("serialize replay snapshot for the scan"),
	);

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// Kernel HTTP/SSE + frame-payload sentinel scan, end to end through a real
// (non-scripted) `AnthropicProviderExecutor` pointed at an unroutable
// address so the failure is deterministic and no live network call occurs.
// The credential is obtained through the fully public
// `resolve_provider_auth` seam (an injected closure, not process env), so no
// global environment mutation is needed in this shared test binary.
// ---------------------------------------------------------------------

#[tokio::test]
async fn kernel_http_sse_bytes_never_leak_a_provider_credential_on_a_real_transport_failure() {
	let server = TestServer::start("leak-scan").await;
	let workspace = seed_workspace("leak-scan");

	let outcome =
		resolve_provider_auth(ProviderSlot::Anthropic, |_| Some(SENTINEL_ANTHROPIC_KEY.to_owned()));
	let key = outcome
		.credential()
		.expect("the injected closure always resolves")
		.clone();
	// Port 1 on loopback deterministically refuses connections without any
	// live network call.
	let adapter = AnthropicAdapter::with_base_url("http://127.0.0.1:1", key);

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || Ok(AnthropicProviderExecutor::new(adapter.clone(), "sentinel-model", 8192)),
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "trigger a transport failure" }))
				.unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic on failure");
	let bytes = body_bytes(response).await;
	assert_never_leaks_either_sentinel("kernel http/sse bytes", &bytes);

	// Kernel trace-surface sentinel scan (Ruling 243.4: kernel HTTP/SSE +
	// traces), continued after the transport-failure path. The failing turn
	// still emits SSE frames (the runner synthesizes a terminal `turn_failed`
	// frame once the first frame has flowed), so reconnect a fresh store
	// handle to the same on-disk file and scan the raw event payloads the
	// kernel persisted for this session before the transport failed, for
	// both sentinel classes. Distinct from slice0_platform_replay.rs's own
	// store-byte scans (raw SQLite file bytes against a different
	// database); this scans the kernel-produced raw event payloads as read
	// back through the platform's own API.
	let frames = parse_sse_frames(&bytes);
	if let Some(session_id) = frames.first().map(|frame| frame.session_id.clone()) {
		let db_str = server.db_path.to_str().expect("utf-8 temp db path");
		let reconnected_append_store = SqliteAppendStore::connect(db_str)
			.await
			.expect("reconnect to the same on-disk sqlite file");
		let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
		let page = boxed_store
			.read_session_events(&session_id, 0, 200)
			.await
			.expect("read back whatever raw events the kernel persisted before the transport failed");
		assert_never_leaks_either_sentinel(
			"kernel-persisted raw event payloads on transport failure (reconnected store)",
			&serde_json::to_vec(&page.events).expect("serialize raw events for the scan"),
		);
	}

	cleanup_workspace(&workspace);
}

// ---------------------------------------------------------------------
// Opt-in live smoke: exactly one real Anthropic Messages round trip through
// the real kernel. Skipped by default; requires both
// `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` and a non-empty `ANTHROPIC_API_KEY`.
// Asserts only stable, typed contracts -- never model prose, token counts,
// or timing.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "opt-in live smoke: requires SUCCESSOR_LIVE_PROVIDER_SMOKE=1 and a real \
            ANTHROPIC_API_KEY"]
async fn live_smoke_against_the_real_anthropic_messages_api_produces_a_replayable_terminal_frame() {
	let live_gate = std::env::var("SUCCESSOR_LIVE_PROVIDER_SMOKE").unwrap_or_default();
	let api_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
	if live_gate != "1" || api_key.is_empty() {
		eprintln!(
			"skipping live smoke: SUCCESSOR_LIVE_PROVIDER_SMOKE=1 and a non-empty ANTHROPIC_API_KEY \
			 are both required"
		);
		return;
	}

	let server = TestServer::start("live").await;
	let workspace = seed_workspace("live");
	let provider_model = std::env::var("SUCCESSOR_LIVE_PROVIDER_MODEL")
		.unwrap_or_else(|_| "claude-opus-4-8".to_owned());
	let state = AppState::with_anthropic(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		provider_model.clone(),
		8192,
		|name| std::env::var(name).ok(),
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(
				&serde_json::json!({ "user_text": "Reply with the single word: ack." }),
			)
			.unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.clone()
		.oneshot(request)
		.await
		.expect("submit_turn does not panic");
	assert!(response.status().is_success(), "expected the live turn to complete or fail typed");
	let frames = parse_sse_frames(&body_bytes(response).await);
	assert!(!frames.is_empty(), "expected at least one kernel frame from the live round trip");
	let terminal_kind = frames.last().expect("non-empty").kind.as_str().to_owned();
	assert!(
		terminal_kind == "turn_completed",
		"live smoke must prove one COMPLETED real provider round trip (Gate 5 criterion 4); a typed \
		 failure terminal would mask auth/endpoint misconfiguration; got terminal frame kind \
		 {terminal_kind}"
	);

	let session_id = frames.first().expect("non-empty").session_id.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the on-disk sqlite file");
	let reconnected_artifact_store = SqliteArtifactStore::connect(db_str)
		.await
		.expect("reconnect an artifact store to the on-disk sqlite file");
	if terminal_kind == "turn_completed" {
		let snapshot = replay_session_snapshot(
			&reconnected_append_store,
			&reconnected_artifact_store,
			&session_id,
		)
		.await
		.expect("a completed live turn must be persisted and replayable");
		assert_eq!(snapshot.session_id, session_id);
	}

	cleanup_workspace(&workspace);
}
