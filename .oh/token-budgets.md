# Session: token-budgets

## Aim
**Updated:** 2026-03-09

### Aim Statement

**Aim:** The assembler never silently produces a context window that overflows the model's capacity or starves messages of budget, and the operator can tune budget allocation — as proportional slices of the model's context window — without rebuilding.

**Current State:** Budget parameters (`BUDGET_SAFETY_MARGIN = 0.9` as a multiplier, `DEFAULT_HOT_WINDOW_TURNS = 4`) are hardcoded constants in `message-transform.ts`. `deriveBudget` can return negative `maxTokens` when system prompt + tools consume more than the usable window. No runtime configuration, no floor enforcement, no warning when the budget is critically thin. If the budget computation silently goes wrong, messages get dropped or overflow, with no feedback. Hydration has no dedicated budget — it eats directly from the message budget with no cap.

**Desired State:** Budget derivation guarantees non-negative, sensible results with documented invariants. Every budget category is a configurable percentage of the model's context window. When budgets are tight, the system logs actionable warnings. The operator can adjust all proportions via settings without code changes.

---

### Current Budget Structure

The context window is consumed in this order:

```
Model Context Window (e.g. 200k tokens)
├── Fixed Costs (subtracted first, measured per-turn)
│   ├── System Prompt tokens (char/4 estimate)
│   ├── Tool Definition tokens (char/4 estimate)
│   └── Current Turn tokens (char/4 estimate of transformed messages)
├── Safety Margin (raw remaining * 0.10, via BUDGET_SAFETY_MARGIN = 0.9 multiplier)
└── Available Budget (maxTokens = floor(remaining * 0.9) - fixedCosts)
    ├── Hydration (passive hydrator output — no dedicated cap, consumed first)
    └── Message Budget (maxTokens - hydratedTokens, floored at 0 in sdk.ts)
        ├── Hot Window (last 4 turns — inviolable, always kept)
        ├── Stubbed Turns (beyond hot window, tool_result content replaced)
        └── Dropped Turns (oldest, removed if budget still exceeded)
```

**Dead scaffolding from scrapped architecture:**
`MemoryAssemblyBudget.reservedTokens` has three sub-categories (`objective`, `codeContext`, `executionState`) — all hardcoded to 0. These were designed for a structured retrieval pipeline (locator map scoring, typed categories, composite retriever) that was **scrapped in favor of semantic search via LanceDB** (see `.oh/infinite-context.md`). The three sub-fields are dead code and should be removed.

**Key gaps:**
1. **No proportional allocation** — budget is "everything left after fixed costs minus safety margin." There is no per-category percentage split.
2. **Hydration has no cap** — it can consume the entire message budget. If the hydrator returns 80k tokens of context, messages get 0 budget.
3. **Safety margin is a magic constant** — `0.9` multiplier (= 10% margin) is not configurable and not documented as a deliberate choice.
4. **Hot window is size-unbounded** — 4 turns always kept regardless of how many tokens they contain. A single turn with a massive tool result can blow through the budget.
5. **No minimum budget** — if fixed costs alone approach the context window, `maxTokens` goes to 0 (or negative before the floor in `sdk.ts`).
6. **No observability** — budget derivation is captured in the snapshot but never logged at debug level.

---

### Desired Budget Structure

Two categories. The old three-tier reserved model is dead — the infinite-context session replaced structured retrieval with semantic search. Everything recalled from LanceDB is "hydration." Everything in the conversation is "messages."

Budget categories claim **guaranteed minimum percentages** of the allocatable budget. When hydration uses less than its allocation, the surplus flows to messages. The percentages describe a **fully saturated** budget — the split that applies when both categories are consuming their full share.

```
Model Context Window (100%)
├── Fixed Costs (measured, subtracted — not configurable, varies per turn)
│   ├── System Prompt tokens
│   ├── Tool Definition tokens
│   └── Current Turn tokens
├── Safety Reserve (configurable %, default 5%)
└── Allocatable Budget (contextWindow - fixedCosts - safetyReserve)
    ├── Messages (guaranteed min 50% — expands into unused hydration)
    │   ├── Hot Window (configurable turn count, default 4)
    │   ├── Stubbed Turns
    │   └── Dropped Turns (overflow)
    └── Hydration (hard cap 50% — passive recall from LanceDB)
        └── Semantically recalled context (user msgs, assistant reasoning, tool results)
```

**Allocation semantics:**
- Hydration is **hard-capped** at its percentage. It cannot exceed its allocation.
- Messages get **at least** 50%. If hydration uses 20%, messages expand to 80%.
- At full saturation (both categories consuming their allocation), the split is 50/50.

**Invariants (enforce at derivation time):**
- `messageBudgetPercent` and `hydrationBudgetPercent` each validated in range 0-100 independently (not required to sum to 100)
- Messages is a guaranteed floor (at least X% of allocatable) — expands into whatever hydration doesn't use
- Hydration is a hard ceiling (up to X% of allocatable) — enforced at entry level, drop lowest-MMR entries to fit
- If `floor + cap < 100`, the gap is pure overflow to messages. If `floor + cap > 100`, hydration caps first, messages get their guarantee.
- `deriveBudget` returns non-negative values for all fields
- When allocatable budget is critically low (fixed costs dominate), log a warning with the breakdown

---

### Mechanism

**Change:** Three layers:

1. **Harden `deriveBudget`** — floor all outputs at 0, validate invariants (fixed costs > context window = error), log when allocatable budget is critically low.

2. **Elastic budget config** — add settings under `assembler.*`:
   - `assembler.safetyMarginPercent` (default: 5) — percentage of context window held as safety reserve
   - `assembler.messageBudgetPercent` (default: 50) — guaranteed minimum percentage for messages (expands into unused hydration capacity)
   - `assembler.hydrationBudgetPercent` (default: 50) — hard cap for hydration (passive semantic recall from LanceDB)
   - `assembler.hotWindowTurns` (default: 4) — number of recent turns in hot window

   Wire these through `deriveBudget` and `transformMessages` via options. Current hardcoded constants become defaults. `messageBudgetPercent + hydrationBudgetPercent` must equal 100; validated at load time. Messages is a floor (at least X%), hydration is a ceiling (up to X%).

3. **Observable budget decisions** — log budget derivation details at debug level each turn: total window, fixed costs, per-slice allocation, actual usage. Existing `EffectivePromptSnapshot` already captures the budget; ensure it reflects the per-category breakdown.

**Hypothesis:** Hardcoded budgets are correct for the initial model profile (200k window Sonnet) but become wrong when the model changes (smaller windows, larger tool sets, fat system prompts, heavy hydration). Making proportions configurable eliminates a class of "works on my machine" failures. The hard cap on hydration prevents a runaway LanceDB recall from starving messages. The elastic overflow ensures messages always get the most context possible when hydration is underutilized.

**Assumptions:**
- The char/4 token estimation is sufficient for budget bounding (exact tokenization is not needed for guard rails, only for precise packing).
- The hot window must remain inviolable even if it alone exceeds its slice (current design intent per `computeBudgetDropCount` — the hot window is a floor, not a ceiling).
- No caller depends on the exact numeric values of the current hardcoded constants.
- Percentage splits need not be model-specific in v1 — a single set of percentages per session is enough. Per-model profiles can come later.

---

### Feedback

**Signal:**
1. `bun check:ts` passes with new settings wired
2. Existing assembler tests pass without modification (unless they assert on the removed hardcoding)
3. New unit tests cover: negative budget floor, minimum budget warning, per-category allocation math, elastic overflow (unused hydration flows to messages), settings overrides flowing through `transformMessages`, hydration cap enforcement
4. Budget debug log visible in `~/.oh-omp/logs/` during a live session showing per-slice breakdown

**Timeframe:** Immediate for enforcement and config wiring. Observable via next live session.

---

### Guardrails

- **Do not change `transformMessages` semantics** — the hot-window/stub/drop pipeline is correct. Budget enforcement is additive.
- **Do not introduce a tokenizer dependency** — char/4 estimation is good enough for bounds. Exact packing is a separate concern.
- **Do not change the double-pass design** — the first pass (content replacement) then second pass (budget bounding) is intentional. Tighten within that structure.
- **Defaults are a deliberate behavior change** — the current system has no hydration cap and a 10% safety margin. The new defaults (5% safety margin, 50% hydration cap) intentionally change behavior. This is not a regression — it's the point. Document in CHANGELOG: safety margin reduced from 10% to 5%, hydration cap introduced at 50% of allocatable budget.
- **`messageBudgetPercent` and `hydrationBudgetPercent` are independent** — they are not required to sum to 100. `messageBudgetPercent` is a guaranteed floor. `hydrationBudgetPercent` is a hard cap. If `floor + cap < 100`, the gap is pure overflow to messages. If `floor + cap > 100`, hydration is capped first, messages get at least their guarantee. Validate that each is in range 0-100 individually, not that they sum.
- **Messages expand, hydration caps** — hydration is a hard ceiling. Messages are a soft floor. Do not invert this: messages must never be capped below their guarantee while hydration has unused allocation.
- **Revisit if** budget warnings fire frequently on default settings — that means the defaults are wrong, not just the enforcement.
- **Remove `reservedTokens` from `MemoryAssemblyBudget`** — the three sub-fields (`objective`, `codeContext`, `executionState`) are dead scaffolding from the scrapped structured retrieval architecture. Replace with a single `hydrationTokens` field.
- **Drops must respect API message ordering** — Claude's API requires the first message to be `role: user`. When `computeBudgetDropCount` removes turns from the front, the surviving messages may start with an `assistant` turn. Fix: drop in user/assistant pairs (always drop the subsequent assistant turn when dropping a user turn), or synthesize a placeholder user message ("conversation continued") when the surviving messages would start with `assistant`. This is a latent bug in the current code that becomes real with tighter budgets or smaller-window models.

### Cleanup: Dead Code to Remove

The following are artifacts of the scrapped structured retrieval pipeline:
- `MemoryAssemblyBudget.reservedTokens` (objective, codeContext, executionState) — replace with `hydrationBudgetMax: number` and `messageBudgetMin: number`
- Any scoring/retriever code still referencing these categories
- Locator eviction logic (LanceDB handles storage)
- Composite retriever, stub retriever, artifact resolver (replaced by LanceDB reads)

---

## Problem Space
**Updated:** 2026-03-10

### Objective

We are optimizing for: **the assembler never wastes or overflows context window capacity, and the operator can tune the allocation without code changes.**

The agent's context window is its entire working reality. Overfill it and the API rejects the call. Underfill it and the agent forgets things it shouldn't. Misallocate between messages (conversation history) and hydration (recalled past context) and either the agent loses track of what it just did, or it can't recall relevant prior work. The budget is the mechanism that controls this tradeoff.

### Constraints

| Constraint | Type | Reason | Question? |
|------------|------|--------|-----------|
| Two-pass transform design (content replacement then budget bounding) | hard | Architectural decision in assembler. First pass stubs tool results, second pass drops turns for budget. Changing the order changes the semantics. | No — confirmed correct in infinite-context session. |
| Hot window is inviolable | hard | The last N turns must always be in context so the model can see its recent work. Without this, the model can't continue a multi-step tool-calling sequence. | No — this is load-bearing. But: a single hot-window turn with a massive tool result can blow the budget. The hot window is a floor, not a budget-aware allocation. |
| char/4 token estimation | soft | No tokenizer dependency. Estimates are good enough for guard rails but not for precise packing. | Could upgrade to a fast tokenizer (tiktoken-like) later, but not required for budget enforcement. Overestimates are safer than underestimates. |
| Claude API: first message must be `role: user` | hard | Anthropic Messages API constraint. If drops remove the first user message and surviving messages start with `assistant`, the API call fails. | No — API constraint, not negotiable. |
| `BUDGET_SAFETY_MARGIN = 0.9` (10% reserve) | assumed | Magic constant, never documented. 10% of a 200k window is 20k tokens of waste. On a 32k window model, it's 3.2k — potentially too aggressive. | Yes — should this be 5%? Should it scale with window size? |
| `DEFAULT_HOT_WINDOW_TURNS = 4` | soft | Reasonable default but not validated. In tool-heavy turns, 4 turns can be 80k+ tokens. In text-only turns, 4 turns might be 2k tokens. | Yes — should hot window have a token budget in addition to turn count? |
| Messages and hydration are the only two consumers | hard | Confirmed by infinite-context session. Structured retrieval was scrapped. Everything recalled comes through LanceDB semantic search (hydration). Everything else is conversation messages. | No — unless a third consumer is introduced later, which would require adding a setting, not changing the model. |
| Settings schema is Zod-validated | hard | All settings go through `settings-schema.ts`. New settings must be Zod schemas with defaults. | No. |
| `deriveBudget` returns `MemoryAssemblyBudget` type | soft | Current return type has dead fields (`reservedTokens`). Changing the type touches callers. | Yes — the type needs cleanup. Dead fields should be removed and `hydrationTokens` added. But callers are few (sdk.ts, snapshot, tests). |
| Passive hydration output is a single text blob of N entries | hard | The hydrator formats recalled results as `<recalled-context>` XML with N entries. Its token cost is the sum of all entries. | No — but cap enforcement must work at the entry level (drop lowest-MMR entries), not by truncating the blob. |

### Terrain

**Systems involved:**
- `message-transform.ts` — `deriveBudget`, `transformMessages`, `computeBudgetDropCount`. The core budget logic.
- `types.ts` — `BudgetDerivationInput`, `MessageTransformOptions`. The budget interface.
- `memory-contract.ts` — `MemoryAssemblyBudget`, `MemoryContract`. The budget output type (has dead fields).
- `sdk.ts` (~lines 1400-1520) — `transformContext` closure. The integration point that calls deriveBudget, runs hydration, and applies budget bounding.
- `settings-schema.ts` — where new assembler settings must be added.
- `effective-prompt-snapshot.ts` — captures budget derivation for observability.
- `passive-hydration.ts` — produces the hydration output that consumes the hydration budget.

**Who is affected:**
- The operator (configures budgets via settings)
- The agent (gets more or less context based on budget allocation)
- Downstream test suite (budget types change, snapshot shape changes)

**Blast radius:**
- If budget enforcement is too aggressive: agent loses context it needs, quality degrades
- If budget enforcement is too loose: API call exceeds context window, hard failure
- If defaults change: existing users see different behavior — this is intentional and must be documented in CHANGELOG
- If `MemoryAssemblyBudget` type changes: callers need updating (sdk.ts, snapshot, tests — small surface area)

**Precedents:**
- memex-core uses a fixed token budget per assembly step with hard caps
- Anthropic's own prompt caching works on prefix stability — budget enforcement that changes which messages survive affects cache hit rates (relevant but second-order)
- The infinite-context session established: no structured retrieval, no scored fragments, just semantic search. Budget model must match this reality.

### Assumptions Made Explicit

1. **char/4 is good enough for budget guard rails** — if false: budget enforcement is unreliable and we need a real tokenizer. Consequence: add `tiktoken` or similar. Risk: low, char/4 consistently overestimates which is the safe direction for budget caps.
2. **Hydration can saturate its allocation** — each ingested entry is the full message text (no chunking, no truncation). The hydrator retrieves top 10 results at full size. In tool-heavy sessions, 10 recalled tool results can easily be 30-50k+ characters (7.5-12.5k+ tokens). The 50% hydration cap is not generous headroom — it's a real constraint that will bind. The elastic overflow to messages only helps when hydration is genuinely light (e.g. early in a session, or few semantic matches). In mature sessions with rich recall stores, expect near-saturation.
3. **Hot window token cost doesn't need a cap** — if false: a single tool-heavy turn can consume the entire message budget, pushing out all non-hot-window history. Consequence: add a per-turn or hot-window token cap. Risk: medium, tool results can be very large.
4. **Settings validation at load time is sufficient** — if false: runtime changes (model switch mid-session) could invalidate the budget. Consequence: validate at derivation time too. Risk: low, model switches mid-session are rare.
5. **The safety reserve percentage should be constant, not scaled by window size** — if false: 5% of a 200k window (10k tokens) is plenty but 5% of a 32k window (1.6k tokens) might not be enough. Consequence: add a minimum absolute safety reserve. Risk: low for current models, real if smaller models are used.
6. **Elastic overflow is the right model** — if false: unused hydration budget that flows to messages could cause the agent to retain too many old messages that should have been dropped. Consequence: messages could be padded with irrelevant ancient history instead of being compact. Risk: low, the stub/drop logic handles this by compressing older turns first.

### X-Y Check

- **Stated need (Y):** Make token budgets reasonable, enforced, and runtime-configurable.
- **Underlying need (X):** The assembler never silently misallocates the context window — no overflow, no starvation, and the operator can tune when defaults don't fit.
- **Confidence:** High that Y=X. The budget is the mechanism; the aim is reliable context assembly. The only risk is over-engineering configuration that nobody tunes — but conservative defaults prevent harm.

### Ready for Solution Space?

**Yes.** The terrain is mapped:
- Two consumers (messages, hydration), no third category
- Four settings to add (independent `messageBudgetPercent` floor and `hydrationBudgetPercent` cap, not required to sum to 100)
- One type to clean up (`MemoryAssemblyBudget`)
- One latent bug to fix (front-drop API ordering)
- One dead code cleanup (`reservedTokens` scaffolding)
- Integration points are few and well-scoped (sdk.ts, message-transform.ts, settings-schema.ts, memory-contract.ts)

Open question worth carrying into solution space: **should the hot window have a token budget in addition to a turn count?** A 4-turn hot window where one turn has a 60k tool result is qualitatively different from one where all turns are 2k. This isn't blocking but is a design decision for the solution.

---

## Solution Space
**Updated:** 2026-03-10

### Problem Confirmed

Budget enforcement is missing, allocation is hardcoded, dead scaffolding needs cleanup, and a front-drop API ordering bug needs fixing. Two consumers (messages, hydration), elastic model (messages expand into unused hydration). Defaults intentionally change behavior: introduces hydration cap and reduces safety margin.

### Candidates Considered

| Option | Level | Approach | Trade-off |
|--------|-------|----------|-----------|
| A: Patch-in-place | Band-Aid | Add hydration cap and settings alongside existing dead fields | Dead code persists, types inconsistent |
| B: Clean deriveBudget + settings | Local Optimum | Redesign deriveBudget, remove dead fields, add settings, fix front-drop. Elastic math in sdk.ts | Touches callers of MemoryAssemblyBudget (few) |
| C: Budget allocation object | Reframe | BudgetAllocation type with methods for consumption tracking | Over-abstraction for two categories |
| D: Budget manager class | Redesign | Full lifecycle budget object | YAGNI |

### Recommendation

**Selected:** Option B — Clean deriveBudget + settings
**Level:** Local Optimum

**Rationale:** The elastic model is one line of arithmetic: `effectiveMessageBudget = messageBudgetMin + max(0, hydrationBudget - actualHydratedTokens)`. It doesn't need an object or class. Type cleanup is required. Settings are straightforward Zod schemas. Front-drop fix is contained. 6 files, no new modules, no new abstractions.

**Accepted trade-offs:**
- Elastic math lives in sdk.ts (the integration point that knows actual hydration output)
- If a third budget category appears later, settings schema and deriveBudget output are additive — just add a field

### Implementation Shape

**`deriveBudget` changes:**
- Input: add `safetyMarginPercent`, `messageBudgetPercent`, `hydrationBudgetPercent`
- Output: replace `MemoryAssemblyBudget.reservedTokens` with `hydrationBudgetMax: number` (ceiling) and `messageBudgetMin: number` (floor)
- Logic: allocatable = contextWindow - fixedCosts - safetyReserve. `hydrationBudgetMax = floor(allocatable * hydrationPercent / 100)`. `messageBudgetMin = floor(allocatable * messagePercent / 100)`. Both floored at 0.
- Invariant: if allocatable <= 0 after fixed costs, log warning

**sdk.ts changes:**
- After hydration: if `actualHydratedTokens > budget.hydrationBudgetMax`, enforce cap at entry level — drop lowest-MMR-ranked recalled entries until total fits within `hydrationBudgetMax`. Do not truncate the XML blob.
- Effective message budget: `allocatable - min(actualHydratedTokens, budget.hydrationBudgetMax)`, floored at `budget.messageBudgetMin`
- Pass effective message budget to second transformMessages call

**`computeBudgetDropCount` changes:**
- After computing drops, verify surviving messages start with a user turn
- If not, extend drops to next user turn boundary or prepend synthetic user message

**Settings (4 new keys under `contextManager.assembler.*`):**
- `safetyMarginPercent` (default: 5) — percentage of context window reserved as safety buffer
- `messageBudgetPercent` (default: 50) — guaranteed minimum percentage of allocatable budget for messages (expands into unused hydration)
- `hydrationBudgetPercent` (default: 50) — hard cap on hydration as percentage of allocatable budget
- `hotWindowTurns` (default: 4) — number of recent turns always kept in full

**Semantic contract:** `messageBudgetPercent` is a guaranteed floor (at least X%). `hydrationBudgetPercent` is a hard ceiling (up to X%). They are independent — not required to sum to 100. Each validated in range 0-100. Hydration cap enforcement works at the entry level (drop lowest-ranked entries), never by truncating the text blob.

---

## Dissent
**Updated:** 2026-03-10
**Decision:** ADJUST

### Findings that changed the design

1. **"Defaults must reproduce current behavior" guardrail was incompatible with the aim.** The aim requires a hydration cap; the current system has none. These cannot coexist. Resolution: defaults are a deliberate behavior change, documented in CHANGELOG. The guardrail was replaced with "defaults should be conservative."

2. **Hydration cap enforcement must work at entry level, not blob level.** The hydrator produces formatted XML with N entries. Truncating the blob corrupts output. Resolution: when hydration exceeds its budget, drop lowest-MMR-ranked entries until total fits. This means either the hydrator receives its budget and self-limits, or sdk.ts does post-hoc entry-level truncation.

3. **`messageBudgetPercent + hydrationBudgetPercent == 100` was over-constrained.** Making them independent is more flexible: message floor and hydration cap are separate concerns. If floor + cap < 100, the gap overflows to messages. If floor + cap > 100, hydration caps first, messages get their guarantee. Resolution: validate each in range 0-100 independently.

### Additional findings noted but not acted on

- Hot window can independently exceed the message guarantee (not addressed — hot window stays unbounded per earlier decision)
- char/4 might underestimate for code-heavy content, making 5% safety margin tight (accepted risk — overestimation is the common case)
- 50/50 saturated split is a guess without usage data (accepted — configurable, operator can tune)

---

## Plan
**Updated:** 2026-03-10
**Issues:** #62, #63, #64

| Issue | Title | Depends on | Status |
|-------|-------|-----------|--------|
| #62 | Budget model: type cleanup and settings contracts | none | open |
| #63 | Elastic budget: deriveBudget redesign and hydration cap enforcement | #62 | open |
| #64 | Fix front-drop API ordering: surviving messages must start with user role | none (parallel) | open |