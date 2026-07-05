//! Owned by Lane C7 `KernelTurnRunner`.
//!
//! Integration coverage for [`TurnRunner`] against the accepted platform
//! router (`successor_context_platform::http::build_router`), bound on
//! `127.0.0.1:0` with a real temporary `SQLite` database and exercised over
//! real TCP (Dissent ruling 2), following the C1 precedent in
//! `slice0_platform_client.rs`. Tool execution runs the real
//! `crate::tools` dispatch against a real temporary workspace seeded with
//! the same fixture content the accepted C6 tests use
//! (`slice0_tools_discovery.rs`).
//!
//! ## Byte-identity oracle (task 210's binding ruling, Option B)
//!
//! Both oracle tests below drive `execute_turn` through a fully
//! [`ScriptedIdFactory`]/[`ScriptedClock`] seam -- never `RealIdFactory`/
//! `RealClock`, which task 210 explicitly rejects for this file -- and
//! compare the produced raw events (both tests), `project_session`
//! projection (successful-turn only), and frames (successful-turn only)
//! against the canonical fixtures at full DTO/byte depth, under ONE
//! global, consistent bijection applied ONLY to the four platform-minted
//! id classes: `session_id`, `assemble_id`, `context_item_id`, and the
//! platform's own `AssemblyTrace` trace id (this Slice-0 lane never
//! observes that fourth class: every `entity_ids.trace_id` this runner
//! emits is minted by its own `IdFactory::trace_id()`, confirmed in
//! `runner.rs`, so it participates in the literal comparison below like
//! any other kernel-minted id). The bijection is recorded by
//! [`IdBijection`]: fixture and produced ids map 1:1 in both directions,
//! one mapping applied across events + projection + frames, and any
//! unmapped id-like field that still differs fails the assertion loudly,
//! naming the offending field.
//!
//! Every other field -- `event_id`, `turn_id`, `request_id`, `message_id`,
//! `tool_call_id`, `frame_id`, kernel `trace_id`, `provider_event_id`,
//! `error_id`, `source_envelope_id`, `artifact_id`, `catalog_id`,
//! `causation_event_id` (after bijection), `occurred_at`, `session_seq`,
//! event types, producers, visibility, and payloads -- is scripted to the
//! fixture's own literal bytes and compared without normalization.
//! `RealIdFactory`/`RealClock` are never used to drive either oracle turn
//! (task 210's ruling explicitly rejects that design): every
//! kernel-controlled seam is scripted so the runner reproduces the fixture's
//! bytes deterministically.
//!
//! ## Ruled exclusions beyond the id bijection (tasks 212, 214)
//!
//! Two additional narrow exclusions apply on top of the id bijection above,
//! and neither may be widened without a new binding ruling:
//!
//! 1. **`idempotency_key` (both oracles).** The canonical fixtures use
//!    human-authored descriptive labels (e.g. `"fixture:catalog:1"`) as
//!    structural context, not a literal production contract. Both oracles
//!    normalize the produced `idempotency_key` to the fixture's literal value
//!    before the byte-for-byte comparison, then separately assert the
//!    production invariants directly against the *un-normalized* produced
//!    value: every produced key equals the runner's disclosed derivation
//!    (`{turn_id}:{event_id}`, or `{session_id}:{event_id}` for the turn-less
//!    `tool_catalog.published` event), every key is unique within the session,
//!    and re-appending an already-stored key is idempotent (the platform's
//!    `duplicate: true` / stable `session_seq` behavior).
//! 2. **The task-212 four-class exclusion, isolated-tail oracle only.** The
//!    unsupported-tool oracle drives a full `execute_turn` (scripted provider
//!    requesting `bash`), so the PRODUCED stream carries a real preamble and
//!    continues its numbering/causality from real turn history — while the
//!    FIXTURE is an isolated tail authored in Wave A with its own numbering
//!    (`session_seq` from 1, no first-event causation, label-style keys). For
//!    that fixture only, `session_seq`, the first event's `causation_event_id`,
//!    `idempotency_key` (folded into exclusion 1 above), and `VisibilityV0` are
//!    asserted against the runner's own production construction
//!    (`expected_tail_visibility`, mirroring `runner::visibility_for`) rather
//!    than the fixture's literal recorded values. This exclusion does NOT apply
//!    to the successful-turn oracle, where all 23 events compare those fields
//!    literally.
//!
//! `VisibilityV0` itself is otherwise NOT an exclusion: `runner.rs`'s
//! `visibility_for` (task-214 ruling) constructs the exact per-event-type
//! fixture values for every event in both fixtures, so the successful-turn
//! oracle compares `visibility` literally with no normalization.
//!
//! ## Task 216: assembly-query seam, derived source ids, phase shapes
//!
//! Three related fixes apply on top of the byte-identity oracle above:
//! 1. `TurnInput::assembly_query` is an explicit override for the `pre_tool`
//!    `assembly.requested` payload's `query` field and the `/assemble` intent's
//!    `query`. Production callers leave it `None` and the runner falls back to
//!    `user_text` verbatim; this file's successful-turn replay supplies the
//!    fixture-literal query (`"concept graph resolver"`), which is not the full
//!    user prompt.
//! 2. `post_locator`/`post_read` `assembly.requested` payloads carry
//!    `required_source_envelope_ids`: the source-envelope ids introduced by
//!    tool-result raw events recorded so far for the current phase, in recorded
//!    order (`runner.rs`'s `assemble_round`).
//! 3. `assembly.requested` payloads are phase-shaped, not uniform: `pre_tool`
//!    is `{phase, query, max_context_tokens, max_items}`;
//!    `post_locator`/`post_read` are `{phase, required_source_envelope_ids}`
//!    only. No `/assemble` DTO field leaks into a raw-event payload beyond
//!    these two shapes.

use std::{
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use successor_context_platform::{
	auth::PlatformLicense, http::build_router, routes::PlatformState,
};
use successor_kernel::{
	frame_sink::FrameSink,
	id_factory::{Clock, IdFactory, ScriptedClock, ScriptedIdFactory},
	platform_client::{EntitlementToken, KernelPlatformClient},
	provider::auth::{ProviderAuthOutcome, ProviderSlot},
	runner::{
		ScriptedProviderExecutor, ScriptedRound, TurnContext, TurnInput, TurnRunner,
		require_provider_credential,
	},
	state_machine::{TurnFailure, TurnPhase, TurnState},
	stream::KernelFrameStream,
	tools::catalog,
};
use successor_protocol::{
	fixtures, kernel_frame, raw_event, validation::validate_unsupported_tool_lifecycle,
};

const LICENSE: &str = "dev-license-c7-integration-abc123";

fn temp_db_path(label: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock after epoch")
		.as_nanos();
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-kernel-c7-{label}-{}-{n}-{nanos}.sqlite3", std::process::id()))
}

/// A live instance of the accepted platform router, bound on
/// `127.0.0.1:0` with a real temporary `SQLite` database, served over a
/// real TCP listener for the lifetime of the test (C1 precedent).
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

/// Seeds a temporary workspace with the same fixture content the accepted
/// C6 tests use (`slice0_tools_discovery.rs`), so `search_files`/`read`
/// against a real filesystem reproduce the canonical fixture's score,
/// path, and preview exactly.
fn seed_workspace(label: &str) -> PathBuf {
	let root = std::env::temp_dir().join(format!(
		"successor-kernel-c7-workspace-{label}-{}-{}",
		std::process::id(),
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("clock after epoch")
			.as_nanos()
	));
	let concept_graph_dir = root.join("packages/coding-agent/src/context");
	std::fs::create_dir_all(&concept_graph_dir).expect("create fixture directory tree");
	std::fs::write(
		concept_graph_dir.join("concept-graph.ts"),
		b"export class ConceptGraphResolver {\n  // fixture content\n}\n",
	)
	.expect("seed concept-graph.ts fixture file");
	root
}

fn cleanup_workspace(root: &PathBuf) {
	let _ = std::fs::remove_dir_all(root);
}

// ---------------------------------------------------------------------
// Byte-identity bijection (task 210, Option B): normalizes exactly the
// four platform-minted id classes so the remaining full-DTO comparison
// can assert literal fixture bytes everywhere else.
// ---------------------------------------------------------------------

/// Records a 1:1 mapping between this run's platform-minted opaque ids
/// (`session_id`, `assemble_id`, `context_item_id`) and the canonical
/// fixture's own literal placeholders for the same id, so a subsequent
/// full-struct equality assertion against the fixture only fails on
/// genuine byte divergence in kernel-controlled fields. Fails loudly,
/// naming the offending field, if either direction of the mapping is not
/// injective.
#[derive(Default)]
struct IdBijection {
	produced_to_fixture: std::collections::HashMap<String, String>,
	fixture_to_produced: std::collections::HashMap<String, String>,
}

impl IdBijection {
	fn record(&mut self, field: &str, produced: &str, fixture: &str) {
		if let Some(existing) = self.produced_to_fixture.get(produced) {
			assert_eq!(
				existing, fixture,
				"{field} bijection is not injective: produced id {produced:?} would map to both \
				 {existing:?} and {fixture:?}"
			);
		} else {
			self
				.produced_to_fixture
				.insert(produced.to_owned(), fixture.to_owned());
		}
		if let Some(existing) = self.fixture_to_produced.get(fixture) {
			assert_eq!(
				existing, produced,
				"{field} bijection is not injective: fixture id {fixture:?} would map to both \
				 {existing:?} and {produced:?}"
			);
		} else {
			self
				.fixture_to_produced
				.insert(fixture.to_owned(), produced.to_owned());
		}
	}

	/// Returns the produced clone of `event`, with its `session_id`
	/// normalized to the fixture's own literal placeholder (recording the
	/// mapping the first time this `session_id` is seen). Every other field
	/// is left untouched for literal comparison by the caller.
	fn normalize_session(
		&mut self,
		event: &raw_event::RawEventV0,
		fixture_session_id: &str,
	) -> raw_event::RawEventV0 {
		self.record("session_id", event.session_id.as_str(), fixture_session_id);
		let mut normalized = event.clone();
		normalized.session_id =
			successor_protocol::ids::SessionId::from_raw(fixture_session_id.to_owned());
		normalized
	}
}

/// Task-214 ruling: `VisibilityV0` construction is fixture-derived (see
/// `runner::visibility_for`'s doc comment for the full per-event-type
/// mapping table). This mirrors that construction (the function is
/// crate-private to `successor-kernel`, so the oracle cannot import it
/// directly), so the oracle now asserts a literal match against the
/// canonical fixture's recorded visibility for every event in the
/// unsupported-tool tail.
fn expected_tail_visibility(event_type: raw_event::RawEventType) -> raw_event::VisibilityV0 {
	match event_type {
		raw_event::RawEventType::ProviderToolCallObserved => raw_event::VisibilityV0 {
			model:      false,
			transcript: false,
			recall:     false,
			assemble:   false,
			share:      false,
			debug:      true,
		},
		raw_event::RawEventType::ToolCallRequested => raw_event::VisibilityV0 {
			model:      false,
			transcript: true,
			recall:     false,
			assemble:   false,
			share:      false,
			debug:      true,
		},
		raw_event::RawEventType::ToolCallRejected | raw_event::RawEventType::ErrorRecorded => {
			raw_event::VisibilityV0 {
				model:      true,
				transcript: true,
				recall:     false,
				assemble:   false,
				share:      false,
				debug:      true,
			}
		},
		other => {
			panic!("expected_tail_visibility: unexpected unsupported-tool tail event type {other:?}")
		},
	}
}

// ---------------------------------------------------------------------
// Unsupported-tool oracle (task 210, Option B): full-DTO byte comparison
// of the produced tail against raw-events-unsupported-tool.json, with
// bijection for session_id only (this scenario carries no assemble_id/
// context_item_ids/platform trace anywhere in its tail).
// ---------------------------------------------------------------------

#[tokio::test]
async fn unsupported_tool_dispatch_matches_the_canonical_fixture_and_passes_the_lifecycle_oracle() {
	let server = TestServer::start("unsupported-tool").await;
	let client = server.client();
	let workspace_root = seed_workspace("unsupported-tool");

	let fixture = fixtures::raw_events_unsupported_tool();
	assert_eq!(fixture.len(), 4, "canonical fixture is a 4-event isolated tail");

	// The preamble (catalog publish, user turn, one PreTool assemble
	// round, the provider request) precedes the fixture's 4-event tail
	// and has no fixture data of its own to script against; its ids only
	// need to be validly typed, not literal, EXCEPT for turn_id/
	// request_id/session_id, which persist onto every tail event and so
	// must resolve to the fixture's own literal values by the time the
	// tail is compared. `session_id` is platform-minted (`create_session`)
	// and is bijected below rather than scripted.
	let ids = ScriptedIdFactory::builder()
		.event_ids([
			"evt_00000000-0000-4000-8000-000000000e01", // tool_catalog.published (preamble)
			"evt_00000000-0000-4000-8000-000000000e02", // user_turn.recorded (preamble)
			"evt_00000000-0000-4000-8000-000000000e03", // assembly.requested (preamble)
			"evt_00000000-0000-4000-8000-000000000e04", // assembly.completed (preamble)
			"evt_00000000-0000-4000-8000-000000000e05", // provider_request.built (preamble)
			"evt_10000000-0000-4000-8000-000000000001", // tail[0] provider_tool_call.observed
			"evt_10000000-0000-4000-8000-000000000002", // tail[1] tool_call.requested
			"evt_10000000-0000-4000-8000-000000000003", // tail[2] tool_call.rejected
			"evt_10000000-0000-4000-8000-000000000004", // tail[3] error.recorded
		])
		.turn_id("turn_10000000-0000-4000-8000-000000000001")
		.request_id("req_10000000-0000-4000-8000-000000000001")
		.tool_call_ids(["tool_10000000-0000-4000-8000-000000000001"])
		.error_ids(["err_10000000-0000-4000-8000-000000000001"])
		.message_ids([
			"msg_00000000-0000-4000-8000-000000000e01",
			"msg_00000000-0000-4000-8000-000000000e02",
		])
		.source_envelope_ids(["src_00000000-0000-4000-8000-000000000e01"])
		.trace_ids([
			"trace_00000000-0000-4000-8000-000000000e00",
			"trace_00000000-0000-4000-8000-000000000e01",
		])
		.provider_event_ids(["pevt_10000000-0000-4000-8000-000000000001"])
		.catalog_ids(["catalog-fixture-unsupported-tool"])
		.frame_ids((1..=8u32).map(|n| format!("frame_00000000-0000-4000-8000-{n:012}")))
		.build();
	let clock = ScriptedClock::new(
		(0..9u32)
			.map(|n| format!("2020-01-01T00:00:{n:02}Z"))
			.chain([
				"2026-06-23T12:10:00Z".to_owned(), // index 9 = tail[0]
				"2026-06-23T12:10:01Z".to_owned(), // index 10 = tail[1]
				"2026-06-23T12:10:02Z".to_owned(), // index 11 = tail[2]
				"2026-06-23T12:10:03Z".to_owned(), // index 12 = tail[3]
			])
			.chain((100..110u32).map(|n| format!("2020-01-01T01:00:{n:02}Z"))),
	);

	let provider = ScriptedProviderExecutor::new(
		"anthropic",
		successor_protocol::provider::ProviderApiShapeV0::AnthropicMessages,
		"claude-fixture",
		[ScriptedRound::ToolUse {
			tool_name:             "bash".to_owned(),
			arguments:             serde_json::json!({ "command": "echo should-not-run" }),
			provider_tool_call_id: "toolu_01_fixture_bash".to_owned(),
		}],
	);
	let frame_sink = FrameSink::new(KernelFrameStream::new());
	let runner = TurnRunner::new(
		client,
		frame_sink,
		Arc::new(ids) as Arc<dyn IdFactory>,
		Arc::new(clock) as Arc<dyn Clock>,
		provider,
		&workspace_root,
	);

	let attempt = runner
		.execute_turn(TurnInput {
			user_text:      "Run echo should-not-run".to_owned(),
			assembly_query: None,
		})
		.await;

	assert!(!attempt.trace.succeeded(), "bash must not be executable in Slice 0");
	let failure = attempt
		.outcome
		.expect_err("a catalog-visible, stub-rejected tool must fail the turn");
	assert_eq!(failure, TurnFailure::ToolRejected {
		tool_name: "bash".to_owned(),
		reason:    catalog::stub_rejection_reason("bash"),
	});

	let produced = attempt.trace.events();
	assert!(
		produced.len() >= fixture.len(),
		"execute_turn must produce at least the unsupported-tool tail"
	);
	let tail = &produced[produced.len() - fixture.len()..];

	// Bijection scope: session_id only (this tail carries no assemble_id/
	// context_item_ids/platform trace, asserted below).
	let mut bijection = IdBijection::default();
	let fixture_session_id = fixture[0].session_id.as_str();
	let preamble = &produced[..produced.len() - fixture.len()];
	let preamble_last_seq = preamble.last().map_or(0, |event| event.session_seq);
	let preamble_last_event_id = preamble.last().map(|event| event.event_id.clone());

	// Task 212 (isolated-tail ruling): the fixture is a self-contained
	// 4-event tail with no preceding session history, but `execute_turn`
	// always produces a real preamble (catalog publish, user turn, one
	// pre-tool assembly round, the initial provider request) ahead of it.
	// Four structural-context field classes are excluded from literal
	// fixture comparison below and replaced with production-rule
	// assertions instead of being silently dropped:
	//   1. `session_seq` continues the real preamble contiguously.
	//   2. `causation_event_id` on the first tail event chains to the real
	//      preceding preamble event (later tail events chain within the tail itself
	//      and already match the fixture literally).
	//   3. `idempotency_key` is the runner's `{turn_id}:{event_id}` derivation, not
	//      the fixture's descriptive placeholder.
	//   4. `visibility` is the runner's actual per-event-type default, not the
	//      fixture's recorded value.
	// Everything else -- entity ids (incl. `provider_event_id`), payload,
	// ordering, and timestamps -- remains fixture-literal.
	for (i, (produced_event, fixture_event)) in tail.iter().zip(fixture.iter()).enumerate() {
		assert!(
			produced_event.entity_ids.assemble_id.is_none()
				&& produced_event.entity_ids.context_item_ids.is_empty(),
			"the unsupported-tool tail carries no assembly-scoped entity ids, matching the fixture"
		);

		assert_eq!(
			produced_event.session_seq,
			preamble_last_seq + 1 + i as u64,
			"{:?} session_seq must contiguously continue the real preamble",
			produced_event.event_type
		);
		if i == 0 {
			assert_eq!(
				produced_event.causation_event_id, preamble_last_event_id,
				"the first tail event must chain causation to the real preceding preamble event"
			);
		} else {
			assert_eq!(
				produced_event.causation_event_id, fixture_event.causation_event_id,
				"{:?} causation_event_id must match the canonical fixture past the first tail event",
				produced_event.event_type
			);
		}
		assert_eq!(
			produced_event.idempotency_key,
			format!(
				"{}:{}",
				produced_event
					.turn_id
					.as_ref()
					.expect("tail events are turn-scoped")
					.as_str(),
				produced_event.event_id.as_str()
			),
			"{:?} idempotency_key must be the runner's turn_id:event_id derivation",
			produced_event.event_type
		);
		assert_eq!(
			produced_event.visibility,
			expected_tail_visibility(produced_event.event_type.clone()),
			"{:?} visibility must match the runner's production default for this event type",
			produced_event.event_type
		);

		let mut normalized = bijection.normalize_session(produced_event, fixture_session_id);
		normalized.session_seq = fixture_event.session_seq;
		normalized.causation_event_id = fixture_event.causation_event_id.clone();
		normalized.idempotency_key = fixture_event.idempotency_key.clone();
		normalized.visibility = fixture_event.visibility.clone();
		assert_eq!(
			&normalized, fixture_event,
			"{:?} must match the canonical fixture byte-for-byte after session_id normalization and \
			 the isolated-tail exclusions (task 212)",
			produced_event.event_type
		);
	}

	// The lifecycle oracle runs against the PRODUCED events, not a
	// manually constructed request.
	validate_unsupported_tool_lifecycle(produced, &catalog::slice0_catalog())
		.expect("the runner's own produced unsupported-tool tail must pass the lifecycle oracle");

	cleanup_workspace(&workspace_root);
}

// ---------------------------------------------------------------------
// Provider-auth Unavailable: typed degradation, no raw events touched.
// ---------------------------------------------------------------------

#[test]
fn provider_auth_unavailable_is_a_typed_degradation_with_no_raw_event_shape() {
	let outcome = ProviderAuthOutcome::Unavailable { slot: ProviderSlot::Anthropic };
	let failure = require_provider_credential(&outcome)
		.expect_err("unavailable auth must not resolve a credential");
	assert_eq!(failure, TurnFailure::ProviderAuthUnavailable { slot: ProviderSlot::Anthropic });
}

// ---------------------------------------------------------------------
// Tool-dispatch failure path: typed rejection, not a panic or a hang.
// ---------------------------------------------------------------------

#[tokio::test]
async fn out_of_root_read_arguments_produce_a_typed_failure_not_a_panic() {
	let server = TestServer::start("tool-dispatch-failure").await;
	let client = server.client();
	let workspace_root = seed_workspace("tool-dispatch-failure");
	let session = client
		.create_session(&successor_protocol::platform_api::CreateSessionRequestV0 {
			workspace:  successor_protocol::platform_api::WorkspaceV0 {
				id:        "workspace-1".to_owned(),
				label:     "Slice 0 workspace".to_owned(),
				root_hint: workspace_root.display().to_string(),
			},
			title:      "tool dispatch failure turn".to_owned(),
			created_by: successor_protocol::platform_api::CreatedByV0 {
				client_kind: "kernel".to_owned(),
				client_id:   "successor-kernel".to_owned(),
			},
		})
		.await
		.expect("create session");

	let ids = successor_kernel::id_factory::RealIdFactory::new();
	let ctx = TurnContext::new(session.session_id.clone(), ids.turn_id(), ids.request_id());
	let tool_call_id = ids.tool_call_id();
	let frame_sink = FrameSink::new(KernelFrameStream::new());
	let mut trace = successor_kernel::turn_trace::TurnTrace::new();
	let provider = ScriptedProviderExecutor::new(
		"anthropic",
		successor_protocol::provider::ProviderApiShapeV0::AnthropicMessages,
		"claude-fixture",
		[],
	);
	let runner = TurnRunner::new(
		client,
		frame_sink,
		Arc::new(ids) as Arc<dyn IdFactory>,
		Arc::new(successor_kernel::id_factory::RealClock) as Arc<dyn Clock>,
		provider,
		&workspace_root,
	);

	let _causation_event_id = successor_kernel::id_factory::RealIdFactory::new().event_id();
	let result = runner
		.dispatch_tool_call(
			&mut trace,
			&ctx,
			&tool_call_id,
			"read",
			&serde_json::json!({ "path": "../../../etc/passwd" }),
			None,
			None,
		)
		.await;

	// Must be a typed error, not a panic (the test reaching this line at
	// all proves no panic occurred) and not a `ToolRejected` (the tool
	// itself is executable in Slice 0; only this invocation's arguments
	// are invalid).
	let failure = result.expect_err("an out-of-root read must fail, not succeed");
	assert!(
		matches!(failure, TurnFailure::Protocol(_)),
		"an out-of-root read argument must surface as a typed execution failure, got {failure:?}"
	);

	cleanup_workspace(&workspace_root);
}

// ---------------------------------------------------------------------
// State machine: illegal transitions are typed, never panics.
// ---------------------------------------------------------------------

#[test]
fn runner_lifecycle_state_rejects_skipping_the_tool_dispatch_step() {
	let after_request_built = TurnState::ProviderRequestBuilt(TurnPhase::PreTool);
	let err = after_request_built
		.validate_next(TurnState::ToolCompleted(TurnPhase::PreTool))
		.expect_err(
			"skipping straight from a built request to a completed tool call must be illegal",
		);
	assert_eq!(err.from, TurnState::ProviderRequestBuilt(TurnPhase::PreTool));
	assert_eq!(err.to, TurnState::ToolCompleted(TurnPhase::PreTool));
}

// ---------------------------------------------------------------------
// Successful-turn byte-identity oracle (task 210, Option B): full-DTO
// comparison of raw events, project_session projection, and frames
// against the canonical fixtures, under one bijection for session_id/
// assemble_id/context_item_id.
// ---------------------------------------------------------------------

/// Builds the [`ScriptedIdFactory`] for the successful-turn replay by
/// deriving every fixture-observable literal value directly from the
/// typed fixture (never hand-transcribed), in this runner's own call
/// order (confirmed against `runner.rs`'s `execute_turn`/`assemble_round`/
/// `dispatch_tool_call` source): `event_id` is 1:1 with the fixture's own
/// event stream in order (every appended event, including
/// `tool_catalog.published`, mints its id via one `event_id()` call
/// immediately before append); `turn_id`/`request_id`/`catalog_id` are
/// single shared values; `message_id`/`tool_call_id` interleave real,
/// fixture-observed values with placeholders at the positions this
/// runner mints but never persists (a tool round's own `round_message_id`
/// is discarded, and the final round's `round_tool_call_id` is minted but
/// unused since no tool call occurs); `provider_event_id` is minted three
/// times (once per tool round, plus once for the final round) and persisted
/// only on the final round's `provider_response.recorded` `entity_ids` (the two
/// tool-round mints are never persisted); `source_envelope_id`/`artifact_id`/
/// kernel `trace_id` are
/// fully real, in fixture order.
fn scripted_ids_for_successful_turn() -> ScriptedIdFactory {
	let fixture = fixtures::raw_events_successful_turn();
	let by_type = |t: raw_event::RawEventType| {
		fixture
			.iter()
			.find(|e| e.event_type == t)
			.unwrap_or_else(|| panic!("fixture must contain a {t:?} event"))
	};

	// Builds the [`ScriptedClock`] for the successful-turn replay. This
	// runner's clock consumption is NOT 1:1 with raw event appends (task
	// 211/212 root cause): `frame_fields()` mints its own
	// `self.clock.now()` tick for every kernel frame it builds, and that
	// tick becomes the frame's persisted `ts` directly -- except for
	// `turn_started`, whose `ts` is overridden by the already-captured
	// `turn_started_at` before emission, so that one tick is genuinely
	// discarded. Confirmed against `runner.rs`'s `execute_turn`/
	// `assemble_round`/`dispatch_tool_call`: six of this fixture's ten
	// frames (`raw_event_appended`, `platform_assemble_started`,
	// `platform_assemble_completed` x2, `tool_call_requested` x2,
	// `tool_call_completed` x2, `turn_completed`) consume a tick between
	// raw-event appends. This builds the exact interleaved sequence: each
	// raw event's own `occurred_at` in fixture order, with a frame's own
	// `ts` (from `kernel-frame-stream.json`) spliced in at each point
	// `frame_fields()` is called, and a discarded placeholder for
	// `turn_started`'s.
	let event_ids: Vec<String> = fixture
		.iter()
		.map(|e| e.event_id.as_str().to_owned())
		.collect();
	let turn_id = fixture
		.iter()
		.find_map(|e| e.turn_id.as_ref())
		.expect("at least one fixture event carries a turn_id")
		.as_str()
		.to_owned();
	let request_id = fixture[0].request_id.as_str().to_owned();
	let catalog_id = by_type(raw_event::RawEventType::ToolCatalogPublished)
		.payload
		.get("catalog_id")
		.and_then(|v| v.as_str())
		.expect("tool_catalog.published payload carries catalog_id")
		.to_owned();

	let user_turn = by_type(raw_event::RawEventType::UserTurnRecorded);
	let provider_response = by_type(raw_event::RawEventType::ProviderResponseRecorded);
	let assistant_turn = by_type(raw_event::RawEventType::AssistantTurnRecorded);
	let message_ids = [
		user_turn
			.entity_ids
			.message_id
			.as_ref()
			.expect("user_turn.recorded carries message_id")
			.as_str()
			.to_owned(),
		"msg_00000000-0000-4000-8000-000000000f01".to_owned(), // round 1 (search_files): ephemeral
		"msg_00000000-0000-4000-8000-000000000f02".to_owned(), // round 2 (read): ephemeral
		provider_response
			.entity_ids
			.message_id
			.as_ref()
			.expect("provider_response.recorded carries message_id")
			.as_str()
			.to_owned(),
		assistant_turn
			.entity_ids
			.message_id
			.as_ref()
			.expect("assistant_turn.recorded carries message_id")
			.as_str()
			.to_owned(),
	];

	let tool_call_events: Vec<&raw_event::RawEventV0> = fixture
		.iter()
		.filter(|e| e.event_type == raw_event::RawEventType::ProviderToolCallObserved)
		.collect();
	assert_eq!(tool_call_events.len(), 2, "the canonical fixture has exactly two tool rounds");
	let tool_call_ids = [
		tool_call_events[0]
			.entity_ids
			.tool_call_id
			.as_ref()
			.expect("tool_call_id")
			.as_str()
			.to_owned(),
		tool_call_events[1]
			.entity_ids
			.tool_call_id
			.as_ref()
			.expect("tool_call_id")
			.as_str()
			.to_owned(),
		"tool_00000000-0000-4000-8000-000000000f03".to_owned(), // final round: minted, unused
	];

	let tool_results: Vec<&raw_event::RawEventV0> = fixture
		.iter()
		.filter(|e| e.event_type == raw_event::RawEventType::ToolResultRecorded)
		.collect();
	assert_eq!(tool_results.len(), 2, "the canonical fixture has exactly two tool results");
	let source_envelope_ids = [
		user_turn
			.entity_ids
			.source_envelope_id
			.as_ref()
			.expect("source_envelope_id")
			.as_str()
			.to_owned(),
		tool_results[0]
			.entity_ids
			.source_envelope_id
			.as_ref()
			.expect("source_envelope_id")
			.as_str()
			.to_owned(),
		tool_results[1]
			.entity_ids
			.source_envelope_id
			.as_ref()
			.expect("source_envelope_id")
			.as_str()
			.to_owned(),
		assistant_turn
			.entity_ids
			.source_envelope_id
			.as_ref()
			.expect("source_envelope_id")
			.as_str()
			.to_owned(),
	];
	let artifact_ids = [
		tool_results[0]
			.entity_ids
			.artifact_id
			.as_ref()
			.expect("artifact_id")
			.as_str()
			.to_owned(),
		tool_results[1]
			.entity_ids
			.artifact_id
			.as_ref()
			.expect("artifact_id")
			.as_str()
			.to_owned(),
	];

	let provider_requests: Vec<&raw_event::RawEventV0> = fixture
		.iter()
		.filter(|e| e.event_type == raw_event::RawEventType::ProviderRequestBuilt)
		.collect();
	assert_eq!(
		provider_requests.len(),
		3,
		"the canonical fixture has exactly three provider rounds"
	);
	let assembly_requests: Vec<&raw_event::RawEventV0> = fixture
		.iter()
		.filter(|e| e.event_type == raw_event::RawEventType::AssemblyRequested)
		.collect();
	assert_eq!(
		assembly_requests.len(),
		3,
		"the canonical fixture has exactly three assembly rounds"
	);
	let trace_ids = [
		assembly_requests[0]
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
		provider_requests[0]
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
		assembly_requests[1]
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
		provider_requests[1]
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
		assembly_requests[2]
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
		provider_requests[2]
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
		provider_response
			.entity_ids
			.trace_id
			.as_ref()
			.expect("trace_id")
			.as_str()
			.to_owned(),
	];

	ScriptedIdFactory::builder()
		.event_ids(event_ids)
		.turn_id(turn_id)
		.request_id(request_id)
		.catalog_ids([catalog_id])
		.message_ids(message_ids)
		.tool_call_ids(tool_call_ids)
		.provider_event_ids([
			"pevt_00000000-0000-4000-8000-000000000001".to_owned(),
			"pevt_00000000-0000-4000-8000-000000000002".to_owned(),
			provider_response
				.entity_ids
				.provider_event_id
				.as_ref()
				.expect("provider_response.recorded carries provider_event_id")
				.as_str()
				.to_owned(),
		])
		.source_envelope_ids(source_envelope_ids)
		.artifact_ids(artifact_ids)
		.trace_ids(trace_ids)
		.frame_ids(
			fixtures::kernel_frame_stream()
				.iter()
				.map(|f| f.frame_id.as_str().to_owned()),
		)
		.build()
}

/// Builds the [`ScriptedClock`] for the successful-turn replay: one
/// `occurred_at` per fixture event, in fixture order (this runner mints
/// exactly one timestamp per raw event append, confirmed against
/// `runner.rs`).
/// Builds the [`ScriptedClock`] for the successful-turn replay. This
/// runner's clock consumption is NOT 1:1 with raw event appends (task
/// 211/212 root cause): `frame_fields()` mints its own `self.clock.now()`
/// tick for every kernel frame it builds, and that tick becomes the
/// frame's persisted `ts` directly -- except for `turn_started`, whose
/// `ts` is overridden by the already-captured `turn_started_at` before
/// emission, so that one tick is genuinely discarded. Confirmed against
/// `runner.rs`'s `execute_turn`/`assemble_round`/`dispatch_tool_call`:
/// six of this fixture's ten frames (`raw_event_appended`,
/// `platform_assemble_started`, `platform_assemble_completed` x2,
/// `tool_call_requested` x2, `tool_call_completed` x2, `turn_completed`)
/// consume a tick between raw-event appends. This builds the exact
/// interleaved sequence: each raw event's own `occurred_at` in fixture
/// order, with a frame's own `ts` (from `kernel-frame-stream.json`)
/// spliced in at each point `frame_fields()` is called, and a discarded
/// placeholder for `turn_started`'s.
fn scripted_clock_for_successful_turn() -> ScriptedClock {
	let events = fixtures::raw_events_successful_turn();
	let frames = fixtures::kernel_frame_stream();
	let ts = |i: usize| events[i].occurred_at.clone();
	let frame_ts = |kind: kernel_frame::KernelFrameKindV0, nth: usize| {
		frames
			.iter()
			.filter(|f| f.kind == kind)
			.nth(nth)
			.expect("frame exists in kernel-frame-stream.json")
			.ts
			.clone()
	};
	ScriptedClock::new([
		ts(0),
		ts(1),
		"1970-01-01T00:00:00Z".to_owned(),
		frame_ts(kernel_frame::KernelFrameKindV0::RawEventAppended, 0),
		frame_ts(kernel_frame::KernelFrameKindV0::PlatformAssembleStarted, 0),
		ts(2),
		ts(3),
		frame_ts(kernel_frame::KernelFrameKindV0::PlatformAssembleCompleted, 0),
		ts(4),
		ts(5),
		frame_ts(kernel_frame::KernelFrameKindV0::ToolCallRequested, 0),
		ts(6),
		ts(7),
		ts(8),
		ts(9),
		frame_ts(kernel_frame::KernelFrameKindV0::ToolCallCompleted, 0),
		ts(10),
		ts(11),
		ts(12),
		ts(13),
		frame_ts(kernel_frame::KernelFrameKindV0::ToolCallRequested, 1),
		ts(14),
		ts(15),
		ts(16),
		ts(17),
		frame_ts(kernel_frame::KernelFrameKindV0::ToolCallCompleted, 1),
		ts(18),
		ts(19),
		frame_ts(kernel_frame::KernelFrameKindV0::PlatformAssembleCompleted, 1),
		ts(20),
		ts(21),
		ts(22),
		frame_ts(kernel_frame::KernelFrameKindV0::TurnCompleted, 0),
	])
}

#[tokio::test]
async fn successful_turn_reproduces_the_fixtures_raw_events_projection_and_frames_at_full_byte_depth()
 {
	let server = TestServer::start("successful-turn").await;
	let client = server.client();
	let workspace_root = seed_workspace("successful-turn");

	let ids = scripted_ids_for_successful_turn();
	let clock = scripted_clock_for_successful_turn();

	let provider = ScriptedProviderExecutor::new(
		"anthropic",
		successor_protocol::provider::ProviderApiShapeV0::AnthropicMessages,
		"claude-sonnet-4-5",
		[
			ScriptedRound::ToolUse {
				tool_name:             "search_files".to_owned(),
				arguments:             serde_json::json!({ "query": "concept graph resolver", "max_matches": 20 }),
				provider_tool_call_id: "toolu_01_fixture_search".to_owned(),
			},
			ScriptedRound::ToolUse {
				tool_name:             "read".to_owned(),
				arguments:             serde_json::json!({ "path": "packages/coding-agent/src/context/concept-graph.ts", "max_bytes": 200000 }),
				provider_tool_call_id: "toolu_01_fixture_read".to_owned(),
			},
			ScriptedRound::Final {
				text:    "The concept graph resolver fixture coordinates concept context retrieval \
				          and reports degraded/no-context conditions explicitly."
					.to_owned(),
				summary: "Inspected packages/coding-agent/src/context/concept-graph.ts and explained \
				          the concept graph resolver fixture."
					.to_owned(),
			},
		],
	);

	let frame_sink = FrameSink::new(KernelFrameStream::new());
	let runner = TurnRunner::new(
		client,
		frame_sink,
		Arc::new(ids) as Arc<dyn IdFactory>,
		Arc::new(clock) as Arc<dyn Clock>,
		provider,
		&workspace_root,
	);

	let attempt = runner
		.execute_turn(TurnInput {
			user_text:      "Find and read the concept graph resolver; explain what it does."
				.to_owned(),
			assembly_query: Some("concept graph resolver".to_owned()),
		})
		.await;

	assert!(attempt.trace.succeeded());
	let assistant_text = attempt
		.outcome
		.clone()
		.expect("a fully scripted, bounded, real-platform turn must complete");
	assert!(!assistant_text.is_empty());

	let produced_events = attempt.trace.events();
	let fixture_events = fixtures::raw_events_successful_turn();
	assert_eq!(
		produced_events.len(),
		fixture_events.len(),
		"produced event count must match the canonical fixture exactly"
	);

	// Bijection scope: session_id, assemble_id, context_item_id. Every
	// other id-like field is compared literally below.
	let mut bijection = IdBijection::default();
	let fixture_session_id = fixture_events[0].session_id.as_str();
	let mut normalized_events = Vec::with_capacity(produced_events.len());
	let mut idempotency_keys: std::collections::HashSet<String> =
		std::collections::HashSet::with_capacity(produced_events.len());
	for (produced_event, fixture_event) in produced_events.iter().zip(fixture_events.iter()) {
		let mut normalized = bijection.normalize_session(produced_event, fixture_session_id);
		if let (Some(produced_assemble), Some(fixture_assemble)) =
			(&produced_event.entity_ids.assemble_id, &fixture_event.entity_ids.assemble_id)
		{
			bijection.record("assemble_id", produced_assemble.as_str(), fixture_assemble.as_str());
			normalized.entity_ids.assemble_id = Some(successor_protocol::ids::AssembleId::from_raw(
				fixture_assemble.as_str().to_owned(),
			));
		}
		assert_eq!(
			produced_event.entity_ids.context_item_ids.len(),
			fixture_event.entity_ids.context_item_ids.len(),
			"{:?} context_item_ids count must match the canonical fixture",
			produced_event.event_type
		);
		let mut normalized_context_items =
			Vec::with_capacity(produced_event.entity_ids.context_item_ids.len());
		for (produced_item, fixture_item) in produced_event
			.entity_ids
			.context_item_ids
			.iter()
			.zip(fixture_event.entity_ids.context_item_ids.iter())
		{
			bijection.record("context_item_id", produced_item.as_str(), fixture_item.as_str());
			normalized_context_items.push(successor_protocol::ids::ContextItemId::from_raw(
				fixture_item.as_str().to_owned(),
			));
		}
		normalized.entity_ids.context_item_ids = normalized_context_items;
		if let Some(serde_json::Value::Array(ids)) = normalized.payload.get_mut("context_item_ids") {
			for id in ids.iter_mut() {
				if let serde_json::Value::String(s) = id
					&& let Some(mapped) = bijection.produced_to_fixture.get(s)
				{
					*s = mapped.clone();
				}
			}
		}
		let expected_idempotency_key = match &produced_event.turn_id {
			Some(turn_id) => format!("{}:{}", turn_id.as_str(), produced_event.event_id.as_str()),
			None => {
				format!("{}:{}", produced_event.session_id.as_str(), produced_event.event_id.as_str())
			},
		};
		assert_eq!(
			produced_event.idempotency_key, expected_idempotency_key,
			"{:?} idempotency_key must be the runner's turn_id:event_id (session_id:event_id when \
			 turn-less) derivation",
			produced_event.event_type
		);
		assert!(
			idempotency_keys.insert(produced_event.idempotency_key.clone()),
			"{:?} idempotency_key {:?} must be unique within the session",
			produced_event.event_type,
			produced_event.idempotency_key
		);
		normalized.idempotency_key = fixture_event.idempotency_key.clone();
		assert_eq!(
			&normalized, fixture_event,
			"{:?} must match the canonical fixture byte-for-byte after \
			 session_id/assemble_id/context_item_id normalization",
			produced_event.event_type
		);
		normalized_events.push(normalized);
	}

	assert_eq!(
		idempotency_keys.len(),
		produced_events.len(),
		"every produced idempotency_key must be unique within the session"
	);

	// Duplicate-append idempotency (task-214 ruling): resubmitting the exact
	// same append request must be a no-op that reports duplicate = true and
	// returns the original session_seq rather than minting a new event.
	let last_produced = produced_events
		.last()
		.expect("successful turn produces at least one event");
	let duplicate_request = successor_protocol::platform_api::RawEventAppendRequestV0 {
		schema_version:     last_produced.schema_version.clone(),
		event_id:           last_produced.event_id.clone(),
		idempotency_key:    last_produced.idempotency_key.clone(),
		event_type:         last_produced.event_type.clone(),
		session_id:         last_produced.session_id.clone(),
		turn_id:            last_produced.turn_id.clone(),
		request_id:         last_produced.request_id.clone(),
		occurred_at:        last_produced.occurred_at.clone(),
		producer:           last_produced.producer.clone(),
		causation_event_id: last_produced.causation_event_id.clone(),
		correlation_id:     last_produced.correlation_id.clone(),
		entity_ids:         last_produced.entity_ids.clone(),
		visibility:         last_produced.visibility.clone(),
		redaction:          last_produced.redaction.clone(),
		payload:            last_produced.payload.clone(),
		artifact:           last_produced.artifact.clone(),
	};
	let duplicate_response = server
		.client()
		.append_event(&duplicate_request)
		.await
		.expect(
			"re-appending an already-stored idempotency_key must succeed as a duplicate, not error",
		);
	assert!(
		duplicate_response.duplicate,
		"re-appending {:?} with the same idempotency_key must report duplicate = true",
		last_produced.event_type
	);
	assert_eq!(
		duplicate_response.session_seq, last_produced.session_seq,
		"a duplicate append must return the original session_seq, not mint a new one"
	);

	// Frames: full byte depth against kernel-frame-stream.json, under the
	// same bijection (frames carry `assemble_id` in `entity_ids` for the
	// PlatformAssembleStarted/Completed kinds -- task 210's bijection
	// scope applies here identically to the raw-events loop above, since
	// the platform mints the same real assemble_id observed there;
	// `context_item_ids` and `session_id` are normalized the same way).
	let produced_frames = attempt.trace.frames();
	let fixture_frames = fixtures::kernel_frame_stream();
	assert_eq!(
		produced_frames.len(),
		fixture_frames.len(),
		"produced frame count must match kernel-frame-stream.json exactly"
	);
	for (produced_frame, fixture_frame) in produced_frames.iter().zip(fixture_frames.iter()) {
		let mut normalized_frame = produced_frame.clone();
		normalized_frame.session_id =
			successor_protocol::ids::SessionId::from_raw(fixture_session_id.to_owned());
		if let (Some(produced_assemble), Some(fixture_assemble)) =
			(&produced_frame.entity_ids.assemble_id, &fixture_frame.entity_ids.assemble_id)
		{
			bijection.record("assemble_id", produced_assemble.as_str(), fixture_assemble.as_str());
			normalized_frame.entity_ids.assemble_id = Some(
				successor_protocol::ids::AssembleId::from_raw(fixture_assemble.as_str().to_owned()),
			);
		}
		let mut normalized_context_items =
			Vec::with_capacity(produced_frame.entity_ids.context_item_ids.len());
		for (produced_item, fixture_item) in produced_frame
			.entity_ids
			.context_item_ids
			.iter()
			.zip(fixture_frame.entity_ids.context_item_ids.iter())
		{
			bijection.record("context_item_id", produced_item.as_str(), fixture_item.as_str());
			normalized_context_items.push(successor_protocol::ids::ContextItemId::from_raw(
				fixture_item.as_str().to_owned(),
			));
		}
		normalized_frame.entity_ids.context_item_ids = normalized_context_items;
		assert_eq!(
			&normalized_frame, fixture_frame,
			"frame {:?} must match kernel-frame-stream.json byte-for-byte \
			 (frame_id/raw_event_id/kind/payload/timestamp are all kernel-controlled and literal in \
			 this lane's KernelFrameV0 shape)",
			produced_frame.kind
		);
	}

	// project_session on the NORMALIZED produced stream must be
	// byte-identical to expected-session-projection.json (the ruling's
	// third comparison target). project_session on the canonical
	// fixture's own events is separately covered by the accepted A4
	// fixture-replay test.
	let produced_projection = successor_protocol::replay::project_session(&normalized_events)
		.expect("a completed, well-formed turn's own events must project cleanly");
	let expected_projection = fixtures::expected_session_projection();
	assert_eq!(
		produced_projection, expected_projection,
		"project_session on this run's own (session_id/assemble_id/context_item_id-normalized) \
		 events must be byte-identical to expected-session-projection.json"
	);

	cleanup_workspace(&workspace_root);
}
