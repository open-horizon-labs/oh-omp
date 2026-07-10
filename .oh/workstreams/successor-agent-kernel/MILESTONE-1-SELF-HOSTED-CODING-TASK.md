# Milestone 1 — Self-Hosted Coding Task

Owner-approved 2026-07-10. Governed by `PARALLEL-WAVE-PROTOCOL.md`,
`SLICE-0-REVIEW-LEARNINGS.md` §1-14, and `TOOL-AUTHORING-BLUEPRINT.md`.

## Aim

Prove that the successor is a coding agent, not only a read-only conversational
kernel: it can inspect a disposable workspace, make one bounded change, run a
focused verification command, repair if needed, and persist/replay the complete
provider, context, tool, mutation, and process trail.

This milestone advances the workstream aim in `FRAME.md`: a reliable,
inspectable, UI-agnostic daily-driver kernel whose runtime truth is canonical
events/provenance rather than rendered transcript text.

## Proven base

At wave base, the kernel has:

- a live provider loop with eight bounded tool rounds;
- five executable read/discovery tools: `search_files`, `read`, `find`, `grep`,
  `list_dir`;
- provider-native tool-use/tool-result projection;
- multi-turn continuation through `ask --session-id`;
- cross-turn `/assemble` retrieval and bounded context injection;
- durable raw events, session projection, replay, and SSE lifecycle frames;
- no executable mutation, process, or code-intelligence authority;
- no live assistant-text delivery despite the reserved `provider_delta` frame.

## Success gate

In a disposable, root-bounded workspace containing a small project with one
intentional failing test, a real provider must:

1. inspect the failure and relevant source;
2. produce one bounded, preconditioned workspace mutation;
3. run the focused test through bounded local process execution;
4. repair once if the first change is incorrect;
5. reach `turn_completed` with visible assistant output;
6. leave the expected file bytes and a passing test;
7. survive kernel/client restart such that `/resume` and replay recover the
   same ordered tool, mutation, process, and assistant facts;
8. expose no provider credential, platform entitlement, or unrestricted
   environment value in events, artifacts, frames, or provider-visible text.

The gate is terminal- and state-asserting: exit code alone, compilation alone,
or a model claim that the task succeeded is insufficient.

## Foundational lanes

### F1 — Assistant output / provider streaming

Implement the reserved `provider_delta` live frame path and complete assistant
output delivery to clients. Durable `assistant_turn.recorded` remains the source
of truth; live deltas must reconcile byte-exactly to the persisted final text.
CLI rendering is a client projection, never canonical state.

### F2 — Tool runtime registry

Replace runner-owned hard-coded dispatch with a behavior-preserving registry so
future tool modules can be authored and reviewed independently. Each registered
tool binds name, generated schema, category/status, authority requirement,
executor, output bounds, and artifact policy. This lane adds no executable tool
and must preserve the current catalog/events/frames byte-for-byte.

### F3 — Capability and authority policy

Define explicit kernel-owned authority classes (`safe_read`,
`workspace_mutation`, `local_process`, and future higher authorities). Default
is read-only. Provider output can request only catalog-published capabilities
and can never grant authority. Effective authority and rejection are typed,
auditable, and replayable. Interactive approval is future-compatible but is not
required for this milestone; explicit invocation/session grants are sufficient.

### F4 — Long-session context evaluation

Build a deterministic evaluation corpus for cross-turn assembly: relevance,
recency, provenance, token-budget behavior, exclusion reasons, and contamination
resistance. This is platform-owned and may execute in parallel with tool-runtime
work when file ownership is disjoint. It promotes no recall/concept tool yet.

## Parallel implementation lanes after F2/F3

### I1 — Workspace mutation

Promote bounded `edit` and `write` semantics: workspace/symlink confinement,
stale-write preconditions, atomic replacement, size bounds, before/after hashes,
bounded diff artifacts, typed rejection, and full event provenance.

### I2 — Bounded local process execution

Start with structured executable + argv, never unrestricted `sh -c`: root-bounded
cwd, executable/environment allowlists, timeout and process-tree termination,
bounded stdout/stderr with artifact spillover, redaction, exit/signal/duration
facts, and deterministic failure mapping.

### I3 — Read-only code intelligence

Promote selected `ast_grep` and `lsp` operations without mutation authority.
`ast_edit` waits for I1 authority semantics. Tests pin DTO/schema/executor and
provider-projection parity under the tool blueprint.

The I-lanes implement disjoint modules/tests in parallel. A serial integration
lane registers accepted tools and performs one sovereign catalog/contract
amendment, preventing parallel edits to canonical fixtures.

## Reliability lanes before broad dogfood

- same-session single-flight/idempotency;
- cancellation for provider and process work with typed terminal state;
- crash-boundary recovery around mutation and process persistence;
- protocol SDK/reducer using SSE for live progress and `/resume` for durable
  reconciliation.

A web/TUI client may follow the SDK, but no UI-first work displaces the coding
success gate.

## Non-goals

- unrestricted shell, network, SSH, browser, or remote mutation authority;
- feature-parity port of oh-omp tools or commands;
- public multi-user kernel exposure;
- subagents or workflow-control tools;
- frontend visual polish before protocol/reducer correctness;
- treating provider messages or rendered UI text as canonical state.

## Initial protocol launch

Launch three read-only dissent/design legs in parallel:

1. F1 assistant-output streaming contract;
2. F2/F3 tool registry plus authority boundary (one central-runtime design leg);
3. F4 long-session context evaluation.

The orchestrator performs the cross-ruling check before execution. Any file
ownership overlap, contradictory law, or multiple sovereign amendment claims
sequences lanes into later waves; nothing executes under contested law.
