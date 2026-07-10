//! B3-owned source/artifact provenance indexes: read-only projections
//! derived from `store::RawEventAppendStore::read_session_events` /
//! `read_event`.
//!
//! These indexes are computed on demand from the raw-event stream, using
//! only B2's `RawEventAppendStore` trait boundary. There is no new
//! persisted storage here and no parallel raw-event pager: a session's
//! `source_envelope_id` / `artifact_id` associations are always exactly
//! what `entity_ids` on its persisted raw events already say. This module
//! never scrapes `raw_events`/`sessions` `SQLite` tables directly.

use std::collections::HashMap;

use serde_json::Value;
use successor_protocol::{
	ids::{ArtifactId, EventId, SessionId, SourceEnvelopeId, ToolCallId},
	raw_event::RawEventType,
};

use crate::{error::PlatformResult, store::RawEventAppendStore};

/// Page size used when walking a session's raw events to build an index.
/// Slice 0 has no volume requirement large enough to need tuning; chosen to
/// keep the walk to a handful of round trips for realistic session sizes.
const INDEX_PAGE_SIZE: u32 = 200;

/// One `source_envelope_id -> producing event` association.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIndexEntryV0 {
	pub source_envelope_id: SourceEnvelopeId,
	pub event_id:           EventId,
	pub session_seq:        u64,
}

/// Internal read-tool metadata carried from raw event payloads for
/// deterministic optional-source freshness. This is not persisted separately
/// and is not exposed on any protocol DTO.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadToolMetadataV0 {
	pub path:   String,
	pub offset: Option<u64>,
	pub limit:  Option<u64>,
}

/// One `artifact_id -> producing event` association, with the source
/// envelope that carried it, when the producing event also recorded one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactIndexEntryV0 {
	pub artifact_id:        ArtifactId,
	pub event_id:           EventId,
	pub session_seq:        u64,
	pub source_envelope_id: Option<SourceEnvelopeId>,
	pub read_metadata:      Option<ReadToolMetadataV0>,
}

/// Both provenance indexes for one session, derived in a single walk of its
/// raw-event stream.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionIndexesV0 {
	pub sources:   Vec<SourceIndexEntryV0>,
	pub artifacts: Vec<ArtifactIndexEntryV0>,
}

/// Walks `session_id`'s full raw-event stream via
/// `store.read_session_events` and derives the source-envelope and artifact
/// provenance indexes from each event's `entity_ids`.
pub async fn build_session_indexes(
	store: &dyn RawEventAppendStore,
	session_id: &SessionId,
) -> PlatformResult<SessionIndexesV0> {
	let mut indexes = SessionIndexesV0::default();
	let mut read_requests = HashMap::<ToolCallId, ReadToolMetadataV0>::new();
	let mut after_seq = 0u64;
	loop {
		let page = store
			.read_session_events(session_id, after_seq, INDEX_PAGE_SIZE)
			.await?;
		for event in &page.events {
			if event.event_type == RawEventType::ToolCallRequested
				&& let Some(tool_call_id) = event.entity_ids.tool_call_id.clone()
				&& let Some(metadata) = read_tool_request_metadata(&event.payload)
			{
				read_requests.entry(tool_call_id).or_insert(metadata);
			}
			if let Some(source_envelope_id) = event.entity_ids.source_envelope_id.clone() {
				indexes.sources.push(SourceIndexEntryV0 {
					source_envelope_id,
					event_id: event.event_id.clone(),
					session_seq: event.session_seq,
				});
			}
			if let Some(artifact_id) = event.entity_ids.artifact_id.clone() {
				indexes.artifacts.push(ArtifactIndexEntryV0 {
					artifact_id,
					event_id: event.event_id.clone(),
					session_seq: event.session_seq,
					source_envelope_id: event.entity_ids.source_envelope_id.clone(),
					read_metadata: event
						.entity_ids
						.tool_call_id
						.as_ref()
						.and_then(|tool_call_id| read_requests.get(tool_call_id).cloned())
						.or_else(|| read_tool_result_metadata(&event.payload)),
				});
			}
		}
		after_seq = page.next_after_seq;
		if !page.has_more {
			break;
		}
	}
	Ok(indexes)
}

fn read_tool_request_metadata(payload: &Value) -> Option<ReadToolMetadataV0> {
	if payload.get("tool_name").and_then(Value::as_str) != Some("read") {
		return None;
	}
	let arguments = payload.get("arguments")?;
	Some(ReadToolMetadataV0 {
		path:   arguments.get("path")?.as_str()?.to_owned(),
		offset: arguments.get("offset").and_then(Value::as_u64),
		limit:  arguments.get("limit").and_then(Value::as_u64),
	})
}

fn read_tool_result_metadata(payload: &Value) -> Option<ReadToolMetadataV0> {
	if payload.get("tool_name").and_then(Value::as_str) != Some("read") {
		return None;
	}
	Some(ReadToolMetadataV0 {
		path:   payload.get("path")?.as_str()?.to_owned(),
		offset: None,
		limit:  None,
	})
}

/// Finds the raw event that produced `artifact_id` within `session_id`.
///
/// A convenience wrapper over `build_session_indexes` for the common
/// single-lookup case; Slice 0 has no requirement to avoid the full walk
/// per lookup.
pub async fn find_artifact_provenance(
	store: &dyn RawEventAppendStore,
	session_id: &SessionId,
	artifact_id: &ArtifactId,
) -> PlatformResult<Option<ArtifactIndexEntryV0>> {
	let indexes = build_session_indexes(store, session_id).await?;
	Ok(indexes
		.artifacts
		.into_iter()
		.find(|entry| &entry.artifact_id == artifact_id))
}

/// Finds the raw event that produced `source_envelope_id` within
/// `session_id`, if any.
pub async fn find_source_provenance(
	store: &dyn RawEventAppendStore,
	session_id: &SessionId,
	source_envelope_id: &SourceEnvelopeId,
) -> PlatformResult<Option<SourceIndexEntryV0>> {
	let indexes = build_session_indexes(store, session_id).await?;
	Ok(indexes
		.sources
		.into_iter()
		.find(|entry| &entry.source_envelope_id == source_envelope_id))
}

#[cfg(test)]
mod tests {
	use successor_protocol::{
		ids::{ArtifactId, SourceEnvelopeId},
		platform_api::{CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0},
	};

	use super::*;
	use crate::sqlite::SqliteAppendStore;

	const SUCCESSFUL_TURN_FIXTURE: &str = include_str!(
		"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
		 raw-events-successful-turn.json"
	);

	async fn seed_successful_turn(append_store: &SqliteAppendStore) -> SessionId {
		seed_successful_turn_with_duplicate_read_request(append_store, false).await
	}

	async fn seed_successful_turn_with_duplicate_read_request(
		append_store: &SqliteAppendStore,
		duplicate_read_request: bool,
	) -> SessionId {
		let session = append_store
			.create_session(CreateSessionRequestV0 {
				workspace:  WorkspaceV0 {
					id:        "workspace_b3_idx".to_owned(),
					label:     "b3-index-tests".to_owned(),
					root_hint: "/tmp/b3-index-tests".to_owned(),
				},
				title:      "B3 source index tests".to_owned(),
				created_by: CreatedByV0 {
					client_kind: "test".to_owned(),
					client_id:   "b3".to_owned(),
				},
			})
			.await
			.expect("create_session must succeed");

		let mut events: Vec<serde_json::Value> =
			serde_json::from_str(SUCCESSFUL_TURN_FIXTURE).expect("fixture must parse as JSON array");
		for event in &mut events {
			if let serde_json::Value::Object(map) = event {
				map.remove("session_seq");
				map.insert(
					"session_id".to_owned(),
					serde_json::Value::String(session.session_id.as_str().to_owned()),
				);
			}
		}

		for event in events {
			let mut request: RawEventAppendRequestV0 = serde_json::from_value(event).expect(
				"fixture event must deserialize as an append request once session_seq is stripped",
			);
			let duplicate = if duplicate_read_request
				&& request.event_type == RawEventType::ToolCallRequested
				&& request.payload.get("tool_name").and_then(Value::as_str) == Some("read")
			{
				request.payload["arguments"]["offset"] = serde_json::json!(10);
				request.payload["arguments"]["limit"] = serde_json::json!(20);
				let mut duplicate = request.clone();
				duplicate.event_id =
					EventId::try_from("evt_00000000-0000-4000-8000-999999999998".to_owned()).unwrap();
				duplicate.idempotency_key = "fixture:tool-requested:read:duplicate".to_owned();
				duplicate.payload["arguments"]["offset"] = serde_json::json!(999);
				duplicate.payload["arguments"]["limit"] = serde_json::json!(1);
				Some(duplicate)
			} else {
				None
			};
			append_store
				.append_event(request)
				.await
				.expect("fixture append must succeed");
			if let Some(duplicate) = duplicate {
				append_store
					.append_event(duplicate)
					.await
					.expect("duplicate read request append must succeed");
			}
		}

		session.session_id
	}

	#[tokio::test]
	async fn source_index_over_canonical_stream_yields_expected_associations() {
		let append_store = SqliteAppendStore::connect_in_memory().await.unwrap();
		let session_id = seed_successful_turn(&append_store).await;

		let indexes = build_session_indexes(&append_store, &session_id)
			.await
			.unwrap();

		// The canonical successful-turn fixture carries four distinct
		// source_envelope_id values (src_...0001..0004), each on exactly one
		// event, and two artifact_id values (art_...0001..0002).
		assert_eq!(indexes.sources.len(), 4, "expected exactly four source-envelope associations");
		assert_eq!(indexes.artifacts.len(), 2, "expected exactly two artifact associations");

		let expected_sources: Vec<String> = (1..=4)
			.map(|n| format!("src_00000000-0000-4000-8000-{n:012}"))
			.collect();
		let mut actual_sources: Vec<String> = indexes
			.sources
			.iter()
			.map(|entry| entry.source_envelope_id.as_str().to_owned())
			.collect();
		actual_sources.sort();
		let mut expected_sources_sorted = expected_sources;
		expected_sources_sorted.sort();
		assert_eq!(actual_sources, expected_sources_sorted);

		let expected_artifacts: Vec<String> = (1..=2)
			.map(|n| format!("art_00000000-0000-4000-8000-{n:012}"))
			.collect();
		let mut actual_artifacts: Vec<String> = indexes
			.artifacts
			.iter()
			.map(|entry| entry.artifact_id.as_str().to_owned())
			.collect();
		actual_artifacts.sort();
		assert_eq!(actual_artifacts, expected_artifacts);

		// Every artifact-bearing event must also carry the source envelope it
		// was produced under.
		for entry in &indexes.artifacts {
			assert!(
				entry.source_envelope_id.is_some(),
				"artifact {} must be linked to a source envelope",
				entry.artifact_id
			);
		}
	}

	#[tokio::test]
	async fn duplicate_read_request_keeps_first_persisted_range_metadata() {
		let append_store = SqliteAppendStore::connect_in_memory().await.unwrap();
		let session_id = seed_successful_turn_with_duplicate_read_request(&append_store, true).await;
		let indexes = build_session_indexes(&append_store, &session_id)
			.await
			.unwrap();
		let read_artifact = indexes
			.artifacts
			.iter()
			.find(|entry| entry.artifact_id.as_str() == "art_00000000-0000-4000-8000-000000000002")
			.expect("canonical read artifact is indexed");
		assert_eq!(
			read_artifact.read_metadata,
			Some(ReadToolMetadataV0 {
				path:   "packages/coding-agent/src/context/concept-graph.ts".to_owned(),
				offset: Some(10),
				limit:  Some(20),
			}),
			"later duplicate request metadata must not overwrite the first persisted request"
		);
	}

	#[tokio::test]
	async fn find_artifact_provenance_locates_the_producing_event() {
		let append_store = SqliteAppendStore::connect_in_memory().await.unwrap();
		let session_id = seed_successful_turn(&append_store).await;

		let indexes = build_session_indexes(&append_store, &session_id)
			.await
			.unwrap();
		let expected = indexes
			.artifacts
			.first()
			.expect("fixture has at least one artifact")
			.clone();

		let found = find_artifact_provenance(&append_store, &session_id, &expected.artifact_id)
			.await
			.unwrap()
			.expect("provenance must be found for a known artifact_id");
		assert_eq!(found, expected);
	}

	#[tokio::test]
	async fn find_artifact_provenance_returns_none_for_unknown_artifact() {
		let append_store = SqliteAppendStore::connect_in_memory().await.unwrap();
		let session_id = seed_successful_turn(&append_store).await;

		let unknown =
			ArtifactId::try_from("art_00000000-0000-4000-8000-999999999999".to_owned()).unwrap();
		let found = find_artifact_provenance(&append_store, &session_id, &unknown)
			.await
			.unwrap();
		assert_eq!(found, None);
	}

	#[tokio::test]
	async fn find_source_provenance_locates_the_producing_event() {
		let append_store = SqliteAppendStore::connect_in_memory().await.unwrap();
		let session_id = seed_successful_turn(&append_store).await;

		let target =
			SourceEnvelopeId::try_from("src_00000000-0000-4000-8000-000000000002".to_owned()).unwrap();
		let found = find_source_provenance(&append_store, &session_id, &target)
			.await
			.unwrap()
			.expect("provenance must be found for a known source_envelope_id");
		assert_eq!(found.source_envelope_id, target);
	}
}
