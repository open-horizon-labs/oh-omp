# Lane A2 — ProtocolFramesPlatformDtos

## Model Binding

- Intended execution agent: `slice0-coder`
- Intended coding model: `anthropic/claude-sonnet-4-6`, `thinking-level=high`
- Resolved coding model evidence: durable `slice0-coder` discovery verified; permanent-label canary passed (`agent://17-PermanentCoderCanary`)
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`)
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`)
- Binding verdict: verified

## Aim

- Outcome: define kernel frame, platform API DTO, and tool catalog protocol types.
- Contract clause(s) served: stable live-frame and platform DTO boundary.
- Fixture(s) served: `kernel-frame-stream.json`.
- Files owned:
  - `crates/successor-protocol/src/kernel_frame.rs`
  - `crates/successor-protocol/src/platform_api.rs`
  - `crates/successor-protocol/src/tool_catalog.rs`
  - `crates/successor-protocol/tests/kernel_frame_fixture.rs`
- Explicit non-goals: platform HTTP implementation; kernel SSE runtime; provider normalization.

## Problem Space

- Current state: consumers need stable DTOs and frame types before platform/kernel work.
- Constraints: KernelFrame is live-only; RawEvent remains persisted truth; `/assemble` is sole semantic context path.
- Named risks: frame/persistence conflation; platform DTO drift from contract field names.
- Edge cases: unsupported tools, degradation, trace/context item DTOs.
- Interface dependencies: consumes A1 IDs/errors/artifacts.
- Authority boundaries: A2 owns protocol DTOs, not transport code.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| DTO-first with fixture test | stable for consumers | requires discipline | selected |
| Implement transport first | faster demo | unstable API | violates Wave A freeze |

Selected approach: protocol DTO modules with fixture-backed field names.

Invalidated if: transport lanes need unstated DTOs.

Stop/pivot if: contract lacks field authority.

## Dissent

Verdict: not needed for prep stub

If skipped, rationale: lane has not executed.

## Execute

Checklist:
Checklist:
- [x] owned files plus approved `src/lib.rs` export expansion only
- [x] shared interfaces imported from owner crate
- [x] no forbidden shortcuts
- [x] tests/checks added
- [x] targeted validation passed
- [x] named risks retired or routed
- [x] model binding verified for execution agent (`slice0-coder`, `anthropic/claude-sonnet-4-6`, `thinking-level=high`; canary `agent://17-PermanentCoderCanary`)

Changed files:
- `crates/successor-protocol/src/lib.rs` — exports A2 modules `kernel_frame`, `platform_api`, and `tool_catalog`.
- `crates/successor-protocol/src/kernel_frame.rs` — `KernelFrameV0`, `KernelFrameKindV0`, SSE event name constant, DTO-level validation report/helpers; corrected to exact contract fields (`kind`, `ts`, `raw_event_session_seq`, `causation_frame_id`, `entity_ids`) and exact underscore kind strings.
- `crates/successor-protocol/src/platform_api.rs` — transport-neutral `/v0` platform API DTOs for sessions, raw-event append/page, artifacts, snapshots, `/assemble`, trace lookup, policies, and validation reports; comment corrected to avoid false bridge language.
- `crates/successor-protocol/src/tool_catalog.rs` — protocol-only tool definition/catalog DTOs and execution mode enum; no executable tool logic.
- `crates/successor-protocol/tests/kernel_frame_fixture.rs` — focused integration tests for kernel-frame JSON shape/kinds, platform DTO field names/no provider messages, and tool catalog shape.

Validation evidence:
- A2 implementation (`agent://42-A2ProtocolFramesPlatformDtos`) reported `cargo test -p successor-protocol` PASS with 83 tests.
- Pre-review KernelFrame correction (`agent://43-A2KernelFrameContractAlignment`) aligned `KernelFrameV0` with exact contract fields/kinds and reported `cargo test -p successor-protocol` PASS with 86 tests.
- Orchestrator reran `cargo test -p successor-protocol`: **PASS**, 86 passed, 0 failed, 0 ignored.
- Exact KernelFrame contract checked: serialized frames use `kind` + `ts`, not `frame_kind`/`occurred_at`; allowed kind strings are the contract underscore values; raw-event references carry `raw_event_id` and `raw_event_session_seq` together.
- Initial A2 review gates blocked the lane: code review incorrect (`agent://46-A2CodeReview`), drift significant (`agent://44-A2DriftReview`), Superego REVISE (`agent://45-A2SuperegoReview`).
- Platform/tool DTO correction attempts via `slice0-coder` were interrupted before writes; orchestrator applied a direct scoped correction to the same A2-owned files only.
- Direct correction aligned platform API DTOs to exact contract shapes for create session, append request/response, event pages, session snapshots, `/assemble` request/response, and trace/policy/degradation fields; append requests explicitly omit platform-assigned `session_seq`; tool catalog DTOs now include `schema_version`, `catalog_id`, `projection_version`, category/status, and `stub_rejected` entries.
- Orchestrator reran `cargo test -p successor-protocol` after direct correction and append-request tightening: **PASS**, 54 unit tests + 16 integration tests passed, 0 failed, 0 ignored.
- A2 rereview after direct platform/tool correction: code review passed and Superego allowed; drift review still blocked on canonical tool-catalog fixture mismatch.
- Tool catalog fixture correction aligned `ToolCatalogV0` to `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/tool-catalog.json`: `schema_version = "kernel.tool_catalog.v0"`, fixture order/fields, optional omitted `description`/`input_schema`, no metadata/session/tool-count fields.
- Orchestrator reran `cargo test -p successor-protocol` after fixture-exact tool-catalog correction: **PASS**, 54 unit tests + 16 integration tests passed, 0 failed, 0 ignored.
- A4 fixture-first preflight reopened A2 append/tool-catalog boundaries: `RawEventAppendRequestV0` now mirrors raw-event nullable session-level `turn_id` while rejecting turn-scoped nulls, invalid schema, empty idempotency key, unknown fields, and platform-assigned `session_seq`; tool-catalog DTOs now deny unknown fields.
- Orchestrator reran `cargo test -p successor-protocol` after the A1/A2 fixture-sovereignty correction: **PASS**, 64 unit tests + 19 A2 integration tests + 33 A3 integration tests passed, 0 failed, 0 ignored.
## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **PASS** after corrections (`agent://54-A2CodeReviewFinal`, `overall_correctness=correct`); reopened A1/A2 fixture-sovereignty review **PASS** (`agent://88-A1A2FixtureSovereigntyReviewPostExactRoundTrip`, `overall_correctness=correct`).

Findings:
- P1: platform API DTOs invented wire shapes for create-session, event-page pagination, session snapshot, and `/assemble` request/response instead of the exact contract shapes.
- P1/P2: tool catalog DTOs lacked reviewed fixture fields (`schema_version`, `catalog_id`, `projection_version`, category/status, `stub_rejected`) and carried invented session/tool-count shape.
- Drift rereview additionally found `ToolCatalogV0` still mismatched the canonical `tool-catalog.json` fixture (`kernel.tool_catalog.v0`; omitted optional fields).

- A4 preflight found accepted A2 append/tool-catalog boundaries needed fixture-sovereignty hardening: append request deserialization had to reject `session_seq`, turn-scoped null turns, invalid schema, empty idempotency keys, and unknown fields; tool-catalog DTOs had to reject unknown fields.
Fixes applied:
- Pre-review correction removed false bridge comment and aligned `KernelFrameV0` wire shape to the exact contract before review.
- Post-review correction rewrote platform API DTOs/tests to contract field names and old-drift field absence checks; append request DTO now omits `session_seq` while reusing A1 raw-event field types.
- Fixture-exact correction rewrote `ToolCatalogV0` and integration tests to deserialize/serialize the canonical fixture exactly and remain declarative only.

- Reopened fixture-sovereignty correction tightened `RawEventAppendRequestV0` serde validation and added unknown-field rejection to tool-catalog DTOs while preserving transport-neutral scope and platform-assigned `session_seq` authority.
## Drift Review

Original aim: define compile-checked protocol DTOs for live KernelFrame projection, platform API boundary, and tool catalog publication.
Current work: A2 modules and integration tests implemented against A1 accepted protocol types; pre-review KernelFrame contract mismatch corrected; post-review platform DTO drift corrected; tool catalog now round-trips the canonical fixture exactly.
Gap: first drift review found significant drift from invented platform/tool DTO shapes; rereview after direct correction still found tool-catalog fixture drift; fixture-exact correction applied. A4 preflight later reopened append/tool-catalog fixture-sovereignty hardening; final targeted drift review returned **aligned** (`agent://87-A1A2FixtureSovereigntyDriftPostExactRoundTrip`).
Verdict: **aligned** after corrections (`agent://53-A2DriftReviewFinal`, `agent://87-A1A2FixtureSovereigntyDriftPostExactRoundTrip`)
Authority boundary: within boundary; direct-orchestrator correction provenance is disclosed as an acceptable caveat, not technical drift.

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **ALLOW** after corrections (`agent://52-A2SuperegoReviewFinal`, `agent://89-A1A2FixtureSovereigntySuperegoPostExactRoundTrip`).

Frame risks:
- Contract/fixture sovereignty risk from invented platform API and tool catalog wire shapes was retired by exact contract/fixture correction.
- A4 preflight later found append/tool-catalog boundary hardening gaps; final Superego allowed after append requests rejected bypasses and tool-catalog DTOs denied unknown fields.
- Execution provenance caveat: final platform/tool correction was direct-orchestrator scoped because two `slice0-coder` correction attempts were interrupted before writes; final reviewers accepted this as disclosed and scoped.

Required corrections:
- Complete. Platform DTOs use exact contract shapes; append requests reject platform-assigned/invalid fields; tool catalog round-trips canonical fixture and rejects unknown fields; no runtime/platform/provider/tool execution behavior introduced.

## Delivery

Status: **accepted**
Residual risks: Platform API DTOs are transport-neutral only; HTTP/auth/storage implementation remains downstream. Direct correction provenance disclosed and accepted by final reviewers.
Human verification needed: none for A2; proceed to downstream Wave A lanes.
