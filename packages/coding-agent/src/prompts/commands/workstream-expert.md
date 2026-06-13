---
description: Interactively build or update a durable Workstream Expert System without coding
---

Interactively build or update a durable Workstream Expert System for this raw workstream seed:

```text
$@
```

This command is builder-only. It **MUST NOT** implement code changes, open PRs, edit product code, or run task execution. Its purpose is to explicitly create or update the persistent expert system that future `/workstream` runs execute under.

## Core contract

A Workstream Expert System is durable per conceptual workstream, not per task. A project may have multiple Workstream Expert Systems. This command identifies the conceptual workstream, resolves existing expert systems, persists the Step 0 / OH Workstream Frame contract, and stops after Superego-reviewed persistence.

## Interactive rule

This command is explicitly interactive. Use `ask` when a material choice affects identity, source authority, persistence, overwrite/update behavior, or blocking scope. Since this command runs rarely, **err on the side of verbosity**: prefer surfacing a decision the user waves through over making it silently.

You **MUST** ask the user before proceeding when:

- multiple existing Workstream Expert Systems could apply,
- no persistence path/store is known,
- creating a new expert system may duplicate an existing conceptual workstream,
- canonical source artifacts are inaccessible,
- the user must authorize a bounded substitute frame,
- updating an existing expert system would materially change durable workstream law,
- the workstream boundary is ambiguous,
- closure/delivery authority cannot be derived from canonical sources.
- model bindings for the expert system's execution roles are missing, unconfirmed, or being changed — suggest pool defaults with rationale, but the user explicitly names/confirms each model.
- an existing Workstream Expert System was found and the user has not yet chosen between updating it, creating a separate one, or leaving it untouched,
- canonical sources conflict with each other or their authority ranking is unclear,
- a task-specific criterion or rule is being promoted into durable workstream law.

You **MUST NOT** ask for trivia that tools can determine. Inspect existing files, docs, and expert-system artifacts first. When in doubt whether a choice is material, ask — preferring one consolidated checkpoint with full context over many scattered micro-questions.

## Required checkpoints

This builder has four explicit checkpoints. Present Superego verdicts and user decisions; never silently absorb them.

1. **Frame Checkpoint:** confirm workstream identity/type/scope, canonical sources and authority, update-vs-create, persistence target, material inferences, and whether the expert system is project-wide or narrower. Workstream expert systems may be project-wide or narrower, but scope must be explicit. If the user corrects identity or scope after frame review, revise the OH Workstream Frame and re-run Superego before build; never silently stretch a narrower frame.
2. **Model Roster binding:** bind only fixed execution roles (`coder`, `verifier`, optional `beancounter`, `superego`, `workstream-expert`) plus materialized project agents. Suggestions are not bindings. Non-answer means unbound. Rebinding is durable law.
3. **Durable-law delta:** before persistence, explicitly present laws added/changed/removed, phase-handoff gate changes, model-roster changes, project-agent materialization, default terminal artifact, and ship/release semantics. Filesystem persistence at `.oh/workstreams/<workstream-id>/EXPERT-SYSTEM.md` does not by itself force a commit, but in an invoked workstream/ship flow logical commits and PR/MR delivery are normal reviewable mechanics unless the task explicitly says local-only/no-PR.
4. **Jurisdiction and cognitive-content classification:** capture rule-source jurisdiction (mechanical trigger rules vs. expert-system process/delegation/verification/closure vs. implementation-detail law), classify non-code work by cognitive content (judgment-bearing frame-class vs. transcription-bearing mechanical-class), and identify retired/external framework agents that must not be inherited by default.

## Required role order

1. Inspect the repo for existing Workstream Expert Systems. Preferred v0 filesystem locations include `.oh/workstreams/*/EXPERT-SYSTEM.md`, but also search for existing Kraken-style or project-specific expert-system artifacts if the seed implies one.
2. Invoke `beancounter` to produce the `## OH Workstream Frame` from the raw workstream seed. The frame must identify conceptual workstream identity, canonical sources, acceptance criteria, existing expert-system candidates, persistence needs, and stop conditions.
3. Ensure canonical source artifacts were read and acceptance criteria were mapped. If a required artifact is unavailable, route the source gap through Superego; distinguish blocking gaps (cannot select or safely verify a solution) from non-blocking gaps that only constrain confidence, closure language, and option scope. Do not ask for separate implementation authorization merely because a bounded substitute frame is needed.
4. Invoke `superego` to perform the Superego OH Frame Review. Present the verdict (`ALLOW` / `REVISE` / `BLOCK`) and its reasons to the user — never absorb a verdict silently.
5. If Superego returns `BLOCK`, ask the user only for the blocking material uncertainty.
6. If Superego returns `REVISE`, summarize each objection and the revision made in response, then revise the OH Workstream Frame before building/updating the expert system.
7. Present a consolidated **Frame Checkpoint** and ask the user to confirm or correct it before building: workstream identity and type, conceptual scope, canonical sources with authority levels, existing-expert-system decision (update vs. create new vs. leave untouched), persistence target, and any material inferences made without explicit sources. Proceed only on explicit confirmation — even when nothing appears ambiguous.
   - If the user corrects the workstream identity, type, or scope at this checkpoint, revise the OH Workstream Frame, re-run Superego, and present the revised verdict before invoking `workstream-expert`. Do not silently stretch a narrower frame to cover a broader project-wide system.
8. Ask the user to choose the target persistence/update path if it remains ambiguous after inspection. Recommend `.oh/workstreams/<workstream-id>/EXPERT-SYSTEM.md` for v0 when no project convention exists.
9. Invoke `workstream-expert` to build a new or update an existing durable `# Workstream Expert System` from the approved OH Workstream Frame, canonical sources, acceptance criteria map, existing expert system if any, persistence target, and Superego corrections.
   - The expert system should include a default `## OH Phase Mapping` unless a canonical source explicitly rejects OH flow. The default mapping treats phases as workflow states rather than agents: workstream invocation normally progresses through problem-space, solution-space, selected solution, execution, and delivery-to-review; `execute` is a composed fixed-role workflow (`beancounter → coder → verifier`, with Superego for durable law/architecture/protocol/high-risk/disputed-frame/human-owned authority gates), and `oh-execute` **MUST NOT** be materialized. `ship` means PR/MR-ready delivery: create/use branch, commit logical units, push to origin, open/prepare PR/MR, route fixes through the fixed execution chain, and stop before human-only merge. Project-agent labels are valid only when materialized as `.omp/agents/<name>.md` or a documented project equivalent; sibling/workspace agents are precedents, not direct law, unless ported with compatibility review.
   - Capture rule-source jurisdiction explicitly. Do not invent a total precedence order when jurisdictional split is sufficient: mechanically enforced rules govern their trigger scope, the expert system governs process/delegation/verification/closure, and project agent-law files govern implementation detail unless canonical sources define another order. True cross-source conflicts route through Superego/user decision as law drift.
   - Classify non-code work by cognitive content when the expert system defines delegation: judgment-bearing artifacts (ADR authoring, expert-system maintenance, decision records) are frame-class; transcription-bearing artifacts (changelogs, link fixes, restating already-decided content) are mechanical-class unless canonical sources say otherwise.
   - Do not inherit retired or external framework agents by default. GSD-style or sibling-workspace agents are not project law unless the current project/user explicitly adopts and materializes them.
10. Propose default model bindings for each execution role the expert system defines (at minimum coder and verifier) from the available model pool, with a one-line fitness rationale per suggestion, then ask the user to explicitly confirm or rename each binding. A suggested default is not a binding; treat a non-answer as `unbound`, never as consent. Record confirmed bindings in the expert system's `## Model Roster`; leave unconfirmed roles marked `unbound: needs user decision`.
11. Invoke `superego` to review the Workstream Expert System for source fidelity, criterion preservation, workstream identity, persistence scope, durable-vs-task-local separation, closure authority, verification gates, model-roster binding status, Superego Phase-Handoff Gate coverage, and spec-substitution resistance. Present the verdict and its reasons to the user.
   - Superego Phase-Handoff Gate requirement: every OH phase handoff that becomes authority for later phases SHOULD receive Superego review, and review is REQUIRED for durable law, architecture/ADR/protocol/RPC/SSE/lifecycle/completion/context-manager/model routing, model taxonomy/bindings/routing policy/project-agent materialization/role labels, unresolved material frame uncertainty carried forward, release/merge/destructive authority, closure language, PR/MR merge readiness, release side effects, scope/non-goal/risk/decision-authority/stop-pivot changes, and canonical-source/review conflict. Skip only for explicit low-risk mechanical reversible non-durable handoffs, with recorded rationale; skip rationale cannot satisfy required-review cases. Superego cannot merge, release, accept human-owned risk, or convert routine execution/ship toward PR/MR-ready output into a permission gate.
12. If Superego returns `BLOCK`, do not persist the update unless the user explicitly authorizes a revised bounded frame. If Superego returns `REVISE`, summarize each objection and the revision made, then re-review before persistence.
13. Before persisting, present the durable-law delta for explicit user approval: laws added/changed/removed, acceptance-criteria handling changes, model-roster changes, phase-handoff gate changes, project-agent materialization, and ship/release semantics when updating an existing system — or the material sections when creating a new one. Then persist the approved expert system at the agreed path/store using file tools when filesystem persistence is selected.
   - Ship and release must remain distinct in the durable-law delta. `ship` defaults to PR/MR-ready delivery-to-review against main/master or the project default branch: create/use branch, commit logical units, push to origin, open/prepare PR/MR, wait for review systems when available, route fixes through the fixed execution chain, and stop before human-only merge. Commit/branch/push/open-PR are normal reviewable delivery mechanics, not human-only gates, unless canonical project law explicitly says otherwise. Release is separate and workspace-specific; materialize it only by explicit decision under a workspace-specific name (for example `<workstream-or-project>-release`) generated from local release law, not copied from another workspace.
14. Stop this builder command after persisting the expert-system artifact. Do not invoke coder execution from the builder itself; the generated expert system should route future workstreams through execution and PR/MR delivery by default unless true gates fire.

## Persistence output

The final response must include:

```markdown
## Workstream Expert Builder Packet

**Rule-source jurisdiction:**
[mechanical trigger rules | expert-system process/delegation/verification/closure | implementation-detail law | conflict route]

**Non-code work classification:**
[judgment-bearing frame-class | transcription-bearing mechanical-class | project-specific exceptions]

**Retired/external framework agents considered:**
[none | listed and excluded | explicitly adopted/materialized]

**Builder-only:** yes

**Workstream ID:**

**Conceptual workstream:**

**Existing expert system reused:** yes | no | none found

**Artifact path / store:**

**Created or updated:** created | updated | blocked

**Canonical sources read:**

**Acceptance criteria mapped:** yes | no | partial

**OH Workstream Frame status:** allowed | revised | blocked

**Superego expert-system review:** allowed | revised | blocked

**Step 0 contract persisted:** yes | no | blocked

**Model roster:** bound | partially bound | unbound

**Model bindings:**
[role → model, binding status per role]

**Durable laws added/changed:**

**OH Phase Mapping:**
[present | omitted because canonical source rejects OH flow | blocked; include execute/ship/release semantics]

**Superego Phase-Handoff Gate:**
[required reviews, optional skips with rationale, unresolved objections, and phase-handoff audits status]

**Materialized project agents:**
[`.omp/agents/<name>.md` or documented project equivalent; none; blocked; note invalid free-form labels not bound]

**Default terminal artifact:**
[PR/MR-ready change | local-only/no-PR by explicit contract | plan-only by explicit contract | blocked]

**Ship / release semantics:**
[ship PR/MR-ready delivery-to-review: branch/commit/push/open-PR/review-fix loop/human-only merge; release separate as workspace-specific flow/agent if explicitly materialized]

**Task-specific deltas recorded but not promoted:**

**Human decisions made:**

**Checkpoints confirmed by user:** frame checkpoint | durable-law delta | model roster | none

**Human decision still needed:** none | choose workstream boundary | approve durable-law update | bind model roster | merge | release/tag/publish | destructive side effect | unresolved material decision | other

**Builder command does not code:** confirmed

**Next suggested command:**
[Usually `/workstream <task>` once the expert system is approved.]
```

## Friction log

Include a brief friction log if anything blocked, required clarification, or should become native behavior.
