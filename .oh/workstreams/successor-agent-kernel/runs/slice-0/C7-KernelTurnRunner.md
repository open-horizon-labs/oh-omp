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

If completed:
- Dissent concern: pending.
- Response: pending.
- Outcome: pending.

## Execute

Checklist:
- [ ] owned files only, plus explicit C8 `lib.rs` module grant and disclosed Cargo bootstrap artifacts if authorized
- [ ] shared protocol IDs/DTOs imported from `successor-protocol`; no local RawEvent/KernelFrame/provider/tool DTO clones
- [ ] no forbidden shortcuts: no local semantic assembly, no provider credential persistence, no inline upstream component implementations
- [ ] tests/checks added in `crates/successor-kernel/tests/slice0_kernel_contract.rs`
- [ ] targeted validation passed (`cargo test -p successor-kernel slice0_kernel_contract` or package-local equivalent, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, including lifecycle order, unsupported-tool rejection, credential no-echo, and A4 residual handling
- [ ] model binding verified for execution agent
- [ ] fixture sovereignty preserved; no fixture/contract edits

Changed files:
- Pending execution.

Validation evidence:
- Pending execution.

## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: pending

Findings:
- Pending execution.

Fixes applied:
- Pending execution.

## Drift Review

Original aim: exact Slice 0 lifecycle runner over accepted platform/provider/tool/frame seams.
Current work: pending execution.
Gap: pending.
Verdict: pending
Authority boundary: pending

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: pending

Frame risks:
- Pending execution.

Required corrections:
- Pending execution.

## Delivery

Status: pending execution
Residual risks:
- C7 depends on every prior C lane and must execute late.
- A4 unsupported-tool projection residual is explicitly routed here for lifecycle evidence and to A4/A2 for reopen if accepted projection still rejects; no runner workaround permitted.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
