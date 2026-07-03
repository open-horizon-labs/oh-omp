# Lane B4 — PlatformProjectionReplay

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
- RawEvent remains canonical persisted truth; KernelFrame and session/trace projections are live or rebuildable views and must not become peer persisted truth.
- Projection assertions must be derived from canonical fixtures and exact replay expectations, including byte-identical session projection/snapshot behavior, not from invented DTO shapes or remembered field names.
- ID-prefix checks must guard every consumed family (`evt_`, `frame_`, `msg_`, `tool_`, `src_`, `art_`, `asm_`, `ctx_`, `trace_`, `err_`, `pevt_`) against descriptive-prefix drift.
- If accepted A-lane protocol/projection types are too narrow for canonical fixtures, B4 must stop and reopen the owning accepted lane with targeted review; it must not add a downstream wrapper or local relaxed DTO.
- Replay must not re-run providers, tools, filesystem reads, network calls, embeddings, clocks, or random ID generation; only stored raw events/artifacts feed projection rebuilds.
- Credential-looking values must not leak through snapshots, projection stores, trace indexes, or replay errors.

## Fan-out / Dependency Order

Required execution order: B1 shell/auth first, then B2 storage append. B4 executes after B2 and after B3 wherever replay needs artifact/source lookup. The only B1/B2 safe-parallel exception is that B1 must first land the minimal shell/module declarations and B2 must never edit B1-owned files. Final Wave B fan-out: B1; B2; B3 before B4 artifact-backed replay; B5 after B2/B3 and preferably B4 trace/projection substrate; B6 last after B1–B5 are accepted.

## Aim

- Outcome: implement platform projection/replay support so an empty projection store can rebuild session snapshots, projections, and trace indexes from persisted raw events and artifacts only.
- Contract clause(s) served: contract §2.2 deterministic replay provenance bar; §6.6 get session snapshot; §11 resume semantics; §12 fixture replay to `expected-session-projection.json`; dispatch map §4.2 platform validation gate for replay/snapshot from raw events + artifacts; Wave B gate 3 raw events/artifacts replay deterministically.
- Fixture(s) served: `raw-events-successful-turn.json`, `raw-events-unsupported-tool.json`, `session-snapshot.json`, `expected-session-projection.json`, and downstream trace/snapshot expectations; adversarial projection mismatch and missing artifact/reference cases.
- Files owned:
  - `crates/successor-context-platform/src/projection.rs`
  - `crates/successor-context-platform/src/replay.rs`
  - `crates/successor-context-platform/src/trace_index.rs`
  - `crates/successor-context-platform/tests/slice0_replay.rs`
- Explicit non-goals: modifying pure protocol replay algorithms owned by accepted A4, raw event append storage, artifact store/index internals, HTTP route wiring, auth, assembly retrieval, provider/kernel/CLI behavior, protocol/fixture/contract edits, and model-binding changes.

## Problem Space

- Current state: A0–A5 are accepted/closed on branch `successor-main` (`b1f037dbc`, `dbc6eff42`, `25f1306fc`); `cargo test -p successor-protocol` is green and `make check-rs` exits 0. A4 owns pure in-memory protocol projection; B4 must apply it to platform persisted raw events/artifacts without changing protocol semantics.
- Constraints: replay must not re-run providers, tools, filesystem reads, network calls, embeddings, clocks, or random ID generation; raw events remain canonical persisted truth; KernelFrame is live-only; projection functions must be deterministic and versioned; snapshots/traces must not leak provider credentials or raw `MEMEX_LICENSE` values.
- Named risks: platform projection diverges from A4 pure replay; replay reads workspace paths or replays tools; trace index becomes peer truth instead of projection; snapshot omits artifact/source handles needed by resume; changing projection semantics without versioning; conflating live frames with persisted raw events.
- Edge cases: empty session; unsupported-tool failure path; missing artifact referenced by raw event; duplicate idempotent events; out-of-order storage read; projection store rebuild after deletion; byte-identical canonical JSON comparison; live-only provider deltas absent from raw event log.
- Interface dependencies: consume B2 raw-event store and B3 artifact/source index once accepted; import A4 `project_session`, canonical JSON helper, projection DTOs, session snapshot DTOs, trace IDs, and validation reports from `successor-protocol`.
- Authority boundaries: B4 owns platform application of accepted replay/projection semantics and trace indexes. It must not modify A4 protocol projection logic locally, define alternate projection DTOs, persist KernelFrames as truth, or add side-effectful replay paths. Accepted protocol changes require Interface Change Request/reopen protocol.
- Ambiguities to record, not resolve: dispatch names `trace_index.rs` here, while assembly traces are also served by B5/B6. B4 should own trace index persistence/projection substrate; B5 owns assembly trace content and retrieval-stage semantics.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Platform replay adapter over accepted A4 pure projection | Keeps one projection semantics source | Requires clean conversion from B2/B3 stores | selected |
| Reimplement projection rules in platform crate | Local convenience | Risks divergence and duplicate DTO/semantics | violates stable-interface discipline |
| Build snapshot incrementally as mutable truth | Fast reads | Makes projection store peer truth | violates raw-event truth invariant |

Selected approach: load persisted raw events/artifacts through B2/B3 interfaces, feed accepted A4 replay/projection logic, persist only rebuildable projection/trace indexes, and prove rebuild from an empty projection store matches canonical fixture outputs.

Invalidated if: accepted A4 replay cannot consume platform persisted data without changing protocol semantics, or platform snapshot requires side effects not already recorded in raw events/artifacts.

Stop/pivot if: implementation needs to edit accepted A4 modules, canonical fixtures, contract text, B2/B3-owned storage files, or route/assembly/kernel code to pass.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; Wave B runbook requires dissent when touching replay/snapshot semantics.

If completed (task 142-B4PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof `65b7482dc`):
- Dissent concern: platform-side projection risks duplicating A4's accepted pure replay, creating a second truth plane via persisted projections/snapshots, and pre-owning B6 routes; no B4 modules are declared in `lib.rs`.
- Response: contract §2.1/§2.2 make persisted RawEvents canonical and projections rebuildable-on-demand views; dispatch §4.2 requires replay/snapshot from raw events + artifacts matching canonical fixtures; A4's `project_session` is the accepted projection; B2/B3 already expose reads and on-demand source indexes.
- Outcome: PROCEED with orchestrator rulings: (1) `lib.rs` expansion granted for exactly `pub mod projection;`, `pub mod replay;`, `pub mod trace_index;` — no other edits; (2) no new migration, projection/snapshot/trace table, or Cargo dependency — always-replay on-demand derivation only; if durable projection state ever seems needed, STOP and route the design decision; (3) reuse seam is binding: load ordered `Vec<RawEventV0>` via B2's `RawEventAppendStore`, call accepted A4 `project_session`, map into platform `SessionSnapshotV0`/derived indexes — never copy A4 match logic; if A4 is too narrow (e.g. unsupported-tool/error projection), that is an authorized narrow A4 reopen, not a platform-local implementation; (4) no route ownership — B4 exposes service-level functions B6 wires later; no duplicate event-page reads; `trace_index` stays minimal/derived as substrate for B5/B6; (5) surface limited to replay adapter + snapshot projection + fixture-derived proof.

## Execute

Checklist:
- [ ] owned files only
- [ ] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [ ] no forbidden shortcuts
- [ ] tests/checks added inside owned scope
- [ ] targeted validation passed (`cargo test -p successor-context-platform --test slice0_replay` or narrower package-local command chosen by executor)
- [ ] orchestrator-owned `make check-rs` gate run after executor returns, before review dispatch
- [ ] named risks retired or routed
- [ ] model binding verified for execution agent (`slice0-executor`, `anthropic/claude-sonnet-5`, `thinking-level=high`; canary `agent://112-ExecutorRebindCanary`)
- [ ] fixture sovereignty preserved; canonical fixtures not edited or weakened
- [ ] no accepted-module edits without Interface Change Request/reopen protocol
- [ ] all new JSON-boundary DTOs use `#[serde(deny_unknown_fields)]` unless an explicit contract extension map exists
- [ ] workspace lint expectations preserved: `make check-rs` is the orchestrator gate and must be green before review
- [ ] no dispatch over-constraint: implement B4-owned contract semantics directly; do not refuse assigned scope merely because a helper API is not pre-existing

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
