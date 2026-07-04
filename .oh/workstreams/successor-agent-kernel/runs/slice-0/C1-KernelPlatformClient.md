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

If completed:
- Dissent concern: pending.
- Response: pending.
- Outcome: pending.

## Execute

Checklist:
- [ ] owned files only, plus explicit C8 `lib.rs` module grant and disclosed Cargo bootstrap artifacts if authorized
- [ ] shared interfaces imported from `successor-protocol`; no local duplicate platform DTOs
- [ ] no forbidden shortcuts: no direct platform crate imports, SQLite access, curl/shell, or local semantic assembly fallback
- [ ] tests/checks added or explicitly routed for the dispatch-map test-file ambiguity
- [ ] targeted validation passed (`cargo test -p successor-kernel` minimum, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, especially credential no-echo and platform-assigned `session_seq` trust
- [ ] model binding verified for execution agent
- [ ] fixture sovereignty preserved; no fixture/contract edits
- [ ] residual A4 unsupported-tool projection issue is not worked around in the client

Changed files:
- Pending execution.

Validation evidence:
- Pending execution.

## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: pending

Findings:
- Pending execution.

Fixes applied:
- Pending execution.

## Drift Review

Original aim: kernel-side HTTP platform client over `/v0` with auth-plane separation.
Current work: pending execution.
Gap: pending.
Verdict: pending
Authority boundary: pending

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: pending

Frame risks:
- Pending execution.

Required corrections:
- Pending execution.

## Delivery

Status: pending execution
Residual risks:
- C1 has no dispatch-owned test file; orchestration must grant/reroute tests before acceptance.
- Exact HTTP retry/backoff policy is unspecified; dissent must either defer or bound it.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
