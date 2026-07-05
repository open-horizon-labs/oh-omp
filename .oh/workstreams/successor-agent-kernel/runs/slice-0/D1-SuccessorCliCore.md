# Lane D1 — SuccessorCliCore

## Model Binding

- Intended execution agent: `slice0-executor` (active Wave D execution label)
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
- The CLI is a stateless client/renderer. It must not own sessions, provider auth, replay, semantic context, tools, raw-event append, transcript parsing, or local session DB/cache.
- Raw events remain canonical truth; D1 may only submit turns through the frozen kernel RPC/SSE surface and render returned IDs/events without inventing a parallel lifecycle model.
- The CLI must preserve contract-critical IDs in machine-readable output and must not sanitize away `session_id`, `turn_id`, `raw_event_id`, `raw_event_session_seq`, artifact IDs, or error envelope IDs.
- Provider credentials, OAuth tokens, subscription material, and raw `MEMEX_LICENSE` values must never print in text, JSON, SSE, errors, traces, or test failure messages.
- Fixture sovereignty holds: D1 tests may consume accepted fixtures/oracles but must not edit, weaken, duplicate with divergent semantics, or contradict the accepted fixture contract.
- No unsupported-tool stream may use `project_session` as an oracle. Unsupported-tool projection semantics are routed through the accepted unsupported-tool lifecycle validator only.

Inherited Wave C residual law:
1. SESSION SEMANTICS: `POST /v0/turns` starts a runner-owned session and does NOT continue a created/attached session; `POST /v0/sessions` and `GET /v0/sessions/{id}` are independent thin wrappers; D1 MUST NOT present attach as turn continuation; session-continuation capability requires a narrow C7 reopen with dissent — never a CLI workaround.
2. Durable C8/D1 interface: the four kernel routes and `api.rs` wrappers are frozen; CLI consumes them as-is; changes require contract-level treatment.
3. Bare zero-event sessions 422 on snapshot replay; CLI create-then-attach flows must account for it and must not misreport an empty created session as a resumable turn history.
4. A4 unsupported-tool projection semantics routed; no CLI/test may call `project_session` on unsupported-tool streams as an oracle.
5. RealIdFactory UUID-shaped std-only ids surface through RPC responses — accepted Slice 0 residual, revisit pre-multi-tenant.
6. Fixture sovereignty + the C7 oracle law in `crates/successor-kernel/tests/slice0_kernel_contract.rs`: end-to-end or CLI tests must not weaken, duplicate, or contradict those oracles.

## Fan-out / Dependency Order

- Wave order: D1 runs before D2. D2's `crates/successor-cli/tests/slice0_cli_smoke.rs` consumes the D1 binary/API.
- D1 depends on accepted C8 local RPC/SSE API and C7 runner semantics. It must not reopen C8 route/API contracts inside this lane.
- D1 may disclose bootstrap edits to `crates/successor-cli/Cargo.toml` only for CLI dependencies needed by the adjudicated RPC/SSE client approach.
- D1 must not modify `crates/successor-kernel`, `crates/successor-context-platform`, `crates/successor-protocol`, fixture files, contract files, or accepted C-wave tests.
- Stop if implementation requires route additions, session-continuation semantics, fixture amendments, provider direct calls, tool direct calls, or a second platform/store path.

## Aim

Build the Slice 0 stateless CLI core for `successor-cli`: a client/renderer that submits through the frozen kernel RPC/SSE surface and preserves IDs in JSON/SSE output.

Owned files:
- `crates/successor-cli/src/main.rs`
- `crates/successor-cli/src/args.rs`
- `crates/successor-cli/src/client.rs`
- `crates/successor-cli/src/render.rs`
- `crates/successor-cli/tests/slice0_cli_contract.rs`
- `crates/successor-cli/Cargo.toml` as disclosed bootstrap only

Gate:
- Stateless CLI submits turns through kernel RPC/SSE.
- JSON and SSE output preserve kernel-surfaced IDs and error envelopes.
- CLI does not directly own sessions, replay, providers, tools, raw-event append, semantic context, or local persistence.

## Problem Space

Authoritative contract constraints:
- Dispatch map §4.5 says the CLI is a stateless client/renderer and proposes `ask`, `resume`, and `inspect session` commands with `--workspace-root`, `--prompt`, `--session-id`, `--kernel-url`, `--platform-url`, and `--format text|json|sse` surfaces.
- Dispatch map §4.5 CLI must-not list is binding: no local session DB/cache, no direct providers, no direct tools, no direct raw-event append, no transcript-to-context parsing, no credential printing, no sanitizing contract-critical IDs from machine-readable output.
- C8 accepted four frozen kernel routes: `POST /v0/sessions`, `GET /v0/sessions/{id}`, `POST /v0/turns`, and `GET /v0/resume/{id}`. D1 consumes the route/API wrappers as-is from `crates/successor-kernel/src/api.rs` and C8 tests; D1 must not rename routes, change lifecycle semantics, or add compatibility shims.
- C8 session semantics are intentionally narrow: `POST /v0/turns` starts a runner-owned session. Created/attached sessions are independent wrappers and are not continued by turn submission.
- Contract machine-readable output must preserve opaque prefix-typed IDs. UUID-shaped std-only IDs from `RealIdFactory` are accepted residual behavior for Slice 0.

Actual current state observed before packet write:
- Root `Cargo.toml` uses `members = ["crates/*"]`; `crates/successor-cli` is included by the workspace glob.
- `crates/successor-cli/Cargo.toml` exists with package name `successor-cli`, workspace version/edition/license/authors/repository, one dependency on `successor-protocol`, and a `[[bin]]` named `successor-cli`.
- `crates/successor-cli/src/main.rs` exists and contains only `const fn main() {}`.
- `crates/successor-cli/src/args.rs`, `client.rs`, and `render.rs` do not exist.
- `crates/successor-cli/tests/` does not exist; `crates/successor-cli/tests/slice0_cli_contract.rs` does not exist.

Risk framing:
- The main risk is accidentally turning the CLI into a second kernel/platform by adding local persistence, replay, provider auth, or tool execution to make local demos convenient.
- The second risk is output drift: text output may be human-friendly, but JSON/SSE must remain machine-checkable and must not omit IDs needed by D2 smoke or downstream orchestrators.
- The third risk is false session-continuation UX: `--session-id` cannot imply that `ask` continues an existing session unless C7 is narrowly reopened with dissent and the kernel gains that capability.

## Solution Space

Expected shape after dissent approval:
- `args.rs`: parse the adjudicated command/flag surface without using environment values as hidden behavior except explicitly adjudicated credentials/config. The parser should reject unsupported command combinations rather than silently falling back to non-contract behavior.
- `client.rs`: call the frozen C8 route/API surface over the adjudicated transport. It should keep request/response DTO usage aligned with accepted API wrappers and preserve HTTP/SSE error envelopes.
- `render.rs`: render text, JSON, and SSE without dropping IDs or leaking secrets. JSON/SSE are contract surfaces, not lossy presentation layers.
- `main.rs`: wire args → client → renderer, own process exit mapping, and avoid embedding provider/tool/platform logic.
- `slice0_cli_contract.rs`: prove the externally observable CLI contract: stateless submission path, ID preservation in JSON/SSE, error envelope preservation, no credential echo, no session-continuation overclaim, and rejection of unsupported local-only behavior.

Transport options requiring dissent adjudication:
1. External listener only: require `--kernel-url` or an env/config equivalent to an already-running kernel. This keeps the CLI as a pure client but pushes server lifecycle to tests/orchestration and may make the binary unusable without a companion launcher.
2. In-process bootstrap of the kernel `serve()`/router on a loopback ephemeral listener, then call it via RPC/SSE. This can make D1/D2 deterministic without a daemon, but it risks broadening CLI dependencies and must not make the CLI a second platform or a direct runner facade.
3. Hybrid: default to external listener, with an explicit opt-in in-process bootstrap for tests/local smoke. This may satisfy both ergonomics and purity, but it creates a one-way-door public flag unless kept test-only/internal.

Output contract options requiring dissent adjudication:
1. Pass-through JSON envelopes matching the kernel API/SSE response shapes exactly where possible.
2. CLI-owned JSON envelope that nests kernel responses under stable fields while preserving every contract-critical ID and error envelope.
3. Text for humans plus `--format json|sse` as the only machine-readable modes; text may summarize but must not be used as a contract oracle.

Validation targets for the executor to fill with observed evidence:
- Focused successor-cli contract tests.
- Focused D1 command-level invocations against deterministic kernel RPC/SSE fixture/server path.
- `make check-rs` or the repository's accepted Rust check command, unless the orchestrator provides stronger scoped validation.
- Credential leak assertion using sentinel values across stdout/stderr, JSON, SSE, and captured error paths.

## Ambiguities

Record these; do not resolve them by invention before dissent:
- Kernel reachability: C8 ruled the kernel LIB-ONLY; D1 must decide whether the CLI reaches RPC/SSE by spawning an in-process `serve()`/router, connecting to an external listener, or a hybrid. Contract implications are listed in Solution Space.
- CLI arg surface: dispatch map proposes command names and flags, but the final public grammar is under-specified. Dissent must decide which commands/flags are Slice 0 contract and which are test/local conveniences.
- `--session-id` semantics: it may be valid for `resume` and `inspect session`; it must not make `ask` look like session continuation unless a C7 reopen provides that capability.
- JSON output schema: IDs must be preserved, but the contract does not yet decide whether CLI JSON is a pass-through kernel envelope or a CLI-owned envelope containing kernel responses.
- SSE output schema: D1 must preserve route event names/lifecycle semantics from C8, but the exact CLI framing around raw SSE bytes vs parsed/re-emitted lines needs dissent.
- Environment acquisition: how the CLI receives `MEMEX_LICENSE`, provider env, platform URL, or kernel URL is under-specified. C3 precedent is env-only and redacted; no secret may print.
- Exit codes: mapping HTTP/RPC/domain errors to process exit codes is not fully specified; tests should assert the chosen observable contract once dissent approves it.
- Cargo bootstrap: current manifest only depends on `successor-protocol`; transport/arg parsing may require additional dependencies, but dependency direction must not violate A0/dispatch constraints.

## Dissent

Verdict: required-before-execute / completed (task 238, PROCEED-WITH-CONDITIONS; record below)

If skipped, rationale: not applicable; D1 fixes public CLI command grammar, process/transport lifecycle, machine-readable output envelopes, session UX semantics, error/exit mapping, and credential exposure boundaries.

Required dissent questions:
- In-process vs external listener vs hybrid: which approach is allowed for Slice 0, and what are its dependency/lifecycle limits?
- Public arg/output surface: which command names, flags, formats, exit codes, and JSON/SSE envelopes become contractual in D1?
- Session wording: how must CLI help/errors prevent users from interpreting `POST /v0/turns` as continuation of a created/attached session?
- Secret handling: which env vars are permitted, how are they redacted, and what sentinel leak scan is mandatory for CLI stdout/stderr/SSE/JSON?
- Test oracle strength: which D1 tests assert public CLI contracts without duplicating or weakening accepted kernel/protocol/platform oracles?

If completed (task 238-D1PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof `1c10f9d6c`; full binding rulings in `agent://238-D1PreExecutionDissent`):
- Dissent concern: D1 could accidentally decide a one-way architecture door — a pure client with no Slice 0 launcher, or an in-process CLI bypassing the frozen RPC/SSE seam — or invent session-continuation grammar, wrap kernel frames in a second schema, or leak provider/platform credentials while adding dependencies without disclosure.
- Response: constrained hybrid — default ephemeral in-process kernel bootstrap per invocation plus explicit `--kernel-url` override, with ALL behavior after bootstrap going through the frozen `/v0/*` HTTP/SSE surface; grammar narrowed to ask/resume/inspect with no `ask --session-id`; machine output is pass-through kernel JSON or raw C2 SSE only; env reads exactly the C3 kernel auth/config seams; clap/reqwest/tokio/serde/serde_json/futures-util/successor-kernel additions disclosed and bounded.
- Outcome: PROCEED-WITH-CONDITIONS with orchestrator rulings (full text agent://238): (1) reachability = hybrid; `--kernel-url` makes the CLI a pure HTTP/SSE client (no bootstrap, no secret reads); in-process default binds ephemeral loopback and dies with the invocation — no daemon, PID file, or cross-invocation state; CLI never calls runner/tools/provider/platform internals directly; (2) grammar pinned exactly: `ask --workspace-root <path> --prompt <text> [--kernel-url] [--platform-url] [--format text|sse]`; `resume --session-id <ses_...> [...] [--format json|text]`; `inspect session --session-id <ses_...> [...] [--format json|text]`; `ask --session-id` FORBIDDEN; `--platform-url` rejected when combined with `--kernel-url`; no env alias for kernel URL; (3) machine output pass-through only — JSON routes write kernel api.rs/ErrorEnvelopeV0 bodies unchanged; `--format sse` writes C2-rendered records byte-for-byte; no `ask --format json` in D1; wrappers/renames/synthetic IDs/NDJSON = second-schema violation; text mode is human-only, never a fixture oracle; (4) clap REQUIRED (default-features off; std/derive/help/usage/error-context; env feature forbidden); (5) env reads pinned: in-process mode only MEMEX_LICENSE, SUCCESSOR_CONTEXT_PLATFORM_URL, ANTHROPIC_API_KEY via kernel config/auth seams; external mode reads no secrets; values redacted everywhere incl. panic paths; exit codes pinned: 0 success / 2 usage / 3 bootstrap-config / 4 transport-without-envelope / 5 kernel typed error envelope; finer mapping is recorded policy; (6) test split: slice0_cli_contract.rs proves grammar rejections, statelessness (no local store), ID-preserving pass-through, SSE byte-exactness against a test kernel double, sentinel redaction, exit buckets, flag-conflict rejection; full E2E/live/leak breadth belongs to D2; (7) Cargo grant exactly per agent://238 (successor-kernel path dep, tokio rt-multi-thread/macros/net, reqwest json/stream/rustls-tls, clap 4.5 bounded, serde/serde_json, futures-util std) — eventsource crates, anyhow, clap env/color, Axum/Tower in CLI, daemon/dirs/auth crates NOT granted; (8) ten forbidden patterns recorded in agent://238 bind the executor; human acceptance required only to widen grammar/output/env/Cargo beyond this grant or touch contract/fixtures.

## Execute

- [x] Dispatch map §4.5/§Wave D/§6 Gate 5/§7 + model-binding table re-read (executor task 239 preflight).
- [x] Contract CLI statelessness/resume/SSE-JSON rules/§13 re-read.
- [x] Review learnings §1–13 re-read in full.
- [x] Accepted C7/C8 packets and kernel tests read before code (construction patterns mirrored from the kernel's own RPC tests).
- [x] Dissent completed and recorded BEFORE execution: task 238 at `1c10f9d6c`, committed `40e6e55b6`; executor launched only after that commit.
- [x] Owned files only: `crates/successor-cli/{Cargo.toml, src/main.rs, src/args.rs, src/client.rs, src/render.rs, tests/slice0_cli_contract.rs}` + `Cargo.lock`; kernel/platform/protocol untouched (verified by reviews 240/241 via diff).
- [x] Frozen C8 routes/wrappers consumed as-is; no renames, no shims; in-process bootstrap through public `AppState::with_anthropic` + `serve` with a pre-bound port-0 loopback listener (the anticipated serve-seam STOP-gap did not materialize — serve accepts a pre-bound listener).
- [x] CLI stateless: no session DB/cache/store; no provider/tool direct calls; no raw-event append; no transcript parsing; statelessness proven under a scratch HOME.
- [x] Contract tests: 15 in `tests/slice0_cli_contract.rs` — grammar rejections (incl. `ask --session-id`, flag conflict, `ask --format json`), ID/envelope byte-preservation against a frozen-surface kernel double, SSE byte-fidelity, sentinel redaction on bootstrap-fail and RPC-fail paths, exit buckets, no false continuation wording.
- [x] Focused validation quoted in `agent://239`: `cargo fmt --all --check` clean; `cargo test -p successor-cli` 15/15; `cargo clippy -p successor-cli --all-targets` clean; kernel suite spot-checked untouched-green.
- [x] Orchestrator gate: `make check-rs` exit 0 at `eeced9480`.
- [x] Packet review/delivery sections updated with observed evidence only (this update).

## Code Review

Status: completed (round 1 clean — zero findings).

Reviewer binding: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Review must verify:
- [ ] Dissent completed before code execution.
- [ ] Only D1-owned files changed.
- [ ] CLI remains stateless and consumes frozen C8 route/API wrappers as-is.
- [ ] JSON/SSE preserve contract-critical IDs and error envelopes.
- [ ] No credentials, license values, provider tokens, artifacts, traces, or SSE output leak sentinel secrets.
- [ ] Tests assert external CLI contract, not incidental internal wiring.
- [ ] No fixture/contract/learnings/test-oracle weakening.

Verdict: correct (task 240 at `eeced9480`, confidence 0.87, findings: none; reviewer re-ran `cargo test -p successor-cli` 15/15 and `cargo clippy -p successor-cli --all-targets -- -D warnings` clean; all seven checklist items above verified incl. dissent-before-code, owned-files-only, pass-through fidelity at the write path, and sentinel redaction).

## Drift Review

Status: completed.

Drift reviewer binding: `slice0-drift-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Drift review must verify:
- [ ] Implementation stays inside Slice 0 D1 scope and does not backdoor session continuation.
- [ ] CLI command grammar/output choices match the dissent verdict.
- [ ] No mixed kernel/platform/client responsibility drift.
- [ ] No new route, fixture, or protocol contract created without explicit approval.
- [ ] Inherited C8/D1 residual law remains visible in tests/docs where relevant.

Verdict: aligned; authority boundary clear (task 241 at `eeced9480`). No material drift; grammar/output/reachability match the ruled surface with nothing invented; session-semantics law visible in code, help text, and tests (ask = fresh runner-owned turn; resume/inspect read-only, no continuation claim). Residuals explicitly routed, not silent: full happy-path/live E2E and leak breadth stay D2 scope under the Cargo-grant split; hardcoded in-process provider model/max_tokens are disclosed internal bootstrap defaults — to stay non-public until a later config/model lane; neither required a D1 stop-and-ask.

## Superego Review

Status: completed.

Superego binding: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Superego must challenge:
- [ ] Whether D1 smuggled convenience behavior that violates CLI statelessness.
- [ ] Whether the chosen transport makes future hardening harder or creates a public contract accidentally.
- [ ] Whether JSON/SSE envelopes are strong enough for D2 and downstream orchestrators.
- [ ] Whether `--session-id` wording or behavior misleads users about continuation.
- [ ] Whether sentinel leak coverage includes all stdout/stderr/success/error paths.

Verdict: ALLOW (task 242 at `eeced9480`; full per-ruling table in `agent://242-D1SuperegoReview`). All 8 dissent rulings adjudicated HONORED with code/test evidence: hybrid reachability with no daemon/persistence; exact grammar at clap level; pass-through-only machine output (raw bytes, no CLI-owned envelope); bounded clap grant (no env feature); secret discipline (CLI never reads provider secrets itself — kernel C3 seams only; credential-looking `--kernel-url` userinfo probe not echoed); exit buckets 0/2/3/4/5; test split honored without weakening accepted fixtures; Cargo grant not exceeded (direct deps verified exactly the granted set, no dev-deps). Gap adjudications: happy-path E2E deferral ACCEPTED (D1 grant did not authorize smoke-harness deps; D2 must consume the seams); provider wiring defaults ACCEPTED as internal bootstrap defaults, not contract surface. D2 inheritance recorded: the `--kernel-url` black-box seam, exit buckets as smoke oracles, in-process bootstrap requiring MEMEX_LICENSE in local runs.

## Delivery

Status: accepted

- Changed files:
  - `crates/successor-cli/{Cargo.toml, src/main.rs, src/args.rs, src/client.rs, src/render.rs}`, new `tests/slice0_cli_contract.rs`, `Cargo.lock`; lane commit `eeced9480` (dissent record `40e6e55b6`).
- Validation evidence:
  - 15/15 CLI contract tests; clippy `-D warnings` clean; fmt clean; `make check-rs` exit 0; kernel suite untouched-green. Command surface: `ask --workspace-root --prompt [--format text|sse]`, `resume --session-id [--format json|text]`, `inspect session --session-id [--format json|text]`, each with `--kernel-url`/`--platform-url` (mutually exclusive).
- Dissent evidence:
  - Task 238 PROCEED-WITH-CONDITIONS recorded in this packet's Dissent section; full rulings `agent://238-D1PreExecutionDissent`.
- Review evidence:
  - Code `agent://240-D1CodeReview` (correct, zero findings); drift `agent://241-D1DriftReview` (aligned/clear); Superego `agent://242-D1SuperegoReview` (ALLOW). First lane in the workstream to clear all three gates in round 1 with zero findings.
- Residual risks (D2 inherits):
  - Genuine happy-path E2E not yet exercised (deliberately deferred; D2's cli_smoke must drive the real binary end-to-end); in-process provider wiring defaults (claude-sonnet-4-5/8192) are internal, non-public until a config/model lane; bare zero-event session 422 behavior surfaces through resume/inspect of unused sessions — D2 smoke must account for it.
- Drift evidence:
  - pending
- Superego evidence:
  - pending
- Residuals routed:
  - pending
