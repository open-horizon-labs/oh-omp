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
//! Also owns two `#[ignore]`d live-provider smokes, opt-in via
//! `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` plus a non-empty `ANTHROPIC_API_KEY`:
//! one exercises a single real Anthropic Messages round trip, while the S8
//! smoke executes the bounded self-hosted coding workflow through the real
//! kernel. Both assert only stable, typed contracts and never assert on model
//! prose, token counts, or timing.

use std::{
	env,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
};

use axum::{body::Body, http::Request};
use successor_context_platform::{
	artifacts::SqliteArtifactStore, auth::PlatformLicense,
	http::build_router as build_platform_router, projection::map_session_snapshot,
	replay::replay_session_snapshot, routes::PlatformState, sqlite::SqliteAppendStore,
	store::RawEventAppendStore,
};
use successor_kernel::{
	api::ResumeResponse,
	http::{AppState, build_router},
	id_factory::{RealClock, RealIdFactory},
	platform_client::KernelPlatformClient,
	platform_http::EntitlementToken,
	provider::{
		anthropic::AnthropicAdapter,
		auth::{ProviderSlot, resolve_provider_auth},
		projection::CompletedToolRoundV0,
	},
	runner::{
		AnthropicProviderExecutor, ProviderExecutor, ProviderRoundOutcome, ScriptedProviderExecutor,
		ScriptedRound,
	},
	state_machine::{MAX_EXECUTABLE_TOOL_ROUNDS, TurnFailure},
	tools::bash::{TrustedExecutable, TrustedExecutableAllowlist},
};
use successor_protocol::{
	ids::{MessageId, SessionId, ToolCallId},
	kernel_frame::KernelFrameV0,
	projection::ToolCallStatus,
	provider::ProviderApiShapeV0,
	raw_event::{RawEventType, RawEventV0},
	replay::project_session,
	tool_catalog::{ToolAuthorityClassV0, ToolAuthorityRequestV0, ToolCatalogV0},
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

/// RAII guard for a seeded workspace directory: cleans up on success and
/// on unwind (a panicking assertion mid-test must not leak the temp dir).
struct WorkspaceGuard(PathBuf);

impl Drop for WorkspaceGuard {
	fn drop(&mut self) {
		cleanup_workspace(&self.0);
	}
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

const S8_TASK_PROMPT: &str = include_str!("fixtures/s8-self-hosted-coding-task.md");

const S8_INITIAL_LIB_RS: &str = r#"pub fn adjusted_score(input: i32) -> i32 {
	input + 1
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn doubles_then_offsets() {
		assert_eq!(adjusted_score(21), 43);
	}
}
"#;

const S8_EXPECTED_FIXED_LIB_RS: &str = r#"pub fn adjusted_score(input: i32) -> i32 {
	input * 2 + 1
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn doubles_then_offsets() {
		assert_eq!(adjusted_score(21), 43);
	}
}
"#;

fn seed_s8_disposable_crate(label: &str) -> (PathBuf, PathBuf) {
	let workspace = seed_workspace(label);
	let src_dir = workspace.join("src");
	std::fs::create_dir_all(&src_dir).expect("create disposable crate source directory");
	std::fs::write(
		workspace.join("Cargo.toml"),
		r#"[package]
name = "successor-s8-disposable"
version = "0.0.0"
edition = "2021"

[lib]
path = "src/lib.rs"
"#,
	)
	.expect("write disposable crate manifest");
	let lib_rs = src_dir.join("lib.rs");
	std::fs::write(&lib_rs, S8_INITIAL_LIB_RS).expect("seed intentionally failing crate");

	(workspace, lib_rs)
}

fn is_executable_file(path: &std::path::Path) -> bool {
	let Ok(metadata) = std::fs::metadata(path) else {
		return false;
	};
	if !metadata.is_file() {
		return false;
	}

	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		metadata.permissions().mode() & 0o111 != 0
	}
	#[cfg(not(unix))]
	{
		true
	}
}

fn resolve_cargo_executable() -> PathBuf {
	if let Some(raw_cargo) = env::var_os("CARGO") {
		let cargo_path = PathBuf::from(&raw_cargo);
		if cargo_path.is_absolute() && is_executable_file(&cargo_path) {
			return cargo_path;
		}
		if cargo_path.components().count() > 1 {
			let current_dir = env::current_dir().expect("resolve current directory for cargo path");
			let joined = current_dir.join(&cargo_path);
			if is_executable_file(&joined) {
				return joined;
			}
		}
		if let Some(found) = find_executable_on_path(&cargo_path) {
			return found;
		}
	}

	find_executable_on_path(std::path::Path::new("cargo"))
		.expect("cargo executable is required for the S8 live provider smoke")
}

fn find_executable_on_path(executable_name: &std::path::Path) -> Option<PathBuf> {
	let file_name = executable_name.file_name()?;
	let path = env::var_os("PATH")?;
	let current_dir = env::current_dir().ok()?;
	env::split_paths(&path).find_map(|dir| {
		let candidate = dir.join(file_name);
		if !is_executable_file(&candidate) {
			return None;
		}
		if candidate.is_absolute() {
			Some(candidate)
		} else {
			Some(current_dir.join(candidate))
		}
	})
}

fn s8_trusted_cargo_allowlist() -> TrustedExecutableAllowlist {
	let cargo_path = resolve_cargo_executable();
	let cargo = TrustedExecutable::new("cargo", cargo_path, Vec::new())
		.expect("construct trusted cargo executable entry");
	TrustedExecutableAllowlist::new([cargo]).expect("construct trusted cargo allowlist")
}

fn s8_full_tool_authority() -> ToolAuthorityRequestV0 {
	ToolAuthorityRequestV0 {
		classes: vec![
			ToolAuthorityClassV0::SafeRead,
			ToolAuthorityClassV0::WorkspaceMutation,
			ToolAuthorityClassV0::LocalProcess,
		],
	}
}

fn completed_tool_names(events: &[RawEventV0]) -> Vec<String> {
	events
		.iter()
		.filter(|event| event.event_type == RawEventType::ToolCallCompleted)
		.filter_map(|event| {
			event
				.payload
				.get("tool_name")
				.and_then(|name| name.as_str())
		})
		.map(str::to_owned)
		.collect()
}

fn raw_event_tool_names(events: &[RawEventV0], event_type: RawEventType) -> Vec<String> {
	events
		.iter()
		.filter(|event| event.event_type == event_type)
		.filter_map(|event| {
			event
				.payload
				.get("tool_name")
				.and_then(|name| name.as_str())
		})
		.map(str::to_owned)
		.collect()
}

fn completed_bash_exit_codes(events: &[RawEventV0]) -> Vec<Option<i64>> {
	events
		.iter()
		.filter(|event| event.event_type == RawEventType::ToolCallCompleted)
		.filter(|event| {
			event
				.payload
				.get("tool_name")
				.and_then(|name| name.as_str())
				== Some("bash")
		})
		.map(|event| {
			event
				.payload
				.get("result")
				.expect("completed bash event carries a result")
				.get("exit_code")
				.and_then(|exit_code| exit_code.as_i64())
		})
		.collect()
}

fn assert_s8_semantic_tool_contract(events: &[RawEventV0]) {
	let completed = completed_tool_names(events);
	let inspection_count = completed
		.iter()
		.filter(|name| {
			matches!(
				name.as_str(),
				"read" | "grep" | "find" | "search_files" | "ast_grep" | "list_dir"
			)
		})
		.count();
	assert!(inspection_count >= 1, "expected at least one completed inspection tool");

	let completed_mutation_count = completed
		.iter()
		.filter(|name| matches!(name.as_str(), "edit" | "write"))
		.count();
	assert!(
		(1..=2).contains(&completed_mutation_count),
		"expected one or two completed mutation calls, got {completed_mutation_count}"
	);

	let bash_exit_codes = completed_bash_exit_codes(events);
	assert!(
		(1..=3).contains(&bash_exit_codes.len()),
		"expected one to three completed bash calls, got {}",
		bash_exit_codes.len()
	);
	let final_exit_code = bash_exit_codes.last().expect("at least one bash receipt");
	assert_eq!(*final_exit_code, Some(0), "final cargo test receipt must succeed");

	let rejected = raw_event_tool_names(events, RawEventType::ToolCallRejected);
	assert!(rejected.is_empty(), "S8 must not reject tool calls: {rejected:?}");
	let failed = raw_event_tool_names(events, RawEventType::ToolCallFailed);
	let failed_mutation_count = failed
		.iter()
		.filter(|name| matches!(name.as_str(), "edit" | "write"))
		.count();
	assert_eq!(
		failed_mutation_count,
		failed.len(),
		"only mutation executor failures are recoverable in S8: {failed:?}"
	);
	assert!(
		failed_mutation_count <= 1,
		"expected at most one failed mutation attempt, got {failed:?}"
	);
	assert!(
		completed_mutation_count + failed_mutation_count <= 2,
		"expected at most two total mutation attempts, completed {completed_mutation_count}, failed \
		 {failed_mutation_count}"
	);
}

fn assert_same_raw_event_sequence(left: &[RawEventV0], right: &[RawEventV0]) {
	assert_eq!(right, left, "fresh resume must return the same raw event sequence");
}

async fn assert_no_s8_secret_leaks(
	surface: &str,
	api_key: &str,
	frames: &[KernelFrameV0],
	events: &[RawEventV0],
	resume_response: &ResumeResponse,
	artifact_store: &SqliteArtifactStore,
) {
	let frame_bytes = serde_json::to_vec(frames).expect("serialize frames for redaction scan");
	assert_never_leaks_either_sentinel(&format!("{surface} frames"), &frame_bytes);
	assert_sentinel_absent(
		&format!("{surface} frames"),
		"Anthropic API key",
		api_key,
		std::str::from_utf8(&frame_bytes).expect("frame json is utf-8"),
	);

	let event_bytes = serde_json::to_vec(events).expect("serialize raw events for redaction scan");
	assert_never_leaks_either_sentinel(&format!("{surface} events"), &event_bytes);
	assert_sentinel_absent(
		&format!("{surface} events"),
		"Anthropic API key",
		api_key,
		std::str::from_utf8(&event_bytes).expect("event json is utf-8"),
	);

	let resume_bytes =
		serde_json::to_vec(resume_response).expect("serialize resume response for redaction scan");
	assert_never_leaks_either_sentinel(&format!("{surface} resume"), &resume_bytes);
	assert_sentinel_absent(
		&format!("{surface} resume"),
		"Anthropic API key",
		api_key,
		std::str::from_utf8(&resume_bytes).expect("resume json is utf-8"),
	);

	for event in events {
		let artifact_id = event.entity_ids.artifact_id.as_ref().or_else(|| {
			event
				.artifact
				.as_ref()
				.and_then(|artifact| artifact.artifact_id.as_ref())
		});
		if let Some(artifact_id) = artifact_id {
			let artifact = artifact_store
				.require_artifact(artifact_id)
				.await
				.expect("artifact referenced by a raw event is retrievable");
			let artifact_bytes =
				serde_json::to_vec(&artifact).expect("serialize artifact for redaction scan");
			assert_never_leaks_either_sentinel(
				&format!("{surface} artifact {}", artifact.artifact_id),
				&artifact_bytes,
			);
			assert_sentinel_absent(
				&format!("{surface} artifact {}", artifact.artifact_id),
				"Anthropic API key",
				api_key,
				std::str::from_utf8(&artifact_bytes).expect("artifact json is utf-8"),
			);
		}
	}
}

#[tokio::test]
#[ignore = "opt-in S8 live provider smoke: requires SUCCESSOR_LIVE_PROVIDER_SMOKE=1, \
            ANTHROPIC_API_KEY, and local cargo"]
async fn s8_live_anthropic_provider_repairs_disposable_rust_crate_and_replays_after_resume() {
	let live_gate = env::var("SUCCESSOR_LIVE_PROVIDER_SMOKE").unwrap_or_default();
	let api_key = env::var("ANTHROPIC_API_KEY").unwrap_or_default();
	if live_gate != "1" || api_key.is_empty() {
		eprintln!(
			"skipping S8 live smoke: SUCCESSOR_LIVE_PROVIDER_SMOKE=1 and a non-empty \
			 ANTHROPIC_API_KEY are both required"
		);
		return;
	}

	let server = TestServer::start("s8-live").await;
	let (workspace, lib_rs) = seed_s8_disposable_crate("s8-live");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	let provider_model =
		env::var("SUCCESSOR_LIVE_PROVIDER_MODEL").unwrap_or_else(|_| "claude-opus-4-8".to_owned());
	let trusted_allowlist = s8_trusted_cargo_allowlist();
	let state = AppState::with_anthropic(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		provider_model.clone(),
		8192,
		|name| env::var(name).ok(),
	)
	.with_trusted_tool_authority_ceiling(vec![
		ToolAuthorityClassV0::SafeRead,
		ToolAuthorityClassV0::WorkspaceMutation,
		ToolAuthorityClassV0::LocalProcess,
	])
	.with_trusted_executable_allowlist(trusted_allowlist);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({
				"user_text": S8_TASK_PROMPT,
				"tool_authority": s8_full_tool_authority(),
			}))
			.expect("serialize S8 submit_turn request"),
		))
		.expect("build S8 submit_turn request");
	let response = router
		.clone()
		.oneshot(request)
		.await
		.expect("S8 submit_turn does not panic");
	assert!(response.status().is_success(), "S8 live turn must stream typed kernel frames");
	let response_bytes = body_bytes(response).await;
	assert_never_leaks_either_sentinel("S8 live response bytes", &response_bytes);
	assert_sentinel_absent(
		"S8 live response bytes",
		"Anthropic API key",
		&api_key,
		std::str::from_utf8(&response_bytes).expect("S8 response bytes are utf-8"),
	);
	let frames = parse_sse_frames(&response_bytes);
	assert!(!frames.is_empty(), "expected kernel frames from S8 live provider turn");
	let terminal_frame = frames.last().expect("non-empty frames");
	assert_eq!(
		terminal_frame.kind.as_str(),
		"turn_completed",
		"S8 live task must complete successfully; terminal payload: {}",
		terminal_frame.payload
	);

	let actual_source =
		std::fs::read_to_string(&lib_rs).expect("read disposable crate source after provider turn");
	assert_eq!(actual_source, S8_EXPECTED_FIXED_LIB_RS);

	let cargo_status = std::process::Command::new(resolve_cargo_executable())
		.arg("test")
		.arg("--quiet")
		.current_dir(&workspace)
		.status()
		.expect("run independent cargo test verification");
	assert!(cargo_status.success(), "independent cargo test --quiet must pass after S8 turn");

	let session_id = frames.first().expect("non-empty frames").session_id.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to S8 sqlite append store");
	let reconnected_artifact_store = SqliteArtifactStore::connect(db_str)
		.await
		.expect("reconnect to S8 sqlite artifact store");
	let event_page = reconnected_append_store
		.read_session_events(&session_id, 0, 10_000)
		.await
		.expect("read durable S8 raw events");
	let events = event_page.events;
	assert!(!events.is_empty(), "S8 raw events must be durable");
	let projection = project_session(&events).expect("S8 durable events project successfully");
	assert_s8_semantic_tool_contract(&events);

	let snapshot =
		replay_session_snapshot(&reconnected_append_store, &reconnected_artifact_store, &session_id)
			.await
			.expect("S8 completed turn must replay from a fresh store connection");
	assert_eq!(snapshot.session_id, session_id);
	let expected_snapshot = map_session_snapshot(&session_id, &events, &projection);
	assert_eq!(
		snapshot, expected_snapshot,
		"fresh-store replay must be byte-identical to the direct persisted-event projection"
	);
	let replayed_snapshot =
		replay_session_snapshot(&reconnected_append_store, &reconnected_artifact_store, &session_id)
			.await
			.expect("S8 replay must be deterministic from the same fresh stores");
	assert_eq!(replayed_snapshot, snapshot);

	let fresh_state = AppState::with_anthropic(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		provider_model,
		8192,
		|name| env::var(name).ok(),
	)
	.with_trusted_tool_authority_ceiling(vec![
		ToolAuthorityClassV0::SafeRead,
		ToolAuthorityClassV0::WorkspaceMutation,
		ToolAuthorityClassV0::LocalProcess,
	])
	.with_trusted_executable_allowlist(s8_trusted_cargo_allowlist());
	let fresh_router = build_router(fresh_state);
	let resume_request = Request::builder()
		.method("GET")
		.uri(format!("/v0/resume/{session_id}?limit=10000").as_str())
		.body(Body::empty())
		.expect("build S8 resume request");
	let resume_response = fresh_router
		.oneshot(resume_request)
		.await
		.expect("S8 resume route does not panic");
	assert!(
		resume_response.status().is_success(),
		"fresh S8 kernel router must resume persisted session"
	);
	let resume_bytes = body_bytes(resume_response).await;
	let resume_payload: ResumeResponse =
		serde_json::from_slice(&resume_bytes).expect("parse S8 resume response");
	assert_same_raw_event_sequence(&events, &resume_payload.events.events);

	assert_no_s8_secret_leaks(
		"S8",
		&api_key,
		&frames,
		&events,
		&resume_payload,
		&reconnected_artifact_store,
	)
	.await;

	let provider_delta_text = frames
		.iter()
		.filter(|frame| frame.kind.as_str() == "provider_delta")
		.filter_map(|frame| frame.payload.get("text"))
		.filter_map(serde_json::Value::as_str)
		.find(|text| !text.trim().is_empty())
		.expect("S8 must surface non-empty visible assistant provider output");
	assert!(!provider_delta_text.is_empty());
}

// ---------------------------------------------------------------------
// Recoverable executor-error continuation and replay.
// ---------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RecordedRound {
	completed_rounds_len: usize,
	last_result_text:     Option<String>,
	last_is_error:        Option<bool>,
}

/// Wraps a real [`ScriptedProviderExecutor`], recording the
/// `completed_rounds` context of every `send_round` call so a test can
/// assert on the bounded, redacted text and `is_error` bit the provider
/// actually saw after a recoverable tool failure.
#[derive(Debug)]
struct RecordingProviderExecutor {
	inner:    ScriptedProviderExecutor,
	recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>>,
}

impl RecordingProviderExecutor {
	const fn new(
		inner: ScriptedProviderExecutor,
		recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>>,
	) -> Self {
		Self { inner, recorded }
	}
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
		completed_rounds: &[CompletedToolRoundV0],
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		self
			.recorded
			.lock()
			.expect("recording mutex poisoned")
			.push(RecordedRound {
				completed_rounds_len: completed_rounds.len(),
				last_result_text:     completed_rounds
					.last()
					.map(|round| round.result_text.clone()),
				last_is_error:        completed_rounds.last().map(|round| round.is_error),
			});
		self
			.inner
			.send_round(user_text, completed_rounds, catalog, message_id, tool_call_id)
			.await
	}
}

/// Fails the append POST for the Nth occurrence of a specific persisted
/// `RawEventType`, parsed from the request body's `event_type` field --
/// never matched by a raw-byte substring, and never counted via a global
/// request number -- proving append failures at an exact point in the
/// recoverable-failure chain remain fatal. Every other request passes through
/// untouched.
struct FaultInjectorConfig {
	trigger_event_type: RawEventType,
	trigger_occurrence: u32,
	seen:               AtomicU32,
	triggered:          Arc<AtomicBool>,
}

async fn inject_fault_on_matching_events_post(
	axum::extract::State(config): axum::extract::State<Arc<FaultInjectorConfig>>,
	req: Request<Body>,
	next: axum::middleware::Next,
) -> axum::response::Response {
	let (parts, body) = req.into_parts();
	let is_events_post =
		parts.method == axum::http::Method::POST && parts.uri.path() == "/v0/events";
	if !is_events_post {
		return next.run(Request::from_parts(parts, body)).await;
	}
	let bytes = axum::body::to_bytes(body, 1024 * 1024)
		.await
		.expect("buffer the request body for fault injection");
	let event_type = serde_json::from_slice::<serde_json::Value>(&bytes)
		.ok()
		.and_then(|value| value.get("event_type").cloned())
		.and_then(|value| serde_json::from_value::<RawEventType>(value).ok());
	if event_type.as_ref() == Some(&config.trigger_event_type) {
		let occurrence = config.seen.fetch_add(1, Ordering::SeqCst) + 1;
		if occurrence == config.trigger_occurrence {
			config.triggered.store(true, Ordering::SeqCst);
			return axum::response::Response::builder()
				.status(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
				.body(Body::from("injected append fault (test-only fault seam)"))
				.expect("build a fault-injection response");
		}
	}
	next
		.run(Request::from_parts(parts, Body::from(bytes)))
		.await
}

impl TestServer {
	async fn start_with_fault_injection(
		label: &str,
		trigger_event_type: RawEventType,
		trigger_occurrence: u32,
	) -> (Self, Arc<AtomicBool>) {
		let db_path = temp_db_path(label);
		let state = PlatformState::connect(db_path.to_str().expect("temp db path is valid utf-8"))
			.await
			.expect("connect the real temp sqlite db");
		let triggered = Arc::new(AtomicBool::new(false));
		let fault_config = Arc::new(FaultInjectorConfig {
			trigger_event_type,
			trigger_occurrence,
			seen: AtomicU32::new(0),
			triggered: triggered.clone(),
		});
		let router = build_platform_router(PlatformLicense::new(LICENSE), Arc::new(state)).layer(
			axum::middleware::from_fn_with_state(fault_config, inject_fault_on_matching_events_post),
		);
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
			.await
			.expect("bind an ephemeral tcp port");
		let addr = listener
			.local_addr()
			.expect("bound listener has a local addr");
		let handle = tokio::spawn(async move {
			let _ = axum::serve(listener, router).await;
		});
		(Self { base_url: format!("http://{addr}/v0"), db_path, handle }, triggered)
	}
}

fn scripted_recovery_rounds(
	invalid_path: &str,
	provider_tool_call_id: &str,
	final_text: &str,
) -> Vec<ScriptedRound> {
	vec![
		ScriptedRound::ToolUse {
			tool_name:             "read".to_owned(),
			arguments:             serde_json::json!({ "path": invalid_path }),
			provider_tool_call_id: provider_tool_call_id.to_owned(),
		},
		ScriptedRound::Final { text: final_text.to_owned(), summary: final_text.to_owned() },
	]
}

#[tokio::test]
async fn recoverable_executor_tool_failure_is_durable_bounded_and_lets_the_provider_continue() {
	let server = TestServer::start("s5-recover").await;
	let workspace = seed_workspace("s5-recover");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	let recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>> =
		Arc::new(std::sync::Mutex::new(Vec::new()));
	let recorded_for_factory = recorded.clone();
	let rounds = scripted_recovery_rounds(
		"does-not-exist.txt",
		"call_s5_recover_001",
		"recovered after the failed read",
	);

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			Ok(RecordingProviderExecutor::new(
				ScriptedProviderExecutor::new(
					"anthropic",
					ProviderApiShapeV0::AnthropicMessages,
					"sentinel-model",
					rounds.clone(),
				),
				recorded_for_factory.clone(),
			))
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "please read a file" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic");
	assert!(response.status().is_success());
	let bytes = body_bytes(response).await;
	let frames = parse_sse_frames(&bytes);
	let last = frames.last().expect("turn produced at least one frame");
	assert_eq!(
		last.kind.as_str(),
		"turn_completed",
		"a recoverable tool failure must not fail the turn"
	);
	assert_never_leaks_either_sentinel("s5 recovery kernel http/sse bytes", &bytes);

	let recorded_rounds = recorded.lock().expect("recorder mutex poisoned").clone();
	assert_eq!(recorded_rounds.len(), 2, "expected the initial round and a recovery round");
	assert_eq!(recorded_rounds[1].completed_rounds_len, 1);
	assert_eq!(recorded_rounds[1].last_is_error, Some(true));
	let bounded_text = recorded_rounds[1]
		.last_result_text
		.clone()
		.expect("the failed round must carry provider-visible result text");
	assert!(bounded_text.len() <= 2048, "provider result text must respect the byte budget");
	assert!(
		bounded_text.contains("tool_execution.failed"),
		"generic recovery must use the generic code"
	);
	assert!(
		!bounded_text.contains("does-not-exist.txt"),
		"provider text must never leak the raw path"
	);

	let session_id = frames
		.first()
		.expect("first frame carries the session_id")
		.session_id
		.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back the persisted raw events");
	assert!(
		page
			.events
			.iter()
			.any(|event| event.event_type == RawEventType::ToolCallFailed),
		"a tool_call.failed raw event must be durable"
	);
	assert!(
		!page
			.events
			.iter()
			.any(|event| event.event_type == RawEventType::ToolResultRecorded),
		"a failed dispatch must never persist tool_result.recorded"
	);
	let projection = project_session(&page.events)
		.expect("the accepted executor-failure chain must replay cleanly");
	assert_eq!(projection.errors.len(), 1, "exactly one accepted executor error envelope");
	assert_eq!(projection.tools.len(), 1, "exactly one tool call in the projected session");
	let failed_tool = &projection.tools[0];
	assert_eq!(failed_tool.status, ToolCallStatus::Failed, "the tool call must project as Failed");
	assert!(
		failed_tool.result_event_id.is_none(),
		"a Failed tool must never carry a result_event_id"
	);
	assert!(
		failed_tool.completed_event_id.is_none(),
		"a Failed tool must never carry a completed_event_id"
	);
	assert!(failed_tool.artifact_id.is_none(), "a Failed tool must never carry an artifact_id");
	let error_row = &projection.errors[0];
	assert_eq!(
		Some(error_row.error_id.clone()),
		failed_tool.error_id,
		"the Failed tool and its ErrorProjectionV0 must be linked by error_id"
	);
	assert_eq!(
		error_row.tool_call_id, failed_tool.tool_call_id,
		"the Failed tool and its ErrorProjectionV0 must be linked by tool_call_id"
	);
	assert!(projection.artifacts.is_empty(), "a failed dispatch must never create an artifact");
	assert_never_leaks_either_sentinel(
		"s5 recovery persisted raw event payloads",
		&serde_json::to_vec(&page.events).expect("serialize raw events for the scan"),
	);
}

#[tokio::test]
async fn append_failure_at_error_recorded_is_fatal_and_blocks_provider_continuation() {
	let (server, triggered) =
		TestServer::start_with_fault_injection("s5-fatal", RawEventType::ErrorRecorded, 1).await;
	let workspace = seed_workspace("s5-fatal");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	let recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>> =
		Arc::new(std::sync::Mutex::new(Vec::new()));
	let recorded_for_factory = recorded.clone();
	let rounds = scripted_recovery_rounds(
		"still-does-not-exist.txt",
		"call_s5_fatal_001",
		"must never be reached",
	);

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			Ok(RecordingProviderExecutor::new(
				ScriptedProviderExecutor::new(
					"anthropic",
					ProviderApiShapeV0::AnthropicMessages,
					"sentinel-model",
					rounds.clone(),
				),
				recorded_for_factory.clone(),
			))
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "please read a file" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic on append failure");
	let bytes = body_bytes(response).await;
	let frames = parse_sse_frames(&bytes);
	let last = frames
		.last()
		.expect("turn produced at least one frame even on a fatal append failure");
	assert_eq!(
		last.kind.as_str(),
		"turn_failed",
		"an infrastructure append failure must fail the whole turn"
	);
	assert!(triggered.load(Ordering::SeqCst), "the fault seam must have actually fired");

	let recorded_rounds = recorded.lock().expect("recorder mutex poisoned").clone();
	assert_eq!(
		recorded_rounds.len(),
		1,
		"the provider must never be asked for a continuation round after a fatal append failure"
	);

	let session_id = frames
		.first()
		.expect("first frame carries the session_id")
		.session_id
		.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back whatever the append fault let through");
	assert_eq!(
		page.events.last().map(|event| event.event_type.clone()),
		Some(RawEventType::ToolCallStarted),
		"an append fault on error.recorded must leave the persisted chain ending at \
		 tool_call.started"
	);
	assert!(
		!page.events.iter().any(|event| matches!(
			event.event_type,
			RawEventType::ErrorRecorded | RawEventType::ToolCallFailed
		)),
		"an append fault on error.recorded must persist neither error.recorded nor tool_call.failed"
	);
	assert!(
		project_session(&page.events).is_err(),
		"a partial durable chain that ends at tool_call.started must be rejected, not projected as \
		 a fake terminal fact"
	);
}

#[tokio::test]
async fn append_failure_at_tool_call_failed_is_fatal_and_blocks_provider_continuation() {
	let (server, triggered) =
		TestServer::start_with_fault_injection("s5-fatal-failed", RawEventType::ToolCallFailed, 1)
			.await;
	let workspace = seed_workspace("s5-fatal-failed");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	let recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>> =
		Arc::new(std::sync::Mutex::new(Vec::new()));
	let recorded_for_factory = recorded.clone();
	let rounds = scripted_recovery_rounds(
		"still-does-not-exist-2.txt",
		"call_s5_fatal_failed_001",
		"must never be reached",
	);

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			Ok(RecordingProviderExecutor::new(
				ScriptedProviderExecutor::new(
					"anthropic",
					ProviderApiShapeV0::AnthropicMessages,
					"sentinel-model",
					rounds.clone(),
				),
				recorded_for_factory.clone(),
			))
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "please read a file" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic on append failure");
	let bytes = body_bytes(response).await;
	let frames = parse_sse_frames(&bytes);
	let last = frames
		.last()
		.expect("turn produced at least one frame even on a fatal append failure");
	assert_eq!(
		last.kind.as_str(),
		"turn_failed",
		"an infrastructure append failure must fail the whole turn"
	);
	assert!(
		!frames.iter().any(|frame| {
			frame.kind.as_str() == "tool_call_completed" && frame.payload["status"] == "failed"
		}),
		"the runner must not emit a failed-tool completion frame when its terminal event was not \
		 persisted"
	);
	assert!(triggered.load(Ordering::SeqCst), "the fault seam must have actually fired");

	let recorded_rounds = recorded.lock().expect("recorder mutex poisoned").clone();
	assert_eq!(
		recorded_rounds.len(),
		1,
		"the provider must never be asked for a continuation round after a fatal append failure"
	);

	let session_id = frames
		.first()
		.expect("first frame carries the session_id")
		.session_id
		.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back whatever the append fault let through");
	assert_eq!(
		page.events.last().map(|event| event.event_type.clone()),
		Some(RawEventType::ErrorRecorded),
		"an append fault on tool_call.failed must leave the persisted chain ending at error.recorded"
	);
	assert!(
		!page
			.events
			.iter()
			.any(|event| event.event_type == RawEventType::ToolCallFailed),
		"an append fault on tool_call.failed must never persist tool_call.failed"
	);
	assert!(
		project_session(&page.events).is_err(),
		"a partial durable chain that contains error.recorded but no tool_call.failed must be \
		 rejected, not projected as a fake terminal fact"
	);
}

#[tokio::test]
async fn two_recoverable_executor_tool_failures_then_final_are_durable_and_bounded_by_the_provider()
{
	let server = TestServer::start("s5-two-failures").await;
	let workspace = seed_workspace("s5-two-failures");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	let recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>> =
		Arc::new(std::sync::Mutex::new(Vec::new()));
	let recorded_for_factory = recorded.clone();
	let rounds = vec![
		ScriptedRound::ToolUse {
			tool_name:             "read".to_owned(),
			arguments:             serde_json::json!({ "path": "still-does-not-exist-1.txt" }),
			provider_tool_call_id: "call_s5_two_failures_001".to_owned(),
		},
		ScriptedRound::ToolUse {
			tool_name:             "read".to_owned(),
			arguments:             serde_json::json!({ "path": "still-does-not-exist-2.txt" }),
			provider_tool_call_id: "call_s5_two_failures_002".to_owned(),
		},
		ScriptedRound::Final {
			text:    "done after two recoverable failures".to_owned(),
			summary: "done after two recoverable failures".to_owned(),
		},
	];

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			Ok(RecordingProviderExecutor::new(
				ScriptedProviderExecutor::new(
					"anthropic",
					ProviderApiShapeV0::AnthropicMessages,
					"sentinel-model",
					rounds.clone(),
				),
				recorded_for_factory.clone(),
			))
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "please read a file" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic on recoverable failures");
	let bytes = body_bytes(response).await;
	let frames = parse_sse_frames(&bytes);
	let last = frames.last().expect("turn produced at least one frame");
	assert_eq!(
		last.kind.as_str(),
		"turn_completed",
		"two recoverable tool failures must not fail the turn"
	);

	let recorded_rounds = recorded.lock().expect("recorder mutex poisoned").clone();
	assert_eq!(
		recorded_rounds.len(),
		3,
		"the provider must see the initial round plus one continuation after each recoverable \
		 failure"
	);
	assert_eq!(recorded_rounds[1].completed_rounds_len, 1);
	assert_eq!(recorded_rounds[1].last_is_error, Some(true));
	assert_eq!(recorded_rounds[2].completed_rounds_len, 2);
	assert_eq!(recorded_rounds[2].last_is_error, Some(true));

	let session_id = frames
		.first()
		.expect("first frame carries the session_id")
		.session_id
		.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back the persisted turn");
	let projection = project_session(&page.events)
		.expect("two recoverable failures then a final round must project");
	assert_eq!(projection.tools.len(), 2, "both failed tool calls must be durable");
	assert!(
		projection
			.tools
			.iter()
			.all(|tool| tool.status == ToolCallStatus::Failed),
		"both tool calls must project as Failed"
	);
	assert_eq!(projection.errors.len(), 2, "both accepted executor errors must be durable");
	assert!(projection.artifacts.is_empty(), "a failed dispatch must never create an artifact");
}

#[tokio::test]
async fn recoverable_failure_then_successful_executable_read_then_final_is_durable() {
	let server = TestServer::start("s5-fail-then-success").await;
	let workspace = seed_workspace("s5-fail-then-success");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	std::fs::write(workspace.join("hello.txt"), b"hello world").expect("seed a real readable file");
	let recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>> =
		Arc::new(std::sync::Mutex::new(Vec::new()));
	let recorded_for_factory = recorded.clone();
	let rounds = vec![
		ScriptedRound::ToolUse {
			tool_name:             "read".to_owned(),
			arguments:             serde_json::json!({ "path": "still-does-not-exist.txt" }),
			provider_tool_call_id: "call_s5_fail_then_success_001".to_owned(),
		},
		ScriptedRound::ToolUse {
			tool_name:             "read".to_owned(),
			arguments:             serde_json::json!({ "path": "hello.txt" }),
			provider_tool_call_id: "call_s5_fail_then_success_002".to_owned(),
		},
		ScriptedRound::Final {
			text:    "done after a failure and a successful read".to_owned(),
			summary: "done after a failure and a successful read".to_owned(),
		},
	];

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			Ok(RecordingProviderExecutor::new(
				ScriptedProviderExecutor::new(
					"anthropic",
					ProviderApiShapeV0::AnthropicMessages,
					"sentinel-model",
					rounds.clone(),
				),
				recorded_for_factory.clone(),
			))
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "please read a file" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic across a failure then a success");
	let bytes = body_bytes(response).await;
	let frames = parse_sse_frames(&bytes);
	let last = frames.last().expect("turn produced at least one frame");
	assert_eq!(
		last.kind.as_str(),
		"turn_completed",
		"a recoverable failure followed by a successful read must not fail the turn"
	);

	let recorded_rounds = recorded.lock().expect("recorder mutex poisoned").clone();
	assert_eq!(recorded_rounds.len(), 3);
	assert_eq!(recorded_rounds[1].completed_rounds_len, 1);
	assert_eq!(recorded_rounds[1].last_is_error, Some(true));
	assert_eq!(recorded_rounds[2].completed_rounds_len, 2);
	assert_eq!(
		recorded_rounds[2].last_is_error,
		Some(false),
		"the successful read round must not be marked as an error for the next provider request"
	);

	let session_id = frames
		.first()
		.expect("first frame carries the session_id")
		.session_id
		.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back the persisted turn");
	let projection = project_session(&page.events)
		.expect("a failure then a success then a final round must project");
	assert_eq!(projection.tools.len(), 2);
	let failed_count = projection
		.tools
		.iter()
		.filter(|tool| tool.status == ToolCallStatus::Failed)
		.count();
	let completed_count = projection
		.tools
		.iter()
		.filter(|tool| tool.status == ToolCallStatus::Completed)
		.count();
	assert_eq!(failed_count, 1, "exactly one tool call must project as Failed");
	assert_eq!(completed_count, 1, "exactly one tool call must project as Completed");
	assert_eq!(projection.errors.len(), 1, "only the failed round durably records an error");
}

#[tokio::test]
async fn recoverable_tool_failures_consume_the_executable_tool_round_budget_like_successes_do() {
	let server = TestServer::start("s5-budget-failures").await;
	let workspace = seed_workspace("s5-budget-failures");
	let _workspace_guard = WorkspaceGuard(workspace.clone());
	let recorded: Arc<std::sync::Mutex<Vec<RecordedRound>>> =
		Arc::new(std::sync::Mutex::new(Vec::new()));
	let recorded_for_factory = recorded.clone();
	let mut rounds: Vec<ScriptedRound> = (0..=MAX_EXECUTABLE_TOOL_ROUNDS)
		.map(|i| ScriptedRound::ToolUse {
			tool_name:             "read".to_owned(),
			arguments:             serde_json::json!({ "path": format!("still-does-not-exist-{i}.txt") }),
			provider_tool_call_id: format!("call_s5_budget_{i:03}"),
		})
		.collect();
	rounds.push(ScriptedRound::Final {
		text:    "unreachable: the budget must reject the extra round first".to_owned(),
		summary: "unreachable".to_owned(),
	});

	let state = AppState::new(
		server.client(),
		Arc::new(RealIdFactory::new()),
		Arc::new(RealClock),
		workspace.clone(),
		ProviderSlot::Anthropic,
		move || {
			Ok(RecordingProviderExecutor::new(
				ScriptedProviderExecutor::new(
					"anthropic",
					ProviderApiShapeV0::AnthropicMessages,
					"sentinel-model",
					rounds.clone(),
				),
				recorded_for_factory.clone(),
			))
		},
	);
	let router = build_router(state);

	let request = Request::builder()
		.method("POST")
		.uri("/v0/turns")
		.header("content-type", "application/json")
		.body(Body::from(
			serde_json::to_vec(&serde_json::json!({ "user_text": "please read a file" })).unwrap(),
		))
		.expect("build submit_turn request");
	let response = router
		.oneshot(request)
		.await
		.expect("submit_turn does not panic when the tool-round budget is exhausted by failures");
	let bytes = body_bytes(response).await;
	let frames = parse_sse_frames(&bytes);
	let last = frames.last().expect("turn produced at least one frame");
	assert_eq!(
		last.kind.as_str(),
		"turn_failed",
		"a round requested past MAX_EXECUTABLE_TOOL_ROUNDS must stop the turn deterministically, \
		 whether prior rounds succeeded or failed"
	);

	let recorded_rounds = recorded.lock().expect("recorder mutex poisoned").clone();
	assert_eq!(
		recorded_rounds.len(),
		usize::from(MAX_EXECUTABLE_TOOL_ROUNDS) + 1,
		"the provider is asked once per executed round up to the budget, then the (budget + 1)th \
		 request is the one whose tool call gets rejected before dispatch"
	);

	let session_id = frames
		.first()
		.expect("first frame carries the session_id")
		.session_id
		.clone();
	let db_str = server.db_path.to_str().expect("utf-8 temp db path");
	let reconnected_append_store = SqliteAppendStore::connect(db_str)
		.await
		.expect("reconnect to the same on-disk sqlite file");
	let boxed_store: &dyn RawEventAppendStore = &reconnected_append_store;
	let page = boxed_store
		.read_session_events(&session_id, 0, 200)
		.await
		.expect("read back the persisted turn");
	let failed_events = page
		.events
		.iter()
		.filter(|event| event.event_type == RawEventType::ToolCallFailed)
		.count();
	assert_eq!(
		failed_events,
		usize::from(MAX_EXECUTABLE_TOOL_ROUNDS),
		"exactly MAX_EXECUTABLE_TOOL_ROUNDS failures must be durable before the budget stops the \
		 turn"
	);
}
