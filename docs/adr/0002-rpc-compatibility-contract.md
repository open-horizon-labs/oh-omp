# ADR 0002: RPC Compatibility Contract for External Orchestrators

- Status: Accepted
- Date: 2026-03-05
- Decision makers: Harness maintainers

## Context

ADR 0001 established a constrained-fork strategy. The key risk is accidental protocol drift between this runtime and external orchestrators that spawn it as a child process.

Downstream systems in ai-omnibus depend on stable process and event semantics, including:

- JSON-lines RPC process integration,
- extension UI request/response envelopes,
- tool execution lifecycle events,
- completion payload extraction via `signal_completion` on `tool_execution_end`.

Without an explicit compatibility contract, upstream merges or local refactors can silently break integration.

## Decision

We define a versioned RPC compatibility contract and enforce it in code via shared constants and tests.

### Contract surface (v1)

1. **Agent event set forwarded over RPC client API** remains stable for orchestrators:
   - `agent_start`
   - `agent_end`
   - `turn_start`
   - `turn_end`
   - `message_start`
   - `message_update`
   - `message_end`
   - `tool_execution_start`
   - `tool_execution_update`
   - `tool_execution_end`

2. **Extension UI envelope tags** remain stable:
   - agent → host: `extension_ui_request`
   - host → agent: `extension_ui_response`

3. **Completion tool name marker** remains stable:
   - `signal_completion`

4. **Compatibility version marker** is explicit:
   - `RPC_COMPATIBILITY_VERSION = 1`

### Change policy

- Additive changes to internals are allowed.
- Breaking changes to contract surface require:
  1. compatibility version increment,
  2. migration notes,
  3. synchronized orchestrator updates.

## Consequences

### Positive

- Contract-critical tokens are centralized instead of duplicated.
- Tests make drift visible during normal CI/test workflows.
- Upstream sync risk is reduced for fork maintainers.

### Negative

- Slight maintenance overhead when evolving RPC internals.
- Future protocol redesign requires explicit migration choreography.

## Implementation

- Introduce `packages/coding-agent/src/modes/rpc/compatibility-contract.ts` as the canonical contract definition.
- Wire runtime event filtering to use the shared contract validator.
- Add unit tests that assert contract constants and classifier behavior.
