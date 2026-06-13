# Workstream Expert System

> **PERSISTED LAW — durable-law delta APPROVED by user 2026-06-12; roster user-confirmed and materialized via `task.agentModelOverrides`; persisted at `.oh/workstreams/oh-omp/EXPERT-SYSTEM.md`. Commit remains gated per invocation (B14/S12).**
> Provenance: U-N1/U-N2/U-N4/U-N5 resolved; all seven delta items approved; fixed Model Roster roles bound by explicit user decision to `openai-codex/gpt-5.5`; config persistence complete through agent overrides; final artifact written 2026-06-12.

## Persistence

**Workstream ID:**
`oh-omp` — project-wide development governance for this repository.

**Artifact path / store:**
`.oh/workstreams/oh-omp/EXPERT-SYSTEM.md`, committed to git when explicitly instructed (user decision; `.gitignore` verified compatible — only `.oh/.cache/` ignored). The draft remains at `.oh/workstreams/oh-omp/EXPERT-SYSTEM.draft.md` as provenance after final persistence. The commit ACTION remains gated per-invocation (B14/S12): the in-principle persistence decision does not waive explicit user commit instruction.

**Lifecycle:** durable conceptual workstream

**Version / updated at:**
`v1 (bootstrap; delta-approved; roster-bound)`, 2026-06-12. Initial creation, compiled from the approved frame `.oh/workstreams/oh-omp/FRAME.md` (superego-ALLOWed round 2, high confidence, zero required corrections) with four binding superego advisories applied; durable-law delta approved by user 2026-06-12; fixed Model Roster roles user-confirmed to `openai-codex/gpt-5.5` and materialized through `task.agentModelOverrides`.

**Applies to:**
ALL development tasks in this repository (oh-omp) — coding, mechanical work, ADR authoring, releases, issue/PR work, expert-system maintenance, and the model-routing build-out itself when its tasks run.

**Does not apply to:**
Upstream repo governance (upstream is read-only sync source — B15); other repositories (until the expert-system pattern is deliberately exported — not authorized); the workstream-subagents pipeline's internal law (adjacent workstream — its role contracts are consumed as canonical sources, not governed here).

## Authority Chain

**Raw request / current task:**
The `/workstream-expert` invocation (originally seeded for the `model-routing` workstream) plus the user's frame-checkpoint correction: the expert system is NOT model-routing-scoped — it is workstream `oh-omp`, a generic project-wide expert system governing all development in this repo, with the routing law as its delegation/routing chapter (Chapter A). This sub-task: builder-only finalization of the approved expert-system artifact, including transcription of the user-confirmed roster binding and config materialization. No code, no ADR text, no prompt edits.

**Existing expert system:**
None found. The model-routing invocation produced only a frame (`.oh/workstreams/oh-omp/FRAME-model-routing-superseded.md` (moved per U-N4)); no `EXPERT-SYSTEM.md` exists anywhere in the repo (per the frame's inspection, carried). This is a create, not an update.

**Canonical sources:**
- `.oh/workstreams/oh-omp/FRAME.md` — THE governing frame (superego-ALLOWed round 2). Read in full this build. Highest authority for this compilation: two-chapter criteria map (A1–A18, B1–B22), stop conditions S1–S19, uncertainties U-1…U-12 + U-N1…U-N7, identity/boundary, compilation rules; U-N1/U-N2/U-N4/U-N5 now user-resolved as durable law in this delta.
- `.oh/workstreams/oh-omp/FRAME-model-routing-superseded.md` (moved per U-N4) — superseded narrower frame, superego-ALLOWed for its scope. Read in full this build (advisory 5: consulted as full artifact, not packet summary). Chapter A provenance.
- `.oh/model-routing.md` — primary decision record behind Chapter A. Read in full this build (318 lines including the Lifecycle & Convergence tail). Internally supersessioned; final state binds. Source for the Definitions below.
- `AGENTS.md` (repo root) — Chapter B's living substrate, repo-committed engineering law. NOT re-read in this build by design: B-criteria are compiled strictly from the frame's superego-ALLOWed direct inspection (advisory 4, shadow-copy containment); AGENTS.md remains the authoritative detail for every B-criterion it sources.
- `.omp/rules/ts-hook-fetch.md` — read in full this build (51 lines). Durable, mechanically enforced project rule (regex condition on test-file edits/writes). Source for B17.
- `docs/adr/0001–0006` — status headers verified by direct inspection this build (advisory 1): **0001 Accepted, 0002 Accepted, 0003 Accepted (iterative), 0004 Proposed, 0005 Accepted, 0006 Proposed**. Never summarize as "six accepted ADRs." Accepted ADRs constrain development as law; Proposed ADRs (0004, 0006) are design intent pending acceptance, cited as provenance, not as accepted constraint.
- `packages/coding-agent/src/prompts/agents/workstream-expert.md` — structural contract; § Model Roster binding rule read this build. `.../commands/workstream-expert.md` + `docs/workstream-subagents-v0.md` — process/role contracts, carried per the frames.

**OH Workstream Frame:**
`.oh/workstreams/oh-omp/FRAME.md` (revision 2, project-wide, 2026-06-12) — superego-ALLOWed round 2, high confidence, zero required corrections, four advisories. It supersedes `.oh/workstreams/oh-omp/FRAME-model-routing-superseded.md` (moved per U-N4) while carrying its law intact as Chapter A. This expert system compiles that frame; it does not re-derive it.

**Superego corrections incorporated:**
Round-2 advisories, all applied in this draft:
1. Per-ADR statuses recorded in the source inventory (0001/0002/0005 Accepted; 0003 Accepted (iterative); 0004 and 0006 Proposed) — never "six accepted ADRs."
2. B1's "before implementation" is marked **inferred** (from AGENTS.md "ADR-driven decisions" + the anti-pattern stop trigger), not quoted text.
3. U-N5 (classification of non-code work under the delegation protocol) was deliberately encoded as OPEN per advisory 3; the user resolved it on 2026-06-12 as cognitive-content classification law, superseding the open-item encoding.
4. Chapter B matrix rows compiled strictly as criterion + verifier check + citation; the frame's paraphrased detail is not expanded here (shadow-copy containment — the cited files hold the authoritative specifics).

**Validity status:** valid; final-ready
All canonical sources readable; the governing frame is superego-ALLOWed; no criterion unknown. Durable-law delta approved by user 2026-06-12: U-N1/U-N2/U-N4/U-N5 are resolved-law; U-N3 has an owner; U-N6 remains open under its conservative interim; U-1/model pool binding is resolved for the fixed roster by the user's `openai-codex/gpt-5.5` decision; A17 bootstrap-v0 seeding, persistence, and commit follow their gates.

## Workstream Identity

**Workstream type:**
other — **project-wide development governance** (composite: process/protocol law + API contract + observability + investigation).

**Conceptual scope:**
ALL development in this repository under two-chapter law. Chapter A (Delegation/Routing Law): every coding task follows the delegation protocol — the orchestrator frames, architects, and reviews but never codes; ALL implement-class and mechanical-class work dispatches to bound coder-tier roles (the delegation floor governs *which tier*, never *whether*); the model-routing build-out itself (ADR authoring, `src/routing/`, dual-mode dispatch params, telemetry, gradation) when those tasks run; the per-role Model Roster and binding law; dogfooding governance with oh-omp as project zero; expert-system maintenance and durable-law amendment. Chapter B (Implementation Law): every change verified against the repo's engineering law via citation-first acceptance gates.

**Activated conceptual systems:**
The entire repo's development surface — `packages/coding-agent` (primary focus per AGENTS.md § Default Context), the dispatch/model-resolution seams (`task/index.ts`, `task/executor.ts`, `task/agents.ts`, `config/model-resolver.ts`), planned `src/routing/`, `docs/adr/`, `.oh/` decision artifacts, `.omp/rules/`, `.omp/agents/`, expert-system pipeline prompts, per-package changelogs.

**Context-only systems:**
Inspectable, NOT modifiable without scope promotion: `session/agent-session.ts` hot paths, `interactive-mode.ts` plan-mode switch, pi-ai rate-limit internals, smol utility internals, the upstream remote.

**Acceptance authority:**
User (Drazen) — for all residual risk, resolved durable-law decisions (U-N1, U-N2, U-N4, U-N5), unresolved U-N6/bootstrap-v0 questions, model bindings, persistence and its commit. Superego holds ALLOW/REVISE/BLOCK review authority as a gate before persistence and before future durable-law changes; it cannot accept risk on the user's behalf.

**Closure authority:**
Non-closing by default. Closure language (`Closes`/`Fixes`/`Resolves`) is permitted only when a task's original request satisfaction target is `full` and every canonical criterion is satisfied or explicitly accepted by the authorized owner; otherwise `Refs`/`Partially addresses`. B19's `fixes #N` convention is the mechanism for closure when closure is EARNED, never a default. This expert system grants no closure authority (A16).

## Durable Problem Model

**Observed reality:**
Sourced facts (frame, direct inspection, this build's verification):
1. Root `AGENTS.md` is a 628-line committed law file (project constraints + development rules); no `CLAUDE.md` exists at root or in `packages/coding-agent/` — AGENTS.md is the single agent-law file. [frame inspection]
2. `.omp/rules/` contains exactly one rule, `ts-hook-fetch.md`, mechanically scoped and durable. [verified this build]
3. `docs/adr/` holds ADRs 0001–0006 in numbered format with Status headers: 0001/0002/0005 Accepted, 0003 Accepted (iterative), 0004/0006 Proposed. [verified this build — advisory 1]
4. `.oh/model-routing.md` is a complete, internally-supersessioned decision record ending in a user-confirmed three-stage lifecycle. [read in full this build]
5. Model assignment today is static/manual; subagents inherit the parent's model (`task/index.ts:513-517` per the record — inference: carried on the frames' superego-ALLOWed authority, not freshly re-verified here). 
6. `.gitignore` permits committing `.oh/workstreams/` content (only `.oh/.cache/` ignored). [frame inspection]
7. No expert system existed before this draft. [frame inspection]
Inference (marked): the routing record's supersession-chain reading is carried as U-N7 on the superseded frame's superego-ALLOWed authority; AGENTS.md section extraction is the same inherited-verification pattern from the oh-omp frame's superego-ALLOWed authority. Neither was freshly re-verified line-by-line here.

**Core tension:**
Two laws of different character merged into one system. Chapter A is a compiled palimpsest of user decisions with explicit supersession chains and dissent-calibrated claims — fragile to re-derivation, so it is carried verbatim-in-substance. Chapter B lives in repo files (AGENTS.md, `.omp/rules/`, ADRs) that change through normal development — so this expert system CITES and defers to them rather than forking their content, or it becomes a stale shadow law whose drift silently bifurcates the rules (U-N6). And the expert system governs the very protocol (delegation) under which its own maintenance runs — self-application means compilation errors propagate into every future task AND into the gradation dataset's ground truth.

**Slop risks:**
Carried from the frame's failure modes (a)–(h):
(a) Diluting or dropping a Chapter A criterion during merge/maintenance. (b) Forking AGENTS.md content verbatim into this artifact, creating drifting shadow law. (c) Re-inventing per-package applicability (U-N1) or rule-source precedence (U-N2) instead of applying the user-resolved law recorded here. (d) Treating this system's governance of routing as authorization to implement routing (A1 gates: governance now, implementation after ADR). (e) Restoring pre-dissent claim strength while restructuring. (f) Scope creep into other repos or interactive routing. (g) Over-narrowing: dropping dogfooding governance or the universal categorical-dispatch reading of A6. (h) Committing artifacts without per-invocation user instruction (B14 vs persistence-decision confusion).

**Definitions:**
- **Effort classes**: `frame / plan / review / implement / mechanical` — the routing taxonomy; definitions, boundary examples, and the "too small to route" floor live in policy data/protocol doc, never engine code. [`.oh/model-routing.md` § Protocol; A5]
- **Categorical never-codes rule**: the orchestrator never codes; ALL implement- and mechanical-class work dispatches to coder-tier models; the delegation floor governs *which tier* gets small work, never *whether* to dispatch. [§ Protocol Hardening, user-confirmed]
- **Satisficing objective**: per class, eligible = models with P(adequate) ≥ class threshold at current confidence; choose cheapest/fastest eligible; never optimize max-quality (would reinstate data-justified overkill). [§ Telemetry spec "Optimization objective"; § Lifecycle Stage 3 Guard]
- **Outcome trust hierarchy**: mechanical verdicts > escalation events > independent verdicts (verifier/superego `DECISION:` lines) > orchestrator disposition; disposition never moves a grade without corroboration. [§ Telemetry spec]
- **Dispatch modes (dual-mode, additive)**: `effort:` class hint (policy resolves through current grades — exploits) or exact `model:` from the pool (validated, directed exploration that feeds gradation); both optional; absent params → today's behavior. [§ Mechanism "Dispatch contract"]
- **Binding statuses**: `user-confirmed` / `suggested-unconfirmed` / `unbound: needs user decision` / `pipeline-default` — a suggestion is not a binding; non-answer = unbound, never consent. [builder prompt § Model Roster; the model-binding step; the durable-law delta step]
- **Chapter B applicability (U-N1 resolved 2026-06-12)**: uniform-except-self-scoped. The full Chapter B binds all TS packages except rows naming their own scope (B6/B7 are coding-agent-only); `crates/pi-natives` is governed by its cargo toolchain plus the language-neutral process rows (B13–B16, B18–B22). Package-level exceptions require the S5 delta protocol.
- **Rule-source jurisdiction (U-N2 resolved 2026-06-12)**: jurisdictional split, not a total order. `.omp/rules/` mechanical rules win within their trigger scope; this expert system governs process/delegation/verification/closure law; AGENTS.md governs implementation detail, and Chapter B defers detail to it by design. A TRUE cross-surface conflict is law drift → S5 stop, routed to the user. U-N6's conservative interim remains in force: AGENTS.md-sourced changes flow through S5 until U-N6 is resolved.
- **Cognitive-content classification (U-N5 resolved 2026-06-12)**: judgment-bearing artifacts (ADR authoring, expert-system maintenance, decision records) are frame-class and orchestrator-permitted; transcription-bearing artifacts (changelog entries, link fixes, drafting from already-decided content with orchestrator review) are mechanical-class and dispatched. Boundary test: does the artifact RECORD decisions being made (frame) or RESTATE decisions already made (mechanical)?
- **Session-policy drift owner (U-N3 assigned 2026-06-12)**: orchestrator, per-session — checks session-policy↔AGENTS.md drift each session; divergence routes through S5.
- **bootstrap-v0**: the versioned, explicit-guess policy seed produced at Lifecycle Stage 1; expected to be replaced by measured gradation, not maintained by hand. Seeding it is itself a durable-law change (A17/advisory 4 of the frame round-1 review). [§ Lifecycle Stage 1]
- **Three-stage lifecycle**: (1) bootstrap — strongest model builds the expert system + seeds bootstrap-v0; (2) measurement — categorical dispatch + acceptance-gate verdicts fill cells; (3) jitter→convergence — Thompson sampling over per-(project × class) posteriors, satisficing-constrained. [§ Lifecycle & Convergence Model, user-confirmed]

## Current Step 0 Contract

**Current task frame:**
Final-ready persistence of the approved `oh-omp` expert-system artifact from the draft, with the user-confirmed fixed Model Roster binding transcribed and materialized in agent config. No product code, no ADR text, no prompt edits, no `.omp/agents/` creation, no commit.

**Task-specific acceptance criteria:**
Task-local (not durable law): (1) draft retained as provenance; (2) final artifact written at `.oh/workstreams/oh-omp/EXPERT-SYSTEM.md` without the DRAFT warning; (3) Model Roster fixed roles bound to `openai-codex/gpt-5.5` with status `user-confirmed`; (4) all four round-2 advisories visibly applied; (5) durable-law delta transcribed: U-N1/U-N2/U-N4/U-N5 resolved by user, U-N3 owner assigned, U-N6 conservative interim retained; (6) `task.agentModelOverrides` contains the roster materialization keys.

**Task-specific non-goals / stop conditions:**
This invocation does not: implement product code, resolve open items by builder judgment, create `.omp/agents/` files, or commit. Review, durable-law delta, roster binding, and config materialization are DONE. Remaining checkpoint sequence: persistence to `EXPERT-SYSTEM.md` by the orchestrator (this step) → commit on explicit user instruction (B14/S12; commit authorized in the delta but still executed as its own gate).

**Frame delta from prior expert system:**
Initial creation — no prior expert system exists. Relative to the superseded model-routing frame: scope widened from one workstream to project-wide governance (user correction); the 18 routing criteria carried undiluted as Chapter A; Chapter B (implementation law) added from inspected repo sources; stop conditions extended S12–S19.

## Acceptance Criteria Matrix

Status key (bootstrap state, 2026-06-12): `planned` = gate defined, governed activity not yet started (routing implementation is ADR-gated); `unproven` = standing gate, re-proven on every task it touches, including rows whose prior unknowns are now resolved-law; `deferred` = deferred with authority; `unknown` = open item awaiting user/delta decision. Chapter B rows are citation-first: the criterion names the rule, the cited source holds the authoritative detail, the evidence column is the verifier check (advisory 4 — paraphrase deliberately not expanded).

### Chapter A — Delegation/Routing Law (carried undiluted from the superseded frame, advisories applied)

| Criterion | Source / provenance | Scope | Required handling | Evidence required | Current status |
|---|---|---|---|---|---|
| A1 **ADR first**: engine hooks, policy schema, precedence, storage, learning authority documented in `docs/adr/` before any routing implementation | `.oh/model-routing.md` § Guardrails; § Dissent → ADR | durable | required (BLOCK IF rule) | Approved ADR exists in `docs/adr/` before any `src/routing/` code lands; coder must stop if asked to implement without it | planned |
| A2 **Additive + protocol-compatible**: no session lifecycle/event/completion changes; dispatch params optional; storage additive; existing dispatches behave identically when params absent | § Guardrails; § Solution Space Execution Contract "Preserve" | durable | required | Diff review: no protocol/event/name changes; regression — dispatch without new params behaves as today; breaking change needed → stop | unproven |
| A3 **Precedence is sacred**: explicit user/agent settings always beat policy; chain = user settings > dispatch exact model > agent frontmatter > policy(effort) > inheritance; policy returns undefined → existing inheritance untouched | § Guardrails; § Architecture item 4; § Problem Space open Q4 | durable | required (chain order flagged Needs Human Verification — one-way once in ADR; U-6) | Precedence test cases per level; session-log evidence that explicit settings win; violation → stop and redesign (S1) | planned |
| A4 **Visible degradation**: tier/routing changes emit observable status via existing surfaces (model_change/log), never silent | § Guardrails | durable | required | Resolved model + resolution source visible in task UI/log for every routed dispatch; silent change → stop (S8) | planned |
| A5 **Taxonomy changes manual only**; taxonomy semantics and tier opinions live in policy data/protocol doc, never hardcoded in engine (layer discipline) | § Guardrails; § Telemetry spec "Three optimized objects" | durable | required | No class semantics in engine code; class split/merge requires explicit human decision (S3); engine change needed for policy tweak → layering broken, stop (S6) | unproven |
| A6 **Categorical never-codes rule**: the orchestrator never codes; ALL implement- and mechanical-class work dispatches to coder-tier models; the delegation floor governs which tier, never whether — governs ALL repo development, not only routing-workstream tasks | § Protocol Hardening "Categorical dispatch rule (constraint, user-confirmed)"; frame rescoping | durable | required | Session audit: zero implement/mechanical work performed in-session by the orchestrator on any oh-omp task; protocol active from observe-only phase onward | unproven |
| A7 **Satisficing objective, not maximizing**: per class choose cheapest/fastest adequate; selection never optimizes max-quality | § Telemetry spec "Optimization objective"; § Lifecycle Stage 3 Guard | durable | required | Policy/selection review + gradation reports show cheapest-adequate selection | planned |
| A8 **Telemetry trust hierarchy**: mechanical verdicts > escalation events > independent verdicts > orchestrator disposition; disposition never moves a grade without corroboration | § Telemetry spec "Outcome trust hierarchy"; Statistical integrity | durable | required | Gradation logic weights by hierarchy; no grade change from uncorroborated disposition alone | planned |
| A9 **Observe-only precedes routing authority**: telemetry records while assignment is manual/static; phasing 0→3; observe-only doubles as labeling-consistency audit before authority transfer | § Mechanism (Outcome telemetry); § Telemetry spec "Phasing" + "Label noise" | durable | required | Rollout sequencing evidence; observe-only writes records without altering resolution; no authority before label audit (S9) | planned |
| A10 **Evidence-not-statistics for sparse cells; auto-amendment volume-contingent** — EXCEPT coder × implement/mechanical cells (auto-amendment v1-viable there); sparse frame/plan/review cells evidence-only; ≥3-consecutive-approvals auto-apply specified but may never trigger; calibrated claims MUST NOT be restored to pre-dissent strength | § Dissent ADJUST 1–5; § Protocol Hardening "Dissent update" | durable | required | Expert system states calibrated claims (done — this row); gradation reports framed as evidence summaries outside coding cells | unproven |
| A11 **Jitter scope**: Thompson sampling over per-(project × class) fitness posteriors, satisficing-constrained; only cheap-to-verify classes (mechanical, gate-verified implement); NEVER frame/review; re-heating on drift/new models/version bumps | § Lifecycle Stage 3 (user-confirmed; replaces fixed exploration budget) | durable | required | Selection-rule review; no exploration dispatches on frame/review | planned |
| A12 **Fixed execution-role set in Model Roster**: coder + verifier always; optionally beancounter/superego/workstream-expert; plus materialized `.omp/agents/` files only — never free-form labels; every role bound to explicit user-named model | builder prompt § Model Roster binding rule; user binding decision 2026-06-12 | durable | required | Roster contains only legal role labels; each fixed role carries explicit model + binding status | satisfied (fixed roster bound to `openai-codex/gpt-5.5`) |
| A13 **Bindings are user-confirmed only; rebinding is durable-law change**: suggestions ≠ bindings; non-answer = unbound; rebind requires explicit user decision citing fitness evidence when available | builder prompt critical rules; the model-binding step; the durable-law delta step; user binding decision 2026-06-12 | durable | required — fixed roster currently **user-confirmed** to `openai-codex/gpt-5.5`; future pool/model changes require S4 | Binding status per role traceable to explicit user confirmation; no silent rebinds (S4) | satisfied for first binding; unproven for future rebinding |
| A14 **No assignment text persisted in telemetry**: shape features only (versioned schema v:1) | § Telemetry spec "Unit of measurement"; § Needs Human Verification (privacy, U-11) | durable | required (flagged for human confirmation in ADR) | Telemetry schema review: no prompt/assignment text fields | planned |
| A15 **Project-scoped policy**: policy table, protocol, telemetry per project; global defaults beneath; project wins; telemetry records carry project key | § Protocol Hardening "Project-dependence" | durable | required | Schema + resolution-order review | planned |
| A16 **Expert system cannot invent facts, weaken criteria, or grant closure authority**; authority chain raw request → canonical sources → frame → expert system preserved | `workstream-subagents-v0.md` expert-system gate; builder critical rules | durable | required (meta-criterion spanning both chapters) | Superego expert-system review (source fidelity, criterion preservation) | unproven (draft reviewed; final persistence preserves source fidelity) |
| A17 **Three-stage lifecycle**: (1) bootstrap — strongest model builds expert system + seeds policy as versioned `bootstrap-v0` explicit guess; (2) measurement — categorical dispatch + acceptance-gate verdicts fill cells; (3) jitter→convergence. Seeding bootstrap-v0 is itself a durable-law change — surfaced explicitly and approved at the durable-law delta, not slipped in as build mechanics | § Lifecycle & Convergence Model (user-confirmed); round-1 advisory 4; user delta approval 2026-06-12; user roster binding 2026-06-12 | durable | required — bootstrap-v0 seeding is delta-approved; fixed roster now user-bound and materialized, but seeding still follows persistence/commit gates | Expert system encodes the stages (done — this row + Definitions); bootstrap policy explicitly versioned; execution waits for persistence/commit gates | planned (delta-approved and roster-bound 2026-06-12) |
| A18 **Interactive routing gated**: interactive-session model selection stays manual until dispatch-level routing proves out; any task touching interactive-session routing without prior explicit user re-scoping is BLOCKED, not merely out of scope | § Guardrails "Interactive scope gated"; round-1 advisory 3 | durable | deferred with authority (user decision in source) | No interactive routing work without explicit re-scoping; violation = BLOCK (S19) | deferred |

### Chapter B — Implementation Law (citation-first: cited source holds authoritative detail)
U-N1 resolved-law applicability: full Chapter B binds all TS packages unless a row self-scopes; B6/B7 are coding-agent-only; `crates/pi-natives` follows its cargo toolchain plus B13–B16 and B18–B22; package-level exceptions require S5. U-N2 resolved-law jurisdiction: `.omp/rules/` wins mechanically within trigger scope, this expert system governs process/delegation/verification/closure, and AGENTS.md governs implementation detail to which Chapter B defers.

| Criterion | Source / provenance | Scope | Required handling | Evidence required | Current status |
|---|---|---|---|---|---|
| B1 **ADR-driven architecture**: architecture changes get an ADR in `docs/adr/`, existing numbered format. "Before implementation" is **inferred** (from AGENTS.md "ADR-driven decisions" + the anti-pattern stop trigger), not quoted text (advisory 2) | `AGENTS.md` § Patterns to Follow; `docs/adr/0001`–`0006` (format precedent; statuses per source inventory) | durable | required | Architectural diffs trace to an accepted ADR; new ADRs follow the numbered format; architecture change without ADR → stop (S15) | unproven |
| B2 **Protocol compatibility is hard law**: event names, lifecycle semantics, completion signaling, RPC/SSE contract preserved; no breakage without explicit migration plan | `AGENTS.md` § Key Constraints; ADR 0001 (Accepted), ADR 0002 (Accepted) | durable | required | Diff review: no event/lifecycle/completion renames; breakage proposal carries a migration plan or stops (S2) | unproven |
| B3 **Narrow, additive patch scope**; deep edits across many core files trigger ADR 0001 re-evaluation | `AGENTS.md` § Key Constraints, § Anti-Patterns "Expanding patch scope"; ADR 0001 (Accepted) | durable | required | Diff blast-radius review; multi-core-file deep edits → stop and re-evaluate (S16) | unproven |
| B4 **Single active context manager**; dual activation must fail closed | `AGENTS.md` § Patterns, § Anti-Patterns "Running dual context managers"; ADR 0003 (Accepted, iterative) | durable | required | Config-matrix review/test: dual activation fails closed (S17) | unproven |
| B5 **Locator-first; bridge ≠ assembler**: locators not payloads in memory tiers; bridge/assembler responsibilities never merged | `AGENTS.md` § Patterns, § Anti-Patterns "Payload retention", "Conflating bridge and assembler"; ADR 0003 (Accepted, iterative) / ADR 0004 (Proposed) | durable | required | Memory-tier diff review: no full tool outputs persisted; module-responsibility review at the bridge/assembler seam | unproven |
| B6 **Logging**: never `console.log`/`console.error`/`console.warn` in `packages/coding-agent`; use `logger` | `AGENTS.md` § Logging | durable (coding-agent-only; U-N1 resolved 2026-06-12) | required | Grep diff for `console.(log\|error\|warn)` in coding-agent paths | unproven |
| B7 **TUI sanitization**: every rendered text path through the established sanitization helpers; multi-path streaming previews updated together | `AGENTS.md` § TUI Rendering Sanitization (incl. streaming-previews subsection) | durable (coding-agent-only; U-N1 resolved 2026-06-12) | required | Rendered-text diff review with explicit error-path and rebuilt-transcript-path checks | unproven |
| B8 **Type discipline**: no `any` unless necessary; no accessibility keywords outside ctor params; never `ReturnType<>`; never inline/dynamic type imports; barrel-file and external-type rules per source | `AGENTS.md` § Code Quality | durable | required | Review/ast-grep on diff: `any`, accessibility keywords, `ReturnType<`, `import(` in type position; `bun check` clean | unproven |
| B9 **Prompts never in code**: prompt text lives in static `.md` files; Handlebars for dynamics; Bun text import | `AGENTS.md` § Code Quality | durable | required | Diff review: new prompt-like strings in `.ts` → stop (S14) | unproven |
| B10 **`Promise.withResolvers()`** over manual promise construction | `AGENTS.md` § Code Quality | durable | required | Grep diff for `new Promise(` outside protocol-required cases | unproven |
| B11 **Bun over Node**: Bun APIs per the source's table; never spawn shell for operations with proper APIs; namespace imports for node builtins | `AGENTS.md` § Bun Over Node (table + Anti-Patterns) | durable | required | Diff review against the source table; grep for named fs/path imports, trivial `spawnSync` | unproven |
| B12 **Async I/O discipline**: no sync calls or exists-before-read in async flows; patterns per source | `AGENTS.md` § File I/O + Anti-Patterns + Streams | durable | required | Grep/review on diff for sync calls and exists-before-read in async paths | unproven |
| B13 **Check commands**: `bun check` family only; never `tsc`/`npx tsc`; never `bun run dev`/`bun test` without user instruction | `AGENTS.md` § Commands | durable | required | Session command audit (S18) | unproven |
| B14 **Never commit unless the user asks** — the in-principle "EXPERT-SYSTEM.md is committed to git" decision does not waive per-invocation commit authorization | `AGENTS.md` § Commands | durable | required | Session audit: every commit traces to explicit user instruction (S12) | unproven |
| B15 **Git remotes**: all work targets `origin`; never push to `upstream` | `AGENTS.md` § Git Remotes; § Releasing | durable | required | Session audit + reflog; any upstream push attempt = absolute stop (S13) | unproven |
| B16 **Testing law**: one nameable, externally observable contract per test; full enumerated rules in source (incl. never `mock.module()`) | `AGENTS.md` § Testing Guidance | durable | required | Test-diff review against the source's enumerated rules; named contract per new test | unproven |
| B17 **`hookFetch` in tests**: never assign/spy `globalThis.fetch`; use `hookFetch` from `@oh-my-pi/pi-utils` with `using` disposal | `.omp/rules/ts-hook-fetch.md` (durable, mechanically enforced) | durable | required | Rule engine fires on matching test edits; grep diff for forbidden patterns | unproven |
| B18 **Changelog law**: per-package `CHANGELOG.md`, `## [Unreleased]` placement, immutable released sections, attribution formats per source | `AGENTS.md` § Changelog; `packages/coding-agent/CHANGELOG.md` (precedent) | durable | required | Changelog diff review: placement, immutability, attribution format | unproven |
| B19 **GitHub conventions**: read ALL comments before acting; labels/title conventions; closure-via-commit semantics; fork-vs-upstream issue placement per source | `AGENTS.md` § GitHub Issues; § Patterns "Fork issues" | durable | required | Session evidence of full-comment reads; issue/PR placement review | unproven |
| B20 **Style**: short, concise, no emojis, no filler in commits/issues/PRs/code | `AGENTS.md` § Style | durable | required | Artifact review of authored commit/issue/PR text | unproven |
| B21 **Release law**: releases follow `.oh/skills/oh-ship/SKILL.md`; fork versioning and sync procedure per source | `AGENTS.md` § Releasing; `.oh/skills/oh-ship/SKILL.md` | durable (release tasks only) | required | Release-task review against the SKILL.md checklist | unproven |
| B22 **Conservation of intent**: never remove/downgrade code to silence type errors from outdated deps; ask before removing apparently intentional functionality | `AGENTS.md` § Code Quality | durable | required | Diff review: removals trace to explicit user approval or stated dead-code evidence | unproven |

## Invariants / Guardrails

All rules durable unless marked task-specific. Sources in brackets.

### MUST
- ALL implement- and mechanical-class work dispatches to bound coder-tier roles; the orchestrator only frames, architects, and reviews. [A6; `.oh/model-routing.md` § Protocol Hardening; durable]
- An approved ADR exists in `docs/adr/` before any routing implementation; architecture changes generally trace to an ADR ("before implementation" inferred — advisory 2). [A1, B1; durable]
- Routing changes are additive and protocol-compatible; explicit settings always win; policy `undefined` → untouched inheritance. [A2, A3; durable]
- Every routed dispatch surfaces resolved model + resolution source. [A4; durable]
- Telemetry persists shape features only (versioned schema), per-project keyed. [A14, A15; durable]
- Gradation weights outcomes by the trust hierarchy; calibrated (post-dissent) claim strength is preserved. [A8, A10; durable]
- Observe-only phase and label audit precede any routing authority. [A9; durable]
- The Model Roster uses only the fixed role labels + materialized `.omp/agents/` files; every binding is user-confirmed. [A12, A13; durable]
- All diffs pass the Chapter B gates relevant to the touched surface, with the cited files as authoritative detail. [B1–B22; durable]
- `bun check` family used for type checks; commits, pushes, and test runs follow B13–B15. [durable]
- Durable-law changes (including AGENTS.md-sourced ones, conservatively, until U-N6 is decided) go through the delta protocol: delta presentation + user approval + superego review. [S5, U-N6; durable]
- This artifact is final-persisted through the documented checkpoint sequence; commit remains gated by explicit user instruction despite the approved delta and roster-bound config materialization. [task-specific]

### MUST NOT
- The orchestrator must not perform implement/mechanical work in-session on any oh-omp task. [A6; durable]
- Never code routing before its ADR; never break session lifecycle/events/completion signaling. [A1, A2, B2; durable]
- Never let policy beat explicit user/agent settings. [A3; durable]
- Never change taxonomy automatically; never hardcode class semantics or tier opinions in engine code. [A5; durable]
- Never optimize for max-quality in selection (satisficing only); never run exploration/jitter on frame/review classes. [A7, A11; durable]
- Never move a grade on uncorroborated orchestrator disposition. [A8; durable]
- Never persist assignment text in telemetry. [A14; durable]
- Never invent model availability, bind silently, or treat a suggestion/non-answer as a binding. [A13, builder prompt; durable]
- Never invent facts, weaken canonical criteria, or grant closure authority via this expert system. [A16; durable]
- Never fork AGENTS.md/.omp-rules/ADR detail verbatim into this artifact (citation-first; shadow-copy containment). [frame core tension, advisory 4; durable]
- Never use `console.*` in coding-agent, prompts in code, `ReturnType<>`, `mock.module()`, `globalThis.fetch` assignment in tests, sync I/O in async flows, or the other Chapter B forbidden patterns — per the cited sources. [B6–B12, B16, B17; durable]
- Never commit without explicit user instruction; never push to upstream. [B14, B15; durable]
- Never resolve U-N6, U-6, or U-10 by builder/coder judgment; U-N1/U-N2/U-N4/U-N5 are user-resolved law and must be applied as recorded. [frame + user delta 2026-06-12; durable]

### BLOCK IF
- S1: Precedence-chain violation proposed → stop and redesign. [carried]
- S2: Protocol/lifecycle/event/completion breakage required → stop (= B2). [carried]
- S3: Taxonomy change → manual human decision only. [carried]
- S4: Model rebinding or first binding → explicit user decision; non-answer = unbound. [carried]
- S5: Durable-law change → delta + user approval + superego review; includes AGENTS.md-sourced law changes until U-N6 is decided; TRUE cross-surface conflict under U-N2 is law drift → S5 stop routed to the user. [carried, extended, U-N2/U-N6]
- S6: Engine change needed for a policy tweak → layering broken, stop. [carried]
- S7: Routing implementation before approved ADR → stop (= A1). [carried]
- S8: Silent degradation discovered → stop. [carried]
- S9: Observe-only audit shows wildly inconsistent effort labels → no authority transfer. [carried]
- S10: Task tool schema additions break protocol clients → frame invalidated for that work. [carried]
- S11: Superego BLOCK on a build/persistence step → no persistence without explicit user authorization; canonical source unreadable → block. [carried]
- S12: Any commit without explicit user instruction → stop; includes this artifact. [AGENTS.md § Commands]
- S13: Any push to `upstream` → absolute stop; remotes verified before push. [AGENTS.md § Git Remotes]
- S14: Prompt text being authored in code → stop. [AGENTS.md § Code Quality]
- S15: Architectural change without an ADR in `docs/adr/` → stop. [AGENTS.md § Patterns to Follow]
- S16: Change requiring deep edits across many core files → ADR 0001 re-evaluation trigger, stop. [AGENTS.md § Anti-Patterns; ADR 0001]
- S17: Configuration would activate dual context managers → fail closed, stop. [AGENTS.md § Anti-Patterns; ADR 0003]
- S18: `bun run dev`/`bun test` (or `tsc`/`npx tsc`) about to run without user instruction → stop. [AGENTS.md § Commands]
- S19: Interactive-session routing work requested without explicit user re-scoping → BLOCK. [A18 + advisory 3]

## Authorized Solution Space

**Allowed seams:**
- Additive routing module (planned `src/routing/`: types, policy, JSONL telemetry, gradation) — AFTER its ADR (A1).
- Dual-mode dispatch params (`effort:`/`model:`) on the task tool — additive, optional, ADR-gated.
- `.omp/agents/` materialization of project roles; `task.agentModelOverrides` keys.
- `.oh/` decision artifacts and workstream files (this directory).
- `docs/adr/` authoring (the routing ADR and future ADRs).
- Thin call-site consults at the dispatch/model-resolution seams (`task/index.ts`, `task/executor.ts`, `task/agents.ts`, `config/model-resolver.ts`) per the additive design.
- All normal development across the repo's activated surface, under Chapter B.

**Forbidden seams:**
- Hot-path deep edits (e.g. `session/agent-session.ts`) without ADR 0001 re-evaluation (S16).
- The upstream remote (read-only sync source — B15/S13).
- Interactive-session routing (A18/S19 — BLOCK without explicit re-scoping).
- Prompt text in code (B9/S14).
- Pipeline prompts, `AGENTS.md`, `.omp/rules/`, `.oh/model-routing.md` — not modifiable under builder-only invocations; modifiable later only via the applicable update protocol (S5 for law-bearing surfaces).
- Other repositories (pattern export not authorized).

**Required abstraction boundary:**
Project-law altitude: this system is the top of repo law (with AGENTS.md as its cited substrate) and sits above every task execution. Too local: per-task rules, ADR text itself, individual binding choices. Too broad: multi-repo governance, the subagents pipeline's internal contracts, upstream conventions. Correct seam: durable law for how ALL oh-omp work is decided, dispatched, implemented, verified, measured, and amended.

**Deferred alternatives:**
- Option C (unified resolution pipeline) — deferred as ADR aspiration only; authority: `.oh/model-routing.md` § Solution Space, user-confirmed.
- Option D (provider-layer routing) — **eliminated on the rationale recorded in `.oh/model-routing.md` § Solution Space** (provider layer cannot see task class; telemetry starves). Advisory-2 phrasing carried: elimination-by-recorded-rationale, re-openable only by an explicit user decision that revisits that rationale, never silently.
- Failover-chain composition — deferred trade-off (carried).
- E-alone (prompt-protocol only) — rejected (compliance ≠ enforcement) but E retained within the selected B+E.
- Per-repo export of the expert-system pattern — deferred until user authorizes.

## Implementation Rules for Coder

**Coder may:**
- Work under a dispatched assignment that names this expert system's rules, within the allowed seams above.
- Author ADRs, `.oh/` artifacts, changelogs, and tests as the assignment directs.
- Propose (never apply) durable-law deltas and rebinding suggestions discovered during work.

**Coder must:**
- Operate as a dispatched coder-tier role under the categorical dispatch protocol (A6): assignments arrive from the orchestrator, never self-originated scope.
- Read the relevant Chapter B cited sources for any surface touched (AGENTS.md sections, `.omp/rules/ts-hook-fetch.md`, accepted ADRs) — the citations, not this artifact's summaries, are the authoritative detail.
- Pass the Chapter B gates relevant to the diff; run `bun check` for type-bearing changes.
- Keep routing work additive and behind the precedence chain (A2, A3); surface resolution visibly (A4).
- Record friction per the Friction/Learning hooks.

**Coder must not:**
- Implement anything routing-related before the approved ADR (A1/S7).
- Touch forbidden seams; commit (S12) or push (S13) without explicit user instruction; run gated commands (S18).
- Resolve open items (U-N6, U-6, U-10) by local judgment; re-open or reinterpret U-N1/U-N2/U-N4/U-N5 instead of applying the user-resolved law.
- Weaken, re-derive, or restate-as-stronger any dissent-calibrated claim (A10).

**Coder must stop if:**
- Any S1–S19 trigger fires.
- The assignment conflicts with this expert system, the frame, or a cited source (frame delta / source contradiction).
- The work demands scope expansion beyond the assignment's named files/seams.
- Verification cannot reach the evidence strength this system requires for the claim being made.
- Worktree/branch/PR or closure expectations are uncertain.
- The work's cognitive-content class remains ambiguous after applying U-N5's boundary test (RECORD decisions being made = frame; RESTATE decisions already made = mechanical): stop and route to the orchestrator/user rather than self-classify.

## Verification Rules

**Required checks:**
- `bun check` (or `check:ts`/`check:rs`) — proves type/compile integrity only (B8, B13). Never `tsc` directly.
- Grep/ast-grep on the diff per the B-criteria verifier column: `console.(log|error|warn)` (B6), `any`/accessibility keywords/`ReturnType<`/type-position `import(` (B8), prompt-like strings in `.ts` (B9), `new Promise(` (B10), named node-builtin imports and trivial `spawnSync` (B11), sync-in-async and exists-before-read (B12), `globalThis.fetch` assignment/spy in tests (B17).
- Diff reviews: protocol/event/lifecycle names (A2/B2), blast radius (B3/S16), context-manager activation (B4/S17), memory-tier payloads and bridge/assembler seam (B5), TUI sanitization paths (B7), test contracts (B16), changelog placement (B18), authored-text style (B20), removal intent (B22).
- Session audits: orchestrator never-codes (A6), command discipline (B13/S18), commit/push authorization (B14/B15, S12/S13), and per-session session-policy↔AGENTS.md drift check by the orchestrator (U-N3; divergence routes through S5).
- Routing-era checks (once ADR exists): precedence test cases per level (A3), regression that param-less dispatch behaves as today (A2), telemetry schema review (A14/A15), rollout sequencing evidence (A9), selection-rule review (A7/A11).

**Evidence strength required by claim:**
- "Governance artifact is faithful to sources": static review against primary artifacts (this document's own standard; superego review).
- "Dispatch/precedence behaves correctly": focused seam tests per precedence level + session-log integration evidence.
- "Existing dispatches unaffected": regression evidence (param-less dispatch behaves as today), not assertion.
- "Routing visible / not silent": direct session-log/UI evidence per routed dispatch.
- "Code-quality gate passed": grep/ast-grep on the actual diff + `bun check`, not reviewer impression.
- "Telemetry privacy": schema review (no text fields) + human confirmation flagged in the ADR (U-11).
- "Test defends its contract": named contract + real failure path demonstrated.

**Does not count as proof:**
- Uncorroborated orchestrator disposition — it never moves a grade and never substitutes for mechanical or independent verdicts (A8).
- Passing compile / `bun check` green as a claim of behavioral correctness.
- **Sampled claims generalized**: verifying one instance and asserting the class (the round-2 friction lesson — one sampled ADR header does not make "six accepted ADRs"; per-item status must be checked per item).
- A title, summary, prior memory, or narrower substitute frame standing in for canonical acceptance criteria.
- "The rule engine would have caught it" without the rule actually firing or the pattern actually grepped.
- Suggested defaults or non-answers treated as binding consent (A13).

**Verifier must return NEEDS_HUMAN if:**
- U-N6 (AGENTS.md amendment interplay) is in play; bootstrap-v0 seed execution is requested before persistence/commit gates are satisfied; or a proposed change would re-open/contradict resolved-law U-N1/U-N2/U-N4/U-N5.
- A future binding decision is requested or implied (rebinding, pool changes, first binding for newly materialized project agents) — A13/S4.
- Closure language is proposed for any artifact (closure must be earned per Delivery/Closure Rules; the verifier cannot grant it).
- A one-way decision flagged Needs Human Verification surfaces: precedence position of dispatch `model:` (U-6), `model:` param audience (U-10), telemetry privacy (U-11).
- Bootstrap-v0 policy seeding is about to be executed before the remaining persistence/commit gates are satisfied (A17 — delta-approved, roster-bound, and structural-only until final persistence).
- Any S1–S19 condition is met or a canonical source contradicts the assignment.

## Model Roster

**Binding rule:** the execution-role set is **fixed by the pipeline** — `coder` and `verifier` always; optionally `beancounter`, `superego`, `workstream-expert`; plus project agents materialized under `.omp/agents/` (a new role exists only as a materialized agent file, never as free-form text in this table). Each role is bound to an explicit, user-named model. A suggestion is not a binding until the user confirms or renames it. Never invent pool availability, never invent role labels. User decision 2026-06-12: after Fable unavailability, bind every fixed role to exactly `openai-codex/gpt-5.5` (no suffix).

| Role | Model (explicit) | Suggested/default + rationale | Binding status | Rebind triggers |
|---|---|---|---|---|
| coder | `openai-codex/gpt-5.5` | User selected the same model for all roles after Fable unavailability; bootstrap guess/no telemetry yet. | user-confirmed | escalation rate, fitness evidence, model deprecation |
| verifier | `openai-codex/gpt-5.5` | User selected the same model for all roles after Fable unavailability; bootstrap guess/no telemetry yet. | user-confirmed | same |
| beancounter (optional) | `openai-codex/gpt-5.5` | User selected the same model for all roles after Fable unavailability; bootstrap guess/no telemetry yet. | user-confirmed | same |
| superego (optional) | `openai-codex/gpt-5.5` | User selected the same model for all roles after Fable unavailability; bootstrap guess/no telemetry yet. | user-confirmed | same |
| workstream-expert (optional) | `openai-codex/gpt-5.5` | User selected the same model for all roles after Fable unavailability; bootstrap guess/no telemetry yet. | user-confirmed | same |
| materialized project agents (`.omp/agents/<name>.md`) | none materialized yet | n/a — no project-agent rows exist yet. | n/a — rows added only when agent files exist | same |

**Materialization:**
Bindings are materialized through `/Users/drazen/.oh-omp/agent/config.yml` `task.agentModelOverrides` keys for discovered built-in agents. No `.omp/agents/` files are materialized yet; future project-agent frontmatter is added only when those files exist.

**Fitness evidence:**
`bootstrap guess — no telemetry yet; user-confirmed unified binding to openai-codex/gpt-5.5`. Tier guesses in `.oh/model-routing.md` are admitted priors only and remain subject to future fitness evidence.

**Rebinding authority:**
Model bindings are durable workstream law (A13). Changes follow Expert-System Update Rules: explicit user decision required; non-answer = unbound; cite fitness evidence (telemetry/gradation, escalation history) when available; no silent rebinds (S4).

## Delivery / Closure Rules

**PR required:** no — for this artifact and `.oh/` governance artifacts generally (frame Delivery contract). Future implementation tasks define their PR contract per-task under B19/B20; this system sets no PR default for them beyond Chapter B.

**Target branch:**
Current working branch for `.oh/` artifacts; no PR flow for this artifact. Implementation tasks: per-task contract, always `origin` (B15).

**Allowed PR language:**
Non-closing refs only, by default (`Refs`, `Partially addresses`). `Closes`/`Fixes`/`Resolves` permitted only when earned: original request satisfaction target `full` AND every canonical criterion satisfied or explicitly accepted by the authorized owner (frame closure semantics; B19's `fixes #N` is the mechanism for earned closure, never a default).

**Required PR body disclosures:**
Summary of change; evidence per the Verification Rules (named checks actually run); residual risk; per-criterion status for the canonical criteria the task touches; any deferred items with their authority.

**Human approval required before closure if:**
Any canonical criterion is unsatisfied, deferred, or unknown; any delta-agenda item is implicated; any verifier NEEDS_HUMAN condition fired; or the commit/push itself is not yet explicitly authorized (B14/B15).

## Expert-System Update Rules

**Requires Superego review:**
- Any durable-law change: workstream identity/boundary, canonical-source interpretation, acceptance authority, invariants (MUST/MUST NOT/BLOCK IF), verification standards, delivery/closure rules, criteria additions/removals/weakening (S5).
- Conservatively, AGENTS.md-driven law changes flow through the same S5 delta protocol until the user resolves U-N6 (AGENTS.md amendment interplay) — interim rule, explicitly conservative, not a resolution of U-N6.
- Restating any dissent-calibrated claim (A10) — superego checks claim strength is not restored to pre-dissent levels.

**Requires user/maintainer decision:**
- Model bindings and rebinding (A13/S4); roster role additions via `.omp/agents/` materialization.
- Open or future user decisions: U-N6 AGENTS.md interplay, future model rebinding (A13/S4), taxonomy changes (A5/S3), and one-way ADR decisions. Delta-approved execution still gated: bootstrap-v0 policy seeding (A17 — roster-bound and materialized, but execution follows persistence/commit gates). Resolved-law carried by this draft: U-N1 Chapter B applicability, U-N2 rule-source jurisdiction, U-N4 superseded-frame move, U-N5 cognitive-content classification; changes to those require S5.
- Taxonomy changes — manual only, always (A5/S3).
- Re-opening Option D (only by explicitly revisiting its recorded rationale), promoting Option C from aspiration, un-gating interactive routing (A18 re-scoping).
- One-way ADR decisions: precedence position (U-6), `model:` audience (U-10), telemetry privacy (U-11).

**Archive / split conditions:**
- Split: if a sub-domain develops law that conflicts with or substantially exceeds project-wide governance (e.g. the routing engine post-ADR accumulating engine-internal law), spin it into its own workstream expert system rather than bloating this one; the workstream-subagents pipeline's internal law is already a separate adjacent workstream and must stay out.
- Archive: only by explicit user decision (e.g. pattern superseded by a successor governance mechanism); never silently.

## Friction / Learning Hooks

**Record friction if:**
- A builder/coder is tempted to copy AGENTS.md detail instead of citing it (citation-first deference under pressure — frame learning item b).
- The frame-checkpoint or delta-checkpoint catches a scope misread (evidence for checkpoint value — frame learning item c; this happened once already: the model-routing → oh-omp rescope).
- The binding step produces suggestion/binding confusion or non-answer ambiguity.
- Cognitive-content boundary labeling of a real task is ambiguous after U-N5's RECORD-vs-RESTATE test (feeds the observe-only label audit, A9).
- Any protocol friction during Lifecycle Stage 1 dogfooding — note as proto-telemetry (routing-ledger notes until `telemetry.ts` exists).

**Candidate reusable guardrails:**
- **Sampled-claim generalization** (round-2 friction): never report a per-item property (e.g. ADR Status) as a class property from a sample of one; verify per item or scope the claim to the sample. Reusable beyond this workstream.
- **Fork/upstream slug ambiguity** (round-2 friction): AGENTS.md references `open-horizon-labs/oh-omp` in both fork and upstream roles across sections; issue/PR placement rules (B19) should name remotes/slugs unambiguously. Candidate AGENTS.md clarification — routed through S5/U-N6, not edited by builders.
- **Paraphrase-density rule** (round-2 friction candidate): in compiled law, the denser the paraphrase of a living source, the higher the shadow-copy drift risk — prefer criterion + citation + verifier check (the advisory-4 row shape) as the default compilation format for living-source law. Reusable for any expert system citing living documents.
- **Widen-never-dilute rescoping** (frame learning item a): chaptering existing reviewed law instead of rewriting it preserved review value across a scope change — reusable rescoping method.
