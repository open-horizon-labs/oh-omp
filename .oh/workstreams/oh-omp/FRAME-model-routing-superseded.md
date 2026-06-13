# OH Workstream Frame — model-routing (builder invocation, 2026-06-12)

> Produced by `beancounter` under `/workstream-expert`; user-confirmed seed: the full model-routing workstream from `.oh/model-routing.md` (routing engine + telemetry + delegation protocol + model roster, oh-omp as project zero). User-confirmed persistence: `.oh/workstreams/model-routing/EXPERT-SYSTEM.md`. Status: awaiting Superego OH Frame Review.

## OH Workstream Frame

### Aim

**Raw request interpretation:**
Produce the governing frame for creating a durable Workstream Expert System for the **model-routing** conceptual workstream in oh-omp. The user (via `/workstream-expert`, seed user-confirmed) wants the full system from `.oh/model-routing.md` governed as one workstream: routing engine + telemetry + delegation protocol + model roster, with oh-omp as project zero. This is a builder-only invocation: frame → superego review → expert-system build → persistence. No code, no implementation planning. Implied acceptance: the expert system must faithfully compile the FINAL user-confirmed decisions in the canonical record (fit objective, two-layer B+E, categorical dispatch, post-dissent calibrated claims), not superseded intermediate framings. Scope traps: (a) restoring stronger pre-dissent claims (auto-amendment as v1 default everywhere); (b) inventing model bindings the user has not named; (c) absorbing the adjacent workstream-subagents pipeline into this workstream's scope; (d) treating quota preservation as the objective (explicitly corrected to byproduct).

**Desired outcome (the workstream's Aim, from `.oh/model-routing.md` § Aim, final frame 2026-06-12T17:00Z):**
"Every unit of work runs on the model best fitted to it — the orchestrating model delegates instead of doing: framing, architecture, and review judgment stay with the orchestrator; hard implementation goes to coding tiers; mechanical and well-specified work goes to weaker models that are genuinely better suited to it. Right tool for the task — overkill is waste even when quota is plentiful; quota preservation falls out as a byproduct." Desired state: "The harness enforces fit-aware routing wherever a model resolves and nothing is explicitly pinned; a versioned protocol defines what good fit means and how it evolves. The policy improves semi-automatically from recorded outcomes." For THIS invocation: a durable expert system encoding that aim as workstream law.

**Canonical sources:**
All four read successfully, in full. Authority ranking:
1. `.oh/model-routing.md` — **primary decision record** (highest authority for content). Contains all user-confirmed decisions: Aim (final two-layer frame), Problem Space (fit objective, constraints table, assumptions), Solution Space (B+E selected, A absorbed as bootstrap, C/D rejected), Telemetry & Optimization Spec, Dissent (ADJUST), Protocol Hardening & Expert-System Integration, Lifecycle & Convergence Model (three-stage, user-confirmed). Supersession chain inside the file is explicit and must be honored: fit objective supersedes quota-centric framing (fact 87994794); two-layer mechanism/policy (fact 08a352bf) supersedes capability-only and protocol-only framings; Thompson-sampling jitter (Lifecycle § Stage 3, "ADR delta") supersedes the fixed ~10% exploration budget in the Telemetry spec; categorical never-codes (Protocol Hardening) supersedes the floor-as-threshold reading of the delegation floor — the floor now governs *which tier*, never *whether* to dispatch.
2. `packages/coding-agent/src/prompts/agents/workstream-expert.md` — **structural contract** (highest authority for artifact shape). Mandates the exact `# Workstream Expert System` structure including `## Model Roster` with the fixed role set, suggested-vs-binding distinction, and rebinding-as-durable-law rule.
3. `packages/coding-agent/src/prompts/commands/workstream-expert.md` — **process contract**: interactive flow, frame checkpoint, explicit binding step (step 10: suggestion is not a binding; non-answer = `unbound`, never consent), durable-law delta approval (step 13), Builder Packet format.
4. `docs/workstream-subagents-v0.md` — **role definitions and pipeline conventions**: beancounter/superego/workstream-expert/coder/verifier roles, canonical-source gate, closure gate, expert-system gate, friction-log requirement.

Detected tensions (none blocking): (a) `workstream-subagents-v0.md` lists "Model-routing UI" as out of scope for the pipeline — `.oh/model-routing.md` itself resolves this: routing was anticipated as adjacent-but-separate, and this workstream IS the separate thing; no conflict. (b) Label-system mismatch, definitional not contradictory: the routing taxonomy uses effort classes (frame/plan/review/implement/mechanical) while the Model Roster uses pipeline role labels (coder/verifier/…); the expert system must define the role↔class mapping (role agents are pre-classified dispatches per `.oh/model-routing.md` § Adjacent workstream) rather than treat them as competing taxonomies. (c) Telemetry spec's fixed exploration budget vs Lifecycle's Thompson sampling — internal supersession, Lifecycle wins (explicitly marked "ADR delta").

**Acceptance criteria map:**
Criteria the expert system MUST preserve as durable law. All `in scope` for the expert-system build unless noted. Verification = how a verifier would check compliance on future tasks under this expert system.

| # | Criterion | Source | Handling | Compliance verification |
|---|---|---|---|---|
| 1 | **ADR first**: engine hooks, policy schema, precedence, storage, learning authority documented in `docs/adr/` before any routing implementation | `.oh/model-routing.md` § Guardrails; § Dissent → ADR | in scope (BLOCK IF rule) | Approved ADR exists in `docs/adr/` before any `src/routing/` code lands; coder must stop if asked to implement without it |
| 2 | **Additive + protocol-compatible**: no session lifecycle/event/completion changes; dispatch params optional; storage additive; existing dispatches behave identically when params absent | § Guardrails; § Solution Space Execution Contract "Preserve" | in scope | Diff review: no protocol/event/name changes; regression — dispatch without new params behaves as today; breaking change needed → stop |
| 3 | **Precedence is sacred**: explicit user/agent settings always beat policy; chain = user settings > dispatch exact model > agent frontmatter > policy(effort) > inheritance; policy returns undefined → existing inheritance untouched | § Guardrails; § Architecture item 4; § Problem Space open Q4 | in scope (chain order flagged Needs Human Verification — one-way once in ADR) | Precedence test cases per level; session-log evidence that explicit settings win; violation → stop and redesign |
| 4 | **Visible degradation**: tier/routing changes emit observable status via existing surfaces (model_change/log), never silent | § Guardrails | in scope | Resolved model + resolution source visible in task UI/log for every routed dispatch |
| 5 | **Taxonomy changes manual only**; taxonomy semantics and tier opinions live in policy data/protocol doc, never hardcoded in engine (layer discipline) | § Guardrails; § Telemetry spec "Three optimized objects" | in scope | No class semantics in engine code; class split/merge requires explicit human decision; engine change needed for policy tweak → layering broken, stop |
| 6 | **Categorical never-codes rule**: the orchestrator never codes; ALL implement- and mechanical-class work dispatches to coder-tier models; the delegation floor governs which tier, never whether | § Protocol Hardening "Categorical dispatch rule (constraint, user-confirmed)" | in scope | Session audit: zero implement/mechanical work performed in-session by the orchestrator under this workstream; protocol active from observe-only phase onward |
| 7 | **Satisficing objective, not maximizing**: per class choose cheapest/fastest adequate; selection never optimizes max-quality | § Telemetry spec "Optimization objective"; § Lifecycle Stage 3 Guard | in scope | Policy/selection review + gradation reports show cheapest-adequate selection |
| 8 | **Telemetry trust hierarchy**: mechanical verdicts > escalation events > independent verdicts > orchestrator disposition; disposition never moves a grade without corroboration | § Telemetry spec "Outcome trust hierarchy"; Statistical integrity | in scope | Gradation logic weights by hierarchy; no grade change from uncorroborated disposition alone |
| 9 | **Observe-only precedes routing authority**: telemetry records while assignment is manual/static; phasing 0→3; observe-only doubles as labeling-consistency audit before authority transfer | § Mechanism (Outcome telemetry); § Telemetry spec "Phasing" + "Label noise" | in scope | Rollout sequencing evidence; observe-only writes records without altering resolution; no authority before label audit |
| 10 | **Evidence-not-statistics for sparse cells; auto-amendment volume-contingent** — EXCEPT coder × implement/mechanical cells (auto-amendment v1-viable there); sparse frame/plan/review cells evidence-only; ≥3-consecutive-approvals auto-apply specified but may never trigger | § Dissent ADJUST 1–5; § Protocol Hardening "Dissent update" | in scope — calibrated claims MUST NOT be restored to pre-dissent strength | Expert system states calibrated claims; gradation reports framed as evidence summaries outside coding cells |
| 11 | **Jitter scope**: Thompson sampling over per-(project × class) fitness posteriors, satisficing-constrained; only cheap-to-verify classes (mechanical, gate-verified implement); NEVER frame/review; re-heating on drift/new models/version bumps | § Lifecycle Stage 3 (user-confirmed; replaces fixed exploration budget) | in scope | Selection-rule review; no exploration dispatches on frame/review |
| 12 | **Fixed execution-role set in Model Roster**: coder + verifier always; optionally beancounter/superego/workstream-expert; plus materialized `.omp/agents/` files only — never free-form labels; every role bound to explicit user-named model | builder prompt § Model Roster binding rule | in scope | Roster contains only legal role labels; each row carries binding status |
| 13 | **Bindings are user-confirmed only; rebinding is durable-law change**: suggestions ≠ bindings; non-answer = unbound; rebind requires explicit user decision citing fitness evidence when available | builder prompt critical rules; command steps 10, 13 | in scope — roster currently **unbound** | Binding status per role traceable to explicit user confirmation; no silent rebinds |
| 14 | **No assignment text persisted in telemetry**: shape features only (versioned schema v:1) | § Telemetry spec "Unit of measurement"; § Needs Human Verification (privacy) | in scope (flagged for human confirmation in ADR) | Telemetry schema review: no prompt/assignment text fields |
| 15 | **Project-scoped policy**: policy table, protocol, telemetry per project; global defaults beneath; project wins; telemetry records carry project key | § Protocol Hardening "Project-dependence" | in scope | Schema + resolution-order review |
| 16 | **Expert system cannot invent facts, weaken criteria, or grant closure authority**; authority chain raw request → canonical sources → frame → expert system preserved | `workstream-subagents-v0.md` expert-system gate; builder critical rules | in scope (meta-criterion) | Superego expert-system review (source fidelity, criterion preservation) |
| 17 | **Three-stage lifecycle**: (1) bootstrap — strongest model builds expert system + seeds policy as versioned `bootstrap-v0` explicit guess; (2) measurement — categorical dispatch + acceptance-gate verdicts fill cells; (3) jitter→convergence | § Lifecycle & Convergence Model (user-confirmed) | in scope | Expert system encodes the stages; bootstrap policy explicitly versioned |
| 18 | **Interactive routing gated**: interactive-session model selection stays manual until dispatch-level routing proves out | § Guardrails "Interactive scope gated" | deferred with authority (user decision in source) | No interactive routing work without explicit re-scoping |

**Workstream type / activated conceptual systems:**
Type: **other** (harness capability + governance protocol; closest composites: API contract — the dispatch contract is a one-way public-ish surface — plus observability — telemetry — plus investigation — gradation). Activated systems: task dispatch (`task/index.ts`, `task/executor.ts`, `task/agents.ts`), model resolution (`config/model-resolver.ts`), settings storage, planned `src/routing/`, `docs/adr/`, `.oh/` decision artifacts, expert-system pipeline prompts. Context-only systems (inspectable, NOT modifiable under this workstream): `session/agent-session.ts` hot paths, `interactive-mode.ts` plan-mode switch, pi-ai rate-limit internals, `patch/index.ts` spark adaptation, smol utility internals (consult seams only).

**Existing Workstream Expert System:**
**None found — confirmed by inspection.** `.oh/workstreams/` did not exist (find: path-not-found) and no `EXPERT-SYSTEM.md` exists anywhere in the repo. This invocation **creates** a new durable expert system; no update-vs-create ambiguity remains.

**Conceptual workstream identity (proposed):**
- **Workstream ID:** `model-routing`
- **Inside the boundary:** the routing engine (planned `src/routing/`: types, policy, JSONL telemetry, gradation), dual-mode dispatch params (`effort`/`model`) on the task tool, the delegation protocol (categorical never-codes rule and effort-class taxonomy), the per-role model roster and its binding/rebinding law, telemetry-driven gradation (trust hierarchy, satisficing selection, Thompson jitter, three-stage lifecycle), dogfooding governance for oh-omp as project zero (static roster + manual protocol operating now, proto-telemetry via routing-ledger notes), and the routing ADR authoring.
- **Outside the boundary:** interactive-session model selection (manual, gated — criterion 18); unified resolution pipeline rewrite (Option C — rejected for v1, ADR aspiration only); provider-layer routing (Option D — rejected permanently); failover-chain composition (deferred trade-off); the workstream-subagents pipeline itself (adjacent workstream); model-routing UI.

**Current priority:** correctness of the compiled law — faithful compilation of final user-confirmed decisions into durable, enforceable workstream law, with zero invented decisions. Speed secondary.

**Original request satisfaction target:** bounded-v0 for this invocation (frame only). Satisfied only when the expert system is built, superego-reviewed, durable-law-delta approved, and persisted with the Builder Packet emitted and `Do not code: confirmed`.

### Problem Space

**Observed reality:**
Evidence (read directly): (1) `.oh/model-routing.md` is a complete, internally-supersessioned decision record ending in a user-confirmed three-stage lifecycle and a confirmed ADR target with adjusted claims. (2) The builder prompts already mandate `## Model Roster` with fixed roles and user-confirmed bindings — the first implemented step of this very workstream (concept-graph fact 6a594a54). (3) No expert system exists yet anywhere in the repo. (4) `.oh/` currently holds flat session files; the user confirmed `.oh/workstreams/<workstream-id>/EXPERT-SYSTEM.md` as the persistence convention. (5) Model assignment today is static/manual; subagents inherit the parent's model (`task/index.ts:513-517` per the record). Inference (marked): the four runtime precedents cited in the record were verified by the record's author, not re-verified in this framing pass.

**Core tension / why this is hard:**
The canonical record is a layered palimpsest: later sections supersede or recalibrate earlier ones (quota→fit; protocol-only→two-layer; fixed exploration budget→Thompson sampling; strong auto-amendment→volume-contingent except coding cells; floor-as-threshold→categorical dispatch). A naive compilation reading the file top-down would encode dead decisions as law. Simultaneously, the expert system is itself a component OF the system it governs (the routing protocol lives inside the expert system; its acceptance gates become telemetry ground truth) — so compilation errors don't just misgovern tasks, they corrupt the gradation dataset's ground truth.

**Specific need:**
A frame precise enough for the workstream-expert builder to compile final-state decisions into the mandated artifact structure — acceptance matrix, MUST/MUST NOT/BLOCK IF invariants, verification gates, an unbound Model Roster awaiting the binding step, and update rules — persisted at the user-confirmed path.

**Constraints:**
(1) Builder-only: no code, no PRs, no product edits. (2) ADR before routing implementation (hard, inherited as law). (3) Additive/protocol-compatible. (4) Artifact must match the structural contract incl. Model Roster with fixed roles. (5) Interactive checkpoints: frame checkpoint, binding step, durable-law delta — user confirmation at each. (6) No invented decisions.

**Failure modes:**
(a) Encoding superseded framings as law. (b) Restoring pre-dissent claim strength. (c) Inventing model bindings or treating suggested defaults as bindings. (d) Scope creep (subagents pipeline, interactive routing, unified-pipeline rewrite). (e) Over-narrowing (dropping the E-layer or dogfooding governance). (f) Promoting task-local mechanics into durable law without the delta-approval step.

### Solution Space

**Chosen approach:**
Create the `model-routing` durable Workstream Expert System at `.oh/workstreams/model-routing/EXPERT-SYSTEM.md`, compiled strictly from the final state of `.oh/model-routing.md` under the structural contract of `workstream-expert.md`, with the Model Roster present but **unbound** pending the explicit binding step, and the acceptance criteria map above as the matrix seed.

**Alternatives rejected / deferred:**
Update existing (n/a — none exists); defer until ADR (rejected: Lifecycle Stage 1 makes expert-system build the FIRST step; ADR gates implementation, not governance); one broad oh-omp expert system (rejected by user seed choice). Source's own rejections become law: Option C deferred as ADR aspiration; Option D rejected permanently; E-alone rejected but E retained within B+E.

**Abstraction boundary:**
The expert system sits below project-global law and above task execution. Too local: per-task rules for building `telemetry.ts` or the ADR text. Too broad: general oh-omp coding standards, the subagents pipeline's own law, interactive-session UX. Correct seam: durable law for *how model-routing work is decided, dispatched, measured, and amended* across all related tasks.

### Execution Contract

**In scope (this invocation):** this frame; superego review; the workstream-expert build; the binding step (defaults proposed, user confirms or `unbound`); durable-law delta presentation; persistence at confirmed path; Builder Packet.

**Out of scope / forbidden:** any product code; the ADR text; `src/routing/` work; modifying pipeline prompts; naming bindings without user confirmation; modifying `.oh/model-routing.md`; promoting task-local mechanics to durable law without approval; touching the adjacent subagents workstream's scope.

**Worktree / branch contract:** No worktree needed (builder-only, single new artifact under `.oh/`, no product code) — explicit justification per fresh-worktree default. Persistence on current working branch.

**Delivery / PR contract:** No PR. Delivery = persisted `EXPERT-SYSTEM.md` + Builder Packet with `Do not code: confirmed`. Risk acceptance authority: the user.

**Closure semantics:** Non-closing only. This invocation produces governance, not the requested system; nothing may claim `Closes`/`Fixes`/`Resolves` against the model-routing effort. The expert system must encode that rule for future tasks.

**Stop conditions (this invocation AND durable):**
1. Precedence-chain violation proposed → stop and redesign.
2. Protocol/lifecycle/event/completion breakage required → stop.
3. Taxonomy change → manual human decision only.
4. Model rebinding or first binding → explicit user decision; non-answer = unbound.
5. Durable-law change → delta + user approval + superego review.
6. Engine change needed for a policy tweak → layering broken, stop.
7. Routing implementation before approved ADR → stop.
8. Silent degradation discovered → stop.
9. Observe-only audit shows wildly inconsistent effort labels → no authority transfer.
10. Task tool schema additions break protocol clients → frame invalidated for that work.
11. This invocation: superego BLOCK → no persistence without explicit user authorization; canonical source unreadable → block.

### Verification / Learning

**Verification standard:** For this frame: superego review against canonical sources — every criterion traceable to a cited section; final state (not superseded) encoded; no invented decisions; roster unbound. Durably: the expert system's acceptance gates become telemetry ground truth — verification gates must be mechanical enough that verifier verdicts are usable fitness records.

**Material uncertainty (carried as open items, not law):**
1. Model pool ids unbound — user has named no models; roster shows `unbound: needs user decision` per role; tier guesses in the record are admitted priors, not bindings.
2. ADR number/slug unassigned.
3. Telemetry retention/rotation — open for ADR.
4. Thompson-sampling posterior representation + adequacy thresholds — open for ADR.
5. `retryOf` as dispatch param vs telemetry-side notation — open for ADR.
6. Exact dispatch-precedence position of dispatch-time `model:` — recommended (user settings win) but Needs Human Verification; one-way once in ADR.
7. Protocol packaging (sections vs companion rule file) — open for ADR.
8. Acceptance-gate verdict ingestion (parse vs structured output, preferred) — open for ADR.
9. Cross-project pooling rules — open for ADR.
10. `model:` param audience (orchestrator-only vs all agents) — Needs Human Verification.
11. Telemetry privacy confirmation (shape-only) — flagged.
12. Policy file location (`.oh/` vs project config) — carried to ADR.
13. Whether `.oh/workstreams/` artifacts are committed or local-only — no explicit convention recorded; surface at the frame checkpoint.

**Learning / friction capture:** (a) supersession-chain hazard — in-place-evolving decision records need final-state markers for safe compilation; (b) role↔class mapping cleanliness; (c) binding-step friction; (d) this invocation is Lifecycle Stage 1 dogfooding — note protocol friction as proto-telemetry.

### Raw Request Alignment

**Preserved:** the full user-confirmed seed (one workstream: engine + telemetry + protocol + roster + gradation + dogfooding, oh-omp project zero); user-confirmed path; all final-state decisions incl. dissent-calibrated claims and the categorical never-codes rule; unbound roster pending explicit binding.

**Contract narrowing / shaping:** this frame governs expert-system *creation*, not routing *implementation* — sequencing is canonical (Lifecycle Stage 1; ADR gates implementation). Superseded framings deliberately excluded from law — valid narrowing because the canonical record itself marks them superseded.

**Expanded:** none. Stop conditions and the criteria map are derivations from cited guardrails, not new scope.

**Acceptance authority:** user (Drazen) — frame checkpoint, model bindings, durable-law delta, persistence; superego holds ALLOW/REVISE/BLOCK review authority before persistence; closure authority for future tasks is encoded in the expert system, never granted by it.
