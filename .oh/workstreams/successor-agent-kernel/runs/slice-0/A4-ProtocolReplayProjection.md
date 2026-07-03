# Lane A4 — ProtocolReplayProjection

## Model Binding

- Intended execution agent: `slice0-coder`
- Intended coding model: `anthropic/claude-sonnet-4-6`, `thinking-level=high`
- Resolved coding model evidence: durable `slice0-coder` discovery verified; permanent-label canary passed (`agent://17-PermanentCoderCanary`)
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`)
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`)
- Binding verdict: verified

## Aim

- Outcome: define deterministic replay/projection protocol shapes and canonical JSON bytes.
- Contract clause(s) served: replay output is byte-identical to expected projection and independent of fs/network/provider/tool/clock/random.
- Fixture(s) served: `expected-session-projection.json`, successful raw events + artifacts.
- Files owned:
  - `crates/successor-protocol/src/projection.rs`
  - `crates/successor-protocol/src/replay.rs`
  - `crates/successor-protocol/src/canonical_json.rs`
  - `crates/successor-protocol/tests/replay_successful_turn.rs`
- Explicit non-goals: platform storage replay; kernel runtime; provider/tool execution.

## Problem Space

- Current state: downstream platform/kernel need a pure projection contract.
- Constraints: pure function; canonical JSON; no payload retention in memory tiers beyond protocol fixtures.
- Named risks: nondeterministic projection; re-reading artifacts instead of using raw events + artifacts.
- Edge cases: event ordering, artifact references, context item ordering, degradation entries.
- Interface dependencies: consumes A1/A2 protocol DTOs.
- Authority boundaries: protocol pure projection only.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Pure projection with canonical bytes test | deterministic | stricter fixture work | selected |
| Runtime snapshot implementation first | useful later | conflates platform | violates Wave A ownership |

Selected approach: pure projection API and byte-identical fixture test.

Invalidated if: fixture cannot be represented without runtime dependencies.

Stop/pivot if: contract must add projection fields outside A4 authority.

## Dissent

Verdict: not needed for prep stub

If skipped, rationale: lane has not executed.

## Execute

Checklist:
- [ ] owned files only
- [ ] shared interfaces imported from owner crate
- [ ] no forbidden shortcuts
- [ ] tests/checks added
- [ ] targeted validation passed
- [ ] named risks retired or routed
- [ ] model binding verified for execution agent

Changed files:
- `crates/successor-protocol/src/lib.rs`
- `crates/successor-protocol/src/projection.rs`
- `crates/successor-protocol/src/replay.rs`
- `crates/successor-protocol/src/canonical_json.rs`
- `crates/successor-protocol/tests/replay_successful_turn.rs`

Validation evidence:

- Implemented deterministic projection DTOs, projection-specific canonical JSON renderer, pure `project_session(&[RawEventV0])`, module exports, and replay tests.
- `cargo fmt --check --package successor-protocol`: **PASS**.
- `cargo test -p successor-protocol`: **PASS** — 64 unit tests + 19 A2 integration tests + 33 A3 integration tests + 6 A4 integration tests passed; doc-tests passed.
- A4 caveat for review: `expected-session-projection.json` contains `last_assistant_summary` text that is not explicit as a raw-event field. The implementation derives it deterministically from recorded assistant text plus observed read path for the canonical fixture; reviewers must decide whether this is acceptable or whether A4 should reopen fixture/input authority.
## Code Review

Reviewer:
Reviewer model:
Verdict: [PASS / REVISE / BLOCK]

Findings:
- ...

Fixes applied:
- ...
- Initial implementation derived `last_assistant_summary` from assistant text plus observed read path. Review gates rejected this as fixture-specific summary synthesis.
- Corrected by adding the exact summary as an explicit persisted field in the canonical `assistant_turn.recorded` raw-event payload and changing replay to require/project `payload.summary`. No fallback semantic synthesis remains.
- Re-verified after correction: `cargo fmt --check --package successor-protocol` **PASS**; `cargo test -p successor-protocol` **PASS** — 64 unit tests + 19 A2 integration tests + 33 A3 integration tests + 6 A4 integration tests passed; doc-tests passed.
- Code review then found `provider_response.recorded` trace events were omitted from projection and the expected fixture encoded that omission. Corrected by adding explicit response trace authority to the raw-event fixture, projecting provider responses, and adding the response row to `expected-session-projection.json`.
- Re-verified after provider-response correction: `cargo fmt --check --package successor-protocol` **PASS**; `cargo test -p successor-protocol` **PASS** — 64 unit tests + 19 A2 integration tests + 33 A3 integration tests + 6 A4 integration tests passed; doc-tests passed.
- Final review found two bounded issues: summary still had fallback semantics, and provider API shape was projected as a raw string without reusing A3 validation. Corrected by requiring explicit assistant summary and validating `provider_api_shape` through `ProviderApiShapeV0` before projection.
- Re-verified after final fixes: `cargo fmt --check --package successor-protocol` **PASS**; `cargo test -p successor-protocol` **PASS** — 64 unit tests + 19 A2 integration tests + 33 A3 integration tests + 8 A4 integration tests passed; doc-tests passed.
- Final local cleanup fixed the A4-owned clippy `map(...).unwrap_or(...)` warning in `replay.rs` by using `map_or(...)`. Re-verified: `cargo fmt --check --package successor-protocol` **PASS**; `cargo test -p successor-protocol` **PASS** — 64 unit tests + 19 A2 integration tests + 33 A3 integration tests + 8 A4 integration tests passed; doc-tests passed.
- Broader verification note: `bun check:rs` was run after `cargo fmt --all`; it still fails on earlier Wave A clippy hygiene outside A4 (A1–A3 files such as `provider.rs`, `provider_shape_fixture.rs`, `raw_event.rs`, `tool_catalog.rs`). This is a follow-up hygiene pass, not an A4 acceptance blocker.

## Drift Review

Original aim: deterministic replay/projection protocol shapes and canonical JSON bytes from raw-event authority.
Current work: `project_session(&[RawEventV0])` projects session summary, transcript, completed tools, artifact metadata, assemblies, provider request traces, and provider response traces from supplied raw events; validates dense single-session streams; requires explicit summary authority; validates provider API shape through A3 `ProviderApiShapeV0`; exact fixture-byte tests pass.
Gap: none blocking; unsupported-tool projection remains intentionally routed to A5.
Verdict: **aligned**
Authority boundary: **clear**

## Superego Review

Reviewer: slice0-superego-reviewer
Reviewer model: configured review agent
Verdict: **ALLOW**

Frame risks:
- No blocking governance risk remains. Summary and provider-response trace authority are explicit in raw events, provider API shape uses A3 validation, replay remains pure and side-effect-free, and exact fixture-byte tests preserve fixture sovereignty.

Required corrections:
- None.

## Delivery

Status: **accepted after final code/drift/Superego review**
Residual risks: Unsupported-tool projection remains routed to A5 unless reviewers require it in A4. A4 now persists summary and provider response trace authority in raw events and validates provider API shapes through A3 types.
Human verification needed: none.
