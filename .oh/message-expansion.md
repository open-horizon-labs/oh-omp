# Session: message-expansion

## Aim
**Updated:** 2026-03-28

**Aim:** The agent can retrieve the full content of any compressed, stubbed, or dropped message when the warm summary isn't sufficient — without blindly re-running tools.

**Current State:** Once a turn leaves the hot window, the agent sees only the warm stub (`[warm:grep | pattern="foo" | 47 lines]`) or a bare stub (`[ref:edit]`). To get the full content, the agent re-runs the tool — which may produce different results if files changed, wastes a tool call, and breaks the agent's reasoning about historical state.

**Desired State:** The agent retrieves the original tool result from storage, sees it was "grep at turn 47 found X", and decides whether to re-run based on what changed since. No blind re-runs. Historical context is recoverable, not lost.

### Mechanism
**Change:** Message expansion tooling that retrieves full original content from the recall store (LanceDB) where all messages are already ingested with embeddings, turn numbers, tool names, and paths.
**Hypothesis:** The data is already stored — what's missing is a retrieval path the agent can invoke during reasoning. Adding a tool or expanding the `recall` tool to support turn-indexed lookup bridges the gap.
**Assumptions:**
- The ingest pipeline stores full tool result text (not truncated) — needs verification
- LanceDB recall store retains data across sessions
- Retrieval by turn index or tool call ID is efficient enough for inline use
- Edit results (currently skipped by warm codec) are the primary beneficiary — once expansion exists, we can compress edits too

### Feedback
**Signal:** Edit tool results get warm-compressed (currently 44 stubbed). Agent stops re-running tools it already ran when the warm stub is sufficient + can expand when it isn't.
**Timeframe:** Immediate — observable in first session after implementation.

### Guardrails
- Don't build a general-purpose message browser — just retrieval by turn/toolCallId
- Don't change the ingest pipeline unless it's dropping data we need
- Expansion is a tool call, not automatic — the agent decides when to expand
- The warm stub must remain the default; expansion is the escape hatch

## Execute
**Updated:** 2026-03-28
**Status:** complete

### Changes
- `packages/coding-agent/src/context/recall/store.ts`: Added `filterByTurn()` — direct WHERE clause on turn + session_id
- `packages/coding-agent/src/tools/recall.ts`: Added `turn` parameter to schema, `#expandTurn()` method for turn-indexed lookup
- `packages/coding-agent/src/context/assembler/codecs/warm-codec.ts`: Removed edit skip — warm codec is now universal
- `packages/coding-agent/src/context/assembler/message-transform.ts`: Generalized `extractToolCallPath` → `extractToolCallInfo` exposing full args via `CodecContext.toolCallArgs`

### Verification
- Build clean (bun check:ts passes)
- Warm codec: edits no longer skipped (44 stubbed → 0 expected)
- Recall tool: `recall({ turn: 47 })` retrieves full original content from LanceDB