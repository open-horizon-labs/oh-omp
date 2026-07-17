# Successor Agent Kernel Moved

The successor implementation, standalone scaffold, and active canonical fixtures are retired from this repository.

The sole authoritative repository is now:

```text
https://github.com/open-horizon-labs/successor-agent-kernel
```

## Authority chain

```text
source cut C0:            f72b95dc763f06765ea83d82251f0f11e834fa06
destination candidate C: f8196dd6b252ca70edf3bc04112ca352b43bafad
source retirement R:     68d634f07e85f90baa0f2c747fd0620f18433452
destination activation A: 3ca83ee79ac8604650b7132f75b98d31c4611ef6
destination evidence B:   f793639ecaecea62b801236445239df3dddce445
```

Authority state: `destination_authoritative`.

All successor implementation changes, fixtures, issues, reviews, and releases belong only in the destination repository. Do not restore or modify the retired successor source, scaffold, or active fixtures here.

The concrete authority record is retained at:

```text
docs/extraction/successor-agent-kernel/authority-record.v0.json
```

## Verification status

`bun check:rs` passes after retirement and after this governance follow-up. `bun check` remains blocked by nine pre-existing Biome diagnostics; GitHub-reporter output is identical at pre-G base `8b1143af7da2286b28670c63c9185fb2d8682b03` and this G worktree:

- `packages/ai/test/tool-argument-coercion.test.ts`;
- `packages/coding-agent/src/context/assembler/message-transform.ts`;
- `packages/coding-agent/src/modes/components/status-line.ts`;
- `packages/coding-agent/src/sdk.ts`;
- `packages/coding-agent/src/session/agent-session.ts`;
- `packages/coding-agent/src/tools/grep.ts`;
- `packages/coding-agent/test/effective-context-window.test.ts`;
- `packages/coding-agent/test/message-transform.test.ts`;
- `packages/coding-agent/test/task/workstream-subagents.test.ts`.

G changes only this pointer and the copied authority record. It does not modify any failing TypeScript path.

Retained ADRs and extraction records in this repository are historical/governance evidence, not a second mutable implementation. Governance-only corrections must not restore successor implementation authority.
