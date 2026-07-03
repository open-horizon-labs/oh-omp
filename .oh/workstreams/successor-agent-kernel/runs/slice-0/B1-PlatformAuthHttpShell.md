# Lane B1 — PlatformAuthHttpShell

## Model Binding

- Intended execution agent: `slice0-executor` (amended 2026-07-02; active Wave B execution label)
- Intended execution model: `anthropic/claude-sonnet-5`, `thinking-level=high` (user-accepted 2026-07-02 roster amendment; runbook §2.5)
- Coder roster note: `slice0-coder` remains `anthropic/claude-sonnet-4-6`, `thinking-level=high`; do not use it as evidence for the active execution lane unless explicitly dispatched as coder support.
- Resolved execution model evidence: Sonnet 5 three-gate experiment and promotion recorded in `SLICE-0-MODEL-CANARY.md` §14; durable rebind canary `agent://112-ExecutorRebindCanary` passed with exact `anthropic-claude-sonnet-5-high` echo; pre-lane fixture slice evidence `agent://111-Sonnet5Gate3FixtureBundle`.
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`).
- Drift reviewer model: `slice0-drift-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://18-PermanentDriftReviewerCanary`).
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`).
- Binding verdict: verified.

## Durable Law / Review Learnings preflight

Before acting, the executor, code reviewer, drift reviewer, Superego reviewer, and verifier must read and apply the FULL `.oh/workstreams/successor-agent-kernel/SLICE-0-REVIEW-LEARNINGS.md` §1–13, not selected excerpts or memory summaries.

Lane-relevant consequences:
- Auth and fixture/security boundaries must scan both credential-looking keys and high-confidence credential-looking string values (`MEMEX_LICENSE`, `Authorization: Bearer`, `refresh_token`, `access_token`, `client_secret`, provider API-key shapes) without broad false positives such as the word `token` alone.
- Every new request/security-boundary DTO must reject unknown fields unless the contract explicitly defines an extension map; unknown credential-looking fields must not be silently dropped before scanning.
- Platform entitlement auth and provider auth are separate planes: `MEMEX_LICENSE`/optional authorized alias protects only context-platform APIs; provider API keys, OAuth/subscription state, model spend credentials, and local provider auth must not authorize platform routes or enter platform records, traces, fixtures, logs, or errors.
- If B1 crate-shell work requires Cargo target stubs, module declarations, workspace metadata, or `Cargo.lock` changes, executor evidence must disclose them as explicit bootstrap artifacts rather than accidental drift.
- Regression tests or fixture assertions are required for any correction to a prior review-loop defect; passing happy paths alone is insufficient.

## Fan-out / Dependency Order

Required execution order: B1 runs first. B1 must land the minimal `lib.rs`/`http.rs`/`auth.rs`/`error.rs` shell and module declarations needed for later platform lanes to compile and test. B2 may only run in safe parallel after that minimal shell has landed, and B2 must never edit B1-owned files. Final Wave B fan-out: B1 shell/auth first; B2 storage append after the B1 shell; B3/B4/B5 after the B2 storage surface they consume (B4 also after B3 where artifact reads are required; B5 preferably after B4 trace/projection substrate); B6 last after B1–B5 are accepted.

## Aim

- Outcome: establish the context-platform crate shell, HTTP surface skeleton, platform entitlement authentication, and platform error mapping without implementing storage, artifact, replay, assembly, or route contract internals.
- Contract clause(s) served: contract §2.4 auth-plane separation; §6 Context Platform API bearer `MEMEX_LICENSE` requirement; dispatch map §4.2 platform validation gates for missing/invalid auth and provider-key-shaped credential rejection; Wave B gate 3 auth prerequisites.
- Fixture(s) served: canonical fixture set indirectly through future platform route tests; credential-leak/adversarial auth cases derived from fixture validator rules. No B1-owned canonical fixture file exists in the dispatch map.
- Files owned:
  - `crates/successor-context-platform/src/lib.rs`
  - `crates/successor-context-platform/src/main.rs`
  - `crates/successor-context-platform/src/http.rs`
  - `crates/successor-context-platform/src/auth.rs`
  - `crates/successor-context-platform/src/error.rs`
- Explicit non-goals: raw-event storage, SQLite schema/migrations, idempotency, artifact persistence, source indexes, projection/replay, `/assemble` retrieval semantics, route contract tests, provider auth, kernel/CLI code, protocol/fixture/contract edits, and model-binding changes.

## Problem Space

- Current state: A0–A5 are accepted/closed on branch `successor-main` (`b1f037dbc`, `dbc6eff42`, `25f1306fc`); `cargo test -p successor-protocol` is green and `make check-rs` exits 0. Wave B platform crates are still stubs, so B1 must consume accepted protocol APIs without reopening them.
- Constraints: platform auth is `MEMEX_LICENSE`-shaped entitlement auth only; provider API keys/OAuth/subscription credentials must not authorize platform APIs and must never enter platform records/traces/errors; HTTP errors must surface protocol `ErrorEnvelopeV0`; all new JSON-boundary DTOs must use `#[serde(deny_unknown_fields)]` unless an explicit contract extension map exists.
- Named risks: collapsing provider auth and platform auth; accepting provider-looking tokens as platform entitlement; leaking raw `MEMEX_LICENSE` or provider-looking secrets in errors/logs; making HTTP shell decisions that force route/storage implementations outside their lanes; adding a second context path or local semantic assembler.
- Edge cases: missing bearer header, malformed bearer header, empty token, `MEMEX_LICENCE` alias ambiguity if considered, provider-key-shaped token strings, auth failures on every route before route-specific work, debug/log/error redaction of auth material.
- Interface dependencies: import accepted A1/A2 protocol IDs, `ErrorEnvelopeV0`, platform DTOs, and tool catalog types from `successor-protocol`; B1 may expose platform-local auth/error helpers for B6 routes but must not redefine protocol DTOs.
- Authority boundaries: B1 owns platform crate shell/auth/error/http bootstrap only. Any need to change `successor-protocol`, canonical fixtures, `SLICE-0-CONTRACT.md`, or accepted A-lane modules requires the Interface Change Request/reopen protocol.
- Ambiguities to record, not resolve: the contract says `MEMEX_LICENCE` alias may be accepted only if ever introduced; dispatch map only names `MEMEX_LICENSE`. Treat alias support as out of scope unless orchestrator explicitly authorizes it.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Minimal auth-first HTTP shell using protocol error envelopes | Retires auth-plane risk early; lets B6 wire routes later | Requires careful stubbing so shell does not over-own routes | selected |
| Implement full platform routes in B1 | Fast visible HTTP progress | Crosses B2–B6 ownership boundaries | violates dispatch ownership |
| Reuse provider/local auth machinery | Less code | Collapses auth planes and risks secret leakage | violates contract §2.4 |

Selected approach: implement a platform-local auth extractor/guard and error mapping in the platform shell, with route placeholders only as needed to enforce auth rejection consistently; keep storage/artifact/projection/assembly implementations behind later lane modules.

Invalidated if: rejecting provider-looking tokens cannot be done without inspecting or storing provider credential material, or accepted protocol error/platform DTOs cannot express the required 401/403/validation failures.

Stop/pivot if: the lane needs to edit accepted A-lane protocol modules, canonical fixtures, contract text, model roster/materialization, or non-owned B2–B6 files to pass.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; Wave B runbook requires dissent when touching auth.

If completed (task 125-B1PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof at `bf5f7db0e`):
- Dissent concern: B1 touches the auth plane before real route/storage internals exist; risks durable accidental decisions — framework/runtime commitment, route semantics pre-owned ahead of B6, overly broad provider-key inspection, raw auth leakage through errors/logs, unauthorized `MEMEX_LICENCE` alias support.
- Response: contract §2.4 separates `MEMEX_LICENSE` platform entitlement from provider auth; §6 requires `Authorization: Bearer <MEMEX_LICENSE>` on all Context Platform API requests; dispatch §4.2 requires 401 `ErrorEnvelopeV0` for missing/invalid auth and rejection of provider-key-shaped credentials. The implementation stack names tokio/axum/reqwest as recommended substrate, not contract; error envelope/status mapping IS contract.
- Outcome: PROCEED with binding conditions: (1) framework/runtime choice is executor discretion disclosed as a bootstrap decision; (2) bearer inspection is in-memory-only, syntactic, redacted 401/403 `ErrorEnvelopeV0`, raw value discarded, never echoed into errors/logs/traces; no broad false positives (the word `token` alone is insufficient); (3) route surface is a single authenticated `/v0` router/fallback or minimal auth-only placeholders — no per-endpoint business handlers, no B2–B6 behavior stubs; (4) `MEMEX_LICENCE` alias neither implemented nor tested; (5) no broad public platform helper API beyond what B6 needs for auth/error reuse.

## Execute

Checklist:
- [x] owned files only (plus disclosed bootstrap artifacts)
- [x] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [x] no forbidden shortcuts
- [x] tests/checks added inside owned scope (22 platform tests; route-contract-level checks routed to B6)
- [x] targeted validation passed (`cargo test -p successor-context-platform` 22/22)
- [x] orchestrator-owned `make check-rs` gate run after executor returned and again after review fixes; exit 0 both times
- [x] named risks retired or routed (auth-plane separation upheld; MEMEX_LICENCE alias kept out of scope)
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; task 126)
- [x] fixture sovereignty preserved; no fixture edits
- [x] no accepted-module edits
- [x] no new JSON-boundary DTOs introduced (protocol `ErrorEnvelopeV0` reused)
- [x] workspace lint gate green before review dispatch
- [x] no dispatch over-constraint; B1-owned semantics implemented directly

Changed files:
- `crates/successor-context-platform/src/{lib.rs, main.rs, http.rs, auth.rs, error.rs}`
- Bootstrap artifacts (disclosed): `crates/successor-context-platform/Cargo.toml` (axum 0.8, tokio 1, sha2 0.10, `[[bin]]`, workspace lints), `Cargo.lock` (transitive additions only)

Validation evidence:
- `cargo test -p successor-context-platform`: 22/22 green (auth guard, provider-shape rejection, redaction, error mapping, router fallback)
- `make check-rs` exit 0 at implementation (`d35cf362c`) and after review fixes (`096e0c986`)
- Protocol crate untouched; its suites unaffected

## Code Review

Reviewer: `slice0-reviewer` (task 127-B1CodeReview, checkout-proof at `d35cf362c`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE (two P2 findings)

Findings:
- P2: license compare early-returned on length mismatch — entitlement length observable via timing.
- P2: generic JWT three-segment syntax treated as provider credential — a JWT-shaped valid `MEMEX_LICENSE` could never authenticate.

Fixes applied (commit `096e0c986`):
- `PlatformLicense::matches` now compares fixed-size SHA-256 digests (sha2 disclosed as bootstrap artifact); no secret-length-dependent branching.
- JWT-shape rule removed; only high-confidence provider key prefixes rejected; test flipped to prove a JWT-shaped license authenticates.

## Drift Review

Original aim: platform crate shell + entitlement auth + protocol error mapping, no later-lane pre-ownership.
Current work: task 126 implementation as committed at `d35cf362c`.
Gap: none material (task 129-B1DriftReview).
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 128-B1SuperegoReview, checkout-proof at `d35cf362c`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE (governance evidence hygiene only; no code changes required)

Frame risks:
- Auth-plane separation preserved; dissent conditions honored substantively; disclosed framework choice is the only durable decision.

Required corrections:
- Fill this packet's Execute/Changed files/Validation evidence/Delivery sections — applied in this update.

## Delivery

Status: accepted
Residual risks:
- The two P2 closures are reviewer-prescribed mechanical fixes verified by gates and tests but not separately re-reviewed.
- Server entrypoint is exercised by tests via router construction, not a live bind; a live smoke lands with B6 route-contract checks.
Human verification needed:
- None outstanding.
