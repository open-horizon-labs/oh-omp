//! Regression test for the <agent://256> dissent ruling (item B): the
//! provider round after a tool call must receive the tool's full bounded
//! result content, not a truncated preview and not a bare `artifact:<id>`
//! reference.
//!
//! This asserts directly on the `round_text` argument passed into
//! `ProviderExecutor::send_round` (captured via a recording wrapper around
//! `ScriptedProviderExecutor`), never on any raw event/frame byte, so it
//! cannot perturb any fixture-pinned oracle (C7/D2).
//!
//! Before the fix, every round's `round_text` was `&input.user_text`
//! unconditionally (`runner.rs`'s `execute_turn`), so the post-`read`
//! round never carried the file body at all: `round_text` stayed
//! `"what package is this?"` and never contained the manifest body. This
//! test fails against that behavior and passes once `round_text` is
//! replaced by `ToolDispatchSuccess::provider_result_text` after each
//! successful tool dispatch.

use std::{
	path::PathBuf,
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, Ordering},
	},
};

use successor_context_platform::{
	auth::PlatformLicense, http::build_router, routes::PlatformState,
};
use successor_kernel::{
	frame_sink::FrameSink,
	id_factory::{Clock, IdFactory, RealClock, RealIdFactory},
	platform_client::{EntitlementToken, KernelPlatformClient},
	runner::{
		ProviderExecutor, ProviderRoundOutcome, ScriptedProviderExecutor, ScriptedRound, TurnInput,
		TurnRunner,
	},
	state_machine::TurnFailure,
	stream::KernelFrameStream,
};
use successor_protocol::{
	ids::{MessageId, ToolCallId},
	provider::ProviderApiShapeV0,
	tool_catalog::ToolCatalogV0,
};

const LICENSE: &str = "dev-license-item-b-hydration-abc123";

fn temp_db_path(label: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock after epoch")
		.as_nanos();
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-kernel-item-b-{label}-{}-{n}-{nanos}.sqlite3", std::process::id()))
}

/// A live instance of the accepted platform router, bound on `127.0.0.1:0`
/// with a real temporary `SQLite` database, served over a real TCP
/// listener for the lifetime of the test (C1/C7 precedent).
struct TestServer {
	base_url: String,
	db_path:  PathBuf,
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
		Self { base_url: format!("http://{addr}/v0"), db_path, handle }
	}

	fn client(&self) -> KernelPlatformClient {
		KernelPlatformClient::new(self.base_url.clone(), EntitlementToken::new(LICENSE))
	}
}

impl Drop for TestServer {
	fn drop(&mut self) {
		self.handle.abort();
		let _ = std::fs::remove_file(&self.db_path);
	}
}

/// Seeds a temporary workspace containing a multiline `Cargo.toml`-shaped
/// manifest, so a `read` tool call against a real filesystem produces a
/// real multi-line file body (the live incident this ruling amends
/// involved exactly this: `read {path:"crates/successor-cli/Cargo.toml"}`
/// degrading to a single-line `{"preview":"[package]"}`).
fn seed_workspace_with_manifest(label: &str, manifest_body: &str) -> PathBuf {
	let root = std::env::temp_dir().join(format!(
		"successor-kernel-item-b-workspace-{label}-{}-{}",
		std::process::id(),
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("clock after epoch")
			.as_nanos()
	));
	std::fs::create_dir_all(&root).expect("create workspace root");
	std::fs::write(root.join("Cargo.toml"), manifest_body).expect("seed the read fixture file");
	root
}

fn cleanup_workspace(root: &PathBuf) {
	let _ = std::fs::remove_dir_all(root);
}

/// Wraps an inner [`ProviderExecutor`], recording every `round_text` it is
/// called with (in call order) into `rounds_seen` before delegating to the
/// inner executor unchanged. The inner `ScriptedProviderExecutor` ignores
/// its `round_text` argument entirely, so wrapping it cannot perturb the
/// scripted rounds it plays back.
struct RecordingProviderExecutor {
	inner:       ScriptedProviderExecutor,
	rounds_seen: Arc<Mutex<Vec<String>>>,
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
		round_text: &str,
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		self
			.rounds_seen
			.lock()
			.expect("rounds_seen mutex poisoned")
			.push(round_text.to_owned());
		self
			.inner
			.send_round(round_text, catalog, message_id, tool_call_id)
			.await
	}
}

#[tokio::test]
async fn provider_continuation_round_after_read_carries_the_full_bounded_file_content() {
	let manifest_body =
		"[package]\nname = \"item-b-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
	let server = TestServer::start("read-hydration").await;
	let workspace_root = seed_workspace_with_manifest("read-hydration", manifest_body);

	let rounds_seen = Arc::new(Mutex::new(Vec::new()));
	let provider = RecordingProviderExecutor {
		inner:       ScriptedProviderExecutor::new(
			"scripted-anthropic",
			ProviderApiShapeV0::AnthropicMessages,
			"scripted-model",
			[
				ScriptedRound::ToolUse {
					tool_name:             "read".to_owned(),
					arguments:             serde_json::json!({ "path": "Cargo.toml" }),
					provider_tool_call_id: "toolu_01_item_b_read".to_owned(),
				},
				ScriptedRound::Final {
					text:    "this is a Rust package manifest".to_owned(),
					summary: "described the manifest".to_owned(),
				},
			],
		),
		rounds_seen: rounds_seen.clone(),
	};

	let frame_sink = FrameSink::new(KernelFrameStream::new());
	let runner = TurnRunner::new(
		server.client(),
		frame_sink,
		Arc::new(RealIdFactory::new()) as Arc<dyn IdFactory>,
		Arc::new(RealClock) as Arc<dyn Clock>,
		provider,
		&workspace_root,
	);

	let attempt = runner
		.execute_turn(TurnInput {
			user_text:      "what package is this?".to_owned(),
			assembly_query: None,
		})
		.await;

	assert!(
		attempt.trace.succeeded(),
		"expected the scripted read-then-final turn to succeed: {:?}",
		attempt.outcome
	);

	let rounds = rounds_seen
		.lock()
		.expect("rounds_seen mutex poisoned")
		.clone();
	assert_eq!(
		rounds.len(),
		2,
		"expected exactly two provider rounds: pre-tool and post-read; got {rounds:?}"
	);

	let pre_tool_round_text = &rounds[0];
	assert_eq!(
		pre_tool_round_text, "what package is this?",
		"the first round is the original user turn and must be unchanged"
	);

	let post_read_round_text = &rounds[1];
	assert!(
		post_read_round_text.contains(manifest_body),
		"round N+1 (post-read) must carry the full bounded Cargo.toml body, not a preview or a bare \
		 artifact handle; got: {post_read_round_text:?}"
	);
	assert!(
		!post_read_round_text.contains("artifact:"),
		"round N+1 must not degrade to a bare artifact handle reference; got: \
		 {post_read_round_text:?}"
	);
	assert_ne!(
		post_read_round_text, "what package is this?",
		"round N+1 must not be the bare, unhydrated original user text (the pre-fix defect)"
	);

	cleanup_workspace(&workspace_root);
}
