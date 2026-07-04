# Lane C1 — KernelPlatformClient

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
- Platform request/response DTOs must be imported from `successor-protocol`; no local `RawEvent`, `EventPage`, `AssemblyResponse`, artifact, trace, or error clones.
- The client must send only `Authorization: Bearer <MEMEX_LICENSE>` to the platform; provider credentials, OAuth/subscription state, API keys, and provider auth metadata must never enter platform requests, raw events, artifacts, traces, logs, or error details.
- Append responses must trust platform-assigned `session_seq`; kernel code must not derive ordering from proposed or local raw-event sequence values.
- Unknown fields, malformed platform responses, and error envelopes must be handled at typed serde boundaries rather than helper-only checks.
- Any fix for credential leakage, platform-assigned-field trust, or route DTO drift requires a targeted regression test or contract assertion that would fail before the correction.
- Cargo/workspace bootstrap changes (`reqwest`, `tokio`, `serde_json`, `thiserror`, `tracing`, generated `Cargo.lock`, or exact equivalents) must be disclosed as bootstrap artifacts, not accidental drift.

## Fan-out / Dependency Order

Required staging: C8 lands the kernel crate shell first, or grants append-only `lib.rs` module declarations per lane after owned files exist. C1 must not edit C8-owned `lib.rs` except under that explicit module-declaration grant and must not touch C8 local RPC files. C1 may run after the C8 shell/grant and accepted Wave B platform route surface are present.

Parallelization: after the C8 shell/grant, C1 can run in parallel with C2, C3 auth, and C5 tool-catalog/read work because file ownership is disjoint. C7 and full C8 depend on C1's accepted platform client API. If C1 discovers the accepted platform route API cannot satisfy contract §6 without platform changes, it must stop and file an Interface Change Request; it must not import platform crate internals.

## Aim

- Outcome: implement the kernel-side HTTP client for the live platform `/v0` API so the standalone successor kernel consumes platform sessions, events, artifacts, snapshots, assemblies, and traces over HTTP with strict auth-plane separation.
- Contract clause(s) served: contract §0 execution target; §2.3 context platform is canonical; §2.4 auth planes are separate; §3 ordering authority; §4 RawEvent append rules; §4.2 `ErrorEnvelopeV0`; §6 full Context Platform API v0 endpoint set; §11 resume semantics; §13 acceptance criteria 2, 8, 9, and 12.
- Fixture(s) served: `raw-events-successful-turn.json`, `raw-events-unsupported-tool.json`, `assemble-request-pre-tool.json`, `assemble-response-pre-tool.json`, `assemble-request-post-read.json`, `assemble-response-post-read.json`, `session-snapshot.json`, and artifact/trace observations implied by those fixtures.
- Files owned:
  - `crates/successor-kernel/src/platform_client.rs`
  - `crates/successor-kernel/src/platform_http.rs`
  - `crates/successor-kernel/src/platform_error.rs`
- Dependencies: accepted `successor-protocol` DTOs/errors/IDs; accepted Wave B platform HTTP contract and `SUCCESSOR_CONTEXT_PLATFORM_DB` runtime surface only through HTTP; C8 shell/module grant; disclosed Cargo bootstrap for async HTTP client substrate.
- Explicit non-goals: platform server internals, SQLite/store access, provider auth resolution, provider request projection, tool execution, turn state machine orchestration, local kernel RPC/SSE, CLI behavior, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: branch `successor-main` is recorded at `921e1e1ad`, pushed. A0–A5 and B1–B6 are accepted with evidence trails. Platform has 86 tests, protocol has 181 tests, and `make check-rs` exited 0. The live platform surface is the full `/v0` contract §6 endpoint set guarded by `MEMEX_LICENSE`; `crates/successor-kernel/` is still a stub with only `successor-protocol` as a dependency.
- Constraints: kernel consumes the platform over HTTP only; no direct platform crate imports or SQLite access. Platform auth is `MEMEX_LICENSE`; provider credentials stay local to provider-auth code and must not be passed through this client. `/assemble` is the only semantic context path. Platform assigns `session_seq`.
- Named risks: collapsing provider auth into platform auth; leaking bearer/provider tokens in errors or traces; inventing route-local DTOs; treating platform response order as local state without validating response shape; hiding reqwest/tokio bootstrap changes; retry/idempotency behavior that changes raw event meaning.
- Edge cases: missing/invalid platform auth; provider-key-shaped platform bearer; malformed JSON error body; 401/403/404/409/422/429/500/503 mapping; duplicate append response; event page pagination; artifact not found; platform unavailable; `/assemble` degradation; trace fetch after assemble.
- Interface dependencies: accepted protocol route DTOs and `ErrorEnvelopeV0`; accepted B6 endpoint status/body contract; caller-provided `MEMEX_LICENSE`/base URL configuration from kernel-local config; no platform crate internals.
- Authority boundaries: C1 owns client transport/error translation only. It may define private transport structs only when protocol DTOs cannot represent internal client state, and those structs must not become public JSON boundaries.
- Ambiguities to record, not resolve: the dispatch map does not assign a C1 test file even though client behavior needs credential-leak/error-mapping regression tests; `Cargo.toml`/`Cargo.lock` are not in the owned-file list but `reqwest`/`tokio` bootstrap is required by contract substrate; exact retry/backoff policy is not specified for Slice 0.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Thin typed `reqwest` client over contract §6 DTOs | Preserves HTTP boundary and reuses protocol types | Requires disclosed Cargo bootstrap | selected |
| Import platform crate services directly | Easier local calls | Couples kernel to platform internals and bypasses auth/HTTP contract | violates contract §0/§6 boundary |
| Shell out to curl or ad hoc JSON | Fast to prototype | Loses typed validation, error mapping, and credential hygiene | forbidden shortcut |

Selected approach: build a kernel-local platform client with typed request/response functions for every contract §6 endpoint, one redacted platform-error layer that maps `ErrorEnvelopeV0`/transport failures without echoing credentials, and a strict auth injection seam that accepts only the platform bearer token and base URL.

Invalidated if: accepted platform/protocol DTOs cannot express required endpoint bodies, route behavior differs from contract §6, or the client cannot be tested without leaking provider/platform tokens.

Stop/pivot if: implementation needs platform crate internals, accepted protocol changes, fixture edits, local semantic assembly, provider auth material in platform calls, or unowned route/server changes.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C1 touches auth-plane boundary, persisted event append behavior, platform sequence trust, and client-side contract semantics.

If completed (task 163-C1PreExecutionDissent, verdict ALLOW / PROCEED-WITH-CONDITIONS, checkout-proof `e8562c6af`):
- Dissent concern: the client lane could quietly invent wire shapes, redefine the error envelope, couple kernel production code to platform internals, or leak entitlement material through logs/errors; the test strategy is a one-way door (mocks invent behavior; in-process shortcuts skip the real HTTP contract).
- Response: contract §4.2 names `ErrorEnvelopeV0` as the error body and §2.4 defines `MEMEX_LICENSE` custody; protocol already carries every platform API DTO C1 needs; the platform exposes the accepted `build_router` plus env-configured binary, enabling real-router tests without mocks.
- Outcome: PROCEED with orchestrator rulings: (1) no Cargo change beyond the shell substrate EXCEPT a test-only dev-dependency on `successor-context-platform`; kernel-local transport/error enum lives in `platform_error.rs`, wrapping status + protocol `ErrorEnvelopeV0` when present — never a parallel envelope; transport/malformed-response errors redacted; (2) integration tests bind the accepted platform router on `127.0.0.1:0` with a real temp SQLite DB and exercise the reqwest client over real TCP; production code never imports the platform crate; `tower::ServiceExt`/oneshot and hand-rolled mock platform servers are PROHIBITED; subprocess black-box smoke deferred to e2e; (3) client-local structs only for non-JSON internal state (base URL, resolved bearer, cursor state, retry classification, redacted diagnostics); any new wire shape is a routed reopen, never client-local; (4) `MEMEX_LICENSE` read via the kernel config seam from env, held in a redacted-Debug type, never logged/echoed; provider credentials strictly out of C1 scope (C3); (5) full §6 client surface including traces — C2/C7 depend on it.

## Execute

Checklist:
- [x] owned files only (platform_client.rs, platform_http.rs, platform_error.rs replacing their C8-shell stubs) plus dev-dependency staging: `successor-context-platform` (dissent ruling 1) and `axum` (test-server bind; disclosed by executor, RATIFIED by orchestrator after Superego task 165 — recorded in commit `5bee8a46b`); production dep tree proven free of both via `cargo tree -e normal`
- [x] shared interfaces imported from `successor-protocol`; no local duplicate platform DTOs
- [x] no forbidden shortcuts: no platform crate imports in production code, no SQLite access, no mock platform servers, no oneshot
- [x] tests routed: C1-owned `tests/slice0_platform_client.rs` resolves the dispatch-map test-file ambiguity (real router, real TCP, temp SQLite)
- [x] targeted validation passed (4 unit + 7 integration kernel tests); orchestrator `make check-rs` exit 0 at `72d28cbc7` and `5bee8a46b`
- [x] named risks retired: bearer redaction proven by dedicated tests (Debug/Display/transport paths); `session_seq` consumed only from platform responses, never client-supplied
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; tasks 164, 168)
- [x] fixture sovereignty preserved; no fixture/contract edits
- [x] A4 unsupported-tool residual untouched — the client transports DTOs and takes no projection-semantics position

Changed files:
- `crates/successor-kernel/src/{platform_client.rs, platform_http.rs, platform_error.rs}`, new `crates/successor-kernel/tests/slice0_platform_client.rs`
- `crates/successor-kernel/Cargo.toml` dev-dependencies (successor-context-platform, axum), `Cargo.lock` transitive

Validation evidence:
- 4 unit + 7 integration tests green: full §6 happy path over real TCP with canonical fixtures, duplicate=true replay, typed 401/404/400 envelopes, malformed-body redaction, URL-join pinning for `/v0` bases with and without trailing slash
- `cargo tree -p successor-kernel -e normal`: no successor-context-platform, no axum
- `make check-rs` exit 0 at both commits

## Code Review

Reviewer: `slice0-reviewer` (task 167-C1CodeReview, checkout-proof at `72d28cbc7`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Findings:
- P1: client hardcoded `/v0/...` onto the caller base URL while contract §6 defines the base URL as the `/v0` API base — contract-faithful callers would request `/v0/v0/...`; tests masked it by using the router root as base.

Fixes applied (task 168, commit `5bee8a46b`):
- All eight endpoint paths contract-relative; base URL semantics documented; harness binds `http://{addr}/v0`; two URL-join pinning tests prevent silent regression.

## Drift Review

Original aim: kernel-side HTTP platform client over `/v0` with auth-plane separation.
Current work: tasks 164+168 as committed through `5bee8a46b`.
Gap: none material (task 166-C1DriftReview: client-only lane held; no config/provider/frame/retry-policy ownership taken; is_retryable classification-only noted as within dissent allowance).
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 165-C1SuperegoReview, checkout-proof at `72d28cbc7`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Frame risks:
- None in code (HTTP-only boundary, DTO/envelope sovereignty, redacted custody all confirmed). Two governance items: the axum dev-dependency exceeded the literal ruling-1 grant and needed explicit ratification; packet evidence was stale.

Required corrections:
- Axum dev-dependency RATIFIED by orchestrator (commit `5bee8a46b` message) as a necessary companion of the granted real-TCP test ruling; this evidence fill closes the staleness item.

## Delivery

Status: accepted
Residual risks:
- Retry POLICY is deliberately unowned: `is_retryable()` classifies, consumers decide; C7 turn runner must own any retry loop explicitly.
- Subprocess black-box smoke of the platform binary is deferred to Wave D e2e; in-lane coverage binds the accepted router in-process over real TCP.
Human verification needed:
- None outstanding.
