//! Regression test for the <agent://256> dissent ruling (item B) plus the
//! <agent://259> finding 2 / `hydration_design_adjudication` fix: the
//! continuation round after a tool call must carry the full turn
//! conversation -- the original user prompt, the provider's own `tool_use`
//! block, and the tool's full bounded result content -- not a truncated
//! preview, not a bare `artifact:<id>` reference, and not a wholesale
//! replacement that discards the original prompt and prior rounds.
//!
//! This asserts directly on the provider-native request `messages` array
//! passed into `ProviderExecutor::send_round` (captured via a recording
//! wrapper around `ScriptedProviderExecutor`, projected through
//! `provider::projection::project_conversation_request_body`), never on any
//! raw event/frame byte, so it cannot perturb any fixture-pinned oracle
//! (C7/D2).
//!
//! Before the fix, `runner.rs`'s `execute_turn` collapsed every round to a
//! single `round_text` string, replaced wholesale by
//! `ToolDispatchSuccess::provider_result_text` after each tool dispatch: the
//! post-`read` round carried only the tool result, with the original
//! prompt and the provider's own `tool_use` call gone entirely. This test
//! fails against that behavior (round 1 would carry a single bare-string
//! message, not `[user prompt, assistant tool_use, user tool_result]`) and
//! passes once the runner threads `completed_rounds` through `send_round`
//! instead.

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
	provider::projection,
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

/// Wraps an inner [`ProviderExecutor`], recording the provider-native
/// request `messages` array for every round it is called with (in call
/// order) into `rounds_seen`, before delegating to the inner executor
/// unchanged. The inner `ScriptedProviderExecutor` ignores both its
/// `user_text` and `completed_rounds` arguments entirely, so wrapping it
/// cannot perturb the scripted rounds it plays back.
struct RecordingProviderExecutor {
	inner:       ScriptedProviderExecutor,
	rounds_seen: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
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
		let body = projection::project_conversation_request_body(
			&self.inner.api_shape(),
			user_text,
			completed_rounds,
			catalog,
		);
		let messages = body["messages"]
			.as_array()
			.expect("anthropic conversation projection always emits a messages array")
			.clone();
		self
			.rounds_seen
			.lock()
			.expect("rounds_seen mutex poisoned")
			.push(messages);
		self
			.inner
			.send_round(user_text, completed_rounds, catalog, message_id, tool_call_id)
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

	let round0 = &rounds[0];
	assert_eq!(round0.len(), 1, "round 0 must carry only the original user message; got {round0:?}");
	assert_eq!(round0[0]["role"], "user", "round 0's only message must be the user prompt");
	assert_eq!(
		round0[0]["content"][0]["text"], "what package is this?",
		"round 0 must carry the unmodified original user prompt"
	);

	let round1 = &rounds[1];
	assert_eq!(
		round1.len(),
		3,
		"round 1 (post-read continuation) must carry [user prompt, assistant tool_use, user \
		 tool_result]; got {round1:?}"
	);
	assert_eq!(
		round1[0]["content"][0]["text"], "what package is this?",
		"round 1 must still carry the original user prompt -- the pre-fix defect discarded it \
		 entirely after the first tool hop, collapsing the round to the tool result alone"
	);
	assert_eq!(
		round1[1]["role"], "assistant",
		"round 1's second message must echo the provider's tool_use"
	);
	assert_eq!(round1[1]["content"][0]["type"], "tool_use");
	assert_eq!(round1[1]["content"][0]["name"], "read");
	assert_eq!(round1[2]["role"], "user", "round 1's third message must carry the tool_result");
	assert_eq!(round1[2]["content"][0]["type"], "tool_result");
	let tool_result_content = round1[2]["content"][0]["content"]
		.as_str()
		.expect("tool_result content is a bounded text string");
	assert!(
		tool_result_content.contains(manifest_body),
		"round 1's tool_result must carry the full bounded Cargo.toml body, not a preview or a bare \
		 artifact handle; got: {tool_result_content:?}"
	);
	assert!(
		!tool_result_content.contains("artifact:"),
		"round 1's tool_result must not degrade to a bare artifact handle reference; got: \
		 {tool_result_content:?}"
	);

	cleanup_workspace(&workspace_root);
}
