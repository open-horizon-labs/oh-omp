Delegates work to subagents when independent execution or specialist expertise is worth the coordination cost. Direct execution is also valid; no role sequence is required.

{{#if asyncEnabled}}
- Use `read jobs://` to inspect state; `read jobs://<job_id>` for detail.
- Use the `await` tool to wait until completion. You **MUST NOT** poll `read jobs://` in a loop.
{{/if}}

Subagents lack your conversation history. Every decision, file content, and user requirement they need **MUST** be explicit in `context` or `assignment`.

<parameters>
- `agent`: Agent type for all tasks.
  - `.id`: CamelCase, max 32 chars
  - `.description`: UI display only — subagent never sees it
  - `.assignment`: Self-contained instructions with a clear objective, scope, relevant constraints, and expected result. Use as much detail as the task needs; no fixed template is required.
- `context`: Shared background prepended to every assignment. Session-specific info only.
- `schema`: JTD schema for expected output. Format lives here — **MUST NOT** be duplicated in assignments.
- `tasks`: Tasks to execute in parallel.
- `isolated`: Run in isolated environment; returns patches. Use when tasks edit overlapping files.
</parameters>

<critical>
- **MUST NOT** duplicate shared constraints across assignments — put them in `context` once.
- **MUST NOT** tell tasks to run project-wide build/test/lint. Parallel agents share the working tree; each task edits, stops. Caller verifies after all complete.
- For large payloads (traces, JSON blobs), write to `local://<path>` and pass the path in context.
- Prefer `task` agents that investigate **and** edit in one pass. Only launch a dedicated read-only discovery step when the affected files are genuinely unknown and cannot be inferred from the task description.
</critical>

## Scope and parallelism
- Give each agent a bounded, coherent task. Identify target files when known, or a clear discovery boundary when they are not; split by responsibility rather than an arbitrary file count.
- Run tasks in parallel only when each can produce a correct result without seeing the other's output. Shared API or schema changes usually need to settle before dependent work starts.
- Avoid overlapping writes in a shared working tree. Keep integration checks with the caller after concurrent edits finish.
- Use `schema` when the caller needs structured output. Short assignments are fine when the context already supplies the necessary detail.

Example: shared `context` describes a settled API rename and its constraints. One assignment updates the declaration; another updates known callers in separate files. Neither agent needs the other's edits to understand the intended final contract. The caller verifies the combined result.

{{#list agents join="\n"}}
### Agent: {{name}}
**Tools:** {{default (join tools ", ") "All"}}
{{description}}
{{/list}}
