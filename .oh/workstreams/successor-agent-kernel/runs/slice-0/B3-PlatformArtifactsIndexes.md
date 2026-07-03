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
- Dissent concern:
- Response:
- Outcome:

## Execute

Checklist:
- [ ] owned files only
- [ ] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [ ] no forbidden shortcuts
- [ ] tests/checks added inside owned scope
- [ ] targeted validation passed (`cargo test -p successor-context-platform --test slice0_artifacts` or narrower package-local command chosen by executor)
- [ ] orchestrator-owned `make check-rs` gate run after executor returns, before review dispatch
- [ ] named risks retired or routed
- [ ] model binding verified for execution agent (`slice0-executor`, `anthropic/claude-sonnet-5`, `thinking-level=high`; canary `agent://112-ExecutorRebindCanary`)
- [ ] fixture sovereignty preserved; canonical fixtures not edited or weakened
- [ ] no accepted-module edits without Interface Change Request/reopen protocol
- [ ] all new JSON-boundary DTOs use `#[serde(deny_unknown_fields)]` unless an explicit contract extension map exists
- [ ] workspace lint expectations preserved: `make check-rs` is the orchestrator gate and must be green before review
- [ ] no dispatch over-constraint: implement B3-owned contract semantics directly; do not refuse assigned scope merely because a helper API is not pre-existing

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
