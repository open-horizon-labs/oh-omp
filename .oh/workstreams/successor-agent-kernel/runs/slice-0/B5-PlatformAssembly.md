# Lane B5 — PlatformAssembly

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
- Provider wire objects and provider-shaped messages are non-canonical; `/assemble` responses must contain platform context items, trace/degradation/policy data, and source/artifact references, never provider messages or provider-specific IDs as successor identity.
- `/assemble` is the only semantic context path. B5 must not introduce a local semantic assembler fallback, transcript-only path, or kernel/provider shortcut.
- If canonical assemble fixtures reveal accepted-lane overfit, B5 must stop and reopen the owning accepted lane with targeted review instead of adding local wrappers or fixture-specific bypasses.
- The A5 residual stays routed-not-patched: typed `assemble_response_pre_tool()` and `assemble_response_post_read()` accessors may be consumed in B5-owned tests, but missing bundle-validator wiring remains A5-owned unless orchestrator reopens A5.
- Credential scanning must cover context items, trace previews, dropped-candidate reasons, and artifact/source text for high-confidence credential-looking values before anything is returned or persisted.
- ID prefixes and protocol field names in assembly requests/responses/traces must be fixture/contract-derived, including `asm_`, `ctx_`, `src_`, `art_`, and `trace_`.
- Explicit degradation is required for missing embeddings/vector search/no context; silent empty success is blocked.

## Fan-out / Dependency Order

Required execution order: B1 shell/auth first, then B2 storage append. B5 executes after B2/B3 and preferably after B4 trace/projection substrate is accepted, because `/assemble` consumes stored raw events/artifacts and emits traceable context projections. The only B1/B2 safe-parallel exception is that B1 must first land the minimal shell/module declarations and B2 must never edit B1-owned files. B6 remains last after B1–B5 are accepted.

## Aim

- Outcome: implement platform `/assemble` service and deterministic lexical/recency retrieval so pre-tool and post-read assembly responses match fixtures, degraded retrieval is explicit, and platform assembly never returns provider messages.
- Contract clause(s) served: contract §2.3 context platform is canonical; §6.7 assemble; §6.8 assembly trace; §9 happy-path assembly phases; §13 acceptance criteria for `/assemble` as the only semantic context path and explicit degradation; dispatch map §4.2 `AssemblyServiceV0` and platform validation gate that `/assemble` returns context items/traces/degradation only.
- Fixture(s) served: `assemble-request-pre-tool.json`, `assemble-response-pre-tool.json`, `assemble-request-post-read.json`, `assemble-response-post-read.json`, raw-event successful-turn assembly lifecycle events, and degradation/no-context adversarial cases.
- Files owned:
  - `crates/successor-context-platform/src/assemble.rs`
  - `crates/successor-context-platform/src/retrieval.rs`
  - `crates/successor-context-platform/tests/slice0_assemble.rs`
- Explicit non-goals: provider request/message projection, kernel context construction, raw-event storage, artifact store/index implementation, projection replay internals, HTTP route wiring outside B6, protocol/fixture/contract edits, and model-binding changes.

## Problem Space

- Current state: A0–A5 are accepted/closed on branch `successor-main` (`b1f037dbc`, `dbc6eff42`, `25f1306fc`); `cargo test -p successor-protocol` is green and `make check-rs` exits 0. `/assemble` is the sole semantic context path, but Slice 0 does not implement embeddings/vector search/full assembly.
- Constraints: `/assemble` may use deterministic lexical/recency retrieval over raw events/artifacts; missing embedding/vector capability must be explicit degradation; response DTO must contain context items, trace, degradation, and policy only; provider messages are forbidden; raw events must record assembly requested/completed lifecycle; all JSON-boundary DTOs must reject unknown fields unless contract explicitly provides extension maps.
- Named risks: silently returning empty context without degradation; making `/assemble` a provider-message builder; adding a local semantic context fallback in platform/kernel; using transcript parsing instead of raw events/artifacts; retrieval nondeterminism; over-constraining dispatch by refusing B5-owned semantics because no pre-existing helper exists; ignoring accepted fixture accessors not wired into bundle validation.
- Edge cases: pre-tool request before any tool result; post-read request with required/excluded source IDs; no context available; over-budget items; duplicate source candidates; context item references to future or missing source/artifact handles; trace `dropped` entries; degradation reasons such as embeddings unavailable/no context.
- Interface dependencies: consume B2 raw-event/session store, B3 artifact/source index, and B4 trace/projection substrate once accepted; import accepted A2 platform assembly DTOs, A4 projection/source handles, and A5 fixture accessors/validation helpers from `successor-protocol`.
- Authority boundaries: B5 owns assembly service and retrieval implementation only. It must not edit `crates/successor-protocol/src/fixtures.rs` or `validation.rs`, even for assemble fixture gaps; accepted protocol/fixture-validator changes require A5/A2 reopen protocol.
- Residual carried forward: typed `assemble_response_pre_tool()` and `assemble_response_post_read()` accessors exist in `fixtures.rs` but are not yet wired into `validate_fixture_bundle()`. B5 must treat the typed accessors as available fixture evidence, but must not patch A5-owned `fixtures.rs`/`validation.rs`. If this gap blocks or weakens B5 validation, stop and route an A5 follow-up/reopen before claiming assembly fixture coverage.
- Ambiguities to record, not resolve: dispatch routes fixture-validator evolution to A5, not Wave B. B5 can add its owned `slice0_assemble.rs` tests against accepted accessors, but bundle-validator wiring remains A5-owned unless orchestrator explicitly reopens that lane.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Deterministic lexical/recency assembly over persisted events/artifacts with explicit degradation | Matches Slice 0 scope and fixtures | Limited semantic quality | selected |
| Provider-message assembly response | Easy handoff to provider | Violates platform/provider boundary | contract violation |
| Stub empty successful assembly | Fast | Masks missing retrieval with no degradation | violates explicit degradation requirement |
| Patch fixture validator from B5 | Closes residual quickly | Crosses A5 ownership | requires A5 reopen, not B5 local edit |

Selected approach: implement assembly/retrieval as a deterministic platform service consuming stored raw events/artifacts and accepted assembly DTOs, with traceable candidate/drop/degradation reporting and fixture-level tests for pre-tool/post-read responses.

Invalidated if: accepted `AssemblyResponseV0` or canonical assemble response fixtures cannot both be satisfied after A5/A2 accepted state, or useful context requires provider-message construction or transcript-derived local fallback.

Stop/pivot if: implementation needs to edit accepted A2/A5 protocol/fixture-validator modules, canonical fixtures, contract text, route/auth/storage files outside owned interfaces, or any kernel/provider context-construction path.

## Dissent

Verdict: required-before-execute

If skipped, rationale: not applicable; Wave B runbook requires dissent when touching `/assemble`.

If completed (task 147-B5PreExecutionDissent, verdict PROCEED-WITH-CONDITIONS, checkout-proof `0f8a60517`):
- Dissent concern: `/assemble` is the single semantic-context path; risks are invented ranking heuristics beyond what fixtures pin, a persisted assembly truth plane, re-walking raw events instead of consuming the B4 substrate, and route pre-ownership of B6.
- Response: contract §2.1/§2.2 keep RawEvents canonical and projections rebuildable; §2.3 allows deterministic lexical/recency retrieval with explicit degradation, not persisted assembly state. The canonical response fixtures pin: pre-tool → zero context items, stage `retrieve_recent_sources`, degradation `embeddings_unavailable` (warning) + `no_context` (info), policy sources exactly user_turn/assistant_turn/tool_result; post-read → `required_source_envelope_ids` dominate, exactly one included item (score `1.0`, token_estimate `32`, `platform_artifact` recovery), stage `required_sources`, only the `embeddings_unavailable` warning. Dispatch §4.2 defines the internal service seam `AssemblyServiceV0 { assemble(request) -> AssemblyResponseV0; get_trace(assemble_id) -> Option<AssemblyTraceV0> }`.
- Outcome: PROCEED with orchestrator rulings: (1) `lib.rs` expansion granted for exactly `pub mod assembly;` — any retrieval helper stays B5-internal, never a second public context path; (2) no migration, table, or new dependency; assembly is derived on demand — if durable assembly state ever seems needed, STOP and route; (3) deterministic fixture-derived selection only: required readable artifacts first, honor excludes, obey max_items/max_context_tokens deterministically, explicit degradation for missing embedding capability; any behavior beyond fixture-pinned rules must be visible in trace/policy/degradation and tested, never an unstated heuristic; (4) consume the B4 replay/projection/trace substrate rather than independently re-walking raw events; expose the dispatch-map `AssemblyServiceV0` service seam; routes belong to B6; (5) the A5 residual is executed by B5 as an authorized narrow A5 reopen: wire typed `assemble_response_pre_tool()`/`assemble_response_post_read()` into `validate_fixture_bundle` with typed-parse and credential-scan coverage; no alternate DTOs, no fixture edits, no weakened validation.

## Execute

Checklist:
- [x] owned files only — with one disclosed naming divergence: the packet's provisional names (`assemble.rs`, `retrieval.rs`, `tests/slice0_assemble.rs`) resolved to `assembly.rs` and `tests/slice0_assembly.rs` per the dispatch-map `AssemblyServiceV0` seam; retrieval stayed internal per dissent ruling 1 (Superego-accepted, task 151)
- [x] shared interfaces imported from `successor-protocol`; no local duplicate protocol DTOs
- [x] no forbidden shortcuts
- [x] tests/checks added inside owned scope (11 assembly integration tests + protocol stage round-trip/credential tests)
- [x] targeted validation passed (platform + protocol suites)
- [x] orchestrator-owned `make check-rs` gate green before review dispatch and after review fixes
- [x] named risks retired or routed (no invented ranking heuristics; unpinned decisions disclosed and trace-visible; no persisted assembly state)
- [x] model binding verified (`slice0-executor`, `anthropic/claude-sonnet-5:high`; tasks 148, 152)
- [x] fixture sovereignty preserved; no fixture edits
- [x] accepted-module edits only under authorized reopens (ruling-5 A5 `validation.rs`; review-fix A2 `platform_api.rs` `AssemblyTraceStageV0`)
- [x] no new JSON-boundary DTOs; `AssemblyTraceStageV0` reopened with `deny_unknown_fields` and the six fixture-pinned fields
- [x] workspace lint gate green before review
- [x] no dispatch over-constraint
- [x] assemble-response accessor residual executed: `validate_assembly_response` wired into `validate_fixture_bundle` for both typed responses with credential-injection rejection

Changed files:
- New: `crates/successor-context-platform/src/assembly.rs`, `crates/successor-context-platform/tests/slice0_assembly.rs`
- Granted expansion: `lib.rs` — exactly one appended module declaration (`assembly`)
- Authorized reopens: `crates/successor-protocol/src/validation.rs` (ruling 5 + stage-aware scanning), `crates/successor-protocol/src/platform_api.rs` (`AssemblyTraceStageV0` six fixture-pinned fields + `deny_unknown_fields`), `crates/successor-protocol/tests/slice0_fixture_contract.rs` (stage round-trip proof)

Validation evidence:
- Platform: 56 unit + 12 assembly + 9 replay tests green; both canonical assemble request fixtures produce responses per-field equal to the canonical response fixtures (minted ids asserted well-formed + self-consistent); determinism, excludes, budget caps, typed errors covered
- Protocol: all suites green; stage round-trip byte fidelity and credential-injection-in-notes rejection proven; bundle validator covers both typed assemble responses
- `make check-rs` exit 0 at `97c2dd5a3` (implementation) and `c94999178` (review fixes)

## Code Review

Reviewer: `slice0-reviewer` (task 150-B5CodeReview, checkout-proof at `97c2dd5a3`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE, closed

Findings:
- P1: fixture-pinned trace-stage fields (`started_at`, `completed_at`, `input_count`, `output_count`, `notes`) silently dropped by the tolerant `AssemblyTraceStageV0`; B6 would return non-fixture-compatible responses and stage credential drift escaped validation.
- P2: unbounded in-memory trace cache for a long-lived B6 process.
- P2: stale packet ownership/evidence — closed by this update.

Fixes applied (task 152, commit `c94999178`):
- Authorized narrow A2 reopen: `AssemblyTraceStageV0` carries the six fields (union of both canonical response fixtures, all required, `deny_unknown_fields`); full construction-site cutover; stage round-trip byte fidelity proven; credential injection into stage `notes` rejected.
- Trace cache bounded with a disclosed eviction policy; regression test added.
- Stage emission semantics for unpinned values disclosed (synchronous stages share the response `created_at`; input/output counts defined per stage semantics; note strings generalized from the fixture-pinned n=1 case).

## Drift Review

Original aim: deterministic `/assemble` service seam over B2/B3/B4, fixture-faithful, derivation-only.
Current work: tasks 148+152 as committed through `c94999178`.
Gap: none material (task 149-B5DriftReview: no route/auth/storage-write/dependency drift; no hidden durable decision; reopen within ruling 5).
Verdict: aligned
Authority boundary: clear

## Superego Review

Reviewer: `slice0-superego-reviewer` (task 151-B5SuperegoReview, checkout-proof at `97c2dd5a3`)
Reviewer model: `openai-codex/gpt-5.5:high`
Verdict: REVISE (governance evidence only; no implementation changes required), closed

Frame risks:
- None in code: single `/assemble` context path, in-memory-only trace cache, disclosed unpinned decisions, A5 reopen within grant.

Required corrections:
- Record actual changed files with the stale-name divergence, validation/gate evidence, and Delivery disposition — applied in this update.

## Delivery

Status: accepted
Residual risks:
- Stage `input_count`/`output_count`/`notes` semantics beyond the fixture-pinned single-source case are disclosed generalizations; B6 route-contract tests must pin them before external exposure.
- The trace cache bound is a service-level retention policy, not a contract; if `/assemble` trace retrieval becomes contractual beyond Slice 0, retention needs explicit contract text.
- Token estimator (`whitespace_words * 4`) reproduces the fixture's pinned 32 but is a Slice 0 placeholder; replacing it later changes `token_estimate` values and must be treated as a contract-visible change.
Human verification needed:
- None outstanding.
