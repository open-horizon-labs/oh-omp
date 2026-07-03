# Lane B6 — PlatformRoutesContract

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
- Route request/response DTO shapes, enum strings, schema versions, and error bodies must be copied from `SLICE-0-CONTRACT.md` or canonical fixtures; no plausible route-local DTO names or fields may be invented.
- Every route JSON boundary must reject unknown fields unless an explicit contract extension map exists, including adversarial credential-looking fields at top level and nested levels.
- Auth and credential planes remain separate on every endpoint: missing/invalid `MEMEX_LICENSE` is rejected; provider-looking credentials are never accepted as platform auth and never leak into route errors, traces, artifacts, logs, or response bodies.
- `ErrorEnvelopeV0` and stable HTTP status mapping must be used consistently for malformed JSON, auth failures, conflicts, validation errors, not found, service unavailable, and internal failures.
- SQLite row structs, table names, SQL errors, and implementation details must not leak through route responses; routes expose protocol DTOs/errors only.
- Route-level tests must include regression assertions for prior review defects: unknown-field rejection, credential value scanning, platform-assigned-field rejection, ID-prefix drift, and accepted-lane overfit handling by reopening rather than wrapping.

## Fan-out / Dependency Order

Required execution order: B6 runs last, after B1–B5 are accepted. It integrates accepted service surfaces only and must not inline missing service logic to unblock route tests. Final Wave B fan-out: B1 shell/auth first; B2 storage append after the B1 shell (or only after B1 lands the minimal declarations needed for safe parallel compilation, with B2 never editing B1-owned files); B3/B4/B5 after the B2 storage surface they consume; B6 last after B1–B5 are accepted.

## Aim

- Outcome: wire the context-platform HTTP routes to B1–B5 services and prove every endpoint returns accepted protocol DTOs or `ErrorEnvelopeV0` while hiding SQLite/internal implementation details.
- Contract clause(s) served: contract §6 Context Platform API v0 endpoints (`POST /sessions`, `POST /events`, event reads, artifact reads, session snapshot, `/assemble`, trace reads); §2.4 auth-plane separation; §13 platform acceptance criteria; dispatch map §4.2 endpoint catalog and B6 gate.
- Fixture(s) served: full canonical Slice 0 fixture bundle through route-level contract tests, especially raw-event successful/unsupported flows, artifact reads, session snapshot, assemble pre-tool/post-read, and error/credential-leak adversarial cases.
- Files owned:
  - `crates/successor-context-platform/src/routes.rs`
  - `crates/successor-context-platform/tests/slice0_platform_contract.rs`
- Explicit non-goals: implementing B1 auth internals, B2 storage/idempotency internals, B3 artifact/index internals, B4 projection/replay internals, B5 assembly/retrieval internals, kernel/CLI code, protocol/fixture/contract edits, and model-binding changes.

## Problem Space

- Current state: A0–A5 are accepted/closed on branch `successor-main` (`b1f037dbc`, `dbc6eff42`, `25f1306fc`); `cargo test -p successor-protocol` is green and `make check-rs` exits 0. Dispatch graph places `ContextPlatformHttpApi` after platform foundation lanes, so B6 should execute after B1–B5 service contracts are available.
- Constraints: all routes require bearer `MEMEX_LICENSE`; provider-looking credentials are not platform auth; endpoints must use protocol DTOs and `ErrorEnvelopeV0`; route layer must not expose SQLite row structs/table names; platform assigns sequence; `/assemble` returns context items/traces/degradation only; no platform record/trace/artifact/error leaks provider credentials or raw entitlement tokens.
- Named risks: route layer reimplements service logic and crosses ownership; missing auth on one endpoint; route-specific DTO copies drift from `successor-protocol`; SQLite/internal errors leak; `/assemble` route returns provider-shaped data; tests pass happy path but miss adversarial auth/error/unknown-field cases.
- Edge cases: all endpoints with missing/invalid auth; provider-key-shaped bearer; malformed JSON; unknown fields at request boundary; not found event/artifact/trace; duplicate idempotency response; append semantic rejection; snapshot with empty projection store; assemble degradation; stable status mapping 400/401/403/404/409/422/500/503.
- Interface dependencies: consume B1 auth/error/http shell, B2 raw-event/session/idempotency store, B3 artifact/source index, B4 projection/replay/trace index, and B5 assembly service once accepted; import all public request/response/error DTOs from accepted `successor-protocol`.
- Authority boundaries: B6 owns route wiring and route-level contract tests only. It may not implement service internals inline, duplicate DTOs, modify accepted A-lane protocol modules, alter canonical fixtures, or weaken route tests to hide upstream gaps.
- Ambiguities to record, not resolve: the dispatch map's dependency graph only explicitly shows `ContextPlatformAssembly -> ContextPlatformHttpApi`; it does not spell out whether B6 waits for every B1–B5 lane. Conservative orchestration should run B6 after B1–B5 because its route tests exercise all platform services.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Thin route layer over B1–B5 services with contract tests | Preserves ownership and catches integration drift | Requires B1–B5 readiness | selected |
| Implement missing service logic in routes | Unblocks tests locally | Creates duplicate semantics and hidden coupling | violates authority boundaries |
| Test only status codes | Lightweight | Misses DTO/error/body contract drift | insufficient for B6 gate |

Selected approach: wire protocol DTO endpoints to accepted platform services, centralize auth/error mapping from B1, and write route-level tests that verify response DTO shape, error envelopes, auth rejection, and absence of SQLite/internal/credential leakage.

Invalidated if: B1–B5 service interfaces cannot satisfy the endpoint contract without route-layer duplicate DTOs or service logic, or accepted protocol DTOs cannot represent required route request/response bodies.

Stop/pivot if: implementation needs to edit accepted protocol/fixture/contract files, B1–B5 service internals outside their accepted APIs, kernel/CLI code, or model roster/materialization.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable if route wiring touches auth, storage/sequence, `/assemble`, artifact retention, or replay/snapshot behavior through endpoint semantics. If B6 is purely thin wiring after accepted B1–B5 APIs, executor may record a narrowly scoped dissent-skipped rationale, but orchestrator should prefer dissent because the lane integrates multiple Wave B authority boundaries.

If completed (task 153-B6PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof `2753b953f`):
- Dissent concern: B6 integrates every Wave B authority boundary; risks are ungoverned edits to B1-owned router files, split live SQLite state across independent pools, route-local JSON shapes papering over protocol DTO gaps, and missing unknown-field rejection at route boundaries.
- Response: contract §6 defines the exact Slice 0 endpoint set (all `Authorization: Bearer <MEMEX_LICENSE>`): `POST /v0/sessions`, `POST /v0/events`, `GET /v0/sessions/{session_id}/events?after_seq&limit`, `GET /v0/events/{event_id}`, `GET /v0/artifacts/{artifact_id}`, `GET /v0/sessions/{session_id}/snapshot`, `POST /v0/assemble`, `GET /v0/traces/{assemble_id}`; protocol DTOs cover every advertised body (CreateSession/Append/EventPage/RawEvent/Artifact/Snapshot/Assemble/Trace/ErrorEnvelope); B1 deliberately left an auth-gated shell with `no_route_implemented` fallback; B3's store construction opens its own pool; `AssemblyServiceV0::new` consumes its stores.
- Outcome: PROCEED with orchestrator rulings: (1) narrow B1 reopen granted — B6 may add exactly `pub mod routes;` to `lib.rs` and mount the routes router in `http.rs` replacing the fallback wiring; no auth/error internal edits — consume accepted public helpers only; (2) full contract §6 endpoint set, none deferred; sharing/inspection, provider APIs, SSE, and tool execution stay out; (3) one database identity — all stores/services built from the same SQLite URL/path; separate `:memory:` pools prohibited; a route test must prove append → artifact → snapshot/replay → assemble observe the same data; if accepted service APIs cannot share stores without consuming them, route a narrow B2/B3/B5 DI reopen (additive constructors), never duplicate store logic or add route-local caches; (4) request/response bodies are protocol DTOs only with contract §4.2 status mapping; the observed missing top-level `deny_unknown_fields` on `CreateSessionRequestV0`/`AssembleRequestV0` is closed via an authorized narrow A2 reopen with rejection tests — never via route-local clone DTOs; (5) route tests use the existing tower `ServiceExt`/`http-body-util` dev-deps; no `axum-test` dependency.

## Execute

Checklist:
- [x] owned files only (`routes.rs`, `tests/slice0_platform_contract.rs`) plus granted/authorized reopens; one disclosed grant cascade: `main.rs` state wiring forced by the `build_router` signature change — recorded here as ACCEPTED boundary expansion (`SUCCESSOR_CONTEXT_PLATFORM_DB` env var + default `successor-context-platform.sqlite3` path are deliberate runtime configuration, not accidental drift)
- [x] shared interfaces imported from `successor-protocol`; no route-local clone DTOs
- [x] no forbidden shortcuts
- [x] tests/checks added inside owned scope (9 route-contract tests incl. one-database coherence, no-echo, nested-rejection)
- [x] targeted validation passed (platform 86 tests; protocol 76 tests)
- [x] orchestrator-owned `make check-rs` gate green before review dispatch (`f6ff2b6c5`) and after review fixes (`b93ce45da`)
- [x] named risks retired or routed (split-state prohibited; same-path WAL pattern per dissent ruling 3 without DI reopens; redacted error envelopes)
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; tasks 154, 158)
- [x] fixture sovereignty preserved; no fixture edits (nested DTO tightening verified against both canonical assemble-request fixtures)
- [x] accepted-module edits only under grants/reopens: B1 (`lib.rs` +1, `http.rs` mount, disclosed `main.rs` cascade); A2 (`platform_api.rs` deny_unknown_fields on `CreateSessionRequestV0`, `AssembleRequestV0`, then five nested DTOs)
- [x] all route JSON boundaries reject unknown fields, top-level and nested
- [x] workspace lint gate green before review
- [x] no dispatch over-constraint

Changed files:
- New: `crates/successor-context-platform/src/routes.rs`, `crates/successor-context-platform/tests/slice0_platform_contract.rs`
- Granted B1 reopen: `lib.rs` (+1 `pub mod routes;`), `http.rs` (router mount replacing fallback wiring), `main.rs` (state wiring cascade, accepted above)
- Authorized A2 reopen: `crates/successor-protocol/src/platform_api.rs` — `deny_unknown_fields` on both request roots and five nested DTOs, with rejection tests
- Bootstrap disclosure: platform `Cargo.toml` names `serde` directly

Validation evidence:
- Platform: 86 tests green (56 unit + 12 assembly + 9 route-contract + 9 replay); full pipeline against canonical fixtures: create → append → pages → event → artifact byte-exact → snapshot fixture-equal → both assembles fixture-equal → trace; per-endpoint auth 401s; one-database coherence; no-echo assertions (nested credential-shaped fields, provider-shaped bearer, malformed JSON)
- Protocol: 76 tests green incl. 4 nested-rejection tests; canonical fixtures still parse
- `make check-rs` exit 0 at `f6ff2b6c5` and `b93ce45da`

## Code Review

Reviewer: `slice0-reviewer` (task 155-B6CodeReview, checkout-proof at `f6ff2b6c5`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Findings:
- P1: five nested request DTOs accepted unknown fields — nested credential-shaped keys silently dropped.
- P1: `decode_body` echoed serde's raw error text (incl. unknown field names) into public `ErrorEnvelopeV0`.

Fixes applied (task 158, commit `b93ce45da`):
- `deny_unknown_fields` on all five nested DTOs, nested-rejection tests, no fixture conflicts.
- Category-level redaction in `decode_body` (not-valid-JSON / schema-mismatch / io) never echoing caller bytes; no-echo tests for nested fields, provider-shaped bearer, and malformed JSON.

## Drift Review

Original aim: thin route wiring of the full contract §6 endpoint set over accepted B1–B5 services.
Current work: tasks 154+158 as committed through `b93ce45da`.
Gap: none material (task 157-B6DriftReview: minor drift — the `main.rs` grant cascade, now recorded as accepted boundary expansion; evidence hardening requested and delivered in task 158).
Verdict: minor drift, resolved
Authority boundary: ambiguous → resolved by explicit orchestrator acceptance of the `main.rs` cascade above

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 156-B6SuperegoReview, checkout-proof at `f6ff2b6c5`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Frame risks:
- Unknown-field sovereignty incomplete at nested route boundaries; packet evidence unfilled.

Required corrections:
- Nested deny_unknown_fields with route/protocol tests — applied in task 158; validation evidence recorded — this update.

## Delivery

Status: accepted
Residual risks:
- The four-independent-pools-one-path WAL design is safe for Slice 0 (append serialization lives in B2's single-connection store; cross-store writes touch disjoint tables with FK checks) but is a documented pattern, not a constraint; revisit before any multi-writer scaling.
- `SUCCESSOR_CONTEXT_PLATFORM_DB` env var + default DB path are now the platform's runtime configuration surface; future config work must treat them as public.
- Route-visible stage/trace semantics inherit B5's disclosed generalizations; external consumers beyond Slice 0 need contract text before relying on them.
Human verification needed:
- None outstanding. Wave B (B1–B6) is complete: all lanes accepted with evidence trails.
