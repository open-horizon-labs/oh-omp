# Slice 0 Model-Binding Canary Report

**Date:** 2026-06-24  
**Scope:** model-routing canary only; no Slice 0 implementation work  
**Verdict:** **PASS for Sonnet-high execution horde; BLOCK for DeepSeek execution claim**

> Active replacement roster: execution/coding lanes use `anthropic/claude-sonnet-4-6` with `thinking-level=high`. The prior DeepSeek execution-evaluation claim is waived for this run unless explicitly revived later.

---

## 1. Intended roster

| Role | Model | Thinking |
|---|---|---|
| Execute / coding lanes | `anthropic/claude-sonnet-4-6` | `high` |
| Review / drift / Superego / verifier / beancounter / workstream-expert | `openai-codex/gpt-5.5` | `high` |
| Final holistic E2E evaluator | `openai-codex/gpt-5.5` | `xhigh` |

---

## 2. Runtime model pool evidence

Command:

```text
bun packages/coding-agent/src/cli.ts --list-models deepseek-v4-pro
```

Relevant output:

```text
provider    model                     context  max-out  thinking                 images
deepseek    deepseek-v4-pro           1.0M     384K     high,xhigh               no
openrouter  deepseek/deepseek-v4-pro  1.0M     384K     minimal,low,medium,high  no
```

Interpretation:

- User-provided id `deepseek/deepseek-v4-pro` resolves as provider `deepseek`, model `deepseek-v4-pro` in oh-omp model-string form.
- Desired `xhigh` thinking is supported by the `deepseek` provider entry.

Command:

```text
bun packages/coding-agent/src/cli.ts --list-models gpt-5.5
```

Relevant output:

```text
provider      model                   context  max-out  thinking               images
openai-codex  gpt-5.5                 1.0M     128K     low,medium,high,xhigh  yes
```

Interpretation:

- `openai-codex/gpt-5.5` exists and supports both `high` and `xhigh`.

---

## 3. Current global settings evidence

Observed in `/Users/drazen/.oh-omp/agent/config.yml`:

```yaml
modelRoles:
  default: openai-codex/gpt-5.5:high
  slow: openai-codex/gpt-5.5:xhigh
  task: deepseek/deepseek-v4-pro:xhigh

task:
  agentModelOverrides:
    task: openai-codex/gpt-5.5
    reviewer: openai-codex/gpt-5.5
    superego: openai-codex/gpt-5.5
    verifier: openai-codex/gpt-5.5
    workstream-expert: openai-codex/gpt-5.5
```

Interpretation:

- `modelRoles.task` already points at the desired DeepSeek xhigh binding.
- However, `task.agentModelOverrides.task` points at GPT-5.5 and has higher precedence for the built-in `task` agent.
- Therefore generic `agent: task` is **not** a valid DeepSeek execution canary in the current settings.

---

## 4. Agent materialization evidence

Initial attempt:

- Wrote canary agents under repo-local `.omp/agents/`.
- Live task dispatch returned `Unknown agent` for both `slice0-coder-canary` and `slice0-review-canary`.
- Fresh-process discovery also did not discover `.omp/agents/` in this runtime.

Runtime-discovered agent directory check showed the active discovered directory is:

```text
/Users/drazen/.claude/agents
```

Second attempt:

- Wrote:
  - `/Users/drazen/.claude/agents/slice0-coder-canary.md`
  - `/Users/drazen/.claude/agents/slice0-review-canary.md`
- Fresh-process `discoverAgents(process.cwd())` found both agents with their intended frontmatter.

Canary frontmatter:

```yaml
name: slice0-coder-canary
model: deepseek/deepseek-v4-pro
thinking-level: xhigh
```

```yaml
name: slice0-review-canary
model: openai-codex/gpt-5.5
thinking-level: high
```

---

## 5. Live task dispatch evidence

### 5.1 Review/governance canary

Agent:

```text
slice0-review-canary
```

Result:

```json
{
  "agent_name": "slice0-review-canary",
  "canary_kind": "review-governance",
  "did_edit_files": false,
  "did_run_commands": false,
  "status": "ok",
  "message": "Invoked as the Slice 0 review/governance canary and performed no repository actions."
}
```

Status: **PASS** for discovered-agent dispatch and task termination.

### 5.2 DeepSeek execution canary — first attempt

Agent:

```text
slice0-coder-canary
```

Result:

```text
SYSTEM WARNING: Subagent exited without calling submit_result tool after 3 reminders.
```

Status: **FAIL**.

### 5.3 DeepSeek execution canary — minimal retry

Agent:

```text
slice0-coder-canary
```

Prompt reduced to:

```text
Call submit_result now with exactly this message: OK slice0-coder-canary execution-coding no-edits no-commands
```

Result:

```text
SYSTEM WARNING: Subagent exited without calling submit_result tool after 3 reminders.
```

Status: **FAIL**.

---

## 6. Canary verdict

| Gate | Verdict | Evidence |
|---|---|---|
| Exact DeepSeek model id available | PASS | `deepseek/deepseek-v4-pro` model pool entry supports `xhigh`. |
| Exact GPT-5.5 model id available | PASS | `openai-codex/gpt-5.5` model pool entry supports `high` and `xhigh`. |
| Dedicated agent materialization path discovered | PASS after correction | `.claude/agents` is discovered; `.omp/agents` is not discovered in this runtime. |
| Review/governance subagent canary | PASS | `slice0-review-canary` returned structured ok result. |
| DeepSeek execution subagent canary | FAIL | `slice0-coder-canary` failed to call `submit_result` twice, including minimal retry. |

Overall:

```text
DeepSeek execution claim remains BLOCKED. Sonnet-high replacement execution roster is PASS and may be used for the horde subject to normal OH gates.
```

---

## 7. Interpretation

The failure is not model availability and not agent discovery after using the correct directory.

The specific failure is task-subagent completion/termination under `deepseek/deepseek-v4-pro:xhigh`:

```text
DeepSeek subagent did not call submit_result, even after reminders and even with a one-line instruction.
```

This suggests one of:

1. `deepseek/deepseek-v4-pro` currently fails tool-call termination in this task-subagent harness;
2. the provider adapter/model settings are not exposing `submit_result` tool calls correctly for this model;
3. the model invocation is misconfigured despite frontmatter discovery;
4. the model is producing no usable output under this harness path.

Until that is solved, coding agents cannot safely run on the DeepSeek binding because the orchestrator cannot reliably receive results or evidence. This does not block the replacement Sonnet-high binding, which passed in Section 11.

---

## 8. Recommended next actions

1. Use `anthropic/claude-sonnet-4-6:high` for execution/coding lanes if launching the horde now.
2. Keep review/governance roster as `openai-codex/gpt-5.5:high`; that path canary-passed.
3. Do not claim this run evaluates DeepSeek coding ability.
4. If DeepSeek evaluation is revived later, debug DeepSeek task-subagent termination in isolation:
   - inspect provider/request logs if available;
   - test the same model in a direct non-subagent chat if possible;
   - test `deepseek/deepseek-v4-pro:high` to see whether `xhigh` is the issue;
   - test the OpenRouter entry only if explicitly approved, noting it lacks `xhigh` in registry output;
   - test whether a built-in agent with exact override behaves differently from project-agent frontmatter.
5. Require a passing DeepSeek execution canary before claiming a DeepSeek coding evaluation.

---

## 9. Temporary artifacts cleanup

Temporary canary agents were created at:

```text
/Users/drazen/.claude/agents/slice0-coder-canary.md
/Users/drazen/.claude/agents/slice0-review-canary.md
```

They were removed after evidence was recorded to avoid leaving extra global/user agent labels active.

Repo-local `.omp/agents/slice0-*-canary.md` files were also removed because this runtime did not discover `.omp/agents`.

---

## 10. Anthropic Sonnet 4.6 xhigh-request diagnostic

User requested the same canary protocol for:

```text
anthropic/claude-sonnet-4-6, thinking-level=xhigh
```

### 10.1 Runtime model pool evidence

Command:

```text
bun packages/coding-agent/src/cli.ts --list-models claude-sonnet-4-6
```

Output:

```text
provider   model              context  max-out  thinking                 images
anthropic  claude-sonnet-4-6  200K     64K      minimal,low,medium,high  yes
```

Interpretation:

- `anthropic/claude-sonnet-4-6` exists.
- The runtime model pool does **not** advertise `xhigh` support for this model.
- Therefore this cannot be accepted as an exact `xhigh` canary, even if frontmatter requests `thinking-level: xhigh`.

### 10.2 Materialized diagnostic agent

Temporary agent frontmatter:

```yaml
name: slice0-anthropic-xhigh-canary
model: anthropic/claude-sonnet-4-6
thinking-level: xhigh
```

Fresh-process discovery found the agent with:

```json
{
  "name": "slice0-anthropic-xhigh-canary",
  "source": "project",
  "model": ["anthropic/claude-sonnet-4-6"],
  "thinkingLevel": "xhigh",
  "tools": ["read", "submit_result"]
}
```

### 10.3 Live task dispatch evidence

Agent:

```text
slice0-anthropic-xhigh-canary
```

Result:

```json
{
  "agent_name": "slice0-anthropic-xhigh-canary",
  "canary_kind": "anthropic-sonnet-4-6-xhigh-request-diagnostic",
  "did_edit_files": false,
  "did_run_commands": false,
  "status": "ok",
  "message": "Invoked as the Anthropic Sonnet 4.6 xhigh-request diagnostic canary; no files were edited and no commands were run."
}
```

Status: **PASS** for task-subagent termination and `submit_result` compliance.

Status: **NOT VALIDATED** for exact `xhigh`, because the model pool does not list `xhigh` as supported for `anthropic/claude-sonnet-4-6`. The runtime may reject, clamp, or otherwise normalize the requested thinking level internally; the task result does not expose resolved thinking level.

### 10.4 Comparative interpretation

Unlike `deepseek/deepseek-v4-pro:xhigh`, which failed twice by exiting without `submit_result`, the Anthropic Sonnet 4.6 diagnostic returned a valid structured result on the first attempt.

This suggests the prior canary failure is specific to the DeepSeek task-subagent path or its binding, not to project-agent discovery or the canary protocol itself.

However, do not substitute Sonnet 4.6 as an `xhigh` execution model without explicit user approval and a model-pool-supported thinking level. The supported launchable variant from current registry evidence is at most `anthropic/claude-sonnet-4-6:high`.

Temporary cleanup: `/Users/drazen/.claude/agents/slice0-anthropic-xhigh-canary.md` was removed after evidence was recorded.


---

## 11. Exact Sonnet 4.6 high replacement canary

User accepted the supported Sonnet variant:

```text
anthropic/claude-sonnet-4-6, thinking-level=high
```

### 11.1 Runtime model pool evidence

The runtime model pool advertises `high` for Sonnet 4.6:

```text
provider   model              context  max-out  thinking                 images
anthropic  claude-sonnet-4-6  200K     64K      minimal,low,medium,high  yes
```

### 11.2 Materialized exact canary agent

Temporary agent frontmatter:

```yaml
name: slice0-sonnet-high-canary
model: anthropic/claude-sonnet-4-6
thinking-level: high
```

Fresh-process discovery found the agent with the intended model and thinking level before dispatch.

### 11.3 Live task dispatch evidence

Agent:

```text
slice0-sonnet-high-canary
```

Result:

```json
{
  "agent_name": "slice0-sonnet-high-canary",
  "canary_kind": "anthropic-sonnet-4-6-high-execution",
  "did_edit_files": false,
  "did_run_commands": false,
  "status": "ok",
  "message": "Invoked as the Anthropic Sonnet 4.6 high-thinking execution canary; no files edited, no commands run."
}
```

Status: **PASS** for exact supported execution binding and task-subagent termination.

### 11.4 Updated launch interpretation

The prior DeepSeek execution canary remains failed and must not be claimed as evaluated coding execution. However, the replacement execution binding `anthropic/claude-sonnet-4-6:high` has passed the same no-op task-subagent protocol.

Therefore the implementation horde may launch only under the Sonnet-high execution roster plus GPT-5.5 review/governance roster, subject to the other OH lane/process gates.

Temporary cleanup: `/Users/drazen/.claude/agents/slice0-sonnet-high-canary.md` was removed after evidence was recorded.

---

## 12. Durable Slice 0 role-label canaries

User confirmed launch-prep roster:

```text
coder + executor: anthropic/claude-sonnet-4-6, thinking-level=high
preppers + reviewers/governance: openai-codex/gpt-5.5, thinking-level=high
```

Durable agents were materialized in the runtime-discovered directory `/Users/drazen/.claude/agents`:

| Agent | Model | Thinking | Canary | Result |
|---|---|---|---|---|
| `slice0-coder` | `anthropic/claude-sonnet-4-6` | `high` | `agent://17-PermanentCoderCanary` | PASS: `OK slice0-coder permanent-canary no-edits no-commands` |
| `slice0-executor` | `anthropic/claude-sonnet-4-6` | `high` | `agent://19-PermanentExecutorCanary` | PASS: `OK slice0-executor permanent-canary no-edits no-commands` |
| `slice0-prepper` | `openai-codex/gpt-5.5` | `high` | `agent://14-PermanentPrepperCanary` | PASS: `OK slice0-prepper permanent-canary no-edits no-commands` |
| `slice0-reviewer` | `openai-codex/gpt-5.5` | `high` | `agent://15-PermanentReviewerCanary` | PASS: reviewer verdict `correct`, confidence `1` |
| `slice0-drift-reviewer` | `openai-codex/gpt-5.5` | `high` | `agent://18-PermanentDriftReviewerCanary` | PASS: `aligned` no-op canary |
| `slice0-superego-reviewer` | `openai-codex/gpt-5.5` | `high` | `agent://16-PermanentSuperegoReviewerCanary` | PASS: `ALLOW` no-op canary |
| `slice0-verifier` | `openai-codex/gpt-5.5` | `high` | `agent://20-PermanentVerifierCanary` | PASS: `PASS` no-op canary |

Conclusion: durable model-routing prep is complete for the Sonnet-high execution roster plus GPT-5.5 high prep/review/governance roster. This does not revive the failed DeepSeek execution claim.

---

## 13. Experimental GLM executor canary

User request: test an executor model, do not switch the active executor yet.

Planned experimental role:

```yaml
name: slice0-glm-executor
model: zai/glm-5.2
thinking-level: high
```

Runtime-discovered materialization path: `/Users/drazen/.claude/agents/slice0-glm-executor.md`.

Direct-provider no-op canary evidence: `agent://105-GlmExecutorNoOpCanary` returned successfully for `zai/glm-5.2`, `high`, with no edits and no commands. A later OpenRouter canary attempt was an operator misbinding and is not part of this experiment.

Status: **PASS for direct ZAI no-op canary**. Active `slice0-executor` remains `anthropic/claude-sonnet-4-6:high`; `slice0-glm-executor` may receive only a bounded clippy hygiene evaluation unless/until the user explicitly accepts a roster switch.

Rerun canary after restoring the runtime agent file to direct `zai/glm-5.2`: `agent://107-DirectZaiGlmExecutorNoOpCanary`.

Result:

```json
{
  "agent_name": "slice0-glm-executor",
  "binding": "zai-glm-5.2",
  "thinking_level": "high",
  "canary_kind": "no-op",
  "did_edit_files": false,
  "did_run_commands": false,
  "message": "OK slice0-glm-executor zai-glm-5.2-high no-edits no-commands",
  "status": "ok"
}
```

Status: **PASS for direct ZAI no-op canary (confirmed rerun)**. Proceed only to bounded clippy hygiene evaluation; no active executor roster switch is implied.

### Bounded execution evaluation result

Task: `DirectZaiGlmClippyCleanup` — bounded clippy hygiene pass over four successor-protocol files with a prepared lint log.

Result: **FAIL (stall)**. The task ran 1h07m without completing and was cancelled. Post-cancellation verification showed no edits to any target file (mtimes unchanged), no partial worktree state, and `cargo test -p successor-protocol` still fully green.

Verdict: `zai/glm-5.2:high` terminates no-op canaries quickly (~15s, twice) but stalled on the first real bounded multi-file coding task without producing edits or a completion result. Same failure class as the DeepSeek execution canary (exit/stall without `submit_result`).

Disposition: `slice0-glm-executor` is **not eligible** for execution roster work. Active `slice0-executor` remains `anthropic/claude-sonnet-4-6:high`. The clippy pass was reassigned to orchestrator-local bounded edits.

Completion: the reassigned local clippy pass finished. Two `make fix-rs` autofix passes resolved 72 of 76 findings; manual fixes covered the remainder (three reasoned `#[expect(clippy::too_many_arguments)]` on protocol envelope constructors; deletion of the dead `_status_to_str` helper and its unjustified `#[allow]` in `canonical_json.rs`). Verified: `make check-rs` exit 0 (fmt + clippy `-D warnings` + cargo check across the workspace) and `cargo test -p successor-protocol` fully green (64 unit + 19 A2 + 33 A3 + 8 A4 + doc-tests).

Cleanup: `/Users/drazen/.claude/agents/slice0-glm-executor.md` was removed after the experiment closed, following the same convention as the section 9 canary-agent cleanup. No experimental agent labels remain active.

---

## 14. Experimental Sonnet 5 executor canary

User request: test `anthropic/claude-sonnet-5` at `high` as the next executor experiment. Testing only; no active roster switch implied.

Registry verification: `anthropic/claude-sonnet-5` exists in the model pool — 1.0M context, 128K max-out, thinking levels minimal/low/medium/high.

Experimental role:

```yaml
name: slice0-sonnet5-executor
model: anthropic/claude-sonnet-5
thinking-level: high
```

Runtime-discovered materialization path: `/Users/drazen/.claude/agents/slice0-sonnet5-executor.md`.

Gate sequence (per the GLM lesson): no-op canary → tool-using canary (read one file, report one fact) → bounded real evaluation task.

Gate 1 — no-op canary: **PASS** (`agent://109-Sonnet5ExecutorNoOpCanary`, 8.8s). Returned exact expected echo `OK slice0-sonnet5-executor anthropic-claude-sonnet-5-high no-edits no-commands`; no edits, no commands.

Gate 2 — tool-using canary: **PASS** (`agent://110-Sonnet5ExecutorToolCanary`, 36.6s). Read exactly one assigned file (`crates/successor-protocol/src/lib.rs`), reported 12 `pub mod` declarations with names in file order. Orchestrator verified the fact against ground truth: exact match, count and order. No edits.

Gate 3 — bounded real evaluation: **PASS with one hygiene caveat** (`agent://111-Sonnet5Gate3FixtureBundle`, 16m45s). Delivered the typed fixture-bundle slice of A5 scope: `fixtures.rs` (11 canonical fixtures inventoried; 9 typed accessors through accepted A1–A4 DTOs; 2 exposed as raw-str with `A5-pending` notes), `tests/slice0_fixture_contract.rs` (13 tests), `lib.rs` export line only. Scope exactly respected. Fixture-first stop law followed: discovered `assemble-response-pre-tool.json` and `assemble-response-post-read.json` do not deserialize through accepted `AssemblyResponseV0` (field-shape mismatches recorded in `fixtures.rs` doc comments) and reported instead of patching — the discipline the review-learning law demands.

Orchestrator verification: `cargo test -p successor-protocol` green (64 unit + 19 A2 + 33 A3 + 8 A4 + 13 new fixture-contract tests). `make check-rs` initially failed on 3 new-code `too_long_first_doc_paragraph` doc lints; the assignment had restricted the agent to targeted validation, so this is an assignment-framing gap, not an agent-discipline failure. Orchestrator re-paragraphed the docs; full gate now exit 0.

Verdict: **eligible for roster consideration**. Comparison: GLM stalled 1h07m with zero output on an easier task; Sonnet 5 delivered disciplined real work in 16m45s with honest mismatch findings. Active `slice0-executor` remains `anthropic/claude-sonnet-4-6:high` until the user explicitly accepts a switch.

New finding routed to A5/A2 adjudication: the two assemble-response fixtures vs `AssemblyResponseV0` mismatch. Per review-learnings §11, either reopen the owning accepted lane (A2) or correct the fixtures; no wrappers.

### Acceptance and promotion (2026-07-02)

User explicitly accepted the switch: active `slice0-executor` rebound from `anthropic/claude-sonnet-4-6:high` to `anthropic/claude-sonnet-5:high`. Runbook roster amended (dated amendment recorded), README roster updated, experimental label `slice0-sonnet5-executor` retired and its agent file removed. Coder lane binding unchanged.

Rebind canary on the durable `slice0-executor` label: **PASS** (`agent://112-ExecutorRebindCanary`, 8.8s). Exact echo `OK slice0-executor anthropic-claude-sonnet-5-high rebind no-edits no-commands`; no edits, no commands. The active execution binding is now `anthropic/claude-sonnet-5:high`.