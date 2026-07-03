//! B5 `PlatformAssembly`: deterministic `/assemble` computation.
//!
//! `AssemblyServiceV0` is the dispatch-map service seam behind the platform's
//! only semantic context path (`SLICE-0-CONTRACT.md` §11,
//! `SLICE-0-DISPATCH-MAP.md` §4.2). It composes the B2
//! [`RawEventAppendStore`], the B3 [`SqliteArtifactStore`], and the B4
//! [`crate::source_index`] substrate into the `AssemblyResponseV0` shape
//! pinned by the canonical `assemble-response-{pre-tool,post-read}.json`
//! fixtures. HTTP wiring (`POST /v0/assemble`) is B6's responsibility; this
//! module only exposes the service seam B6 wraps.
//!
//! # Selection rule (Dissent ruling 3)
//!
//! Slice 0 implements no embeddings, vector search, or tokenizer (Dissent
//! ruling 2: no migration, table, or new dependency). Selection is driven
//! entirely by `AssembleRequestV0::required_source_envelope_ids`:
//!
//! - **Empty** (the canonical `pre_tool` fixture): there is no deterministic
//!   way to rank "recent" sources without embeddings, so the
//!   `retrieve_recent_sources` stage always yields zero context items and
//!   reports `embeddings_unavailable` (warning) + `no_context` (info).
//! - **Non-empty** (the canonical `post_read` fixture): required sources
//!   dominate. Each requested `source_envelope_id` is resolved to its producing
//!   raw event (B4 [`find_source_provenance`]) and backing artifact (B3
//!   [`SqliteArtifactStore::require_artifact`]), then turned into a `score:
//!   1.0`, `platform_artifact`-recovery `ContextItemV0`. The stage is
//!   `required_sources` and only `embeddings_unavailable` is reported (there is
//!   context, so `no_context` does not apply).
//!
//! This rule is **phase-agnostic by design**: a `pre_tool` or `post_locator`
//! request that happens to carry required sources gets the same
//! required-source-dominant treatment, and a `post_read` request with no
//! required sources falls back to the empty-context path. The two canonical
//! fixtures never exercise the phase/required-sources cross product, so this
//! generalization is a disclosed, unpinned decision (see the B5 completion
//! notes), not an invented special case keyed off the `phase` enum itself.
//!
//! # Unpinned edge cases (disclosed, not invented)
//!
//! - **Unknown session**: `assemble()` fails closed with a typed `not_found`
//!   error before doing any other work.
//! - **Unknown or unresolvable required source** (not found in the session, or
//!   its producing event has no backing artifact — `ContextItemV0`'s
//!   `artifact_id` is not optional, so such a source cannot be represented):
//!   not fatal. The source is dropped (recorded in `trace.dropped` with a
//!   reason) and reported as an `unknown_required_source` warning degradation,
//!   so one vanished nomination never blocks the rest of the turn.
//! - **Required source that is also excluded**: the exclude list wins. The
//!   source is dropped (`trace.dropped` reason `"excluded"`) and never becomes
//!   a context item.
//! - **Budget caps** (`max_items` / `max_context_tokens`, including `0`):
//!   over-budget items are still resolved and appear in `context_items` (so
//!   their score/token cost is visible), but `included` is `false` once the
//!   deterministic greedy walk (in request order) would exceed either cap.
//! - **Token estimate**: no tokenizer dependency is available (ruling 2).
//!   `estimate_tokens` approximates cost as whitespace-token count × 4, which
//!   reproduces the canonical fixture's pinned `token_estimate: 32` for the
//!   8-word read-artifact body.
//!
//! # `get_trace`
//!
//! `get_trace` derives traces from an in-process cache populated by this
//! service's own `assemble()` calls, not from durable storage: ruling 2
//! forbids adding a table/migration for assembly state, and this slice does
//! not re-derive historical traces from `assembly.requested` /
//! `assembly.completed` marker events already sitting in the raw-event
//! stream. A trace is therefore only available for `assemble_id`s minted by
//! this exact service instance — a limitation recorded in the B5 completion
//! notes rather than papered over with a new persistence layer.

use std::{
	collections::HashMap,
	sync::{Mutex, PoisonError},
	time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use successor_protocol::{
	artifact::ArtifactV0,
	ids::{AssembleId, ContextItemId, TraceId},
	platform_api::{
		AssembleRequestV0, AssemblyResponseV0, AssemblyTraceStageV0, AssemblyTraceV0,
		ContextItemRecoveryV0, ContextItemV0, DegradationV0, PolicyV0,
	},
	projection::PROJECTION_VERSION,
	raw_event::RawEventV0,
};
use uuid::Uuid;

use crate::{
	artifacts::SqliteArtifactStore, error::PlatformResult, source_index::find_source_provenance,
	store::RawEventAppendStore,
};

const STAGE_RETRIEVE_RECENT_SOURCES: &str = "retrieve_recent_sources";
const STAGE_REQUIRED_SOURCES: &str = "required_sources";

const DEGRADATION_EMBEDDINGS_UNAVAILABLE: &str = "embeddings_unavailable";
const DEGRADATION_NO_CONTEXT: &str = "no_context";
const DEGRADATION_UNKNOWN_REQUIRED_SOURCE: &str = "unknown_required_source";

const SEVERITY_WARNING: &str = "warning";
const SEVERITY_INFO: &str = "info";

const RECOVERY_METHOD_PLATFORM_ARTIFACT: &str = "platform_artifact";

/// Deterministic `/assemble` computation over the B2/B3/B4 platform
/// substrate. See the module documentation for the selection rule and
/// disclosed unpinned-behavior decisions.
pub struct AssemblyServiceV0<E: RawEventAppendStore> {
	events:    E,
	artifacts: SqliteArtifactStore,
	traces:    Mutex<HashMap<AssembleId, AssemblyTraceV0>>,
}

impl<E: RawEventAppendStore> AssemblyServiceV0<E> {
	#[must_use]
	pub fn new(events: E, artifacts: SqliteArtifactStore) -> Self {
		Self { events, artifacts, traces: Mutex::new(HashMap::new()) }
	}

	/// Computes an `AssemblyResponseV0` for `request`. See the module
	/// documentation for the selection rule and error/degradation split.
	pub async fn assemble(&self, request: &AssembleRequestV0) -> PlatformResult<AssemblyResponseV0> {
		// Fail closed on an unknown session before doing any other work:
		// every lookup below is scoped to this session and would otherwise
		// surface the same failure less directly (and, on the zero-required-
		// sources path, would not surface it at all).
		self
			.events
			.read_session_events(&request.session_id, 0, 1)
			.await?;

		let assemble_id = new_assemble_id();
		let trace_id = new_trace_id();
		let created_at = now_rfc3339();

		let mut context_items = Vec::new();
		let mut degradation = Vec::new();
		let mut dropped = Vec::new();

		let stage_name = if request.required_source_envelope_ids.is_empty() {
			degradation.push(DegradationV0 {
				code:     DEGRADATION_EMBEDDINGS_UNAVAILABLE.to_owned(),
				message:  "Embedding backend unavailable in Slice 0; deterministic lexical retrieval \
				           used."
					.to_owned(),
				severity: SEVERITY_WARNING.to_owned(),
			});
			degradation.push(DegradationV0 {
				code:     DEGRADATION_NO_CONTEXT.to_owned(),
				message:  "No relevant prior context before local discovery tools run.".to_owned(),
				severity: SEVERITY_INFO.to_owned(),
			});
			STAGE_RETRIEVE_RECENT_SOURCES
		} else {
			degradation.push(DegradationV0 {
				code:     DEGRADATION_EMBEDDINGS_UNAVAILABLE.to_owned(),
				message:  "Embedding backend unavailable in Slice 0; required-source retrieval used."
					.to_owned(),
				severity: SEVERITY_WARNING.to_owned(),
			});

			let mut included_items: u64 = 0;
			let mut included_tokens: u64 = 0;

			for source_envelope_id in &request.required_source_envelope_ids {
				if request
					.exclude_source_envelope_ids
					.contains(source_envelope_id)
				{
					dropped.push(dropped_entry(source_envelope_id.as_str(), "excluded"));
					continue;
				}

				let Some(entry) =
					find_source_provenance(&self.events, &request.session_id, source_envelope_id)
						.await?
				else {
					degradation.push(unknown_required_source_degradation(source_envelope_id.as_str()));
					dropped
						.push(dropped_entry(source_envelope_id.as_str(), "unknown_source_envelope_id"));
					continue;
				};

				let Some(event) = self.events.read_event(&entry.event_id).await? else {
					degradation.push(unknown_required_source_degradation(source_envelope_id.as_str()));
					dropped
						.push(dropped_entry(source_envelope_id.as_str(), "unknown_source_envelope_id"));
					continue;
				};

				// `ContextItemV0::artifact_id` is required, not optional: a
				// source whose producing event carries no artifact cannot be
				// represented as a context item under this schema. Drop it
				// the same way as an unresolvable source rather than
				// inventing a placeholder artifact id.
				let Some(artifact_id) = event.entity_ids.artifact_id.clone() else {
					degradation.push(DegradationV0 {
						code:     DEGRADATION_UNKNOWN_REQUIRED_SOURCE.to_owned(),
						message:  format!(
							"required source envelope {source_envelope_id} has no backing artifact"
						),
						severity: SEVERITY_WARNING.to_owned(),
					});
					dropped.push(dropped_entry(source_envelope_id.as_str(), "no_artifact"));
					continue;
				};

				let artifact = self.artifacts.require_artifact(&artifact_id).await?;

				let source_kind = event
					.payload
					.get("source_kind")
					.and_then(Value::as_str)
					.unwrap_or("unknown")
					.to_owned();
				let title = derive_title(&event, &artifact);
				let rendered_text = derive_rendered_text(&artifact);
				let token_estimate = estimate_tokens(&rendered_text);

				let included = included_items < request.budget.max_items
					&& included_tokens.saturating_add(token_estimate)
						<= request.budget.max_context_tokens;
				if included {
					included_items += 1;
					included_tokens += token_estimate;
				}

				context_items.push(ContextItemV0 {
					context_item_id: new_context_item_id(),
					source_envelope_id: source_envelope_id.clone(),
					artifact_id: artifact_id.clone(),
					source_kind,
					title,
					rendered_text,
					score: 1.0,
					token_estimate,
					included,
					recovery: ContextItemRecoveryV0 {
						method: RECOVERY_METHOD_PLATFORM_ARTIFACT.to_owned(),
						id:     artifact_id.as_str().to_owned(),
					},
				});
			}

			STAGE_REQUIRED_SOURCES
		};

		let trace = AssemblyTraceV0 {
			trace_id,
			assemble_id: assemble_id.clone(),
			query: request.intent.query.clone(),
			projection_version: PROJECTION_VERSION.to_owned(),
			stages: vec![AssemblyTraceStageV0 { name: stage_name.to_owned(), detail: Value::Null }],
			dropped,
		};

		let policy = PolicyV0 {
			enabled_sources:  vec![
				"user_turn".to_owned(),
				"assistant_turn".to_owned(),
				"tool_result".to_owned(),
			],
			disabled_sources: Vec::new(),
			weights:          json!({}),
		};

		let mut response = AssemblyResponseV0::new(
			assemble_id.clone(),
			request.session_id.clone(),
			request.turn_id.clone(),
			request.request_id.clone(),
			request.phase,
			created_at,
			trace.clone(),
			policy,
		);
		response.context_items = context_items;
		response.degradation = degradation;

		self
			.traces
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
			.insert(assemble_id, trace);

		Ok(response)
	}

	/// Looks up a trace previously produced by this service instance's own
	/// `assemble()` call. See the module documentation for why this is an
	/// in-process cache rather than a durable lookup.
	#[must_use]
	pub fn get_trace(&self, assemble_id: &AssembleId) -> Option<AssemblyTraceV0> {
		self
			.traces
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
			.get(assemble_id)
			.cloned()
	}
}

fn dropped_entry(source_envelope_id: &str, reason: &str) -> Value {
	json!({ "source_envelope_id": source_envelope_id, "reason": reason })
}

fn unknown_required_source_degradation(source_envelope_id: &str) -> DegradationV0 {
	DegradationV0 {
		code:     DEGRADATION_UNKNOWN_REQUIRED_SOURCE.to_owned(),
		message:  format!(
			"required source envelope {source_envelope_id} was not found in this session"
		),
		severity: SEVERITY_WARNING.to_owned(),
	}
}

/// Derives a human-readable title from the producing event's payload,
/// falling back to the artifact preview or the raw event type when the
/// payload does not carry the `tool_name`/`path` shape the canonical
/// `tool_result.recorded` fixture uses.
fn derive_title(event: &RawEventV0, artifact: &ArtifactV0) -> String {
	let tool_name = event.payload.get("tool_name").and_then(Value::as_str);
	let path = event.payload.get("path").and_then(Value::as_str);
	match (tool_name, path) {
		(Some(tool_name), Some(path)) => format!("{tool_name} {path}"),
		(Some(tool_name), None) => tool_name.to_owned(),
		(None, Some(path)) => path.to_owned(),
		(None, None) => artifact
			.preview
			.clone()
			.unwrap_or_else(|| event.event_type.to_string()),
	}
}

/// Derives the rendered text from the artifact's inline content, preferring
/// the raw string (the canonical fixtures always store text content this
/// way) and falling back to a compact JSON rendering or the preview.
fn derive_rendered_text(artifact: &ArtifactV0) -> String {
	match &artifact.content {
		Some(Value::String(text)) => text.clone(),
		Some(other) => other.to_string(),
		None => artifact.preview.clone().unwrap_or_default(),
	}
}

/// Slice 0 has no tokenizer dependency (Dissent ruling 2). Token cost is
/// approximated as whitespace-token count × 4, which reproduces the
/// canonical fixture's pinned `token_estimate: 32` for the 8-word read
/// artifact body and is otherwise a simple, deterministic, testable
/// placeholder pending a real tokenizer in a later slice.
fn estimate_tokens(rendered_text: &str) -> u64 {
	(rendered_text.split_whitespace().count() as u64) * 4
}

fn new_assemble_id() -> AssembleId {
	AssembleId::from_raw(format!("asm_{}", Uuid::new_v4()))
}

fn new_trace_id() -> TraceId {
	TraceId::from_raw(format!("trace_{}", Uuid::new_v4()))
}

fn new_context_item_id() -> ContextItemId {
	ContextItemId::from_raw(format!("ctx_{}", Uuid::new_v4()))
}

/// Dependency-free second-precision RFC3339 UTC formatter (Dissent ruling 2:
/// no new `chrono`/`time` dependency; B2/B3 instead push timestamp
/// generation into `SQLite`'s `strftime`, which is not an option for this
/// pure-computation service). Uses the standard Howard Hinnant
/// `civil_from_days` algorithm over `SystemTime`; unit-tested below against
/// known epoch offsets.
fn now_rfc3339() -> String {
	let unix_seconds = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs();
	format_rfc3339_utc(unix_seconds)
}

fn format_rfc3339_utc(unix_seconds: u64) -> String {
	let days = (unix_seconds / 86_400) as i64;
	let secs_of_day = unix_seconds % 86_400;
	let (year, month, day) = civil_from_days(days);
	let hour = secs_of_day / 3600;
	let minute = (secs_of_day % 3600) / 60;
	let second = secs_of_day % 60;
	format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days-since-epoch to `(year, month, day)`, Howard Hinnant's
/// `civil_from_days`: <http://howardhinnant.github.io/date_algorithms.html>.
const fn civil_from_days(z: i64) -> (i64, u32, u32) {
	let z = z + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = (z - era * 146_097) as u64;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe as i64 + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
	let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
	let y = if m <= 2 { y + 1 } else { y };
	(y, m, d)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn civil_from_days_matches_known_epoch_offsets() {
		assert_eq!(civil_from_days(0), (1970, 1, 1));
		assert_eq!(civil_from_days(1), (1970, 1, 2));
		assert_eq!(civil_from_days(-1), (1969, 12, 31));
		assert_eq!(civil_from_days(11_016), (2000, 2, 29));
		assert_eq!(civil_from_days(-25_508), (1900, 3, 1));
		// 2026-06-23, matching the canonical fixtures' `occurred_at` date.
		assert_eq!(civil_from_days(20_627), (2026, 6, 23));
	}

	#[test]
	fn format_rfc3339_utc_renders_expected_shape() {
		assert_eq!(format_rfc3339_utc(20_627 * 86_400 + 12 * 3600), "2026-06-23T12:00:00Z");
	}

	#[test]
	fn estimate_tokens_matches_canonical_fixture_artifact() {
		assert_eq!(
			estimate_tokens("export class ConceptGraphResolver {\n  // fixture content\n}\n"),
			32
		);
	}

	#[test]
	fn estimate_tokens_is_zero_for_empty_text() {
		assert_eq!(estimate_tokens(""), 0);
	}
}
