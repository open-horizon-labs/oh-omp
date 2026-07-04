# Lane C4 — KernelProviderProjection

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
- Provider wire objects and provider-specific IDs are projection metadata only; successor IDs remain stable replay identity.
- Provider-normalized shapes must be fixture-derived from `provider-shape-normalization.json` for `anthropic_messages`, `openai_chat_completions`, and `openai_responses`; no Anthropic-only normalized type model.
- Provider request traces record `provider_api_shape` and safe previews/source refs, never raw credentials or auth headers.
- Tool-use/function-call blocks must normalize into the successor lifecycle (`provider_tool_call.observed`, `tool_call.requested`, `tool_result.recorded`, `provider_response.recorded`).
- Streaming token deltas may be `KernelFrame` only; persisted provider observations are coarse raw events, not `provider_delta.recorded`.
- Any accepted-lane overfit discovered by provider or unsupported-tool fixtures must reopen the owning lane; C4 must not add local wrapper DTOs to bypass fixture sovereignty.

## Fan-out / Dependency Order

Required staging: C8 lands the kernel crate shell first or grants top-level module declarations. C4 owns `provider/mod.rs`, so it must land a minimal provider namespace shell early enough for C3 to compile `provider/auth.rs` and `provider/credentials.rs`, then wait for C3 accepted provider-auth seam before full provider projection/Anthropic adapter execution.

Parallelization: C4 namespace shell can happen immediately after C8 shell. Full C4 runs after C3; it can otherwise parallelize with C5/C6 tool lanes once interfaces are stable. C7 depends on C4 provider projection. C4 must not route around the residual A4 `project_session` unsupported-tool rejection candidate; if fixture projection is still rejected, record an Interface Change Request/reopen for the owning protocol/projection lane.

## Aim

- Outcome: implement provider request/response/tool-call projection for the standalone successor kernel so provider-facing shapes normalize to successor lifecycle events/traces without leaking credentials or making provider wire JSON canonical state.
- Contract clause(s) served: contract §2.1 raw event truth; §2.4 auth separation; §4 event types; §5 frame rules for provider deltas; §9 turn lifecycle provider events; §10 Provider projection v0; §13 acceptance criteria 4, 7, and 9.
- Fixture(s) served: `provider-shape-normalization.json`; provider portions of `raw-events-successful-turn.json` and `raw-events-unsupported-tool.json`; `kernel-frame-stream.json` provider-delta boundary expectations.
- Files owned:
  - `crates/successor-kernel/src/provider/mod.rs`
  - `crates/successor-kernel/src/provider/projection.rs`
  - `crates/successor-kernel/src/provider/anthropic.rs`
  - `crates/successor-kernel/tests/slice0_provider_shapes.rs`
- Dependencies: accepted `successor-protocol` provider normalization DTOs and IDs; accepted C3 credential resolver; C2 frame stream for token deltas as live frames; downstream C7 runner for lifecycle persistence.
- Explicit non-goals: credential custody, platform HTTP client, raw event append store, tool execution, turn orchestration, local RPC, CLI behavior, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: provider credentials are available locally, but kernel provider modules do not exist. Contract requires fixture-level normalization for three provider API shapes and one live provider smoke path later.
- Constraints: provider auth read only from C3 local resolver; provider credentials absent from platform records/traces/SSE/fixtures; provider messages are projections; provider-specific IDs metadata only; context comes from platform `/assemble` and is projected into provider-visible content by the kernel.
- Named risks: hard-coding Anthropic shapes and treating OpenAI fixtures as opaque; storing provider request wire bodies as canonical raw events; leaking auth headers in request traces; preserving provider tool IDs as successor IDs; working around accepted fixture/projection overfit locally; emitting unsupported tool flow incorrectly.
- Edge cases: Anthropic tool_use vs OpenAI tool_calls vs Responses function calls; provider stream deltas; final text with no tool call; unsupported tool call; provider error; malformed provider response; provider-specific ID collisions; context item/source refs in provider request trace; credential-looking content in provider payloads.
- Interface dependencies: C3 credential handle; protocol provider-normalized DTOs; C5/C6 tool catalog names as advertised to provider; C7 persists provider observations and tool lifecycle raw events.
- Authority boundaries: C4 owns projection/adapters, not credentials, tool execution, raw event append, or runner lifecycle. It must return normalized observations/requests to C7 without performing platform persistence itself.
- Ambiguities to record, not resolve: exact live provider HTTP call substrate/features are not specified beyond contract recommending `reqwest`; C4 owns `provider/mod.rs` but must serve C3 namespace shell; the residual A4 unsupported-tool fixture rejection must be routed to protocol/projection owners, not bypassed here.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Fixture-first provider projection with Anthropic live adapter | Meets normative three-shape fixture bar and live-smoke path | Requires strict separation from credentials/runner | selected |
| Anthropic-only adapter first | Faster live path | Fails provider-shape-normalization fixture and risk matrix | insufficient |
| Persist provider wire JSON as raw events | Easy replay debugging | Makes provider wire canonical and may leak secrets | contract violation |

Selected approach: implement provider-normalized projection functions from accepted protocol shapes, an Anthropic live adapter that consumes C3 credential handles without serializing them, and fixture tests proving all three provider shapes normalize into the same successor lifecycle metadata with `provider_api_shape` and no secrets.

Invalidated if: accepted provider DTOs cannot round-trip the canonical provider-shape fixture or live provider projection requires storing credentials/wire auth payloads.

Stop/pivot if: implementation needs protocol/fixture edits, local wrapper DTOs around accepted provider shapes, platform-side provider calls, credential serialization, or a second semantic context path.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C4 touches provider normalized types, provider credential trace boundaries, tool-call lifecycle projection, and the unsupported-tool fixture residual.

If completed:
- Dissent concern: pending.
- Response: pending.
- Outcome: pending.

## Execute

Checklist:
- [ ] owned files only, plus explicit C8 top-level module grant and early C4 provider-namespace shell/grant for C3 if authorized
- [ ] shared provider normalization interfaces imported from `successor-protocol`; no local clone DTOs
- [ ] no forbidden shortcuts: no Anthropic-only normative model, no provider credentials in traces, no provider wire as canonical state
- [ ] tests/checks added in `crates/successor-kernel/tests/slice0_provider_shapes.rs`
- [ ] targeted validation passed (`cargo test -p successor-kernel slice0_provider_shapes` or package-local equivalent, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, including A4 unsupported-tool projection residual and credential no-echo
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

Original aim: provider projection/normalization without credential leakage or provider-wire canonization.
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
- A4 unsupported-tool projection residual is routed here for detection only and to C7 for lifecycle handling; no local workaround is permitted.
- Exact live provider request substrate/features remain to be ruled by dissent if Cargo bootstrap is needed.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
