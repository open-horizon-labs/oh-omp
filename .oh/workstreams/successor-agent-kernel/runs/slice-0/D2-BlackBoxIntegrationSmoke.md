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

- [x] Dispatch map Wave D/§6 Gate 5/§7 + model-binding table re-read (executor preflights, tasks 244/246/250).
- [x] Contract CLI statelessness/resume/SSE-JSON rules/§13 re-read.
- [x] Review learnings §1–13 re-read in full.
- [x] Accepted C7/C8 packets and `slice0_kernel_contract.rs`/`slice0_kernel_rpc.rs` read; harness construction mirrored from the RPC suite.
- [x] D1 packet + accepted implementation read before CLI smoke; D1-owned exit buckets 2/3/4 not re-proven.
- [x] Dissent completed and recorded BEFORE execution: task 243 at `6646a8848`, committed `aba9519bf`.
- [x] Existing/absent files confirmed at checkout: protocol suite NO-TOUCH honored (zero edits); accepted B4 `slice0_replay.rs` untouched; three NEW D2 files created.
- [x] Mid-lane STOP honored (learnings §11): task 244 stopped on the missing platform serve seam instead of working around; adjudication task 245 (ALLOW, Option A) granted exactly one additive `pub async fn serve(listener, license, state)` in platform `http.rs`; completion task 246 stayed inside that grant; the reopened diff passed its DEDICATED review gate (task 247 scope 1: within-change-set).
- [x] Deterministic smoke is scripted-seams-only: real compiled CLI binary (`CARGO_BIN_EXE`, `env_clear()`) in `--kernel-url` mode against real platform + real kernel HTTP servers on ephemeral loopback with scripted provider/ID/clock; no CLI lib calls, no in-process Anthropic bootstrap.
- [x] Live-provider smoke opt-in and separately recorded: `#[ignore]` + `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` + non-empty `ANTHROPIC_API_KEY`; skipped in default runs (1 ignored); deterministic acceptance never requires credentials.
- [x] Sentinel leak-scan coverage per ruling 243.4 ownership: CLI stdout/stderr + SSE stdout (cli_smoke); kernel HTTP/SSE bytes + kernel-produced raw-event/replay-snapshot payloads via reconnected store handles (end_to_end, incl. pre-failure persisted payloads recovered from the failing turn's own SSE frames); platform HTTP responses incl. 401, raw checkpointed SQLite DB/WAL/SHM bytes, artifacts, snapshot/replay JSON, trace-index bytes (platform_replay); failure diagnostics redacted — surface/class/offsets only, proven by firing tests (task 250).
- [x] Fixture sovereignty preserved; C7/C8/protocol/platform oracles untouched and not duplicated.
- [x] Focused validation quoted in `agent://244`/`agent://246`/`agent://250`: 21 CLI tests, end_to_end 3 (2 passed + live ignored) then green post-fix, platform_replay green, clippy/fmt clean across touched crates.
- [x] Orchestrator gate `make check-rs` exit 0 at `11664f8fd`, `4eeac9478`, `16351bd35`.
- [x] Packet review/delivery sections updated with observed evidence only (this update; closes task 247 finding 3).

## Code Review

Status: completed (round 1 + fix round closed).

Reviewer binding: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Review must verify:
- [x] Dissent completed before code execution (task 243 recorded at `aba9519bf`).
- [x] Only D2-owned files changed + the task-245-authorized reopen; dedicated reopen gate verdict: within-change-set.
- [x] Existing accepted tests unweakened/untouched (verified via diff; A5/B4/C7/C8/D1 suites zero edits).
- [x] Deterministic smoke asserts contract surfaces: 3-hop ID preservation (store→frames→stdout), byte-exact SSE stdout vs directly received bytes, typed error envelope pass-through, cross-process resume/inspect freshness, replay determinism, sentinel non-leak.
- [x] Live-provider path opt-in, env-only, redacted, separately recorded (wiring verified; run evidence = orchestrator obligation under Gate 5).
- [x] Unsupported-tool residual law respected; no `project_session` oracle on unsupported-tool streams (grep-verified, task 248).
- [x] Gate 5 leak scan covers all five ruled surfaces after the task-250 trace-surface addition.

Verdict: round 1 (task 247 at `16351bd35`…`4eeac9478` scope) incorrect with three P2s — (1) platform_replay and (2) end_to_end leak-scan assertions echoed scanned payloads on failure (would print sentinels), (3) this packet's delivery section pending. Reopen gate (scope 1): within-change-set, explicit. Closures: P2 1-2 by task 250 / commit `16351bd35` — shared `assert_sentinel_absent` helper reporting surface, sentinel class, count, and byte offset/length only; firing behavior proven by temporary injected-sentinel tests whose panic output contained zero sentinel bytes (instrumentation removed); kernel trace-surface scan added in the same commit. P2 3 closed by this packet update. A5 precedent: mechanical application of named findings with empirical firing proof, not separately re-reviewed (recorded residual).

## Drift Review

Status: completed.

Drift reviewer binding: `slice0-drift-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Drift review must verify:
- [x] D2 stayed a validation lane; the single src change was the adjudicated task-245 reopen, not a contract amendment.
- [x] Smoke composes accepted oracles without competing: no duplicate/looser versions of protocol/platform/kernel assertions.
- [x] File-collision decisions match the dissent verdict (protocol no-touch; new platform_replay file; B4 untouched).
- [x] D2 consumes real D1 behavior (spawned compiled binary, ruled grammar) — no test-only CLI path.
- [x] Deterministic and live evidence separated (live: ignored-by-default, distinct env gates, separate packet record).

Verdict: minor drift (task 249 at `4eeac9478`), authority boundary clear — sole gap was missing kernel trace-surface leak-scan evidence vs ruling 243.4's surface assignment; closed by task 250 / `16351bd35` (raw-event payload + replay-snapshot scans through reconnected store handles in both the full-stack and transport-failure tests). STOP-and-route pattern explicitly confirmed followed; inherited law visible (zero-event 422 asserted over HTTP, resume/inspect as separate processes never continuation, C7 oracle law not duplicated).

## Superego Review

Status: completed.

Superego binding: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`.

Superego must challenge:
- [x] Smoke strength adjudicated sufficient for Gate 5: black-box binary spawn, real stores, byte-exact SSE, cross-process freshness, failure-path coverage — not happy-path-only.
- [x] Accepted suites verified unweakened (`git diff --name-only` over accepted suites empty).
- [x] Leak-scan coverage adjudicated per ruling 243.4 across store rows, artifacts, traces (post task 250), SSE, CLI streams, failure diagnostics.
- [x] Live gating cannot contaminate deterministic acceptance (ignored-by-default; env gates; no default network dependence).
- [x] No overclaims: attach/inspect never continuation; replay claims scoped to scripted turns; unsupported-tool projection untouched.

Verdict: ALLOW (task 248 at `4eeac9478`; full per-ruling table in `agent://248-D2SuperegoReview`). All task-243 rulings + the ten forbidden patterns adjudicated honored (the SSE measurement proxy included — instrument outside the production path, not a forbidden relay); 243.5 partially-honored solely because the live-smoke RUN evidence is a separate Gate 5/orchestrator obligation: execute behind `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` + `ANTHROPIC_API_KEY` and record command/date/env-gate names/observed result (no secret values) in this packet. Governance sequence (dissent→partial→STOP→adjudication→completion→dedicated reopen gate) explicitly verified in history.

## Delivery

Status: accepted (deterministic scope). Final Slice 0 acceptance additionally requires the separately-recorded live provider smoke below.

Evidence:
- Changed files:
  - NEW `crates/successor-cli/tests/slice0_cli_smoke.rs` (6 tests), NEW `crates/successor-kernel/tests/slice0_end_to_end.rs` (2 + 1 ignored live), NEW `crates/successor-context-platform/tests/slice0_platform_replay.rs`; adjudicated reopen: `crates/successor-context-platform/src/http.rs` (+1 additive `serve()`); `crates/successor-cli/Cargo.toml` granted dev-dep + `Cargo.lock`. Commits `11664f8fd` (partial + STOP), `4eeac9478` (completion + reopen), `16351bd35` (review fixes).
- Validation evidence:
  - 21 successor-cli tests green; kernel + platform suites green with live smoke ignored by default; clippy/fmt clean; `make check-rs` exit 0 at each commit.
- Dissent evidence:
  - Task 243 PROCEED-WITH-CONDITIONS recorded in this packet; seam adjudication task 245 (ALLOW, Option A) in `agent://245-D2CliSmokeSeamAdjudication`.
- Review evidence:
  - Code `agent://247-D2CodeReviewWithReopenGate` (reopen: within-change-set; three P2s closed — tasks 250 + this update); fix evidence `agent://250-D2LeakScanRedactionFix`.
- Drift evidence:
  - `agent://249-D2DriftReview` (minor drift, closed by `16351bd35`; boundary clear).
- Superego evidence:
  - `agent://248-D2SuperegoReview` (ALLOW).
- Gate 5 leak-scan evidence:
  - Sentinels `d2-memex-license-sentinel-...`/`sk-ant-d2-sentinel-...` scanned as raw bytes across: CLI stdout/stderr + SSE stdout; kernel HTTP/SSE bytes + persisted raw-event/replay-snapshot payloads (incl. pre-failure payloads on the transport-failure path); platform HTTP responses (incl. 401), checkpointed SQLite DB/WAL/SHM, artifacts, snapshot/replay JSON, trace-index. Failure diagnostics redacted (surface/class/offsets only; firing-proof in `agent://250`).
- Live provider smoke (Gate 5 / final acceptance obligation):
  - CORRECTED RECORD. The original run (2026-07-05T19:46:24Z at `208fde5d8`, `test result: ok. 1 passed ... 163.09s`) was recorded as proof of one real provider round trip, but its terminal oracle accepted `turn_completed` OR `turn_failed` — later diagnosis established the turn almost certainly terminated in a typed provider-auth failure masked as a pass (the environment's `ANTHROPIC_API_KEY` is a gateway key; nothing consumed `ANTHROPIC_BASE_URL`; and executable tools were advertised with `input_schema: null`, which real Anthropic rejects with HTTP 400 `tools.N.custom.input_schema`). That record therefore did NOT satisfy Gate 5 criterion 4. Corrected by the user-authorized post-acceptance correction at `987c22621` (dissent task 252 PROCEED-WITH-CONDITIONS, executor task 253): oracle now REQUIRES `turn_completed`; `ANTHROPIC_BASE_URL` resolved through the kernel C3 lookup; model explicit via `SUCCESSOR_LIVE_PROVIDER_MODEL` (default `claude-opus-4-8`); executable-tool schemas schemars-derived from the executor's own arg DTOs and published through the catalog (fixture amendment #3). RERUN AND GENUINELY PASSED: 2026-07-06T09:36:50Z, `ANTHROPIC_API_KEY=$DIRECT_ANTHROPIC_API_KEY ANTHROPIC_BASE_URL=https://api.anthropic.com SUCCESSOR_LIVE_PROVIDER_MODEL=claude-opus-4-8 SUCCESSOR_LIVE_PROVIDER_SMOKE=1 cargo test -p successor-kernel --test slice0_end_to_end live_smoke_... -- --ignored --exact` → `test result: ok. 1 passed; 0 failed ... finished in 3.55s` with the strengthened oracle (no secret values displayed). Gate 5 criterion 4 satisfied by THIS run. Lesson routed to review-learnings: a live-path oracle that tolerates typed failure terminals cannot prove a provider path.
- Residuals routed:
  - P2 redaction closures per A5 precedent (not separately re-reviewed; firing proof recorded); SSE measurement proxy accepted as instrument (task 248); session semantics / RealIdFactory / A4 routing / zero-event 422 remain as recorded C-wave+D1 residuals for post-Slice-0 work.
