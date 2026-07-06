//! Regression coverage for `<agent://256>` dissent ruling item A: the
//! Slice 0 tool-round budget (`MAX_EXECUTABLE_TOOL_ROUNDS`, commit
//! `1e0b8ca98`) decoupled the runner's round counter from `TurnPhase`, but
//! left `TurnState::validate_next` enforcing strictly-advancing phase
//! transitions. Any turn requesting a third (or later) tool round pinned at
//! `TurnPhase::PostRead` hit `ToolCompleted(PostRead) ->
//! Assembling(PostRead)`, an illegal self-cycle under the old validator.
//!
//! This harness reuses the `TestServer` + `ScriptedProviderExecutor`
//! pattern from `item_b_provider_result_hydration.rs`.

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
	state_machine::{MAX_EXECUTABLE_TOOL_ROUNDS, TurnFailure, TurnState},
	stream::KernelFrameStream,
};
use successor_protocol::{
	ids::{MessageId, ToolCallId},
	kernel_frame::KernelFrameKindV0,
	provider::ProviderApiShapeV0,
	tool_catalog::ToolCatalogV0,
};

const LICENSE: &str = "dev-license-item-a-pinned-cycle-def456";

fn temp_db_path(label: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock after epoch")
		.as_nanos();
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-kernel-item-a-{label}-{}-{n}-{nanos}.sqlite3", std::process::id()))
}

/// A live instance of the accepted platform router, bound on `127.0.0.1:0`
/// with a real temporary `SQLite` database, served over a real TCP
/// listener for the lifetime of the test (C1/C7 precedent, reused from
/// `item_b_provider_result_hydration.rs`).
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

/// Seeds a temporary workspace containing a `Cargo.toml`-shaped manifest so
/// `read`/`find`/`grep` tool calls against a real filesystem all succeed.
fn seed_workspace_with_manifest(label: &str, manifest_body: &str) -> PathBuf {
	let root = std::env::temp_dir().join(format!(
		"successor-kernel-item-a-workspace-{label}-{}-{}",
		std::process::id(),
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("clock after epoch")
			.as_nanos()
	));
	std::fs::create_dir_all(&root).expect("create workspace root");
	std::fs::write(root.join("Cargo.toml"), manifest_body)
		.expect("seed the read/find/grep fixture file");
	root
}

fn cleanup_workspace(root: &PathBuf) {
	let _ = std::fs::remove_dir_all(root);
}

/// Wraps an inner [`ProviderExecutor`], recording the effective text each
/// round is called with (the turn's `user_text`, plus the completed tool
/// rounds' bounded result text once any exist) into `rounds_seen` before
/// delegating to the inner executor unchanged.
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
		user_text: &str,
		completed_rounds: &[projection::CompletedToolRoundV0],
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		let effective_round_text = if completed_rounds.is_empty() {
			user_text.to_owned()
		} else {
			format!(
				"{user_text}\n{}",
				completed_rounds
					.iter()
					.map(|round| round.result_text.as_str())
					.collect::<Vec<_>>()
					.join("\n")
			)
		};
		self
			.rounds_seen
			.lock()
			.expect("rounds_seen mutex poisoned")
			.push(effective_round_text);
		self
			.inner
			.send_round(user_text, completed_rounds, catalog, message_id, tool_call_id)
			.await
	}
}

/// Regression for <agent://256> item A: four scripted tool rounds (read,
/// find, grep, find) push the pinned phase two rounds past
/// `TurnPhase::PostRead`'s first arrival, each round exercising the
/// `ToolCompleted(PostRead) -> Assembling(PostRead)` self-cycle that the
/// old strictly-advancing validator rejected. The turn must still
/// complete, and every round after the first must carry hydrated
/// tool-result text, not the bare original user turn.
#[tokio::test]
async fn four_tool_rounds_pinned_past_post_read_still_completes() {
	let manifest_body =
		"[package]\nname = \"item-a-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
	let server = TestServer::start("four-rounds").await;
	let workspace_root = seed_workspace_with_manifest("four-rounds", manifest_body);

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
					provider_tool_call_id: "toolu_01_item_a_round_1_read".to_owned(),
				},
				ScriptedRound::ToolUse {
					tool_name:             "find".to_owned(),
					arguments:             serde_json::json!({ "glob": "**/*" }),
					provider_tool_call_id: "toolu_02_item_a_round_2_find".to_owned(),
				},
				ScriptedRound::ToolUse {
					tool_name:             "grep".to_owned(),
					arguments:             serde_json::json!({ "pattern": "package" }),
					provider_tool_call_id: "toolu_03_item_a_round_3_grep".to_owned(),
				},
				ScriptedRound::ToolUse {
					tool_name:             "find".to_owned(),
					arguments:             serde_json::json!({ "glob": "**/*" }),
					provider_tool_call_id: "toolu_04_item_a_round_4_find".to_owned(),
				},
				ScriptedRound::Final {
					text:    "this workspace has one fixture crate".to_owned(),
					summary: "described the workspace after four tool rounds".to_owned(),
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
			user_text:      "what is in this workspace?".to_owned(),
			assembly_query: None,
		})
		.await;

	assert!(
		attempt.trace.succeeded(),
		"expected the four-tool-round turn (pinned twice past PostRead) to complete: {:?}",
		attempt.outcome
	);
	assert_eq!(
		attempt.trace.terminal_state(),
		Some(TurnState::Completed),
		"expected the terminal state to be Completed, not a partial/failed trace"
	);

	let rounds = rounds_seen
		.lock()
		.expect("rounds_seen mutex poisoned")
		.clone();
	assert_eq!(
		rounds.len(),
		5,
		"expected five provider rounds: pre-tool, post-locator, and three pinned-PostRead rounds \
		 (two of which only exist because of the pinned self-cycle); got {rounds:?}"
	);

	assert_eq!(
		rounds[0], "what is in this workspace?",
		"the first round is the original user turn and must be unchanged"
	);

	for (index, round_text) in rounds.iter().enumerate().skip(1) {
		assert!(
			!round_text.is_empty(),
			"round {index} (post-tool-round hydration) must not be empty"
		);
		assert_ne!(
			round_text, "what is in this workspace?",
			"round {index} must not be the bare, unhydrated original user text"
		);
	}

	cleanup_workspace(&workspace_root);
}

/// Regression for <agent://256> item A: a turn that requests
/// `MAX_EXECUTABLE_TOOL_ROUNDS + 1` tool rounds must still fail with the
/// typed `TurnFailure::ToolBudgetExhausted` variant (the pre-existing
/// budget enforcement), not with `TurnFailure::IllegalTransition` (the bug
/// this change fixes). This pins the boundary: legalizing the pinned
/// `PostRead` self-cycle must not weaken or bypass the round budget.
#[tokio::test]
async fn tool_round_past_the_budget_still_fails_with_tool_budget_exhausted_not_illegal_transition()
{
	let manifest_body =
		"[package]\nname = \"item-a-budget-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
	let server = TestServer::start("budget-exhaustion").await;
	let workspace_root = seed_workspace_with_manifest("budget-exhaustion", manifest_body);

	assert_eq!(
		MAX_EXECUTABLE_TOOL_ROUNDS, 8,
		"this test's scripted round count is derived from MAX_EXECUTABLE_TOOL_ROUNDS; if the budget \
		 constant changes, the script below must grow with it"
	);

	// One more ToolUse round than the runner will execute: the budget check
	// rejects the (MAX_EXECUTABLE_TOOL_ROUNDS + 1)-th tool call before ever
	// dispatching it, so no trailing `Final` round is needed.
	let scripted_rounds: Vec<ScriptedRound> = (0..=MAX_EXECUTABLE_TOOL_ROUNDS)
		.map(|round_number| ScriptedRound::ToolUse {
			tool_name:             "find".to_owned(),
			arguments:             serde_json::json!({ "glob": "**/*" }),
			provider_tool_call_id: format!("toolu_budget_round_{round_number}"),
		})
		.collect();

	let provider = ScriptedProviderExecutor::new(
		"scripted-anthropic",
		ProviderApiShapeV0::AnthropicMessages,
		"scripted-model",
		scripted_rounds,
	);

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
			user_text:      "keep finding files forever".to_owned(),
			assembly_query: None,
		})
		.await;

	assert!(
		!attempt.trace.succeeded(),
		"expected the over-budget turn to fail, not complete: {:?}",
		attempt.outcome
	);
	assert_eq!(
		attempt.trace.terminal_state(),
		Some(TurnState::Failed),
		"expected the terminal state to be Failed"
	);
	match &attempt.outcome {
		Err(TurnFailure::ToolBudgetExhausted) => {},
		other => panic!(
			"expected TurnFailure::ToolBudgetExhausted (the pre-existing budget enforcement), got \
			 {other:?}. An IllegalTransition here would mean legalizing the pinned PostRead \
			 self-cycle regressed into bypassing (or misreporting) the round budget instead of just \
			 fixing the false-positive rejection."
		),
	}

	// <agent://256> item A review finding (P1, item 1): exceeding the live
	// per-turn tool-call maximum must still emit `tool_call.rejected`
	// followed by `error.recorded` before the turn fails (contract §9
	// amendment, commit 1e0b8ca98) -- reusing the same raw-event machinery
	// `dispatch_tool_call` uses for a catalog-visible, stub-rejected tool.
	// Pre-fix, the budget check returned `Err(TurnFailure::ToolBudgetExhausted)`
	// immediately with no event appended for this round at all, so this
	// assertion fails against that behavior and only passes once the two
	// events are appended before the early return.
	let event_types: Vec<&str> = attempt
		.trace
		.events()
		.iter()
		.map(|event| event.event_type.as_str())
		.collect();
	assert!(
		event_types.len() >= 2,
		"expected at least a `tool_call.rejected` and `error.recorded` raw event on the over-budget \
		 path; got {event_types:?}"
	);
	assert_eq!(
		&event_types[event_types.len() - 2..],
		["tool_call.rejected", "error.recorded"],
		"expected the persisted raw-event trail to end with `tool_call.rejected` immediately \
		 followed by `error.recorded` before the turn_failed terminal (contract §9 amendment for \
		 exceeding the live per-turn tool budget); got {event_types:?}"
	);

	cleanup_workspace(&workspace_root);
}

/// Regression for <agent://256> item A: the terminal frame kind for a turn
/// that completes after being pinned twice past `PostRead` must still be
/// `turn_completed`, matching the observed live-incident evidence
/// (`turn_failed` was the symptom of the bug this change fixes).
#[tokio::test]
async fn terminal_frame_kind_for_completed_pinned_cycle_turn_is_turn_completed() {
	let manifest_body = "[package]\nname = \"item-a-frame-fixture\"\nversion = \"0.1.0\"\n";
	let server = TestServer::start("frame-kind").await;
	let workspace_root = seed_workspace_with_manifest("frame-kind", manifest_body);

	let provider = ScriptedProviderExecutor::new(
		"scripted-anthropic",
		ProviderApiShapeV0::AnthropicMessages,
		"scripted-model",
		[
			ScriptedRound::ToolUse {
				tool_name:             "read".to_owned(),
				arguments:             serde_json::json!({ "path": "Cargo.toml" }),
				provider_tool_call_id: "toolu_frame_round_1_read".to_owned(),
			},
			ScriptedRound::ToolUse {
				tool_name:             "find".to_owned(),
				arguments:             serde_json::json!({ "glob": "**/*" }),
				provider_tool_call_id: "toolu_frame_round_2_find".to_owned(),
			},
			ScriptedRound::ToolUse {
				tool_name:             "grep".to_owned(),
				arguments:             serde_json::json!({ "pattern": "package" }),
				provider_tool_call_id: "toolu_frame_round_3_grep".to_owned(),
			},
			ScriptedRound::ToolUse {
				tool_name:             "find".to_owned(),
				arguments:             serde_json::json!({ "glob": "**/*" }),
				provider_tool_call_id: "toolu_frame_round_4_find".to_owned(),
			},
			ScriptedRound::Final { text: "done".to_owned(), summary: "done".to_owned() },
		],
	);

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
			user_text:      "what is in this workspace?".to_owned(),
			assembly_query: None,
		})
		.await;

	assert!(attempt.trace.succeeded(), "expected success: {:?}", attempt.outcome);
	let last_frame_kind = attempt
		.trace
		.frames()
		.last()
		.expect("expected at least one emitted frame")
		.kind
		.clone();
	assert_eq!(
		last_frame_kind,
		KernelFrameKindV0::TurnCompleted,
		"the last emitted frame for a completed turn (even one pinned twice past PostRead) must be \
		 turn_completed, not turn_failed"
	);

	cleanup_workspace(&workspace_root);
}
