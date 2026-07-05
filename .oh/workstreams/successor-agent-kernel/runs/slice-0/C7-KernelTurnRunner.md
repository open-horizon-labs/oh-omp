# Lane C7 — KernelTurnRunner

## Model Binding

- Intended execution agent: `slice0-executor` (active Wave C execution label)
- Intended execution model: `anthropic/claude-sonnet-5`, `thinking-level=high` (user-accepted 2026-07-02 roster amendment; runbook §2.5)
- Coder roster note: `slice0-coder` remains `anthropic/claude-sonnet-4-6`, `thinking-level=high`; do not treat it as the active execution-lane binding unless explicitly dispatched as coder support.
- Resolved execution model evidence: Sonnet 5 three-gate experiment and promotion recorded in `SLICE-0-MODEL-CANARY.md` §14; durable rebind canary `agent://112-ExecutorRebindCanary` passed with exact `anthropic-claude-sonnet-5-high` echo; pre-lane fixture slice evidence `agent://111-Sonnet5Gate3FixtureBundle`.
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`).
- Drift reviewer model: `slice0-drift-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://18-PermanentDriftReviewerCanary`).
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`).
- Binding verdict: verified.

## Durable Law / Review Learnings preflight

Before acting, the executor, code reviewer, drift reviewer, Superego reviewer, and verifier must read and apply the FULL `.oh/workstreams/successor-agent-kernel/SLICE-0-REVIEW-LEARNINGS.md` §1–13, not selected excerpts or memory summaries.

Lane-relevant consequences:
- Raw events are canonical truth; the runner must append accepted raw events through C1/platform and must not treat frames/provider wire/tool outputs as peer truth models.
- The runner must call platform `/assemble` at required phases (`pre_tool`, `post_locator` when locator is used, `post_read`, `final` as applicable) and never construct semantic context from transcript/tool text locally.
- Tool lifecycle must follow contract §9 and fixtures exactly, including unsupported-tool `tool_call.requested` → `tool_call.rejected` → `error.recorded` path.
- Provider credentials from C3/C4 must not enter raw events, artifacts, traces, frames, or error details; provider observations are metadata-only.
- The A4 `project_session` unsupported-tool rejection residual must not be worked around in kernel code. If accepted projection still rejects the canonical unsupported-tool stream, record/reopen the owning protocol/projection lane.
- Regression evidence must prove lifecycle ordering, id prefixes, context path exclusivity, unsupported-tool rejection, credential no-echo, and frame/raw-event boundary.

## Fan-out / Dependency Order

Required staging: C7 runs late. It requires C8 shell/module grant, accepted C1 platform client, C2 frame stream, C3 provider auth, C4 provider projection, C5 tool catalog/read, and C6 discovery tools. It must not start full implementation until those upstream APIs are accepted or explicitly staged with stable seams.

Parallelization: C7 is not a parallel Wave C starter. It is the integration lane for kernel foundation and should execute after C1–C6 acceptance. Full C8 local RPC runs after C7 acceptance. If C7 exposes missing upstream seams, route narrow reopens/grants to owner lanes rather than duplicating client/provider/tool/frame code in runner files.

## Aim

- Outcome: implement the Slice 0 turn runner/state machine so a read-only coding Q&A turn follows the exact platform-assemble → provider → tool → provider → assistant lifecycle with deterministic raw events, live frames, and replayable turn trace.
- Contract clause(s) served: contract §0 execution target; §2.1 raw event truth; §2.3 platform `/assemble` canonical context; §2.4 auth separation; §3 ID/order authority; §4 event types; §5 frame rules; §7 tool catalog/rejection; §8 tool authority; §9 successful turn state machine; §10 provider projection; §13 acceptance criteria 1–12.
- Fixture(s) served: `raw-events-successful-turn.json`, `raw-events-unsupported-tool.json`, `kernel-frame-stream.json`, `assemble-request-pre-tool.json`, `assemble-response-pre-tool.json`, `assemble-request-post-read.json`, `assemble-response-post-read.json`, `session-snapshot.json`, `expected-session-projection.json`, `provider-shape-normalization.json`, and `tool-catalog.json` as integrated lifecycle inputs/outputs.
- Files owned:
  - `crates/successor-kernel/src/runner.rs`
  - `crates/successor-kernel/src/state_machine.rs`
  - `crates/successor-kernel/src/id_factory.rs`
  - `crates/successor-kernel/src/turn_trace.rs`
  - `crates/successor-kernel/tests/slice0_kernel_contract.rs`
- Dependencies: accepted C1–C6 APIs; accepted `successor-protocol` DTOs, IDs, validators, fixture helpers; accepted Wave B platform `/v0` HTTP surface.
- Explicit non-goals: local RPC/SSE route exposure, CLI behavior, platform internals, provider credential storage, new tool authority, semantic retrieval outside `/assemble`, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: all platform endpoints exist and kernel crate is a stub. C7 is where foundation pieces become an observable turn but must not become platform, provider-auth store, tool implementation, or RPC server.
- Constraints: at most one locator and one read tool per turn in Slice 0; unsupported tools produce deterministic rejection/error events; every meaningful fact is a raw event; frames are live projection; no local semantic assembly; provider credentials local only; resume uses platform state.
- Named risks: runner papering over missing C1–C6 APIs; local context construction from transcript/tool text; lifecycle order drift; no-op unsupported tool path; provider credentials in traces/errors; ID prefix drift; treating stream frames as persistence; over-broad tool loop beyond Slice 0.
- Edge cases: path-explicit prompt skips locator; provider asks unsupported tool; provider asks too many tools; read failure after locator; platform append failure mid-turn; `/assemble` degradation/no context; provider failure/rate limit; cancellation/turn failure; duplicate idempotency retry; missing provider credentials; A4 unsupported-tool projection rejection.
- Interface dependencies: C1 append/assemble/fetch client; C2 frame sink; C3 credential resolver; C4 provider projection/adapter; C5/C6 tool APIs; protocol fixture DTOs and IDs.
- Authority boundaries: C7 owns lifecycle orchestration and turn trace only. It may define private state-machine states but must not duplicate platform client, provider auth/projection, or tool implementations.
- Ambiguities to record, not resolve: exact user prompt/provider API seam into C7 is not specified until C8 local RPC lands; idempotency-key strategy and retry behavior need dissent ruling; final-phase `/assemble` usage is contract-listed but fixture examples emphasize pre/post locator/read; A4 unsupported-tool projection residual may block integrated fixture validation.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| State-machine runner over accepted C1–C6 seams | Centralizes lifecycle and preserves ownership | Requires late execution after dependencies | selected |
| Inline missing provider/tool/platform code in runner | Unblocks integration faster | Violates ownership and hides upstream defects | forbidden shortcut |
| Let provider/tool loop construct context directly | Fewer platform calls | Creates second semantic context path | contract violation |

Selected approach: implement a typed state machine and ID factory that orchestrate C1–C6 components, append lifecycle raw events through platform, emit C2 frames, preserve a local turn trace, and fail closed with raw `error.recorded` facts on tool/provider/platform failures.

Invalidated if: accepted upstream APIs cannot express the contract §9 lifecycle or canonical fixtures cannot be satisfied without changing protocol/platform fixtures.

Stop/pivot if: implementation needs to edit upstream lane internals, bypass `/assemble`, weaken unsupported-tool rejection, add tool authority, store provider credentials, or work around A4 projection rejection locally.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C7 touches turn lifecycle, persisted events, frame/event boundary, tool authority, provider observations, and `/assemble` as sole context path.

If completed (task 203-C7PreExecutionDissent, verdict ALLOW / PROCEED-WITH-CONDITIONS, checkout-proof `9eb2f0163`):
- Dissent concern: the composition lane could overclaim "both fixtures replay byte-identically through the same oracle" (false: accepted protocol intentionally rejects the unsupported-tool stream in project_session), derive fixture-pinned UUIDs/timestamps from content or fixture-specific branches, bypass accepted lane boundaries (publish_with, direct read execution, platform internals), or invent an auth-unavailable degraded-turn fixture shape that no canonical artifact pins.
- Response: contract §3 makes IDs opaque prefix-typed values the kernel mints and §9 pins the exact 23-event successful lifecycle order (tool_catalog.published → user_turn.recorded → 3× assembly/provider cycles with two tool lifecycles → provider_response.recorded → assistant_turn.recorded); kernel-frame-stream.json pairs frames to raw events via raw_event_id/raw_event_session_seq (turn_started→seq2 … turn_completed→seq23); platform assigns session_seq (C1 residual); the accepted protocol test raw_events_unsupported_tool_is_rejected_by_project_session documents the A4 rejection as intentional, with validate_unsupported_tool_lifecycle as the sanctioned oracle; C1 residual leaves retry policy to C7 with no contract clause requiring retries; contract §11 resume is reconstruction data, not a C7 runtime capability; C8 owns RPC/SSE.
- Outcome: PROCEED with orchestrator rulings: (1) C7 edits `src/{runner,state_machine,id_factory,turn_trace}.rs` + granted `tests/slice0_kernel_contract.rs` (dispatch-map name; the dissent's `kernel_turn_runner.rs` reference is superseded); no Cargo changes; (2) boundaries binding — platform appends/assemble via C1 `PlatformClient` only, frames via public `FrameSink` constructors only (never `publish_with`), provider projection via C4 surfaces as data, tool execution via C5/C6 catalog dispatch so non-executable tools produce the canonical rejection (no direct read execution from the runner path); (3) identity one-way door — injected `IdFactory` + `Clock` seams are production API (real UUID/time impls in production, fixture-scripted impls in replay tests); no content-derived IDs, no fixture-specific branches in the runner; (4) SPLIT REPLAY ORACLES — successful-turn replay is verified via accepted `project_session` against `expected-session-projection.json` byte-identical; unsupported-tool replay is verified via raw-event byte comparison plus `validate_unsupported_tool_lifecycle`; calling project_session a replay pass for the unsupported-tool stream is prohibited until A2/A4 projection semantics are adjudicated (A4 residual stays routed, not resolved here); (5) scope cuts — single-attempt lifecycle with typed failures (no retry/backoff), no resume engine, no RPC/SSE exposure, live provider strictly opt-in smoke per C4 precedent; NO new canonical fixture for provider-auth-unavailable turns (that requires separate human acceptance); runner exposes a composable API for C8.

## Execute

Checklist:
- [x] owned files only (runner.rs, state_machine.rs, id_factory.rs, turn_trace.rs + granted tests/slice0_kernel_contract.rs); no Cargo changes; TurnInput assembly-query seam ruled in-scope by task 216
- [x] shared protocol IDs/DTOs imported from `successor-protocol`; no local DTO clones (drift tasks 206/224)
- [x] no forbidden shortcuts: no local semantic assembly, no credential persistence, no publish_with bypass (source-level guard tested), no retry/resume/RPC
- [x] tests in granted `tests/slice0_kernel_contract.rs`: 5 contract tests incl. both replay oracles at ruled strength
- [x] targeted validation + orchestrator `make check-rs` exit 0 at `78f672ef8` and `51253b59d`
- [x] named risks retired or routed: lifecycle order proven byte-identically; unsupported-tool rejection proven on the PRODUCED stream; credential no-echo held; A4 residual stays routed (oracle never calls project_session on that stream)
- [x] model binding verified (`slice0-executor`, Sonnet 5; tasks 204/205/209/211/213/215/217/220/221/222)
- [x] fixture sovereignty preserved BY GOVERNANCE: two contradictions surfaced and resolved via approved sovereign amendments `1db794108` (search_files values, pre-C7) and `abe0fcb44` (degradation arrays; dissent task 218 + human acceptance + sovereignty ratified in task 225)

Changed files:
- `crates/successor-kernel/src/{runner.rs, state_machine.rs, id_factory.rs, turn_trace.rs}`, new `tests/slice0_kernel_contract.rs`; commits `7703f59ec` (lane), `3504e8aa5` (oracle revision), `78f672ef8` (lint gate), `51253b59d` (doc closure)

Validation evidence:
- Both oracles at full ruled strength: 23/23 raw events (task-210 bijection over platform-minted ids + task-214 idempotency exclusion with production assertions), 10/10 frames vs kernel-frame-stream.json, serialized project_session byte-identical to expected-session-projection.json; unsupported-tool via execute_turn with the task-212 four-class exclusion, each pinned by production-rule assertions, validate_unsupported_tool_lifecycle on the PRODUCED stream. 186+ kernel tests; `make check-rs` exit 0.

## Code Review

Reviewer: `slice0-reviewer` (round 1 task 207 at `7703f59ec`; round 2 task 223 at `78f672ef8`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: round 1 incorrect (two P1s), closed; round 2 PASS (`correct`, zero findings, 0.87 — reviewer re-ran the contract suite)

Findings:
- [P1] successful-turn oracle compared only type/kind sequences, not bytes; [P1] unsupported-tool fallback validated the fixture, not the produced stream.

Fixes applied:
- Tasks 209-222 under four binding Superego adjudications (210 bijection, 212 isolated-tail, 214 idempotency/visibility/projection_version, 216 assembly payloads); genuine runner defects fixed en route (visibility table, PROJECTION_VERSION, provider_event_id threading, context_item_ids, frame refs/causation/entity_ids at all 10 sites, phase-shaped payloads); sovereign fixture amendment #2 (`abe0fcb44`).

## Drift Review

Original aim: exact Slice 0 lifecycle runner over accepted platform/provider/tool/frame seams.
Current work: tasks 204-222 through `51253b59d`.
Gap: round 1 (task 206) minor drift — the weakened oracle was an unrecorded acceptance-rule change; round 2 (task 224): recording gap closed — the oracle law is a documented ruling trail in the test module with production-rule assertions.
Verdict: aligned (round 2)
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (round 1 task 208; round 2 task 225 at `78f672ef8`; adjudications tasks 210/212/214/216/218)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: round 1 REVISE, closed; round 2 REVISE on one doc-only item, closed

Frame risks:
- Round 1: execute_turn dropped TurnTrace on failure (observability black hole) — closed: TurnAttempt threads the trace through every exit, TurnOutcome removed, fallback retired. Round 2: stale module-doc paragraph contradicting the implemented oracle — closed by `51253b59d` (doc-only, implements the named finding verbatim). Amendment #2 sovereignty RATIFIED in task 225 (byte-minimal, within ruled scope).

Required corrections:
- All applied; evidence recorded in this update.

## Delivery

Status: accepted
Residual risks:
- RealIdFactory mints UUID-shaped ids via std hashing (no uuid dep permitted) — accepted Slice 0 residual for a single-tenant local kernel; revisit before any multi-tenant use.
- A4 unsupported-tool projection semantics remain routed to A4/A2 (the oracle deliberately never calls project_session on that stream).
- Oracle law (tasks 210/212/214/216) is durable interpretation recorded in the test module doc; future fixture adjudications must consult it.
Human verification needed:
- Fixture amendment #2 human acceptance GRANTED (recorded in tasks 218/219 and commit `abe0fcb44`).
