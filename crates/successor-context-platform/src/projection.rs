//! Maps the accepted A4 `SessionProjectionV0` (deterministic replay output)
//! into the platform-facing `SessionSnapshotV0` DTO.
//!
//! This module owns no projection *matching* logic -- transcript, tool, and
//! artifact interpretation all live in accepted A4
//! (`successor_protocol::replay::project_session` /
//! `successor_protocol::projection::SessionProjectionV0`). This is purely a
//! shape adapter from the accepted projection (plus the raw-event stream it
//! was computed from) to the platform DTO exposed over HTTP.
//!
//! Coverage note: this is exercised end-to-end (not via hand-built
//! fixtures here) by `crate::replay`'s snapshot path and by
//! `tests/slice0_replay.rs`, which assert the mapped output against the
//! canonical `session-snapshot.json` fixture field-by-field. Duplicating
//! that coverage with hand-constructed `RawEventV0`/`SessionProjectionV0`
//! values here would test the same mapping contract twice.

use successor_protocol::{
	ids::{ArtifactId, EventId, SessionId, SourceEnvelopeId},
	platform_api::{SessionSnapshotV0, SharingV0},
	projection::SessionProjectionV0,
	raw_event::RawEventV0,
};

/// Maps ordered raw events plus the accepted A4 projection into the
/// platform `SessionSnapshotV0` DTO.
///
/// `created_at`, `updated_at`, `raw_event_ids`, `source_envelope_ids`, and
/// `artifact_ids` are derived from the raw stream itself -- the accepted
/// projection carries none of these at the session level. `last_raw_event_seq`,
/// `last_turn_id`, and `last_assistant_summary` come from the projection's
/// `session` summary, which A4 guarantees non-empty for any successfully
/// accepted projection.
///
/// `events` and `projection` must come from the same replay call (the same
/// raw-event slice fed to `project_session`); this function performs no
/// independent store access.
pub fn map_session_snapshot(
	session_id: &SessionId,
	events: &[RawEventV0],
	projection: &SessionProjectionV0,
) -> SessionSnapshotV0 {
	let created_at = events
		.first()
		.map_or_else(String::new, |event| event.occurred_at.clone());
	let updated_at = events
		.last()
		.map_or_else(String::new, |event| event.occurred_at.clone());

	let raw_event_ids: Vec<EventId> = events.iter().map(|event| event.event_id.clone()).collect();

	let mut source_envelope_ids: Vec<SourceEnvelopeId> = Vec::new();
	let mut artifact_ids: Vec<ArtifactId> = Vec::new();
	for event in events {
		if let Some(id) = event.entity_ids.source_envelope_id.clone() {
			source_envelope_ids.push(id);
		}
		if let Some(id) = event.entity_ids.artifact_id.clone() {
			artifact_ids.push(id);
		}
	}

	let assemble_ids = projection
		.assemblies
		.iter()
		.map(|assembly| assembly.assemble_id.clone())
		.collect();

	let mut snapshot = SessionSnapshotV0::new(
		session_id.clone(),
		created_at,
		updated_at,
		projection.session.last_raw_event_seq,
		projection.session.last_turn_id.clone(),
		SharingV0::private(),
	);
	snapshot.raw_event_ids = raw_event_ids;
	snapshot.source_envelope_ids = source_envelope_ids;
	snapshot.artifact_ids = artifact_ids;
	snapshot.assemble_ids = assemble_ids;
	snapshot.last_assistant_summary = Some(projection.session.last_assistant_summary.clone());
	snapshot
}
