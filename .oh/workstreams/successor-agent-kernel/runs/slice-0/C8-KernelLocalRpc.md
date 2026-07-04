# Lane C8 — KernelLocalRpc

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
- Local RPC/SSE exposes the runner only; it must not become a second platform, second store, provider credential inspection endpoint, or semantic assembly path.
- Kernel route DTOs must use accepted protocol/local API shapes or C8-owned API shapes with explicit contract alignment; no duplicate RawEvent/KernelFrame/platform/provider DTOs.
- SSE must serialize C2 `KernelFrameV0` as `event: kernel_frame`; route handlers must not invent a separate stream schema.
- Resume uses platform snapshot/events/artifacts through C1 and local provider auth re-resolution through C3; no local session-file copy.
- Provider credentials and platform bearer values must be redacted from route errors, traces, logs, and any inspect/debug output.
- Cargo/module bootstrap artifacts are durable decisions and must be explicitly disclosed; C8 owns the top-level crate shell and must prevent parallel lanes from racing `lib.rs` edits.

## Fan-out / Dependency Order

Execution-safe order has two C8 phases:

1. **C8 shell/bootstrap phase first:** establish the kernel crate shell, top-level module policy, and explicit grants. Because dispatch assigns `crates/successor-kernel/src/lib.rs` to C8 while C1–C7 need module declarations, C8 must either land minimal `lib.rs` scaffolding first or authorize append-only module declarations per lane after owned files exist. This phase may also centralize disclosed Cargo bootstrap (`reqwest`, `tokio`, `serde`/`serde_json`, `thiserror`, `tracing`, `uuid`, and lane-specific additions only as ruled).
2. **C8 full local RPC phase last:** after C1–C7 are accepted, wire local routes/SSE to C7 runner and C2 frame stream.

Parallelization: C1/C2/C3/C5 may begin after shell/grants; C4 namespace shell precedes C3 full auth and C4 full projection follows C3; C6 follows C5; C7 follows C1–C6; C8 full follows C7. If implementation agents need to edit the same core files concurrently, stop per runbook §8.

## Aim

- Outcome: expose the standalone successor kernel's local RPC/SSE surface over the accepted runner without storing sessions locally, inspecting provider secrets, or creating a second semantic context path.
- Contract clause(s) served: contract §0 execution target; §2.3 platform is canonical; §2.4 auth planes; §5 SSE frame format; §9 turn lifecycle exposure; §11 resume semantics; §13 acceptance criteria 1, 8, 9, 10, and 12; dispatch map C8 gate.
- Fixture(s) served: `kernel-frame-stream.json` through SSE; `raw-events-successful-turn.json` and `raw-events-unsupported-tool.json` through runner-backed local turn calls; `session-snapshot.json` and artifact/event fixtures through resume path expectations.
- Files owned:
  - `crates/successor-kernel/src/http.rs`
  - `crates/successor-kernel/src/routes.rs`
  - `crates/successor-kernel/src/api.rs`
  - `crates/successor-kernel/src/lib.rs`
- Dependencies: accepted C1 platform client, C2 stream/SSE serializer, C3 provider auth resolver, C4 provider projection, C5/C6 tools, C7 runner/trace; accepted protocol DTOs/errors/IDs.
- Explicit non-goals: CLI implementation, platform route/server implementation, direct platform storage, provider credential endpoints, provider auth UI/login, tool implementations, turn lifecycle internals beyond wiring, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: kernel crate is a stub. Dispatch gives C8 `lib.rs` ownership, which creates a staging hazard because earlier C lanes need module declarations before C8 full RPC can run.
- Constraints: local RPC is a control surface for kernel runner only; platform state remains canonical; resume is `session_id` plus platform queries plus local provider auth re-resolution; no second store or local session copy; stream event name fixed.
- Named risks: delaying `lib.rs` until last and blocking all C lanes; racing `lib.rs` edits across parallel lanes; exposing provider secrets through inspect/debug routes; local RPC becoming a mini-platform; route DTO drift; SSE stream schema drift; hiding bootstrap dependencies.
- Edge cases: start turn; stream frames before/after raw-event append; runner failure; client disconnect/cancel if in scope; resume with fresh local state; missing platform auth; missing provider auth; platform unavailable; unsupported tool turn; no provider secret inspection route.
- Interface dependencies: all C1–C7 accepted APIs; protocol error/frame DTOs; C1 platform resume methods; C3 provider auth re-resolution.
- Authority boundaries: C8 owns crate shell and local RPC wiring only. It may define C8-owned local API request/response wrappers if the contract lacks local kernel DTOs, but must not duplicate platform/protocol/provider shapes or create stable external contract drift without dissent.
- Ambiguities to record, not resolve: dispatch owns no C8 test file despite route/SSE/resume acceptance needs; local kernel RPC route names/body shapes are not detailed in contract beyond C8 gate and Wave D CLI expectations; Cargo bootstrap exact dependency set is not owned by a lane; whether C8 shell and full C8 should be split into separate tasks is an orchestration decision.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Split C8 into early shell/bootstrap and late local RPC wiring | Unblocks parallel lanes and preserves C8 ownership | Requires explicit staging discipline | selected |
| Let every lane freely edit `lib.rs`/Cargo.toml | Fast locally | Races core files and repeats B1-shell failure | unsafe |
| Run full C8 first with stubs for C1–C7 | Creates compile surface | Produces compatibility shims and fake behavior | forbidden by cutover/design integrity |

Selected approach: use C8 as the canonical kernel crate shell owner first, with explicit append-only module grants and disclosed Cargo bootstrap, then run full local RPC/SSE wiring last over accepted C1–C7 APIs.

Invalidated if: local RPC cannot expose C7 without defining a second store/context path, or route names/body shapes require a contract decision not present in Slice 0 artifacts.

Stop/pivot if: implementation needs provider secret inspection, local session persistence, platform crate internals, route DTO clones of platform/protocol types, fixture/contract edits, or concurrent uncoordinated edits to `lib.rs`/Cargo.toml.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C8 touches public local RPC/SSE surface, resume authority, provider secret exposure boundaries, module/Cargo bootstrap staging, and model-visible execution routing through the kernel.

If completed:
- Dissent concern: pending.
- Response: pending.
- Outcome: pending.

## Execute

Checklist:
- [ ] shell/bootstrap phase completed before C1–C7 or explicit grants recorded
- [ ] full C8 execution waits for accepted C1–C7 APIs
- [ ] owned files only, plus disclosed Cargo bootstrap artifacts if authorized
- [ ] shared interfaces imported from `successor-protocol` and accepted C1–C7 modules; no duplicate RawEvent/KernelFrame/platform/provider DTOs
- [ ] no forbidden shortcuts: no local store, no provider secret inspection, no second semantic context path, no stubbed fake runner behavior
- [ ] tests/checks added or explicitly routed for the dispatch-map test-file ambiguity
- [ ] targeted validation passed (`cargo test -p successor-kernel` minimum, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, especially resume-from-platform and SSE schema exactness
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

Original aim: C8-owned kernel crate shell plus late local RPC/SSE wiring over accepted runner.
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
- C8 is both first shell/bootstrap and last full RPC lane; orchestration must split or explicitly stage it before launch.
- Local RPC route contract and C8 test-file ownership are under-specified and require dissent/orchestrator ruling.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
