# Workstream Subagents v0

## Purpose

Build a small, dogfoodable v0 of an OH-native Agneto/Superego loop inside `oh-omp`.

This v0 should make dedicated subagents operate over a shared **OH Workstream Frame** and always emit a friction log artifact.

The goal is **not** to build the final harness-native governance system yet. The goal is to create a real workflow we can run on real tasks, inspect together, and use to discover where the loop creates value or friction.

## Background / problem statement

Long-running LLM workstreams can drift in ways that remain plausible:

- a bounded task becomes an ecosystem-wide refactor,
- adjacent project context silently becomes modification scope,
- verification becomes weaker than the work actually requires,
- an agent assumes more project context than it has activated,
- role handoffs lose the original aim, problem-space understanding, priority, boundary, and evidence standard.

Previous systems point at the right shape:

- **Agneto** encoded the engineering pipeline instinct: beancounter -> coder -> reviewer.
- **Open Horizons** provides the coherent thinking framework / workstream contract.
- **Superego** is the skeptical contract-checking prompt/policy.
- **Expert-system skills** prove that structured prompts and project-specific gates can work extremely well.
- **Oh My Pi / oh-omp** should be the harness-native control plane.

Agneto's failure mode was not that role pipelines are inherently too ambitious. It failed because handoffs lacked a coherent cognitive framework. The v0 should therefore encode the OH frame directly in prompts now, not defer it.

## Core thesis

Every serious workstream should begin with an implicit first-principles evaluation. For this v0 workflow, that evaluation should be explicit so we can dogfood and learn.

The cognitive frame is:

```text
Aim -> Problem Space -> Solution Space -> Execution Contract -> Verification / Learning
```

Agents may infer local implementation details. They must not silently infer or change the workstream frame.

The wider ecosystem is context by default, not scope. Scope expansion requires explicit promotion.

Think bigger about the model; stay bounded in the implementation.

The most dangerous slop pattern is spec substitution: the workflow cannot read the canonical issue/spec, invents a narrower substitute from title/local memory, verifies that substitute, then delivers as if the original request were closed. v0 must make that impossible by default.


A workstream is more durable than a single task. Within one project there can be multiple conceptual workstreams, each requiring its own persistent expert system. Step 0 is crucial because it identifies the conceptual workstream and persists the contract that keeps execution consistent across related tasks.
## v0 shape

Implement a prompt-native workflow using current `task` / subagent infrastructure.

Preferred command shape:

```text
/workstream <raw task>
```

The command should instruct the main agent to orchestrate these roles:

```text
Beancounter / OH Workstream Frame
  -> Superego OH frame review
  -> Workstream Expert System builder
  -> Superego expert-system review
  -> Coder (can reuse existing `task` agent in v0)
  -> Superego drift check as needed
  -> Verifier
  -> Completion packet + friction log
```

This does not need native automatic hooks yet. It should be dogfoodable as an explicit workflow command.

Two prompt-level gates are part of v0, not future native runtime work:
- **Canonical source gate:** if the raw task references an issue, ticket, ADR, spec, security review, failing test, customer report, or similar canonical artifact, the workstream must read it before coding. If it cannot be read, Superego blocks unless the user explicitly authorizes a bounded substitute frame.
- **Closure gate:** `Closes`, `Fixes`, and `Resolves` are allowed only when original request satisfaction is yes/full and canonical acceptance criteria are satisfied or explicitly accepted by the authorized owner. Partial work uses `Refs`, `Partially addresses`, or equivalent non-closing language.
- **Expert-system gate:** after Step 0, resolve an existing durable Workstream Expert System for the conceptual workstream or compile/update one from canonical sources and the OH frame. It becomes persistent workstream law for coder/verifier across related tasks, but cannot invent facts, weaken criteria, or grant closure authority.

## Initial implementation scope

### In scope

- Add bundled role agents:
  - `beancounter`
  - `superego`
  - `verifier`
  - `workstream-expert`
- Add or expose a bundled `/workstream` command for workstream runs.
- Add a bundled `/workstream-expert` command for explicit interactive builder-only runs that create/update a durable Workstream Expert System and stop before coding.
- Reuse the existing `task` agent as the coder for v0.
- Require an OH Workstream Frame before coding.
- Require independent Superego review of the OH Workstream Frame.
- Require a durable Workstream Expert System before coding, either reused from an existing conceptual workstream or created/updated from Step 0.
- Require independent Superego review of the Workstream Expert System, including workstream identity, persistence scope, and durable-vs-task-local rule separation.
- Require a verifier review after coding.
- Require a friction log artifact in the final output.
- Add minimal tests that bundled agents / command definitions load correctly and include the OH frame language.


### Explicit builder-only trigger

`/workstream-expert <raw workstream seed>` runs the Step 0 -> Superego -> Workstream Expert Builder -> Superego path without coder execution. It is intentionally interactive: it must ask before choosing among multiple existing expert systems, creating a new durable workstream, selecting a persistence path, authorizing a bounded substitute source, or materially changing durable workstream law.

Expected use cases:
- bootstrap a Kraken-style expert system before executing tasks,
- update a durable workstream expert system after new canonical sources appear,
- resolve workstream boundaries without coding,
- persist Step 0 contracts for consistency across future `/workstream` executions.

The command must finish with a Workstream Expert Builder Packet and confirm `Do not code: confirmed`.
### Out of scope

- Rewriting the main agent loop.
- Automatic pre-tool Superego gates.
- New persistent database schema.
- Full Teach-OH persistence/runtime integration.
- Full Agneto resurrection.
- A new UI for friction logs.
- Model-routing UI.

## Existing code seams

Likely files to inspect/use:

- `packages/coding-agent/src/task/index.ts`
  - existing task/subagent tool orchestration.
- `packages/coding-agent/src/task/executor.ts`
  - subagent execution and structured output handling.
- `packages/coding-agent/src/task/types.ts`
  - task params, agent definitions, output data.
- `packages/coding-agent/src/task/agents.ts`
  - bundled agent registration.
- `packages/coding-agent/src/task/commands.ts`
  - bundled workflow command support.
- `packages/coding-agent/src/prompts/agents/*.md`
  - bundled agent prompt conventions.
- `packages/coding-agent/src/prompts/agents/task.md`
  - current general-purpose coder-like agent.

## Beancounter role

Beancounter owns the OH Workstream Frame. It must not produce an implementation plan as its primary output.

Required structure:

```markdown
## OH Workstream Frame

### Aim
**Raw request interpretation:**
**Desired outcome:**
**Current priority:**
**Original request satisfaction target:** full | partial | bounded-v0 | unclear
**Canonical sources:**
**Acceptance criteria map:**
**Workstream type / activated conceptual systems:**

### Problem Space
**Observed reality:**
**Core tension / why this is hard:**
**Specific need:**
**Ecosystem context, not scope:**
**Constraints:**
**Underspecification / uncertainties:**
**Failure modes:**

### Solution Space
**Candidate approaches:**
**Chosen approach:**
**Alternatives rejected / deferred:**
**Abstraction boundary:**

### Execution Contract
**In scope:**
**Out of scope / forbidden expansion:**
**Worktree / branch contract:**
**Delivery / PR contract:**
**Closure semantics:**
**Stop conditions:**

### Verification / Learning
**Verification standard:**
**Required evidence:**
**Evidence strength expected:** direct E2E | integration | focused seam test | unit/helper | static review | manual/direct-use
**Known acceptable gaps:**
**Learning / friction capture:**

### Raw Request Alignment
**Preserved:**
**Contract narrowing / shaping:**
**Expanded:**
**Acceptance authority:** user | Step 0/project convention | maintainer | verifier | nobody yet
```

Core rule:

> Do not collapse from raw request directly into implementation. First establish the OH frame: Aim -> Problem Space -> Solution Space -> Execution Contract -> Verification/Learning. The coder may execute inside that frame but must not silently change it.

## Superego role

Superego owns skeptical OH frame integrity checking. It is not primarily a code reviewer.

Superego checks:

- Did Beancounter jump to solution before understanding Problem Space?
- Is the Aim clear and grounded?
- Is observed reality separated from inference?
- Are material uncertainties surfaced rather than hidden?
- Did the frame preserve the raw request's intent?
- Did it silently narrow acceptance or verification?
- Did it silently broaden scope?
- Is ecosystem context clearly separated from modification scope?
- Is the chosen abstraction boundary justified?
- Are rejected/deferred alternatives explicit enough?
- Is verification strong enough for the risk?
- Are stop conditions real?
- Is the coder being asked to infer frame-level decisions?
- Were all canonical source artifacts read before coding?
- Did the frame substitute a title, summary, local memory, or prior context for canonical acceptance criteria?
- Does the delivery contract forbid closure language when original request satisfaction is partial or unclear?

Decision format remains:

```text
DECISION: ALLOW | REVISE | BLOCK
CONFIDENCE: HIGH | MEDIUM | LOW
```

Superego should prefer self-correction over human interruption. Escalate only material unresolved issues.

## Workstream Expert System role

The Workstream Expert-System Builder compiles the approved OH Workstream Frame plus canonical sources into a durable conceptual-workstream law artifact. It is stricter and more operational than the frame: acceptance matrix, definitions, invariants, implementation rules, verification rules, delivery/closure gates, and update rules that keep future related tasks consistent.

It must preserve authority: raw request -> canonical sources -> OH frame -> expert system. It may derive operational guardrails, but it must not invent source facts, weaken canonical acceptance criteria, or grant closure authority.

It must first determine whether an existing Workstream Expert System applies. If yes, Step 0 updates that system rather than creating a duplicate per-task artifact. If no, it creates a new system with an explicit persistence path/store and scope of applicability.

Required structure:

```markdown
# Workstream Expert System

## Persistence
**Workstream ID:**
**Artifact path / store:**
**Lifecycle:** durable conceptual workstream | archived | blocked
**Version / updated at:**
**Applies to:**
**Does not apply to:**

## Authority Chain
**Raw request:**
**Existing expert system:**
**Canonical sources:**
**OH Workstream Frame:**
**Superego corrections incorporated:**
**Validity status:** valid | blocked | valid only as user-authorized bounded substitute

## Workstream Identity
**Workstream type:** security | migration | API contract | UX | observability | state-machine | test-only | refactor | release | investigation | money-movement | other
**Conceptual scope:**
**Activated conceptual systems:**
**Context-only systems:**
**Acceptance authority:**
**Closure authority:**

## Durable Problem Model
**Observed reality:**
**Core tension:**
**Slop risks:**
**Definitions:**

## Current Step 0 Contract
**Current task frame:**
**Task-specific acceptance criteria:**
**Task-specific non-goals / stop conditions:**
**Frame delta from prior expert system:**

## Acceptance Criteria Matrix
| Criterion | Source / provenance | Scope | Required handling | Evidence required | Current status |
|---|---|---|---|---|---|

## Invariants / Guardrails
### MUST
### MUST NOT
### BLOCK IF

## Authorized Solution Space
**Allowed seams:**
**Forbidden seams:**
**Required abstraction boundary:**
**Deferred alternatives:**

## Implementation Rules for Coder
**Coder may:**
**Coder must:**
**Coder must not:**
**Coder must stop if:**

## Verification Rules
**Required checks:**
**Evidence strength required by claim:**
**Does not count as proof:**
**Verifier must return NEEDS_HUMAN if:**

## Delivery / Closure Rules
**PR required:** yes | no | deferred by contract
**Target branch:**
**Allowed PR language:** Closes/Fixes/Resolves permitted | non-closing refs only
**Required PR body disclosures:**
**Human approval required before closure if:**

## Expert-System Update Rules
**Requires Superego review:**
**Requires user/maintainer decision:**
**Archive / split conditions:**

## Friction / Learning Hooks
**Record friction if:**
**Candidate reusable guardrails:**
```

## Coder role

For v0, use the existing `task` agent unless a dedicated coder prompt is clearly needed.

Coder receives the full OH Workstream Frame, Workstream Expert System, and any Superego corrections.

The coder may infer local implementation details. It may not silently modify:

- Aim,
- Problem Space interpretation,
- Solution Space / chosen approach,
- Execution Contract,
- abstraction boundary,
- Verification Standard,
- Stop Conditions,
- Risk Acceptance.
- Workstream Expert System acceptance matrix, invariants, verification rules, delivery/closure rules,

If implementation evidence contradicts the frame or Workstream Expert System, or reveals that the task belongs to a different conceptual workstream, the coder must stop and produce:

```markdown
## Frame Delta

Did implementation reveal anything that changes the Aim, Problem Space, Solution Space, Execution Contract, Workstream Expert System, Verification Standard, or Stop Conditions?

- none, or:
- proposed delta requiring Superego/user review
```

## Verifier role

Verifier checks across OH layers:

```markdown
## Verification Review

**Verdict:** PASS | NEEDS_FIX | NEEDS_HUMAN

**Original request satisfied:** yes | no | partial

**Aim satisfaction:**

**Problem-space fidelity:**
Did the implementation solve the real problem, or a convenient proxy?

**Solution-space fidelity:**
Did it stay within chosen approach / abstraction boundary?

**Execution contract satisfaction:**

**Raw request vs OH frame audit:**

**Verification evidence:**

**Evidence strength by material claim:**
- [claim]: direct E2E | integration | focused seam test | unit/helper | static review | manual/direct-use | not proven

**Verification gap audit:**

**Acceptance gap / authority:**

**Residual risk:**

**Required fixes or human decisions:**

**Friction log candidates:**
```

## Completion packet

The orchestrating agent should produce a final completion packet that distinguishes original request satisfaction from OH frame satisfaction:

```markdown
## Completion Packet

**Original request satisfied:** yes | no | partial

**OH frame satisfied:** yes | no | partial

**Aim satisfaction:** yes | no | partial

**Problem-space fidelity:**

**Solution-space fidelity:**

**Raw request vs OH frame:**
- Preserved:
- Narrowed:
- Expanded:
- Meaningful gaps:
- Acceptance authority for gaps:

**Frame Delta:**

**Files changed:**

**Worktree / branch:**

**Delivery / PR:**

**Scope check:**

**Verification:**
- Automated:
- Manual/direct-use:
- Evidence strength by material claim:
- Verification gap audit:
- Not proven:

**Residual risk:**

**Risk acceptance authority:**

**Superego corrections:**

**Human decision needed:** none | accept residual risk | approve scope expansion | choose verification path | approve request narrowing | approve branch/PR target | review frame delta | other

**Friction log:**
```

`Human decision needed: none` is only allowed if residual gaps are either immaterial or explicitly accepted by the OH Workstream Frame/project convention.

## Friction log artifact

Every v0 workstream run must produce a friction log.

Suggested event fields:

```markdown
### Event 1
**Phase:** step0 | superego-contract | coding | superego-drift | verification | completion | delivery
**OH Layer:** aim | problem-space | solution-space | execution-contract | verification | learning
**Category:** boundary | context | handoff | verification | scope | model | tool | human-escalation | noise | worktree | branch | pr-delivery | other
**Severity:** low | medium | high
**Observed friction:**
**Why it mattered:**
**Correction / outcome:** self-corrected | escalated | ignored | unresolved | not-applicable
**Should become native behavior?** yes | no | maybe
**Native candidate priority:** now | later | no
**Notes:**
```

## Minimal tests

Add tests that prove:

1. Bundled agents load:
   - `beancounter`
   - `superego`
   - `verifier`

2. Bundled command loads:
   - `workstream` or chosen command name.

3. Agent definitions have expected names/descriptions/tools.

4. Command expansion and prompts include:
   - `OH Workstream Frame`,
   - `Problem Space`,
   - `Solution Space`,
   - `Execution Contract`,
   - `Raw Request Alignment`,
   - `Frame Delta`,
   - `Problem-space fidelity`,
   - `Verification gap audit`,
   - `OH Layer`,
   - friction log requirement.

No full end-to-end model test is required for v0.

## Success criteria for v0

v0 is successful when:

1. A user can run a workstream command on a real task.
2. Dedicated subagents produce an OH Workstream Frame, Superego review, coder report, verifier review, completion packet, and friction log.
3. The loop can catch or at least expose plausible boundary drift.
4. The friction log gives enough evidence to decide what should become native harness behavior next.
5. The system is annoying in observable ways rather than vague ways; those annoyances are captured as dogfood data.

## After dogfooding

After 1-3 real runs, evaluate:

- Did the OH Workstream Frame catch ambiguity?
- Did Problem Space prevent premature solution collapse?
- Did Superego catch useful boundary or verification issues?
- Did handoffs preserve the frame?
- Did the coder stay bounded?
- Did verifier distinguish paper correctness from reality evidence?
- Was the friction log useful?
- Which parts should become native runtime mechanics?
