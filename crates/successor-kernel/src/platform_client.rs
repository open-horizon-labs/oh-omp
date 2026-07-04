//! Owned by Lane C1 `KernelPlatformClient`.
//!
//! Typed async client over the platform `/v0` contract
//! (`SLICE-0-CONTRACT.md` §6): one method per endpoint, each accepting and
//! returning the exact protocol DTO the platform's routes accept and
//! return. The base URL passed to the constructor is the platform's
//! `/v0` API base per contract §6 (e.g. `http://127.0.0.1:7332/v0`); every
//! endpoint path below is contract-relative (`/sessions`, `/events`, …)
//! and is appended onto that base as-is — this client never appends its
//! own `/v0` segment. This client never reads environment variables —
//! the kernel config seam (lane C3) owns sourcing `MEMEX_LICENSE` and the
//! platform `/v0` base URL and wiring them into the constructor.
//!
//! HTTP mechanics (bearer injection, JSON encode/decode, status
//! classification) live in `platform_http.rs`; the kernel error seam lives
//! in `platform_error.rs`.

use successor_protocol::{
	ids::{ArtifactId, AssembleId, EventId, SessionId},
	platform_api::{
		AssembleRequestV0, AssemblyResponseV0, AssemblyTraceV0, CreateSessionRequestV0,
		CreateSessionResponseV0, EventPageV0, RawEventAppendRequestV0, RawEventAppendResponseV0,
		ReadArtifactResponseV0, SessionSnapshotV0,
	},
	raw_event::RawEventV0,
};

pub use crate::platform_http::EntitlementToken;
use crate::{platform_error::PlatformClientError, platform_http::PlatformHttpClient};

/// Typed async client over the platform `/v0` contract (§6).
///
/// One method per endpoint: create session, append events, page events,
/// fetch a single event, fetch an artifact, read a session snapshot,
/// assemble, and fetch an assembly trace.
#[derive(Clone, Debug)]
pub struct KernelPlatformClient {
	http: PlatformHttpClient,
}

impl KernelPlatformClient {
	/// Builds a client against `base_url`, the platform's `/v0` API base
	/// per contract §6 (e.g. `http://127.0.0.1:8787/v0`), authenticating
	/// every request with `token`. Does not read environment variables;
	/// callers (the kernel config seam) source the `/v0` base URL and
	/// `MEMEX_LICENSE` value themselves and pass them here.
	pub fn new(base_url: impl Into<String>, token: impl Into<EntitlementToken>) -> Self {
		Self { http: PlatformHttpClient::new(base_url, token) }
	}

	/// `POST {base_url}/sessions` — contract §6.1.
	pub async fn create_session(
		&self,
		request: &CreateSessionRequestV0,
	) -> Result<CreateSessionResponseV0, PlatformClientError> {
		self.http.post("/sessions", request).await
	}

	/// `POST {base_url}/events` — contract §6.2.
	pub async fn append_event(
		&self,
		request: &RawEventAppendRequestV0,
	) -> Result<RawEventAppendResponseV0, PlatformClientError> {
		self.http.post("/events", request).await
	}

	/// `GET {base_url}/sessions/{session_id}/events?after_seq&limit` — contract
	/// §6.3.
	pub async fn read_session_events(
		&self,
		session_id: &SessionId,
		after_seq: Option<u64>,
		limit: Option<u32>,
	) -> Result<EventPageV0, PlatformClientError> {
		let mut query = Vec::new();
		if let Some(after_seq) = after_seq {
			query.push(("after_seq", after_seq.to_string()));
		}
		if let Some(limit) = limit {
			query.push(("limit", limit.to_string()));
		}
		self
			.http
			.get(&format!("/sessions/{}/events", session_id.as_str()), &query)
			.await
	}

	/// `GET {base_url}/events/{event_id}` — contract §6.4.
	pub async fn read_event(&self, event_id: &EventId) -> Result<RawEventV0, PlatformClientError> {
		self
			.http
			.get(&format!("/events/{}", event_id.as_str()), &[])
			.await
	}

	/// `GET {base_url}/artifacts/{artifact_id}` — contract §6.5.
	pub async fn read_artifact(
		&self,
		artifact_id: &ArtifactId,
	) -> Result<ReadArtifactResponseV0, PlatformClientError> {
		self
			.http
			.get(&format!("/artifacts/{}", artifact_id.as_str()), &[])
			.await
	}

	/// `GET {base_url}/sessions/{session_id}/snapshot` — contract §6.6.
	pub async fn read_snapshot(
		&self,
		session_id: &SessionId,
	) -> Result<SessionSnapshotV0, PlatformClientError> {
		self
			.http
			.get(&format!("/sessions/{}/snapshot", session_id.as_str()), &[])
			.await
	}

	/// `POST {base_url}/assemble` — contract §6.7.
	pub async fn assemble(
		&self,
		request: &AssembleRequestV0,
	) -> Result<AssemblyResponseV0, PlatformClientError> {
		self.http.post("/assemble", request).await
	}

	/// `GET {base_url}/traces/{assemble_id}` — contract §6.8. Keyed by
	/// `assemble_id`, not `trace_id`: the trace is served from the same
	/// `PlatformState` that served the originating `POST {base_url}/assemble`.
	pub async fn read_trace(
		&self,
		assemble_id: &AssembleId,
	) -> Result<AssemblyTraceV0, PlatformClientError> {
		self
			.http
			.get(&format!("/traces/{}", assemble_id.as_str()), &[])
			.await
	}
}
