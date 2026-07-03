//! B3-owned durable artifact storage: `artifact_id`-keyed persistence with
//! source-event provenance, over the platform's `SQLite` pool.
//!
//! Binding orchestrator rulings for this lane (see
//! `.oh/workstreams/successor-agent-kernel/runs/slice-0/
//! B3-PlatformArtifactsIndexes.md`):
//!
//! - `artifact_id` is the canonical identity. sha256-based dedup is prohibited
//!   as an identity scheme: this store never uses a content hash to decide
//!   whether two artifacts are "the same" artifact. A duplicate `artifact_id`
//!   store attempt is rejected, never silently merged or overwritten
//!   (`artifacts.artifact_id` is a `SQLite` `PRIMARY KEY`).
//! - Every artifact carries a `source_event_id`: the raw event that produced
//!   it. `0002_slice0_artifacts.sql` enforces this exists in `raw_events`.
//! - `validate_artifact_content` (the accepted A1 validator) runs both on write
//!   -- rejecting a mismatched hash/length before anything is persisted -- and
//!   on readback, to detect storage-layer corruption rather than silently
//!   returning tampered bytes as if they were the original artifact.
//! - This module defines its own SQLite-backed store rather than extending
//!   `sqlite::SqliteAppendStore` (B2-owned, not editable by this lane). It
//!   opens an independent `sqlx::SqlitePool` against the same on-disk path as
//!   the append store and runs the same embedded migration set
//!   (`sqlx::migrate!` is idempotent: whichever store connects first creates
//!   the schema, the other observes it already applied), so both stores act on
//!   one physical database. `SqliteJournalMode::Wal` is what makes two
//!   independently pooled connections to that one file safe to interleave.
//!
//! Callers who need to exercise both stores against one temporary database
//! (as this module's own tests do) must connect each store to the same file
//! path. Two independent calls to `connect_in_memory()` -- this store's or
//! `SqliteAppendStore`'s -- each open a private, unshared in-memory
//! database and will not observe each other's writes.

use sqlx::{
	Row, SqlitePool,
	sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use successor_protocol::{
	artifact::{ArtifactV0, validate_artifact_content},
	error::ProtocolResult,
	ids::{ArtifactId, EventId, SessionId},
};

use crate::{
	error::{PlatformError, PlatformResult},
	store::violation_to_platform_error,
};

fn sqlx_error(err: sqlx::Error) -> PlatformError {
	PlatformError::new(
		successor_protocol::error::ProtocolViolationCode::Internal,
		format!("artifact storage error: {err}"),
	)
}

fn json_error(err: serde_json::Error) -> PlatformError {
	PlatformError::new(
		successor_protocol::error::ProtocolViolationCode::Internal,
		format!("artifact json error: {err}"),
	)
}

const NOW_EXPR: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// Extracts the exact byte representation of an artifact's inline content.
///
/// Slice 0 canonical artifacts (see `RawEventArtifactRef::content` in
/// `successor-protocol`) carry inline content as a JSON *string*: the
/// literal text of the artifact. The declared `sha256`/`byte_length` are
/// computed over those raw UTF-8 bytes, not over a re-serialized JSON
/// encoding of some structured value. Any other JSON shape (object, array,
/// number, ...) has no accepted byte-exact canonicalization in Slice 0, so
/// it is rejected as a validation failure rather than guessed at -- this
/// lane has no authority to invent a canonicalization scheme.
fn content_bytes(content: &serde_json::Value) -> PlatformResult<Vec<u8>> {
	match content {
		serde_json::Value::String(s) => Ok(s.as_bytes().to_vec()),
		_ => Err(PlatformError::new(
			successor_protocol::error::ProtocolViolationCode::ValidationFailed,
			"artifact content must be a JSON string for byte-exact validation in Slice 0",
		)),
	}
}

/// Runs the accepted `validate_artifact_content` check against `artifact`'s
/// declared `sha256`/`byte_length` and its actual content bytes.
fn verify_content(artifact: &ArtifactV0) -> ProtocolResult<()> {
	let Some(content) = artifact.content.as_ref() else {
		return Err(successor_protocol::error::ProtocolViolation::new(
			successor_protocol::error::ProtocolViolationCode::ValidationFailed,
			"artifact has no inline content to verify",
		));
	};
	let bytes = content_bytes(content).map_err(|_| {
		successor_protocol::error::ProtocolViolation::new(
			successor_protocol::error::ProtocolViolationCode::ValidationFailed,
			"artifact content must be a JSON string for byte-exact validation in Slice 0",
		)
	})?;
	validate_artifact_content(artifact.sha256.as_str(), artifact.byte_length, &bytes)
}

/// B3-owned SQLite-backed durable artifact store.
///
/// See the module documentation for the pool-sharing constraints this store
/// operates under.
pub struct SqliteArtifactStore {
	pool: SqlitePool,
}

impl SqliteArtifactStore {
	/// Opens (creating if missing) a file-backed artifact store.
	///
	/// `path` must name the same physical `SQLite` file used by whichever
	/// `sqlite::SqliteAppendStore` produced the events this store's
	/// artifacts are attached to; see the module documentation.
	pub async fn connect(path: &str) -> Result<Self, sqlx::Error> {
		let options = SqliteConnectOptions::new()
			.filename(path)
			.create_if_missing(true)
			.journal_mode(SqliteJournalMode::Wal)
			.foreign_keys(true);
		Self::connect_with(options).await
	}

	/// Opens a private in-memory artifact store.
	///
	/// This database is **not** shared with any other store, including one
	/// built from `sqlite::SqliteAppendStore::connect_in_memory()`. It is
	/// only useful for exercising `SqliteArtifactStore` in isolation.
	pub async fn connect_in_memory() -> Result<Self, sqlx::Error> {
		let options: SqliteConnectOptions = "sqlite::memory:".parse()?;
		Self::connect_with(options.foreign_keys(true)).await
	}

	async fn connect_with(options: SqliteConnectOptions) -> Result<Self, sqlx::Error> {
		let pool = SqlitePoolOptions::new()
			.max_connections(1)
			.connect_with(options)
			.await?;
		sqlx::migrate!("./migrations").run(&pool).await?;
		Ok(Self { pool })
	}

	/// Persists `artifact`, produced by `source_event_id` within
	/// `session_id`.
	///
	/// Rejects, without persisting anything, if `artifact`'s declared
	/// hash/length do not match its actual content bytes (typed error from
	/// the accepted `validate_artifact_content` check). Rejects with
	/// `ProtocolViolationCode::Conflict` if `artifact.artifact_id` is
	/// already stored: store attempts never silently overwrite existing
	/// content.
	pub async fn put_inline_artifact(
		&self,
		source_event_id: &EventId,
		session_id: &SessionId,
		artifact: ArtifactV0,
	) -> PlatformResult<ArtifactV0> {
		verify_content(&artifact).map_err(violation_to_platform_error)?;

		let artifact_json = serde_json::to_string(&artifact).map_err(json_error)?;
		let mut conn = self.pool.acquire().await.map_err(sqlx_error)?;
		let byte_length = i64::try_from(artifact.byte_length).map_err(|_| {
			PlatformError::new(
				successor_protocol::error::ProtocolViolationCode::ValidationFailed,
				"artifact byte_length exceeds representable range",
			)
		})?;
		let result = sqlx::query(&format!(
			"INSERT INTO artifacts (artifact_id, source_event_id, session_id, sha256, byte_length, \
			 artifact_json, stored_at) VALUES (?, ?, ?, ?, ?, ?, {NOW_EXPR})"
		))
		.bind(artifact.artifact_id.as_str())
		.bind(source_event_id.as_str())
		.bind(session_id.as_str())
		.bind(artifact.sha256.as_str())
		.bind(byte_length)
		.bind(&artifact_json)
		.execute(&mut *conn)
		.await;

		match result {
			Ok(_) => Ok(artifact),
			Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
				Err(PlatformError::new(
					successor_protocol::error::ProtocolViolationCode::Conflict,
					format!("artifact {} already stored", artifact.artifact_id),
				))
			},
			Err(err) => Err(sqlx_error(err)),
		}
	}

	/// Reads an artifact by `artifact_id`, returning `Ok(None)` if unknown.
	///
	/// Re-runs `validate_artifact_content` against the stored bytes before
	/// returning: a mismatch indicates storage-layer corruption and is
	/// surfaced as a typed error (the same `ProtocolViolationCode` the
	/// write-path check would have produced) rather than being returned to
	/// the caller as if it were the original artifact.
	pub async fn get_artifact(
		&self,
		artifact_id: &ArtifactId,
	) -> PlatformResult<Option<ArtifactV0>> {
		let mut conn = self.pool.acquire().await.map_err(sqlx_error)?;
		let row = sqlx::query("SELECT artifact_json FROM artifacts WHERE artifact_id = ?")
			.bind(artifact_id.as_str())
			.fetch_optional(&mut *conn)
			.await
			.map_err(sqlx_error)?;
		let Some(row) = row else { return Ok(None) };
		let json: String = row.try_get("artifact_json").map_err(sqlx_error)?;
		let artifact: ArtifactV0 = serde_json::from_str(&json).map_err(json_error)?;
		verify_content(&artifact).map_err(violation_to_platform_error)?;
		Ok(Some(artifact))
	}

	/// Reads an artifact by `artifact_id`, mapping "unknown" to a typed
	/// `ProtocolViolationCode::NotFound` error (via `PlatformError::not_found`)
	/// rather than `Ok(None)`, with no SQLite-specific detail in the
	/// message.
	pub async fn require_artifact(&self, artifact_id: &ArtifactId) -> PlatformResult<ArtifactV0> {
		self
			.get_artifact(artifact_id)
			.await?
			.ok_or_else(|| PlatformError::not_found(format!("artifact {artifact_id} not found")))
	}
}

#[cfg(test)]
mod tests {
	use successor_protocol::{
		artifact::ArtifactHash,
		error::ProtocolViolationCode,
		ids::{ArtifactId, EventId, SessionId},
		platform_api::{CreateSessionRequestV0, CreatedByV0, RawEventAppendRequestV0, WorkspaceV0},
	};

	use super::*;
	use crate::{sqlite::SqliteAppendStore, store::RawEventAppendStore};

	/// The canonical successful-turn raw-event fixture, as full `RawEventV0`
	/// JSON objects (each carries `session_seq`, unlike
	/// `RawEventAppendRequestV0`).
	const SUCCESSFUL_TURN_FIXTURE: &str = include_str!(
		"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
		 raw-events-successful-turn.json"
	);

	/// A unique temporary `SQLite` file path. Two independently pooled
	/// connections to this same path observe the same physical database
	/// (unlike `sqlite::memory:`, which is private per connection).
	struct TempDbPath(String);

	impl TempDbPath {
		fn new(label: &str) -> Self {
			let unique = uuid::Uuid::new_v4();
			let path = std::env::temp_dir().join(format!("b3-artifacts-{label}-{unique}.sqlite3"));
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

	/// Appends the full canonical successful-turn stream into a fresh
	/// session on `append_store`, rewriting `session_id` on each fixture
	/// event to match. Returns the session id used.
	async fn seed_successful_turn(append_store: &SqliteAppendStore) -> SessionId {
		let session = append_store
			.create_session(CreateSessionRequestV0 {
				workspace:  WorkspaceV0 {
					id:        "workspace_b3".to_owned(),
					label:     "b3-tests".to_owned(),
					root_hint: "/tmp/b3-tests".to_owned(),
				},
				title:      "B3 artifact store tests".to_owned(),
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
			let request: RawEventAppendRequestV0 = serde_json::from_value(event).expect(
				"fixture event must deserialize as an append request once session_seq is stripped",
			);
			append_store
				.append_event(request)
				.await
				.expect("fixture append must succeed");
		}

		session.session_id
	}

	/// The two artifact-bearing fixture events, as `(source_event_id,
	/// artifact)` pairs, built directly from the fixture's
	/// `RawEventArtifactRef` + `entity_ids.artifact_id`.
	async fn fixture_artifacts(
		append_store: &SqliteAppendStore,
		session_id: &SessionId,
	) -> Vec<(EventId, ArtifactV0)> {
		let mut after_seq = 0u64;
		let mut found = Vec::new();
		loop {
			let page = append_store
				.read_session_events(session_id, after_seq, 100)
				.await
				.expect("read_session_events must succeed");
			for event in &page.events {
				let Some(artifact_ref) = &event.artifact else {
					continue;
				};
				let Some(content) = &artifact_ref.content else {
					continue;
				};
				let Some(artifact_id) = event.entity_ids.artifact_id.clone() else {
					continue;
				};
				let artifact = ArtifactV0::new(
					artifact_id,
					artifact_ref.media_type.clone(),
					artifact_ref
						.encoding
						.clone()
						.unwrap_or_else(|| "identity".to_owned()),
					artifact_ref.sha256.as_str(),
					artifact_ref.byte_length,
				)
				.expect("fixture artifact hash must be well-formed")
				.with_content(serde_json::Value::String(content.clone()));
				if let Some(preview) = &artifact_ref.preview {
					found.push((event.event_id.clone(), artifact.with_preview(preview.clone())));
				} else {
					found.push((event.event_id.clone(), artifact));
				}
			}
			after_seq = page.next_after_seq;
			if !page.has_more {
				break;
			}
		}
		assert_eq!(
			found.len(),
			2,
			"canonical successful-turn fixture must carry exactly two inline artifacts"
		);
		found
	}

	/// Seeds a fresh session with the full canonical fixture stream and
	/// returns `(session_id, first_event_id)` -- a real, persisted event
	/// whose `source_event_id` foreign key is satisfiable, for tests that only
	/// need *some* valid provenance rather than an artifact-bearing event.
	async fn seed_session_with_an_event(append_store: &SqliteAppendStore) -> (SessionId, EventId) {
		let session_id = seed_successful_turn(append_store).await;
		let page = append_store
			.read_session_events(&session_id, 0, 1)
			.await
			.expect("read_session_events must succeed");
		let event_id = page
			.events
			.first()
			.expect("seeded session must have at least one event")
			.event_id
			.clone();
		(session_id, event_id)
	}

	fn make_artifact(id: &str, content: &str) -> ArtifactV0 {
		let hash = ArtifactHash::compute(content.as_bytes());
		ArtifactV0::new(
			ArtifactId::try_from(id.to_owned()).unwrap(),
			"text/plain",
			"utf-8",
			hash.as_str(),
			content.len() as u64,
		)
		.unwrap()
		.with_content(serde_json::Value::String(content.to_owned()))
	}

	#[tokio::test]
	async fn store_then_read_round_trips_byte_exact_fixture_artifacts() {
		let db = TempDbPath::new("roundtrip");
		let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
		let artifact_store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();

		let session_id = seed_successful_turn(&append_store).await;
		let artifacts = fixture_artifacts(&append_store, &session_id).await;

		for (source_event_id, artifact) in artifacts {
			let stored = artifact_store
				.put_inline_artifact(&source_event_id, &session_id, artifact.clone())
				.await
				.expect("put_inline_artifact must succeed for a valid fixture artifact");
			assert_eq!(stored, artifact, "put_inline_artifact must return the exact stored artifact");

			let read_back = artifact_store
				.get_artifact(&artifact.artifact_id)
				.await
				.expect("get_artifact must succeed")
				.expect("artifact must be found");
			assert_eq!(read_back, artifact, "readback must be byte-exact with the original artifact");
		}
	}

	#[tokio::test]
	async fn put_inline_artifact_rejects_hash_mismatch() {
		let store = SqliteArtifactStore::connect_in_memory().await.unwrap();
		let event_id = EventId::try_from("evt_mismatch".to_owned()).unwrap();
		let session_id = SessionId::try_from("ses_mismatch".to_owned()).unwrap();

		// Well-formed hash, but computed over different content than what is
		// actually attached.
		let wrong_hash = ArtifactHash::compute(b"not the real content");
		let artifact = ArtifactV0::new(
			ArtifactId::try_from("art_mismatch".to_owned()).unwrap(),
			"text/plain",
			"utf-8",
			wrong_hash.as_str(),
			b"actual content".len() as u64,
		)
		.unwrap()
		.with_content(serde_json::Value::String("actual content".to_owned()));

		let err = store
			.put_inline_artifact(&event_id, &session_id, artifact)
			.await
			.unwrap_err();
		assert_eq!(err.envelope().code, ProtocolViolationCode::ValidationFailed.as_str());
	}

	#[tokio::test]
	async fn get_artifact_detects_corrupted_stored_content() {
		let db = TempDbPath::new("corruption");
		let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
		let store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();
		let (session_id, event_id) = seed_session_with_an_event(&append_store).await;
		let artifact = make_artifact("art_corrupt", "pristine content");

		store
			.put_inline_artifact(&event_id, &session_id, artifact.clone())
			.await
			.unwrap();

		// Tamper the stored JSON directly, bypassing the store's own write
		// path, to simulate storage-layer corruption.
		let raw_pool = sqlx::SqlitePool::connect(db.as_str()).await.unwrap();
		let tampered = artifact
			.clone()
			.with_content(serde_json::Value::String("tampered content".to_owned()));
		let tampered_json = serde_json::to_string(&tampered).unwrap();
		sqlx::query("UPDATE artifacts SET artifact_json = ? WHERE artifact_id = ?")
			.bind(&tampered_json)
			.bind(artifact.artifact_id.as_str())
			.execute(&raw_pool)
			.await
			.unwrap();
		raw_pool.close().await;

		let err = store.get_artifact(&artifact.artifact_id).await.unwrap_err();
		assert_eq!(err.envelope().code, ProtocolViolationCode::ValidationFailed.as_str());
	}

	#[tokio::test]
	async fn get_artifact_unknown_id_returns_none() {
		let store = SqliteArtifactStore::connect_in_memory().await.unwrap();
		let unknown = ArtifactId::try_from("art_unknown".to_owned()).unwrap();
		assert_eq!(store.get_artifact(&unknown).await.unwrap(), None);
	}

	#[tokio::test]
	async fn require_artifact_unknown_id_returns_typed_not_found_without_sql_detail() {
		let store = SqliteArtifactStore::connect_in_memory().await.unwrap();
		let unknown = ArtifactId::try_from("art_unknown".to_owned()).unwrap();

		let err = store.require_artifact(&unknown).await.unwrap_err();
		let envelope = err.envelope();
		assert_eq!(envelope.code, ProtocolViolationCode::NotFound.as_str());
		let message_lower = envelope.message.to_lowercase();
		assert!(
			!message_lower.contains("sql"),
			"not-found message must not leak SQL detail: {}",
			envelope.message
		);
		assert!(
			!message_lower.contains("sqlite"),
			"not-found message must not leak SQLite detail: {}",
			envelope.message
		);
	}

	#[tokio::test]
	async fn put_inline_artifact_duplicate_id_is_rejected_deterministically() {
		let db = TempDbPath::new("duplicate");
		let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
		let store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();
		let session_id = seed_successful_turn(&append_store).await;
		let page = append_store
			.read_session_events(&session_id, 0, 2)
			.await
			.expect("read_session_events must succeed");
		let event_id = page.events[0].event_id.clone();
		let other_event_id = page.events[1].event_id.clone();
		let original = make_artifact("art_dup", "original content");

		store
			.put_inline_artifact(&event_id, &session_id, original.clone())
			.await
			.unwrap();

		// A second store attempt under the same artifact_id, with different
		// content, must be rejected -- never silently overwritten.
		let colliding = make_artifact("art_dup", "different content entirely");
		let err = store
			.put_inline_artifact(&other_event_id, &session_id, colliding)
			.await
			.unwrap_err();
		assert_eq!(err.envelope().code, ProtocolViolationCode::Conflict.as_str());

		// The original content must be unchanged.
		let read_back = store
			.get_artifact(&original.artifact_id)
			.await
			.unwrap()
			.unwrap();
		assert_eq!(read_back, original);
	}

	#[tokio::test]
	async fn put_inline_artifact_does_not_scan_for_credentials() {
		// Binding ruling: reject credential-looking artifact content "if and
		// only if accepted validators say so"; this lane must not invent new
		// scanning. `successor_protocol::validation::check_raw_event_credentials`
		// (the accepted A5 credential scanner) is a private, `RawEventV0`-scoped
		// helper with no public entry point for standalone artifact content, so
		// this store performs no credential scanning of its own. This test
		// documents that: credential-shaped content is accepted, not rejected.
		let db = TempDbPath::new("credential");
		let append_store = SqliteAppendStore::connect(db.as_str()).await.unwrap();
		let store = SqliteArtifactStore::connect(db.as_str()).await.unwrap();
		let (session_id, event_id) = seed_session_with_an_event(&append_store).await;
		let artifact = make_artifact("art_cred", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG");

		let result = store
			.put_inline_artifact(&event_id, &session_id, artifact)
			.await;
		assert!(
			result.is_ok(),
			"artifact store has no accepted credential validator to invoke, so it must not reject on \
			 its own invented scan: {result:?}"
		);
	}
}
