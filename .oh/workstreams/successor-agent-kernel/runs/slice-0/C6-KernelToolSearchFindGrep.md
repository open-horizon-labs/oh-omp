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

If completed:
- Dissent concern: pending.
- Response: pending.
- Outcome: pending.

## Execute

Checklist:
- [ ] owned files only, plus explicit C8 `lib.rs` grant and C5 `tools/mod.rs` export grant if authorized
- [ ] shared tool/artifact interfaces imported from `successor-protocol` and C5 accepted helper APIs
- [ ] no forbidden shortcuts: no shelling out, no web/subagent authority, no hidden semantic retrieval
- [ ] tests/checks added in `crates/successor-kernel/tests/slice0_tools_discovery.rs`
- [ ] targeted validation passed (`cargo test -p successor-kernel slice0_tools_discovery` or package-local equivalent, then orchestrator `make check-rs` before review)
- [ ] named risks retired or routed, especially root escape, unbounded output, and `.gitignore`/binary/error behavior
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

Original aim: bounded read-only discovery tools without shell or hidden context path.
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
- Exact traversal/regex/ignore dependency choices need disclosed Cargo bootstrap and may need dissent ruling.
- C6 depends on C5 helper/export shape; if unavailable, route a narrow C5 reopen rather than duplicating path authority logic.
Human verification needed:
- None before execution; pre-execution dissent ruling required.
