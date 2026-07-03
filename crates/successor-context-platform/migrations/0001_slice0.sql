-- Slice 0 platform storage: sessions, the raw-event append ledger, and
-- idempotency-key records.
--
-- Design notes
-- ------------
-- `raw_events` stores the full canonical `RawEventV0` as JSON in `event_json`
-- so the store never has to reconstruct a typed event from decomposed
-- columns. Three columns are denormalized out of that JSON purely to carry
-- the durable uniqueness invariants the append boundary must enforce:
--   - `event_id`      is the primary key: an event identifier is globally
--                      unique across every session.
--   - `(session_id, session_seq)` is UNIQUE: the platform assigns a dense,
--                      gapless per-session sequence number at append time.
--   - `(session_id, idempotency_key)` is UNIQUE: a client-supplied
--                      idempotency key identifies at most one persisted
--                      event within a session.
--
-- `idempotency_keys` is a second table, not just an index, because a
-- duplicate-key request must be answered with the *original* stored
-- response (byte-identical replay support) and must be told apart from a
-- same-key/different-payload conflict. Neither the original response object
-- nor the content fingerprint used for that comparison belongs on the event
-- ledger itself, so they live here instead. `idempotency_keys` duplicates
-- the `(session_id, idempotency_key)` uniqueness constraint as its primary
-- key; this is intentional defense in depth, not redundant schema drift --
-- the two tables are written in the same transaction and are expected to
-- stay in lockstep.
--
-- `sessions.last_session_seq` is the atomic counter used to allocate the
-- next `session_seq` for a session (`UPDATE ... SET last_session_seq =
-- last_session_seq + 1 ... RETURNING last_session_seq`), executed inside the
-- single writer transaction that also performs the idempotency check,
-- structural/causation validation, and the `raw_events` insert.

CREATE TABLE sessions (
	session_id TEXT PRIMARY KEY,
	workspace_json TEXT NOT NULL,
	title TEXT NOT NULL,
	created_by_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_session_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE raw_events (
	event_id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	session_seq INTEGER NOT NULL,
	idempotency_key TEXT NOT NULL,
	event_json TEXT NOT NULL,
	stored_at TEXT NOT NULL,
	UNIQUE (session_id, session_seq),
	UNIQUE (session_id, idempotency_key)
);

CREATE INDEX raw_events_session_seq_idx ON raw_events (session_id, session_seq);

CREATE TABLE idempotency_keys (
	session_id TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	event_id TEXT NOT NULL REFERENCES raw_events (event_id),
	response_json TEXT NOT NULL,
	PRIMARY KEY (session_id, idempotency_key)
);
