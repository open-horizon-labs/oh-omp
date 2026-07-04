//! Live kernel frame stream primitive (Lane C2 `KernelFrameStream`).
//!
//! [`KernelFrameStream`] is the live-view-only delivery primitive backing a
//! single kernel request stream. It assigns dense, kernel-owned
//! `stream_seq` values and fans already-built frames out to zero or more
//! subscribers via [`tokio::sync::broadcast`], with deterministic close
//! semantics.
//!
//! This is **not** a durable or replayable log: there are no redelivery
//! guarantees, no invented backpressure, and dropping a subscriber never
//! affects the producer side. Persisted truth is
//! [`successor_protocol::raw_event::RawEventV0`]; this module only ever
//! holds already-built [`KernelFrameV0`] values in transit to live viewers.
//! See `frame_sink.rs` for the write-side API that builds those frames.

use std::sync::{Arc, Mutex};

use successor_protocol::kernel_frame::KernelFrameV0;
use thiserror::Error;
use tokio::sync::broadcast;

/// Capacity of the underlying broadcast channel.
///
/// Chosen generously relative to Slice 0 turn sizes (the canonical fixture
/// carries 10 frames for one full turn) so an ordinary subscriber never
/// lags. A subscriber that falls more than this many frames behind observes
/// [`broadcast::error::RecvError::Lagged`] on its next receive, per
/// `tokio::sync::broadcast` semantics -- Slice 0 makes no stronger
/// redelivery promise than that.
const STREAM_CHANNEL_CAPACITY: usize = 256;

/// Error returned when publishing to a [`KernelFrameStream`] after it has
/// been closed.
///
/// Closing is deterministic and terminal for producers: once observed, a
/// caller must not retry `publish_with` on the same stream.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
#[error("kernel frame stream is closed")]
pub struct StreamClosedError;

/// Shared, lock-protected state for one live stream.
///
/// `next_seq` and `closed` are updated together under one lock so that
/// sequence assignment and the closed check are atomic with respect to each
/// other: a publish either consumes exactly one `stream_seq` or is rejected
/// with [`StreamClosedError`] and consumes none (no gaps from rejected
/// publishes).
struct StreamState {
	next_seq: u64,
	closed:   bool,
}

/// A live, per-request kernel frame stream.
///
/// Cloning a `KernelFrameStream` yields another handle to the same
/// underlying stream (shared sequence counter, shared broadcast channel) --
/// it does not create an independent stream. Construct one
/// [`KernelFrameStream::new`] per live request stream; independent request
/// streams get independent dense `stream_seq` sequences because each has
/// its own `KernelFrameStream` instance and thus its own counter.
pub struct KernelFrameStream {
	state:  Arc<Mutex<StreamState>>,
	sender: broadcast::Sender<KernelFrameV0>,
}

impl Clone for KernelFrameStream {
	fn clone(&self) -> Self {
		Self { state: Arc::clone(&self.state), sender: self.sender.clone() }
	}
}

// Manual `Debug` impl: `tokio::sync::broadcast::Sender<T>` does not implement
// `Debug` unconditionally, so a derive here would leak that dependency onto
// every caller of `KernelFrameStream`. The rendered form only exposes the
// stream's own state, which is what a maintainer actually wants to see.
impl std::fmt::Debug for KernelFrameStream {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let state = self
			.state
			.lock()
			.expect("kernel frame stream mutex is not poisoned");
		f.debug_struct("KernelFrameStream")
			.field("next_seq", &state.next_seq)
			.field("closed", &state.closed)
			.finish()
	}
}
impl KernelFrameStream {
	/// Create a new, open live stream with dense `stream_seq` starting at 1.
	pub fn new() -> Self {
		let (sender, _initial_receiver) = broadcast::channel(STREAM_CHANNEL_CAPACITY);
		Self { state: Arc::new(Mutex::new(StreamState { next_seq: 1, closed: false })), sender }
	}

	/// Subscribe to live frames published on this stream from this point
	/// forward.
	///
	/// Dropping the returned receiver never affects the producer: later
	/// [`Self::publish_with`] calls succeed exactly as if the subscriber had
	/// never been created. A publish with zero live subscribers is simply
	/// not observed by anyone -- that is an ordinary live-view outcome, not
	/// a producer-side failure.
	pub fn subscribe(&self) -> broadcast::Receiver<KernelFrameV0> {
		self.sender.subscribe()
	}

	/// Assign the next dense `stream_seq` and publish a frame built from it.
	///
	/// `build` is invoked with the assigned `stream_seq` while the state
	/// lock is held, so sequence assignment, the closed check, and frame
	/// construction happen atomically: either exactly one `stream_seq` is
	/// consumed and the resulting frame is published, or the stream was
	/// already closed, [`StreamClosedError`] is returned, and no
	/// `stream_seq` is consumed. This is the property that keeps dense
	/// `stream_seq` free of gaps under concurrent producers sharing one
	/// stream.
	pub(crate) fn publish_with(
		&self,
		build: impl FnOnce(u64) -> KernelFrameV0,
	) -> Result<KernelFrameV0, StreamClosedError> {
		let seq = {
			let mut state = self
				.state
				.lock()
				.expect("kernel frame stream mutex is not poisoned");
			if state.closed {
				return Err(StreamClosedError);
			}
			let seq = state.next_seq;
			state.next_seq += 1;
			seq
		};
		let frame = build(seq);
		// `send` errors only when there are currently no subscribers, which is
		// an ordinary live-view outcome (nobody watching right now), not a
		// producer-side failure. Ruling 5 forbids inventing backpressure or
		// redelivery, so a frame with no subscribers is simply not observed.
		let _ = self.sender.send(frame.clone());
		Ok(frame)
	}

	/// Close the stream: all subsequent [`Self::publish_with`] calls fail
	/// with [`StreamClosedError`] and consume no further `stream_seq`.
	/// Idempotent.
	///
	/// This does not drop the broadcast sender; existing subscribers keep
	/// receiving any frames already in flight to them, and only observe
	/// `Err(RecvError::Closed)` once every `KernelFrameStream` handle
	/// (including any live [`crate::frame_sink::FrameSink`]) is dropped, per
	/// standard `tokio::sync::broadcast` semantics.
	pub fn close(&self) {
		let mut state = self
			.state
			.lock()
			.expect("kernel frame stream mutex is not poisoned");
		state.closed = true;
	}

	/// `true` once [`Self::close`] has been called on any handle to this
	/// stream.
	pub fn is_closed(&self) -> bool {
		self
			.state
			.lock()
			.expect("kernel frame stream mutex is not poisoned")
			.closed
	}
}

impl Default for KernelFrameStream {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
mod tests {
	use successor_protocol::{
		ids::{FrameId, RequestId, SessionId, TurnId},
		kernel_frame::{KernelFrameKindV0, KernelFrameV0},
	};

	use super::*;

	fn build_frame(stream_seq: u64) -> KernelFrameV0 {
		KernelFrameV0::new(
			FrameId::try_from(format!("frame_{stream_seq:020}")).expect("valid frame_ prefix"),
			stream_seq,
			SessionId::try_from("ses_test".to_owned()).expect("valid ses_ prefix"),
			TurnId::try_from("turn_test".to_owned()).expect("valid turn_ prefix"),
			RequestId::try_from("req_test".to_owned()).expect("valid req_ prefix"),
			KernelFrameKindV0::TurnStarted,
			"2026-06-23T12:00:00Z",
			serde_json::json!({}),
		)
	}

	#[test]
	fn publish_with_assigns_dense_seq_starting_at_one() {
		let stream = KernelFrameStream::new();
		let first = stream.publish_with(build_frame).expect("stream is open");
		let second = stream.publish_with(build_frame).expect("stream is open");
		assert_eq!(first.stream_seq, 1);
		assert_eq!(second.stream_seq, 2);
	}

	#[test]
	fn close_rejects_further_publishes_without_consuming_a_seq() {
		let stream = KernelFrameStream::new();
		let first = stream.publish_with(build_frame).expect("stream is open");
		assert_eq!(first.stream_seq, 1);

		stream.close();
		assert!(stream.is_closed());

		let rejected = stream.publish_with(build_frame);
		assert_eq!(rejected, Err(StreamClosedError));

		// Closing again is idempotent and does not panic.
		stream.close();
		assert!(stream.is_closed());
	}

	#[test]
	fn dropping_subscriber_does_not_affect_producer() {
		let stream = KernelFrameStream::new();
		let receiver = stream.subscribe();
		drop(receiver);

		// Publishing with no live subscribers must neither panic nor error.
		let frame = stream
			.publish_with(build_frame)
			.expect("producer unaffected by subscriber drop");
		assert_eq!(frame.stream_seq, 1);
	}

	#[tokio::test]
	async fn subscriber_receives_published_frames_in_order() {
		let stream = KernelFrameStream::new();
		let mut receiver = stream.subscribe();

		stream.publish_with(build_frame).expect("stream is open");
		stream.publish_with(build_frame).expect("stream is open");

		let first = receiver.recv().await.expect("first frame delivered");
		let second = receiver.recv().await.expect("second frame delivered");
		assert_eq!(first.stream_seq, 1);
		assert_eq!(second.stream_seq, 2);
	}
}
