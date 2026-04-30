# Lean Mech Suit Runtime Design

Date: 2026-04-27
Status: Design adjusted after dissent; pending written-spec review

## Purpose

Build a clean-sheet, lean "mech suit" runtime for LLM agents: a small set of primitives that encode what agents need to act coherently over time without inheriting upstream `oh-omp` cruft. The system should be replacement-capable for day-to-day coding-agent-like workflows, but it must remain a general agent substrate rather than a coding-agent clone.

This design defines the system shape only. Each implementation phase must receive its own detailed plan before execution. No phase should be treated as obvious plumbing.

## Why Pivot Now

ADR 0001 chose a constrained fork as the bootstrap path because immediate dogfooding, process compatibility, and event compatibility mattered more than runtime purity. This design does not erase that decision. It records the re-evaluation path ADR 0001 explicitly left open: if the fork patch surface grows beyond a maintainable threshold, pause and consider a deliberate redesign or greenfield runtime.

The current motivation is that upstream `oh-omp` is broad, fast-moving, and expensive to keep aligned with, while most upstream features do not serve the desired LLM mech-suit shape. The constrained fork remains the bootstrap runtime until the new runtime proves a vertical dogfood slice. The clean-sheet runtime must earn replacement by demonstrating value, not by architectural preference alone.

The pivot test is practical: can the new substrate run a streamed, tool-using, resumable agent loop with prompt composition, approval handling, context decisions, event replay, and reboot behavior through public RPC only? If not, the constrained fork remains the working system.

The main replacement target is the current oh-kernel-style runtime role: the substrate that hosts model turns, tools, context, persistence, and client-facing events. That makes custom tools a central risk, not an optional extension detail. If custom tools cannot be expressed cleanly on the new runtime, the runtime has not proven its main use case.

## Goals

- Provide a clean-sheet runtime that is not constrained by current `oh-omp` protocol or API compatibility.
- Keep UI decoupled from runtime behavior through an RPC command/event boundary.
- Support streaming-first provider interactions.
- Include core tool execution, approvals, context assembly, prompt composition, session continuity, and rebootability from v1.
- Prove the runtime through a minimal CLI consumer that uses only public RPC commands/events.
- Shape the runtime so both non-coding agents and coding-agent-like workflows can be built on it without changing runtime internals.
- Phase implementation so every phase leaves behind a usable capability and proves one runtime contract.
- Treat custom-tool hosting as a first-class replacement requirement for the oh-kernel runtime role.

## Non-Goals

- Do not clone all current `packages/coding-agent` behavior line-for-line.
- Do not preserve upstream `oh-omp` compatibility as a design constraint.
- Do not build a full TUI in v1.
- Do not make coding-agent personality, UI rendering, or workflow-specific behavior part of the runtime identity.
- Do not implement every future agent mode, plugin system, or provider capability in the first slice.
- Do not replace `packages/coding-agent` immediately; v1 proves a credible replacement path, not full parity.
- Do not build a plugin marketplace or broad extension ecosystem in v1.
- Do not make two real provider adapters block the first contract spike; fake-provider contract tests come first.
- Do not treat prompt profile prose as the authority for safety, budgets, permissions, or stop conditions. Typed runtime policy owns those decisions.
- Do not treat current custom-tool API compatibility as a core-runtime requirement; any compatibility adapter belongs outside the kernel and must not distort the clean contract.

## Recommended Approach

Use a replacement-capable kernel plus two prompt profiles behind one loop controller:

- a core runtime package/module with durable agent contracts;
- a minimal CLI shell that dogfoods the runtime over public RPC;
- a deterministic fake/test provider first, followed by streaming provider adapters for Anthropic and OpenAI-compatible providers once the event contract stabilizes;
- core tool lifecycle and approvals;
- assembler-style context and memory;
- a named Prompt Composer / Mech Suit OS;
- local append-only session/event persistence;
- one mechanical loop controller shaped by prompt profiles and runtime policies.

This approach is broad enough to test whether current coding-agent-like workflows can move onto the new substrate, but narrow enough to avoid recreating the current architecture.

The guardrail is that v1 proves one complete vertical skeleton before broad implementation. The runtime should validate its command/event shape, Prompt Composer, local event log, fake-provider stream, fake tool approval, observation recording, and replay/reboot semantics before investing heavily in real provider coverage or richer tooling.

Before starting broad implementation, the first phase must map the current oh-kernel/custom-tool obligations into a small replacement envelope. The output should be a cut line: which custom-tool semantics are kernel requirements, which are compatibility-adapter concerns, and which are deliberately left behind.

## Architecture Boundary

The system is split into two small pieces.

### Core Runtime

The core runtime owns durable agent mechanics:

- provider abstraction and normalized streaming events;
- tool schemas, invocation, approval lifecycle, and tool-result events;
- context and memory candidate production;
- Prompt Composer / Mech Suit OS;
- session and event persistence;
- loop controller mechanics;
- prompt profiles and runtime policies;
- RPC command/event interface.

The runtime does not own UI, TUI rendering, coding-agent personality, or old upstream compatibility.

### Minimal CLI Shell

The CLI is a dogfood consumer, not a privileged layer. It must use public runtime RPC commands/events for:

- starting and resuming sessions;
- appending user/task input;
- running chat-style and task-style profiles;
- configuring providers;
- approving or denying tools;
- inspecting prompt/context decisions;
- observing streamed provider/tool/runtime events.

If the CLI needs a capability, the runtime API must expose it cleanly. There are no CLI backdoors into stores, prompt construction, or tool execution.

## Core Components

### Provider Layer

A streaming-first adapter boundary that:

- accepts provider-ready requests from the Prompt Composer;
- emits normalized stream events;
- supports text deltas, tool-call deltas, final tool calls, final assistant messages, and provider errors;
- exposes provider metadata and capabilities;
- ships first with a fake/test provider for contract validation, then Anthropic and OpenAI-compatible adapters after the normalized event shape stabilizes.

Provider adapters must not know about CLI presentation, persistence layout, workspace structure, or agent profiles.

### Tool Layer

Core owns the tool lifecycle:

- tool registry;
- schema and description metadata;
- invocation context;
- approval policy hook;
- requested, approved, denied, started, output, completed, failed, cancelled, and timed-out events;
- normalized observations that can be fed back to the model.

Concrete tools are host-provided functions. The runtime owns orchestration and event shape, not the whole tool catalog.

### Custom Tool Substrate

Custom tools are not a marketplace feature for v1; they are the proof that the runtime can replace the oh-kernel role. The kernel should define a clean custom-tool substrate with:

- model-callable tool definitions with stable names, descriptions, and schemas;
- runtime argument validation before execution;
- streamed progress/update events;
- cooperative cancellation through abort signals;
- structured result content plus machine-readable details;
- normalized failure events and error observations;
- approval and permission policy before side effects;
- optional lifecycle notifications for session start, resume, cancellation, and shutdown;
- deferrable action support for preview/apply-style tools through generic pending-action events;
- no direct TUI dependency.

Existing custom tools may need a compatibility adapter, but that adapter should live at the host/CLI/migration layer. The runtime contract should be cleaner than the current API: UI affordances become RPC events or optional render hints, not imports from the TUI; process execution helpers are host capabilities with explicit permissions; session access goes through scoped runtime APIs rather than direct store access.

### Prompt Composer / Mech Suit OS

The Prompt Composer is the central compiler. It turns environment, intent, memory, capabilities, and budgets into the model's next operating reality.

Inputs include:

- agent identity and instructions;
- prompt profile;
- runtime policies;
- current user/task input;
- session state;
- memories, summaries, recall results, and retrieved snippets;
- available tools and approval constraints;
- workspace/environment facts;
- context assembly candidates;
- token, turn, tool, and time budgets.

Outputs include:

- provider-ready request messages;
- provider tool declarations;
- budget and provenance records;
- context inclusion/exclusion decisions;
- prompt diagnostics explaining why the prompt has its shape.

Loop control must never hand-build prompts. It asks the Prompt Composer for each model turn.

### Context and Memory Layer

This is the clean-sheet expression of today's assembler idea. It supplies typed, addressable candidates to the Prompt Composer:

- hot recent messages;
- summaries;
- pinned facts and decisions;
- retrieved snippets;
- recall results;
- tool observations;
- workspace facts;
- profile instructions and operational rules.

It must avoid indiscriminate raw historical tool transcript replay. Large payloads should be stored as addressable observations with retrieval recipes, not eagerly stuffed into prompts.

### Session/Event Store

V1 ships with a concrete local store first. It should support:

- append-only event logs;
- resumable sessions;
- durable memory artifacts;
- prompt/context decision records;
- tool invocation records;
- provider request/response metadata;
- partial stream markers;
- pending approvals that survive restart.

The storage model can become pluggable later, but v1 optimizes for clone, configure, run, and reboot.

### Loop Controller + Prompt Profiles

The runtime should not expose heavy loop strategies as a central abstraction. It should expose one mechanical loop controller plus prompt profiles.

The loop controller owns non-prompt mechanics:

1. compose prompt;
2. stream model output;
3. detect tool request, final output, continuation, or failure;
4. apply approvals;
5. invoke tools;
6. record observations;
7. repeat until a terminal or paused state.

Prompt profiles shape model behavior:

- chat profile: conversational, user-in-the-loop, lower autonomy;
- task profile: goal-directed, higher autonomy, continues until done/blocked/budget.

Future review, research, or coding profiles should usually be profile/config additions unless they require genuinely new mechanics.

Runtime policies remain explicit and typed. Prompt profiles may shape model behavior, but they do not own governance. The runtime policy contract owns:

- max turns;
- max tool calls;
- token and context budgets;
- timeouts;
- approval mode;
- tool permission rules;
- retry limits;
- autonomy level;
- stop conditions;
- blocked-state criteria;
- persistence mode.

## RPC Runtime Boundary

The runtime is RPC-driven from day one. CLI, future TUI, API clients, and headless scripts all interact through the same command/event boundary.

### Commands

The initial command surface should include:

- start session;
- resume session;
- append user/task input;
- run loop;
- cancel or interrupt;
- approve or deny tool request;
- inspect session state;
- inspect prompt/context decisions;
- list providers, tools, and profiles;
- stream runtime events.

### Events

The event stream is the primary integration surface. Example events include:

- `session.started`;
- `session.resumed`;
- `input.appended`;
- `prompt.composed`;
- `context.item.included`;
- `context.item.excluded`;
- `provider.stream.delta`;
- `provider.tool_call.delta`;
- `tool.requested`;
- `tool.approved`;
- `tool.denied`;
- `tool.started`;
- `tool.output`;
- `tool.completed`;
- `tool.failed`;
- `loop.waiting_for_approval`;
- `loop.completed`;
- `loop.blocked`;
- `loop.failed`;
- `loop.cancelled`;
- `loop.budget_exhausted`.

The TUI should be only another RPC client. It may render progress, approvals, diffs, context decisions, and provider streams, but it must not own prompt construction, tool execution, store mutation, or hidden behavior.

### Minimal RPC Invariants

The exact transport remains open for phase planning, but the runtime boundary must preserve these invariants from the first vertical slice:

- every command has a correlation id;
- every event names its session id and, when applicable, command id;
- events are ordered within a session;
- clients can replay persisted session events after restart;
- cancellation records a durable event and has defined best-effort behavior for provider streams and tool calls;
- approval requests carry stable approval tokens;
- stale approval tokens fail with normalized RPC errors;
- partial provider/tool output is explicitly marked and never silently upgraded into final state.

## Per-Turn Data Flow

1. A client sends an RPC command such as start session, append input, or run loop.
2. Runtime loads session state: event history, memories, summaries, context decisions, pending approvals, profile, and policy config.
3. Context and memory produce typed candidates.
4. Prompt Composer compiles a bounded provider request, tool declarations, and provenance records.
5. Provider adapter streams normalized events.
6. Loop controller persists model output, detects tool requests or final state, applies approval policy, invokes tools, records observations, and repeats when needed.
7. RPC event stream broadcasts all observable state to clients.

## Error Handling and Rebootability

Failures and pauses are first-class runtime states.

### Loop Outcomes

Every loop run ends in one of these states:

- `completed`: agent produced a final answer/result;
- `blocked`: agent cannot continue without user input, approval, config, or dependency recovery;
- `failed`: runtime, provider, store, composer, or tool error prevented completion;
- `cancelled`: client/user interrupted execution;
- `budget_exhausted`: turn, tool, token, or time budget stopped the loop;
- `waiting_for_approval`: tool request is paused pending approval.

These outcomes must be emitted as RPC events and persisted in the session log.

### Error Boundaries

Subsystems may have internal error shapes, but the runtime normalizes errors at the event boundary:

- provider errors: auth, rate limit, model unavailable, unsupported capability, malformed stream;
- tool errors: validation failure, denied approval, execution failure, timeout, cancellation;
- composer errors: impossible budget, missing required context, invalid profile/tool declaration;
- store errors: session not found, corrupted event log, write failure;
- RPC errors: invalid command, stale approval token, cancelled operation.

Clients should never parse provider-specific errors directly.

### Reboot Semantics

The mech can reboot. The runtime must support interruption without corrupting state:

- cancellation records an event;
- in-flight tools are cancelled when possible;
- pending approvals survive resume;
- completed provider/tool outputs are durable;
- partial provider streams are marked partial;
- resumed loops know whether they can continue, need approval, or must ask for new input.

## Implementation Phase Shape

Implementation should be phased so each phase proves one contract and leaves behind a usable capability. Each phase must receive a detailed implementation plan before execution.

**Preflight. Oh-kernel/custom-tool replacement envelope**
   - Map the current oh-kernel runtime obligations and custom-tool semantics before implementation starts.
   - Classify each obligation as kernel contract, host/compatibility-adapter concern, or intentionally dropped behavior.
   - Include current custom-tool capabilities such as schemas, streamed updates, cancellation, pending actions, lifecycle callbacks, UI hooks, process helpers, discovery, and renderer hooks.
   - Usable as the scope gate that prevents either under-building the main use case or importing old API cruft into the new kernel.

1. **Contract spike / vertical skeleton**
   - Drive one thin loop through public runtime commands using a fake provider and fake custom tool.
   - Include RPC command correlation, prompt composition, fake stream events, one fake custom-tool request, approval/denial, streamed tool update, tool observation recording, append-only event persistence, replay, and reboot/resume behavior.
   - Usable as the executable contract for the runtime shape before broad implementation.

2. **Prompt Composer + event contract slice**
   - Compile bounded prompts from typed context candidates and emit inclusion/exclusion decisions.
   - Exercise the composer with the fake provider so the mech-suit OS is validated before generic plumbing dominates.
   - Usable for prompt inspection and context-quality debugging.

3. **Session + local store slice**
   - Start and resume sessions with append-only events, partial markers, pending approvals, and replay.
   - Usable for durable chat/session logging and reboot tests.

4. **Provider adapter slice**
   - Add real provider coverage behind the stabilized fake-provider contract.
   - Prefer one real adapter first if phase planning shows adapter work is dominating; complete Anthropic plus OpenAI-compatible support before declaring v1 provider goals met.
   - Usable as a provider abstraction by itself.

5. **Tools + approvals slice**
   - Register and invoke real host-provided custom tools with lifecycle events, approval policy, output bounding, pending-action support, and addressable observations.
   - Usable for safe agent actions and oh-kernel replacement validation.

6. **Loop controller + profiles slice**
   - Run chat/task profiles through one mechanical loop with typed runtime policy.
   - Usable as the first actual mech-suit agent runtime.

7. **Minimal CLI/RPC dogfood slice**
   - Exercise the full stack through public runtime commands only.
   - Usable proof that UI remains decoupled and the runtime can support day-to-day agent work.

## Testing and Validation

Validation should test contracts, not old implementation trivia.

### Provider Contract

- fake provider emits deterministic streams;
- Anthropic and OpenAI-compatible adapters normalize to the same event shape;
- malformed provider streams become normalized provider errors.

### Prompt Composer Contract

- bounded provider requests are composed from context candidates;
- inclusion/exclusion decisions are recorded;
- budgets and profile/policy constraints are respected;
- huge raw tool payloads are not silently included.

### Tool Lifecycle Contract

- request, approval, start, output, completion, and failure events occur in order;
- denied tools pause or return structured observations correctly;
- outputs become addressable observations rather than uncontrolled prompt bloat.
- custom tools can stream progress, receive cancellation, register pending preview/apply actions, and return structured details without direct TUI access.

### Session/Store Contract

- sessions resume from append-only events;
- interrupted loops preserve enough state to continue safely;
- partial provider outputs are marked partial;
- pending approvals survive restart.

### Loop Controller Contract

- loop continues after tool observations;
- loop stops on final, blocked, failed, cancelled, waiting-for-approval, and budget-exhausted states;
- ordered events are emitted for clients.

### RPC Boundary Contract

- CLI and future TUI use only public commands/events;
- no UI client reaches into runtime internals.
- command ids, session ids, event ordering, replay, cancellation, and approval token semantics are contract-tested.

## Dogfood Proof

The first end-to-end proof should be narrow but complete:

A minimal CLI starts or resumes a session, runs a task-profile agent with provider streaming, assembler-style prompt composition, custom file/read/search/edit/shell-like tools, approval handling, persisted events, interruption/reboot, and final result delivery through RPC events only.

The coding-agent-like proof is one concrete day-to-day workflow, not full package parity: complete a small repo task through custom tools that requires reading/searching files, making a bounded edit, optionally running a shell check behind approval, surviving interruption/restart, and returning a final result with inspectable prompt/context/tool events.

This proves the mech-suit thesis without requiring a full coding-agent clone.

## Success Criteria

V1 succeeds when:

1. A non-coding agent can be built on the runtime without changing runtime internals.
2. A coding-agent-like workflow can be plausibly rebuilt on top of the same runtime.
3. Tools, context intelligence, and session continuity are integrated, not isolated demos.
4. Every implementation phase leaves behind a usable capability.
5. The minimal CLI proves the runtime through public RPC only.
6. The runtime can reboot after interruption/failure without corrupting session state.
7. The first vertical skeleton proves the Prompt Composer, event contract, fake provider, fake tool approval, event log, and reboot semantics before real adapter breadth.
8. The constrained fork can remain the bootstrap runtime until the new dogfood slice demonstrates a credible replacement path.
9. The oh-kernel/custom-tool replacement envelope is explicit enough to guide implementation without inheriting current custom-tool API cruft.

## Open Decisions for Phase Planning

These are intentionally left for implementation plans, not resolved in this shape spec:

- exact package names and directory layout;
- exact local store format;
- exact RPC transport;
- exact provider API coverage for Anthropic and OpenAI-compatible adapters;
- exact first dogfood tool catalog;
- exact prompt profile template contents;
- exact migration path from `packages/coding-agent`.
- exact compatibility-adapter plan for current custom tools and oh-kernel consumers.
