//! The `RawEventAppendStore` trait: the storage-facing boundary between the
//! platform's HTTP layer (owned elsewhere) and the append/session
//! persistence implementation in `sqlite.rs`.
//!
//! Only protocol DTOs and `PlatformError` cross this boundary. Nothing here
//! may leak `SQLite` row shapes, table names, or driver error types --
//! `sqlite.rs` is responsible for mapping every storage failure into a
//! `PlatformError`-compatible protocol error code before it reaches a
//! caller.
//!
//! Methods return a hand-boxed future (`BoxFuture`) rather than using
//! `async fn` in the trait so that `dyn RawEventAppendStore` stays object
//! safe: callers (B3-B6) are expected to hold this behind `Arc<dyn
//! RawEventAppendStore>` as shared axum state, which native `async fn`-in-
//! trait does not support without an extra dependency.

use std::{future::Future, pin::Pin};

use successor_protocol::{
	error::{ProtocolViolation, ProtocolViolationSet},
	ids::{EventId, SessionId},
	platform_api::{
		CreateSessionRequestV0, CreateSessionResponseV0, EventPageV0, RawEventAppendRequestV0,
		RawEventAppendResponseV0,
	},
	raw_event::RawEventV0,
};

use crate::error::{PlatformError, PlatformResult};

/// A future boxed for storage in a trait object, matching the shape
/// `async fn` methods would produce if `RawEventAppendStore` did not need to
/// be `dyn`-compatible.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Platform-internal storage boundary for session creation and raw-event
/// append/read. Implemented by `sqlite::SqliteAppendStore`.
pub trait RawEventAppendStore: Send + Sync {
	/// Creates a new session and returns its platform-assigned identifier
	/// and creation timestamp.
	fn create_session(
		&self,
		request: CreateSessionRequestV0,
	) -> BoxFuture<'_, PlatformResult<CreateSessionResponseV0>>;

	/// Appends one raw event to a session, enforcing idempotency, dense
	/// sequencing, and structural/causation/credential validation inside a
	/// single writer transaction.
	fn append_event(
		&self,
		request: RawEventAppendRequestV0,
	) -> BoxFuture<'_, PlatformResult<RawEventAppendResponseV0>>;

	/// Reads a single raw event by its globally unique event id.
	fn read_event<'a>(
		&'a self,
		event_id: &'a EventId,
	) -> BoxFuture<'a, PlatformResult<Option<RawEventV0>>>;

	/// Reads a page of a session's raw events in ascending `session_seq`
	/// order, starting strictly after `after_seq`.
	fn read_session_events<'a>(
		&'a self,
		session_id: &'a SessionId,
		after_seq: u64,
		limit: u32,
	) -> BoxFuture<'a, PlatformResult<EventPageV0>>;
}

/// Maps a protocol validation failure into a `PlatformError`, preserving the
/// first violation's code and message. `validate_raw_event_stream` and
/// `RawEventV0::validate_structure` are the accepted A1/A5 validators this
/// store reuses rather than reimplementing; this function is purely the
/// translation from their `ProtocolViolation(Set)` error type to the
/// platform crate's own error type.
pub(crate) fn violation_set_to_platform_error(set: ProtocolViolationSet) -> PlatformError {
	set.violations().first().map_or_else(
		|| {
			PlatformError::new(
				successor_protocol::error::ProtocolViolationCode::ValidationFailed,
				"validation failed with no violation detail",
			)
		},
		|violation| PlatformError::new(violation.code, violation.message.clone()),
	)
}

/// Maps a single protocol violation into a `PlatformError`.
pub(crate) fn violation_to_platform_error(violation: ProtocolViolation) -> PlatformError {
	PlatformError::new(violation.code, violation.message)
}
