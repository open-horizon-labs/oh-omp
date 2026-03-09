# Session: infinite-context

## Aim
**Updated:** 2026-03-09

### The Core Insight

The context window is not a cache. It is not a performance optimization. It is the agent's **entire reality**. The agent has no memory -- it has no subjective continuity between turns. Each turn, it is born into whatever world the context window describes, does its work, and ceases to exist. The next turn, a new agent is born into whatever world the *next* context window describes.

There is no "remembering." There is only "being told." The assembler doesn't help the agent remember -- it **constructs the agent's world**. A well-assembled context produces a competent, oriented agent. A poorly-assembled one produces a confused, amnesiac agent that wastes the user's time re-establishing what it should already know.

**Context quality = agent cognition quality = user experience quality.** They are the same thing measured at different points in the chain.

### Aim Statement

**Aim:** Every turn, the agent inhabits a world that makes it competent at what the user needs right now.

**Current State:** The agent's world is constructed by brute-force replay -- full conversation history shoved into the window until it doesn't fit, then legacy compaction summarizes and discards. The agent goes from omniscient (early turns, everything fits) to amnesiac (late turns, compaction destroyed causal context). The user experiences this as: "Why did you forget what you just did? Why are you reading files you already read? Why are you re-discovering decisions we already made?"

**Desired State:** The agent's world is constructed by *curation* -- each turn, the assembler selects the fragments of reality the agent needs to be competent at this specific moment. Turn 200 feels like turn 5 because the world the agent inhabits at turn 200 is just as coherent, just as informationally complete for the task at hand. The user never notices the mechanism. The agent just *knows*.

### Mechanism

**Change:** Replace brute-force replay with curated world construction. The assembler becomes the agent's reality engine -- deciding not what to "cache" but what to *make real* for each turn.

**Hypothesis:** The illusion of infinite context is achievable because the agent's per-turn information need is sparse. It doesn't need the whole history -- it needs the right 5-10% of history, precisely selected and coherently presented. A 200K window filled with the right 20-30 fragments produces a more competent agent than the same window filled with 200 turns of raw replay.

**The mechanism has three parts:**

1. **Observation** (bridge) -- as tool results flow, capture what happened, what it means, what changed. Not the raw output -- the *significance*.
2. **Curation** (kernel + scoring) -- each turn, select the fragments that make the agent competent for *this* turn. Relevance is not "recency" -- it's causal adjacency. The file edit from turn 12 matters at turn 201 if the current error traces back to it.
3. **World construction** (message transform + hydration) -- assemble the selected fragments into a coherent world. Not a list of facts -- a *narrative* the agent can inhabit. "You edited X because of Y, then discovered Z, which led to the current task."

**Assumptions:**
- Per-turn information need is genuinely sparse (~5-10% of session history). If the agent needs 80% of history every turn, curation can't help.
- Causal adjacency is computable from locator metadata (file paths, symbols, timestamps, tool types) without embeddings. We don't need semantic similarity -- we need structural relatedness.
- The agent's competence degrades gracefully with imperfect curation -- a slightly wrong world is better than a truncated one.

### Feedback

**Signal:** The user never says "you forgot" or "we already did that." Measurably:
1. **Zero re-brief turns** -- after any context pressure event, the agent continues without asking "what were we doing?"
2. **No redundant tool calls** -- the agent doesn't re-read files it already read, re-grep for patterns it already found, re-discover decisions already made.
3. **Causal chain intact** -- at turn N, the agent can reference and build on work from any prior turn, not just the last 3.

**Timeframe:** Observable within 3 real dogfood sessions of 50+ turns each.

### Guardrails

- **The assembler constructs worlds, not caches.** Every design decision evaluated by: "does this make the agent more competent at this turn?" not "does this save tokens?"
- **Protocol compatibility is hard.** The world-construction layer is additive. Event names, lifecycle, completion signaling untouched.
- **Latency is part of UX.** World construction must complete in <2s. A perfect world delivered slowly is still a bad experience.
- **No external dependencies.** The reality engine is in-process, local-first. No vector DBs, no embedding APIs. File I/O and locator recipes.
- **Legacy is not a concern.** All work targets the assembler. Legacy context management can be removed at will — no backwards compatibility requirement.

### Engineering Decomposition

| Layer | Current (V0.3) | Target (10x) |
|---|---|---|
| **Retriever** | Stub: returns `[method] path :: key` | Real: reads artifacts from disk, re-executes grep/find/LSP recipes |
| **STM distillation** | None: paths/symbols accumulate forever | Distill per-N-turns: compress old paths/symbols into summarized records |
| **LTM promotion** | None: nothing persists across sessions | Promote stable learnings (architecture decisions, file layout, patterns) |
| **WM rebuild** | Shallow: copies STM arrays verbatim | Hypothesis-driven: tracks active hypotheses, next actions, causal chain |
| **Scoring** | Works but context-blind | Semantic: weight by causal adjacency to current error/task, not just path overlap |
| **Hot window** | Fixed 3 turns, hard cutoff | Adaptive: expand for complex multi-step tasks, shrink for simple queries |
| **Message transform** | Binary: keep or stub | Graduated: full content -> summary -> stub -> drop, based on relevance |
| **Locator eviction** | FIFO at 500 cap | Score-based: evict lowest-relevance entries, preserve high-value ones |
| **Format** | Flat XML fragments | Structured: group by task/file, annotate with provenance and freshness |
| **Telemetry** | Shadow logging only | Decision trace: per-turn report of what was kept, why, what was dropped |

### Sequencing (fork issues #16-20)

Critical path: **#19 -> #16 -> #17 -> #18 -> #20**, with #6 running in parallel as validation.

1. **#19 Kernel hydration scaling** -- real retriever, concurrent artifact reads, budget-aware truncation
2. **#16 Conversation bounding** -- adaptive hot window + graduated message transform
3. **#17 WM rebuild** -- hypothesis tracking, causal chain, next-action inference
4. **#18 STM distillation** -- compress accumulated paths/symbols, promote stable entries
5. **#20 LTM promotion** -- cross-session persistence, stable knowledge extraction
6. **#6 Success gate evaluation** -- eval harness proving assembled world beats brute-force replay
7. **New: Locator eviction policy** -- score-based eviction replacing FIFO
8. **#7 Hard cutover** -- remove legacy context management once success gate passes

### Definition of Done

Done is not "the retriever reads real files." Done is "the user can't tell the agent has a finite context window."


## Problem Space
**Updated:** 2026-03-09

### Objective

We are optimizing for: **the agent's per-turn competence as a function of its assembled world**. The agent either knows what it needs to know right now, or it doesn't. Everything else is mechanism.

### Verified Ground Truth

Assumptions from the aim were verified against the actual codebase. Here's what's real:

**1. Bridge classification: WORKING.**
- `classify.ts` has a complete `TOOL_CATEGORY_MAP` covering all builtin and hidden tools.
- Deterministic, rule-based: tool name -> category (lookup/read/mutation/execution/control/subagent) + trust level + retrieval method.
- Extracts touched paths and symbols from tool args. Tracks errors as unresolved loops.
- Path invalidation works: mutations invalidate locators referencing edited paths.
- No MCP tool coverage — only builtin tools are classified. MCP tools hit the default fallback (`execution`/`heuristic`).

**2. Artifact persistence: PARTIALLY WORKING.**
- `ArtifactManager` (`session/artifacts.ts`) exists and persists tool results to `~/.oh-omp/sessions/<id>/artifacts/<artifact-id>.txt`.
- `allocateOutputArtifact()` is called by bash, fetch, python, render_mermaid, ssh — tools that produce large/truncated output.
- Bridge extracts `artifact://<id>` references from result strings and stores them in locator params.
- The composite retriever can resolve artifacts via `ArtifactResolver`.
- **Gap: not all tool results are artifacts.** Small results (read, grep, lsp, edit) stay only in conversation messages. If those messages get stubbed by the message transform, the content is gone — there's no artifact to hydrate from.

**3. Distillation: DOES NOT EXIST.**
- Zero distillation code in the assembler. The word appears only in comments about future work.
- STM grows unboundedly — `touchedPaths` and `touchedSymbols` arrays only accumulate, never compress.
- No summarization, no knowledge extraction, no background processing.
- memex-core has a full distillation pipeline (LLM-powered, async, simhash-gated). This is a potential reference implementation.

**4. Hydrator: STUB.**
- `hydrateLocators()` exists and is wired into the kernel. But the composite retriever's `resolve()` returns synthetic one-liners (`[method] path :: key`), not real content.
- The retriever architecture supports full content retrieval (file reads, artifact reads, grep re-execution). The stub just doesn't use it.
- The user's correction: **hydration should return complete tool results, not fragments.** Budget management is a selection problem (which locators to hydrate), not a truncation problem (how to fragment each result). If a result doesn't fit, don't include it — or rerun the tool with narrower scope.

### Two Codebases, One Problem

**oh-my-pi assembler** has the architecture but not the engine:
- Locator map model (addresses + retrieval recipes). Correct design.
- Bridge (observe, classify, produce locator entries). Working.
- Scoring (recency decay, path/symbol overlap, diversity). Working but context-blind.
- Message transform (binary keep-or-stub, 3-turn hot window). Too coarse.
- Hydrator. Stub.
- STM. Unbounded accumulation.
- LTM. Doesn't exist.
- WM. Copies STM arrays.

**memex-core** has the engine but different integration assumptions:
- LLM-powered distillation (extract knowledge, embed, store in LanceDB).
- SimHash change detection (cheap gating for expensive operations).
- ContextSpace budget allocation (named sections with weights, proportional allocation).
- Background re-distillation (async, non-blocking, in-flight guards).
- Semantic search via LanceDB with MMR diversity reranking.
- Module system for extensible context contributions.

**repo-native-alignment (RNA)** has semantic code understanding:
- `search_symbols` — find functions, structs, classes by name/signature across Rust/Python/TypeScript/Go.
- `graph_query` — trace call graphs, dependencies, impact analysis.
- Already integrated into oh-my-pi via MCP server.
- Could serve as the semantic search layer for scoring — structural code relatedness without embeddings.

### Constraints

| Constraint | Type | Reason | Questionable? |
|---|---|---|---|
| No external dependencies (no vector DB, no embedding API) | hard | In-process, local-first, latency | Partially — RNA MCP is already external. If we treat MCP servers as part of the harness (they are), RNA's search is available without new deps. |
| Protocol compatibility (events, lifecycle, completion) | hard | ADR 0001/0002, downstream orchestrators | No |
| <2s wall-clock per turn for assembly | hard | UX | No |
| TypeScript/Bun runtime | hard | oh-my-pi is Bun | No — but memex patterns can be ported |
| Legacy must remain functional | ~~hard~~ **removed** | User correction: all work targets assembler, legacy can be removed | N/A |
| No LLM calls in assembly hot path | soft | Latency | **Yes** — distillation can be async/background (between turns), not in the assembly path. memex-core proves this works. |
| Retrieval must re-execute recipes | assumed | ADR 0003 locator model | **Yes** — re-executing grep/LSP at hydration time is non-deterministic (files change). Better: persist complete results at bridge time, read from cache at hydration time. Rerun only if cache is stale. |

### Assumptions Verified

1. **Per-turn info need is sparse (~5-10%).** Believed true for coding tasks — most turns touch 1-3 files. Not yet measured.
2. **Structural relatedness sufficient for scoring.** Can be strengthened by coupling with RNA's code graph (call chains, dependency edges) — gives causal adjacency without embeddings.
3. **Bridge classification accurate.** VERIFIED — deterministic, comprehensive for builtins. Gap: MCP tools fall to default. Fixable.
4. **Artifact persistence working.** PARTIALLY VERIFIED — large outputs are persisted. Small tool results (read, grep, lsp) are NOT persisted as artifacts. This is the critical gap: the assembler can't hydrate what was never stored.
5. **Distillation keeps up.** NOT APPLICABLE — no distillation exists. Must be built. memex-core's simhash-gated background approach is the reference.
6. **Complete results, not fragments.** User correction: hydrate full tool results on demand. Budget is a selection problem, not truncation. Can always rerun tools if cached result is stale or missing.

### The Critical Gap

The single biggest blocker is **assumption 4**: small tool results are not persisted. The bridge creates locator entries for every tool call, but only large/truncated results get artifact files. When the message transform stubs an old turn's tool results, the content of small results (which is most of them — read, grep, lsp, edit) is destroyed with no way to recover it.

This means the hydrator *cannot work* even if it were fully implemented — there's nothing to hydrate from for the majority of tool calls.

The fix is straightforward: the bridge must persist every tool result at observation time, not just truncated ones. Store complete results keyed by locator entry. Then hydration is just a file read.

### X-Y Check

- **Stated need (Y):** 10x assembler performance, infinite context illusion
- **Underlying need (X):** The agent never loses track of what it's doing, what it did, or why
- **Confidence:** High that Y=X. But watch for scope creep toward "store everything" when the real lever is "select better and hydrate completely."

### Ready for Solution Space?

**Yes.** The terrain is mapped. The critical gap (no persistence for small tool results) and the critical correction (complete hydration, not fragments) reframe the sequencing. The path is:
1. Persist all tool results at bridge time (unblock hydration)
2. Replace hydrator stub with real retrieval (file reads from cache)
3. Graduate message transform (adaptive, not binary)
4. Wire RNA for semantic scoring (causal adjacency via code graph)
5. Add distillation (background, simhash-gated, memex-core patterns)
6. Build STM compression and LTM promotion

## Solution Space (Final)
**Updated:** 2026-03-09

### Revision History

1. Original: Option C (pipeline + world framing) — scoring, graduated transform, hydration.
2. Dissent surfaced locator-index alternative — model curates itself.
3. Converged on: LanceDB + memex embeddings + recall tool.
4. Refined: passive hydration (auto-injected) + active recall (model-driven).

### Architecture: Passive Hydration + Active Recall

**Core insight:** The context window is the agent's entire reality. Human memory is not
pre-loading — it's association and retrieval. But humans also don't start each task with a
blank mind. Relevant context surfaces automatically (passive), and you can deliberately
search for more (active).

**Two layers:**

**Layer 1: Passive Hydration (automatic, every turn)**
- Take the hot window text (last 3-5 turns)
- Embed it via memex proxy
- Compare embedding to last turn's cached embedding (cosine similarity)
- If changed enough: search LanceDB for semantically similar past content (all message types)
- Select top-K results with **MMR diversity reranking** (avoid near-identical results)
- Auto-inject into context as hydrated content
- If not changed enough: reuse cached results (no embed call, no search)

The conversation itself is the query. No heuristic decides what's relevant — semantic
similarity to the current conversation does. Because all message types are stored, passive
hydration returns full causal chains: the user's request + the agent's reasoning + the tool
results that followed.

**Layer 2: Active Recall (model-driven, on demand)**
- `recall(query, limit?)` tool — semantic search over LanceDB, returns full results
- The model uses this when passive hydration isn't enough
- "I remember doing something with that config file" → `recall("config file changes")`

**Context layout per turn:**
```
[System prompt]
[Passively hydrated context — top-K MMR-diverse results matching current conversation]
[Hot window — last 3-5 turns, full messages]
[Current message]
[Tools: recall(query) for deeper search]
```

The model never starts from zero. Passive hydration ensures relevant past work is
present before the model even thinks about recalling. Active recall is the escape hatch
for when passive hydration misses something.

### Embedding: Memex Proxy

Single HTTP call to `memex-embed.ohlabs.ai`. Qwen3-Embedding-4B, 2560-dim vectors.
Requires a valid memex license. No daemon, no fallback chain, no local models.

Shared embedding space with memex — same model, same dimensions. Future option:
cross-system queries. Not required now, architecturally free.

### Efficiency: SimHash/Cosine Cache

Most turns, the hot window barely changes (user said one thing, model did one thing).
Cosine similarity between this turn's hot window embedding and last turn's gates re-search.
Cache hit = no embed call, no LanceDB search. Only when conversation shifts meaningfully
does the search re-fire. Memex proves most turns are cache hits.

### Ingest Pipeline

**All three message types are stored in LanceDB:**
- **User messages** — intent, requirements, corrections, constraints
- **Assistant messages** — reasoning, decisions, explanations, hypotheses
- **Tool results** — what actually happened (file contents, grep hits, errors, edits)

Each as a row with metadata: turn number, message role, associated file paths/symbols
(bridge classification for tool results, extracted from text for user/assistant).

Why all three: a recalled tool result without the user message that motivated it and
the assistant reasoning that explained it is an orphaned fact. "You edited auth.ts" is
useless without "because the user reported session expiry under load" and "you chose a
mutex over retry logic because of the read-heavy access pattern."

**Ingest steps:**
1. As messages flow through the conversation, persist each to disk
2. Embed via memex proxy (async, non-blocking)
3. Store in LanceDB: vector + full text + metadata (role, turn #, paths, symbols)

### What Stays

- **Bridge** — observes, classifies, extracts paths/symbols. Now also embeds + stores to LanceDB.
- **Hot window** — last few turns as full messages. Unchanged.
- **Message transform** — stubs old tool results. Now safe because passive hydration + recall
  can recover anything that was stubbed.

### What Gets Removed

- Scoring pipeline (recency, path overlap, diversity — replaced by embedding similarity + MMR)
- Hydrator stub (replaced by passive hydration + recall tool)
- Locator eviction (LanceDB handles storage)
- External curation logic in kernel
- Legacy compaction, memory summaries, dual-path code

### Memory Tiers (Emergent)

- **WM** = hot window (current conversation, last few turns)
- **STM** = passive hydration (auto-selected by semantic similarity to hot window, with MMR)
- **LTM** = full LanceDB (all sessions, queryable via recall tool)

Cross-session persistence is free — LanceDB is a directory on disk.

### Implementation Sequence

**Phase 1: Ingest**
1. Persist ALL messages (user, assistant, tool results) to disk
2. Embed each via memex proxy (async, non-blocking)
3. Store in LanceDB: vector + full text + metadata (role, turn #, paths, symbols)

**Phase 2: Passive Hydration**
4. Each turn: embed hot window text, cosine-compare to cached embedding
5. On change: search LanceDB, MMR-rerank, select top-K
6. Inject into context before hot window
7. Cache results + embedding for next turn's comparison

**Phase 3: Active Recall**
8. Implement `recall(query, limit?)` tool
9. Semantic search over LanceDB with MMR
10. Wire into agent's tool set

**Phase 4: Remove Dead Code**
11. Remove legacy compaction, memory summaries
12. Remove scoring/hydration/eviction pipeline
13. Assembler's only job: hot window + passive hydration injection + message stubbing

**Phase 5: Refinement**
14. Tune K (how many results to passively inject)
15. Tune MMR lambda (diversity vs relevance balance)
16. Tune cosine similarity threshold for cache invalidation
17. Cross-session queries (query past sessions' LanceDB stores)
18. Background session summary (LLM-distilled, async, optional)

### Prerequisites

- Valid memex license in agent config
- `@lancedb/lancedb` TypeScript client
- All messages (user, assistant, tool results) persisted and embedded

### Guardrails

- **Memex license required.** No license = no embeddings = no hydration = no recall. Fail closed.
- **Embedding is off the hot path.** Embed async at bridge time. If slow, store without vector,
  embed later. Passive hydration uses whatever is in LanceDB at query time.
- **Protocol compatibility unchanged.** recall is a new tool. Passive hydration is context injection.
- **Hot window is the safety net.** Recent turns always in context regardless of hydration state.
- **MMR is not optional.** Without diversity reranking, passive hydration degenerates into
  returning N near-identical results. MMR is load-bearing.

### Definition of Done

The user can't tell the agent has a finite context window. Passive hydration keeps the
agent oriented. Active recall lets it dig deeper. A 200-turn session feels like a 5-turn session.

## Implementation Map
**Updated:** 2026-03-09

### KEEP (still needed)

| File | Role | Change |
|---|---|---|
| `bridge/bridge.ts` | Observation loop — watches tool events, extracts paths/symbols, tracks errors | Modify: also ingest all messages into LanceDB |
| `bridge/classify.ts` | Tool classification (category, trust, retrieval method) | As-is — metadata for LanceDB rows |
| `bridge/types.ts` | `ResultProfile`, `ToolCategory`, `LocatorEntry` types | As-is — locator entries become LanceDB row metadata |
| `context-manager/index.ts` | Mode switching (legacy/shadow/assembler) | Simplify: remove legacy/shadow, keep assembler as sole mode. Eventually delete mode concept. |
| `memory-contract.ts` | `MemoryContract` (STM/WM/locator map) | Modify heavily: STM becomes recent metadata, locator map becomes LanceDB table schema |
| `extract-paths.ts` | Extracts file paths from text | As-is — useful for metadata on user/assistant messages |
| `assembler/message-transform.ts` | Stubs old tool results in conversation | Keep — hot window stays as messages, old turns get stubbed. Safe now because hydration + recall recover anything. |
| `assembler/types.ts` | Budget types, `AssemblerTurnInput`, `AssembledPacket` | Modify: `AssembledPacket` becomes simpler (hydrated LanceDB results, not scored fragments) |
| SDK integration (`sdk.ts` ~lines 1400-1520) | `transformContext` function | Rewrite: embed hot window -> cache check -> LanceDB search -> MMR -> inject |

### REMOVE (replaced by LanceDB + recall)

| File | Reason |
|---|---|
| `assembler/scoring.ts` | Entire scoring pipeline (recency decay, path overlap, diversity, spatial clustering). Replaced by embedding similarity + MMR. |
| `assembler/hydrator.ts` | Stub hydrator + composite retriever. Replaced by LanceDB retrieval + recall tool. |
| `assembler/format.ts` | XML fragment formatting. Replaced by direct injection of LanceDB results. |
| `assembler/kernel.ts` | Orchestrates scoring, selection, hydration, budget. Entire pipeline replaced. New "kernel" is ~50 lines: embed -> search -> MMR -> inject. |
| `bridge/retriever.ts` | `CompositeRetriever`, `ArtifactResolver`, `FileRetriever`, `StubRetriever`. All replaced by LanceDB reads. |
| `context-manager/telemetry.ts` | Telemetry for old mode system. Remove with the mode system. |
| Legacy compaction code | Memory summaries, compaction logic, dual-path code. All legacy context management. |

### NEW (to build)

| Component | What | Reference |
|---|---|---|
| LanceDB store | Table schema, init, write, search. Rows: vector + full text + metadata (role, turn, tool, paths, symbols) | `@lancedb/lancedb` TypeScript client |
| Memex embed client | `embed(text: string): Promise<Float32Array>`. Single HTTP call to memex proxy. | memex-core `hosted.rs` for protocol |
| Ingest pipeline | Hook into bridge + message flow. Persist + embed + store every message. Async, non-blocking. | memex-core `distill/tool_result.rs` for patterns |
| Passive hydration | Per-turn: embed hot window -> cosine compare to cache -> on miss: search LanceDB with MMR -> inject | memex-core `assembler.rs` + `cache.rs` |
| Cosine cache | Last turn's hot window embedding + search results. Invalidate on significant change. | memex-core `cache.rs` + `simhash.rs` |
| `recall` tool | Agent tool. `recall(query, limit?)` -> embed -> LanceDB search with MMR -> return full results | New, straightforward |
| MMR reranker | Maximal Marginal Relevance. ~50 lines. | Port from `memex-storage/src/context.rs` |

### Counts

- 6 files removed
- 5 files/integration points modified
- 7 new components to build
- 2 files kept as-is

## Plan
**Updated:** 2026-03-09
**Issues:** #42, #43, #44, #45, #46

| # | Issue | Phase | Depends On |
|---|---|---|---|
| [#42](https://github.com/open-horizon-labs/oh-omp/issues/42) | Recall foundation: LanceDB store, memex embed client, MMR reranker | 1: Foundation | -- |
| [#43](https://github.com/open-horizon-labs/oh-omp/issues/43) | Ingest pipeline: persist and embed all messages into LanceDB | 2: Ingest | #42 |
| [#44](https://github.com/open-horizon-labs/oh-omp/issues/44) | Passive hydration: auto-inject relevant past context each turn | 3: Hydration | #43 |
| [#45](https://github.com/open-horizon-labs/oh-omp/issues/45) | Recall tool: active session history search for the agent | 3: Recall | #42 |
| [#46](https://github.com/open-horizon-labs/oh-omp/issues/46) | Remove dead code: scoring, hydration, legacy context management | 4: Cleanup | #44, #45 |

**Parallelism:** #44 and #45 can run in parallel (both depend on #42, not on each other).