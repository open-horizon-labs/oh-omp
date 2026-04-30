# ADR 0005: Clean-Sheet Mech Suit Runtime

- Status: Accepted
- Date: 2026-04-30
- Decision makers: Harness maintainers

## Context

ADR 0001 adopted a constrained fork of oh-my-pi as the bootstrap runtime. That was the correct near-term choice because immediate dogfooding, process compatibility, event compatibility, and completion signaling were more important than runtime purity.

ADR 0001 also defined a re-evaluation trigger: if the fork patch surface grows beyond a maintainable threshold, pause and consider upstreaming hooks or a deliberate redesign/greenfield runtime.

The current evidence points toward that re-evaluation path:

- upstream `oh-omp` is broad and fast-moving;
- most upstream features do not serve the desired LLM mech-suit shape;
- keeping up with upstream creates maintenance drag;
- the desired architecture centers on a small runtime substrate for LLM agents rather than a feature-rich terminal app;
- UI/TUI behavior should be isolated behind RPC instead of coupled to runtime internals.
- the main replacement use case is the oh-kernel-style runtime role, including custom-tool hosting rather than only built-in tools.

The target is a lean "mech suit" runtime: a clean set of primitives that let LLM agents act coherently over time through provider streaming, tools, custom-tool hosting, approvals, prompt composition, context assembly, local persistence, rebootability, and an RPC command/event boundary.

## Decision

We will design a clean-sheet, replacement-capable agent runtime as the next architectural direction, documented in `docs/superpowers/specs/2026-04-27-lean-mech-suit-design.md`.

This does not immediately retire the constrained fork. The existing fork remains the bootstrap runtime until the new runtime proves a vertical dogfood slice.

The clean-sheet runtime must be:

1. **Runtime-first and UI-decoupled**
   - Runtime behavior is exposed through RPC commands and events.
   - CLI/TUI clients are consumers, not privileged layers.

2. **Prompt-composer centered**
   - The Prompt Composer / Mech Suit OS is the central compiler of environment, intent, memory, tools, policy, and budget into provider-ready requests.
   - Prompt composition must be validated early, not deferred behind generic plumbing.

3. **Streaming and tool-capable from the start**
   - Provider output is normalized into streamed runtime events.
   - Tool schema, approval, invocation, lifecycle events, and observations are core runtime concepts.
   - Custom-tool hosting is a first-class replacement requirement, including schemas, validation, streamed updates, cancellation, lifecycle hooks, pending actions, structured results, and normalized failures.

4. **Rebootable and event-sourced locally first**
   - Sessions are resumable through a local append-only event log.
   - Partial streams, pending approvals, cancellations, and tool observations survive interruption where possible.

5. **Policy-typed, not prompt-only**
   - Prompt profiles may shape model behavior.
   - Autonomy, approvals, tool permissions, stop states, budgets, retry limits, and blocked-state criteria are typed runtime policy.

6. **Phased through useful vertical slices**
   - The first implementation step is a contract spike / vertical skeleton using a fake provider and fake tool.
   - Each phase must leave behind a usable capability and receive its own detailed implementation plan before execution.

7. **Custom-tool compatibility kept outside the kernel**
   - The clean runtime defines the new tool contract.
   - Adapters for current custom-tool APIs may exist in host or migration layers, but must not distort the kernel contract or re-couple UI/TUI internals to runtime behavior.

## Options Considered

### Continue constrained fork only

This preserves compatibility and avoids greenfield risk. It also keeps the team tied to upstream feature breadth and ongoing sync friction. It does not create the desired lean runtime boundary or isolated TUI model.

### Compatibility-shaped rewrite

This would rebuild around current coding-agent surfaces and likely accelerate short-term migration. The risk is importing current conceptual baggage into the new runtime and recreating the fork in cleaner code.

### Clean-sheet runtime without dogfood guardrails

This maximizes design freedom but risks building an elegant parallel framework that never replaces day-to-day work.

### Clean-sheet runtime with vertical dogfood proof

This keeps the architectural direction clean while requiring practical proof before retirement of the bootstrap fork. It best balances long-term runtime shape with near-term operational discipline.

## Consequences

### Positive

- Clear architectural seam between runtime and UI/TUI.
- Runtime primitives can serve non-coding agents and coding-agent-like workflows.
- Prompt composition becomes a first-class system concern rather than incidental prompt assembly.
- RPC event streams provide a stable integration and observability surface.
- Rebootability and persistence become core contracts.
- The constrained fork has an explicit replacement test rather than an indefinite maintenance burden.

### Negative

- Greenfield runtime work creates temporary parallel-system cost.
- The v1 replacement-capable scope is broad and must be aggressively cut by phase.
- Provider, tool, store, prompt, and RPC contracts can freeze too early if the vertical skeleton is not used to learn.
- Migration from `packages/coding-agent` remains a separate planning problem.
- Custom-tool migration is high-risk because existing tools may depend on UI helpers, process helpers, lifecycle callbacks, pending actions, discovery behavior, or renderer hooks.

### Guardrails

1. The constrained fork remains the bootstrap runtime until the clean-sheet runtime proves a streamed, tool-using, resumable dogfood slice over public RPC.
2. The first phase must be a fake-provider/fake-tool vertical skeleton that validates command/event shape, prompt composition, event persistence, replay, approvals, and reboot semantics.
3. Before broad implementation, create an oh-kernel/custom-tool replacement envelope that classifies current custom-tool semantics as kernel contract, compatibility-adapter concern, or intentionally dropped behavior.
4. Real provider breadth must not block the initial contract spike.
5. Prompt profiles must not encode runtime governance that belongs in typed policy.
6. V1 proves one concrete coding-agent-like workflow; it does not claim full `packages/coding-agent` parity.
7. Every implementation phase requires a detailed plan before execution.
8. Custom tools must be proven through the vertical skeleton with streamed updates, cancellation semantics, approval handling, structured results, and no direct TUI dependency.

## References

- `docs/adr/0001-constrained-fork-strategy.md`
- `docs/superpowers/specs/2026-04-27-lean-mech-suit-design.md`
