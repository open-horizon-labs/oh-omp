//! Minimal, on-demand derived trace index: maps `assemble_id` values to the
//! raw events that reference them via `entity_ids.assemble_id`.
//!
//! This is a raw-event-level index only, computed fresh from an
//! already-loaded event slice -- no persistence. It complements, but does
//! not duplicate, accepted A4's `AssemblyProjectionV0` (which projects only
//! the `assembly.completed` event's context items per phase, via
//! `successor_protocol::projection::SessionProjectionV0::assemblies`).
//! `trace_index` surfaces every raw event tagged with a given `assemble_id`
//! -- in the canonical successful-turn fixture that is `assembly.requested`,
//! `assembly.completed`, and the `provider_request.built` event issued
//! during that assembly -- so callers that need the full assembly trace
//! (not just its accepted projection) can walk it directly.

use std::collections::HashMap;

use successor_protocol::{
	ids::{AssembleId, EventId, SessionId},
	raw_event::{RawEventType, RawEventV0},
};

use crate::{
	error::PlatformResult, replay::read_ordered_session_events, store::RawEventAppendStore,
};

/// One raw event associated with an assembly, in session order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceIndexEntryV0 {
	pub event_id:    EventId,
	pub session_seq: u64,
	pub event_type:  RawEventType,
}

/// `assemble_id -> ordered related raw events`, derived on demand from an
/// already-loaded raw-event slice.
///
/// Callers that already hold a session's ordered events (for example from
/// `replay::read_ordered_session_events`) should call this directly rather
/// than re-walking the store; see [`build_session_trace_index`] for the
/// standalone, store-walking convenience entry point.
#[must_use]
pub fn build_trace_index(events: &[RawEventV0]) -> HashMap<AssembleId, Vec<TraceIndexEntryV0>> {
	let mut index: HashMap<AssembleId, Vec<TraceIndexEntryV0>> = HashMap::new();
	for event in events {
		if let Some(assemble_id) = event.entity_ids.assemble_id.clone() {
			index
				.entry(assemble_id)
				.or_default()
				.push(TraceIndexEntryV0 {
					event_id:    event.event_id.clone(),
					session_seq: event.session_seq,
					event_type:  event.event_type.clone(),
				});
		}
	}
	index
}

/// Builds the assembly trace index for `session_id` in one event-page walk.
///
/// For callers that only need the trace index and not the full A4
/// projection/snapshot, this avoids computing `project_session`.
pub async fn build_session_trace_index(
	store: &dyn RawEventAppendStore,
	session_id: &SessionId,
) -> PlatformResult<HashMap<AssembleId, Vec<TraceIndexEntryV0>>> {
	let events = read_ordered_session_events(store, session_id).await?;
	Ok(build_trace_index(&events))
}
