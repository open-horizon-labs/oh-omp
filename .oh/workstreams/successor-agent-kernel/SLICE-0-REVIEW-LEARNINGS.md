# Slice 0 Review Learnings

This file is durable law for Slice 0 execution. Attach it to every remaining builder, reviewer, drift-review, Superego, and verifier assignment.

Purpose: compound review-loop findings so agents stop repeating the same class of mistake.

## Standing rule

Before implementing or reviewing a Slice 0 lane, check this file against the lane packet, contract, dispatch map, and canonical fixtures.

If a patch repeats any BLOCK pattern below, reviewers should block even if tests pass.

## BLOCK patterns learned from A0–A3

### 1. Invented protocol shape

BLOCK IF a public DTO, enum string, JSON field, schema version, or fixture type is invented from plausible naming instead of copied from `SLICE-0-CONTRACT.md` or a canonical fixture.

Observed failures:
- `RawEventV0` used `sequence`, `created_at`, plural `artifacts` instead of contract fields.
- `KernelFrameV0` used `frame_kind`, `occurred_at`, and dot-notation kinds instead of `kind`, `ts`, and underscore strings.
- Platform API DTOs invented request/response shapes.
- Tool catalog initially invented `platform.tool_catalog.v0` and metadata/tool-count fields instead of round-tripping `tool-catalog.json`.

Required behavior:
- If a canonical fixture exists, deserialize and reserialize it exactly before designing helper constructors.
- Tests must assert old drifted field names are absent, not only that new names are present.

### 2. Contract invariants enforced only by helper methods

BLOCK IF a constrained protocol value can deserialize from invalid JSON because validation only lives in constructors or helper methods.

Observed failures:
- `ArtifactHash` had strict parser helpers but derived transparent `Deserialize`.
- `ArtifactV0.sha256` and `RawEventArtifactRef.sha256` were plain `String`, bypassing `ArtifactHash`.

Required behavior:
- Use typed boundary values in DTO fields.
- Implement validating `Deserialize` for constrained scalars.
- Add tests for malformed JSON deserialization at every actual DTO boundary, not only scalar helpers.

### 3. Unknown fields silently dropped at fixture/security boundaries

BLOCK IF fixture-facing DTOs accept unknown fields where credentials or auth material could be hidden or dropped before scanning.

Observed failure:
- Nested fixture DTOs denied unknown fields, but root `ProviderShapeNormalizationFixtureV0` did not, allowing top-level credential fields to be ignored.

Required behavior:
- Use `#[serde(deny_unknown_fields)]` on fixture/security boundary DTOs unless there is an explicit contract extension map.
- Add tests for both nested and top-level unknown credential-looking fields.

### 4. Credential scanning only checks keys

BLOCK IF provider/platform fixture validation scans only object keys and ignores high-confidence credential-looking string values.

Observed failure:
- Credential-looking values could pass if stored in known string fields.

Required behavior:
- Scan object keys and high-confidence string values.
- Avoid broad false positives such as the word `token` alone.
- Flag high-confidence values such as `MEMEX_LICENSE`, `Authorization: Bearer`, `refresh_token`, `access_token`, `client_secret`, and obvious provider API key strings.

### 5. Provider wire objects become stable protocol

BLOCK IF provider wire JSON or provider-specific IDs become canonical successor identity or persisted state.

Required behavior:
- Provider wire objects are projections/fixtures only.
- Provider-specific tool-call IDs remain metadata strings.
- Successor IDs (`tool_`, `pevt_`, `msg_`, `trace_`, etc.) are stable replay identity.
- Stable request traces use normalized DTOs such as `provider_request.built`, with previews/source refs but no credentials or raw wire/auth payloads.

### 6. Platform-assigned fields accepted from append requests

BLOCK IF append request DTOs expose or trust platform-assigned fields.

Observed failure:
- A direct alias from append request to `RawEventV0` retained `session_seq`.

Required behavior:
- Append request omits platform-assigned `session_seq`.
- Append response includes assigned `session_seq`, duplicate status, stored timestamp, and optional source/artifact IDs.

### 7. Live projection vs canonical persisted truth conflated

BLOCK IF `KernelFrameV0` embeds raw events or becomes canonical persisted truth.

Required behavior:
- RawEvent remains persisted canonical truth.
- KernelFrame is live-only stream projection.
- Frames may reference raw events by `raw_event_id` and `raw_event_session_seq` when reporting persisted facts.

### 8. ID prefix drift

BLOCK IF ID prefixes are guessed or made more descriptive than the contract.

Observed failures:
- `ToolCallId` used `toolcall_` instead of `tool_`.
- `ContextItemId` was omitted.

Required behavior:
- Copy prefixes from `SLICE-0-CONTRACT.md`.
- Add prefix tests for every ID family consumed by downstream lanes.

### 9. Cargo/workspace bootstrap artifacts hidden or undocumented

BLOCK IF Cargo-required target stubs or lockfile changes appear as accidental drift.

Required behavior:
- If Cargo metadata requires minimal source stubs, record this as an explicit bootstrap expansion.
- If `Cargo.lock` changes due workspace/package additions, record it as generated workspace artifact evidence.
- Preserve existing workspace membership unless an explicit migration says otherwise.

### 10. Review fixes without regression tests

BLOCK IF a review finding is fixed only by code changes without a targeted test that would have failed before the fix.

Required behavior:
- Every repeated review-loop defect gets a regression test or fixture assertion.
- Packet evidence must name the review finding, correction, and validation command/result.


### 11. Accepted-lane overfit discovered by downstream canonical fixtures

BLOCK IF a downstream lane works around accepted protocol types with a local wrapper when canonical fixtures prove the accepted type was overfit.

Observed failure:
- A4 fixture-first preflight showed accepted A1/A2 could not deserialize canonical raw-event fixtures: session-level `tool_catalog.published` has `turn_id: null`; platform-produced assembly events use producer kind `platform`; canonical fixtures use `redaction: "public"`; raw-event artifacts may be inline metadata without assigned `artifact_id`; accepted boundaries were also missing unknown-field rejection/exact round-trip tests.

Required behavior:
- Reopen the owning accepted lane with targeted review instead of adding a downstream wrapper.
- Preserve fixture sovereignty with exact canonical fixture deserialize/reserialize tests where the fixture is a protocol boundary.
- Keep overfit relaxations narrow: e.g. nullable raw-event `turn_id` is allowed only for session-level events and turn-scoped nulls must be rejected at serde boundaries.
- Add unknown-field rejection to fixture/security boundaries when adding fixture-derived shapes.
## Builder preflight checklist

Before editing a lane:

1. Read the lane packet, dispatch map, contract, canonical fixtures, and this file.
2. Identify all public JSON shapes and enum strings before writing code.
3. If a fixture exists, design DTOs from fixture round-trip, not from memory.
4. Decide which fields require typed validating wrappers at serde boundaries.
5. Decide which DTOs need `deny_unknown_fields`.
6. Add tests that assert rejected drift, not only accepted happy paths.

## Reviewer checklist

Reviewers must explicitly check:

1. Are all public JSON fields/schema versions/enum strings contract- or fixture-derived?
2. Can invalid JSON bypass helper validation?
3. Are unknown fields rejected where security/fixture boundaries require it?
4. Are provider credentials impossible to persist in protocol fixtures/artifacts/traces?
5. Are platform-assigned fields omitted from requests and present only in responses/persisted records?
6. Is live-only frame data kept separate from canonical raw events?
7. Did the fix add a regression test for every prior class of mistake?

## Current accepted lane implications

- A0/A1/A2/A3 are accepted under these lessons.
- A4 and A5 must consume this file before implementation.
- If A4/A5 fixtures expose another accepted-lane overfit, reopen the owning lane with targeted review; do not bypass with local fixture wrappers.


## Lessons from A5 (2026-07-03)

### 12. Dispatch over-constraint masquerading as discipline

BLOCK IF an orchestrator assignment translates the fixture-first stop law into "implement no check without a pre-existing accepted API". Contract-specified semantics implemented in the owning lane's own module are that lane's job, not invented semantics — `RawEventV0` explicitly defers causation/idempotency/credential checks to the shared validator lane. Deferral discipline applies to fixture/DTO mismatches, never to the lane's own assigned scope.

Corollary: entity producer/reference semantics must be derived from canonical fixture flows and proven against the full fixture suite — not from memory of one lane's projection logic. The A5 future-reference validator was first circular (unreachable), then over-narrow (rejected the canonical fixture); only the fixture-derived producer table survived.

### 13. Split verification is the orchestrator's gate, not the executor's

Executor assignments restrict validation to `cargo test -p <crate>` by design. Therefore the orchestrator MUST run `make check-rs` on every returned lane before dispatching review gates. Workspace-lint failures found there (doc-paragraph lints, fmt drift) are assignment-framing gaps — fix forward without treating them as agent-discipline failures, and never present a lane to reviewers before the workspace gate is green.

## Lessons from the post-acceptance provider-path correction (2026-07-06)

### 14. A live-path oracle that tolerates typed failure terminals proves nothing

The Gate 5 live provider smoke asserted "a valid normalized terminal frame" and accepted `turn_completed` OR `turn_failed`. A typed provider-auth failure is a valid normalized terminal frame, so the smoke recorded a masked 401 as a Gate 5 pass (D2 packet, original 2026-07-05 record). Three real defects hid behind it: the gateway base URL was never consumed, the hardcoded model was stale for the environment, and executable tools were advertised with `input_schema: null` (real Anthropic rejects the request with HTTP 400 before the model runs). Deterministic suites could not catch any of these because scripted providers never validate request bodies.

Rules:
- A test whose purpose is "prove path X works" must assert the SUCCESS terminal of path X, never a disjunction that a failure also satisfies. Failure-tolerant assertions are for failure-path tests.
- Anything only a real counterparty validates (request body shapes, auth header semantics, model names) needs at least one oracle on the real path; scripted seams prove protocol composition, not counterparty acceptance.
- Schema/content advertised to a counterparty must be derived from the same types that validate it locally (schemars from the executor's own arg DTOs), so advertisement and validation cannot drift; a bare `{"type":"object"}` placeholder must fail the projection contract test.
- When a governance record's evidence is later invalidated, correct the record in place with the diagnosis and the genuine rerun — do not delete or overwrite the history (D2 packet CORRECTED RECORD precedent, `987c22621`).