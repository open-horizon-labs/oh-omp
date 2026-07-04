# Lane C5 — KernelToolCatalogAndRead

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
- Tool catalog must match `tool-catalog.json`; no invented `platform.tool_catalog.v0`, tool-count metadata, or renamed tool identifiers.
- Executable authority is read-only: `read` plus discovery tools; catalog-visible unsupported tools must deterministically reject, not silently no-op or dispatch to shell/oh-omp.
- `read` must be root-bounded, reject absolute paths, `..`, symlink escape, binary-looking files, and over-limit content according to contract §8.1.
- Tool results must produce artifact content with canonical `sha256:<64 lowercase hex>` and `byte_length`; placeholder hashes or semantic JSON comparisons are blocked.
- Provider/model never supplies the workspace root; root comes from trusted session/kernel config.
- Regression coverage must include unsupported tool rejection routing, root escape attempts, binary/truncation behavior, and catalog exactness.

## Fan-out / Dependency Order

Required staging: C8 lands the kernel crate shell first, or grants top-level module declarations. C5 owns `tools/mod.rs`, so it must land the tool namespace/catalog/read substrate before C6 can safely add `search_files`, `find`, and `grep`. C5 may need append-only `lib.rs` module grant for `tools` after files exist.

Parallelization: after C8 shell/grant, C5 can run in parallel with C1/C2/C3. C6 depends on the C5 tool namespace and shared root-bounds/artifact substrate. C7 depends on C5/C6 accepted tool APIs and catalog behavior.

## Aim

- Outcome: implement the kernel tool catalog and safe `read` tool foundation so provider-visible tools are contract-exact, root-bounded, artifact-producing, and deterministic about unsupported authority.
- Contract clause(s) served: contract §2.5 local authority is read-only; §4 event types for tool catalog/lifecycle; §7 Tool catalog v0; §8.1 `read`; §9 successful and unsupported tool paths; §13 acceptance criteria 5 and 6; risk-retirement matrix tool authority row.
- Fixture(s) served: `tool-catalog.json`; read/artifact portions of `raw-events-successful-turn.json`; unsupported catalog entries in `raw-events-unsupported-tool.json`; artifact hash/byte-length expectations in projection fixtures.
- Files owned:
  - `crates/successor-kernel/src/tools/mod.rs`
  - `crates/successor-kernel/src/tools/catalog.rs`
  - `crates/successor-kernel/src/tools/read.rs`
  - `crates/successor-kernel/tests/slice0_tools_read.rs`
- Dependencies: accepted protocol tool catalog/artifact/raw-event DTOs and validators; trusted workspace root from C3/config or runner session config; downstream C6 discovery tools and C7 runner.
- Explicit non-goals: `search_files`/`find`/`grep` implementation, provider projection, raw event append orchestration, platform client, local RPC, write/shell/web/subagent tools, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: kernel tools do not exist. Contract allows only hardened read/discovery tools in Slice 0 while catalog-visible unsupported tools must be rejected/stubbed deterministically.
- Constraints: no mutation, shell/runtime, browser, subagent, notebook, remote/web, or provider-supplied root authority. Artifact hashes/lengths must match exact bytes. Tool outputs are recorded as raw events/artifacts by C7, but C5 must provide safe execution/result material for that path.
- Named risks: prefix-only path checks allowing symlink escape; reading absolute paths; shelling out to host tools; treating catalog as free-form metadata; computing hashes over decoded strings instead of bytes; broad false-positive secret scanning vs high-confidence credential patterns; C5 implementing C6 discovery tools prematurely.
- Edge cases: relative path normalization; symlink to outside root; binary-looking file; file over `max_bytes`; missing file; permission denied; UTF-8 vs binary; truncation metadata; catalog unsupported tool request for `bash`, `edit`, `web_search`, `task`, `submit_result`; root path with trailing separators.
- Interface dependencies: accepted artifact/hash types and tool catalog fixture types; C6 should reuse the C5 root-bounds/artifact substrate if exposed; C7 will translate C5 tool outcomes into lifecycle raw events.
- Authority boundaries: C5 owns catalog/read and common tools module only. It must not append raw events itself unless explicitly designed as private return data for C7; C7 owns lifecycle sequencing.
- Ambiguities to record, not resolve: whether common root-bound path/artifact helpers in `tools/mod.rs` are public to C6 or private shared module APIs; exact binary detection heuristic is not contract-specified; any Cargo dependency for ignore/walkdir/regex belongs to C6 unless C5 needs it for shared substrate.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Fixture-first catalog plus root-bounded in-process read | Matches contract and avoids shell authority | Requires careful path/artifact tests | selected |
| Delegate read to existing oh-omp tools or shell commands | Reuses mature code | Imports broader authority and shell/runtime risk | forbidden shortcut |
| Implement all tools in C5 | Simpler module cohesion | Crosses C6 ownership and parallelization boundary | ownership violation |

Selected approach: build a fixture-derived catalog publisher, a safe `read` executor over canonicalized workspace paths, deterministic unsupported-tool metadata, and artifact byte/hash production for C7 to persist.

Invalidated if: accepted protocol catalog/artifact DTOs cannot round-trip `tool-catalog.json` or if safe read cannot be implemented without broader host authority.

Stop/pivot if: implementation needs write/shell/web/subagent authority, fixture/contract changes, local semantic retrieval, or C6-owned discovery implementation.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C5 touches tool authority, fixture schema, artifact retention, and unsupported-tool rejection semantics.

If completed (task 181-C5PreExecutionDissent, verdict REVISE → PROCEED-WITH-CONDITIONS once these rulings are recorded, checkout-proof `b75f38389`):
- Dissent concern: root-bounding via textual prefix checks is the named wrong patch (symlink escape); helper visibility for C6 and the workspace-root source were unresolved; sha256 could be re-implemented; catalog content could drift from the fixture; the binary heuristic was unspecified.
- Response: contract §8 pins the containment mechanism (relative paths only; lexical rejection of absolute/`..` before I/O; canonicalize root and candidate; component-ancestry check; root from trusted kernel/session config, never provider/env/cwd); protocol already exposes `ArtifactHash::compute` + `validate_artifact_content` (sha2 lives in successor-protocol — kernel needs no hashing dep); `tool-catalog.json` pins 34 tools, schema `kernel.tool_catalog.v0`, executable only search_files/read/find/grep, `stub_rejected` for the rest; the unsupported-tool fixture pins the bash rejection (`policy: slice0_read_only`).
- Outcome: PROCEED with orchestrator rulings: (1) C5 edits `tools/{mod,catalog,read}.rs` + granted `tests/slice0_tools_read.rs`; `tools/mod.rs` exposes the safe-path/artifact substrate as pub(crate) for C6 without implementing C6 tools; no lib.rs change; NO new Cargo deps — hashing via protocol `ArtifactHash::compute`/`validate_artifact_content`; (2) root bounding per contract §8 exactly: reject absolute and `..` lexically before I/O, canonicalize root+candidate, component ancestry (never string prefix), symlink escape rejected, nonexistent = typed not-found (never treated as in-root content), root injected by constructor from trusted config; (3) catalog is fixture-derived data — no locally invented schema versions/ids/counts/metadata; the bash rejection follows the fixture; generalized rejection reasons for other stub tools are a RECORDED C5 deterministic policy decision, not presented as fixture-pinned; (4) binary detection: minimal recorded decision — NUL-byte presence in the read window marks binary-looking with a typed rejection; no content-type inference invention; (5) read semantics: whole-file Slice 0 scope with correct sha256/byte_length; no pagination/truncation invention.

## Execute

Checklist:
- [ ] owned files only, plus explicit C8 `lib.rs` module grant and disclosed Cargo bootstrap artifacts if authorized
- [ ] shared catalog/artifact/tool interfaces imported from `successor-protocol`; no local clone DTOs
- [ ] no forbidden shortcuts: no shelling out, no mutation authority, no unsupported tool execution
- [ ] tests/checks added in `crates/successor-kernel/tests/slice0_tools_read.rs`
- [ ] targeted validation passed (`cargo test -p successor-kernel slice0_tools_read` or package-local equivalent, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, especially root escape, hash/byte-length, unsupported catalog behavior
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

Original aim: contract-exact tool catalog and safe read foundation.
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
- Binary detection heuristic and common helper visibility to C6 require dissent/orchestrator ruling.
- Unsupported-tool fixture handling is routed jointly to C5 catalog, C6 discovery authority, and C7 lifecycle; no single lane may paper over fixture/projection rejection.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
