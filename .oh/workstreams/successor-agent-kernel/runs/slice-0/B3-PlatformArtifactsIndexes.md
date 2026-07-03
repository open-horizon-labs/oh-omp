# Lane B3 — PlatformArtifactsIndexes

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
- Artifact hash and byte-length invariants must live in typed validating serde/storage boundaries; helper-only validation is insufficient if malformed fixture JSON can deserialize.
- Canonical artifact-bearing fixtures must deserialize and reserialize exactly before helper constructors or indexes are trusted; tests must assert drifted field names or malformed hashes/lengths are rejected, not only that accepted examples pass.
- Credential scanning must inspect artifact/source content for high-confidence credential-looking values as well as keys before content enters artifact/source indexes or replay-visible projections.
- ID prefixes used or checked by artifact/source indexes must be copied from `SLICE-0-CONTRACT.md` (`art_`, `src_`, `evt_`, `ctx_`, etc.); tests must catch prefix drift.
- B3 must not edit B2-owned migration files without an explicit orchestration split/ICR; if artifact indexing requires schema changes beyond B2-provided surfaces, stop and route the dependency instead of patching `0001_slice0.sql`.
- Provider wire objects, previews, or filesystem paths are never canonical artifact truth; stored inline bytes plus hash/length are the replay source.

## Fan-out / Dependency Order

Required execution order: B1 shell/auth first, then B2 storage append. B3 executes only after B2 exposes the storage/session/artifact-association surface B3 consumes. The only B1/B2 safe-parallel exception is that B1 must first land the minimal shell/module declarations and B2 must never edit B1-owned files. Final Wave B fan-out: B1; B2; then B3/B4/B5 subject to their storage/artifact/projection dependencies; B6 last after B1–B5 are accepted.

## Aim

- Outcome: implement inline artifact persistence and source/artifact indexes for the context platform so stored artifacts are hash/length verified, retrievable by artifact ID, and available to replay without re-reading workspace files.
- Contract clause(s) served: contract §2.1 raw event log/artifact handles as truth-derived projections; §2.2 replay must not re-run filesystem reads; §4 artifact hash and locator rules; §6.5 read artifact; §12 fixture artifact hash/byte-length rules; dispatch map §4.2 `ArtifactStoreV0` trait and platform validation gates.
- Fixture(s) served: inline artifact objects embedded in `raw-events-successful-turn.json` and `raw-events-unsupported-tool.json`; `expected-session-projection.json` artifact/source handles; adversarial placeholder hash, wrong byte length, content mismatch, future source/artifact reference, and credential-looking artifact content cases.
- Files owned:
  - `crates/successor-context-platform/src/artifacts.rs`
  - `crates/successor-context-platform/src/source_index.rs`
  - `crates/successor-context-platform/tests/slice0_artifacts.rs`
- Explicit non-goals: SQLite migration/schema ownership except through B2-provided store contracts, raw event append/idempotency, HTTP route wiring, auth, projection/replay semantics beyond artifact/source lookup support, assembly retrieval ranking, kernel/CLI code, protocol/fixture/contract edits, and model-binding changes.

## Problem Space

- Current state: A0–A5 are accepted/closed on branch `successor-main` (`b1f037dbc`, `dbc6eff42`, `25f1306fc`); `cargo test -p successor-protocol` is green and `make check-rs` exits 0. The contract allows Slice 0 artifact content embedded inside raw-event fixture `artifact` objects, while platform APIs expose artifact handles.
- Constraints: artifact content is inline for Slice 0; hash is canonical `sha256:<64 lowercase hex>` over exact bytes; byte length must match exact bytes; replay must use stored raw events/artifacts only and must not re-read workspace files; artifact/source indexes must not retain provider credentials or raw platform entitlement tokens.
- Named risks: treating artifact previews as content; recalculating artifacts from filesystem paths during replay; accepting malformed hash/length at DTO boundary; leaking credential-like content through source indexes; crossing into B2 storage migration or B4 replay logic; assuming detached object storage not present in Slice 0 fixtures.
- Edge cases: inline artifact without assigned `artifact_id` in raw-event fixture flow; duplicate content/hash across events; wrong digest with correct length; correct digest with wrong byte length; binary-looking content policy if surfaced from future tool lane; missing artifact referenced by projection; source/artifact references to future events.
- Interface dependencies: import accepted A1 artifact/raw-event ID and hash types, A4 projection/source expectations, and A5 validation helpers from `successor-protocol`; consume B2 storage/session APIs for persisted event/artifact association once B2 is accepted.
- Authority boundaries: B3 owns artifact/source index implementation and tests only. It must not define alternate `ArtifactV0`, `ArtifactHash`, source envelope, raw-event, or projection DTOs. Any need to change accepted protocol/fixtures or B2 migration ownership requires orchestrator routing and, for accepted A-lane changes, the Interface Change Request/reopen protocol.
- Ambiguities to record, not resolve: dispatch does not specify whether B3 may amend B2 migration tables for artifact indexes. Treat migration changes as B2-owned; if B3 needs schema changes, stop for orchestrator split/ICR rather than editing `0001_slice0.sql` directly.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Inline artifact store over B2 persistence with protocol hash verification | Matches Slice 0 fixtures and replay contract | Requires coordination with B2 schema/API | selected |
| Detached object store abstraction now | Future-friendly | Out of scope and not fixture-backed | violates Slice 0 inline-artifact scope |
| Re-read workspace paths for artifact content | Easy for smoke | Non-deterministic and side-effectful replay | contract violation |

Selected approach: store/retrieve inline `ArtifactV0` values associated with prior raw events, build source/artifact indexes from persisted raw event facts, and prove hash/length/content invariants without re-reading the workspace.

Invalidated if: artifact API cannot return exact stored inline content and verified hash/length using only B2 platform storage, or canonical fixture artifact semantics require detached files not present in the contract.

Stop/pivot if: implementation requires editing B2-owned migrations/store internals without a split decision, accepted protocol artifact DTOs, canonical fixtures, contract text, or non-owned projection/assembly route files.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; Wave B runbook requires dissent when touching artifact retention.

If completed:
- Dissent concern (task 135-B3PreExecutionDissent, PROCEED-WITH-CONDITIONS, checkout-proof `5daa6f802`): no B3 modules declared in `lib.rs`; `0001_slice0.sql` is B2-owned; durable artifact persistence is not implementable from B3's listed files alone; sha256-dedup storage is a dangerous one-way door not demanded by fixtures.
- Response: contract/fixtures require exact inline artifact bytes returned with matching `sha256:<64 hex>`/`byte_length`; accepted protocol already provides `ArtifactV0`/`ArtifactHash`/`validate_artifact_content`; B2's `RawEventAppendStore` owns raw-event truth and read/page.
- Outcome: PROCEED with orchestrator rulings: (1) `lib.rs` expansion granted for exactly `pub mod artifacts;` and `pub mod source_index;`; (2) new B3-owned migration `migrations/0002_slice0_artifacts.sql` granted; `0001` untouchable; (3) B3 may define its own artifact store trait/impl over the existing SQLite pool type consumed via B2's exported constructors — no B2 file edits; raw-event truth stays behind `RawEventAppendStore`; source indexes are projections derived from `read_session_events`/`read_event`; (4) storage model is artifact-ID/provenance-first with exact inline bytes; sha256-dedup prohibited as canonical identity; hash/length verified via accepted `validate_artifact_content` on write and readback; (5) no new Cargo dependency.

## Execute

Checklist:
- [x] owned files only (plus granted lib.rs two-line expansion, B3-owned migration 0002, and the authorized narrow A5 validation.rs reopen for the credential-scan surface)
- [x] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [x] no forbidden shortcuts
- [x] tests/checks added inside owned scope (artifact round-trip, coherence, corruption, conflict, scan regressions)
- [x] targeted validation passed (`cargo test -p successor-context-platform` 52/52; protocol suites green)
- [x] orchestrator-owned `make check-rs` gate green before each review dispatch and at final state (`1be14f1eb`)
- [x] named risks retired or routed (dedup one-way door prohibited; provenance coherence enforced; scan false-positive surface narrowed)
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; tasks 136, 140)
- [x] fixture sovereignty preserved; no fixture edits
- [x] accepted-module edits only under the authorized reopen protocol (A5 `validation.rs`: public `scan_artifact_content`, one implementation two entry points)
- [x] no new public JSON-boundary DTOs (protocol `ArtifactV0` reused; rows private)
- [x] workspace lint gate green before review
- [x] no dispatch over-constraint

Changed files:
- New: `crates/successor-context-platform/src/{artifacts.rs, source_index.rs}`, `crates/successor-context-platform/migrations/0002_slice0_artifacts.sql`
- Granted expansion: `lib.rs` — exactly two appended module declarations (`artifacts`, `source_index`)
- Authorized narrow reopen: `crates/successor-protocol/src/validation.rs` — public `scan_artifact_content` + assignment-shaped credential detection helpers + discrimination unit test

Validation evidence:
- `cargo test -p successor-context-platform`: 52/52 green (round-trips from canonical fixtures byte-exact; hash mismatch, corruption-on-readback, duplicate-id conflict, unknown-id, coherence and scan regressions)
- `cargo test -p successor-protocol`: all suites green; pre-existing tests unmodified
- `make check-rs` exit 0 at `3b8ea338f`, `bfa43c5a2`, and final `1be14f1eb`

## Code Review

Reviewer: `slice0-reviewer` (tasks 139-B3CodeReview at `3b8ea338f`; 141-B3FixReReview at `bfa43c5a2`; checkout-proof both)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: PASS after two fix rounds

Findings:
- Task 139, P1: `put_inline_artifact` bypassed credential scanning (a test locked in accepting AWS-secret content); P1: provenance accepted any existing event/session pair without coherence proof.
- Task 141: confirmed both P1s closed; found the new substring scan over-broad — bare credential key words in legitimate tool output would be rejected (P1).

Fixes applied:
- Task 140 (`bfa43c5a2`): authorized A5 reopen exposing `scan_artifact_content` (delegating to the existing scanner); coherence checks on the same serialized connection (event exists, belongs to session, references the artifact_id, inline hash matches); AWS-secret test flipped to rejection; cross-session/non-producing/hash-mismatch regressions.
- Orchestrator (`a4762f140`, `1be14f1eb`): narrowed substring mode to assignment-shaped leaks (key pattern + `=`/`:` + secret-like literal ≥16 chars, excluding code-call and placeholder shapes) with a discrimination test using the reviewer's exact false-positive examples; clippy clean.

## Drift Review

Original aim: durable artifact persistence + provenance/source indexes, artifacts-internal only.
Current work: tasks 136+140 as committed through `1be14f1eb`.
Gap: none material (task 137-B3DriftReview: minor drift — the credential-scan gap flagged as routed ambiguity, resolved via the authorized reopen).
Verdict: minor drift, resolved
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 138-B3SuperegoReview, checkout-proof at `3b8ea338f`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Frame risks:
- Provenance not session-coherent at the storage boundary (an artifact could claim authorship from an unrelated session/event).

Required corrections:
- Enforce source_event_id/session_id coherence at the write boundary with cross-session regression tests — applied in task 140, verified green.

## Delivery

Status: accepted
Residual risks:
- The assignment-shaped narrowing was orchestrator-applied per the reviewer's named examples and defended by a discrimination test, but not put through a fourth review round (recorded, consistent with the B1 mechanical-closure precedent).
- `is_secret_like_token` heuristics (≥16 chars, no parens/placeholders) are conservative; genuinely short secrets in assignment shape pass the substring mode but remain covered by value-pattern scanning where provider-shaped.
- Readback re-validation on every artifact read is an integrity-over-throughput tradeoff; revisit only if B5/B6 profiling shows it hot.
Human verification needed:
- None outstanding.
