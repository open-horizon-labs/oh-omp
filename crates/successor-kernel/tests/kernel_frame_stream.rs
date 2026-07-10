//! Integration tests for Lane C2 `KernelFrameStream`.
//!
//! Covers: reproducing the canonical 11-frame fixture through the producer
//! API field-for-field; dense `stream_seq` under concurrent producers on
//! one stream; independent sequences on separate streams; subscriber-drop
//! safety; and deterministic close semantics. SSE byte-well-formedness and
//! the persisted-fact raw-event-ref pairing invariant are covered by
//! `#[cfg(test)]` unit modules in `sse.rs` and `frame_sink.rs` respectively
//! (white-box access to internal helpers not exposed across the crate
//! boundary).

use std::collections::HashSet;

use successor_kernel::{
	frame_sink::{FrameFields, FrameSink, RawEventRef},
	stream::{KernelFrameStream, StreamClosedError},
};
use successor_protocol::{fixtures, kernel_frame::KernelFrameV0};

fn fields_from_fixture(expected: &KernelFrameV0) -> FrameFields {
	let raw_event_ref = match (&expected.raw_event_id, expected.raw_event_session_seq) {
		(Some(event_id), Some(session_seq)) => Some(RawEventRef::new(event_id.clone(), session_seq)),
		(None, None) => None,
		other => panic!("fixture frame has an unpaired raw event reference: {other:?}"),
	};
	FrameFields {
		frame_id: expected.frame_id.clone(),
		session_id: expected.session_id.clone(),
		turn_id: expected.turn_id.clone(),
		request_id: expected.request_id.clone(),
		kind: expected.kind.clone(),
		ts: expected.ts.clone(),
		payload: expected.payload.clone(),
		raw_event_ref,
		causation_frame_id: expected.causation_frame_id.clone(),
		entity_ids: expected.entity_ids.clone(),
	}
}

/// Reproduces the canonical 11-frame fixture stream through the producer
/// API and asserts field-for-field equality with the fixture.
///
/// Fixture-comparison approach: `frame_id` and `ts` are caller-supplied
/// inputs to [`FrameSink::emit`], not minted by the sink (see
/// `frame_sink.rs` module docs) -- turn-lifecycle identity and timestamps
/// are C7 `KernelTurnRunner` authority, out of C2 scope. Because of that
/// design choice, this test drives `emit` with the fixture's own pinned
/// `frame_id`/`ts` values for every frame, so the only sink-owned field
/// (`stream_seq`) is exercised for real while every other field can be
/// compared exactly rather than excluded from comparison.
#[tokio::test]
async fn producer_reproduces_canonical_fixture_stream_field_for_field() {
	let expected_frames = fixtures::kernel_frame_stream();
	assert_eq!(expected_frames.len(), 11, "canonical fixture is pinned at 11 frames");

	let sink = FrameSink::new(KernelFrameStream::new());
	let mut produced = Vec::with_capacity(expected_frames.len());
	for expected in &expected_frames {
		let frame = sink
			.emit(fields_from_fixture(expected))
			.expect("stream is open");
		assert!(
			frame.validate_dto().is_empty(),
			"every frame produced by FrameSink must pass A2 DTO validation: {:?}",
			frame.validate_dto()
		);
		produced.push(frame);
	}

	assert_eq!(
		produced, expected_frames,
		"producer output must match the canonical fixture field-for-field, including stream_seq \
		 (kernel-assigned, must land on the fixture's dense 1..=11) and frame_id/ts \
		 (caller-supplied fixture values, not minted by the sink)"
	);

	let seqs: Vec<u64> = produced.iter().map(|frame| frame.stream_seq).collect();
	assert_eq!(seqs, (1..=11).collect::<Vec<u64>>(), "fixture stream_seq must be dense 1..=11");
}

fn minimal_fields(frame_id: String) -> FrameFields {
	use successor_protocol::{
		ids::{FrameId, RequestId, SessionId, TurnId},
		kernel_frame::KernelFrameKindV0,
		raw_event::EntityIdsV0,
	};

	FrameFields {
		frame_id:           FrameId::try_from(frame_id).expect("valid frame_ prefix"),
		session_id:         SessionId::try_from("ses_concurrent_test".to_owned())
			.expect("valid ses_ prefix"),
		turn_id:            TurnId::try_from("turn_concurrent_test".to_owned())
			.expect("valid turn_ prefix"),
		request_id:         RequestId::try_from("req_concurrent_test".to_owned())
			.expect("valid req_ prefix"),
		kind:               KernelFrameKindV0::ProviderDelta,
		ts:                 "2026-06-23T12:00:00Z".to_owned(),
		payload:            serde_json::json!({}),
		raw_event_ref:      None,
		causation_frame_id: None,
		entity_ids:         EntityIdsV0::default(),
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn dense_stream_seq_has_no_gaps_or_duplicates_under_concurrent_producers() {
	const PRODUCER_COUNT: u64 = 50;

	let sink = FrameSink::new(KernelFrameStream::new());
	let mut handles = Vec::with_capacity(PRODUCER_COUNT as usize);
	for i in 0..PRODUCER_COUNT {
		let sink = sink.clone();
		handles.push(tokio::spawn(async move {
			sink
				.emit(minimal_fields(format!("frame_concurrent_{i:016}")))
				.expect("stream is open")
				.stream_seq
		}));
	}

	let mut seqs = Vec::with_capacity(PRODUCER_COUNT as usize);
	for handle in handles {
		seqs.push(handle.await.expect("producer task does not panic"));
	}

	let unique: HashSet<u64> = seqs.iter().copied().collect();
	assert_eq!(unique.len(), seqs.len(), "stream_seq values must have no duplicates: {seqs:?}");

	seqs.sort_unstable();
	let expected: Vec<u64> = (1..=PRODUCER_COUNT).collect();
	assert_eq!(
		seqs, expected,
		"stream_seq must be dense (1..=N) with no gaps under concurrent producers"
	);
}

#[tokio::test]
async fn separate_streams_have_independent_dense_sequences() {
	let sink_a = FrameSink::new(KernelFrameStream::new());
	let sink_b = FrameSink::new(KernelFrameStream::new());

	let a1 = sink_a
		.emit(minimal_fields("frame_stream_a_0000000001".to_owned()))
		.expect("stream a open");
	let b1 = sink_b
		.emit(minimal_fields("frame_stream_b_0000000001".to_owned()))
		.expect("stream b open");
	let a2 = sink_a
		.emit(minimal_fields("frame_stream_a_0000000002".to_owned()))
		.expect("stream a open");
	let b2 = sink_b
		.emit(minimal_fields("frame_stream_b_0000000002".to_owned()))
		.expect("stream b open");

	assert_eq!(
		(a1.stream_seq, a2.stream_seq),
		(1, 2),
		"stream a's sequence is independent of stream b"
	);
	assert_eq!(
		(b1.stream_seq, b2.stream_seq),
		(1, 2),
		"stream b's sequence is independent of stream a"
	);
}

#[tokio::test]
async fn subscriber_drop_mid_stream_does_not_panic_or_stall_the_producer() {
	let stream = KernelFrameStream::new();
	let sink = FrameSink::new(stream.clone());

	let subscriber = stream.subscribe();
	sink
		.emit(minimal_fields("frame_before_drop_00000001".to_owned()))
		.expect("stream is open");
	drop(subscriber);

	// The producer must remain fully functional after its only subscriber
	// disappears: no panic, no stall, and stream_seq keeps advancing densely.
	let after_drop = sink
		.emit(minimal_fields("frame_after_drop_000000001".to_owned()))
		.expect("producer unaffected by drop");
	assert_eq!(after_drop.stream_seq, 2);
}

#[tokio::test]
async fn close_is_deterministic_and_post_close_emit_is_a_typed_error_not_a_panic() {
	let stream = KernelFrameStream::new();
	let sink = FrameSink::new(stream.clone());

	let frame = sink
		.emit(minimal_fields("frame_before_close_0000001".to_owned()))
		.expect("stream is open");
	assert_eq!(frame.stream_seq, 1);

	stream.close();
	assert!(stream.is_closed());

	let rejected = sink.emit(minimal_fields("frame_after_close_00000001".to_owned()));
	assert_eq!(rejected, Err(StreamClosedError));

	// Closing again is idempotent; repeated post-close emits keep failing
	// the same typed way rather than panicking.
	stream.close();
	let rejected_again = sink.emit(minimal_fields("frame_after_close_00000002".to_owned()));
	assert_eq!(rejected_again, Err(StreamClosedError));
}
