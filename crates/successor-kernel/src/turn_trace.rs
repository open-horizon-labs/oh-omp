//! Owned by Lane C7 `KernelTurnRunner`.
//!
//! Deterministic turn trace assembly.
//!
//! [`crate::runner::TurnRunner`] appends raw events through
//! [`crate::platform_client::KernelPlatformClient`] and emits frames through
//! [`crate::frame_sink::FrameSink`] as a turn progresses. Neither of those
//! seams gives the runner's caller (C8) a single, ordered, in-memory view of
//! "what happened during this attempt" — [`read_session_events`] would
//! require a second platform round trip, and the frame stream is
//! fire-and-forget broadcast. [`TurnTrace`] closes that gap: the runner
//! appends to it locally as the turn progresses, and returns it (embedded in
//! [`crate::runner::TurnOutcome`]) when the attempt finishes, succeeds or
//! fails.
//!
//! Construction is deterministic and append-only: [`TurnTrace::push_event`]
//! and [`TurnTrace::push_frame`] record exactly what the runner appended/
//! emitted, in the order it did so, with no re-derivation, re-ordering, or
//! filtering. This keeps the trace a faithful, replayable record rather
//! than a second projection with its own opinions.
//!
//! [`read_session_events`]: crate::platform_client::KernelPlatformClient::read_session_events

use successor_protocol::{kernel_frame::KernelFrameV0, raw_event::RawEventV0};

use crate::state_machine::{TurnFailure, TurnState};

/// An ordered, in-memory record of one turn attempt: every raw event
/// appended and every frame emitted, in the exact order the runner produced
/// them, plus the terminal [`TurnState`] the attempt reached.
///
/// A [`TurnTrace`] is scoped to a single attempt (Dissent ruling 5:
/// single-attempt lifecycle, no resume engine). It is not itself a
/// persisted artifact; it mirrors what was persisted (raw events) and
/// broadcast (frames) so a caller does not need a second round trip to
/// inspect what just happened.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnTrace {
	events:         Vec<RawEventV0>,
	frames:         Vec<KernelFrameV0>,
	terminal_state: Option<TurnState>,
}

impl TurnTrace {
	/// Starts an empty trace.
	pub fn new() -> Self {
		Self::default()
	}

	/// Records that `event` was just appended to the platform, in order.
	pub fn push_event(&mut self, event: RawEventV0) {
		self.events.push(event);
	}

	/// Records that `frame` was just emitted through the [`FrameSink`],
	/// in order.
	///
	/// [`FrameSink`]: crate::frame_sink::FrameSink
	pub fn push_frame(&mut self, frame: KernelFrameV0) {
		self.frames.push(frame);
	}

	/// Marks the trace complete with the lifecycle's terminal state
	/// ([`TurnState::Completed`] or [`TurnState::Failed`]).
	///
	/// Idempotent-in-intent but last-write-wins: only the runner calls this,
	/// exactly once, at the end of an attempt.
	pub const fn finish(&mut self, terminal_state: TurnState) {
		self.terminal_state = Some(terminal_state);
	}

	/// Every raw event appended during this attempt, in append order.
	pub fn events(&self) -> &[RawEventV0] {
		&self.events
	}

	/// Every frame emitted during this attempt, in emission order.
	pub fn frames(&self) -> &[KernelFrameV0] {
		&self.frames
	}

	/// The lifecycle's terminal state, if [`Self::finish`] has been called.
	pub const fn terminal_state(&self) -> Option<TurnState> {
		self.terminal_state
	}

	/// Whether the attempt reached [`TurnState::Completed`].
	pub const fn succeeded(&self) -> bool {
		matches!(self.terminal_state, Some(TurnState::Completed))
	}

	/// The dense session-sequence range this trace's events span, as
	/// `(first, last)`, or `None` if no events were recorded (e.g. the
	/// turn failed before appending anything, such as
	/// [`TurnFailure::ProviderAuthUnavailable`]).
	pub fn session_seq_range(&self) -> Option<(u64, u64)> {
		let first = self.events.first()?.session_seq;
		let last = self.events.last()?.session_seq;
		Some((first, last))
	}
}

/// A completed turn attempt.
///
/// Either the [`TurnTrace`] of a successful run, or a typed
/// [`TurnFailure`] paired with whatever [`TurnTrace`] had been recorded
/// before the failure occurred (empty if the failure preceded any raw
/// event, e.g. provider auth unavailable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnAttempt {
	pub trace:   TurnTrace,
	pub outcome: Result<(), TurnFailure>,
}

impl TurnAttempt {
	pub const fn completed(trace: TurnTrace) -> Self {
		Self { trace, outcome: Ok(()) }
	}

	pub const fn failed(trace: TurnTrace, failure: TurnFailure) -> Self {
		Self { trace, outcome: Err(failure) }
	}
}

#[cfg(test)]
mod tests {
	use successor_protocol::{
		ids::{EventId, RequestId, SessionId, TurnId},
		raw_event::RawEventType,
	};

	use super::*;
	use crate::state_machine::TurnPhase;

	fn sample_event(session_seq: u64) -> RawEventV0 {
		RawEventV0::new(
			SessionId::try_from(format!("ses_{session_seq:032}")).expect("valid session id"),
			EventId::try_from(format!("evt_{session_seq:032}")).expect("valid event id"),
			RawEventType::UserTurnRecorded,
			session_seq,
			format!("idempotency-{session_seq}"),
			RequestId::try_from(format!("req_{session_seq:032}")).expect("valid request id"),
			TurnId::try_from(format!("turn_{session_seq:032}")).expect("valid turn id"),
			serde_json::json!({}),
			"2026-06-23T12:00:00Z",
		)
	}

	#[test]
	fn new_trace_has_no_session_seq_range() {
		assert_eq!(TurnTrace::new().session_seq_range(), None);
	}

	#[test]
	fn push_event_preserves_append_order_and_session_seq_range() {
		let mut trace = TurnTrace::new();
		trace.push_event(sample_event(1));
		trace.push_event(sample_event(2));
		trace.push_event(sample_event(3));
		assert_eq!(trace.events().len(), 3);
		assert_eq!(trace.events()[0].session_seq, 1);
		assert_eq!(trace.events()[2].session_seq, 3);
		assert_eq!(trace.session_seq_range(), Some((1, 3)));
	}

	#[test]
	fn finish_records_the_terminal_state_and_succeeded_reflects_it() {
		let mut trace = TurnTrace::new();
		assert!(!trace.succeeded());
		trace.finish(TurnState::Completed);
		assert!(trace.succeeded());
		assert_eq!(trace.terminal_state(), Some(TurnState::Completed));
	}

	#[test]
	fn finish_with_failed_does_not_mark_the_trace_succeeded() {
		let mut trace = TurnTrace::new();
		trace.finish(TurnState::Failed);
		assert!(!trace.succeeded());
	}

	#[test]
	fn turn_attempt_failed_carries_the_partial_trace_and_the_typed_failure() {
		let mut trace = TurnTrace::new();
		trace.push_event(sample_event(1));
		trace.finish(TurnState::Failed);
		let attempt = TurnAttempt::failed(trace.clone(), TurnFailure::ToolRejected {
			tool_name: "bash".to_owned(),
			reason:    "stub rejected".to_owned(),
		});
		assert_eq!(attempt.trace, trace);
		assert_eq!(
			attempt.outcome,
			Err(TurnFailure::ToolRejected {
				tool_name: "bash".to_owned(),
				reason:    "stub rejected".to_owned(),
			})
		);
	}

	#[test]
	fn turn_attempt_completed_carries_no_failure() {
		let attempt = TurnAttempt::completed(TurnTrace::new());
		assert_eq!(attempt.outcome, Ok(()));
	}

	#[test]
	fn turn_phase_is_reexported_for_trace_consumers_without_a_separate_import() {
		// Documents that `TurnPhase` (state_machine.rs) is the phase vocabulary
		// a `TurnTrace` consumer is expected to cross-reference against
		// `events()` payloads; no separate phase type lives in this module.
		assert_eq!(TurnPhase::PreTool.round_index(), 0);
	}
}
