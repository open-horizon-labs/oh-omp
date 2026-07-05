# Lane D2 — BlackBoxIntegrationSmoke

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
- D2 is a black-box integration/smoke lane. It proves externally observable behavior across accepted Slice 0 seams; it must not rewrite the seams to make the smoke pass.
- Existing accepted tests are sovereign evidence. D2 may add coverage, but must not weaken, delete, duplicate with divergent expectations, or contradict accepted protocol/platform/kernel oracles.
- Gate 5 leak scanning is mandatory and must cover platform store, artifacts, traces, SSE, and CLI output; sentinel credentials must never appear in stdout/stderr, JSON, SSE, stored artifacts, platform rows, traces, or failure diagnostics.
- Deterministic smoke is the gate. Any live provider path must be opt-in, separately recorded, redacted, and excluded from deterministic acceptance unless explicitly approved.
- Raw events remain canonical truth; D2 must not use rendered CLI text, provider wire text, or unsupported-tool projection as a stronger oracle than accepted raw-event/session/frame fixtures.
- Review, drift, and Superego gates remain required and may not be collapsed into a single smoke-pass claim.

Inherited Wave C residual law:
1. SESSION SEMANTICS: `POST /v0/turns` starts a runner-owned session and does NOT continue a created/attached session; `POST /v0/sessions` and `GET /v0/sessions/{id}` are independent thin wrappers; D2 MUST NOT present attach as turn continuation; session-continuation capability requires a narrow C7 reopen with dissent — never a CLI workaround or smoke-test assumption.
2. Durable C8/D1 interface: the four kernel routes and `api.rs` wrappers are frozen; CLI consumes them as-is; changes require contract-level treatment.
3. Bare zero-event sessions 422 on snapshot replay; CLI create-then-attach flows and smoke tests must account for it and assert the accepted platform behavior rather than masking it.
4. A4 unsupported-tool projection semantics routed; no CLI/test may call `project_session` on unsupported-tool streams as an oracle.
5. RealIdFactory UUID-shaped std-only ids surface through RPC responses — accepted Slice 0 residual, revisit pre-multi-tenant.
6. Fixture sovereignty + the C7 oracle law in `crates/successor-kernel/tests/slice0_kernel_contract.rs`: D2 end-to-end tests must not weaken, duplicate, or contradict those oracles.

## Fan-out / Dependency Order

- Wave order: D1 → D2. D2's CLI smoke consumes the D1 binary/API and must not begin the CLI-smoke portion until D1 is accepted.
- D2 kernel/platform/protocol test additions are additive and could stage earlier, but this packet keeps the wave simple and sequential to avoid mixed evidence.
- D2 depends on accepted A/B/C fixtures, C7 runner oracles, C8 RPC/SSE route behavior, and D1 CLI contract behavior.
- D2 must not modify implementation source except where a legitimately failing black-box smoke exposes a defect and the workstream explicitly reopens the owning lane. Under this packet, D2 owns only the listed test files.
- Stop if passing the smoke appears to require changing contracts, fixtures, learned laws, C7/C8 oracles, D1 public output contract, provider direct calls, or live-provider credentials in deterministic tests.

## Aim

Add Wave D black-box integration smoke for the Slice 0 successor stack.

Owned files:
- `crates/successor-cli/tests/slice0_cli_smoke.rs`
- `crates/successor-kernel/tests/slice0_end_to_end.rs`
- `crates/successor-context-platform/tests/slice0_platform_replay.rs`
- `crates/successor-protocol/tests/slice0_fixture_contract.rs`

Gate:
- Deterministic smoke passes across CLI, kernel, platform replay, and protocol fixture seams.
- Opt-in live provider path is recorded separately and gated away from deterministic smoke.
- Gate 5 sentinel credential leak scan passes over platform store, artifacts, traces, SSE, and CLI output.

## Problem Space

Authoritative contract constraints:
- Dispatch map Wave D assigns D2 to black-box integration smoke after D1.
- Dispatch map §6 Gate 5 requires CLI + integration smoke, deterministic replay, SSE/JSON contract preservation, and a leak scan that covers platform store, artifacts, traces, SSE, and CLI output.
- Contract §13 acceptance requires protocol fixtures valid, context platform replays fixture into expected session state, kernel consumes fixtures and exposes frames/resume, CLI submits via kernel and preserves IDs in JSON/SSE, unsupported tools degrade explicitly, credentials never persist outside approved boundaries, and deterministic replay is stable.
- Review learnings §1–13 are binding. D2 cannot trade oracle strength for convenience; it must route contradictions back through dissent/contract amendment, not silently rewrite fixtures or accepted tests.

Actual current state observed before packet write:
- `crates/successor-cli/tests/slice0_cli_smoke.rs`: exact file absent. `crates/successor-cli/tests/` is absent. D2 would create this file after D1 provides the binary/API.
- `crates/successor-kernel/tests/slice0_end_to_end.rs`: exact file absent. Existing accepted kernel suites include `slice0_kernel_contract.rs` (C7 runner/oracle law) and `slice0_kernel_rpc.rs` (C8 local RPC/SSE). D2 should create the exact end-to-end file only as additive smoke and must not duplicate/contradict those accepted oracles.
- `crates/successor-context-platform/tests/slice0_platform_replay.rs`: exact file absent. Existing replay-adjacent accepted suite `crates/successor-context-platform/tests/slice0_replay.rs` covers successful-turn replay to canonical session snapshot, replay determinism, empty-session typed error, unknown-session typed not-found, unsupported-tool typed error pending A4 reopen, missing-artifact integrity error, trace-index assembly associations, distinguishable typed errors, and replay projection matching the expected fixture. D2 must treat create-vs-extend as a dissent item because the dispatch-owned exact filename overlaps an accepted replay suite.
- `crates/successor-protocol/tests/slice0_fixture_contract.rs`: exact file exists and is an accepted protocol fixture contract suite. It covers fixture parsing for raw events, expected session projection, provider shape normalization, kernel frame stream, session snapshot, assemble requests/responses/traces, unsupported-tool rejection semantics, tool catalog, replay to expected projection bytes, raw-event validator adversarial mutations, unsupported-tool lifecycle validator cases, stale field rejection, and credential-shaped field rejection. D2 can only extend this file additively after dissent; it must not weaken or delete existing accepted tests.

Risk framing:
- Collision risk: D2 owns filenames that overlap with accepted suites by topic, especially platform replay and protocol fixture contract. Additive smoke must not become a competing oracle.
- False confidence risk: a CLI smoke that asserts only process exit 0 without checking IDs, SSE/JSON shape, error envelopes, and leak boundaries is too weak for Gate 5.
- Live-provider drift risk: allowing provider credentials in the deterministic path makes the smoke non-reproducible and increases leak risk.
- Unsupported-tool oracle risk: D2 may be tempted to call `project_session` on unsupported-tool streams to assert a full projection; that is forbidden by A4 residual law.

## Solution Space

Expected shape after dissent approval:
- `crates/successor-cli/tests/slice0_cli_smoke.rs`: black-box CLI invocations against the adjudicated D1 transport path. Assert deterministic success/failure outputs, ID preservation in JSON/SSE, no false session continuation, error envelope preservation, and no sentinel credential leakage on stdout/stderr.
- `crates/successor-kernel/tests/slice0_end_to_end.rs`: additive end-to-end smoke that exercises the accepted kernel surface without replacing C7/C8 contract tests. Prefer a narrow happy-path plus one failure/leak boundary over broad fixture reimplementation.
- `crates/successor-context-platform/tests/slice0_platform_replay.rs` or accepted alternative after dissent: additive Gate 5 replay/leak coverage that complements `slice0_replay.rs`, especially platform store/artifact/trace sentinel scanning and bare zero-event session 422 behavior. If dissent chooses to extend `slice0_replay.rs` instead, this packet must be amended before execution because dispatch ownership currently names `slice0_platform_replay.rs`.
- `crates/successor-protocol/tests/slice0_fixture_contract.rs`: additive fixture/leak contract assertions only if they strengthen existing accepted coverage. Do not refactor, rename, relax, or delete existing tests.

Deterministic smoke requirements:
- Use fixture/scripted providers or accepted deterministic doubles only.
- Assert output structure, not only success status.
- Assert all contract-critical IDs are present in machine-readable CLI output and SSE frames.
- Assert credential sentinels do not appear in CLI output, SSE frames, traces, artifacts, platform store material, or failure diagnostics.
- Assert unsupported-tool residual routing without using `project_session` as oracle.
- Assert create/attach/replay semantics respect bare zero-event session 422 and do not imply continuation.

Live-provider path requirements:
- Must be opt-in and excluded by default.
- C4 precedent names the env gate `SUCCESSOR_LIVE_PROVIDER_SMOKE=1`; dissent must confirm whether D2 uses that exact name or a new one.
- Must use env-only secret acquisition consistent with C3 precedent and redact every secret in logs/output/failure messages.
- Must record evidence separately from deterministic Gate 5 evidence.

Validation targets for the executor to fill with observed evidence:
- `cargo test -p successor-cli --test slice0_cli_smoke` after D1 is accepted.
- `cargo test -p successor-kernel --test slice0_end_to_end` if the exact D2 kernel file is created.
- Platform replay test command matching dissent outcome: `cargo test -p successor-context-platform --test slice0_platform_replay` if created, or the approved existing-suite command if extended.
- `cargo test -p successor-protocol --test slice0_fixture_contract` for additive protocol fixture checks.
- Repository Rust check (`make check-rs` or accepted orchestrator equivalent) after all D2 test additions.
- Explicit sentinel leak scan evidence covering platform store, artifacts, traces, SSE, and CLI output.

## Ambiguities

Record these; do not resolve them by invention before dissent:
- Smoke oracle strength: which exact black-box assertions are sufficient for Gate 5 without duplicating C7/C8 or protocol/platform fixture oracles?
- Existing file collision: `slice0_platform_replay.rs` is absent, but `slice0_replay.rs` already covers replay contract behavior. Dissent must decide create exact D2 file vs extend the accepted suite, with the anti-weakening rule cited.
- Existing accepted protocol suite: `slice0_fixture_contract.rs` already exists and is sovereign. Dissent must decide which additive checks, if any, belong there without weakening or duplicating accepted tests.
- Live-smoke gate name: C4 precedent uses `SUCCESSOR_LIVE_PROVIDER_SMOKE=1`, but D2 must confirm whether to reuse that name for this lane.
- CLI transport dependency: D2 CLI smoke depends on D1's in-process-vs-listener verdict. D2 must not invent a second transport just for tests.
- JSON/SSE envelope expectations: D2 can assert ID preservation only after D1 dissent fixes pass-through vs CLI-owned envelope shape.
- Secret acquisition: C3 precedent is env-only and redacted, but exact env vars for license/provider/kernel/platform still need D1/D2 alignment.
- Leak-scan implementation: the contract states coverage domains but not the exact scanner mechanism, sentinel value names, or failure reporting format.

## Dissent

Verdict: required-before-execute / completed (task 243, PROCEED-WITH-CONDITIONS; record below)

If skipped, rationale: not applicable; D2 fixes the final Slice 0 smoke oracle, accepted-suite extension policy, credential leak scan scope, live-provider gate, and cross-crate evidence used for Gate 5 closure.

Required dissent questions:
- Smoke oracle strength: what minimum deterministic assertions are necessary and sufficient for Gate 5 across CLI, kernel, platform replay, protocol fixtures, SSE/JSON, and IDs?
- Existing-file policy: for platform replay and protocol fixture contract collisions, should D2 create exact owned files, extend existing accepted files, or amend the dispatch packet before execution?
- Anti-weakening enforcement: how will reviewers prove no accepted fixture/oracle/test was weakened, duplicated with divergent semantics, or contradicted?
- Leak-scan scope: what sentinel values, storage locations, traces, SSE streams, CLI stdout/stderr, JSON outputs, and artifact stores must be scanned, and how is failure reported without leaking secrets?
- Live-smoke gating: should the opt-in path use `SUCCESSOR_LIVE_PROVIDER_SMOKE=1`; what other env-only configuration is allowed; and how is live evidence separated from deterministic acceptance?
- Dependency on D1: what D1 command/output/transport contract does D2 consume, and what happens if D1 resolves the transport differently than expected?

If completed (task 243-D2PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof `6646a8848`; full binding rulings in `agent://243-D2PreExecutionDissent`):
- Dissent concern: D2 could become a nondeterministic or duplicate integration suite — the CLI default path invokes real Anthropic/provider auth, accepted A5/B4/C7/D1 suites already own nearby contracts, and Gate 5 leak scanning spans surfaces that can be silently weakened by scanning rendered summaries instead of raw bytes.
- Response: bind D2 to a real compiled CLI process in `--kernel-url` mode against real kernel/platform HTTP servers with scripted provider/ID seams; create only new D2 coverage; leave accepted suites no-touch except strictly additive missing leak assertions; scan raw store/artifact/trace/SSE/CLI bytes with env-injected sentinels; keep live provider smoke ignored-by-default and separately recorded.
- Outcome: PROCEED-WITH-CONDITIONS with orchestrator rulings (full text agent://243): (1) protocol `slice0_fixture_contract.rs` NO-TOUCH (only a strictly additive static fixture-byte leak assertion if a concrete gap is found); platform gets NEW `slice0_platform_replay.rs` — accepted B4 `slice0_replay.rs` untouched; nowhere may D2 delete/rename/relax/skip/convert accepted tests; (2) deterministic smoke = spawn the real compiled `successor-cli` binary (`CARGO_BIN_EXE`, std::process::Command) in `--kernel-url` mode against an in-process harness of the REAL kernel router + REAL platform router + temp SQLite + scripted provider rounds/IDs/clock — never CLI library calls, never the in-process Anthropic bootstrap; proves bucket-0 terminal success over a real kernel stream, bucket-5 typed errors, ID preservation platform-store→kernel-frames→CLI stdout, byte-exact SSE stdout, resume/inspect freshness across separate CLI processes; D1-owned buckets 2/3/4 not re-proven; (3) kernel `slice0_end_to_end.rs` adds only non-duplicative full-stack value (kernel against the real platform incl. B4 replay over a real store) — no duplicate route/grammar/C7-oracle coverage; (4) leak scan: deterministic sentinels (`d2-memex-license-sentinel-...`, `sk-ant-d2-sentinel-...`) injected via env — set in spawned CLI environments even in `--kernel-url` mode to prove pure-client non-consumption; scan RAW BYTES per surface ownership: cli_smoke owns CLI stdout/stderr+SSE stdout; end_to_end owns kernel HTTP/SSE bytes + kernel trace/frame payloads; platform_replay owns SQLite DB/WAL/SHM bytes, replay/snapshot JSON, artifact payloads, trace-index bytes (checkpoint/drop store before scanning); failure messages name surface + env var, never sentinel values; (5) live provider smoke lives in `slice0_end_to_end.rs` as `#[ignore]` + `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` + non-empty `ANTHROPIC_API_KEY`; one live Anthropic Messages path; asserts only stable contracts (valid normalized terminal frame, persisted/replayable state, no leak) — never model text/tokens/timing; evidence recorded separately in this packet; deterministic Gate 5 valid without it; (6) Cargo grant: at most `successor-context-platform` as dev-dep of `successor-cli` (only if cli_smoke hosts the real platform router); NO assert_cmd, NO tempfile, no new leaf crates, no upgrades, no boundary changes; (7) inherited law binding: bare zero-event 422, attach/inspect never continuation, no project_session on unsupported-tool streams, C7 oracle law neither duplicated nor weakened, no test-only continuation semantics; ten forbidden patterns in agent://243 bind the executor; broader deps or accepted-test mutation route back to review before coding.

## Execute

- [ ] Re-read `.oh/workstreams/successor-agent-kernel/SLICE-0-DISPATCH-MAP.md` Wave D, §6 Gate 5, §7 risk matrix, and model-binding table.
- [ ] Re-read `.oh/workstreams/successor-agent-kernel/SLICE-0-CONTRACT.md` CLI statelessness, resume, SSE/JSON output rules, and §13 acceptance criteria.
- [ ] Re-read `.oh/workstreams/successor-agent-kernel/SLICE-0-REVIEW-LEARNINGS.md` §1–13 in full.
- [ ] Re-read accepted C7/C8 packets and tests, especially `slice0_kernel_contract.rs` and `slice0_kernel_rpc.rs`.
- [ ] Re-read D1 packet and accepted D1 implementation/review evidence before beginning CLI smoke.
- [ ] Complete required-before-execute dissent and record verdict/evidence in this packet before implementation.
- [ ] Confirm exact existing/absent D2 test files again at execution checkout before writing tests.
- [ ] Implement only D2-owned test files, or amend the packet first if dissent chooses to extend an existing non-owned replay suite.
- [ ] Keep deterministic smoke provider-free or fixture/scripted-only.
- [ ] Keep live-provider smoke opt-in and separately recorded; never make live credentials required for deterministic acceptance.
- [ ] Add sentinel leak scan coverage for platform store, artifacts, traces, SSE, CLI stdout/stderr, JSON output, and failure diagnostics.
- [ ] Preserve fixture sovereignty and accepted C7/C8/protocol/platform oracles.
- [ ] Run focused D2 validation commands and capture exact exits.
- [ ] Run or obtain orchestrator Rust check evidence appropriate for Gate 5.
- [ ] Update this packet's review/delivery sections with observed evidence only.

## Code Review

Status: pending.

Reviewer binding: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Review must verify:
- [ ] Dissent completed before code execution.
- [ ] Only D2-owned test files changed, or packet/dispatch amendment explicitly authorized any existing-suite extension.
- [ ] Existing accepted tests were not weakened, deleted, refactored into looser assertions, or contradicted.
- [ ] Deterministic smoke asserts contract surfaces: IDs, JSON/SSE shape, error envelopes, replay behavior, and no secret leakage.
- [ ] Live-provider path is opt-in, env-only, redacted, and separately recorded.
- [ ] Unsupported-tool residual law is respected; no `project_session` oracle on unsupported-tool streams.
- [ ] Gate 5 leak scan covers platform store, artifacts, traces, SSE, and CLI output.

Verdict: pending.

## Drift Review

Status: pending.

Drift reviewer binding: `slice0-drift-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Drift review must verify:
- [ ] D2 remains smoke/integration validation, not an implementation lane or contract amendment lane.
- [ ] The smoke does not become a weaker competing oracle against accepted protocol/platform/kernel tests.
- [ ] File collision decisions match the dissent verdict and dispatch ownership is updated if necessary.
- [ ] D2 consumes D1 behavior rather than inventing a separate CLI/test-only path.
- [ ] Deterministic and live evidence are separated.

Verdict: pending.

## Superego Review

Status: pending.

Superego binding: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Superego must challenge:
- [ ] Whether the smoke is strong enough to justify Gate 5 closure or merely proves happy-path execution.
- [ ] Whether existing accepted suites were subtly weakened by additive-looking edits.
- [ ] Whether leak-scan coverage can miss credentials in store rows, artifacts, traces, SSE, CLI stdout/stderr, JSON, or failure diagnostics.
- [ ] Whether live-provider gating can contaminate deterministic acceptance or developer environments.
- [ ] Whether D2 overclaims session continuation, replay behavior, or unsupported-tool projection beyond accepted law.

Verdict: pending.

## Delivery

Status: pending.

To fill after execution:
- Changed files:
  - pending
- Validation evidence:
  - pending
- Dissent evidence:
  - pending
- Review evidence:
  - pending
- Drift evidence:
  - pending
- Superego evidence:
  - pending
- Gate 5 leak-scan evidence:
  - pending
- Residuals routed:
  - pending
