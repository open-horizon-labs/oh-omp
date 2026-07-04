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

If completed (task 182-C4PreExecutionDissent, verdict ALLOW / PROCEED-WITH-CONDITIONS, checkout-proof `b75f38389`):
- Dissent concern: provider projection could redefine A3-owned normalized DTOs, make wire JSON or credentials canonical state, pull live network into default CI, widen C3's credential API, or work around the A4 unsupported-tool rejection.
- Response: A3 owns `ProviderApiShapeV0`, `NormalizedProviderRequestV0/ToolCallV0/ToolResultV0/ResponseV0`, `ProviderObservationMetadataV0`, `ProviderWireShapeV0` and the three-shape fixture validator — C4 imports, never redefines; the three-shape fixture binds C4's deterministic tests and interface model to all three shapes while live transport is Anthropic-only; kernel Cargo already carries reqwest(json/stream/rustls) — no SDKs, no additions; C3's `header_value` is provider-boundary-internal and sufficient.
- Outcome: PROCEED with orchestrator rulings: (1) C4 edits `provider/{mod,projection,anthropic}.rs` + granted `tests/slice0_provider_shapes.rs`; mod.rs reorganization preserves C3 `auth`/`credentials` declarations and APIs — any C3 change is a C3 reopen, not C4 scope; (2) no Cargo changes; provider SDKs prohibited; (3) deterministic fixture-driven projection tests for ALL THREE shapes + a live-capable Anthropic adapter; live smoke strictly opt-in env-gated (never default CI, never a test the suite requires network/credentials for); (4) custody invariants tested: no Serialize path for credential-bearing request state, no secret in Debug/traces/observations, `provider_api_shape` present on request-built observations per fixtures; (5) A4 residual: DETECT and RECORD unsupported-tool projection rejection in the fixture path as typed behavior — any local reimplementation or bypass of accepted projection is forbidden.

## Execute

Checklist:
- [x] owned files only (provider/{mod,projection,anthropic}.rs + granted tests/slice0_provider_shapes.rs); C3 declarations preserved; no Cargo changes
- [x] A3 normalized DTOs imported, no local clone DTOs (drift task 185: no shadowing structs)
- [x] no forbidden shortcuts: three-shape interface model, no credentials in traces/observations, wire JSON adapter-internal only
- [x] tests added in granted file (10 deterministic) + projection unit tests incl. tool-use-only regression set (task 191)
- [x] targeted validation + orchestrator `make check-rs` exit 0 at `931cd99cb` and `da4436642`
- [x] named risks retired: A4 residual as typed reject_unsupported_tool (detection only); credential no-echo proven; malformed-wire redacted
- [x] model binding verified (`slice0-executor`, Sonnet 5; tasks 184 salvage, 191 fix). Provenance: first C4 run died unreported; salvage audit KEPT the draft per file (root cause: incomplete import list + missing test file) — governance accepted by Superego task 189
- [x] fixture sovereignty preserved

Changed files:
- `crates/successor-kernel/src/provider/{mod.rs, projection.rs, anthropic.rs}`, new `tests/slice0_provider_shapes.rs`

Validation evidence:
- All kernel suites green (69 lib + 6 test binaries); three-shape fixture round-trips typed-equal; custody proofs (no-Serialize, redacted Debug, provider_api_shape on observations); opt-in live smoke skipped by default (SUCCESSOR_LIVE_PROVIDER_SMOKE=1 + ANTHROPIC_API_KEY gate)

## Code Review

Reviewer: `slice0-reviewer` (task 187-C4CodeReview, checkout-proof at `931cd99cb`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Findings:
- P1: normalize_response required a text content block, so Anthropic tool-use-only responses (stop_reason tool_use, no text) died as MalformedResponse exactly when the model calls the read tool.

Fixes applied (task 191, commit `da4436642`):
- Tool-use-only messages normalize with empty text (A3 DTO requires String — least-inventive, disclosed inline); tool call extracted independently; neither-text-nor-tooluse still typed; mixed-content behavior guarded; first-call semantics for multiple tool_use blocks pinned explicitly.

## Drift Review

Original aim: provider projection/normalization without credential leakage or provider-wire canonization.
Current work: tasks 184+191 through `da4436642`.
Gap: none material (task 185-C4DriftReview: all seven boundary checks pass; build_provider_request takes data, orchestrates nothing).
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: ALLOW (task 189-C4SuperegoReview, checkout-proof at `931cd99cb`)

Frame risks:
- None: DTO sovereignty, custody, opt-in smoke, A4-residual handling and salvage provenance all confirmed governed.

Required corrections:
- None.

## Delivery

Status: accepted
Residual risks:
- A4 unsupported-tool residual: detection typed here; lifecycle handling remains routed to C7.
- The private request_body credential-leak path is covered by type-level proofs (no-Serialize, redacted Debug) rather than an offline wire test (mock servers prohibited); live smoke exercises it end-to-end when opted in.
Human verification needed:
- None outstanding.
