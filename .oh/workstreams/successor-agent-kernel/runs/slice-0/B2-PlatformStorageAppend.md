# Lane B2 — PlatformStorageAppend

## Model Binding

- Intended execution agent: `slice0-executor` (amended 2026-07-02; active Wave B execution label)
- Intended execution model: `anthropic/claude-sonnet-5`, `thinking-level=high` (user-accepted 2026-07-02 roster amendment; runbook §2.5)
- Coder roster note: `slice0-coder` remains `anthropic/claude-sonnet-4-6`, `thinking-level=high`; do not use it as evidence for the active execution lane unless explicitly dispatched as coder support.
- Resolved execution model evidence: Sonnet 5 three-gate experiment and promotion recorded in `SLICE-0-MODEL-CANARY.md` §14; durable rebind canary `agent://112-ExecutorRebindCanary` passed with exact `anthropic-claude-sonnet-5-high` echo; pre-lane fixture slice evidence `agent://111-Sonnet5Gate3FixtureBundle`.
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`).
- Drift reviewer model: `slice0-drift-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://18-PermanentDriftReviewerCanary`).
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`).
- Binding verdict: verified.

## Durable Law / Review Learnings preflight

Before acting, the executor, code reviewer, drift reviewer, Superego reviewer, and verifier must read and apply the FULL `.oh/workstreams/successor-agent-kernel/SLICE-0-REVIEW-LEARNINGS.md` §1–13, not selected excerpts or memory summaries.

Lane-relevant consequences:
- Append request boundaries must reject or omit platform-assigned fields such as `session_seq`; only the platform store may assign dense per-session sequence numbers, while append responses/persisted records report assigned sequence, duplicate status, stored timestamp, and source/artifact IDs as applicable.
- Constrained values at storage/append JSON boundaries must use typed validating serde boundaries, not helper-only validation that invalid JSON can bypass.
- Credential scanning must inspect high-confidence credential-looking string values as well as keys before raw events, artifacts, traces, or storage rows are accepted.
- Any fix for a prior review defect needs a targeted regression test or fixture assertion that would have failed before the correction, especially unknown fields, platform-assigned fields, typed validation, and credential leakage.
- B2 depends on the B1 crate shell/module surface; B2 must not declare/export B2 modules by editing B1-owned `lib.rs`, `http.rs`, `auth.rs`, or `error.rs`.
- Regression evidence must name the review-learning class corrected and the validation command/result.

## Fan-out / Dependency Order

Required execution order: B1 runs before B2 for execution purposes. The only safe parallelization condition is explicit orchestration where B1 first lands the minimal `lib.rs`/`http.rs`/`auth.rs`/`error.rs` shell and module declarations B2 needs to compile and test, after which B2 may work only in B2-owned files. Final Wave B fan-out: B1 shell/auth first; B2 storage append after the B1 shell; B3/B4/B5 after the B2 storage surface they consume (B4 also after B3 where artifact reads are required; B5 preferably after B4 trace/projection substrate); B6 last after B1–B5 are accepted.

## Aim

- Outcome: implement the platform append/session/idempotency storage foundation that assigns dense per-session sequence numbers transactionally and persists canonical raw events without trusting client-assigned platform fields.
- Contract clause(s) served: contract §2.1 raw event log is truth; §3 ordering authority; §4 RawEvent required rules for platform-assigned `session_seq`, causation, idempotency, and credential exclusion; §6.1 create session; §6.2 append raw event; dispatch map §4.2 platform-internal `RawEventAppendStore`; Wave B gate 3 platform sequence assignment.
- Fixture(s) served: `raw-events-successful-turn.json`, `raw-events-unsupported-tool.json`, `session-snapshot.json` as downstream storage/replay inputs; adversarial duplicate idempotency, future causation, future reference, credential-looking value, and client-supplied `session_seq` cases.
- Files owned:
  - `crates/successor-context-platform/src/store.rs`
  - `crates/successor-context-platform/src/sqlite.rs`
  - `crates/successor-context-platform/src/session.rs`
  - `crates/successor-context-platform/src/idempotency.rs`
  - `crates/successor-context-platform/migrations/0001_slice0.sql`
- Explicit non-goals: HTTP route wiring, auth extraction, artifact API/index behavior beyond append-time integrity hooks, projection/replay, assembly/retrieval, kernel/CLI code, protocol/fixture/contract edits, and model-binding changes.

## Problem Space

- Current state: A0–A5 are accepted/closed on branch `successor-main` (`b1f037dbc`, `dbc6eff42`, `25f1306fc`); `cargo test -p successor-protocol` is green and `make check-rs` exits 0. B2 is the first lane that makes platform persistence semantics real.
- Constraints: raw events are canonical persisted truth; `session_seq` is platform-assigned and dense per session; duplicate `(session_id, idempotency_key)` returns the existing append result with `duplicate=true`; causation must reference earlier raw events in the same session; provider credentials and `MEMEX_LICENSE` values must not be stored; SQLite details must not leak into protocol/kernel/CLI crates.
- Named risks: accepting client-supplied `session_seq`; non-transactional sequence races; idempotency returning divergent events for the same key; treating provider wire objects or frames as canonical storage; storing credential-looking payload/artifact content without accepted validator checks; migration choices becoming irreversible without dissent.
- Edge cases: first event in a session; duplicate idempotency key with byte-identical vs different payload; cross-session causation; same/future causation; gaps under concurrent appends; rollback after artifact/hash validation failure; unknown fields at append boundary; stable error mapping for conflicts and validation failures.
- Interface dependencies: import accepted A1/A2/A4/A5 protocol types and validators from `successor-protocol`, especially `RawEventV0`, `RawEventAppendRequestV0`, `RawEventAppendResponseV0`, IDs, `ErrorEnvelopeV0`, artifact hash/length validation, `validate_append_candidate`, and fixture validation reports as available.
- Authority boundaries: B2 owns platform storage/session/idempotency/migration internals only. It may define private row structs and SQL schema but must convert at the protocol boundary. Any need to change `successor-protocol`, canonical fixtures, `SLICE-0-CONTRACT.md`, or accepted A-lane modules requires the Interface Change Request/reopen protocol.
- Ambiguities to record, not resolve: dispatch gives B2 artifact integrity in its gate while B3 owns artifact store/index files. B2 may validate inline append artifacts enough to preserve raw-event integrity, but durable artifact API/index behavior belongs to B3.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Transactional SQLite append store with typed protocol boundaries | Retires sequence/idempotency risk and matches contract substrate | Requires migration discipline | selected |
| In-memory append store first | Faster to code | Does not retire storage/replay acceptance risk | insufficient for Wave B platform foundation |
| Let kernel assign sequence and platform persist as-is | Simple | Violates platform ordering authority | contract violation |

Selected approach: create a platform-local storage layer backed by the B2 migration, allocate `session_seq` inside the same transaction as idempotency/raw-event persistence, reject or ignore client-supplied platform-assigned fields per accepted protocol API, and expose only protocol DTOs/errors to route consumers.

Invalidated if: dense sequence/idempotency cannot be made transactional in the owned storage files, or accepted append DTOs expose unavoidable platform-assigned fields to clients contrary to review-learning §6.

Stop/pivot if: satisfying storage semantics requires editing accepted protocol append DTOs, canonical fixtures, contract text, auth/route/assembly files, or implementing non-owned artifact/projection behavior.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; Wave B runbook requires dissent when touching storage semantics, sequence assignment, and irreversible storage/migration choices.

If completed (task 130-B2PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof at `fbca17a09`):
- Dissent concern: migration schema is the real one-way door; seq/idempotency races hide outside a single writer transaction; two packet boundary assumptions were false in the current checkout — B1's `lib.rs` declares no B2 modules, and the owned-file list excludes the Cargo manifest a SQLite driver requires.
- Response: contract §1 recommends `SQLite + sqlx`; B1 already landed tokio/axum, so an async sqlx store aligns runtime and contract. Contract §2.1/§3/§4/§6.2 and dispatch §4.2 decide duplicate semantics; protocol error text says `DuplicateIdempotencyKey` is for key reuse with a DIFFERENT payload, so byte-identical replays return the stored result.
- Outcome: PROCEED with orchestrator rulings: (1) controlled `lib.rs` expansion granted per the A2/A3 Wave A precedent — B2 may append module declarations/exports for its four modules ONLY, never editing existing B1 lines; (2) `crates/successor-context-platform/Cargo.toml` + `Cargo.lock` authorized as disclosed bootstrap artifacts for the sqlx dependency; (3) driver ruling: sqlx (async surface); a sync/rusqlite pivot requires explicit rationale plus concurrent-append tests; (4) one writer transaction covers idempotency check, seq allocation, validation, and persistence, backed by durable unique constraints on `(session_id, session_seq)`, `(session_id, idempotency_key)`, and `event_id`; (5) idempotency fingerprint is canonical bytes excluding platform-assigned fields — same key + same fingerprint returns the stored response with `duplicate=true`; same key + different fingerprint returns `DuplicateIdempotencyKey` without allocating a sequence; (6) append-time credential/structure validation reuses accepted A1/A5 protocol validators; no scanner re-implementation.

## Execute

Checklist:
- [x] owned files only (plus granted lib.rs module-declaration expansion and disclosed bootstrap artifacts)
- [x] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [x] no forbidden shortcuts
- [x] tests/checks added inside owned scope (16 new storage tests; route/integration checks routed to B6)
- [x] targeted validation passed (`cargo test -p successor-context-platform` 38/38)
- [x] orchestrator-owned `make check-rs` gate run after executor returned: exit 0 before review dispatch
- [x] named risks retired or routed (seq races closed by single-writer transaction + constraints; duplicate semantics per dissent ruling 5)
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; task 131)
- [x] fixture sovereignty preserved; no fixture edits
- [x] no accepted-module edits
- [x] no new public JSON-boundary DTOs (protocol DTOs reused; storage rows are private)
- [x] workspace lint gate green before review
- [x] no dispatch over-constraint; B2-owned semantics implemented directly

Changed files:
- New: `crates/successor-context-platform/src/{store.rs, sqlite.rs, session.rs, idempotency.rs}`, `crates/successor-context-platform/migrations/0001_slice0.sql`
- Granted expansion: `lib.rs` — exactly four appended module declarations (`idempotency`, `session`, `sqlite`, `store`)
- Bootstrap artifacts (disclosed): `Cargo.toml` (sqlx 0.8 runtime-tokio/sqlite/migrate/macros; serde_json promoted from dev-deps), `Cargo.lock` (transitive)

Validation evidence:

## Code Review

Reviewer: `slice0-reviewer` (task 132-B2CodeReview, checkout-proof at `17829098b`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: PASS (`overall_correctness=correct`, confidence 0.86, zero findings)

Findings:
- None. Transactional integrity, fingerprint semantics, validator reuse, and boundary hygiene all confirmed; reviewer independently reran the 38-test suite.

Fixes applied:
- None required.

## Drift Review

Original aim: transactional append/session/idempotency storage foundation, storage-internal only.
Current work: task 131 implementation as committed at `17829098b`.
Gap: none material (task 133-B2DriftReview; minor notes only — granted module exports, storage-internal read/page methods for later consumers).
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 134-B2SuperegoReview, checkout-proof at `17829098b`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: ALLOW

Frame risks:
- None found: RawEventV0 remains stored canonical truth; migration one-way doors explicit; six dissent rulings honored; bootstrap surface matches disclosure.

Required corrections:
- None.

## Delivery

Status: accepted
Residual risks:
- The single-connection pool is the durable serialization mechanism; raising `max_connections` without adding BEGIN IMMEDIATE/busy-retry logic would reopen seq-race exposure (documented in `sqlite.rs` and the migration comments; constraints provide the backstop).
- Live HTTP wiring of the store lands with B6 route-contract checks.
Human verification needed:
- None outstanding.
