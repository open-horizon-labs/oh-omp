//! Kernel frame producer (Lane C2 `KernelFrameStream`).
//!
//! [`FrameSink`] is the write side of a live, per-request kernel frame
//! stream. It is driven by the C7 `KernelTurnRunner`: callers supply
//! already-minted identifiers and frame content via [`FrameFields`], and
//! the sink's sole kernel-owned contribution is assigning the dense
//! `stream_seq` for the live stream (see `stream.rs`) and building the
//! accepted [`KernelFrameV0`] DTO. This module never mints `frame_id`
//! values, never invents timestamps, and never decides turn-lifecycle
//! ordering -- that is runner (C7) authority, out of C2 scope.

use successor_protocol::{
	ids::{EventId, FrameId, RequestId, SessionId, TurnId},
	kernel_frame::{KernelFrameKindV0, KernelFramePayloadV0, KernelFrameV0},
	raw_event::EntityIdsV0,
};

use crate::stream::KernelFrameStream;
pub use crate::stream::StreamClosedError;

/// A paired persisted raw-event reference for a persisted-fact frame.
///
/// The accepted [`KernelFrameV0`] contract requires `raw_event_id` and
/// `raw_event_session_seq` to be present together or absent together (see
/// [`KernelFrameV0::validate_dto`]). Requiring both fields in one type makes
/// the unpaired state unrepresentable through [`FrameSink::emit`] callers --
/// this is `frame_sink.rs`'s "rejected by construction" half of that
/// invariant, independent of the DTO-level `validate_dto` safety net that
/// still catches the unpaired state if it is ever constructed by other
/// means (e.g., directly via [`KernelFrameV0::with_raw_event_id`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEventRef {
	pub event_id:    EventId,
	pub session_seq: u64,
}

impl RawEventRef {
	/// Pair a raw event's identifier with its session-scoped sequence
	/// number.
	pub const fn new(event_id: EventId, session_seq: u64) -> Self {
		Self { event_id, session_seq }
	}
}

/// Caller-supplied fields for one emitted frame.
///
/// `frame_id` and `ts` are minted by the driving runner (C7
/// `KernelTurnRunner`); [`FrameSink`] never invents frame identity or
/// timestamps. `stream_seq` is deliberately absent from this type: it is
/// assigned by [`FrameSink::emit`], not supplied by the caller, because the
/// caller cannot know the current state of the stream's dense counter
/// (especially under concurrent producers sharing one stream).
#[derive(Debug, Clone)]
pub struct FrameFields {
	pub frame_id:           FrameId,
	pub session_id:         SessionId,
	pub turn_id:            TurnId,
	pub request_id:         RequestId,
	pub kind:               KernelFrameKindV0,
	pub ts:                 String,
	pub payload:            KernelFramePayloadV0,
	pub raw_event_ref:      Option<RawEventRef>,
	pub causation_frame_id: Option<FrameId>,
	pub entity_ids:         EntityIdsV0,
}

/// The write side of a live, per-request kernel frame stream.
///
/// Wraps a [`KernelFrameStream`] handle: [`FrameSink::emit`] builds the
/// accepted [`KernelFrameV0`] DTO from [`FrameFields`] and publishes it,
/// with the stream assigning the dense `stream_seq`. Cloning a `FrameSink`
/// yields another handle to the same live stream (shared sequence counter
/// and broadcast channel) -- concurrent producers sharing a clone still
/// observe a dense, duplicate-free `stream_seq` because assignment happens
/// under the stream's single lock (see [`KernelFrameStream::publish_with`]).
#[derive(Debug, Clone)]
pub struct FrameSink {
	stream: KernelFrameStream,
}

impl FrameSink {
	/// Construct a `FrameSink` bound to `stream`.
	pub const fn new(stream: KernelFrameStream) -> Self {
		Self { stream }
	}

	/// Build and publish a [`KernelFrameV0`] from `fields`.
	///
	/// Returns the constructed frame (with its assigned `stream_seq`) on
	/// success. Fails with [`StreamClosedError`] if the stream has already
	/// been closed; in that case no `stream_seq` is consumed.
	pub fn emit(&self, fields: FrameFields) -> Result<KernelFrameV0, StreamClosedError> {
		self.stream.publish_with(move |stream_seq| {
			let mut frame = KernelFrameV0::new(
				fields.frame_id,
				stream_seq,
				fields.session_id,
				fields.turn_id,
				fields.request_id,
				fields.kind,
				fields.ts,
				fields.payload,
			);
			if let Some(raw_event_ref) = fields.raw_event_ref {
				frame = frame.with_raw_event(raw_event_ref.event_id, raw_event_ref.session_seq);
			}
			if let Some(causation_frame_id) = fields.causation_frame_id {
				frame = frame.with_causation_frame_id(causation_frame_id);
			}
			frame.entity_ids = fields.entity_ids;
			frame
		})
	}
}

#[cfg(test)]
mod tests {
	use successor_protocol::ids::{RequestId, SessionId, TurnId};

	use super::*;

	fn minimal_fields(frame_id: &str) -> FrameFields {
		FrameFields {
			frame_id:           FrameId::try_from(frame_id.to_owned()).expect("valid frame_ prefix"),
			session_id:         SessionId::try_from("ses_test".to_owned()).expect("valid ses_ prefix"),
			turn_id:            TurnId::try_from("turn_test".to_owned()).expect("valid turn_ prefix"),
			request_id:         RequestId::try_from("req_test".to_owned()).expect("valid req_ prefix"),
			kind:               KernelFrameKindV0::TurnStarted,
			ts:                 "2026-06-23T12:00:00Z".to_owned(),
			payload:            serde_json::json!({}),
			raw_event_ref:      None,
			causation_frame_id: None,
			entity_ids:         EntityIdsV0::default(),
		}
	}

	#[test]
	fn emit_assigns_stream_seq_and_passes_a2_validation() {
		let sink = FrameSink::new(KernelFrameStream::new());
		let frame = sink
			.emit(minimal_fields("frame_00000000000000000001"))
			.expect("stream is open");
		assert_eq!(frame.stream_seq, 1);
		assert!(frame.validate_dto().is_empty());
	}

	#[test]
	fn emit_after_close_fails_without_consuming_a_seq() {
		let stream = KernelFrameStream::new();
		let sink = FrameSink::new(stream.clone());
		sink
			.emit(minimal_fields("frame_00000000000000000001"))
			.expect("stream is open");
		stream.close();
		let rejected = sink.emit(minimal_fields("frame_00000000000000000002"));
		assert_eq!(rejected, Err(StreamClosedError));
	}

	#[test]
	fn emit_with_raw_event_ref_sets_both_paired_fields() {
		let sink = FrameSink::new(KernelFrameStream::new());
		let mut fields = minimal_fields("frame_00000000000000000001");
		fields.raw_event_ref = Some(RawEventRef::new(
			EventId::try_from("evt_test".to_owned()).expect("valid evt_ prefix"),
			7,
		));
		let frame = sink.emit(fields).expect("stream is open");
		assert_eq!(frame.raw_event_id.as_ref().map(EventId::as_str), Some("evt_test"));
		assert_eq!(frame.raw_event_session_seq, Some(7));
		assert!(frame.validate_dto().is_empty());
	}
}
