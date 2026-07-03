# Lane A1 — ProtocolIdsErrorsRaw

## Model Binding

- Intended execution agent: `slice0-coder`
- Intended coding model: `anthropic/claude-sonnet-4-6`, `thinking-level=high`
- Resolved coding model evidence: durable `slice0-coder` discovery verified; permanent-label canary passed (`agent://17-PermanentCoderCanary`)
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`)
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`)
- Binding verdict: verified

## Aim

- Outcome: define foundational protocol IDs, errors, raw events, and artifacts.
- Contract clause(s) served: stable protocol API; canonical persisted raw event truth; artifact hash validation.
- Fixture(s) served: successful/unsupported raw-event fixtures; invalid ID/hash/credential leakage cases.
- Files owned:
  - `crates/successor-protocol/src/lib.rs`
  - `crates/successor-protocol/src/ids.rs`
  - `crates/successor-protocol/src/error.rs`
  - `crates/successor-protocol/src/raw_event.rs`
  - `crates/successor-protocol/src/artifact.rs`
- Explicit non-goals: provider normalization; replay projection; fixture bundle validator; platform/kernel code.

## Problem Space

- Current state: foundational protocol shapes need stable ownership before consumers implement.
- Constraints: preserve raw event as canonical persisted truth; no credential-like payload retention beyond allowed fixture content; exact ID prefixes.
- Named risks: consumers redefine IDs/errors; artifact hashes not content-bound; weak error codes.
- Edge cases: duplicate idempotency keys, invalid prefixes, malformed hashes, credential-like strings.
- Interface dependencies: unblocks A2/A3/A4/A5 and later platform/kernel lanes.
- Authority boundaries: A1 may define shared protocol primitives only.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Strong newtypes + explicit validation | stable, safe | more boilerplate | selected |
| Plain strings everywhere | fast | weak contract | violates protocol authority |

Selected approach: stable serializable DTOs plus validation reports/errors with exact code semantics.

Invalidated if: downstream lanes need to mutate A1 interfaces without ICR.

Stop/pivot if: fixture requirements contradict the contract.

## Dissent

Verdict: not needed for prep stub

If skipped, rationale: lane has not executed.

## Execute

Checklist:
- [x] owned files only plus approved A1 dependency/lockfile expansion for protocol serialization/hash/error substrate
- [x] shared interfaces imported from owner crate where applicable
- [x] no forbidden shortcuts
- [x] tests/checks added inside owned protocol modules
- [x] targeted validation passed
- [x] named risks retired or routed
- [x] model binding verified for execution agent (`slice0-coder`, `anthropic/claude-sonnet-4-6`, `thinking-level=high`; canary `agent://17-PermanentCoderCanary`)

Changed files:
- `crates/successor-protocol/Cargo.toml` — approved A1 expansion adding `serde`, `serde_json`, `schemars`, `thiserror`, `sha2`, and `hex`.
- `Cargo.lock` — generated protocol dependency lockfile update.
- `crates/successor-protocol/src/lib.rs` — exports foundational protocol modules.
- `crates/successor-protocol/src/ids.rs` — validated transparent ID newtypes for all A1/A2 ID families, including contract-correct `ToolCallId` prefix `tool_` and `ContextItemId` prefix `ctx_`.
- `crates/successor-protocol/src/error.rs` — `ErrorEnvelopeV0`, `ProtocolViolationCode`, `ProtocolViolation`, `ProtocolViolationSet`, `ProtocolResult<T>`; corrected to contract fields including `error_id`, `retryable`, `correlation_id`, and `details`.
- `crates/successor-protocol/src/artifact.rs` — `ArtifactV0`, `ArtifactHash`, artifact hash/byte-length validation helpers.
- `crates/successor-protocol/src/raw_event.rs` — `RawEventType`, `RawEventArtifactRef`, `RawEventV0`, and support DTOs aligned to exact contract field names: `session_seq`, `request_id`, required `turn_id`, `occurred_at`, `producer`, `correlation_id`, `entity_ids`, `visibility`, `redaction`, `payload`, singular `artifact`.

Validation evidence:
- A1a (`agent://27-A1aProtocolIdsErrors`) completed with `cargo check -p successor-protocol` PASS.
- Error-envelope correction (`agent://28-A1aErrorEnvelopeCorrection`) completed with `cargo check -p successor-protocol` PASS.
- A1b (`agent://29-A1bArtifactRawEvent`) completed with `cargo check -p successor-protocol` PASS.
- A1b ran `cargo test -p successor-protocol`: **PASS**, 45 passed, 0 failed, 0 ignored.
- Contract-alignment correction (`agent://33-A1ContractAlignmentCorrection`) changed `ToolCallId` to `tool_`, added `ContextItemId` as `ctx_`, and replaced the simplified `RawEventV0` shape with the exact contract fields.
- Required-turn correction (`agent://34-A1RawEventTurnIdRequiredCorrection`) made `RawEventV0.turn_id` required and updated tests.
- Orchestrator reran `cargo test -p successor-protocol`: **PASS**, 48 passed, 0 failed, 0 ignored.
- Artifact-hash deserialization correction (`agent://38-A1ArtifactHashDeserializeCorrection`) removed unvalidated transparent deserialization and added strict JSON-boundary validation for `ArtifactHash`.
- Orchestrator reran `cargo test -p successor-protocol` after the artifact-hash correction: **PASS**, 52 passed, 0 failed, 0 ignored.
- DTO hash-field validation correction (`agent://40-A1DtoHashFieldValidationCorrectionRetry`) changed `ArtifactV0.sha256` and `RawEventArtifactRef.sha256` from plain `String` to validated `ArtifactHash`.
- Orchestrator reran `cargo test -p successor-protocol` after DTO hash-field correction: **PASS**, 54 passed, 0 failed, 0 ignored.
- A4 fixture-first preflight reopened A1: canonical raw-event fixtures require session-level `turn_id: null`, `ProducerKind::Platform`, `RedactionLevelV0::Public`, inline artifact metadata without assigned `artifact_id`, raw-event/tool-catalog unknown-field rejection, and exact raw-event fixture JSON value round-trip.
- Fixture-sovereignty correction changed `RawEventV0.turn_id` to `Option<TurnId>` while enforcing turn-scoped non-null at the serde boundary; `RawEventArtifactRef.sha256` remains validated `ArtifactHash`; canonical raw-event fixtures now deserialize and reserialize with exact JSON value equality.
- Orchestrator reran `cargo test -p successor-protocol` after the A1/A2 fixture-sovereignty correction: **PASS**, 64 unit tests + 19 A2 integration tests + 33 A3 integration tests passed, 0 failed, 0 ignored.
- Raw event schema version: `platform.raw_event.v0`. Artifact schema version: `platform.artifact.v0`. Error schema version: `platform.error.v0`.
- All 15 Slice 0 raw event type strings are represented with explicit serde dot-notation renames.
- Artifact hash validation rejects missing `sha256:` prefix, uppercase hex, wrong digest length, digest mismatch, and byte-length mismatch.
## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **PASS** after corrections (`agent://41-A1CodeReviewPostDtoHashFix`, `overall_correctness=correct`); reopened A1/A2 fixture-sovereignty review **PASS** (`agent://88-A1A2FixtureSovereigntyReviewPostExactRoundTrip`, `overall_correctness=correct`).

Findings:
- P1: `RawEventV0` schema drifted from the contract (`sequence`/`created_at`/plural `artifacts` vs required contract fields).
- P1: `ToolCallId` used `toolcall_` instead of contract prefix `tool_`.
- P2: `ContextItemId` with prefix `ctx_` was missing.
- P2: `ArtifactHash` derived transparent `Deserialize`, allowing malformed hashes to cross the JSON boundary without strict validation.
- P2: `ArtifactV0.sha256` and `RawEventArtifactRef.sha256` were plain `String`, allowing malformed hashes to deserialize through the actual DTOs despite `ArtifactHash` validation.
- A4 preflight found accepted A1 overfit: `turn_id` was required even though canonical session-level raw events use `turn_id: null`; raw-event and nested/tool-catalog fixture DTOs also needed unknown-field rejection and exact fixture round-trip coverage.
- Final code review found no remaining issues.

Fixes applied:
- `ids.rs` now uses `tool_` for `ToolCallId` and defines `ContextItemId` with `ctx_`.
- `raw_event.rs` now uses exact contract fields, singular `artifact`, required `turn_id`, and tests assert old field names are absent.
- `artifact.rs` now implements custom `Deserialize` for `ArtifactHash` via the strict parser and tests reject missing prefix, uppercase hex, and wrong-length digest at deserialization time.
- `ArtifactV0.sha256` and `RawEventArtifactRef.sha256` now use the validated `ArtifactHash` type; tests reject malformed hashes at both DTO/ref JSON boundaries.
- Fixture-sovereignty correction: `RawEventV0.turn_id` is optional at the raw-event boundary but turn-scoped events reject null during deserialization/validation; `ProducerKind::Platform`, `RedactionLevelV0::Public`, inline artifact metadata, raw-event/tool-catalog unknown-field rejection, and exact raw-event fixture JSON value round-trip tests are in place.

## Drift Review

Original aim: define foundational protocol IDs, errors, raw events, and artifacts.
Current work: A1 split into A1a IDs/errors/dependencies and A1b artifacts/raw-events, then corrected for exact contract field/prefix alignment; all modules compile and protocol crate tests pass.
Gap: first drift review reported significant drift due raw-event schema/prefix mismatch; correction applied; rerun drift review returned aligned. A4 preflight later reopened A1 fixture-sovereignty overfit; final targeted drift review returned **aligned** (`agent://87-A1A2FixtureSovereigntyDriftPostExactRoundTrip`).
Verdict: **aligned** after corrections (`agent://36-A1DriftReviewRerun`, `agent://87-A1A2FixtureSovereigntyDriftPostExactRoundTrip`)
Authority boundary: clear. Fixture bundle validation remains routed to A5, but A1 now directly models canonical raw-event fixture boundary shapes needed by A4.

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **ALLOW** after corrections (`agent://37-A1SuperegoReviewRerun`, `agent://89-A1A2FixtureSovereigntySuperegoPostExactRoundTrip`).

Frame risks:
- First Superego review found contract-sovereignty risk from simplified raw-event shape and ID prefix drift.
- A4 preflight later found fixture-sovereignty risk from accepted A1 overfitting `turn_id` requiredness and omitting canonical fixture boundary variants/unknown-field gates.
- Final Superego allowed after raw-event DTOs modeled canonical fixtures directly, rejected turn-scoped null turns at serde boundary, preserved exact fixture JSON value round-trip, and retained validated artifact hashes.

Required corrections:
- Complete. Corrected ID prefixes and raw-event DTO shape to exact contract; artifact hash deserialization and raw-event fixture-sovereignty corrections further tighten A1 without expanding into replay/runtime behavior.

## Delivery

Status: **accepted**
Residual risks: broader fixture bundle validation remains A5-owned, but A1 canonical raw-event fixtures now deserialize/reserialize exactly and A4 may consume `RawEventV0` directly.
Human verification needed: none for A1; proceed to downstream Wave A lanes.
