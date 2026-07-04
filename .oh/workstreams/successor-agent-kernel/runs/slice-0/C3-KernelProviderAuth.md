# Lane C3 — KernelProviderAuth

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
- Provider auth is local kernel custody only; provider credentials must never be serialized to protocol/platform DTOs, raw events, artifacts, traces, fixtures, SSE frames, logs, or error details.
- Platform `MEMEX_LICENSE` and provider API/OAuth/subscription credentials are separate auth planes; neither may authorize the other.
- Credential scanning expectations from review learnings §4 apply to any test/debug output this lane creates: high-confidence secret-looking values and keys must be rejected or redacted.
- Resume must re-resolve provider auth locally; no local session-file copy and no platform-stored provider credential handles.
- Unknown-field rejection and deny-by-default config parsing are required where config files/env-derived structured data become security boundaries.
- Any correction for leaked credentials or auth-plane collapse needs an adversarial regression test that would have failed before the fix.

## Fan-out / Dependency Order

Required staging: C8 lands the kernel crate shell first, or grants top-level module declarations. Because C3 owns files under `src/provider/` while C4 owns `src/provider/mod.rs`, C4 must first land a provider-namespace shell or grant C3 append-only provider module declarations for `auth` and `credentials`. C3 full execution should precede C4 full provider projection.

Parallelization: after C8 shell plus C4 provider-namespace shell/grant, C3 can run in parallel with C1, C2, and C5. C4 depends on C3's accepted auth resolver. C7 depends on C3/C4 for live provider work. Full C8 must not expose provider-secret inspection endpoints.

## Aim

- Outcome: implement local-only provider credential resolution and redaction boundaries for the standalone successor kernel, preserving provider auth across live turns/resume without sending or persisting credentials outside kernel custody.
- Contract clause(s) served: contract §2.4 auth planes are separate; §10 provider projection/auth rules; §11 resume semantics; §13 acceptance criteria 7, 8, and 9; runbook Wave C dissent trigger for local provider auth.
- Fixture(s) served: `provider-shape-normalization.json` secret-absence expectations; `raw-events-successful-turn.json` and `raw-events-unsupported-tool.json` no-credential guarantees; later leak scans over traces/SSE/CLI output.
- Files owned:
  - `crates/successor-kernel/src/provider/auth.rs`
  - `crates/successor-kernel/src/provider/credentials.rs`
  - `crates/successor-kernel/src/config.rs`
- Dependencies: accepted protocol provider-shape enums and trace DTOs for metadata-only observations; local environment/config inputs; C4 provider namespace shell/grant; downstream C4 provider projection and C7 runner.
- Explicit non-goals: provider wire/request projection, Anthropic/OpenAI shape normalization, platform auth client behavior, platform storage/routes, tool execution, turn lifecycle, local RPC endpoints, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: provider credentials are confirmed available in the environment for live provider work, but the kernel crate has no config/auth modules. The platform stack is accepted and must never receive provider credentials.
- Constraints: Slice 0 may use API-key/dev-token local provider auth only; subscription/OAuth login is roadmap, not required. Provider credentials re-resolve on resume. Provider credentials are redacted and not serializable. Platform auth remains `MEMEX_LICENSE` only.
- Named risks: storing provider credentials in raw events/traces/artifacts for convenience; treating `MEMEX_LICENSE` as model spend auth; logging env var values on config errors; exposing credentials through local RPC; making provider auth a stable protocol DTO; inventing OAuth/subscription behavior for Slice 0.
- Edge cases: missing provider credential; unsupported provider selected; malformed config; provider-key-shaped platform token; `MEMEX_LICENSE` present but provider key absent; resume after process restart; redaction in Debug/Display/error paths; multiple provider shape fixtures with one live provider credential.
- Interface dependencies: C4 needs a redacted credential handle/resolver, not raw secret serialization; C7 needs failure/error surfaces that can produce safe `error.recorded` events without embedding secrets.
- Authority boundaries: C3 owns local config and credential custody only. It must not build provider request payloads, perform provider HTTP calls, or send credentials to C1/platform.
- Ambiguities to record, not resolve: exact environment variable names for provider credentials are not specified in the contract; C3 has no dispatch-owned test file despite security-critical behavior; `provider/mod.rs` is owned by C4 but needed as namespace shell for C3-owned files; exact dependency needs for secret redaction helpers are unspecified.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Local redacted credential resolver with non-serializable secret wrapper | Preserves custody and gives C4/C7 a narrow seam | Requires careful test grants | selected |
| Pass provider keys as strings through runner/platform events | Simple plumbing | Leaks secrets and collapses auth planes | contract violation |
| Implement full oh-omp OAuth/subscription login now | Future-compatible | Exceeds Slice 0 and risks persistence leaks | out of scope |

Selected approach: define a kernel-local config/auth resolver that reads approved local inputs, returns redacted/non-serializable credential handles to provider adapters, exposes safe error types, and proves secrets do not appear in serialization, debug output, platform DTOs, or trace inputs.

Invalidated if: live provider work requires credentials to be persisted in platform/session state, or accepted provider projection APIs require raw credential serialization.

Stop/pivot if: implementation needs to alter platform/protocol DTOs to carry provider credentials, invent provider auth contract fields, expose credentials over local RPC, or implement subscription/OAuth login beyond Slice 0.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C3 directly touches the local provider auth boundary and credential custody rules.

If completed (task 174-C3PreExecutionDissent, verdict ALLOW / PROCEED-WITH-CONDITIONS, checkout-proof `85a4ca9b8`):
- Dissent concern: provider credentials are the highest-consequence material in the kernel; risks are serde-reachable secrets (any `Serialize` path into raw events/frames/artifacts/platform DTOs), a prematurely public provider-generic env contract the Slice 0 contract does not pin, config-file sources without deny-by-default boundaries, persisted token state violating resume semantics, and missing-credential failures collapsing the wrong auth plane.
- Response: contract §2.4 pins `MEMEX_LICENSE` as the platform plane and keeps provider auth local; §10 allows API-key/dev-token local auth only (OAuth/subscription roadmap); §11 resume is re-resolution, not restoration; acceptance criteria 7–9 require custody, redaction, and resume proofs. The shell already declares `provider::{auth, credentials}`, so C4-owned `provider/mod.rs` needs no C3 edits; C1's `EntitlementToken` sets the redacted-newtype precedent.
- Outcome: PROCEED with orchestrator rulings: (1) C3 edits only `config.rs`, `provider/auth.rs`, `provider/credentials.rs`; `provider/mod.rs` untouched (any need becomes an explicit append-only staging grant); no Cargo changes — no provider SDKs, keyring, or zeroize (zeroization recorded as deferred); (2) test-file grant: C3-owned `crates/successor-kernel/tests/slice0_provider_auth.rs`; (3) credential sources: Anthropic-only env resolution (`ANTHROPIC_API_KEY`) behind an internal registry seam — NOT a public provider-generic contract; config-file sources deferred; missing provider credential is a typed local provider-auth degradation consumed by C4/C7, never a kernel-start hard error and never conflated with platform-entitlement failure; (4) custody: secret newtypes with redacted `Debug`/`Display` and non-`Serialize` BY CONSTRUCTION; header materialization private to the provider boundary; runtime scanning is regression defense only; (5) `config.rs` owns env sourcing of `MEMEX_LICENSE` + platform `/v0` base URL for C1 constructor injection, keeping the two auth planes as distinct types that cannot cross-authorize; (6) resume = stateless re-resolution from the environment; persisted token state prohibited.

## Execute

Checklist:
- [ ] owned files only, plus explicit C8 top-level module grant and C4 provider-namespace shell/grant if authorized
- [ ] shared protocol/provider shape metadata imported from owner crate; no credential DTOs in protocol/platform shapes
- [ ] no forbidden shortcuts: no credential logging, serialization, platform storage, or local RPC exposure
- [ ] tests/checks added or explicitly routed for the dispatch-map test-file ambiguity
- [ ] targeted validation passed (`cargo test -p successor-kernel` minimum, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, especially provider credential no-echo and auth-plane separation
- [ ] model binding verified for execution agent
- [ ] fixture sovereignty preserved; no fixture/contract edits

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

Original aim: local-only provider credential resolver and redaction boundary.
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
- Provider credential env names are unspecified; dissent must bind or explicitly leave them as config inputs without inventing public contract.
- C3 has no dispatch-owned security test file; orchestration must grant/reroute tests before acceptance.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
