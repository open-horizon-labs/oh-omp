# Slice 0 Horde Runbook — OH Process + Model-Gated Execution

**Status:** Process authority for future Slice 0 implementation horde  
**Date:** 2026-06-24  
**Authority:** `SLICE-0-CONTRACT.md`, canonical fixtures under `fixtures/slice-0/`, and `SLICE-0-DISPATCH-MAP.md`  
**Purpose:** require every implementation lane to flow through OH process, preserve stable interfaces, and make model bindings explicit before execution.

---

## 1. Core rule

The horde may be large, but each lane must move through a disciplined OH packet:

```text
Aim
→ Problem Space
→ Solution Space
→ Dissent decision
→ Execute
→ Code Review
→ Drift Review
→ Superego Review
→ Lane Acceptance
```

The lane, not a single subagent invocation, is the accountability unit.

No lane is accepted because code exists. A lane is accepted only when its packet, code, reviews, and evidence agree.

---

## 2. Model-binding policy

### 2.1 User intent

The implementation horde is also a model-quality experiment.

Desired binding:

```text
Coding / execute lanes: anthropic/claude-sonnet-4-6, thinkingLevel=high
Review, drift, Superego, verifier, beancounter, and workstream-expert lanes: openai-codex/gpt-5.5, thinkingLevel=high
Final holistic E2E evaluation by orchestrator: openai-codex/gpt-5.5, thinkingLevel=xhigh
```

Rationale:

- use a task-subagent-validated execution model for real coding tasks;
- keep independent review pressure high enough that weak code is caught;
- record that the prior DeepSeek execution-evaluation claim is waived for this Sonnet-high run unless explicitly revived later;
- preserve Slice 0 correctness over model-evaluation convenience.

### 2.2 Active routing machinery

The workstream machinery does provide active routing tools at the durable role-binding layer. The correct distinction is:

- **Active today:** Workstream Expert Systems must include a `## Model Roster` and can materialize role bindings through `task.agentModelOverrides` and/or project-agent frontmatter under `.omp/agents/`.
- **Active today:** bundled/project agent frontmatter supports `model: ...`; task execution resolves settings override first, then agent frontmatter, then active/session model inheritance.
- **Active today:** the `/agents` dashboard and settings layer can persist `task.agentModelOverrides`; project settings are commonly loaded from `.omp/settings.json`.
- **Active today:** available models can be enumerated by the runtime model registry / `--list-models` path in an actual oh-omp launch.
- **Not active in this exposed API:** the current `task` tool schema visible to this orchestrator has no per-call `model` or `effort` parameter.

Therefore Slice 0 should use the workstream machinery as the primary routing mechanism: bind a durable Model Roster, materialize those bindings through settings or project-agent frontmatter, and prove the resolved model with canary dispatch evidence before implementation.

The visible `task` tool schema still has only:

```text
agent
context
schema
tasks
```

and no dispatch-time `model`, `effort`, or exact-model field. That means the binding is enforced by roster materialization, not by adding a model field to individual `task` calls from this harness.

### 2.3 Exact model-id and materialization gate

Before launching implementation agents, perform a model-binding preflight.

Required checks:

1. Enumerate the available model pool visible to the actual execution harness, preferably with the runtime `--list-models` path filtered for Sonnet 4.6 and GPT-5.5.
2. Confirm exact model ids exist: `anthropic/claude-sonnet-4-6` and `openai-codex/gpt-5.5`.
3. Bind the durable Model Roster for the Slice 0 workstream: coder/executor = `anthropic/claude-sonnet-4-6` with `thinkingLevel=high`; reviewer/drift/Superego/verifier/beancounter/workstream-expert = `openai-codex/gpt-5.5` with `thinkingLevel=high`; final orchestrator E2E evaluation = `openai-codex/gpt-5.5` with `thinkingLevel=xhigh`.
4. Materialize the roster through active machinery:
   - project or user `task.agentModelOverrides` keys for the exact agent names that will be invoked, where supported by the running harness; and/or
   - materialized `.omp/agents/<name>.md` files with `model: <exact-id>` and `thinkingLevel: <level>` frontmatter; and/or
   - `/agents` dashboard persisted overrides, if operating interactively.
5. Verify that the invoked agent names in future `task` calls exactly match the override/frontmatter keys.
6. Run a canary dispatch for each role and capture resolved-model evidence from task logs/artifacts/UI.
7. Stop if resolved model evidence is absent, ambiguous, or different from the bound roster.

Do not count this run as a DeepSeek coding evaluation. The active execution binding is Sonnet 4.6 high because the DeepSeek task-subagent canary failed termination.

### 2.4 Confirmed model ids

User-confirmed Slice 0 ids:

```text
Execution/coding: anthropic/claude-sonnet-4-6, thinkingLevel=high
Review/governance/final base model: openai-codex/gpt-5.5
```

`high` and `xhigh` are valid thinking selectors in oh-omp. Project-agent frontmatter supports both `model:` and `thinkingLevel:` fields. Model-string suffixes such as `<model>:high` may also resolve through model-role parsing, but the preferred materialization for Slice 0 project agents is explicit frontmatter fields to avoid ambiguity.

Do not silently fall back from `anthropic/claude-sonnet-4-6` to another execution model, or from `openai-codex/gpt-5.5` to another review/governance model. Exact-model dispatch is part of the evaluation mechanism; substitution invalidates the experiment unless explicitly approved by the user.

### 2.5 Model roster for Slice 0 horde

| Role | Binding | Thinking | Binding status | Notes |
|---|---|---|---|---|
| Builder / Coder lane | `anthropic/claude-sonnet-4-6` | `high` | user-confirmed; exact canary passed | Lane implementation coding under `slice0-coder`. Binding unchanged by the 2026-07-02 executor amendment. |
| Execution agent | `anthropic/claude-sonnet-5` | `high` | user-accepted 2026-07-02 after three-gate experiment (canary §14) | Active `slice0-executor` binding; rebind canary evidence recorded in canary §14. |
| Code reviewer | `openai-codex/gpt-5.5` | `high` | user-confirmed; canary passed | Independent from the coding model; strong review pressure. |
| Drift reviewer | `openai-codex/gpt-5.5` | `high` | user-confirmed; requires canary resolved-model evidence | Can be batched per lane or per wave. |
| Superego reviewer | `openai-codex/gpt-5.5` | `high` | user-confirmed; requires canary resolved-model evidence | Frame/governance review. |
| Verifier / Beancounter / Workstream-expert | `openai-codex/gpt-5.5` | `high` | user-confirmed; requires canary resolved-model evidence | Planning, verification, and expert-system maintenance. |
| Final holistic E2E reviewer | `openai-codex/gpt-5.5` via orchestrator | `xhigh` | user-confirmed; current orchestrator responsibility | Human-facing final synthesis by this assistant. |
| Experimental executor canary | `zai/glm-5.2` | `high` | experiment closed: no-op canaries passed but bounded execution stalled; not eligible | Isolated role label `slice0-glm-executor`; failed bounded clippy evaluation by 1h07m stall with no edits and no completion result; active `slice0-executor` remains Sonnet-high. |
| Experimental executor canary | `anthropic/claude-sonnet-5` | `high` | experiment accepted and promoted 2026-07-02 | Experimental label `slice0-sonnet5-executor` retired; binding promoted to active `slice0-executor` (canary §14). |

Binding changes are durable process changes for this horde. They require explicit user confirmation and must be recorded here or in a successor runbook amendment.

Amendment (2026-07-02): user explicitly accepted switching the active execution agent `slice0-executor` from `anthropic/claude-sonnet-4-6:high` to `anthropic/claude-sonnet-5:high` after the three-gate Sonnet 5 experiment (no-op canary, tool-using canary, bounded real evaluation — evidence in `SLICE-0-MODEL-CANARY.md` §14). Coder lane binding unchanged. Experimental label `slice0-sonnet5-executor` retired after promotion.

### 2.6 Model-routing workstream status

The selected oh-omp model-routing design is dual-mode: dispatch may specify either:

- abstract `effort` class, resolved by routing policy/gradation; or
- exact `model` id from the available model pool, used for explicit exploration/evaluation.

Intended precedence:

```text
user settings > dispatch-time exact model > agent frontmatter > policy > inheritance
```

Current status in this harness: dispatch-time `effort`/`model` parameters are **not active** in the exposed `task` tool schema. Current resolution is settings override / agent frontmatter / active model / session model. Therefore Slice 0 horde execution should use the active workstream-routing tools now:

1. bind the Model Roster in the workstream artifact;
2. materialize it via `task.agentModelOverrides` and/or a runtime-discovered agent directory. In this current harness, fresh-process discovery found `/Users/drazen/.claude/agents`; repo-local `.omp/agents` was not discovered.
3. prove the binding with canary dispatch resolved-model evidence; or
4. wait for the model-routing dispatch extension if per-call exact-model/effort selection is required for this evaluation.

Do not silently fall back from `anthropic/claude-sonnet-4-6` to any other execution model. The prior `deepseek/deepseek-v4-pro:xhigh` binding is explicitly not active for this run because its execution canary failed.

### 2.7 Concrete Slice 0 binding route

Important current-context note: the existing global oh-omp bootstrap roster is known to bind many built-in agents to `openai-codex/gpt-5.5` through `task.agentModelOverrides`. Because settings overrides have highest precedence over agent frontmatter, do **not** assume editing built-in agent frontmatter can override those global settings.

Preferred route for this Sonnet-high coding run:

1. Confirm both exact model ids from the actual model pool: `anthropic/claude-sonnet-4-6` and `openai-codex/gpt-5.5`.
2. Materialize dedicated Slice 0 coding agents in the runtime-discovered agent directory. In this current harness, that directory is `/Users/drazen/.claude/agents`, not repo-local `.omp/agents`.
3. Use explicit frontmatter, for example:
   - `/Users/drazen/.claude/agents/slice0-coder.md` with `model: anthropic/claude-sonnet-4-6` and `thinking-level: high`;
   - `/Users/drazen/.claude/agents/slice0-executor.md` with `model: anthropic/claude-sonnet-4-6` and `thinking-level: high` if a separate executor role is needed.
4. Ensure those dedicated agent labels are not overridden by global `task.agentModelOverrides`. If they are, either remove/rebind those exact keys by explicit user decision or choose new unshadowed role labels.
5. Invoke implementation builders with those Slice 0-specific agent labels, not generic `task`, unless the built-in `task` override has been explicitly rebound to `anthropic/claude-sonnet-4-6:high` for the run.
6. Keep reviewer/governance roles on `openai-codex/gpt-5.5` with `thinking-level: high`, likely through existing or updated overrides/frontmatter for `reviewer`, `superego`, `verifier`, `beancounter`, and `workstream-expert`.
7. Run a canary for each role and record resolved-model evidence in the first lane packet before any real implementation code is written.

Current canary result is recorded in `SLICE-0-MODEL-CANARY.md`: GPT-5.5 review canary passed; DeepSeek execution canary failed twice by exiting without `submit_result`; exact Sonnet 4.6 high execution canary passed. Therefore implementation horde launch is allowed only under the Sonnet-high execution roster, not under a DeepSeek evaluation claim.

Experimental GLM executor route: closed. `zai/glm-5.2:high` passed two no-op canaries (`agent://105-GlmExecutorNoOpCanary`, `agent://107-DirectZaiGlmExecutorNoOpCanary`) but stalled 1h07m on the bounded clippy evaluation task (`DirectZaiGlmClippyCleanup`) with no edits and no completion result — the same failure class as the DeepSeek execution canary. `slice0-glm-executor` is not eligible for execution roster work; active `slice0-executor` remains `anthropic/claude-sonnet-4-6:high`. Lesson: no-op canaries prove termination plumbing, not execution viability; future model experiments need a small tool-using canary (e.g. read one file, report one fact) between the no-op gate and real work.

Experimental Sonnet 5 executor route: user requested testing of `anthropic/claude-sonnet-5` at `high` (registry-verified: 1.0M context, 128K max-out, thinking minimal/low/medium/high). Isolated role `slice0-sonnet5-executor` materialized. Gate sequence applies the GLM lesson: no-op canary, then a small tool-using canary (read one file, report one fact), then a bounded real evaluation task. Active `slice0-executor` remains `anthropic/claude-sonnet-4-6:high` during the experiment.

---

## 3. Lane OH Packet template

Each implementation lane must maintain one lane packet under:

```text
.oh/workstreams/successor-agent-kernel/runs/slice-0/<LANE-ID>-<Name>.md
```

Template:

```markdown
# Lane <ID> — <Name>

## Model Binding

- Intended coding model:
- Resolved coding model evidence:
- Reviewer model:
- Superego model:
- Binding verdict: [verified / ambiguous / failed]

## Aim

- Outcome:
- Contract clause(s) served:
- Fixture(s) served:
- Files owned:
- Explicit non-goals:

## Problem Space

- Current state:
- Constraints:
- Named risks:
- Edge cases:
- Interface dependencies:
- Authority boundaries:

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Option A | | | |
| Option B | | | |

Selected approach:

Invalidated if:

Stop/pivot if:

## Dissent

Verdict: [not needed / completed / required-but-blocked]

If skipped, rationale:

If completed:
- Dissent concern:
- Response:
- Outcome:

## Execute

Checklist:
- [ ] owned files only
- [ ] shared interfaces imported from owner crate
- [ ] no forbidden shortcuts
- [ ] tests/checks added
- [ ] targeted validation passed
- [ ] named risks retired or routed
- [ ] model binding verified for execution agent

Changed files:

Validation evidence:

## Code Review

Reviewer:
Reviewer model:
Verdict: [PASS / REVISE / BLOCK]

Findings:
- ...

Fixes applied:
- ...

## Drift Review

Original aim:
Current work:
Gap:
Verdict: [aligned / minor drift / significant drift / lost]
Authority boundary: [clear / ambiguous / crossed]

## Superego Review

Reviewer:
Reviewer model:
Verdict: [ALLOW / REVISE / BLOCK]

Frame risks:
- ...

Required corrections:
- ...

## Delivery

Status: [accepted / needs revision / blocked]
Residual risks:
Human verification needed:
```

---

## 4. Interface discipline

Interface owners may define interfaces. Consumers may consume interfaces. Consumers may not silently redefine or mutate interfaces.

For Slice 0:

```text
Wave A protocol lanes own shared types.
Platform/kernel/provider/tool/CLI lanes consume them.
```

### 4.1 Owner lanes

Wave A owns:

- `RawEventV0`
- `KernelFrameV0`
- platform DTOs
- provider normalization DTOs
- fixture validator APIs
- replay/projection APIs
- `ErrorEnvelopeV0`
- artifact shapes
- typed IDs

### 4.2 Consumer lanes

Later lanes must import Wave A interfaces. They may not define local equivalents such as:

```rust
struct RawEvent { ... }
struct KernelFrame { ... }
enum ProviderApiShape { ... }
```

Internal implementation structs are allowed only when clearly private and converted at the boundary.

---

## 5. Interface Change Request protocol

If a lane discovers a stable interface is wrong, it must not patch opportunistically.

It must file this in its lane packet:

```markdown
## Interface Change Request

Requested change:
Why current interface fails:
Contract/fixture evidence:
Affected lanes:
Backward compatibility:
Options considered:
Recommended change:
Dissent required: yes
Superego required: yes
```

Then the orchestrator pauses affected lanes.

Required flow:

```text
problem-space
→ solution-space
→ dissent
→ superego
→ protocol owner update
→ fixture validator update
→ consumer lane resume
```

---

## 6. Dissent policy

Dissent is mandatory when a lane touches or challenges:

- raw event ontology;
- provider shape normalization;
- auth plane boundary;
- replay semantics;
- artifact retention;
- `/assemble` as sole context path;
- platform sequence assignment;
- tool authority;
- fixture schema;
- public protocol types;
- model bindings, routing policy, model roster, or role materialization;
- irreversible storage/migration/schema choices;
- any one-way decision.

Dissent may be skipped for low-risk local work only with explicit rationale:

```text
Dissent skipped: no material change to aim, authority, irreversible decision, stable interface, or model-binding policy.
```

Wave A protocol lanes should treat dissent as mandatory because they lock shared interfaces.

---

## 7. Execute discipline

Each builder lane must run the lane-local OH process before coding:

1. Aim.
2. Problem Space.
3. Solution Space.
4. Dissent decision.
5. Execute.
6. Lane-local drift self-check.

Execution constraints:

- owned files only;
- 3–5 explicit files per task unless the orchestrator pre-splits;
- no broad rewrites;
- no contract/fixture weakening;
- no duplicate DTOs;
- no provider credentials in platform/session/event/artifact/trace/fixture output;
- no second semantic context path;
- no `provider_delta.recorded`;
- no subscription/OAuth provider login in Slice 0;
- no unverified model-binding claims.

- `SLICE-0-REVIEW-LEARNINGS.md` must be attached to every remaining builder, reviewer, drift-review, Superego, and verifier assignment.
- Builders must run the review-learning preflight before coding; reviewers must block repeated known review-loop failure classes even when the local tests pass.
---

## 8. Code review rubric

Every builder lane gets independent code review after execution.

Review asks:

1. Does this implement the lane aim?
2. Does it use stable interfaces instead of duplicating them?
3. Does it obey file ownership?
4. Does it preserve provider/platform auth separation?
5. Does it add targeted checks that fail tempting wrong patches?
6. Does it avoid broad rewrites, hidden side effects, and unsafe shortcuts?
7. Does it preserve model-binding evidence for the lane?
8. Does it leave contract/fixtures sovereign?
9. Does it satisfy `SLICE-0-REVIEW-LEARNINGS.md`, including contract/fixture sovereignty, serde-boundary validation, unknown-field rejection, provider credential gates, platform-assigned field handling, and regression tests for prior defects?

Verdict:

```text
PASS
REVISE
BLOCK
```

No lane integrates until code review is PASS.

---

## 9. Drift review rubric

Every lane gets drift review after code review fixes.

Template:

```markdown
Original aim:
Current work:
Gap:
Verdict: aligned | minor drift | significant drift | lost
Authority boundary: clear | ambiguous | crossed
```

Rules:

- `aligned`: continue.
- `minor drift`: record and refocus.
- `significant drift`: pause lane; orchestrator decides.
- `lost`: salvage/replan.

Examples of significant drift:

- fixture validator lane designs platform HTTP;
- CLI lane stores sessions locally;
- provider lane changes raw event schema;
- tool executor lane adds write/shell/web authority;
- platform auth lane stores provider credentials;
- model-binding workaround silently substitutes a non-requested model.

---

## 10. Superego review rubric

Superego review checks frame integrity, not ordinary code style.

It asks:

- Did the lane stay within aim?
- Did it respect authority boundaries?
- Did it weaken contract/fixtures?
- Did it bypass risk retirement?
- Did it conflate platform/provider auth?
- Did it introduce a second context path?
- Did it hide a material decision as implementation detail?
- Did it claim completion without adversarial evidence?
- Did it modify model bindings/routing/role labels without explicit user confirmation?
- Did it preserve the active Sonnet-high execution roster and avoid reviving the failed DeepSeek claim without a new passing canary?

Verdict:

```text
ALLOW
REVISE
BLOCK
```

Superego may be batched across several completed lane packets, but verdicts must be per lane.

---

## 11. Wave process

### Wave A — interface freeze

Required full flow:

```text
Aim → Problem Space → Solution Space → Dissent → Execute → Code Review → Drift Review → Superego
```

Reason: Wave A locks shared interfaces.

Gate:

- `successor-protocol` compiles;
- fixture validator passes;
- provider-shape normalization passes;
- replay projection passes;
- no duplicate DTOs downstream;
- model-binding canary confirms coding lanes resolve to `anthropic/claude-sonnet-4-6:high` before code-writing begins.

### Wave B — context platform

Full flow per lane.

Dissent required if touching:

- auth;
- storage semantics;
- sequence assignment;
- `/assemble`;
- artifact retention;
- replay/snapshot semantics;
- model-routing or role materialization.

### Wave C — kernel/provider/tools

Full flow per lane.

Dissent required if touching:

- provider normalized types;
- local provider auth;
- tool authority;
- turn lifecycle;
- persisted events;
- frame/event boundary;
- model binding or execution routing.

Extra drift check: kernel must not become platform, and CLI must not become kernel.

### Wave D — CLI/integration

Full flow per lane.

Dissent may be skipped only if CLI remains stateless and no authority boundary changes.

Final integration gates:

- deterministic fixture replay;
- provider-shape fixture coverage;
- unsupported tool rejection;
- credential leak scan;
- resume from platform only;
- one live provider smoke if credentials are available and authorized;
- no transcript-derived context assembly;
- model-binding evidence preserved for implementation lanes.

---

## 12. Final holistic E2E review

After all lanes are individually accepted, the orchestrator performs a holistic review and writes:

```text
.oh/workstreams/successor-agent-kernel/SLICE-0-E2E-REVIEW.md
```

It checks:

1. Every Lane OH Packet exists.
2. Every implementation lane has verified coding-model evidence.
3. Every lane has code review PASS.
4. Every lane has drift verdict aligned or minor-only.
5. Every lane has Superego ALLOW.
6. All Interface Change Requests are resolved.
7. Fixture validator passes.
8. Replay projection is byte-identical.
9. Provider normalization covers all three shapes.
10. Platform auth and provider auth are separated.
11. No provider credentials appear in platform/event/artifact/trace/fixture/CLI/SSE output.
12. Resume works from `session_id + MEMEX_LICENSE + local provider auth re-resolution`.
13. CLI remains stateless.
14. `/assemble` is the only semantic context path.
15. No forbidden raw event types appear.
16. No broad unintended rewrites landed.
17. Active Sonnet-high execution claims and any revived DeepSeek coding-evaluation claims are backed by resolved-model evidence.

Final verdict:

```text
PASS: Slice 0 ready for external review
REVISE: specific lanes need correction
BLOCK: architecture/authority/model-binding violation
```

---

## 13. Future subagent assignment boilerplate

Every future builder assignment should include:

```text
## OH Process Required

You are responsible for the full lane packet:
Aim → Problem Space → Solution Space → Dissent decision → Execute → Drift self-check.

You may not skip Problem Space or Solution Space.
You may skip Dissent only with explicit rationale.
You must stop if contract and fixtures conflict.
You must not weaken contract/fixtures.
You must not edit outside owned files.
You must produce risk-retirement evidence.
You must use shared interfaces from their owner crate.
You must preserve model-binding evidence.
```

Every future review assignment should include:

```text
## Review Required

Review the lane packet and code.
Return PASS / REVISE / BLOCK.
Check code correctness, stable-interface use, forbidden shortcuts, risk retirement, and model-binding evidence.
```

Every future Superego assignment should include:

```text
## Superego Required

Review the lane packet for aim fidelity, authority boundaries, contract/fixture preservation, drift, model-binding integrity, and hidden durable decisions.
Return ALLOW / REVISE / BLOCK per lane.
```

---

## 14. Launch preconditions

Before starting implementation horde:

- [ ] Human confirms this runbook.
- [x] Exact coding model `anthropic/claude-sonnet-4-6` is confirmed from actual model pool.
- [x] Exact review/governance model `openai-codex/gpt-5.5` is confirmed from actual model pool.
- [x] The harness path for enforcing per-role model bindings and thinking levels (`high` for execute, `high` for reviews/governance) is confirmed.
- [x] Canary dispatch proves resolved model per role for durable Slice 0 labels.
- [x] Wave A tasks are split into owned 3–5 file assignments.
- [x] Lane packet directory exists.
- [ ] Dispatch map and runbook are attached to every builder/reviewer/superego assignment.

If any model-binding precondition fails, do not launch the horde. If the execution model differs from `anthropic/claude-sonnet-4-6:high`, record the substitution and get explicit user approval before continuing.
