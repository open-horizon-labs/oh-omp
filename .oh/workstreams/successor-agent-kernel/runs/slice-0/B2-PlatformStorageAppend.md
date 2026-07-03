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

If completed:
- Dissent concern:
- Response:
- Outcome:

## Execute

Checklist:
- [ ] owned files only
- [ ] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [ ] no forbidden shortcuts
- [ ] tests/checks added inside owned scope or explicitly routed to B6/D2 if route/integration-level
- [ ] targeted validation passed (`cargo test -p successor-context-platform` or narrower package-local command chosen by executor)
- [ ] orchestrator-owned `make check-rs` gate run after executor returns, before review dispatch
- [ ] named risks retired or routed
- [ ] model binding verified for execution agent (`slice0-executor`, `anthropic/claude-sonnet-5`, `thinking-level=high`; canary `agent://112-ExecutorRebindCanary`)
- [ ] fixture sovereignty preserved; canonical fixtures not edited or weakened
- [ ] no accepted-module edits without Interface Change Request/reopen protocol
- [ ] all new JSON-boundary DTOs use `#[serde(deny_unknown_fields)]` unless an explicit contract extension map exists
- [ ] workspace lint expectations preserved: `make check-rs` is the orchestrator gate and must be green before review
- [ ] no dispatch over-constraint: implement B2-owned contract semantics directly; do not refuse assigned scope merely because a helper API is not pre-existing

Changed files:

Validation evidence:

## Code Review

Reviewer:
Reviewer model:
Verdict: [PASS / REVISE / BLOCK]

Findings:
- ...

Fixes applied:
- ...

## Drift Review

Original aim:
Current work:
Gap:
Verdict: [aligned / minor drift / significant drift / lost]
Authority boundary: [clear / ambiguous / crossed]

## Superego Review

Reviewer:
Reviewer model:
Verdict: [ALLOW / REVISE / BLOCK]

Frame risks:
- ...

Required corrections:
- ...

## Delivery

Status: [accepted / needs revision / blocked]
Residual risks:
Human verification needed:
