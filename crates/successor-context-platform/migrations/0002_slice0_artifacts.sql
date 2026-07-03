-- Slice 0 B3-owned artifact storage.
--
-- Design
-- ------
-- `artifacts` is keyed by `artifact_id` (platform identity), never by
-- content hash. The binding orchestrator ruling for lane B3 explicitly
-- prohibits sha256-based dedup as canonical artifact identity, so
-- `artifact_id` is the PRIMARY KEY: a duplicate `artifact_id` store
-- attempt fails the constraint rather than silently overwriting existing
-- content.
--
-- `source_event_id` records the raw event that produced this artifact
-- (provenance-first storage). It references `raw_events(event_id)`, a
-- table owned and populated exclusively by B2's `RawEventAppendStore`
-- (`0001_slice0.sql`). This migration only adds a new table; it does not
-- alter `0001_slice0.sql` in any way.
--
-- `artifact_json` stores the full canonical `ArtifactV0` JSON encoding
-- (schema_version, artifact_id, media_type, encoding, sha256, byte_length,
-- preview, content) so readback returns exactly the value that was
-- written, mirroring how `0001_slice0.sql` stores `raw_events.event_json`.
--
-- `sha256` and `byte_length` are duplicated here as query-able columns for
-- provenance/debugging lookups without deserializing `artifact_json`. They
-- are never treated as the source of truth for integrity: every write and
-- readback re-runs the accepted `validate_artifact_content` check against
-- the actual bytes inside `artifact_json`, so storage-layer corruption of
-- these convenience columns cannot silently pass verification.
CREATE TABLE artifacts (
	artifact_id TEXT PRIMARY KEY,
	source_event_id TEXT NOT NULL REFERENCES raw_events (event_id),
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	sha256 TEXT NOT NULL,
	byte_length INTEGER NOT NULL,
	artifact_json TEXT NOT NULL,
	stored_at TEXT NOT NULL
);

CREATE INDEX artifacts_source_event_id_idx ON artifacts (source_event_id);

CREATE INDEX artifacts_session_id_idx ON artifacts (session_id);
