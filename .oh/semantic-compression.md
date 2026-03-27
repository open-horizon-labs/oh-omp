# Session: semantic-compression

## Aim
**Updated:** 2026-06-12
**Refinement:** "semantic compression" → "context lossless compression" → **"signal-only context."** The goal isn't fitting more into a bigger window. It's needing less window because every token is signal.

### Aim Statement

**Aim:** The agent's context window contains only information that influences its next correct action. Everything else — formatting, stale state, human-readable verbosity, redundant re-reads — is eliminated, not compressed. Less window, not more. The industry expands context windows; we shrink them. A 50K context of pure signal outperforms a 200K context that's 75% noise.

**Current State:** Content enters at whatever verbosity tools produce and stays at that verbosity or drops to zero (opaque stubs). There is no signal/noise separation. A 5000-token file read carries the same weight whether the model needs all of it or just 3 function signatures. Aged content either consumes full space or becomes a useless `[ref]` pointer. The window fills with noise because there's no mechanism to distinguish signal from formatting.

**Desired State:** Every piece of content in the window is there because it contributes to the model's next correct action. Content that was signal when produced but is noise now (stale reads, superseded state, redundant re-reads) is eliminated. Content that was always part-signal-part-noise (source code = structure + formatting) is stripped to the signal component. The context window shrinks to its information-theoretic minimum while the model's behavior is indistinguishable from the uncompressed baseline.

### Mechanism

**Change:** Introduce content-type-aware re-encoding in the message transform pipeline, backed by RNA structural representations for code and rule-based transforms for tool output. Content graduates from full source → structural summary → stub as it ages, with each tier preserving all actionable information from the previous tier.

**Hypothesis:** The gap between "human-readable source" and "minimum information the model needs to act" is 5-11x for code (validated on `message-transform.ts`: RNA compact functions-only = 10.9x vs raw source). This gap exists because source code is optimized for human reading (whitespace, formatting, comments, variable names in context) while the model acts on structure (signatures, types, relationships, line ranges). A lossless re-encoding serves structure where the model needs structure, and reserves source only where the model needs source (active editing).

**Assumptions:**
1. The model can reason over RNA compact output as effectively as source text for orientation/navigation tasks. **UNTESTED — critical assumption.**
2. "Lossless for the model" is operationally defined: same task → same tool calls → equivalent final output. Not bit-identical, but behaviorally equivalent.
3. Mixed-representation context (some turns compressed, some not) does not confuse the model.
4. RNA's structural graph is complete enough that the model doesn't need to fall back to source for understanding (only for editing).
5. Re-encoding latency fits within the assembly time budget (<200ms per turn).

### What "Lossless" Means Here

- **Lossless for model behavior:** The compressed representation contains every fact the model would have extracted from the original. No decision the model makes changes.
- **Lossy for human readability:** You can't reconstruct the original source from the compressed form. Formatting, comments, whitespace — gone. Acceptable because the model is the consumer, not a human.
- **Verifiably lossless:** If you can construct a task where compressed context produces different tool calls than uncompressed context, the compression is broken. This is the eval criterion.

### What This Is

- A **codec for meaning** — compress on write, decompress-by-reading (the model IS the decompressor)
- An **experimental research problem** — we don't know the compression frontier yet
- **Content transformation**, not content selection — everything stays, it just gets denser

### What This Is NOT

- NOT message dropping, pruning, or selection (that's curation — separate problem)
- NOT tool set reduction or system prompt restructuring (those are config changes)
- NOT summarization in the traditional sense (summaries lose detail; compression preserves it)
- NOT lossy in the information-theoretic sense for what the model needs (lossy only for what humans need — formatting, readability)

### Feedback

**Signal:**
1. **Behavioral equivalence rate:** Same tasks run with compressed vs. uncompressed context → % producing identical tool-call sequences. Target: >95%.
2. **Token savings ratio:** `tokens_original / tokens_compressed` for aged content. Target: 3x practical, 5x stretch.
3. **Session longevity:** Number of turns before context exhaustion increases proportionally to savings.

**Timeframe:** Behavioral equivalence requires A/B experiments — first signal within 1-2 weeks of Phase 1 (RNA-first exploration tool). Savings ratio is measurable immediately from token counts.

### Guardrails

- **Behavioral equivalence is non-negotiable.** A 10x compression that changes one tool call is worse than a 1.5x compression that changes nothing.
- **Original content is never destroyed.** Compression is a view transformation in the context window. Original remains in storage. Reversible by re-reading.
- **No external API dependency for compression.** RNA for code, rule-based for everything else. Optional Tier 4 (cheap API model) acceptable but not required.
- **Graduated, not abrupt.** Transition from full→dense→stub configurable per content type. Start conservative (code reads only), expand as equivalence is validated.


### Open Research Questions

1. **What is the compression frontier?** For a given content type (code, reasoning, tool output), what is the minimum token representation that preserves model behavior? Is it 2x? 5x? 10x? Does it vary by content type?

2. **Who compresses?** Options:
   - **Rule-based transforms** — fast, predictable, limited ceiling (strip anchors, collapse whitespace, remove boilerplate headers). Maybe 2-3x.
   - **LLM-as-compressor** — a smaller/faster model compresses content for the main model. Higher ceiling (5-10x?) but adds latency and cost. Amortized if compression is done once and result persists.
   - **Hybrid** — rule-based for structural noise, LLM for semantic density. Best of both?

3. **How do we evaluate?** Compression is only good if the model behaves the same. Need an eval framework:
   - Same task, compressed vs. uncompressed context → same tool calls? Same final output?
   - At what compression ratio does behavior diverge?
   - Does it degrade gracefully or cliff?

4. **Is the model a good decompressor?** Frontier models are trained on natural language. Compressed representations (terse, abbreviated, structured) might be *harder* for them to parse than verbose natural language. Or they might be better — less noise, more signal. Unknown.

5. **Does compression compose?** If you compress turn 5, then compress turn 10, does the model handle a conversation of mixed compressed/uncompressed turns? Or does compression need to be all-or-nothing?

6. **Content-type-specific codecs?** Code, tool results, reasoning, and error messages likely have very different compression profiles. A grep result compresses differently than an LSP hover result. Do we need per-type compressors?

### Researched Landscape

**Tier 0: Pure rule-based (no model, deterministic, zero cost)**
- Pattern replacement ("Could you explain" → "explain", hedging removal)
- Whitespace/formatting normalization, structural boilerplate removal
- N-gram abbreviation for recurring patterns (CompactPrompt)
- Numeric quantization for floating-point data
- Ceiling: ~22-30% reduction (~1.3x). Fast, predictable, no dependencies.

**Tier 1: Lightweight model scoring (BERT-level encoder, no LLM)**
- **Selective Context** (Li et al. 2023) — self-information scoring via Shannon entropy. Compute per-token information content, drop low-information tokens. Phrase-level filtering most effective.
- **CompactPrompt** (2025) — self-information + dependency-based phrase grouping + n-gram abbreviation. End-to-end pipeline.
- **LLMLingua-2** (ACL 2024) — BERT-level encoder trained via distillation from GPT-4 for token classification. Task-agnostic. 3-6x faster than LLMLingua-1.
- Ceiling: ~2-5x compression. BERT-base runs in <100ms on CPU. Could run in Bun via ONNX runtime.
- **This is the sweet spot for our constraints.** Fast, cheap, no API calls, deterministic.

**Tier 2: Small LLM scoring (GPT-2-small 125M / LLaMA-7B)**
- **LLMLingua** (EMNLP 2023, Microsoft) — uses GPT-2-small or LLaMA-7B perplexity for coarse-to-fine token pruning. Budget Controller (sentence-level) → Iterative Token Compression → Distribution Alignment.
- **LongLLMLingua** (ACL 2024) — optimized for long context. 94% cost reduction on LooGLE benchmark. 1.4x-2.6x latency improvement at 2-6x compression.
- Results: **20x compression with only 1.5% performance loss** on GSM8K. Up to 20x on reasoning benchmarks.
- GPT-2-small (125M params) runs on M1 Max CPU. LLaMA-7B needs quantization or GPU.
- Interesting for our case: GPT-2-small is small enough to embed in-process.

**Tier 3: Full LLM / trained compressor (defeats purpose unless amortized)**
- **RECOMP** (ICLR 2024) — extractive + abstractive compressors. 5-10% compression on QA datasets. Trained via contrastive learning + symbolic distillation.
- **500xCompressor** (Li et al. 2024) — compresses into special tokens. 6-480x but requires model modification.
- **Gist tokens / AutoCompressors** — learned compressed representations. Require fine-tuning.
- These add cost and complexity. Only viable if compression is done once and cached.

**Tier 4: Cheap API model as compressor**
- Economics: Gemini Flash-Lite at ~$0.075/1M vs. Claude Sonnet at ~$3/1M = 40:1 ratio.
- Even a 2x compression ratio is economically positive at this price gap.
- At 5x compression: spend $0.075 to save $2.40 = 32x ROI.
- But: adds latency (API roundtrip), external dependency, non-deterministic.

### Key Findings

1. **LLMLingua with GPT-2-small is the most promising precedent.** 20x compression, 1.5% quality loss, small enough model to run locally. The question is whether it works for code/tool-output (benchmarked mostly on natural language).

2. **BERT-level self-information scoring is the practical floor.** 2-5x compression, runs in milliseconds, no API dependency. CompactPrompt and Selective Context prove this works.

3. **Rule-based transforms have a low ceiling but are free.** ~1.3x. Worth doing as a baseline layer but won't get near 10x alone.

4. **The cheap-API-model route has compelling economics** but violates the local-first / no-external-dependency constraints. Could be an optional tier.

5. **Nobody has benchmarked these on agentic coding loops specifically.** All prior art is on NL benchmarks (GSM8K, BBH, QA datasets, RAG). Code, tool results, and multi-turn reasoning chains are uncharted territory. This is where the research value lies.

### Feedback

**Signal:** For a fixed set of representative tasks:
1. Compression ratio: tokens_original / tokens_compressed (target: 10x aspirational, 3x practical floor)
2. Behavioral equivalence: compressed context produces identical tool calls and equivalent final output
3. Compression latency: time to compress per message (must not dominate assembly time)

**Timeframe:** This is research. Signal comes from experiments, not production metrics. First experiments within a week. Compression frontier characterization within a month.

### Guardrails

- **Behavioral equivalence is the only metric that matters.** A 100x compression that changes model behavior is worse than a 2x compression that doesn't.
- **No compression on the hot path without measurement.** If compression adds latency, it must be justified by measurable token savings that translate to net latency reduction.
- **Reversible by design.** Original content must remain available (in storage, not in context). Compression is a view transformation, not a destructive operation.
- **Start with the easiest wins.** Tool results have the most structural noise and the most predictable compression patterns. Start there before tackling the harder problem of reasoning compression.

## Problem Space
**Updated:** 2026-03-26
**Scope:** Token efficiency in the agentic coding loop

### Objective

We are optimizing for: **maximum useful context per token** in the agentic loop's context window. The constraint is a fixed-size window (~128K-200K tokens). Every token that doesn't contribute to the model's next correct action is waste. The outcome: longer sessions, fewer degradation events, same or better task completion.

### What the Corpus Told Us

We analyzed 93 sessions (carnage excluded), 10,001K total tokens. The data invalidated our initial assumptions and revealed the actual token budget breakdown:

```
Token budget (93 sessions, 10,001K tokens total):

Tool results:     7,034K  (70.3%)
  read:           4,059K  (57.7% of tools, 40.6% of total)  ← THE dominant cost
  grep:           1,045K  (14.9%)
  bash:             746K  (10.6%)
  other:          1,184K  (16.8%)

Assistant msgs:   2,894K  (28.9%)
  thinking sigs:  ~1,400K (opaque, not compressible)
  tool call args:   ~720K
  reasoning:        ~400K
  visible text:     ~370K

User messages:       73K  (0.7%)
```

**Key empirical findings:**

1. **Structural formatting is a rounding error.** Line anchors, tree headers, JSDoc, blank lines — combined <0.5% of tokens. Our initial hypothesis about rule-based structural compression was wrong. There is no meaningful "fluff" to strip.

2. **76% of file reads are re-reads of previously-read files.** But most (74% of all reads) are standalone — the model reading for understanding, not editing. The model reads `sdk.ts` 80 times across sessions, edits it 7 times.

3. **The hashline tax is real but modest.** 530 re-reads after edits (15.8% of reads), costing 361K tokens (3.6% of total). Of those, 317K are anchor-refresh after successful edits, 44K are retry after failures. This is a cost of the editing strategy, not a compression problem.

4. **Edit failure rate: 16.7%.** 106 of 636 edit attempts fail. This triggers re-read cycles but the token cost (44K) is small relative to total.

5. **Thinking signatures are 49% of assistant content and opaque.** We can't compress them — they're encrypted blobs for Anthropic's thinking continuity.

6. **Nobody has benchmarked prompt compression on agentic coding content.** All prior art (LLMLingua, Selective Context, RECOMP) was evaluated on NL benchmarks. Code + tool output + multi-turn reasoning is uncharted.

### The Three Actual Problems (data-driven)

The corpus analysis reveals three distinct problems hiding inside "semantic compression".
The RNA experiment then reframes all three.

**Problem A: Content density (the compression problem)**
Can the same information be represented in fewer tokens? The data says: structural noise is negligible (<0.5%), so the compression target is the *content itself*. Code, reasoning, tool output.

**Problem B: Redundant re-reads (the caching problem)**
The model reads the same file repeatedly for orientation. 74% of reads are standalone (no adjacent edit). This is 26.8% of total tokens — the single largest waste category.

**Problem C: Editing strategy tax (the UX problem)**
Hashline anchors invalidate on every edit, forcing a full re-read. 15.8% of reads exist solely to refresh anchors. 3.6% of total tokens.

### The RNA Reframe

The user's insight: the model reads *text* optimized for humans. What if it read *structure* instead?

RNA (Repo-Native Alignment) already indexes the codebase into a semantic graph: 99,696 symbols with signatures, types, relationships, call edges, cyclomatic complexity, importance scores, and line ranges. It already has a `compact` mode that returns "signature + location only" — which is, by construction, a compressed structural representation of code.

**Empirical test: `message-transform.ts`**

| Representation | Content | Est. tokens | Ratio |
|---|---|---|---|
| Raw `read` (current) | 600 lines full source + hashline anchors | ~5,452 | 1x |
| RNA compact (all symbols) | 50 entries: functions, interfaces, types, locals | ~2,500 | 2.2x |
| RNA compact (functions + interfaces) | 16 entries with full signatures and line ranges | ~800 | 6.8x |
| RNA compact (functions only) | 10 function signatures with cc/edges/lines | ~500 | **10.9x** |

**RNA gives the model MORE useful information at 11x fewer tokens.** The compact view includes cyclomatic complexity, edge counts, and line ranges that aren't present in raw source at all.

### How RNA Dissolves All Three Problems

**Problem A (content density) → Alternative representation**
Not "compress the text" but "don't use text." RNA's structural view IS the compressed representation. For code understanding, the model doesn't need source text — it needs the symbol graph. Signatures, types, relationships. This isn't lossy compression — it's a different encoding of the same information, optimized for the model's actual task (reasoning about code structure) rather than the human's task (reading code).

**Problem B (redundant re-reads) → Persistent graph navigation**
The model re-reads files because text-based context is ephemeral — it gets stubbed/dropped as the conversation ages. RNA's graph is persistent. The model can navigate the codebase through graph queries (`neighbors`, `impact`, `reachable`) instead of repeatedly reading files. The graph doesn't forget between turns.

For the 74% of reads that are standalone (understanding, not editing):
- Current: `read file` → 857 tokens average, content forgotten after hot window
- RNA: `search compact` → ~80 tokens for signatures, graph persists across session

**Problem C (editing tax) → Stable structural addresses**
Hashline anchors (`42#XQ:`) are fragile — they change on every edit. RNA node IDs (`message-transform.ts:transformMessages:function`) are stable — they survive edits to the function body. An editing strategy addressed by RNA nodes instead of hashline anchors wouldn't need re-reads for anchor refresh.

This doesn't eliminate the need to see source for editing — the model still needs the actual lines to know what to change. But it reduces the addressing problem: "edit the function at this stable ID" vs. "re-read the whole file to find the current anchor for line 42."

### The Graduated Representation Model

The key insight: not all code needs the same level of detail. The model's needs vary by intent:

```
Intent            Current (text)     RNA alternative          Savings
─────────────────────────────────────────────────────────────────────
Orientation       read whole file    repo_map / compact       10-25x
Understanding     read whole file    compact + targeted read  5-10x
Navigation        grep + read chain  neighbors / impact       3-7x
Pre-edit recon    read whole file    compact + line range     3-5x
Active editing    read + edit        targeted read + edit     1-2x
```

This is **level-of-detail rendering for code** — analogous to how game engines render distant objects at lower polygon counts. Far context gets structure. Near context gets source.

### Revised Problem Arithmetic

```
Token budget: 10,001K total across 93 sessions

Category                    Tokens    % total   RNA approach              Est. savings
──────────────────────────────────────────────────────────────────────────────────────
Standalone reads (orient.)  2,677K    26.8%     RNA compact replaces      ~2,400K (90%)
Reads before edit           336K      3.4%      Targeted line-range read  ~170K (50%)
Re-reads after edit         361K      3.6%      Stable node addresses     ~300K (83%)
Grep results                1,045K    10.5%     RNA graph traversal       ~700K (67%)
Bash results                746K      7.5%      (unchanged)               0
Other tool results          1,184K    11.8%     (unchanged)               0
Assistant messages          2,894K    28.9%     (unchanged by RNA)        0
User messages               73K       0.7%      (unchanged)               0

Total potential savings:    ~3,570K tokens = 35.7% reduction
Effective ratio:            ~1.56x from RNA alone (no text compression needed)
```

35% reduction from representation change alone — no model-based compression, no LLMLingua, no BERT. Pure engineering: serve structure instead of text where structure suffices.

Combined with text compression on the remaining content (LLMLingua-class, 2-5x on the ~6,400K that RNA doesn't touch), theoretical ceiling:
- Conservative (2x on remainder): 1.56 * 1.28 = **~2.0x total**
- Moderate (3x on remainder): 1.56 * 1.64 = **~2.6x total**
- Aggressive (5x on remainder): 1.56 * 2.14 = **~3.3x total**

The 10x target requires ~6.4x from text compression on the non-RNA content. This is in LLMLingua's claimed range for NL (20x) but unvalidated for code/tool output.

### Revised Assumptions

1. **The model can reason over RNA compact output as effectively as source text** — for understanding and navigation tasks. UNTESTED. This is the critical assumption to validate first.
2. **RNA compact mode gives complete structural information.** If it misses edge cases (complex generics, conditional types, runtime-computed values), the model will ask for source anyway, reducing savings.
3. **Graph navigation replaces grep+read chains.** Depends on RNA's graph quality and the model's ability to formulate graph queries instead of text searches.
4. **Stable node addresses work for editing.** The editing tool would need to accept RNA node IDs and resolve them to current line ranges. Non-trivial integration.
5. **The model will adapt to a mixed-representation context** — some turns have source text, others have RNA compact output. No confusion or degradation.

### Constraints (updated)

| Constraint | Type | Reason | Question? |
|------------|------|--------|-----------|
| Context window is fixed (~128-200K tokens) | hard | API limit | Only changes with model upgrades |
| Compression must not degrade model behavior | hard | Core invariant | No |
| Compression latency must not dominate turn time | hard | UX | RNA queries are fast (<100ms) |
| RNA graph must be current | hard | Stale graph = wrong info | Auto-reindex on file change |
| Content format is set by tool implementations | soft | Current architecture | Tools could emit RNA-backed formats |
| Hashline editing is the current strategy | soft | Existing implementation | RNA node addresses as alternative |
| Thinking signatures are opaque | hard | Anthropic's API design | No |
| No external API dependency for compression | soft | Local-first | RNA is fully local |

### Terrain (updated)

- **Systems involved:** RNA server, message transform pipeline, tool result rendering, context assembler, recall system, edit tool
- **Key integration point:** RNA sits between the tool layer and the context assembler. Tool results could be post-processed through RNA to produce structural views before entering the conversation.
- **Blast radius:** If RNA compact output omits something the model needs, the model either asks for source (safe but costs a turn) or makes wrong decisions (unsafe). The failure mode is recoverable but burns tokens.
- **Existing infrastructure:** RNA is already built, indexed, and serving queries. The integration is wiring, not building.

### X-Y Check (revised)

- **Stated need (Y):** Semantic compression — make content denser
- **Underlying need (X):** Fit more useful context into a fixed window so sessions last longer and the model stays effective
- **Revised take:** Y was framed as text compression. The data + RNA reframe suggest the real Y is **representation optimization** — serve the right level of detail for each context need. Text compression is one tool. Structural representation (RNA) is another. Combined, they attack different parts of the token budget. RNA handles code (40.6% of total), text compression handles the rest.

### Open Questions

1. **Can the model work with RNA compact output?** Needs an A/B experiment: same task, one session with source reads, one with RNA compact + targeted reads. Compare tool calls, edit quality, task completion.
2. **What's the right granularity for RNA compact?** Functions only? Functions + interfaces? Functions + interfaces + key constants? Too sparse = model asks for source. Too dense = no savings.
3. **How does RNA-backed navigation compare to grep+read?** Measure: same codebase exploration task, RNA graph queries vs. grep+read chains. Compare tokens spent and information quality.
4. **Can we make the editing tool RNA-address-aware?** Accept `node: "message-transform.ts:transformMessages:function"` instead of hashline anchors. Resolve to current line range at edit time.
5. **Does mixed-representation context confuse the model?** Some turns with source, some with RNA compact. Does the model handle the transition?

## Problem Space: Codec Architecture
**Updated:** 2025-07-12
**Scope:** Codec registry + LOD graduation in message-transform pipeline

### Objective (Implementation-Scoped)

Maximize useful information retained per token when tool results age out of the hot window.
The gap between full fidelity (hot) and opaque stub (current cold) is all waste.
A warm tier preserving structural information at 5-10x fewer tokens means the model retains
functional knowledge instead of losing it to `[ref:read:path]` tombstones.

### Extension Point

Single point of change: `replaceToolResultContent` in `message-transform.ts:362`.
Currently replaces ALL tool_result content with a stub string. The codec architecture
replaces this with content-type-aware warm representations.

Pipeline: `sdk.ts:1614 → transformMessages → replaceToolResultContent → formatStubText`
Classification: `extractSourceTags()` already routes by tool type.
Metadata: `MemoryLocatorEntry` carries provenance, params, recipe.

### Three Engineering Problems

1. **Content-type routing** — dispatch on tool type to select codec. Plumbing problem.
2. **RNA integration** — code codec queries RNA for compact output. Sync-vs-async question.
3. **LOD graduation** — warm tier between hot and cold. Tuning problem.

### Design Decisions Open

1. **Sync vs async codec** → **Option C: lazy background pre-compute.** RNA query fires when locator is created, result cached by file path. Transform stays sync. 3-turn latency buffer. Graceful fallback to stub if unavailable.
2. **Codec interface** → **Registry of `ContentCodec` objects matched in order.** `matches(sourceTags, locator?) → boolean`, `encode(message, locator?) → TextContent[] | null`. First match wins. Default stub fallback.
3. **Warm tier sizing** → **No separate tier. Codec output IS the warm tier.** Binary becomes: hot (full) → warm (codec) → dropped (budget). No LOD management system yet.
4. **RNA digest cache** → **Separate `Map<string, {digest, fileHash}>` on bridge, keyed by file path.** Multiple locators can share one file's digest. FileHash enables dedup.
5. **Dedup** → **In `replaceToolResultContent`, before codec dispatch.** Same path + same fileHash as prior turn → `[unchanged:T{n}:read:path]`. Skip codec entirely.


## Execute
**Updated:** 2025-07-12
**Status:** in-progress

### Phase 1: Codec Infrastructure — SHIPPED ✓
Commit: `a39687e87` on `experiment/rna-replaces-tools`

- `ContentCodec` interface + `CodecContext` type in `types.ts`
- `codecs[]` + `resolveLocator` added to `MessageTransformOptions`
- `replaceToolResultContent` refactored: tries codecs before stub fallback
- `"compressed"` added to `TurnDecisionAction`, `compressedCount` to `TransformMetadata`
- All consumers updated: assembly-summary, prompt-inspector, RPC types, 5 test files
- Zero behavior change when no codecs registered

### Phase 2: Read Codec — SHIPPED ✓
Commit: `dac1fcf41` on `experiment/rna-replaces-tools`

- `readCodec` in `codecs/read-codec.ts`: handles `proxy_read`/`read` tool results
- RNA structural views preserved as-is with `[warm:read:path]` marker
- Source reads compressed to `[warm:read:path | lines X-Y of Z]`
- `getLocatorEntry()` added to `ContextBridge`
- Wired into `sdk.ts` transformMessages call


### Phase 2b: Anchor-Aware Skeleton for Source Reads
**Solution:** Option D from solution space analysis.
Extract structural lines (declarations, scope boundaries) from hashline-formatted source reads,
preserving anchors. Model retains declaration structure + edit capability without full source.
Pattern-match on hashline content for TS/JS declaration forms.
3-5x compression on typical source reads. No external dependencies.

### Phase 3: Dedup Detection
**Solution:** Dedup-as-codec with read history in CodecContext.
Pass `readHistory: Map<filePath, {turnIndex, contentHash}>` through CodecContext.
Dedup codec runs before read-codec. Same file + same hash → `[unchanged since T{n}:read:path]`.
Different hash → fall through to read-codec (fresh skeleton).
Codecs stay stateless; history built by the transform loop and passed in.
~4K tokens/session savings on re-reads.

### Phase 4: Additional Codecs (grep, bash, lsp, config) — TODO


## Solution Space
**Updated:** 2026-03-26

### Problem Confirmed

**Problem:** The model spends 51% of all tokens (read 40.6% + grep 10.5%) on code understanding via text-based tools. RNA can represent the same structural information at 5-11x fewer tokens. How do we make RNA the primary representation for code understanding while preserving raw source for editing?

**Key constraint:** The model was trained on source code, not RNA output. The representation must be interpretable without degrading behavior.

**Success:** Standalone understanding reads (74% of all reads = ~3,000K tokens) shift to RNA-backed representations at 5-10x fewer tokens = ~1,500-2,700K tokens saved per 93 sessions = 15-27% total token reduction.

### Correction: RNA Compact Is Not Magic

The exploration revealed that `compact: true` alone gives only ~1.5x compression on RNA search results. The 11x figure from `message-transform.ts` required stacking filters:

```
11x = compact:true + kind:function + include_markdown:false + file:specific-file
```

Without `include_markdown:false`, markdown sections dominate results and blow up token count. Without `kind` filtering, local variables and constants clutter the output. RNA compact is a building block, not a silver bullet.

### Current Tool Landscape (what RNA touches)

| Tool | Volume | What model sees | RNA equivalent | Gap |
|------|--------|----------------|----------------|-----|
| `read` | 4,059K (40.6%) | Full source with `LINE#HASH:` anchors, ~5 chars/line overhead | `search(file=X, compact=true, kind=function)` for signatures; no function bodies | Bodies. RNA has signatures + metadata, not implementation. |
| `grep` | 1,045K (10.5%) | Tree-formatted matches: `# dir / ## file / >>LINE#HASH:match`, context lines 59% of output | `search(query=X, compact=true)` for symbol matches; `mode=neighbors` for call graph | Regex text search. RNA finds symbols, not arbitrary text patterns. |
| `lsp` (refs) | ~200K est. | `Found N refs: file:line:col + 1 context line` per ref, first 50 expanded | `search(node=X, mode=neighbors, direction=incoming)` | Dynamic dispatch, string-computed method calls |
| `lsp` (hover) | ~50K est. | Type signature + docs as markdown | `search(query=X)` full mode gives signature + docs | Essentially equivalent |
| `lsp` (definition) | ~50K est. | File:line:col + 3 context lines | `search(query=X, compact=true)` gives file:line | Essentially equivalent |
| `find` | ~30K est. | File path listings | `search(file=X)` + `repo_map` for structure | Glob patterns — RNA searches by symbol/content, not path |
| `ast_grep` | ~50K est. | Structural matches with byte ranges, captures | No equivalent | Structural pattern matching is different from symbol search |

### What RNA Cannot Replace

1. **Function bodies.** RNA has signatures, types, complexity scores, and edges. It does NOT have implementation code. The model still needs `read` to see what a function actually does.
2. **Text-level regex search.** RNA finds symbols. It cannot find arbitrary text patterns like error messages, string literals, config keys, or comment content.
3. **Editing.** RNA cannot write files. `edit` and `write` are untouched.
4. **Non-code tools.** `bash`, `fetch`, `web_search`, `puppeteer`, `notebook` — RNA has nothing to say about these.
5. **File content for non-code files.** JSON, YAML, Markdown, config files — RNA indexes markdown sections but not arbitrary file content.

### Candidate Solutions

#### Option A: Prompt guidance only (Band-Aid)
- **Approach:** Rewrite the system prompt to position RNA as the primary code orientation tool. "Use `mcp_rna_server_search` for understanding code structure. Use `read` only for source lines you need to edit or inspect in detail."
- **Level:** Band-Aid
- **Implementation cost:** Zero code changes. Prompt edit only.
- **Trade-off:** Model compliance is unreliable. Models default to habits. A prompt suggestion won't stop it from `read`-ing files out of habit. No enforcement.
- **Estimated savings:** Maybe 10-20% of reads shift to RNA = 4-8% total token reduction IF the model complies.

#### Option B: Smart read tool with RNA preamble (Local Optimum)
- **Approach:** Modify the `read` tool to prepend an RNA compact summary to every file read. The model gets signatures at the top, then full source below. For aged tool results in the message transform, strip the source and keep only the RNA summary.
- **Level:** Local Optimum
- **Implementation cost:** Medium. Modify read tool output formatting + message transform aging logic.
- **Trade-off:** INCREASES token cost on fresh reads (~500 tokens of RNA summary added). Only saves when reads age and get compressed. Net effect depends on ratio of fresh-to-aged reads.
- **Second-order effects:** The RNA summary persists in context after the source is stripped, giving the model lasting structural memory of files it read.

#### Option C: RNA-first exploration, source-only editing (Reframe)
- **Approach:** Don't change existing tools. Instead, add a new `explore_code` tool (or enhance the existing RNA MCP tools with friendlier defaults) that the model uses for ALL non-edit code understanding. The tool wraps RNA search with: `compact=true`, `include_markdown=false`, sensible `top_k`, and `kind` filtering. The system prompt directs the model: explore with `explore_code`, read with `read` only when you need source for editing.
- **Level:** Reframe
- **Implementation cost:** Low-medium. Thin wrapper tool + prompt changes. No modifications to read/grep/edit.
- **Trade-off:** The model must learn when to use which tool. Two code-understanding paths creates cognitive load. But the model already handles 33 tools.
- **Estimated savings:** If 50% of standalone reads shift to RNA: ~1,500K tokens saved = 15% total reduction.
- **Key advantage:** Non-invasive. Existing tools untouched. RNA tool is additive. Can A/B test trivially.

#### Option D: Graduated representation in message transform (Redesign)
- **Approach:** The message transform already stubs old tool results to `[ref]`. Instead of binary full/stubbed, introduce a gradient:
  - Hot window (last 3 turns): full source with anchors
  - Warm window (turns 4-8): RNA compact summary (signatures + types + edges)
  - Cold window (turns 9+): `[ref]` stub with file path only
  The transform queries RNA at compression time to generate the compact summary.
- **Level:** Redesign
- **Implementation cost:** High. Requires RNA client in the message transform pipeline, per-message compression logic, content-type detection (only compress code reads, not bash/fetch output).
- **Trade-off:** Complex integration. RNA must be available at assembly time (it already is via MCP). Adds latency to context assembly. But: completely transparent to the model — it reads normally, and aged content automatically compresses.
- **Estimated savings:** All reads beyond the hot window get compressed. With an average session of 76 turns and a 3-turn hot window, ~96% of reads age out = potentially very high savings on long sessions.
- **Key advantage:** No model behavior change required. No new tools. The compression is invisible.

#### Option E: RNA as the read layer (Redesign)
- **Approach:** Replace the `read` tool's default mode. When the model calls `read(path="file.ts")`, it gets RNA compact output by default. A `mode: "source"` parameter gets raw source with hashline anchors (for editing). The system prompt explains the two modes.
- **Level:** Redesign
- **Implementation cost:** High. Modifies the most-used tool. Requires RNA client in the read tool. Must handle fallback when RNA hasn't indexed a file.
- **Trade-off:** Breaking change to the most critical tool. If RNA output is insufficient, the model wastes a turn re-reading in source mode. Risk of degrading edit workflows if the model forgets to specify `mode: "source"` before editing.
- **Estimated savings:** Similar to Option C but enforced rather than suggested.
- **Key risk:** The model was trained to expect source code from `read`, not structural summaries. This could confuse it.

### Evaluation

| Criterion | A: Prompt | B: Preamble | C: New tool | D: Transform | E: Replace read |
|-----------|-----------|-------------|-------------|-------------|----------------|
| Solves stated problem | Weakly | Partially | Yes | Yes | Yes |
| Implementation cost | Zero | Medium | Low | High | High |
| Risk of regression | None | Low | Low | Medium | High |
| Model behavior change | Unreliable | None | Moderate | None | High |
| Estimated savings | 4-8% | 5-15% | 15% | 20-30% | 15-25% |
| Testable incrementally | Yes | Yes | Yes | Partially | No |
| Preserves existing tools | Yes | Modifies read | Yes | Modifies transform | Modifies read |
| Works with current RNA | Yes | Needs client | Yes | Needs client | Needs client |

### Recommendation

**Selected: Option C (RNA-first exploration) as the starting point, with Option D (graduated transform) as the target state.**

**Why C first:**
1. Non-invasive — adds a tool, doesn't modify any existing tool
2. Testable today — RNA MCP is already available; we just need a wrapper with good defaults and prompt guidance
3. Validates the critical assumption: can the model reason over RNA output effectively?
4. Provides the data needed to justify Option D's higher investment

**Why D as the target:**
1. Transparent — doesn't require the model to change behavior
2. Graduated — content gets denser as it ages, matching the model's declining need for detail
3. Composes with existing infrastructure — extends the message transform's existing stub/drop logic
4. The only option that helps with assistant message verbosity too (aged reasoning could be summarized)

**Why not the others:**
- A (prompt only): No enforcement, unreliable compliance
- B (preamble): Increases fresh-read cost, only saves on aging — net unclear
- E (replace read): Too risky — modifies the #1 tool, model expects source code

### Accepted Trade-offs

1. Option C requires the model to learn a new tool. This is manageable — the system prompt already teaches 33 tools.
2. RNA doesn't have function bodies. The model will still need `read` for detailed understanding. Savings are bounded by the orientation/navigation fraction (74% of reads).
3. RNA graph quality is a dependency. If RNA misses symbols or has stale data, the model gets wrong information. Worse than getting verbose-but-correct source.

### Implementation Path

**Phase 1: Validate (Option C, low effort)**
1. Design the `explore_code` tool wrapper with RNA defaults: `compact=true`, `include_markdown=false`, intelligent `kind` filtering
2. Add system prompt guidance directing the model to use it for orientation
3. Run the same tasks with and without, measure token consumption and task quality
4. Determine: what granularity works? Does the model ask for source anyway?

**Phase 2: Integrate (Option D, medium effort)**
5. If Phase 1 validates that RNA output is sufficient for understanding, add RNA-backed compression to the message transform's aging pipeline
6. Implement the graduated compression: hot=full, warm=RNA compact, cold=stub
7. Measure: does the model maintain quality with compressed older context?

**Phase 3: Optimize**
8. Fine-tune the warm/cold thresholds based on session data
9. Investigate RNA node addresses for editing (stable anchors)
10. Evaluate text compression (LLMLingua) on the remaining non-code content (assistant messages, bash output)

### What We Need to Know Before Phase 1

1. **RNA query latency** — how fast is `search(file=X, compact=true, kind=function)`? Must be <200ms to not bottleneck tool execution.
2. **RNA coverage** — what fraction of files in a typical session are indexed? Unindexed files fall back to `read`.
3. **The right defaults** — what `kind` filter gives the best signal/noise? `function` only misses interfaces and types. `function+type_alias+interface` might be the sweet spot.
4. **Model interpretability** — does the model correctly interpret RNA's compact format? Can it reason about code from signatures + edges without seeing source?