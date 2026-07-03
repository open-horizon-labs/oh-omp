//! Context Platform HTTP route handlers (`SLICE-0-CONTRACT.md` §6).
//!
//! Lane B6 wires the accepted B1-B5 surfaces into the live `/v0` router.
//! Handlers are thin: deserialize a protocol DTO (unknown top-level fields
//! rejected on `CreateSessionRequestV0`/`AssembleRequestV0` per the A2
//! reopen; `RawEventAppendRequestV0` already rejects unknown fields via its
//! hand-rolled `Deserialize`), delegate to the accepted store/service APIs,
//! and let `PlatformError`'s existing `IntoResponse` impl map the result
//! onto `ErrorEnvelopeV0` with the contract §4.2 status. No `SQLite` handle,
//! internal error detail, or credential material is ever placed in a
//! response body.
//!
//! # Single database identity (Dissent ruling 3)
//!
//! [`PlatformState::connect`] opens four independent connection pools — one
//! each for the directly-held [`SqliteAppendStore`]/[`SqliteArtifactStore`]
//! used by the simple CRUD-style handlers, and a second pair owned by the
//! [`AssemblyServiceV0`] (whose constructor takes its stores by value) — all
//! pointed at the *same* `SQLite` file path. `SqliteAppendStore` and
//! `SqliteArtifactStore` already document (see `artifacts.rs`) that
//! multiple independently pooled connections against one physical `SQLite`
//! file are safe to interleave under WAL mode, and this is the exact
//! multi-connect-same-path pattern the B2/B3/B4/B5 test suites already use
//! (see `tests/slice0_assembly.rs::seeded_service`,
//! `tests/slice0_replay.rs`). No additional DI constructor was needed on
//! any B2/B3/B5 type to achieve single-database identity across the
//! platform surface — see the B6 completion notes for the disclosure.

use std::sync::Arc;

use axum::{
	Json, Router,
	body::Bytes,
	extract::{Path, Query, State},
	routing::{get, post},
};
use serde::Deserialize;
use successor_protocol::{
	artifact::ArtifactV0,
	error::ProtocolViolationCode,
	ids::{ArtifactId, AssembleId, EventId, SessionId},
	platform_api::{
		AssembleRequestV0, AssemblyResponseV0, AssemblyTraceV0, CreateSessionRequestV0,
		CreateSessionResponseV0, EventPageV0, RawEventAppendRequestV0, RawEventAppendResponseV0,
		ReadArtifactResponseV0, SessionSnapshotV0,
	},
	raw_event::RawEventV0,
};

use crate::{
	artifacts::SqliteArtifactStore,
	assembly::AssemblyServiceV0,
	error::{PlatformError, PlatformResult},
	replay,
	sqlite::SqliteAppendStore,
	store::{RawEventAppendStore, violation_to_platform_error},
};

/// Default page size for `GET /v0/sessions/{session_id}/events` when the
/// caller omits `limit`. The contract does not mandate a specific value;
/// this mirrors the page size the B4 replay module uses internally for its
/// own paging loop.
const DEFAULT_EVENT_PAGE_LIMIT: u32 = 200;

/// Shared Context Platform state passed to every route handler as axum
/// `State`. See the module doc for the single-database-identity rationale.
pub struct PlatformState {
	events:    SqliteAppendStore,
	artifacts: SqliteArtifactStore,
	assembly:  AssemblyServiceV0<SqliteAppendStore>,
}

impl PlatformState {
	/// Connects every store/service this router needs to the `SQLite`
	/// database at `path`, establishing single-database identity by
	/// pointing every pool at the same physical file.
	pub async fn connect(path: &str) -> Result<Self, sqlx::Error> {
		let events = SqliteAppendStore::connect(path).await?;
		let artifacts = SqliteArtifactStore::connect(path).await?;
		let assembly_events = SqliteAppendStore::connect(path).await?;
		let assembly_artifacts = SqliteArtifactStore::connect(path).await?;
		Ok(Self {
			events,
			artifacts,
			assembly: AssemblyServiceV0::new(assembly_events, assembly_artifacts),
		})
	}
}

/// Builds the `/v0` contract routes (§6) against `state`. Callers mount
/// this under the auth-gated `/v0` prefix (see `http.rs`); this function
/// does not apply auth itself.
pub fn router(state: Arc<PlatformState>) -> Router {
	Router::new()
		.route("/sessions", post(create_session))
		.route("/events", post(append_event))
		.route("/sessions/{session_id}/events", get(read_session_events))
		.route("/events/{event_id}", get(read_event))
		.route("/artifacts/{artifact_id}", get(read_artifact))
		.route("/sessions/{session_id}/snapshot", get(read_snapshot))
		.route("/assemble", post(assemble))
		.route("/traces/{assemble_id}", get(read_trace))
		.with_state(state)
}

/// Decodes a JSON request body into a protocol DTO, mapping any decode
/// failure — malformed JSON, a missing/mistyped field, or a
/// `deny_unknown_fields` rejection — onto the same typed `PlatformError` /
/// `ErrorEnvelopeV0` shape every other failure in this module uses, instead
/// of axum's untyped default body-extractor rejection.
fn decode_body<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> PlatformResult<T> {
	serde_json::from_slice(bytes).map_err(|err| {
		PlatformError::new(
			ProtocolViolationCode::ValidationFailed,
			format!("malformed request body: {err}"),
		)
	})
}

/// Parses a raw path segment into a protocol id type, mapping a bad prefix
/// onto the same `PlatformError` the store layer already uses for id
/// validation failures (via the accepted `store::violation_to_platform_error`
/// helper).
fn parse_id<T>(raw: String) -> PlatformResult<T>
where
	T: TryFrom<String, Error = successor_protocol::error::ProtocolViolation>,
{
	T::try_from(raw).map_err(violation_to_platform_error)
}

/// `POST /v0/sessions` — contract §6.1.
async fn create_session(
	State(state): State<Arc<PlatformState>>,
	body: Bytes,
) -> PlatformResult<Json<CreateSessionResponseV0>> {
	let request: CreateSessionRequestV0 = decode_body(&body)?;
	let response = state.events.create_session(request).await?;
	Ok(Json(response))
}

/// `POST /v0/events` — contract §6.2. When the appended event carries
/// inline fixture artifact content and the append was not an idempotent
/// replay, the artifact is stored via the accepted B3 store so a
/// subsequent `GET /v0/artifacts/{artifact_id}` observes it — this is the
/// "with artifact storage" wiring the lane packet's edge cases require.
async fn append_event(
	State(state): State<Arc<PlatformState>>,
	body: Bytes,
) -> PlatformResult<Json<RawEventAppendResponseV0>> {
	let request: RawEventAppendRequestV0 = decode_body(&body)?;
	let artifact_ref = request.artifact.clone();
	let session_id = request.session_id.clone();

	let response = state.events.append_event(request).await?;

	if !response.duplicate
		&& let (Some(artifact_ref), Some(artifact_id)) = (artifact_ref, response.artifact_id.clone())
		&& let Some(content) = artifact_ref.content.clone()
	{
		let mut artifact = ArtifactV0::new(
			artifact_id,
			artifact_ref.media_type.clone(),
			artifact_ref
				.encoding
				.clone()
				.unwrap_or_else(|| "identity".to_owned()),
			artifact_ref.sha256.as_str(),
			artifact_ref.byte_length,
		)
		.map_err(violation_to_platform_error)?
		.with_content(serde_json::Value::String(content));
		if let Some(preview) = artifact_ref.preview.clone() {
			artifact = artifact.with_preview(preview);
		}
		state
			.artifacts
			.put_inline_artifact(&response.event_id, &session_id, artifact)
			.await?;
	}

	Ok(Json(response))
}

#[derive(Debug, Deserialize)]
struct EventPageQuery {
	after_seq: Option<u64>,
	limit:     Option<u32>,
}

/// `GET /v0/sessions/{session_id}/events?after_seq&limit` — contract §6.3.
async fn read_session_events(
	State(state): State<Arc<PlatformState>>,
	Path(session_id_raw): Path<String>,
	Query(query): Query<EventPageQuery>,
) -> PlatformResult<Json<EventPageV0>> {
	let session_id: SessionId = parse_id(session_id_raw)?;
	let after_seq = query.after_seq.unwrap_or(0);
	let limit = query.limit.unwrap_or(DEFAULT_EVENT_PAGE_LIMIT);
	let page = state
		.events
		.read_session_events(&session_id, after_seq, limit)
		.await?;
	Ok(Json(page))
}

/// `GET /v0/events/{event_id}` — contract §6.4.
async fn read_event(
	State(state): State<Arc<PlatformState>>,
	Path(event_id_raw): Path<String>,
) -> PlatformResult<Json<RawEventV0>> {
	let event_id: EventId = parse_id(event_id_raw)?;
	let event = state.events.read_event(&event_id).await?.ok_or_else(|| {
		PlatformError::not_found(format!("no event found for {}", event_id.as_str()))
	})?;
	Ok(Json(event))
}

/// `GET /v0/artifacts/{artifact_id}` — contract §6.5.
async fn read_artifact(
	State(state): State<Arc<PlatformState>>,
	Path(artifact_id_raw): Path<String>,
) -> PlatformResult<Json<ReadArtifactResponseV0>> {
	let artifact_id: ArtifactId = parse_id(artifact_id_raw)?;
	let artifact = state.artifacts.require_artifact(&artifact_id).await?;
	Ok(Json(artifact))
}

/// `GET /v0/sessions/{session_id}/snapshot` — contract §6.6.
async fn read_snapshot(
	State(state): State<Arc<PlatformState>>,
	Path(session_id_raw): Path<String>,
) -> PlatformResult<Json<SessionSnapshotV0>> {
	let session_id: SessionId = parse_id(session_id_raw)?;
	let snapshot =
		replay::replay_session_snapshot(&state.events, &state.artifacts, &session_id).await?;
	Ok(Json(snapshot))
}

/// `POST /v0/assemble` — contract §6.7.
async fn assemble(
	State(state): State<Arc<PlatformState>>,
	body: Bytes,
) -> PlatformResult<Json<AssemblyResponseV0>> {
	let request: AssembleRequestV0 = decode_body(&body)?;
	let response = state.assembly.assemble(&request).await?;
	Ok(Json(response))
}

/// `GET /v0/traces/{assemble_id}` — contract §6.8. The trace is served from
/// the `AssemblyServiceV0` in-memory trace cache populated by a prior
/// `POST /v0/assemble` on this same `PlatformState`.
async fn read_trace(
	State(state): State<Arc<PlatformState>>,
	Path(assemble_id_raw): Path<String>,
) -> PlatformResult<Json<AssemblyTraceV0>> {
	let assemble_id: AssembleId = parse_id(assemble_id_raw)?;
	let trace = state.assembly.get_trace(&assemble_id).ok_or_else(|| {
		PlatformError::not_found(format!("no trace found for {}", assemble_id.as_str()))
	})?;
	Ok(Json(trace))
}
