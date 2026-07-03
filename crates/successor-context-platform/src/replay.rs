//! Platform replay adapter: derives session snapshots and the accepted A4
//! session projection from B2's raw-event store, with B3 artifact-backed
//! integrity checks.
//!
//! Always-replay, on-demand derivation only: nothing here is persisted.
//! Every call walks a session's raw events exactly once via
//! `RawEventAppendStore::read_session_events` and reuses that single walk
//! for the A4 projection input and the `SessionSnapshotV0` mapping (see
//! `crate::projection`). This module contains no projection *matching*
//! logic of its own: ordered raw events are handed unchanged to accepted A4
//! `successor_protocol::replay::project_session`.

use successor_protocol::{
	ids::SessionId, platform_api::SessionSnapshotV0, projection::SessionProjectionV0,
	raw_event::RawEventV0, replay::project_session,
};

use crate::{
	artifacts::SqliteArtifactStore,
	error::PlatformResult,
	projection::map_session_snapshot,
	store::{RawEventAppendStore, violation_to_platform_error},
};

/// Page size used when walking a session's raw events for replay.
const REPLAY_PAGE_SIZE: u32 = 200;

/// Reads a session's raw events once, in ascending `session_seq` order, via
/// B2's [`RawEventAppendStore`].
///
/// This is the single event-page walk backing every replay-derived view in
/// this module (A4 projection input, snapshot index fields). Callers must
/// not walk `read_session_events` a second time for the same replay
/// operation -- an unknown session surfaces the store's typed `NotFound`
/// error here, not a panic.
pub async fn read_ordered_session_events(
	store: &dyn RawEventAppendStore,
	session_id: &SessionId,
) -> PlatformResult<Vec<RawEventV0>> {
	let mut events = Vec::new();
	let mut after_seq = 0u64;
	loop {
		let page = store
			.read_session_events(session_id, after_seq, REPLAY_PAGE_SIZE)
			.await?;
		after_seq = page.next_after_seq;
		let has_more = page.has_more;
		events.extend(page.events);
		if !has_more {
			break;
		}
	}
	Ok(events)
}

/// Replays a session's raw events into the accepted A4
/// [`SessionProjectionV0`].
///
/// Reuse seam: this function contains no projection matching logic. It
/// loads ordered raw events via B2's store and hands them, unchanged, to
/// accepted A4 `project_session`. An empty event stream (session created,
/// no events appended) surfaces A4's typed `ReplayMismatch` error rather
/// than a panic. Streams accepted A4 rejects outright -- for example the
/// unsupported-tool fixture's `error.recorded` event -- also surface as a
/// typed `ReplayMismatch` `PlatformError`; see
/// `crates/successor-context-platform/tests/slice0_replay.rs` for the
/// routed-reopen note on that narrow gap.
pub async fn replay_session_projection(
	store: &dyn RawEventAppendStore,
	session_id: &SessionId,
) -> PlatformResult<SessionProjectionV0> {
	let events = read_ordered_session_events(store, session_id).await?;
	project_session(&events).map_err(violation_to_platform_error)
}

/// Replays a session into the platform [`SessionSnapshotV0`] DTO.
///
/// Every artifact the accepted projection references is verified present
/// and content-valid in B3's [`SqliteArtifactStore`] via `require_artifact`;
/// a missing or corrupted artifact surfaces B3's typed `PlatformError`
/// (`NotFound` / `ValidationFailed`) rather than a panic or a silently
/// incomplete snapshot.
pub async fn replay_session_snapshot(
	store: &dyn RawEventAppendStore,
	artifacts: &SqliteArtifactStore,
	session_id: &SessionId,
) -> PlatformResult<SessionSnapshotV0> {
	let events = read_ordered_session_events(store, session_id).await?;
	let projection = project_session(&events).map_err(violation_to_platform_error)?;

	for artifact in &projection.artifacts {
		artifacts.require_artifact(&artifact.artifact_id).await?;
	}

	Ok(map_session_snapshot(session_id, &events, &projection))
}
