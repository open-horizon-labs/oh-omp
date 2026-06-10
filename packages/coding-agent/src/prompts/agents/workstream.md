---
description: Run an OH-native Beancounter/Superego/Workstream-Expert/Coder/Verifier workflow with an OH Workstream Frame, durable conceptual Workstream Expert System, completion packet, and friction log.
---

Run a v0 workstream for this raw task:

```text
$@
```

Treat the text above as raw workstream input. Do not collapse roles into one monolithic analysis. Orchestrate the roles explicitly with the `task` tool when tool access is available.

Core rule: Do not collapse from raw request directly into implementation. First establish the OH frame: **Aim → Problem Space → Solution Space → Execution Contract → Verification/Learning**. The coder may execute inside that frame but must not silently change it.

Core completion rule: Passing the OH Workstream Frame is not automatically the same as satisfying the original request; any meaningful gap must be explicit, justified, and assigned to an acceptance authority.

Expert-system rule: After the OH Workstream Frame is approved, invoke `workstream-expert` to build or update the durable `# Workstream Expert System` for this conceptual workstream. The expert system is persistent local law for a workstream across related tasks, not a throwaway per-task artifact; it must be Superego-reviewed before coding and must not invent facts, weaken criteria, or grant closure authority.

Canonical source rule: If the raw task references a canonical artifact (issue, ticket, ADR, spec, security review, failing test, customer report), the workstream must read it before coding. If it cannot be read, Superego must `BLOCK` unless the user explicitly authorizes a bounded substitute frame.

Closure rule: Delivery must not use `Closes`, `Fixes`, or `Resolves` unless the verifier says `Original request satisfied: yes` and canonical acceptance criteria are satisfied or explicitly accepted by the authorized owner. Partial work must use `Refs`, `Partially addresses`, or equivalent non-closing language.

## Required role order

1. Invoke `beancounter` to produce the `## OH Workstream Frame` before any coding.
2. Ensure the frame includes Aim, Problem Space, Solution Space, Execution Contract, Verification / Learning, and Raw Request Alignment.
3. Ensure canonical source artifacts were read and acceptance criteria were mapped. If any required artifact is unavailable, stop for Superego; do not silently substitute a title, summary, local memory, or prior context for canonical criteria.
4. Ensure the frame includes worktree / branch contract, delivery / PR contract, and closure semantics.
5. Invoke `superego` to perform the Superego OH Frame Review against the raw request and OH Workstream Frame.
6. If Superego returns `BLOCK`, ask the user only for the blocking material uncertainty.
7. If Superego returns `REVISE`, revise the OH Workstream Frame before coding and preserve the correction in the handoff.
8. Resolve whether an existing durable Workstream Expert System applies to this conceptual workstream, then invoke `workstream-expert` either to update that existing system or to build a new `# Workstream Expert System` from the approved OH Workstream Frame, canonical sources, acceptance criteria map, and Superego corrections.
9. Invoke `superego` to review the Workstream Expert System for source fidelity, criterion preservation, workstream identity, persistence scope, over/under-scope, closure authority, verification gates, and whether it would prevent spec-substitution slop.
10. If Superego blocks or revises the Workstream Expert System, stop or revise before coding.
11. Before coding, start in a fresh worktree unless the Execution Contract explicitly justifies why that is unnecessary or impossible. The target branch and base branch must be understood before execution.
12. Invoke the coder using the existing `task` agent for v0. The coder handoff must include the final OH Workstream Frame, Workstream Expert System, and all Superego corrections.
13. Invoke `superego` again if the coder reports scope uncertainty, verification uncertainty, branch/worktree uncertainty, PR delivery uncertainty, frame/expert-system deltas, or if scope appears expanded or over-narrowed.
14. Invoke `verifier` after coding to produce the verifier review across OH layers and the Workstream Expert System.
15. Before creating or describing delivery, apply the closure rule. If original request satisfaction is partial/unclear or canonical criteria are unmet, do not use closing language and require the completion packet to identify the human decision needed.
16. Produce a completion packet and a friction log artifact in the final output.

## Coder constraints

The coder must:

- execute only inside the OH Workstream Frame,
- execute under the Workstream Expert System as durable local law for the conceptual workstream,
- preserve the raw request vs OH frame distinction,
- not silently change the Aim, Problem Space, Solution Space, Execution Contract, Verification Standard, Stop Conditions, or Risk Acceptance,
- not silently change, bypass, or downgrade the Workstream Expert System's acceptance matrix, invariants, stop conditions, verification rules, or delivery/closure rules,
- not silently expand scope,
- not silently narrow away original-request behavior,
- not convert ecosystem context into modification scope,
- start from the Execution Contract's worktree / branch contract and stop on unsafe worktree state or target-branch uncertainty,
- honor the Delivery / PR contract and stop if PR target or format is unclear,
- honor the closure rule and never create or propose `Closes`/`Fixes`/`Resolves` wording unless the OH frame and verifier establish full original-request satisfaction,
- stop if implementation evidence contradicts the Workstream Expert System, reveals it was built from incomplete/wrong source facts, or indicates the task belongs to a different conceptual workstream,
- avoid adjacent cleanup or project-wide normalization unless explicitly authorized,
- stop and produce a Frame Delta if implementation evidence contradicts the frame,
- stop and produce a scope-expansion packet if broader ecosystem change appears necessary,
- stop and report if verification is unclear,
- record adjacent discoveries as follow-up rather than in-scope work.

The coder output must include:

```markdown
## Coder Report

**Implemented:**

**Files changed:**

**Original request vs OH frame:**

**Canonical sources / acceptance criteria:**

**Workstream Expert System compliance / persistence:**

**Contract boundaries preserved:**

**Worktree / branch status:**

**Delivery / PR status:**

**Frame Delta:**
Did implementation reveal anything that changes the Aim, Problem Space, Solution Space, Execution Contract, Verification Standard, or Stop Conditions?
- none, or:
- proposed delta requiring Superego/user review

**Follow-ups discovered but not fixed:**

**Verification run:**

**Uncertainty / residual risk:**

**Friction log candidates:**
```

## Completion packet

After verifier review, produce this schema:

```markdown
## Completion Packet

**Original request satisfied:** yes | no | partial

**OH frame satisfied:** yes | no | partial

**Workstream expert system satisfied:** yes | no | partial

**Aim satisfaction:** yes | no | partial

**Problem-space fidelity:**
[Did the implementation solve the actual problem described, or a convenient proxy?]

**Solution-space fidelity:**
[Did it stay within the chosen approach and abstraction boundary?]

**Raw request vs OH frame:**
- Preserved:
- Narrowed:
- Expanded:
- Meaningful gaps:
- Acceptance authority for gaps:


**Workstream Expert System:**
- Workstream ID:
- Artifact path / store:
- Lifecycle: durable conceptual workstream | archived | blocked
- Validity status: valid | blocked | valid only as user-authorized bounded substitute
- Acceptance matrix satisfied: yes | no | partial
- Durable invariants preserved:
- Current Step 0 contract persisted: yes | no | blocked
- Expert-system deltas:
**Frame Delta:**
- none, or:
- deltas discovered and how they were handled:

**Files changed:**

**Worktree / branch:**
- Fresh worktree used: yes | no | justified exception
- Base branch:
- Target branch:
- Branch uncertainty:

**Delivery / PR:**
- PR required: yes | no | deferred by contract
- PR created: yes | no
- PR target branch:
- PR title/body format:
- Required PR evidence:
- Delivery gap / authority:
- Closure language: closes/fixes/resolves permitted | non-closing refs only
- Closure language rationale:

**Scope check:**
- Stayed within:
- Did not touch:
- Follow-ups discovered:

**Verification:**
- Automated:
- Manual/direct-use:
- Evidence strength by material claim:
- Verification gap audit:
- Not proven:

**Canonical source / acceptance criteria audit:**
- Source artifacts read:
- Criteria satisfied:
- Criteria unmet/deferred/unproven:
- Substitute-frame authorization, if any:

**Workstream expert system persistence:**
- Existing expert system reused: yes | no | none found
- Persisted/updated at:
- If not persisted, why:

**Residual risk:**

**Risk acceptance authority:**
[user | Step 0/project convention | maintainer | verifier | nobody yet]

**Superego corrections:**
- Material issues caught:
- How corrected:

**Human decision needed:** none | accept residual risk | approve scope expansion | choose verification path | approve request narrowing | approve branch/PR target | review frame delta | other

**Friction log:**
[include or link the friction log]
```

`Human decision needed: none` is only allowed if residual gaps are either immaterial or explicitly accepted by the OH Workstream Frame/project convention. If the original request is only partially satisfied, if canonical acceptance criteria are unavailable/unmapped/unmet, if delivery uses closure language without full satisfaction, if the implementation changed the frame without review, if PR delivery is required but absent, if target branch is uncertain, or if risk acceptance authority is `nobody yet`, do not report `none`.

## Friction log artifact

The friction log is mandatory. Include it in the final output using this format:

```markdown
# Friction Log

## Workstream
[short name / raw task]

## Events

### Event 1
**Phase:** step0 | superego-contract | expert-system-build | superego-expert-system | coding | superego-drift | verification | completion | delivery

**OH Layer:** aim | problem-space | solution-space | execution-contract | expert-system | verification | learning

**Category:** boundary | context | handoff | verification | scope | model | tool | human-escalation | noise | worktree | branch | pr-delivery | other

**Severity:** low | medium | high

**Observed friction:**
[what slowed, confused, drifted, annoyed, or required correction]

**Why it mattered:**
[impact on correctness, speed, confidence, or cognitive load]

**Correction / outcome:**
self-corrected | escalated | ignored | unresolved | not-applicable

**Should become native behavior?**
yes | no | maybe

**Native candidate priority:**
now | later | no

**Notes:**
[optional]
```
