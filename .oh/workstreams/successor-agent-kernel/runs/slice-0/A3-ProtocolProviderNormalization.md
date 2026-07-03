# Lane A3 — ProtocolProviderNormalization

## Model Binding

- Intended execution agent: `slice0-coder`
- Intended coding model: `anthropic/claude-sonnet-4-6`, `thinking-level=high`
- Resolved coding model evidence: durable `slice0-coder` discovery verified; permanent-label canary passed (`agent://17-PermanentCoderCanary`)
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`)
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`)
- Binding verdict: verified

## Aim

- Outcome: define provider API shapes and normalized provider request/tool/response protocol fixtures.
- Contract clause(s) served: provider wire objects never become canonical state; normalized shape fixture gate.
- Fixture(s) served: `provider-shape-normalization.json`.
- Files owned:
  - `crates/successor-protocol/src/provider.rs`
  - `crates/successor-protocol/src/provider_shape_fixture.rs`
  - `crates/successor-protocol/tests/provider_shape_normalization.rs`
- Explicit non-goals: live provider adapters; provider auth; kernel turn runner.

## Problem Space

- Current state: provider normalization must be protocol-stable before kernel adapters consume it.
- Constraints: shapes exactly `anthropic_messages`, `openai_chat_completions`, `openai_responses`; provider credentials never persisted.
- Named risks: SDK objects leaking into canonical state; provider-specific tool ids becoming canonical.
- Edge cases: provider_request.built missing shape, unsupported tool lifecycle, malformed provider calls.
- Interface dependencies: consumes A1 IDs/errors/artifacts.
- Authority boundaries: protocol fixture ownership only.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Shape enum + normalized DTO fixture | stable | explicit conversion burden | selected |
| Adapter-specific canonical types | easy per-provider | breaks portability | violates contract |

Selected approach: normalized DTOs and fixture validator for all three provider shapes.

Invalidated if: a provider lane needs a new canonical shape not authorized by contract.

Stop/pivot if: fixtures conflict with provider shape enum.

## Dissent

Verdict: not needed for prep stub

If skipped, rationale: lane has not executed.

## Execute

Checklist:
- [x] owned files plus approved `src/lib.rs` export expansion only
- [x] shared interfaces imported from owner crate
- [x] no forbidden shortcuts
- [x] tests/checks added
- [x] targeted validation passed
- [x] named risks retired or routed
- [x] model binding verified for execution agent (`slice0-coder`, `anthropic/claude-sonnet-4-6`, `thinking-level=high`; canary `agent://17-PermanentCoderCanary`)

Changed files:
- `crates/successor-protocol/src/lib.rs` — exports A3 modules `provider` and `provider_shape_fixture`.
- `crates/successor-protocol/src/provider.rs` — provider normalized schema constant, exact `ProviderApiShapeV0` strings, typed canonical successor IDs, normalized tool call/result/response DTOs, provider wire-shape projection DTO, and metadata-only provider observation DTO.
- `crates/successor-protocol/src/provider_shape_fixture.rs` — fixture DTO and deterministic validator for `provider-shape-normalization.json`, including schema checks, exact three-shape coverage, event-type checks, and high-confidence credential-key scanning.
- `crates/successor-protocol/tests/provider_shape_normalization.rs` — canonical fixture tests for deserialization, exact shape set, normalized semantics, provider-specific ID metadata boundary, round-trip JSON, and validation failure cases.

Validation evidence:
- A3 implementation (`agent://55-A3ProtocolProviderNormalization`) reported `cargo test -p successor-protocol` PASS with 23 new tests.
- Orchestrator reran `cargo test -p successor-protocol`: **PASS**, 54 unit tests + 16 A2 integration tests + 23 A3 integration tests passed, 0 failed, 0 ignored.
- Fixture validated: `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/provider-shape-normalization.json` deserializes, round-trips structurally, contains exactly `anthropic_messages`, `openai_chat_completions`, and `openai_responses`, and preserves provider-specific IDs as metadata only.
- Initial A3 reviews: drift aligned (`agent://58-A3DriftReview`) and Superego ALLOW (`agent://56-A3SuperegoReview`), but code review BLOCKED on two P1 findings (`agent://57-A3CodeReview`).
- A3 P1 correction (`agent://59-A3ProviderRequestAndCredentialGateCorrection`) added stable `NormalizedProviderRequestV0` / `provider_request.built`, added `deny_unknown_fields` on fixture DTOs, and strengthened credential scanning for high-confidence string values.
- Orchestrator reran `cargo test -p successor-protocol` after A3 P1 correction: **PASS**, 54 unit tests + 16 A2 integration tests + 29 A3 integration tests passed, 0 failed, 0 ignored.
- A3 rereview after P1 correction: drift aligned, but code review and Superego still blocked/revised because the root fixture DTO lacked `deny_unknown_fields`, allowing top-level unknown credential fields to be dropped before scanning.
- Final root fixture correction added `#[serde(deny_unknown_fields)]` to `ProviderShapeNormalizationFixtureV0` and a top-level unknown credential-field regression test.
- Orchestrator reran `cargo test -p successor-protocol` after the root fixture correction: **PASS**, 54 unit tests + 16 A2 integration tests + 30 A3 integration tests passed, 0 failed, 0 ignored.
- Final review-learning correction added missing required high-confidence credential value sentinels (`refresh_token`, `access_token`, `client_secret`) and `#[serde(deny_unknown_fields)]` to `ProviderObservationMetadataV0`.
- Orchestrator reran `cargo test -p successor-protocol` after final review-learning correction: **PASS**, 54 unit tests + 16 A2 integration tests + 32 A3 integration tests passed, 0 failed, 0 ignored.
- Fixed event-type discriminator correction added serde-boundary validation for normalized provider DTO `event_type` fields, so wrong discriminants cannot deserialize into `NormalizedProviderRequestV0`, `NormalizedToolCallV0`, `NormalizedToolResultV0`, or `NormalizedResponseV0`.
- Orchestrator reran `cargo test -p successor-protocol` after fixed event-type discriminator correction: **PASS**, 54 unit tests + 16 A2 integration tests + 33 A3 integration tests passed, 0 failed, 0 ignored.

## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **PASS** after corrections (`agent://67-A3CodeReviewAfterEventTypeFix`, `overall_correctness=correct`).

Findings:
- P1: stable `provider_request.built` normalized provider request trace DTO was missing; `ProviderWireShapeV0.request_projection` is raw wire projection, not a durable request-trace boundary.
- P1: credential validation scanned only typed keys and ignored string values/unknown fields, so credential-bearing values could pass the fixture gate.
- P1: root `ProviderShapeNormalizationFixtureV0` lacked `deny_unknown_fields`, so top-level unknown credential fields could be dropped before scanning.
- P1: credential value sentinel list missed required review-learning patterns `refresh_token`, `access_token`, and `client_secret`.
- P1: `ProviderObservationMetadataV0` accepted unknown fields, leaving a provider metadata credential-smuggling path.
- P1: normalized provider DTOs used plain `String` `event_type` fields, allowing malformed JSON discriminants to deserialize into the wrong DTO.

Fixes applied:
- `provider.rs` now defines `PROVIDER_REQUEST_BUILT_EVENT_TYPE` and `NormalizedProviderRequestV0` with request/turn IDs, concrete `provider_api_shape`, bounded preview, and source-reference fields without wire objects or auth.
- `provider.rs` now denies unknown fields on `ProviderObservationMetadataV0` and validates normalized provider DTO `event_type` fields during deserialization.
- `provider_shape_fixture.rs` now denies unknown fields on fixture-facing DTOs including the root fixture DTO, and scans both credential-looking keys and required high-confidence credential-looking string values.
- `provider_shape_normalization.rs` now tests request-trace serialization/no wire projection, credential-looking string rejection including required sentinels, nested/top-level unknown credential field rejection, provider metadata unknown-field rejection, and wrong `event_type` deserialization rejection for all normalized provider DTOs.

## Drift Review

Original aim: define provider API shapes and normalized provider request/tool/response protocol fixtures.
Current work: exact provider shape enum, normalized provider request/tool/result/response DTOs, wire-shape projection DTOs, canonical fixture DTO/validator, and integration tests implemented.
Gap: none remaining for A3. Review-loop corrections added stable provider request traces, credential/unknown-field gates, provider metadata hardening, and fixed event-type serde-boundary validation.
Verdict: **aligned** after corrections (`agent://68-A3DriftReviewAfterEventTypeFix`)
Authority boundary: within A3 authority; no provider runtime/auth/storage behavior introduced.

## Superego Review

Reviewer: pending
Reviewer model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **ALLOW** after corrections (`agent://69-A3SuperegoReviewAfterEventTypeFix`).

Frame risks:
- Initial reviews found downstream-boundary risk from missing provider request DTO, incomplete credential scanning, unknown-field gaps, provider metadata credential-smuggling path, and unvalidated event-type discriminants.
- All risks were retired with additive protocol-boundary hardening and regression tests; no provider runtime/auth behavior was introduced.

Required corrections:
- Complete. Stable provider request trace DTO, stronger credential gate, root/nested/provider-metadata unknown-field rejection, required credential value sentinels, and fixed event-type serde-boundary validation are in place.

## Delivery

Status: **accepted**
Residual risks: Credential scanning intentionally uses high-confidence string patterns to avoid false positives; broader runtime/auth prevention remains downstream. A5 should consume A3 tests/validator for fixture-level enforcement.
Human verification needed: none for A3; proceed to A4.
