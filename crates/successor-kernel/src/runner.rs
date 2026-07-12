//! Owned by Lane C7 `KernelTurnRunner`.
//!
//! The composable `TurnRunner`: the Wave C composition lane that drives one
//! Slice 0 turn end to end (contract §9) using only the accepted C1-C6
//! surfaces as boundaries (Dissent ruling 2):
//!
//! - platform I/O exclusively through [`KernelPlatformClient`];
//! - frames exclusively through [`FrameSink::emit`] (never
//!   [`crate::stream::KernelFrameStream`]'s `pub(crate)` `publish_with` — see
//!   the `runner_never_reaches_publish_with` boundary test below);
//! - provider request/response projection through
//!   [`crate::provider::projection`]'s data surfaces;
//! - tool execution exclusively through the catalog dispatch in
//!   [`crate::tools`], gated by [`crate::tools::catalog`].
//!
//! Identity and time are seams ([`IdFactory`], [`Clock`], `id_factory.rs`),
//! never hand-rolled inline. The turn lifecycle is a bounded, typed state
//! machine (`state_machine.rs`): the canonical fixture is one locator tool
//! call (`search_files`) followed by one file-read tool call (`read`); live
//! execution permits up to `state_machine::MAX_EXECUTABLE_TOOL_ROUNDS`
//! executable tool rounds per turn (<agent://256> dissent ruling, amending
//! Dissent ruling 5's original two-call bound). Every attempt is single-shot:
//! no retry, no backoff, no resume engine.
//!
//! ## Disclosed deviations from the canonical fixtures
//!
//! Raw-event `payload` is untyped JSON (`RawEventV0::payload:
//! serde_json::Value`), so the exact key set below is this lane's own
//! construction, not a re-serialization of a typed DTO. It was built to
//! match `raw-events-successful-turn.json` field-for-field at the time of
//! writing. Two fields are intentionally *not* reproduced verbatim:
//! - `idempotency_key`: the fixture uses human-authored descriptive labels
//!   (e.g. `"fixture:catalog:1"`). This lane derives it from the freshly minted
//!   `event_id` instead (already unique per attempt, satisfying the idempotency
//!   contract) rather than inventing a descriptive-label algorithm with no
//!   contract-specified grammar.
//! - `AssembleIntentV0::confidence` (a `String` per the accepted C1/A5 DTO) is
//!   set to a fixed `"high"` literal: Slice 0 has no confidence-scoring model,
//!   and the contract does not specify one.

use std::{collections::VecDeque, future::Future, path::Path, sync::Arc};

use serde_json::{Value as WireJson, json};
use successor_protocol::{
	ids::{
		ContextItemId, EventId, FrameId, MessageId, RequestId, SessionId, SourceEnvelopeId,
		ToolCallId, TurnId,
	},
	kernel_frame::{KernelFrameKindV0, KernelFrameV0},
	platform_api::{
		AssembleIntentV0, AssembleRequestV0, AssembleWorkspaceV0, AssemblyBudgetV0,
		AssemblyResponseV0, CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0,
		RawEventAppendResponseV0, WorkspaceV0,
	},
	provider::{
		NormalizedResponseV0, NormalizedToolCallV0, PROVIDER_RESPONSE_RECORDED_EVENT_TYPE,
		PROVIDER_TOOL_CALL_OBSERVED_EVENT_TYPE, ProviderApiShapeV0, ProviderObservationMetadataV0,
	},
	raw_event::{
		EntityIdsV0, RAW_EVENT_SCHEMA_VERSION, RawEventArtifactRef, RawEventProducerV0, RawEventType,
		RedactionLevelV0, VisibilityV0,
	},
	tool_catalog::{ToolAuthorityClassV0, ToolAuthorityRequestV0, ToolCatalogV0, ToolStatusV0},
};

use crate::{
	frame_sink::{FrameFields, FrameSink, RawEventRef},
	id_factory::{Clock, IdFactory},
	platform_client::KernelPlatformClient,
	platform_error::PlatformClientError,
	provider::{auth::ProviderAuthOutcome, credentials::AnthropicApiKey, projection},
	state_machine::{MAX_EXECUTABLE_TOOL_ROUNDS, TurnFailure, TurnPhase, TurnState},
	tools::{
		bash::TrustedExecutableAllowlist,
		catalog,
		registry::{self, EffectiveToolAuthority, ToolExecutionContext},
	},
	turn_trace::{TurnAttempt, TurnTrace},
};

// ---------------------------------------------------------------------
// Provider executor seam
// ---------------------------------------------------------------------

/// One provider round's outcome, normalized to what the turn loop needs.
#[derive(Debug, Clone)]
pub struct ProviderRoundOutcome {
	pub response:  NormalizedResponseV0,
	pub tool_call: Option<(NormalizedToolCallV0, ProviderObservationMetadataV0)>,
	/// A distinct assistant-turn summary, when the round supplies one
	/// (production Anthropic responses never do; only scripted/test
	/// rounds may). `None` falls back to `response.text` at the call site.
	pub summary:   Option<String>,
}

/// The seam standing where a live provider adapter (e.g.
/// [`crate::provider::anthropic::AnthropicAdapter`]) sits in production.
///
/// [`TurnRunner`] is generic over `P: ProviderExecutor` (static dispatch,
/// per Dissent ruling 2/5's "composable runner API"): production wires a
/// concrete adapter-backed executor; replay tests wire
/// [`ScriptedProviderExecutor`]. Native `async fn` in a non-`dyn` trait is
/// used directly (stable since Rust 1.75) rather than pulling in an
/// `async-trait`-style dependency, honoring Dissent ruling 1 (no Cargo
/// changes).
pub trait ProviderExecutor: Send + Sync {
	/// Provider identifier for raw-event payloads, e.g. `"anthropic"`.
	fn provider_id(&self) -> &str;
	/// The provider API shape this executor speaks.
	fn api_shape(&self) -> ProviderApiShapeV0;
	/// Model identifier for raw-event payloads.
	fn model(&self) -> &str;

	/// Sends one round's request (built from `user_text`, `completed_rounds`,
	/// and `catalog`) and returns the normalized outcome. `message_id`/
	/// `tool_call_id` are pre-minted by the caller so they can be threaded
	/// into the normalized response/tool-call regardless of which branch the
	/// provider takes.
	///
	/// `user_text` is the turn's original user prompt, unchanged for every
	/// round. `completed_rounds` carries every tool round already completed
	/// in this turn's provider round-trip, oldest first, so a provider-native
	/// implementation can echo back the full conversation (see
	/// [`projection::project_conversation_request_body`]) instead of
	/// collapsing to the latest tool result alone (<agent://256>
	/// `item_b_fix_ruling`; <agent://259> finding 2 /
	/// `hydration_design_adjudication`).
	fn send_round(
		&self,
		user_text: &str,
		completed_rounds: &[projection::CompletedToolRoundV0],
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> impl Future<Output = Result<ProviderRoundOutcome, TurnFailure>> + Send;
}

/// Resolves `auth` into a credential the caller can use to construct a live
/// provider adapter, or a typed [`TurnFailure::ProviderAuthUnavailable`]
/// degradation.
///
/// Part of the composable runner API (Dissent ruling 5): a caller
/// re-resolves [`ProviderAuthOutcome`] once per attempt (no caching, no
/// resume engine) and calls this before constructing a provider executor
/// and a [`TurnRunner`] for that attempt. No raw-event or frame shape
/// exists for the unavailable case (out of scope per the packet's
/// non-goals): the caller's contract is simply "do not attempt the turn",
/// and no raw event is ever appended for an attempt that fails this way.
pub const fn require_provider_credential(
	auth: &ProviderAuthOutcome,
) -> Result<&AnthropicApiKey, TurnFailure> {
	match auth {
		ProviderAuthOutcome::Resolved(key) => Ok(key),
		ProviderAuthOutcome::Unavailable { slot } => {
			Err(TurnFailure::ProviderAuthUnavailable { slot: *slot })
		},
	}
}

/// Test/replay seam: a [`ProviderExecutor`] whose rounds are pre-scripted.
#[derive(Debug, Clone)]
pub enum ScriptedRound {
	/// The provider requests `tool_name` with `arguments`.
	ToolUse {
		tool_name:             String,
		arguments:             WireJson,
		provider_tool_call_id: String,
	},
	/// The provider finishes the turn with `text`.
	Final { text: String, summary: String },
}

#[derive(Debug)]
pub struct ScriptedProviderExecutor {
	provider_id: String,
	api_shape:   ProviderApiShapeV0,
	model:       String,
	rounds:      std::sync::Mutex<VecDeque<ScriptedRound>>,
}

impl ScriptedProviderExecutor {
	pub fn new(
		provider_id: impl Into<String>,
		api_shape: ProviderApiShapeV0,
		model: impl Into<String>,
		rounds: impl IntoIterator<Item = ScriptedRound>,
	) -> Self {
		Self {
			provider_id: provider_id.into(),
			api_shape,
			model: model.into(),
			rounds: std::sync::Mutex::new(rounds.into_iter().collect()),
		}
	}
}

impl ProviderExecutor for ScriptedProviderExecutor {
	fn provider_id(&self) -> &str {
		&self.provider_id
	}

	fn api_shape(&self) -> ProviderApiShapeV0 {
		self.api_shape.clone()
	}

	fn model(&self) -> &str {
		&self.model
	}

	async fn send_round(
		&self,
		_user_text: &str,
		_completed_rounds: &[projection::CompletedToolRoundV0],
		_catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		let round = self
			.rounds
			.lock()
			.expect("ScriptedProviderExecutor mutex poisoned")
			.pop_front()
			.expect(
				"ScriptedProviderExecutor script exhausted: runner requested more rounds than scripted",
			);
		Ok(match round {
			ScriptedRound::ToolUse { tool_name, arguments, provider_tool_call_id } => {
				ProviderRoundOutcome {
					response:  NormalizedResponseV0 {
						event_type: PROVIDER_RESPONSE_RECORDED_EVENT_TYPE.to_owned(),
						message_id,
						finish_reason: "tool_calls".to_owned(),
						text: String::new(),
					},
					tool_call: Some((
						NormalizedToolCallV0 {
							event_type: PROVIDER_TOOL_CALL_OBSERVED_EVENT_TYPE.to_owned(),
							tool_call_id,
							tool_name,
							arguments,
						},
						ProviderObservationMetadataV0 {
							provider_tool_call_id,
							provider_api_shape: self.api_shape.clone(),
						},
					)),
					summary:   None,
				}
			},
			ScriptedRound::Final { text, summary } => ProviderRoundOutcome {
				response:  NormalizedResponseV0 {
					event_type: PROVIDER_RESPONSE_RECORDED_EVENT_TYPE.to_owned(),
					message_id,
					finish_reason: "stop".to_owned(),
					text,
				},
				tool_call: None,
				summary:   Some(summary),
			},
		})
	}
}

/// Production [`ProviderExecutor`].
///
/// A thin wrapper over [`crate::provider::anthropic::AnthropicAdapter`].
/// Holds the model/`max_tokens` configuration `send_round`'s signature
/// does not carry (those are per-executor configuration, not per-round
/// data).
#[derive(Debug, Clone)]
pub struct AnthropicProviderExecutor {
	adapter:    crate::provider::anthropic::AnthropicAdapter,
	model:      String,
	max_tokens: u32,
}

impl AnthropicProviderExecutor {
	pub fn new(
		adapter: crate::provider::anthropic::AnthropicAdapter,
		model: impl Into<String>,
		max_tokens: u32,
	) -> Self {
		Self { adapter, model: model.into(), max_tokens }
	}
}

impl ProviderExecutor for AnthropicProviderExecutor {
	fn provider_id(&self) -> &'static str {
		"anthropic"
	}

	fn api_shape(&self) -> ProviderApiShapeV0 {
		ProviderApiShapeV0::AnthropicMessages
	}

	fn model(&self) -> &str {
		&self.model
	}

	async fn send_round(
		&self,
		user_text: &str,
		completed_rounds: &[projection::CompletedToolRoundV0],
		catalog: &ToolCatalogV0,
		message_id: MessageId,
		tool_call_id: ToolCallId,
	) -> Result<ProviderRoundOutcome, TurnFailure> {
		let outcome = self
			.adapter
			.send_message(
				user_text,
				completed_rounds,
				catalog,
				&self.model,
				self.max_tokens,
				message_id,
				tool_call_id,
			)
			.await
			.map_err(|err| TurnFailure::Provider(err.to_string()))?;
		Ok(ProviderRoundOutcome {
			response:  outcome.response,
			tool_call: outcome.tool_call,
			summary:   None,
		})
	}
}

// ---------------------------------------------------------------------
// Turn input/output
// ---------------------------------------------------------------------

/// One turn's input.
#[derive(Debug, Clone)]
pub struct TurnInput {
	pub user_text:      String,
	/// Explicit assembly-query override for the `pre_tool` `assembly.requested`
	/// payload's `query` field and the `/assemble` intent (task 216's ruling).
	/// Production callers leave this `None`; the runner then falls back to
	/// `user_text` verbatim. Replay tests may supply a distinct
	/// fixture-literal query when the canonical fixture's assembly query is
	/// not the full user prompt.
	pub assembly_query: Option<String>,
}

/// Fixed per-turn identity shared across every raw event the runner
/// appends: `turn_id`, and `request_id` (which doubles as `correlation_id`
/// for the whole attempt, per contract §9).
///
/// Public so a caller (C8, or a replay test) can construct one directly
/// to exercise [`TurnRunner::dispatch_tool_call`] in isolation, without
/// running a full [`TurnRunner::execute_turn`] (Dissent ruling 4: the
/// unsupported-tool oracle needs exactly this).
pub struct TurnContext {
	pub session_id: SessionId,
	pub turn_id:    TurnId,
	pub request_id: RequestId,
}

impl TurnContext {
	pub const fn new(session_id: SessionId, turn_id: TurnId, request_id: RequestId) -> Self {
		Self { session_id, turn_id, request_id }
	}
}

fn kernel_producer() -> RawEventProducerV0 {
	RawEventProducerV0::default()
}

fn platform_producer() -> RawEventProducerV0 {
	RawEventProducerV0 {
		kind: successor_protocol::raw_event::ProducerKind::Platform,
		id:   "context-platform-dev".to_owned(),
	}
}

/// Per-event-type `VisibilityV0` construction (contract §§4, 9, 12; task-214
/// ruling). Audited against every event in the canonical fixtures — all 23
/// events of `raw-events-successful-turn.json` and the 4-event tail of
/// `raw-events-unsupported-tool.json` — this is the single source of truth
/// for visibility: every append site in this module constructs
/// `VisibilityV0` through this function rather than hand-rolling per-call
/// overrides.
///
/// | `event_type`                  | model | transcript | recall | assemble | share | debug |
/// |-------------------------------|-------|------------|--------|----------|-------|-------|
/// | `tool_catalog.published`      | true  | false      | false  | false    | false | true  |
/// | `user_turn.recorded`          | true  | true       | true   | true     | false | true  |
/// | `assembly.requested`          | false | false      | false  | false    | false | true  |
/// | `assembly.completed`          | true  | false      | false  | false    | false | true  |
/// | `provider_request.built`      | false | false      | false  | false    | false | true  |
/// | `provider_tool_call.observed` | false | false      | false  | false    | false | true  |
/// | `tool_call.requested`         | false | true       | false  | false    | false | true  |
/// | `tool_call.started`           | false | true       | false  | false    | false | true  |
/// | `tool_result.recorded`        | true  | true       | true   | true     | false | true  |
/// | `tool_call.completed`         | false | true       | false  | false    | false | true  |
/// | `tool_call.rejected`          | true  | true       | false  | false    | false | true  |
/// | `tool_call.failed`            | true  | true       | false  | false    | false | true  |
/// | `error.recorded`              | true  | true       | false  | false    | false | true  |
/// | `provider_response.recorded`  | false | true       | false  | false    | false | true  |
/// | `assistant_turn.recorded`     | true  | true       | true   | true     | false | true  |
///
/// `share` is always `false` in Slice 0: no external sharing surface exists.
/// `tool_call.failed` has no canonical fixture coverage (no fixture path
/// reaches it in Slice 0); it is grouped with `tool_call.rejected` /
/// `error.recorded` as the nearest semantic sibling (a terminal
/// tool-lifecycle failure) pending a canonical fixture addition.
fn visibility_for(event_type: &RawEventType) -> VisibilityV0 {
	match event_type {
		RawEventType::ToolCatalogPublished | RawEventType::AssemblyCompleted => VisibilityV0 {
			model:      true,
			transcript: false,
			recall:     false,
			assemble:   false,
			share:      false,
			debug:      true,
		},
		RawEventType::UserTurnRecorded
		| RawEventType::ToolResultRecorded
		| RawEventType::AssistantTurnRecorded => VisibilityV0::default(),
		RawEventType::AssemblyRequested
		| RawEventType::ProviderRequestBuilt
		| RawEventType::ProviderToolCallObserved => VisibilityV0 {
			model:      false,
			transcript: false,
			recall:     false,
			assemble:   false,
			share:      false,
			debug:      true,
		},
		RawEventType::ToolCallRequested
		| RawEventType::ToolCallStarted
		| RawEventType::ToolCallCompleted
		| RawEventType::ProviderResponseRecorded => VisibilityV0 {
			model:      false,
			transcript: true,
			recall:     false,
			assemble:   false,
			share:      false,
			debug:      true,
		},
		RawEventType::ToolCallRejected
		| RawEventType::ToolCallFailed
		| RawEventType::ErrorRecorded => VisibilityV0 {
			model:      true,
			transcript: true,
			recall:     false,
			assemble:   false,
			share:      false,
			debug:      true,
		},
	}
}

const fn api_shape_label(shape: &ProviderApiShapeV0) -> &'static str {
	match shape {
		ProviderApiShapeV0::AnthropicMessages => "anthropic_messages",
		ProviderApiShapeV0::OpenAiChatCompletions => "openai_chat_completions",
		ProviderApiShapeV0::OpenAiResponses => "openai_responses",
	}
}

// ---------------------------------------------------------------------
// TurnRunner
// ---------------------------------------------------------------------

/// Drives one Slice 0 turn: catalog publish -> user turn -> assemble ->
/// provider request -> (tool dispatch loop, bounded to locator-then-read)
/// -> provider response -> assistant turn -> completion.
///
/// Generic over `P: ProviderExecutor` (Dissent ruling 5's composable
/// runner API): production callers instantiate with an adapter-backed
/// executor; replay tests instantiate with [`ScriptedProviderExecutor`].
pub struct TurnRunner<P: ProviderExecutor> {
	platform: KernelPlatformClient,
	frames: FrameSink,
	ids: Arc<dyn IdFactory>,
	clock: Arc<dyn Clock>,
	provider: P,
	workspace_root: std::path::PathBuf,
	effective_authority: EffectiveToolAuthority,
	trusted_executable_allowlist: Arc<TrustedExecutableAllowlist>,
}

/// What [`TurnRunner::dispatch_tool_call`] returns on a successfully
/// executed (not rejected, not failed) tool call.
#[derive(Debug)]
pub struct ToolDispatchSuccess {
	pub source_envelope_id:   SourceEnvelopeId,
	pub last_event_id:        EventId,
	pub last_frame_id:        FrameId,
	/// The tool result content the *next* provider round must see (<agent://256>
	/// dissent ruling, item B): full bounded content for `read`, the full
	/// matches payload for `search_files`/`find`/`grep`. Never a preview-only
	/// or artifact-handle-only projection. This is a runtime-only value used
	/// to build the next `send_round` call; it is never persisted as raw
	/// event/frame bytes, so it cannot perturb any fixture-pinned oracle.
	pub provider_result_text: String,
}

impl<P: ProviderExecutor> TurnRunner<P> {
	pub fn new(
		platform: KernelPlatformClient,
		frames: FrameSink,
		ids: Arc<dyn IdFactory>,
		clock: Arc<dyn Clock>,
		provider: P,
		workspace_root: impl AsRef<Path>,
	) -> Self {
		Self::with_effective_authority(
			platform,
			frames,
			ids,
			clock,
			provider,
			workspace_root,
			EffectiveToolAuthority::default_safe_read(),
		)
	}

	#[expect(
		clippy::too_many_arguments,
		reason = "authority-aware constructor mirrors the existing explicit runner seams plus \
		          request and ceiling"
	)]
	pub fn with_tool_authority(
		platform: KernelPlatformClient,
		frames: FrameSink,
		ids: Arc<dyn IdFactory>,
		clock: Arc<dyn Clock>,
		provider: P,
		workspace_root: impl AsRef<Path>,
		request: Option<&ToolAuthorityRequestV0>,
		trusted_ceiling: &[ToolAuthorityClassV0],
	) -> Result<Self, registry::ToolAuthorityResolutionError> {
		let effective_authority = EffectiveToolAuthority::resolve(request, trusted_ceiling)?;
		Ok(Self::with_effective_authority(
			platform,
			frames,
			ids,
			clock,
			provider,
			workspace_root,
			effective_authority,
		))
	}

	fn with_effective_authority(
		platform: KernelPlatformClient,
		frames: FrameSink,
		ids: Arc<dyn IdFactory>,
		clock: Arc<dyn Clock>,
		provider: P,
		workspace_root: impl AsRef<Path>,
		effective_authority: EffectiveToolAuthority,
	) -> Self {
		Self {
			platform,
			frames,
			ids,
			clock,
			provider,
			workspace_root: workspace_root.as_ref().to_path_buf(),
			effective_authority,
			trusted_executable_allowlist: Arc::new(TrustedExecutableAllowlist::default()),
		}
	}

	/// Injects an explicit trusted-executable allowlist. Defaults to an
	/// empty allowlist (see `with_effective_authority`); a nonempty allowlist
	/// never self-grants `local_process` authority on its own — authority is
	/// still resolved independently via
	/// `with_tool_authority`/`EffectiveToolAuthority`.
	pub fn with_trusted_executable_allowlist(
		mut self,
		allowlist: Arc<TrustedExecutableAllowlist>,
	) -> Self {
		self.trusted_executable_allowlist = allowlist;
		self
	}

	fn map_transport(err: PlatformClientError) -> TurnFailure {
		TurnFailure::Transport(err.to_string())
	}

	#[expect(
		clippy::too_many_arguments,
		reason = "every raw event genuinely needs each of these fields"
	)]
	async fn append(
		&self,
		trace: &mut TurnTrace,
		ctx: &TurnContext,
		event_id: EventId,
		event_type: RawEventType,
		occurred_at: String,
		producer: RawEventProducerV0,
		causation_event_id: Option<EventId>,
		entity_ids: EntityIdsV0,
		visibility: VisibilityV0,
		redaction: RedactionLevelV0,
		payload: WireJson,
		artifact: Option<RawEventArtifactRef>,
	) -> Result<RawEventAppendResponseV0, TurnFailure> {
		let request = RawEventAppendRequestV0 {
			schema_version: RAW_EVENT_SCHEMA_VERSION.to_owned(),
			event_id: event_id.clone(),
			event_type,
			session_id: ctx.session_id.clone(),
			turn_id: Some(ctx.turn_id.clone()),
			request_id: ctx.request_id.clone(),
			occurred_at,
			producer,
			causation_event_id,
			correlation_id: ctx.request_id.clone(),
			entity_ids,
			visibility,
			redaction,
			payload,
			artifact,
			idempotency_key: format!("{}:{}", ctx.turn_id.as_str(), event_id.as_str()),
		};
		let response = self
			.platform
			.append_event(&request)
			.await
			.map_err(Self::map_transport)?;
		let persisted = self
			.platform
			.read_event(&event_id)
			.await
			.map_err(Self::map_transport)?;
		trace.push_event(persisted);
		Ok(response)
	}

	fn emit(&self, trace: &mut TurnTrace, fields: FrameFields) -> KernelFrameV0 {
		let frame = self
			.frames
			.emit(fields)
			.expect("frame stream must not be closed mid-turn");
		trace.push_frame(frame.clone());
		frame
	}

	fn frame_fields(
		&self,
		ctx: &TurnContext,
		kind: KernelFrameKindV0,
		raw_event_ref: Option<RawEventRef>,
		entity_ids: EntityIdsV0,
		payload: WireJson,
	) -> FrameFields {
		FrameFields {
			frame_id: self.ids.frame_id(),
			session_id: ctx.session_id.clone(),
			turn_id: ctx.turn_id.clone(),
			request_id: ctx.request_id.clone(),
			kind,
			ts: self.clock.now(),
			causation_frame_id: None,
			raw_event_ref,
			entity_ids,
			payload,
		}
	}

	/// Composable, independently testable tool-dispatch step (Dissent
	/// ruling 4: the unsupported-tool oracle exercises exactly this path
	/// in isolation, without a preceding turn).
	///
	/// Always appends `tool_call.requested` first. Then branches on the
	/// catalog status: executes and records a result for
	/// [`ToolStatusV0::Executable`] tools, or appends
	/// `tool_call.rejected` + `error.recorded` and returns
	/// [`TurnFailure::ToolRejected`] for catalog-visible, stub-rejected
	/// tools (contract §12, the unsupported-tool fixture). A tool absent
	/// from the catalog entirely fails the same way, without appending any
	/// events, since no fixture defines that raw-event shape.
	#[expect(
		clippy::too_many_arguments,
		reason = "tool-call lifecycle seam: \
		          trace/ctx/tool_call_id/tool_name/arguments/causation_event_id/causation_frame_id \
		          are each independently required by callers (execute_turn and the \
		          standalone-dispatch test) and do not group into a coherent sub-struct without \
		          adding indirection for no behavioral gain"
	)]
	pub async fn dispatch_tool_call(
		&self,
		trace: &mut TurnTrace,
		ctx: &TurnContext,
		tool_call_id: &ToolCallId,
		tool_name: &str,
		arguments: &WireJson,
		causation_event_id: Option<EventId>,
		causation_frame_id: Option<FrameId>,
	) -> Result<ToolDispatchSuccess, TurnFailure> {
		let registry = registry::slice0_registry();
		let effective_catalog =
			registry.effective_catalog(&self.effective_authority, &self.trusted_executable_allowlist);
		let Some(status) = effective_catalog
			.tools
			.iter()
			.find(|tool| tool.name == tool_name)
			.map(|tool| tool.status)
		else {
			return Err(TurnFailure::ToolNotInCatalog { tool_name: tool_name.to_owned() });
		};
		let tool_entity_ids =
			EntityIdsV0 { tool_call_id: Some(tool_call_id.clone()), ..EntityIdsV0::default() };

		let requested_event_id = self.ids.event_id();
		let requested_response = self
			.append(
				trace,
				ctx,
				requested_event_id.clone(),
				RawEventType::ToolCallRequested,
				self.clock.now(),
				kernel_producer(),
				causation_event_id,
				tool_entity_ids.clone(),
				visibility_for(&RawEventType::ToolCallRequested),
				RedactionLevelV0::Sensitive,
				json!({ "tool_name": tool_name, "arguments": arguments }),
				None,
			)
			.await?;

		if status != ToolStatusV0::Executable {
			let reason = catalog::stub_rejection_reason(tool_name);
			let rejected_event_id = self.ids.event_id();
			let error_id = self.ids.error_id();
			self
				.append(
					trace,
					ctx,
					rejected_event_id.clone(),
					RawEventType::ToolCallRejected,
					self.clock.now(),
					kernel_producer(),
					Some(requested_event_id),
					EntityIdsV0 {
						tool_call_id: Some(tool_call_id.clone()),
						error_id: Some(error_id.clone()),
						..EntityIdsV0::default()
					},
					visibility_for(&RawEventType::ToolCallRejected),
					RedactionLevelV0::Sensitive,
					json!({ "tool_name": tool_name, "policy": catalog::REJECTION_POLICY, "reason": reason }),
					None,
				)
				.await?;

			self
				.append(
					trace,
					ctx,
					self.ids.event_id(),
					RawEventType::ErrorRecorded,
					self.clock.now(),
					kernel_producer(),
					Some(rejected_event_id),
					EntityIdsV0 {
						tool_call_id: Some(tool_call_id.clone()),
						error_id: Some(error_id.clone()),
						..EntityIdsV0::default()
					},
					visibility_for(&RawEventType::ErrorRecorded),
					RedactionLevelV0::Sensitive,
					json!({
						"schema_version": successor_protocol::error::ERROR_SCHEMA_VERSION,
						"error_id": error_id.as_str(),
						"code": catalog::REJECTION_ERROR_CODE,
						"message": format!("Tool {tool_name} is catalog-visible but not executable in Slice 0."),
						"recoverable": true,
						"retryable": false,
						"correlation_id": ctx.request_id.as_str(),
						"details": { "tool_name": tool_name, "policy": catalog::REJECTION_POLICY },
					}),
					None,
				)
				.await?;

			return Err(TurnFailure::ToolRejected { tool_name: tool_name.to_owned(), reason });
		}

		let requested_fields = self.frame_fields(
			ctx,
			KernelFrameKindV0::ToolCallRequested,
			Some(RawEventRef::new(requested_event_id.clone(), requested_response.session_seq)),
			tool_entity_ids.clone(),
			json!({ "tool_name": tool_name, "arguments": arguments }),
		);
		let requested_frame =
			self.emit(trace, FrameFields { causation_frame_id, ..requested_fields });

		let started_event_id = self.ids.event_id();
		self
			.append(
				trace,
				ctx,
				started_event_id.clone(),
				RawEventType::ToolCallStarted,
				self.clock.now(),
				kernel_producer(),
				Some(requested_event_id),
				tool_entity_ids.clone(),
				visibility_for(&RawEventType::ToolCallStarted),
				RedactionLevelV0::Sensitive,
				json!({ "tool_name": tool_name }),
				None,
			)
			.await?;

		let (payload, artifact, provider_result_text) = self
			.execute_tool(tool_name, arguments)
			.map_err(TurnFailure::Protocol)?;
		let artifact_preview = artifact.preview.clone();

		let result_event_id = self.ids.event_id();
		// `tool_result.recorded` is the sole tool-lifecycle sub-event that
		// introduces a source envelope and an artifact handle (contract §§4.5,
		// 9): the platform's append store echoes `entity_ids.source_envelope_id`
		// / `entity_ids.artifact_id` verbatim from the request rather than
		// minting them, so the kernel must propose both here.
		let artifact_id = self.ids.artifact_id();
		let result_entity_ids = EntityIdsV0 {
			tool_call_id: Some(tool_call_id.clone()),
			source_envelope_id: Some(self.ids.source_envelope_id()),
			artifact_id: Some(artifact_id.clone()),
			..EntityIdsV0::default()
		};
		let result_response = self
			.append(
				trace,
				ctx,
				result_event_id.clone(),
				RawEventType::ToolResultRecorded,
				self.clock.now(),
				kernel_producer(),
				Some(started_event_id),
				result_entity_ids,
				visibility_for(&RawEventType::ToolResultRecorded),
				RedactionLevelV0::Sensitive,
				payload,
				Some(artifact),
			)
			.await?;
		let source_envelope_id = result_response.source_envelope_id.ok_or_else(|| {
			TurnFailure::Protocol(
				"platform did not assign a source_envelope_id for an appended artifact".to_owned(),
			)
		})?;

		let completed_event_id = self.ids.event_id();
		let completed_response = self
			.append(
				trace,
				ctx,
				completed_event_id.clone(),
				RawEventType::ToolCallCompleted,
				self.clock.now(),
				kernel_producer(),
				Some(result_event_id),
				tool_entity_ids,
				visibility_for(&RawEventType::ToolCallCompleted),
				RedactionLevelV0::Sensitive,
				json!({ "tool_name": tool_name, "status": "ok" }),
				None,
			)
			.await?;

		let frame_preview = artifact_preview
			.as_deref()
			.unwrap_or("")
			.lines()
			.next()
			.unwrap_or("");
		let completed_fields = self.frame_fields(
			ctx,
			KernelFrameKindV0::ToolCallCompleted,
			Some(RawEventRef::new(completed_event_id.clone(), completed_response.session_seq)),
			EntityIdsV0 {
				tool_call_id: Some(tool_call_id.clone()),
				source_envelope_id: Some(source_envelope_id.clone()),
				artifact_id: Some(artifact_id),
				..EntityIdsV0::default()
			},
			json!({ "tool_name": tool_name, "status": "ok", "preview": frame_preview }),
		);
		let completed_frame = self.emit(trace, FrameFields {
			causation_frame_id: Some(requested_frame.frame_id.clone()),
			..completed_fields
		});

		Ok(ToolDispatchSuccess {
			source_envelope_id,
			last_event_id: completed_event_id,
			last_frame_id: completed_frame.frame_id,
			provider_result_text,
		})
	}

	/// Runs the underlying Slice 0 tool executor through the registry, producing
	/// the raw-event payload/artifact pair. Returns `Err(reason)` on a typed
	/// tool-level rejection (bad args, out-of-root path, ...) rather than
	/// panicking.
	fn execute_tool(
		&self,
		tool_name: &str,
		arguments: &WireJson,
	) -> Result<(WireJson, RawEventArtifactRef, String), String> {
		let registry = registry::slice0_registry();
		let ctx = ToolExecutionContext {
			workspace_root:    &self.workspace_root,
			process_allowlist: &self.trusted_executable_allowlist,
		};
		let execution =
			registry.execute_authorized(&ctx, tool_name, arguments, &self.effective_authority)?;
		Ok((execution.payload, execution.artifact, execution.provider_result_text))
	}

	#[expect(
		clippy::too_many_arguments,
		reason = "task 216 assembly-query seam adds one parameter; splitting into a struct is out \
		          of scope for this narrow fix"
	)]
	async fn assemble_round(
		&self,
		trace: &mut TurnTrace,
		ctx: &TurnContext,
		phase: TurnPhase,
		user_text: &str,
		query: &str,
		required_source_envelope_ids: &[SourceEnvelopeId],
		causation_event_id: EventId,
		causation_frame_id: FrameId,
	) -> Result<(AssemblyResponseV0, EventId, FrameId), TurnFailure> {
		let trace_id = self.ids.trace_id();

		let mut assemble_request = AssembleRequestV0::new(
			ctx.session_id.clone(),
			ctx.turn_id.clone(),
			ctx.request_id.clone(),
			phase.as_assemble_phase(),
			AssembleIntentV0 {
				query:         query.to_owned(),
				raw_user_text: user_text.to_owned(),
				confidence:    "high".to_owned(),
			},
			AssembleWorkspaceV0 {
				root_hint: self.workspace_root.display().to_string(),
				repo_id:   "successor-agent-kernel".to_owned(),
			},
			AssemblyBudgetV0 { max_context_tokens: 12_000, max_items: 20 },
		);
		assemble_request.required_source_envelope_ids = required_source_envelope_ids.to_vec();
		let assembly_response = self
			.platform
			.assemble(&assemble_request)
			.await
			.map_err(Self::map_transport)?;
		let context_item_ids: Vec<ContextItemId> = assembly_response
			.context_items
			.iter()
			.map(|item| item.context_item_id.clone())
			.collect();
		let assemble_entity_ids = EntityIdsV0 {
			assemble_id: Some(assembly_response.assemble_id.clone()),
			context_item_ids: context_item_ids.clone(),
			trace_id: Some(trace_id.clone()),
			..EntityIdsV0::default()
		};

		let requested_payload = if phase.is_first() {
			json!({ "phase": phase.as_assemble_phase().as_str(), "query": query, "max_context_tokens": 12_000_u32, "max_items": 20_u32 })
		} else {
			json!({
				"phase": phase.as_assemble_phase().as_str(),
				"required_source_envelope_ids": required_source_envelope_ids.iter().map(SourceEnvelopeId::as_str).collect::<Vec<_>>(),
			})
		};
		let requested_event_id = self.ids.event_id();
		let requested_response = self
			.append(
				trace,
				ctx,
				requested_event_id.clone(),
				RawEventType::AssemblyRequested,
				self.clock.now(),
				kernel_producer(),
				Some(causation_event_id),
				EntityIdsV0 {
					assemble_id: assemble_entity_ids.assemble_id.clone(),
					trace_id: Some(trace_id.clone()),
					..EntityIdsV0::default()
				},
				visibility_for(&RawEventType::AssemblyRequested),
				RedactionLevelV0::Public,
				requested_payload,
				None,
			)
			.await?;

		let started_frame = if phase.is_first() {
			let fields = self.frame_fields(
				ctx,
				KernelFrameKindV0::PlatformAssembleStarted,
				Some(RawEventRef::new(requested_event_id.clone(), requested_response.session_seq)),
				assemble_entity_ids.clone(),
				json!({ "phase": phase.as_assemble_phase().as_str() }),
			);
			Some(self.emit(trace, FrameFields {
				causation_frame_id: Some(causation_frame_id.clone()),
				..fields
			}))
		} else {
			None
		};

		let mut completed_payload = json!({
			"phase": phase.as_assemble_phase().as_str(),
			"context_item_ids": context_item_ids.iter().map(ContextItemId::as_str).collect::<Vec<_>>(),
		});
		if !assembly_response.degradation.is_empty() {
			completed_payload["degradation"] = json!(
				assembly_response
					.degradation
					.iter()
					.map(|d| d.code.as_str())
					.collect::<Vec<_>>()
			);
		}
		let completed_event_id = self.ids.event_id();
		let completed_response = self
			.append(
				trace,
				ctx,
				completed_event_id.clone(),
				RawEventType::AssemblyCompleted,
				self.clock.now(),
				platform_producer(),
				Some(requested_event_id),
				assemble_entity_ids.clone(),
				visibility_for(&RawEventType::AssemblyCompleted),
				if context_item_ids.is_empty() {
					RedactionLevelV0::Public
				} else {
					RedactionLevelV0::Sensitive
				},
				completed_payload.clone(),
				None,
			)
			.await?;

		let is_terminal = phase.round_index() == TurnPhase::PostRead.round_index();
		let last_frame_id = if phase.is_first() || is_terminal {
			let completed_causation = started_frame
				.as_ref()
				.map_or_else(|| causation_frame_id.clone(), |frame| frame.frame_id.clone());
			let completed_frame_payload = json!({
				"phase": phase.as_assemble_phase().as_str(),
				"context_item_count": context_item_ids.len() as u64,
			});
			let mut completed_frame_payload = completed_frame_payload;
			if !assembly_response.degradation.is_empty() {
				completed_frame_payload["degradation_codes"] = json!(
					assembly_response
						.degradation
						.iter()
						.map(|d| d.code.as_str())
						.collect::<Vec<_>>()
				);
			}
			let fields = self.frame_fields(
				ctx,
				KernelFrameKindV0::PlatformAssembleCompleted,
				Some(RawEventRef::new(completed_event_id.clone(), completed_response.session_seq)),
				assemble_entity_ids,
				completed_frame_payload,
			);
			let frame = self
				.emit(trace, FrameFields { causation_frame_id: Some(completed_causation), ..fields });
			frame.frame_id
		} else {
			causation_frame_id
		};

		Ok((assembly_response, completed_event_id, last_frame_id))
	}

	/// Runs a full turn (contract §9). Auth must already have been
	/// resolved by the caller via [`require_provider_credential`] before
	/// constructing `self.provider`; this method assumes `self.provider`
	/// is ready to send requests.
	pub async fn execute_turn(&self, input: TurnInput) -> TurnAttempt {
		self.run_turn(input, None).await
	}

	/// Continues an existing session (contract §9/§11 continuation amendment,
	/// ruling 270) instead of minting a fresh one. The session's raw-event
	/// `session_seq` continues from its prior tail, and this turn's first
	/// event (`tool_catalog.published`) chains its `causation_event_id` to
	/// that tail rather than starting a new causation chain. Continuing into
	/// a session with no prior raw events fails closed with
	/// [`TurnFailure::Protocol`] before any event is appended. This is never
	/// resume or attach (contract §11): it drives a genuine new turn
	/// lifecycle appended to the same session stream.
	pub async fn continue_turn(&self, input: TurnInput, session_id: SessionId) -> TurnAttempt {
		self.run_turn(input, Some(session_id)).await
	}

	async fn run_turn(
		&self,
		input: TurnInput,
		continue_session_id: Option<SessionId>,
	) -> TurnAttempt {
		let mut trace = TurnTrace::new();
		// Finding 1 (C7 review): thread the accumulated trace through every
		// exit path, success or failure, instead of discarding it on the
		// `?`-propagated failure paths below. The fallible body runs in a
		// nested async block that borrows `trace` mutably; once it resolves,
		// `trace` is intact (partial on failure, complete on success) and is
		// wrapped into the returned `TurnAttempt` either way.
		let result: Result<String, TurnFailure> = async {
			let mut state = TurnState::NotStarted;

			let registry = registry::slice0_registry();
			let catalog = registry
				.effective_catalog(&self.effective_authority, &self.trusted_executable_allowlist);
			let (session_id, catalog_causation_event_id) = if let Some(existing_session_id) =
				continue_session_id
			{
				let snapshot = self
					.platform
					.read_snapshot(&existing_session_id)
					.await
					.map_err(Self::map_transport)?;
				let tail_event_id = snapshot.raw_event_ids.last().cloned().ok_or_else(|| {
					TurnFailure::Protocol(format!(
						"session {existing_session_id} has no prior raw events; continuation requires a session with at least one completed turn"
					))
				})?;
				(existing_session_id, Some(tail_event_id))
			} else {
				let session = self
					.platform
					.create_session(&CreateSessionRequestV0 {
						workspace:  WorkspaceV0 {
							id:        "workspace-1".to_owned(),
							label:     "Slice 0 workspace".to_owned(),
							root_hint: self.workspace_root.display().to_string(),
						},
						title:      "Slice 0 turn".to_owned(),
						created_by: CreatedByV0 {
							client_kind: "kernel".to_owned(),
							client_id:   "successor-kernel".to_owned(),
						},
					})
					.await
					.map_err(Self::map_transport)?;
				(session.session_id, None)
			};
			let ctx = TurnContext {
				session_id,
				turn_id:    self.ids.turn_id(),
				request_id: self.ids.request_id(),
			};

			let catalog_event_id = self.ids.event_id();
			// `tool_catalog.published` is session-level (contract §9): unlike every
			// other raw event in a turn, its `turn_id` is `null`. `Self::append`
			// always scopes to `ctx.turn_id`, so this one event is constructed
			// inline rather than threading a rarely-used `Option<TurnId>` override
			// through every other call site.
			let catalog_request = RawEventAppendRequestV0 {
				schema_version:     RAW_EVENT_SCHEMA_VERSION.to_owned(),
				event_id:           catalog_event_id.clone(),
				event_type:         RawEventType::ToolCatalogPublished,
				session_id:         ctx.session_id.clone(),
				turn_id:            None,
				request_id:         ctx.request_id.clone(),
				occurred_at:        self.clock.now(),
				producer:           kernel_producer(),
				causation_event_id: catalog_causation_event_id,
				correlation_id:     ctx.request_id.clone(),
				entity_ids:         EntityIdsV0::default(),
				visibility:         visibility_for(&RawEventType::ToolCatalogPublished),
				redaction:          RedactionLevelV0::Public,
				payload:            {
					let mut catalog_payload = json!({
						"catalog_id": self.ids.catalog_id(),
						"projection_version": successor_protocol::projection::PROJECTION_VERSION,
						"tool_count": catalog.tools.len(),
					});
					if let Some(decision) = self.effective_authority.conditional_decision_payload() {
						catalog_payload["authority_decision"] = decision;
					}
					catalog_payload
				},
				artifact:           None,
				idempotency_key:    format!(
					"{}:{}",
					ctx.session_id.as_str(),
					catalog_event_id.as_str()
				),
			};
			self
				.platform
				.append_event(&catalog_request)
				.await
				.map_err(Self::map_transport)?;
			let catalog_persisted = self
				.platform
				.read_event(&catalog_event_id)
				.await
				.map_err(Self::map_transport)?;
			trace.push_event(catalog_persisted);
			state = state.validate_next(TurnState::CatalogEnsured)?;

			let turn_started_at = self.clock.now();
			let message_id = self.ids.message_id();
			let turn_started_fields = self.frame_fields(
				&ctx,
				KernelFrameKindV0::TurnStarted,
				None,
				EntityIdsV0 { message_id: Some(message_id.clone()), ..EntityIdsV0::default() },
				json!({ "text_preview": input.user_text }),
			);
			let turn_started_frame = self
				.emit(&mut trace, FrameFields { ts: turn_started_at.clone(), ..turn_started_fields });

			let user_turn_event_id = self.ids.event_id();
			let user_turn_source_envelope_id = self.ids.source_envelope_id();
			let user_turn_response = self
				.append(
					&mut trace,
					&ctx,
					user_turn_event_id.clone(),
					RawEventType::UserTurnRecorded,
					turn_started_at,
					kernel_producer(),
					Some(catalog_event_id),
					EntityIdsV0 {
						message_id: Some(message_id.clone()),
						source_envelope_id: Some(user_turn_source_envelope_id.clone()),
						..EntityIdsV0::default()
					},
					visibility_for(&RawEventType::UserTurnRecorded),
					RedactionLevelV0::Sensitive,
					json!({ "source_kind": "user_turn", "text": input.user_text }),
					None,
				)
				.await?;
			state = state.validate_next(TurnState::UserTurnRecorded)?;

			let raw_event_appended_fields = FrameFields {
				causation_frame_id: Some(turn_started_frame.frame_id.clone()),
				..self.frame_fields(
					&ctx,
					KernelFrameKindV0::RawEventAppended,
					Some(RawEventRef::new(user_turn_event_id.clone(), user_turn_response.session_seq)),
					EntityIdsV0 {
						message_id: Some(message_id.clone()),
						source_envelope_id: Some(user_turn_source_envelope_id.clone()),
						..EntityIdsV0::default()
					},
					json!({ "duplicate": user_turn_response.duplicate, "event_type": "user_turn.recorded" }),
				)
			};
			let raw_event_appended_frame = self.emit(&mut trace, raw_event_appended_fields);

			let mut causation = user_turn_event_id;
			let mut last_frame_id = raw_event_appended_frame.frame_id;
			let mut required_source_envelope_ids: Vec<SourceEnvelopeId> = Vec::new();
			let mut phase = TurnPhase::PreTool;
			let mut executed_tool_rounds: u8 = 0;
			let mut completed_rounds: Vec<projection::CompletedToolRoundV0> = Vec::new();
			let assembly_query = input
				.assembly_query
				.clone()
				.unwrap_or_else(|| input.user_text.clone());

			let (assistant_text, terminal_state) = loop {
				state = state.validate_next(TurnState::Assembling(phase))?;
				let (assembly_response, assemble_completed_event_id, assemble_last_frame_id) = self
					.assemble_round(
						&mut trace,
						&ctx,
						phase,
						&input.user_text,
						&assembly_query,
						&required_source_envelope_ids,
						causation,
						last_frame_id,
					)
					.await?;
				state = state.validate_next(TurnState::Assembled(phase))?;
				causation = assemble_completed_event_id;
				last_frame_id = assemble_last_frame_id;

				// Only the first round of a turn (`TurnPhase::PreTool`) injects the
				// assembled-context block into the first user message. Later rounds
				// within the same turn already carry their own just-completed tool
				// activity via `completed_rounds` (the tool-use/tool-result message
				// pair), so no text is injected there, and the reported ids keep
				// their pre-existing unfiltered value so same-turn required-source
				// hydration (already reflected in `completed_rounds`, not in this
				// block) continues to be observable on `provider_request.built`.
				let (context_item_ids, provider_user_text): (Vec<ContextItemId>, String) = if phase.is_first() {
					let rendered_context = projection::render_context_block(&assembly_response.context_items);
					(
						rendered_context.injected_context_item_ids,
						format!("{}{}", rendered_context.text, input.user_text),
					)
				} else {
					(
						assembly_response.context_items.iter().map(|item| item.context_item_id.clone()).collect(),
						input.user_text.clone(),
					)
				};
				let mut request_payload = json!({
					"phase": phase.provider_request_label(),
					"provider_id": self.provider.provider_id(),
					"provider_api_shape": api_shape_label(&self.provider.api_shape()),
					"model": self.provider.model(),
					"context_item_ids": context_item_ids.iter().map(ContextItemId::as_str).collect::<Vec<_>>(),
				});
				if phase.is_first() {
					let tool_names: Vec<&str> = registry
						.effective_executable_names(&self.effective_authority, &self.trusted_executable_allowlist)
						.collect();
					request_payload["tool_names"] = json!(tool_names);
				}
				let request_event_id = self.ids.event_id();
				self
					.append(
						&mut trace,
						&ctx,
						request_event_id.clone(),
						RawEventType::ProviderRequestBuilt,
						self.clock.now(),
						kernel_producer(),
						Some(causation),
						EntityIdsV0 {
							context_item_ids: context_item_ids.clone(),
							trace_id: Some(self.ids.trace_id()),
							assemble_id: Some(assembly_response.assemble_id.clone()),
							..EntityIdsV0::default()
						},
						visibility_for(&RawEventType::ProviderRequestBuilt),
						RedactionLevelV0::Sensitive,
						request_payload,
						None,
					)
					.await?;
				state = state.validate_next(TurnState::ProviderRequestBuilt(phase))?;
				causation = request_event_id;

				let round_message_id = self.ids.message_id();
				let round_tool_call_id = self.ids.tool_call_id();
				let outcome = self
					.provider
					.send_round(
						&provider_user_text,
						&completed_rounds,
						&catalog,
						round_message_id.clone(),
						round_tool_call_id.clone(),
					)
					.await?;

				if let Some((tool_call, metadata)) = outcome.tool_call {
					if executed_tool_rounds >= MAX_EXECUTABLE_TOOL_ROUNDS {
						// <agent://256> item A (contract §9 amendment, commit 1e0b8ca98): a
						// provider tool call past the live per-turn maximum must still
						// emit `tool_call.rejected` + `error.recorded` before the turn
						// fails, reusing `dispatch_tool_call`'s stub-rejection machinery
						// (same producers/visibility/payload shape). No `tool_call.requested`
						// precedes this: the budget check rejects the call before it is
						// ever requested/observed, so causation chains to the last real
						// preceding event (`provider_request.built`).
						let tool_name = tool_call.tool_name.as_str();
						let reason =
							catalog::tool_budget_exhausted_reason(tool_name, MAX_EXECUTABLE_TOOL_ROUNDS);
						let rejected_event_id = self.ids.event_id();
						let error_id = self.ids.error_id();
						self
							.append(
								&mut trace,
								&ctx,
								rejected_event_id.clone(),
								RawEventType::ToolCallRejected,
								self.clock.now(),
								kernel_producer(),
								Some(causation.clone()),
								EntityIdsV0 {
									tool_call_id: Some(round_tool_call_id.clone()),
									error_id: Some(error_id.clone()),
									..EntityIdsV0::default()
								},
								visibility_for(&RawEventType::ToolCallRejected),
								RedactionLevelV0::Sensitive,
								json!({ "tool_name": tool_name, "policy": catalog::TOOL_BUDGET_REJECTION_POLICY, "reason": reason }),
								None,
							)
							.await?;

						self
							.append(
								&mut trace,
								&ctx,
								self.ids.event_id(),
								RawEventType::ErrorRecorded,
								self.clock.now(),
								kernel_producer(),
								Some(rejected_event_id),
								EntityIdsV0 {
									tool_call_id: Some(round_tool_call_id.clone()),
									error_id: Some(error_id.clone()),
									..EntityIdsV0::default()
								},
								visibility_for(&RawEventType::ErrorRecorded),
								RedactionLevelV0::Sensitive,
								json!({
									"schema_version": successor_protocol::error::ERROR_SCHEMA_VERSION,
									"error_id": error_id.as_str(),
									"code": catalog::TOOL_BUDGET_REJECTION_ERROR_CODE,
									"message": format!("Tool {tool_name} was requested after the Slice 0 per-turn tool-call maximum was already exhausted."),
									"recoverable": true,
									"retryable": false,
									"correlation_id": ctx.request_id.as_str(),
									"details": { "tool_name": tool_name, "policy": catalog::TOOL_BUDGET_REJECTION_POLICY },
								}),
								None,
							)
							.await?;

						return Err(TurnFailure::ToolBudgetExhausted);
					}
					executed_tool_rounds += 1;

					let observed_event_id = self.ids.event_id();
					let provider_event_id = self.ids.provider_event_id();
					let is_executable_tool =
						catalog::tool_status(&tool_call.tool_name) == Some(ToolStatusV0::Executable);
					let mut observed_payload = json!({
						"tool_name": tool_call.tool_name,
						"arguments": tool_call.arguments,
					});
					if is_executable_tool {
						observed_payload["provider_api_shape"] =
							json!(api_shape_label(&self.provider.api_shape()));
					}
					self
						.append(
							&mut trace,
							&ctx,
							observed_event_id.clone(),
							RawEventType::ProviderToolCallObserved,
							self.clock.now(),
							kernel_producer(),
							Some(causation),
							EntityIdsV0 {
								tool_call_id: Some(round_tool_call_id.clone()),
								provider_event_id: Some(provider_event_id),
								..EntityIdsV0::default()
							},
							visibility_for(&RawEventType::ProviderToolCallObserved),
							RedactionLevelV0::Sensitive,
							observed_payload,
							None,
						)
						.await?;
					state = state.validate_next(TurnState::ToolDispatching(phase))?;

					let dispatch = self
						.dispatch_tool_call(
							&mut trace,
							&ctx,
							&round_tool_call_id,
							&tool_call.tool_name,
							&tool_call.arguments,
							Some(observed_event_id),
							Some(last_frame_id),
						)
						.await?;
					state = state.validate_next(TurnState::ToolCompleted(phase))?;

					required_source_envelope_ids = vec![dispatch.source_envelope_id];
					causation = dispatch.last_event_id;
					last_frame_id = dispatch.last_frame_id;
					completed_rounds.push(projection::CompletedToolRoundV0 {
						provider_tool_call_id: metadata.provider_tool_call_id,
						tool_name: tool_call.tool_name,
						arguments: tool_call.arguments,
						result_text: dispatch.provider_result_text,
					});
					phase = phase.next().unwrap_or(phase);
				} else {
					let response_event_id = self.ids.event_id();
					let final_provider_event_id = self.ids.provider_event_id();
					self
						.append(
							&mut trace,
							&ctx,
							response_event_id.clone(),
							RawEventType::ProviderResponseRecorded,
							self.clock.now(),
							kernel_producer(),
							Some(causation),
							EntityIdsV0 {
								message_id: Some(round_message_id.clone()),
								context_item_ids: context_item_ids.clone(),
								trace_id: Some(self.ids.trace_id()),
								provider_event_id: Some(final_provider_event_id),
								..EntityIdsV0::default()
							},
							visibility_for(&RawEventType::ProviderResponseRecorded),
							RedactionLevelV0::Sensitive,
							json!({
								"phase": "final_response",
								"provider_id": self.provider.provider_id(),
								"provider_api_shape": api_shape_label(&self.provider.api_shape()),
								"model": self.provider.model(),
								"finish_reason": outcome.response.finish_reason,
								"text": outcome.response.text,
							}),
							None,
						)
						.await?;
					state = state.validate_next(TurnState::ProviderResponseRecorded)?;

					let assistant_message_id = self.ids.message_id();
					let assistant_source_envelope_id = self.ids.source_envelope_id();
					let assistant_turn_event_id = self.ids.event_id();
					let assistant_turn_response = self
						.append(
							&mut trace,
							&ctx,
							assistant_turn_event_id.clone(),
							RawEventType::AssistantTurnRecorded,
							self.clock.now(),
							kernel_producer(),
							Some(response_event_id),
							EntityIdsV0 {
								message_id: Some(assistant_message_id.clone()),
								source_envelope_id: Some(assistant_source_envelope_id.clone()),
								..EntityIdsV0::default()
							},
							visibility_for(&RawEventType::AssistantTurnRecorded),
							RedactionLevelV0::Sensitive,
							json!({
								"source_kind": "assistant_turn",
								"text": outcome.response.text,
								"summary": outcome.summary.clone().unwrap_or_else(|| outcome.response.text.clone()),
							}),
							None,
						)
						.await?;
					state = state.validate_next(TurnState::AssistantTurnRecorded)?;


					if !outcome.response.text.is_empty() {
						let provider_delta_fields = self.frame_fields(
							&ctx,
							KernelFrameKindV0::ProviderDelta,
							Some(RawEventRef::new(
								assistant_turn_event_id.clone(),
								assistant_turn_response.session_seq,
							)),
							EntityIdsV0 {
								message_id: Some(assistant_message_id.clone()),
								source_envelope_id: Some(assistant_source_envelope_id.clone()),
								..EntityIdsV0::default()
							},
							json!({ "text": outcome.response.text }),
						);
						let provider_delta_frame = self.emit(&mut trace, FrameFields {
							causation_frame_id: Some(last_frame_id),
							..provider_delta_fields
						});
						last_frame_id = provider_delta_frame.frame_id;
					}

					let turn_completed_fields = self.frame_fields(
						&ctx,
						KernelFrameKindV0::TurnCompleted,
						Some(RawEventRef::new(
							assistant_turn_event_id,
							assistant_turn_response.session_seq,
						)),
						EntityIdsV0 {
							message_id: Some(assistant_message_id),
							source_envelope_id: Some(assistant_source_envelope_id),
							..EntityIdsV0::default()
						},
						json!({ "finish_reason": outcome.response.finish_reason }),
					);
					self.emit(&mut trace, FrameFields {
						causation_frame_id: Some(last_frame_id),
						..turn_completed_fields
					});
					state = state.validate_next(TurnState::Completed)?;

					break (outcome.response.text, state);
				}
			};

			trace.finish(terminal_state);
			Ok(assistant_text)
		}
		.await;

		match result {
			Ok(assistant_text) => TurnAttempt::completed(trace, assistant_text),
			Err(failure) => {
				trace.finish(TurnState::Failed);
				TurnAttempt::failed(trace, failure)
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::provider::auth::ProviderSlot;

	#[test]
	fn runner_never_reaches_publish_with() {
		// Boundary assertion (Dissent ruling 2): the only legitimate way
		// for this module to reach the frame stream is `FrameSink::emit`.
		// `KernelFrameStream::publish_with` is `pub(crate)`, so nothing
		// outside `crate::stream` can be *forced* to avoid it by the type
		// system alone; this scans the module's own source for the
		// literal so a regression that starts calling it directly fails
		// this test immediately rather than only showing up in review.
		let source = include_str!("runner.rs");
		// Built at runtime (not a contiguous literal) so this test's own
		// source doesn't trip its own scan.
		let forbidden_call = [".", "publish_with", "("].concat();
		assert!(
			!source.contains(&forbidden_call),
			"runner.rs must only reach the frame stream through FrameSink::emit, never a direct \
			 stream call"
		);
	}

	#[test]
	fn require_provider_credential_surfaces_unavailable_without_touching_the_platform() {
		let outcome = ProviderAuthOutcome::Unavailable { slot: ProviderSlot::Anthropic };
		let failure = require_provider_credential(&outcome).unwrap_err();
		assert_eq!(failure, TurnFailure::ProviderAuthUnavailable { slot: ProviderSlot::Anthropic });
	}

	#[test]
	fn api_shape_label_matches_the_contract_wire_strings() {
		assert_eq!(api_shape_label(&ProviderApiShapeV0::AnthropicMessages), "anthropic_messages");
		assert_eq!(
			api_shape_label(&ProviderApiShapeV0::OpenAiChatCompletions),
			"openai_chat_completions"
		);
		assert_eq!(api_shape_label(&ProviderApiShapeV0::OpenAiResponses), "openai_responses");
	}
}
