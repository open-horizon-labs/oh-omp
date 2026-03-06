# Assembler Mode Migration

Migration guide for operators switching from legacy context management to assembler mode.

## Prerequisites

The assembler mode requires the tool-result bridge (issue #11) and assembler kernel (issue #3) to be functional. Both are included in this release.

## Configuration

To activate assembler mode, update your configuration:

```bash
omp config set contextManager.mode assembler
omp config set memories.enabled false
omp config set compaction.enabled false
```

All three settings must be applied. The runtime validates the configuration at startup and will reject conflicting combinations with a clear error.

## What Changes

### Disabled in Assembler Mode

| Legacy Feature | Setting | Effect |
|---|---|---|
| Memory summary injection | `memories.enabled` | `memory_summary.md` is no longer injected into the system prompt |
| Memory startup pipeline | `memories.enabled` | Background memory consolidation does not run |
| Compaction-based context | `compaction.enabled` | Session compaction summaries are not generated |

### Enabled in Assembler Mode

| Feature | Description |
|---|---|
| Tool-result bridge | Observes tool execution and generates locator entries in `MemoryContractV1` |
| Assembler kernel | Scores, ranks, and hydrates locator entries within token/latency budget |
| Per-turn context injection | Assembled context fragments injected as a developer message before each LLM turn |

### Unchanged

- TTSR (tool-triggered state refresh) rules remain active.
- MCP server instructions are still appended to the system prompt.
- Extension `transformContext` hooks compose with the assembler injection.
- Shadow telemetry is not attached in assembler mode (it is shadow-mode only).

## Modes Summary

| Mode | Legacy Active | Assembler Injects | Bridge Observes | Shadow Telemetry |
|---|---|---|---|---|
| `legacy` | Yes | No | No | No |
| `shadow` | Yes | No | Yes | Yes |
| `assembler` | No | Yes | Yes | No |

## Rollback

To revert to legacy mode:

```bash
omp config set contextManager.mode legacy
omp config set memories.enabled true
omp config set compaction.enabled true
```

## Known Limitations

- Some legacy settings (e.g., memory consolidation schedules) become inert under assembler mode. They are not actively harmful but have no effect.
- The assembler's scoring heuristics (especially for bash mutation detection) will be tuned during dogfood (issue #6).
- Temporary mode-specific branching exists until the hard cutover removal issue runs. At that point, legacy code paths will be deleted entirely.
