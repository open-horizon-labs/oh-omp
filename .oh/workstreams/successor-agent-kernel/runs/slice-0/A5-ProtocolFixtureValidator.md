# Lane A5 — ProtocolFixtureValidator

## Model Binding

- Intended execution agent: `slice0-executor` (amended 2026-07-02; packet originally named `slice0-coder`)
- Intended coding model: `anthropic/claude-sonnet-5`, `thinking-level=high` (user-accepted 2026-07-02 roster amendment; runbook §2.5)
- Resolved coding model evidence: three-gate Sonnet 5 experiment plus rebind canary `agent://112-ExecutorRebindCanary` (`SLICE-0-MODEL-CANARY.md` §14); pre-lane fixture slice landed under `agent://111-Sonnet5Gate3FixtureBundle`
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`)
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`)
- Binding verdict: verified

## Aim

- Outcome: define the Slice 0 fixture bundle validator and shared validation logic.
- Contract clause(s) served: canonical fixtures parse; adversarial mutation checks fail tempting wrong patches.
- Fixture(s) served: all canonical Slice 0 fixtures and adversarial mutation cases.
- Files owned:
  - `crates/successor-protocol/src/fixtures.rs`
  - `crates/successor-protocol/src/validation.rs`
  - `crates/successor-protocol/tests/slice0_fixture_contract.rs`
- Explicit non-goals: modifying fixture semantics without contract authority; platform/kernel implementations.

## Problem Space

- Current state: later horde waves need fixture gates before implementation fanout.
- Constraints: validator must catch invalid IDs, causation, hashes, credential leakage, unsupported-tool lifecycle, provider shape errors, and replay mismatch.
- Named risks: false-positive fixture pass; validator tied to runtime side effects.
- Edge cases: malformed artifacts, missing provider_api_shape, future references, duplicate idempotency keys.
- Interface dependencies: consumes A1/A2/A3/A4 protocol modules.
- Authority boundaries: shared validation only.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Central validator with adversarial tests | strong Wave B+ gate | more setup | selected |
| Per-lane ad hoc checks | easy | inconsistent | violates horde gate |

Selected approach: central fixture bundle validator and mutation tests.

Invalidated if: canonical fixtures are absent or conflict with contract.

Stop/pivot if: validation requires a runtime dependency.

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

Validation evidence:

## Code Review

Reviewer:
Reviewer model:
Verdict: [PASS / REVISE / BLOCK]

Findings:
- ...

Fixes applied:
- ...

## Drift Review

Original aim:
Current work:
Gap:
Verdict: [aligned / minor drift / significant drift / lost]
Authority boundary: [clear / ambiguous / crossed]

## Superego Review

Reviewer:
Reviewer model:
Verdict: [ALLOW / REVISE / BLOCK]

Frame risks:
- ...

Required corrections:
- ...

## Pre-lane slice landed (Sonnet 5 experiment gate 3)

The typed fixture-bundle accessor slice was implemented under the `slice0-sonnet5-executor` experiment (`agent://111-Sonnet5Gate3FixtureBundle`; evidence in `SLICE-0-MODEL-CANARY.md` §14): `crates/successor-protocol/src/fixtures.rs`, `crates/successor-protocol/tests/slice0_fixture_contract.rs` (13 tests), `lib.rs` export. Orchestrator-verified: full suite + `make check-rs` green. Remaining A5 scope: `validation.rs`, adversarial mutation tests, unsupported-tool lifecycle projection semantics, and formal lane review gates over the landed slice.

Adjudication required before or during A5: `assemble-response-pre-tool.json` and `assemble-response-post-read.json` do not deserialize through accepted `AssemblyResponseV0` (mismatch details in `fixtures.rs` doc comments). Per review-learnings §11: reopen A2 or correct the fixtures; no local wrappers.

## Delivery

Status: **implemented, verified, re-reviewed; all named findings closed**

Evidence trail: fixture slice `agent://111` (experiment gate 3); validator `agent://113`; review gates `agent://114` (drift: minor, boundary clear), `agent://115` (code: incorrect, two P1s), `agent://116` (superego: REVISE); revision `agent://117`; revision re-review `agent://118` (future-reference validator circular, order test mislabeled) closed by orchestrator with producer-filtered introduction maps derived from canonical fixture flows plus order-swap and forward-reference tests; combined focused re-review `agent://120` (checkout-proof verified at `dbc6eff42`) accepted the future-reference fix and found one P1 on the A2 reopen — assemble-response DTOs deserialized without `deny_unknown_fields` — closed by adding the attribute to `AssemblyResponseV0`/`ContextItemV0`/`DegradationV0`/`ContextItemRecoveryV0` plus three input-rejection tests (stale `reason`, stale `kind`, credential-like root key).

A2 adjudication: resolved by user decision (fixtures sovereign); reopen executed as `agent://119`, DTOs aligned to both canonical assemble-response fixtures, raw accessors fully cut over to typed.

Commits on `successor-main`: `b1f037dbc` (A0–A5 + Makefile-owned Rust verification + workstream machinery), `dbc6eff42` (A2 reopen), `25f1306fc` (deny-unknown-fields P1 fix).

Verified at final state: `cargo test -p successor-protocol` — six suites, all green (unit incl. validation, A2, A3, A4, fixture-contract incl. adversarial mutations and unknown-field rejection, doc-tests); `make check-rs` exit 0.

Residual risks:
- The deny-unknown-fields closure is a mechanical application of the reviewer's named finding with rejection-test evidence; it was not separately re-reviewed.
- The typed assemble-response accessors are not yet wired into `validate_fixture_bundle()`; reviewer judged this acceptable as a recorded follow-up for A5 closure or Wave B.

Human verification needed:
- None outstanding; both prior items (A2 adjudication, future-reference fix acceptance) resolved this session.
