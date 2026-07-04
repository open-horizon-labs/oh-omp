# Lane C6 — KernelToolSearchFindGrep

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
- Discovery tools are lexical/root-bounded only; no hidden semantic/vector retrieval, shell-outs, web fetches, subagents, or oh-omp tool delegation.
- `search_files`, `find`, and `grep` must obey the same root, bounds, artifact, binary/truncation, and error rules as C5 `read`.
- Bounded traversal/output is part of correctness; tests must fail unbounded output, root escape, and unsupported tool authority expansion.
- Tool result artifacts need exact byte length/hash where content is recorded; previews must not become unbounded content channels.
- Unsupported tool requests must be routed into deterministic rejection/error lifecycle by C7; C6 must not silently ignore or execute beyond its authority.
- If existing C5 helper APIs are insufficient, request a narrow C5 reopen/grant rather than duplicating inconsistent path/root logic.

## Fan-out / Dependency Order

Required staging: C8 shell/module grant first, then C5 tool namespace/read substrate. C6 must not create or rewrite `tools/mod.rs`; if it needs exports, C5 must provide them or grant append-only module declarations for C6-owned tool files.

Parallelization: C6 can run after C5 lands the tools namespace/shared root-bounds substrate. It can parallelize with C4 full provider projection if C3 is already accepted. C7 depends on C5 and C6 accepted tool APIs. Full C8 depends indirectly through C7/RPC.

## Aim

- Outcome: implement bounded read-only discovery tools (`search_files`, `find`, `grep`) for the standalone successor kernel so the Slice 0 locator path can find files without shell/web/subagent authority or hidden semantic assembly.
- Contract clause(s) served: contract §2.5 local authority is read-only; §7.1 executable tools; §8.2 `search_files`; §8.3 `find`/`grep`; §9 successful and unsupported tool paths; §13 acceptance criteria 5, 6, and 12; risk-retirement matrix tool authority row.
- Fixture(s) served: discovery portions of `raw-events-successful-turn.json`; unsupported-tool path in `raw-events-unsupported-tool.json`; `tool-catalog.json` executable tool set; artifact/projection expectations downstream.
- Files owned:
  - `crates/successor-kernel/src/tools/search_files.rs`
  - `crates/successor-kernel/src/tools/find.rs`
  - `crates/successor-kernel/src/tools/grep.rs`
  - `crates/successor-kernel/tests/slice0_tools_discovery.rs`
- Dependencies: accepted C5 tools namespace/catalog/read root-bounds substrate; accepted protocol artifact/tool result DTOs; trusted workspace root from kernel session/config; downstream C7 runner.
- Explicit non-goals: tool catalog ownership, `read` implementation, write/edit/shell/web/subagent tools, semantic/vector retrieval, provider projection, platform client, turn orchestration, fixture/contract edits, and any oh-omp context-management framing.

## Problem Space

- Current state: no discovery tools exist in `successor-kernel`. Contract allows lexical/filename/regex discovery only and requires useful smoke behavior without path-explicit prompts.
- Constraints: search only under session workspace root; bounded traversal and output; respect `.gitignore` unless implementation explicitly records why not; return path/match previews as tool-result artifacts; no hidden semantic retrieval; no shelling out.
- Named risks: using system `find`/`grep` through shell; following symlink escapes; unbounded recursion or output; treating hidden/vector search as `/assemble`; diverging from C5 path/artifact rules; broadening catalog-visible unsupported tools into executable tools.
- Edge cases: empty query; regex syntax error; glob patterns with `..`; binary files; very large files; symlinks; ignored files; no matches; max match limits; long lines/previews; Unicode paths/content; permission errors.
- Interface dependencies: C5 common safe path/artifact helpers; C7 lifecycle persistence; protocol artifact/result shapes.
- Authority boundaries: C6 owns discovery algorithms only. It must not alter C5 catalog/read semantics, persist raw events itself, or call platform `/assemble`.
- Ambiguities to record, not resolve: exact crates for traversal/glob/ignore/regex are not specified; `.gitignore` behavior is recommended but contract allows explicit recorded deviation; C6 may need C5-owned `tools/mod.rs` exports for module visibility.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| In-process bounded traversal/regex using Rust crates and C5 root helpers | Preserves authority and testability | Requires disclosed dependencies | selected |
| Shell out to `find`/`grep`/`rg` | Fast and mature | Violates no-shell authority and output bounds | forbidden shortcut |
| Use platform `/assemble` for search | Reuses context system | Creates second/hidden semantic context path for tools | contract violation |

Selected approach: implement in-process discovery tools that share C5 root validation/artifact limits, produce bounded deterministic previews/results, and expose only safe result material for C7 to record.

Invalidated if: useful discovery cannot be bounded without shelling out, or C5 helper APIs cannot be shared without broad ownership changes.

Stop/pivot if: implementation needs shell/runtime/web/subagent authority, semantic/vector retrieval, C5-owned rewrites, fixture/contract edits, or local context assembly.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; C6 touches tool authority and the contract's no-shell/no-hidden-semantic-retrieval boundary.

If completed (task 193-C6PreExecutionDissent, verdict ALLOW / PROCEED-WITH-CONDITIONS, checkout-proof `da4436642`):
- Dissent concern: discovery tools could re-implement containment instead of reusing the C5 substrate, hand-roll degraded pattern semantics while presenting them as contract-pinned, invent ordering/limit/gitignore policy silently, or add dependencies without staging disclosure.
- Response: contract §7.1 names the semantics honestly served by audited crates (`search_files`: walkdir/ignore + lexical/regex matching; `find`: glob; `grep`: regex/text search); §8.2/§8.3 pin root-bounds, artifact-backed `tool_result.recorded` results, no hidden semantic/vector retrieval, same bounds/error rules for find/grep; the successful-turn fixture pins the `search_files` shape (`{query, max_matches}` → `matches[{path, score, preview}]` JSON artifact); the C5 substrate exposes `validate_relative_path_lexically`, `WorkspaceRoot`, `read_with_root`, `looks_binary`, `compute_artifact_bytes`; the SHELL-stage crate prohibition does not import as a C6 ban — C6 is the lane where these semantics live.
- Outcome: PROCEED with orchestrator rulings: (1) C6 edits `tools/{search_files,find,grep}.rs` + new granted `tests/slice0_tools_discovery.rs`; (2) dependency staging GRANTED as disclosed bootstrap artifacts: `regex`, `globset`, `walkdir` (audited, default-features minimal); `ignore` NOT granted — gitignore semantics are not contract-pinned and must not appear implicitly; Cargo.toml/Cargo.lock changes disclosed in completion notes; (3) containment: reuse the C5 substrate exactly — lexical validation before I/O, WorkspaceRoot ancestry, looks_binary before grep content scans, compute_artifact_bytes for results; any tools/mod.rs addition is a C5 staging expansion requiring explicit disclosure; a shared C6-owned walker composing those helpers is allowed; (4) recorded deterministic policy (disclosed, payload/trace-visible, never presented as fixture-pinned): lexicographic ordering by normalized relative path, stable tie-breaks, explicit max-result/match defaults with truncation metadata, hidden files INCLUDED (no gitignore/hidden exclusion invention), symlinks not followed out of root per substrate, binary files skipped by grep with the NUL rule; (5) search_files result shape follows the fixture exactly; find/grep shapes follow catalog schemas with the same artifact/error rules.

## Execute

Checklist:
- [x] owned files only (tools/{search_files,find,grep}.rs + granted tests/slice0_tools_discovery.rs); no lib.rs or tools/mod.rs grants needed — the shared walker lives in C6-owned find.rs
- [x] shared interfaces from `successor-protocol` and accepted C5 helpers (WorkspaceRoot, validate_relative_path_lexically, read_with_root, looks_binary, compute_artifact_bytes)
- [x] no forbidden shortcuts: no subprocess, no gitignore/hidden-file semantics (`ignore` crate deliberately absent), no semantic retrieval; deps exactly the granted regex/globset/walkdir
- [x] tests in granted file: 18 discovery tests + revision regressions (long-line truncation, oversize skip, fixture replay)
- [x] targeted validation + orchestrator `make check-rs` exit 0 at `c8ebb4abb` and `a5557d6fd`
- [x] named risks retired: root escape via substrate reuse; unbounded output closed by revision (512-byte previews, 2MiB scan gate); binary NUL rule; determinism proven (sorted-walk ≡ lexicographic sort-then-truncate)
- [x] model binding verified (`slice0-executor`, Sonnet 5; tasks 194, 199; task 198 cancelled mid-flight — design reused, no edits lost)
- [x] fixture sovereignty preserved AND enforced: C6 surfaced two verified fixture STOP items (unreproducible score 0.91, non-derivable preview) — routed to the approved sovereign amendment `1db794108` (dissent task 200 ALLOW, human acceptance, sovereignty review task 202 ALLOW)

Changed files:
- `crates/successor-kernel/src/tools/{search_files.rs, find.rs, grep.rs}`, new `tests/slice0_tools_discovery.rs`, `Cargo.toml` (regex minimal+unicode-perl, globset, walkdir), `Cargo.lock`

Validation evidence:
- All kernel suites green (8 binaries); fixture-replay test asserts exact score/preview post-amendment; determinism, truncation-metadata, symlink-exclusion, invalid-pattern typed errors all covered; `cargo test --workspace` 22 ok blocks at `1db794108`

## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed (task 195-C6CodeReview, checkout-proof at `c8ebb4abb`)

Findings:
- P1: grep previews unbounded (full matching line serialized; oversize files fully read before scan).
- P2: search_files did not reproduce the canonical fixture's recorded result (tests avoided the fixture's real query).

Fixes applied (task 199 implementing cancelled task 198's design, commit `a5557d6fd`):
- 512-byte char-boundary-safe preview truncation with `preview_truncated` metadata; 2MiB per-file scan gate (skip like binary); content-derived first-non-empty-line previews bounded by the same helpers; fixture-replay test with the real query — which surfaced the fixture's own inconsistency, resolved by sovereign amendment `1db794108`.

## Drift Review

Original aim: bounded read-only discovery tools without shell or hidden context path.
Current work: tasks 194+199 through `a5557d6fd` (+fixture amendment `1db794108`).
Gap: none material (task 197-C6DriftReview: discovery-only, C5 files untouched, walker in C6-owned files).
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed (task 196-C6SuperegoReview, checkout-proof at `c8ebb4abb`)

Frame risks:
- Unbounded grep content channel + full-file reads (converged with code review P1) — closed by task 199 bounds and regression tests; stricter-than-ruled structural symlink exclusion accepted as sound conservative deviation, disclosed.

Required corrections:
- Applied in task 199; evidence recorded in this update.

## Delivery

Status: accepted
Residual risks:
- Regex DoS surface (catastrophic patterns) accepted for Slice 0: single-tenant local kernel, bounded scan gate limits blast radius; revisit if the kernel ever serves untrusted patterns.
- search_files ranking remains path-only disclosed policy; content relevance is deliberately out of Slice 0 scope.
Human verification needed:
- Fixture amendment human acceptance GRANTED (recorded in tasks 200/201/202 and commit `1db794108`).
