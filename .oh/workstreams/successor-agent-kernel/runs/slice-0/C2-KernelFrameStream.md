# Lane C2 — KernelFrameStream

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
- `KernelFrameV0` is live-only stream projection, not canonical persisted truth; it must not embed raw event payloads or replace raw events.
- Frame field names, schema version, allowed kinds, and ID prefixes must be copied from contract §5 and accepted protocol DTOs; no dot-notation or plausible renamed fields.
- Dense `stream_seq` is kernel-assigned for the live stream only; persisted facts in frames must reference `raw_event_id` and `raw_event_session_seq` when available.
- Provider token deltas may be frames only; `provider_delta.recorded` raw events remain forbidden in Slice 0.
- SSE formatting must be exactly `event: kernel_frame` with typed frame JSON; no provider-specific streaming envelope becomes the public kernel stream protocol.
- Regression coverage must catch frame/raw-event conflation, missing raw-event references for persisted facts, non-dense stream sequence, and wrong SSE event name.

## Fan-out / Dependency Order

Required staging: C8 lands the kernel crate shell first, or grants C2 append-only `lib.rs` module declarations after C2-owned files exist. C2 must not edit C8 local RPC files. C2 can run after the C8 shell/grant and accepted protocol `KernelFrameV0` are available.

Parallelization: after the shell/grant, C2 can run in parallel with C1, C3, and the C5 tool-catalog/read substrate because it owns disjoint files. C7 depends on C2 for frame sink/stream semantics, and full C8 depends on C2 for SSE exposure. If C2 needs route/SSE HTTP mounting, that belongs to C8, not C2.

## Aim

- Outcome: implement the kernel live frame stream substrate that emits contract-exact `kernel.frame.v0` frames with dense stream ordering and safe SSE serialization while preserving raw events as canonical truth.
- Contract clause(s) served: contract §2.1 raw event log is truth; §3 stream-frame ordering authority; §5 KernelFrame v0; §9 successful/unsupported turn frame lifecycle; §13 acceptance criteria 4, 6, and 10.
- Fixture(s) served: `kernel-frame-stream.json`; raw-event reference expectations in `raw-events-successful-turn.json` and `raw-events-unsupported-tool.json`; degradation/frame observations tied to assemble fixtures.
- Files owned:
  - `crates/successor-kernel/src/frame_sink.rs`
  - `crates/successor-kernel/src/stream.rs`
  - `crates/successor-kernel/src/sse.rs`
- Dependencies: accepted `KernelFrameV0`, IDs, entity IDs, and error DTOs from `successor-protocol`; C8 shell/module grant; C7 runner as downstream consumer; C8 local RPC/SSE as downstream exposer.
- Explicit non-goals: raw-event persistence, platform append client, provider auth/projection, tool execution, turn lifecycle decisions, HTTP route mounting, CLI rendering, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: branch `successor-main` is recorded at `921e1e1ad`, pushed. A0–A5 and B1–B6 are accepted with evidence trails. The kernel crate is a stub and has no frame streaming modules yet.
- Constraints: frame stream is live-only; persisted replay must not depend on frames. SSE event name is fixed. Frame IDs use `frame_`; raw event IDs use `evt_`; stream sequence is dense per live request stream, not per session.
- Named risks: streaming raw provider wire objects as stable kernel protocol; creating raw events for token deltas; using wall-clock order as stream order; dropping raw-event IDs from persisted-fact frames; letting C8/RPC route code leak into C2; testing only happy-path serialization.
- Edge cases: first frame sequence; turn failure after partial frames; persisted append success vs append failure; provider delta frames with no raw event; resumed session with no live stream; backpressure/cancel behavior if in scope; serialization errors; SSE newline/data framing.
- Interface dependencies: protocol `KernelFrameV0` and allowed frame kind enum/string set; C7 will call frame sink APIs; C8 will expose C2 SSE serialization without redefining frame JSON.
- Authority boundaries: C2 owns stream primitives and SSE serialization only. It may not decide runner lifecycle order or persist events. It may define private sink abstractions but public frame shape remains protocol-owned.
- Ambiguities to record, not resolve: the dispatch map does not assign a C2 test file despite `kernel-frame-stream.json` fixture acceptance needs; exact backpressure/cancellation semantics are not specified; C2 may need async-stream/futures dependencies not named in the contract substrate.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Typed frame sink plus SSE serializer over `KernelFrameV0` | Preserves protocol sovereignty and separates C7/C8 responsibilities | Needs careful ordering tests | selected |
| Let C7 write ad hoc frame JSON | Fewer files | Duplicates stream protocol and hides ordering bugs | violates interface discipline |
| Persist frames as replay facts | Simplifies resume thinking | Breaks raw-event truth and replay contract | contract violation |

Selected approach: provide a small stream sequencer/sink that assigns dense `stream_seq`, accepts already-typed `KernelFrameV0` facts from runner code, validates persisted-fact references where applicable, and serializes frames to exact `event: kernel_frame` SSE records for C8.

Invalidated if: accepted `KernelFrameV0` cannot represent `kernel-frame-stream.json`, or correct SSE exposure requires C2 to own local RPC routes.

Stop/pivot if: implementation needs to invent frame JSON, add persisted `provider_delta` raw events, edit fixtures/contract/protocol, or move turn lifecycle decisions into the stream layer.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C2 touches the frame/event boundary and public live-stream protocol.

If completed (task 169-C2PreExecutionDissent, verdict ALLOW / PROCEED-WITH-CONDITIONS, checkout-proof `4360ce436`):
- Dissent concern: frames could quietly become a second truth plane (persisted/replayable), C2 could pre-own C7 lifecycle or C8 SSE-route semantics, and the lane has no dispatch-owned test file; channel choice may need a Cargo feature change.
- Response: sovereign rules pin RawEvent as the only persisted truth and KernelFrame as live projection; the canonical `kernel-frame-stream.json` pins schema `kernel.frame.v0`, SSE event name `kernel_frame`, dense `stream_seq` 1..10, exact frame kinds, and paired `raw_event_id`/`raw_event_session_seq` refs (null for `turn_started`); accepted A2 DTO tests already enforce the shapes; kernel Cargo has no SSE crate and needs none.
- Outcome: PROCEED with orchestrator rulings: (1) C2 edits only `frame_sink.rs`, `stream.rs`, `sse.rs` — no C8 RPC/route files, no turn-lifecycle ordering decisions; (2) SSE serialization hand-rolled over accepted `KernelFrameV0` (`event: kernel_frame` + `data:` JSON); SSE/event-stream crates prohibited; (3) if channels are used, the tokio `sync` feature change is authorized as a disclosed Cargo bootstrap artifact; no new crates; (4) test-file grant: C2-owned `crates/successor-kernel/tests/kernel_frame_stream.rs` (plus `#[cfg(test)]` modules as needed); fixture/contract edits remain forbidden; (5) live-view semantics only — deterministic enqueue/close/drop-on-disconnect, dense per-stream seq, persisted-fact frames carry raw-event refs; durable replay, redelivery, and backpressure guarantees are NOT invented; provider delta raw events remain forbidden.

## Execute

Checklist:
- [x] owned files only (frame_sink.rs, stream.rs, sse.rs replacing their C8-shell stubs) plus granted test file and the authorized tokio `sync` feature disclosure (dissent ruling 3)
- [x] shared `KernelFrameV0`/ID interfaces imported from `successor-protocol`
- [x] no forbidden shortcuts: no duplicate frame DTOs, no persisted frame truth, no provider wire SSE protocol, no SSE crate
- [x] test-file ambiguity resolved via granted `tests/kernel_frame_stream.rs` (dissent ruling 4)
- [x] targeted validation passed (15 unit + 12 integration kernel tests); orchestrator `make check-rs` exit 0 at `f839787be`
- [x] named risks retired: dense seq atomic with close-check under one mutex (verified 8-thread/50-task); paired raw-event refs unrepresentable as unpaired at the FrameSink type level with A2 `validate_dto` safety net
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; task 170)
- [x] fixture sovereignty preserved; canonical 10-frame fixture reproduced field-for-field (frame_id/ts caller-supplied by design — C7 authority; only stream_seq sink-assigned)

Changed files:
- `crates/successor-kernel/src/{frame_sink.rs, stream.rs, sse.rs}`, new `crates/successor-kernel/tests/kernel_frame_stream.rs`, `Cargo.toml` (tokio +sync), `Cargo.lock` transitive

Validation evidence:
- Fixture reproduction full PartialEq (no exclusions); dense concurrent seq; independent per-stream sequences; SSE spec-correctness (event name constant, per-line data, trailing blank line); subscriber-drop and post-close typed-error semantics; `make check-rs` exit 0

## Code Review

Reviewer: `slice0-reviewer` (task 173-C2CodeReview, checkout-proof at `f839787be`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: PASS (`overall_correctness=correct`, confidence 0.86, zero findings)

Findings:
- None. Zero-subscriber publish judged consistent with live-view/no-redelivery ruling; caller-supplied identity correctly left to C7; JSON-escape-before-SSE-framing prevents raw CR/LF.

Fixes applied:
- None required.

## Drift Review

Original aim: live kernel frame stream/SSE substrate without weakening raw-event truth.
Current work: task 170 as committed at `f839787be`.
Gap: none material (task 172-C2DriftReview). Two residual notes recorded below for later lanes.
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 171-C2SuperegoReview, checkout-proof at `f839787be`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: ALLOW

Frame risks:
- None: RawEvent truth vs live projection preserved; identity/lifecycle authority stays with C7/A5; broadcast capacity disclosed as live-view detail, not a delivery guarantee.

Required corrections:
- None.

## Delivery

Status: accepted
Residual risks:
- `publish_with` is pub(crate): C7/C8 could bypass FrameSink; later lanes must route through FrameSink or justify direct use explicitly (drift note).
- Per-kind mandatory raw_event_ref enforcement is C7/A5-owned; C2 enforces only the paired shape.
- A stale comment in stream.rs claims frame construction happens under the lock; actual code releases first — cosmetic, behavior tested; fix opportunistically in C7/C8 work.
Human verification needed:
- None outstanding.
