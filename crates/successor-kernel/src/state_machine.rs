//! Owned by Lane C7 `KernelTurnRunner`.
//!
//! The Slice 0 turn lifecycle (contract §9) as a typed state machine, plus
//! the typed failure surface [`TurnFailure`] the runner returns instead of
//! panicking or inventing an ad hoc error string.
//!
//! Slice 0's canonical fixture is the locator (`search_files`) + file-read
//! (`read`) happy path — contract §9, Dissent ruling 5 — represented
//! directly as the three [`TurnPhase`] variants; there is no fourth phase.
//! Live execution (<agent://256> dissent ruling, amending Dissent ruling 5's
//! original two-call bound) permits up to [`MAX_EXECUTABLE_TOOL_ROUNDS`]
//! executable tool rounds per turn: rounds beyond [`TurnPhase::PostRead`]
//! reuse its assemble/label mapping rather than advancing to a fourth
//! phase, and [`TurnPhase::next`] still returns `None` after
//! [`TurnPhase::PostRead`] — the tool-round budget is enforced by a
//! runner-owned counter against [`MAX_EXECUTABLE_TOOL_ROUNDS`], independent
//! of [`TurnPhase::round_index`].
//!
//! [`TurnState`] transitions are validated by [`TurnState::validate_next`]:
//! illegal transitions return a typed [`IllegalTransition`] rather than
//! panicking, so a caller (or a test) can assert on the exact rejected edge.

use successor_protocol::platform_api::AssemblePhaseV0;
use thiserror::Error;

use crate::provider::auth::ProviderSlot;

/// One of the three bounded assemble/provider rounds in a Slice 0 turn.
///
/// Round 0 ([`TurnPhase::PreTool`]) always runs. Round 1
/// ([`TurnPhase::PostLocator`]) only runs if the provider requested the
/// locator tool in round 0. Round 2 ([`TurnPhase::PostRead`]) only runs if
/// the provider requested the read tool in round 1. A turn always
/// finalizes at or before [`TurnPhase::PostRead`] (Dissent ruling 5: no
/// further tool round is ever attempted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TurnPhase {
	PreTool,
	PostLocator,
	PostRead,
}

/// Maximum number of executable tool-call rounds permitted within a single
/// turn.
///
/// Set by the <agent://256> dissent ruling, amending Dissent ruling 5's
/// original two-call bound. Enforced by a runner-owned round counter
/// (`runner.rs`'s `execute_turn`), independent of [`TurnPhase::round_index`]:
/// [`TurnPhase`] itself still only distinguishes the first three
/// assemble/provider rounds ([`TurnPhase::PreTool`],
/// [`TurnPhase::PostLocator`], [`TurnPhase::PostRead`]); rounds beyond
/// `PostRead` reuse its assemble-phase/label mapping instead of advancing
/// to a fourth phase.
pub const MAX_EXECUTABLE_TOOL_ROUNDS: u8 = 8;

impl TurnPhase {
	/// Zero-based round index, matching the order rounds run in.
	pub const fn round_index(self) -> u8 {
		match self {
			Self::PreTool => 0,
			Self::PostLocator => 1,
			Self::PostRead => 2,
		}
	}

	/// The [`AssemblePhaseV0`] this round assembles context for.
	pub const fn as_assemble_phase(self) -> AssemblePhaseV0 {
		match self {
			Self::PreTool => AssemblePhaseV0::PreTool,
			Self::PostLocator => AssemblePhaseV0::PostLocator,
			Self::PostRead => AssemblePhaseV0::PostRead,
		}
	}

	/// The provider-request phase label used in the `provider_request.built`
	/// raw event payload (contract §9): `"initial"`, `"read_request"`, or
	/// `"final"`.
	pub const fn provider_request_label(self) -> &'static str {
		match self {
			Self::PreTool => "initial",
			Self::PostLocator => "read_request",
			Self::PostRead => "final",
		}
	}

	/// The tool name expected to precede this round, for every round after
	/// the first.
	pub const fn preceding_tool_name(self) -> Option<&'static str> {
		match self {
			Self::PreTool => None,
			Self::PostLocator => Some("search_files"),
			Self::PostRead => Some("read"),
		}
	}

	/// The round that follows this one, or `None` if this round is the last
	/// one Slice 0 ever attempts.
	pub const fn next(self) -> Option<Self> {
		match self {
			Self::PreTool => Some(Self::PostLocator),
			Self::PostLocator => Some(Self::PostRead),
			Self::PostRead => None,
		}
	}

	/// Whether this round's `platform_assemble_started`/`_completed` frame
	/// pair follows the canonical fixture's curation (kernel-frame-stream
	/// contract §5): only the first round ever gets a `started` frame.
	pub const fn is_first(self) -> bool {
		self.round_index() == 0
	}
}

/// A typed node in the Slice 0 turn lifecycle (contract §9).
///
/// Every raw event the runner appends corresponds to exactly one forward
/// transition of this state machine. States are intentionally coarser than
/// raw event types where several raw events share one logical state (e.g.
/// `tool_call.requested`/`.started` both fall under
/// [`TurnState::ToolDispatching`]) because the state machine's job is to
/// reject illegal *macro* transitions (skipping assembly, recording a
/// response before the request was built, ...), not to re-validate the
/// exact raw-event ordering — that is [`successor_protocol::replay`]'s job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
	/// No turn work has started yet.
	NotStarted,
	/// `tool_catalog.published` has been ensured for the session.
	CatalogEnsured,
	/// `user_turn.recorded` has been appended.
	UserTurnRecorded,
	/// `assembly.requested` has been appended for `phase`; the platform
	/// `/assemble` call is in flight or has just returned.
	Assembling(TurnPhase),
	/// `assembly.completed` has been appended for `phase`.
	Assembled(TurnPhase),
	/// `provider_request.built` has been appended for `phase`.
	ProviderRequestBuilt(TurnPhase),
	/// `provider_tool_call.observed` has been appended for `phase`; a tool
	/// dispatch (accepted or rejected) is in flight or has just returned.
	ToolDispatching(TurnPhase),
	/// The tool call for `phase` completed successfully
	/// (`tool_call.completed` appended); the next round's assembly has not
	/// started yet.
	ToolCompleted(TurnPhase),
	/// `provider_response.recorded` has been appended for the terminal
	/// round.
	ProviderResponseRecorded,
	/// `assistant_turn.recorded` has been appended; the turn is done except
	/// for the `turn_completed` frame.
	AssistantTurnRecorded,
	/// The turn finished successfully.
	Completed,
	/// The turn ended in a typed failure. Terminal: no further transition
	/// is legal from this state.
	Failed,
}

/// A rejected [`TurnState`] transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("illegal turn state transition: {from:?} -> {to:?}")]
pub struct IllegalTransition {
	pub from: TurnState,
	pub to:   TurnState,
}

impl TurnState {
	/// Validates that `next` is a legal transition from `self`, returning
	/// `next` unchanged on success or a typed [`IllegalTransition`] on
	/// failure. Never panics.
	pub fn validate_next(self, next: Self) -> Result<Self, IllegalTransition> {
		let legal = match (self, next) {
			// Any state may transition to `Failed`: a typed failure can be
			// surfaced at any point in the lifecycle.
			(_, Self::Failed) => true,
			(Self::NotStarted, Self::CatalogEnsured) => true,
			(Self::CatalogEnsured, Self::UserTurnRecorded) => true,
			(Self::UserTurnRecorded, Self::Assembling(TurnPhase::PreTool)) => true,
			(Self::Assembling(a), Self::Assembled(b)) => a == b,
			(Self::Assembled(a), Self::ProviderRequestBuilt(b)) => a == b,
			(Self::ProviderRequestBuilt(a), Self::ToolDispatching(b)) => a == b,
			(Self::ProviderRequestBuilt(_), Self::ProviderResponseRecorded) => true,
			(Self::ToolDispatching(a), Self::ToolCompleted(b)) => a == b,
			(Self::ToolCompleted(a), Self::Assembling(b)) => a.next() == Some(b),
			(Self::ProviderResponseRecorded, Self::AssistantTurnRecorded) => true,
			(Self::AssistantTurnRecorded, Self::Completed) => true,
			_ => false,
		};
		if legal {
			Ok(next)
		} else {
			Err(IllegalTransition { from: self, to: next })
		}
	}
}

/// A typed failure surfaced by [`crate::runner::TurnRunner`] (Dissent
/// ruling 5: single-attempt lifecycle, typed failures, no retry/backoff).
///
/// [`TurnFailure::ProviderAuthUnavailable`] carries no raw-event or frame
/// shape: per the packet's non-goals, auth-unavailable turn shapes need
/// separate human acceptance and are out of scope for this lane. A caller
/// receiving this variant must not have any raw events appended on its
/// behalf for the attempt that failed this way.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TurnFailure {
	/// The provider credential could not be resolved for this attempt.
	#[error("provider credential unavailable for slot {slot:?}")]
	ProviderAuthUnavailable { slot: ProviderSlot },

	/// The provider requested a tool that is catalog-visible but not
	/// executable in Slice 0 (contract §7/§12, the unsupported-tool
	/// fixture).
	#[error("tool `{tool_name}` is catalog-visible but not executable in Slice 0: {reason}")]
	ToolRejected { tool_name: String, reason: String },

	/// The provider requested a tool call after the Slice 0 tool budget
	/// (at most one locator call and one read call) was exhausted.
	#[error("provider requested a tool call after the Slice 0 tool budget was exhausted")]
	ToolBudgetExhausted,

	/// The tool the provider named is not present in the published
	/// catalog at all (distinct from [`Self::ToolRejected`], which covers
	/// catalog-visible-but-stub-rejected tools).
	#[error("tool `{tool_name}` is not present in the published tool catalog")]
	ToolNotInCatalog { tool_name: String },

	/// A platform HTTP call failed (transport failure or a non-2xx
	/// response). Rendered via `Display` rather than wrapping
	/// `PlatformClientError` directly so this type stays independent of
	/// the exact transport error shape.
	#[error("platform transport failure: {0}")]
	Transport(String),

	/// A protocol-level violation was detected while projecting a provider
	/// request (e.g. a malformed wire tool call).
	#[error("protocol violation: {0}")]
	Protocol(String),

	/// The provider adapter (or its test double) reported a failure.
	#[error("provider failure: {0}")]
	Provider(String),

	/// An internal state machine transition was illegal. Surfacing this
	/// as a typed failure (rather than panicking) lets a caller distinguish
	/// "the turn failed" from "the runner has a bug it can recover from",
	/// while still failing the attempt.
	#[error(transparent)]
	IllegalTransition(#[from] IllegalTransition),
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn turn_phase_bounds_the_turn_to_three_rounds() {
		assert_eq!(TurnPhase::PreTool.next(), Some(TurnPhase::PostLocator));
		assert_eq!(TurnPhase::PostLocator.next(), Some(TurnPhase::PostRead));
		assert_eq!(TurnPhase::PostRead.next(), None);
	}

	#[test]
	fn turn_phase_provider_labels_match_contract_examples() {
		assert_eq!(TurnPhase::PreTool.provider_request_label(), "initial");
		assert_eq!(TurnPhase::PostLocator.provider_request_label(), "read_request");
		assert_eq!(TurnPhase::PostRead.provider_request_label(), "final");
	}

	#[test]
	fn happy_path_transitions_are_all_legal() {
		let mut state = TurnState::NotStarted;
		let path = [
			TurnState::CatalogEnsured,
			TurnState::UserTurnRecorded,
			TurnState::Assembling(TurnPhase::PreTool),
			TurnState::Assembled(TurnPhase::PreTool),
			TurnState::ProviderRequestBuilt(TurnPhase::PreTool),
			TurnState::ToolDispatching(TurnPhase::PreTool),
			TurnState::ToolCompleted(TurnPhase::PreTool),
			TurnState::Assembling(TurnPhase::PostLocator),
			TurnState::Assembled(TurnPhase::PostLocator),
			TurnState::ProviderRequestBuilt(TurnPhase::PostLocator),
			TurnState::ToolDispatching(TurnPhase::PostLocator),
			TurnState::ToolCompleted(TurnPhase::PostLocator),
			TurnState::Assembling(TurnPhase::PostRead),
			TurnState::Assembled(TurnPhase::PostRead),
			TurnState::ProviderRequestBuilt(TurnPhase::PostRead),
			TurnState::ProviderResponseRecorded,
			TurnState::AssistantTurnRecorded,
			TurnState::Completed,
		];
		for next in path {
			state = state
				.validate_next(next)
				.unwrap_or_else(|err| panic!("{err}"));
		}
	}

	#[test]
	fn no_tool_short_circuit_from_pre_tool_request_straight_to_response_is_legal() {
		let state = TurnState::ProviderRequestBuilt(TurnPhase::PreTool);
		assert!(
			state
				.validate_next(TurnState::ProviderResponseRecorded)
				.is_ok()
		);
	}

	#[test]
	fn skipping_assembly_is_an_illegal_transition() {
		let state = TurnState::UserTurnRecorded;
		let err = state
			.validate_next(TurnState::ProviderRequestBuilt(TurnPhase::PreTool))
			.expect_err("skipping straight to a built request must be illegal");
		assert_eq!(err.from, TurnState::UserTurnRecorded);
		assert_eq!(err.to, TurnState::ProviderRequestBuilt(TurnPhase::PreTool));
	}

	#[test]
	fn phase_mismatch_across_assemble_and_assembled_is_illegal() {
		let state = TurnState::Assembling(TurnPhase::PreTool);
		assert!(
			state
				.validate_next(TurnState::Assembled(TurnPhase::PostLocator))
				.is_err()
		);
	}

	#[test]
	fn skipping_post_locator_straight_to_post_read_is_illegal() {
		let state = TurnState::ToolCompleted(TurnPhase::PreTool);
		assert!(
			state
				.validate_next(TurnState::Assembling(TurnPhase::PostRead))
				.is_err()
		);
	}

	#[test]
	fn completed_is_terminal_except_for_failed() {
		let state = TurnState::Completed;
		assert!(state.validate_next(TurnState::NotStarted).is_err());
		assert!(state.validate_next(TurnState::Failed).is_ok());
	}

	#[test]
	fn any_state_may_transition_to_failed() {
		for state in [
			TurnState::NotStarted,
			TurnState::Assembling(TurnPhase::PostRead),
			TurnState::ProviderResponseRecorded,
			TurnState::Completed,
		] {
			assert!(state.validate_next(TurnState::Failed).is_ok());
		}
	}

	#[test]
	fn turn_failure_illegal_transition_conversion_preserves_the_rejected_edge() {
		let err = TurnState::NotStarted
			.validate_next(TurnState::Completed)
			.unwrap_err();
		let failure: TurnFailure = err.into();
		assert_eq!(
			failure,
			TurnFailure::IllegalTransition(IllegalTransition {
				from: TurnState::NotStarted,
				to:   TurnState::Completed,
			})
		);
	}
}
