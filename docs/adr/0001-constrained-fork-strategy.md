# ADR 0001: Constrained Fork Strategy for Harness Development

- Status: Accepted
- Date: 2026-03-05
- Decision makers: Harness maintainers

## Context

We need a terminal-native coding agent harness that we can use to build the harness itself.

The immediate objective is not a full "infinite context" platform. The immediate objective is a reliable daily loop:

1. run tasks from terminal,
2. reconstruct relevant context just-in-time,
3. preserve decision continuity across sessions,
4. keep protocol trust and debuggability.

We considered four paths:

1. upstream-only usage with wrapper scripts,
2. constrained fork,
3. deep fork with protocol/runtime changes,
4. greenfield runtime rewrite.

A hard practical constraint is integration compatibility with existing orchestrators in the ai-omnibus environment that spawn oh-my-pi processes and consume event/completion contracts.

## Decision

We adopt a **constrained fork** of oh-my-pi as the bootstrap runtime.

### 1) Protocol compatibility is a hard constraint

We keep compatibility with existing process/event contracts used by downstream orchestrators.

- Preserve event names and event lifecycle semantics.
- Preserve completion signaling semantics (`signal_completion` flow).
- Avoid breaking changes in the RPC/SSE contract without an explicit migration plan.

### 2) Patch scope is narrow and additive

Allowed in the fork:

- Query-time context packet assembly hooks.
- Context provenance/attribution metadata.
- Token/latency budget enforcement around context injection.
- Observability hooks needed to evaluate continuity quality.

Out of scope for bootstrap:

- Broad runtime rewrites.
- Renaming/redefining core event protocol.
- Replacing terminal interaction model before bootstrap loop is proven.

### 3) Upstream sync is policy, not best-effort

- Track upstream regularly (target: weekly sync cadence).
- Keep a small, explicit patch queue.
- Gate sync with compatibility tests for event protocol and completion semantics.

### 4) Re-evaluation trigger

If patch surface grows beyond a maintainable threshold (for example recurring deep edits across many core runtime files), pause and re-evaluate:

- upstreaming required hooks, or
- a deliberate redesign/greenfield runtime.

## Consequences

### Positive

- Immediate terminal runtime with proven agent loop.
- Faster time-to-dogfooding for context-management work.
- Lower bootstrap risk than greenfield runtime.
- Clear path to evolve context behavior without losing operational compatibility.

### Negative

- Ongoing fork maintenance cost (sync + conflict resolution).
- Need for strict discipline to avoid deep-fork drift.
- Some design choices constrained by compatibility contracts.

## Implementation Notes (Bootstrap)

1. Keep this fork compatible by default.
2. Add context injection as an additive layer, not a protocol replacement.
3. Instrument continuity metrics early (re-brief time, context correction rate, continuity success).
4. Only expand scope after measured bootstrap adoption is achieved.
