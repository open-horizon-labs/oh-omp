//! Platform replay adapter: derives session snapshots and the accepted A4
//! session projection from B2's raw-event store, with B3 artifact-backed
//! integrity checks.
//!
//! Always-replay, on-demand derivation only: nothing here is persisted.
//! Every call walks a session's raw events exactly once via
//! `RawEventAppendStore::read_session_events` and reuses that single walk
//! for the A4 projection input and the `SessionSnapshotV0` mapping (see
//! `crate::projection`). This module contains no projection *matching*
//! logic of its own for the successful-turn path: ordered raw events are
//! handed unchanged to accepted A4
//! `successor_protocol::replay::project_session`. The one exception is the
//! failure-aware snapshot rebuild in `replay_session_snapshot` (see its doc
//! comment): A4 rejects an `error.recorded` event outright by design, so a
//! failed turn's snapshot is derived directly from the raw-event stream's index
//! fields instead of being routed through `project_session`.

use successor_protocol::{
	error::ProtocolViolationCode,
	ids::SessionId,
	platform_api::{SessionSnapshotV0, SharingV0},
	projection::SessionProjectionV0,
	raw_event::{RawEventType, RawEventV0},
	replay::project_session,
};

use crate::{
	artifacts::SqliteArtifactStore,
	error::{PlatformError, PlatformResult},
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
/// than a panic, as does any stream A4 rejects outright -- for example the
/// unsupported-tool fixture's `error.recorded` event. Unlike
/// `replay_session_snapshot`, this function has no failure-aware fallback:
/// reconstructing a full A4 transcript/tool-state projection for a failed
/// turn would require reimplementing A4's matching logic, which this lane
/// has no authority to do; see `crates/successor-context-platform/tests/
/// slice0_replay.rs` for the routed-reopen note on that narrow gap.
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
///
/// Failure-aware rebuild: a stream containing at least one `error.recorded`
/// event marks a turn that failed, which accepted A4 `project_session`
/// rejects outright by design (A4 only projects successfully completed
/// turns). Routing such a stream through `project_session` would surface
/// every failed-turn `inspect session` call as an opaque `ReplayMismatch`,
/// even though the session's raw-event index (which events exist, their
/// ids, the last turn touched) is well-formed and answerable without
/// re-running any provider, tool, or filesystem call. For that case this
/// function derives the snapshot's index fields directly from the raw
/// stream in `build_failure_aware_snapshot`, mirroring
/// `crate::projection::map_session_snapshot`'s raw-event-derived fields,
/// instead of calling `project_session`. An empty event stream is
/// unaffected by this branch (it never contains an `error.recorded` event
/// to match): it still routes through `project_session` and surfaces the
/// distinct, unchanged zero-event-session `ReplayMismatch`.
pub async fn replay_session_snapshot(
	store: &dyn RawEventAppendStore,
	artifacts: &SqliteArtifactStore,
	session_id: &SessionId,
) -> PlatformResult<SessionSnapshotV0> {
	let events = read_ordered_session_events(store, session_id).await?;

	if events
		.iter()
		.any(|event| event.event_type == RawEventType::ErrorRecorded)
	{
		return build_failure_aware_snapshot(session_id, &events, artifacts).await;
	}

	let projection = project_session(&events).map_err(violation_to_platform_error)?;

	for artifact in &projection.artifacts {
		artifacts.require_artifact(&artifact.artifact_id).await?;
	}

	Ok(map_session_snapshot(session_id, &events, &projection))
}

/// Builds a `SessionSnapshotV0` directly from a failed-turn raw-event
/// stream (one containing at least one `error.recorded` event), bypassing
/// accepted A4 `project_session` for the reason documented on
/// `replay_session_snapshot`.
///
/// Every field is derived from the already-recorded raw events and
/// verified against B3 artifact metadata; nothing here re-runs a provider,
/// a tool, a filesystem read, or any other side effect.
/// `last_assistant_summary` and `assemble_ids` are left absent/empty when the
/// stream never reached an `assistant_turn.recorded` or `assembly.completed`
/// event, which is expected for a turn that failed before those stages.
/// `events` must be non-empty and already ordered by `session_seq` (the same
/// contract `read_ordered_session_events` provides); callers only reach this
/// function once at least one `error.recorded` event has been observed, so
/// `events` is never empty here.
async fn build_failure_aware_snapshot(
	session_id: &SessionId,
	events: &[RawEventV0],
	artifacts: &SqliteArtifactStore,
) -> PlatformResult<SessionSnapshotV0> {
	let created_at = events
		.first()
		.map_or_else(String::new, |event| event.occurred_at.clone());
	let updated_at = events
		.last()
		.map_or_else(String::new, |event| event.occurred_at.clone());
	let last_raw_event_seq = events.last().map_or(0, |event| event.session_seq);
	let last_turn_id = events
		.iter()
		.rev()
		.find_map(|event| event.turn_id.clone())
		.ok_or_else(|| {
			PlatformError::new(
				ProtocolViolationCode::ReplayMismatch,
				"failed-turn snapshot requires at least one turn-scoped raw event",
			)
		})?;

	let mut raw_event_ids = Vec::with_capacity(events.len());
	let mut source_envelope_ids = Vec::new();
	let mut artifact_ids = Vec::new();
	let mut assemble_ids = Vec::new();
	let mut last_assistant_summary = None;
	for event in events {
		raw_event_ids.push(event.event_id.clone());
		if let Some(id) = event.entity_ids.source_envelope_id.clone() {
			source_envelope_ids.push(id);
		}
		if let Some(id) = event.entity_ids.artifact_id.clone() {
			artifact_ids.push(id);
		}
		if event.event_type == RawEventType::AssemblyCompleted
			&& let Some(id) = event.entity_ids.assemble_id.clone()
		{
			assemble_ids.push(id);
		}
		if event.event_type == RawEventType::AssistantTurnRecorded {
			last_assistant_summary = event
				.payload
				.get("summary")
				.and_then(|value| value.as_str())
				.map(str::to_owned);
		}
	}

	for artifact_id in &artifact_ids {
		artifacts.require_artifact(artifact_id).await?;
	}

	let mut snapshot = SessionSnapshotV0::new(
		session_id.clone(),
		created_at,
		updated_at,
		last_raw_event_seq,
		last_turn_id,
		SharingV0::private(),
	);
	snapshot.raw_event_ids = raw_event_ids;
	snapshot.source_envelope_ids = source_envelope_ids;
	snapshot.artifact_ids = artifact_ids;
	snapshot.assemble_ids = assemble_ids;
	snapshot.last_assistant_summary = last_assistant_summary;
	Ok(snapshot)
}

#[cfg(test)]
mod tests {
	use successor_protocol::platform_api::{
		CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0,
	};

	use super::*;
	use crate::sqlite::SqliteAppendStore;

	/// A unique temporary `SQLite` file path shared by both connections in a
	/// test, mirroring the helper established in
	/// `crates/successor-context-platform/tests/slice0_replay.rs`.
	struct TempDbPath(String);

	impl TempDbPath {
		fn new(label: &str) -> Self {
			let unique = uuid::Uuid::new_v4();
			let path = std::env::temp_dir().join(format!("b4-replay-unit-{label}-{unique}.sqlite3"));
			Self(path.to_string_lossy().into_owned())
		}

		fn as_str(&self) -> &str {
			&self.0
		}
	}

	impl Drop for TempDbPath {
		fn drop(&mut self) {
			for suffix in ["", "-wal", "-shm"] {
				let _ = std::fs::remove_file(format!("{}{suffix}", self.0));
			}
		}
	}

	/// The unsupported-tool fixture stream: `tool_call.requested` /
	/// `tool_call.rejected` / `error.recorded` -- a recorded failed turn.
	/// This is the exact stream `replay_session_projection` still rejects
	/// (unmodified, per the dissent ruling's A4-reopen note); it is now also
	/// the regression fixture for `replay_session_snapshot`'s failure-aware
	/// rebuild.
	const UNSUPPORTED_TOOL_FIXTURE: &str = include_str!(
		"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
		 raw-events-unsupported-tool.json"
	);

	async fn create_session(append_store: &SqliteAppendStore, label: &str) -> SessionId {
		append_store
			.create_session(CreateSessionRequestV0 {
				workspace:  WorkspaceV0 {
					id:        format!("workspace_{label}"),
					label:     format!("replay-unit-{label}"),
					root_hint: format!("/tmp/replay-unit-{label}"),
				},
				title:      format!("replay unit test ({label})"),
				created_by: CreatedByV0 {
					client_kind: "test".to_owned(),
					client_id:   "replay-unit".to_owned(),
				},
			})
			.await
			.expect("create_session must succeed")
			.session_id
	}

	/// Appends a fixture event stream (full `RawEventV0` JSON, `session_seq`
	/// present) into a fresh session, rewriting `session_id` to match and
	/// stripping `session_seq` so the store assigns it densely. Mirrors the
	/// seeding helper established in the integration test module.
	async fn seed_fixture_stream(
		append_store: &SqliteAppendStore,
		label: &str,
		fixture: &str,
	) -> SessionId {
		let session_id = create_session(append_store, label).await;
		let mut events: Vec<serde_json::Value> =
			serde_json::from_str(fixture).expect("fixture must parse as JSON array");
		for event in &mut events {
			if let serde_json::Value::Object(map) = event {
				map.remove("session_seq");
				map.insert(
					"session_id".to_owned(),
					serde_json::Value::String(session_id.as_str().to_owned()),
				);
			}
		}
		for event in events {
			let request: RawEventAppendRequestV0 = serde_json::from_value(event)
				.expect("fixture event must deserialize as an append request");
			append_store
				.append_event(request)
				.await
				.expect("fixture append must succeed");
		}
		session_id
	}

	/// Firing proof for the (c) fix: a failed-turn stream (one containing
	/// `error.recorded`) previously surfaced `replay_session_snapshot` as an
	/// opaque `ReplayMismatch`, identical to `replay_session_projection`'s
	/// (unchanged, still-correct) rejection. The failure-aware rebuild must
	/// now answer with a well-formed snapshot instead.
	#[tokio::test]
	async fn snapshot_of_a_failed_turn_stream_succeeds_via_the_failure_aware_rebuild() {
		let db = TempDbPath::new("failed-turn");
		let append_store = SqliteAppendStore::connect(db.as_str())
			.await
			.expect("connect append store");
		let artifact_store = SqliteArtifactStore::connect(db.as_str())
			.await
			.expect("connect artifact store");

		let session_id =
			seed_fixture_stream(&append_store, "failed-turn", UNSUPPORTED_TOOL_FIXTURE).await;

		let snapshot = replay_session_snapshot(&append_store, &artifact_store, &session_id)
			.await
			.expect(
				"a failed-turn stream (error.recorded) must produce a snapshot via the failure-aware \
				 rebuild, not a replay_mismatch",
			);

		assert_eq!(snapshot.session_id, session_id);
		assert_eq!(snapshot.last_raw_event_seq, 4, "the fixture carries exactly four raw events");
		assert_eq!(snapshot.raw_event_ids.len(), 4);
		assert!(snapshot.source_envelope_ids.is_empty());
		assert!(snapshot.artifact_ids.is_empty());
		assert!(snapshot.assemble_ids.is_empty());
		assert!(
			snapshot.last_assistant_summary.is_none(),
			"a turn that failed before an assistant response has no assistant summary"
		);
	}

	/// Firing proof that the failure-aware branch does not swallow the
	/// distinct zero-event-session residual: an empty stream never contains
	/// an `error.recorded` event, so it must still route through
	/// `project_session` and surface the same typed `ReplayMismatch` as
	/// before this fix.
	#[tokio::test]
	async fn snapshot_of_an_empty_session_stays_the_distinct_typed_replay_mismatch() {
		let db = TempDbPath::new("still-empty");
		let append_store = SqliteAppendStore::connect(db.as_str())
			.await
			.expect("connect append store");
		let artifact_store = SqliteArtifactStore::connect(db.as_str())
			.await
			.expect("connect artifact store");

		let session_id = create_session(&append_store, "still-empty").await;

		let err = replay_session_snapshot(&append_store, &artifact_store, &session_id)
			.await
			.expect_err("an empty session must still be rejected");

		assert_eq!(
			err.envelope().code,
			ProtocolViolationCode::ReplayMismatch.as_str(),
			"the failure-aware rebuild must not change the distinct zero-event-session residual"
		);
	}
}
