# Successor Agent Kernel — OH Session

**Status:** Aim framed
**OH endeavor:** `5a64195d-5601-4085-a231-b55445377825` — Successor Agent Kernel
**Working location:** this monorepo, under `.oh/workstreams/successor-agent-kernel/`, until the build is ready for a dedicated repo.

## Aim

**Aim:** We can develop through a reliable, inspectable, UI-agnostic agent kernel instead of fighting a terminal app whose transcript-shaped state leaks into context, memory, and tool behavior.

**Why it matters:** The constrained-fork path has hit a fundamental architecture limit. oh-omp’s current message/content spine makes context assembly, concept lookup, recall, tool identity, subagents, and UI state fight over rendered transcript text. Continuing to patch that spine will harden the wrong abstraction and keep producing noisy memory, missing provenance, fragile context injection, and UI/runtime coupling.

**Current State:** oh-omp is the daily-driver harness and the executable research corpus, but its runtime is terminal-app-centric. Provider-ish `AgentMessage[]` and rendered text act as de facto source of truth. Context assembly, concept graph, recall, slash commands, tool previews, and session replay are bolted around that shape. Frontends are not clean clients of a headless core.

**Desired State:** A headless RPC-driven core agentic loop owns canonical session/provenance state, tool lifecycle, context assembly, memory projections, provider request construction, and replay/debug traces. Terminal TUI is one frontend client; other clients can emerge later without rewriting the kernel. oh-omp remains spec-in-code and dogfood oracle until successor cutover is justified.

### Mechanism

**Change:** Build a successor agent kernel as a dedicated OH workstream: start with a headless RPC core loop, not a UI rewrite. Extract only the oh-omp behavior we actually use, drop unused legacy/fork constraints, and make context assembly/memory/provenance native kernel behavior rather than transforms over transcript-shaped messages.

**Hypothesis:** If canonical state is event/provenance-first and all consumers use explicit projections — provider request, UI stream, recall, concept graph, transcript/export, replay — then the harness becomes more reliable, inspectable, modular, and extensible than oh-omp can become through local patches. A narrow vertical spike can prove or falsify this before committing to a full successor.

**Assumptions:**
- The observed failures share a common architectural root: rendered/provider-ish messages became the internal truth model.
- A small headless core can preserve daily-driver essentials while omitting unused oh-omp surface area.
- RPC boundaries will reduce UI/runtime coupling rather than introduce excessive latency or complexity.
- Context assembly can be cleaner and more stable when it consumes provenance/events directly instead of transcript text.
- oh-omp can remain available as daily driver while the successor proves itself; we do not need a big-bang cutover.
- The first vertical slice can be small enough to build and dogfood before architectural enthusiasm outruns evidence.

**Misunderstanding Signal:** We start measuring success by module parity, language choice, UI polish, or rewrite velocity instead of whether a real coding session becomes more reliable, inspectable, and less contaminated by transcript-shaped state. Another misunderstanding signal: agents are dispatched to port features before the kernel contract and cutover gates are explicit.

### Feedback

**Signal:** The successor vertical slice can complete a real small coding task through the headless core with:
- inspectable provider request and context assembly trace;
- stable tool call/result identity and replay;
- no concept/memory query contamination from assistant reports or command manuals;
- a terminal client consuming RPC stream events rather than owning runtime truth;
- session resume/replay sufficient to debug what happened;
- less code/path entanglement than the corresponding oh-omp flow.

**Timeframe:** First signal should come from a timeboxed architecture/spec + vertical spike, not a full rewrite. If a minimal submit → assemble → provider/tool stream → persist/replay path cannot feel simpler than oh-omp, the premise is suspect.

### Guardrails

- **No feature-parity rewrite.** Preserve only daily-driver behaviors we choose explicitly. Drop legacy compaction, upstream compatibility, unused slash commands, and broad extension parity unless justified.
- **No UI-first build.** The terminal UI is a client; the kernel and RPC protocol are the product center.
- **No transcript-shaped canonical state.** Provider messages, transcript, and UI timeline are projections, not the source of truth.
- **No agent coding horde before kernel contract.** Agents may map, characterize, test, and review; they must not independently invent the core ontology or mass-port modules.
- **No indefinite dual production harness.** oh-omp remains daily driver during proof, but successor needs explicit cutover gates. If it cannot meet them, stop rather than maintain two systems forever.
- **No native/Rust fetish.** Native code is allowed where it serves storage/projection/performance, but the architecture is the point, not the language.
- **Prove with a vertical slice.** If the first headless core path recreates oh-omp complexity, leaks transcript state back in, or requires heuristic parsing to make memory work, pause and revisit the premise.

### Immediate Next Phase

Move to `/problem-space` for the successor build, not implementation. Map:
- minimum viable headless core loop;
- canonical state model options;
- RPC protocol surface;
- daily-driver behaviors to preserve/drop;
- oh-omp contract-mining targets;
- vertical spike boundaries and kill criteria.


---

## Problem Space

**Scope:** Successor-agent-kernel build framing: what terrain must be understood before choosing architecture, first spike, repository/package shape, or implementation plan. This is not yet a solution design.

### Objective

We are optimizing for **a daily-driver agent kernel whose runtime truth is inspectable, provenance-aware, UI-agnostic, and reliable under long coding sessions**.

Success means the successor can run a real coding task through a headless core where provider requests, context assembly, tool lifecycle, memory hits, replay, and UI stream are all explicit projections over canonical state — not inferred from rendered transcript text. Failure disappears when concept/memory query contamination, lost tool identity, UI/runtime coupling, and prompt black-boxing are impossible by construction rather than patched case-by-case.

### Constraints

| Constraint | Type | Reason | Question? |
|---|---|---|---|
| oh-omp remains the daily driver until successor cutover gates are met | hard | We need a working harness during the build; big-bang replacement would destroy feedback and reliability | No, unless successor rapidly becomes usable enough to dogfood safely |
| The successor starts as a dedicated OH/workstream in this monorepo | hard for now | User decision: stay here until ready for a dedicated repo; preserves access to oh-omp as spec-in-code | Can change once package boundaries or repo hygiene demand it |
| No constrained-fork/upstream-compatibility mission | hard | User confirmed this path has been abandoned; upstream-shaped constraints are now misleading | No, unless a later business reason revives it |
| No feature-parity rewrite | hard | Parity imports accidental complexity and unused surfaces; objective is daily-driver successor, not clone | Individual behaviors may be preserved only by explicit selection |
| Headless RPC core first; UI is client | hard | Multi-frontend modularity and runtime/UI separation are central to the aim | No; UI details can vary, but kernel truth must not live in TUI |
| Provider messages are projections, not canonical state | hard | This is the diagnosed architecture limit; violating it recreates oh-omp's failure mode | No, this is the core bet |
| Context assembly/memory/provenance are native kernel concerns | hard | The failure pattern comes from bolting them onto transcript-shaped messages | No, unless spike proves native kernel makes things worse |
| Use oh-omp as executable evidence, not source to port wholesale | hard | Existing code contains scar tissue and behavior contracts, but also wrong abstractions | No for wholesale porting; yes for selected contract mining |
| Avoid indefinite dual production systems | hard | Running two harnesses forever is maintenance failure | Cutover gates may change, but a no-cutover path invalidates the project |
| Native/Rust is optional, architecture-driven | hard | Language is not the point; premature native split can hide bad contracts | Can revisit when storage/projection/performance contracts stabilize |
| Agent hordes must not design the ontology independently | hard | Parallel architectural invention creates incompatible kernels | Agents may map/test/review bounded areas after central contract exists |
| First proof must be a narrow vertical slice | hard | Prevents speculative architecture from outrunning evidence | No; scope can shrink further, not expand |
| RPC overhead is acceptable | assumed | Multi-frontend and headless operation need a boundary; local RPC should be cheap enough | Must be measured in spike |
| Event/provenance-first state can remain understandable | assumed | More explicit state can also become ceremony if over-modeled | Spike must prove simpler debugging than oh-omp |
| We know which oh-omp behaviors are actually used | assumed | User and dogfood history give signal, but inventory is incomplete | Must be answered by contract-mining phase |

### Terrain

- **Systems:**
  - Existing oh-omp/coding-agent session manager, `AgentMessage[]` projection, prompt transform, slash commands, TUI, tools, recall, concept graph, assembler, subagents, MCP integration, provider adapters.
  - Successor kernel: canonical state/event/provenance model, artifact/locator store, context assembly scheduler, memory projections, provider projection, RPC stream protocol, client projections, replay/debug traces.
  - Build infrastructure: monorepo packages vs dedicated repo, local OH workstream artifacts, future cutover path.
- **Stakeholders:**
  - Primary operator/daily-driver user: needs reliability, speed, inspectability, and low cognitive drag.
  - Future UI clients: terminal, headless CLI, web/editor clients; all need stable RPC semantics.
  - Future agents/subagents: need crisp tool/context/result contracts, not inferred prose.
  - Maintainer: needs a build structure that prevents two half-working harnesses and does not require full parity migration.
- **Blast radius if wrong:**
  - Wrong canonical state model → successor repeats oh-omp's central failure with more code.
  - Overbroad rewrite → months of unusable parallel harness and lost daily-driver feedback.
  - Under-scoped spike → false confidence from a toy loop that avoids the hard problems (tools, context, replay, UI stream).
  - UI-first implementation → RPC becomes a remote-control API for a terminal app rather than a kernel protocol.
  - Feature parity pressure → imports legacy complexity before the kernel proves itself.
  - Bad RPC/event protocol → hard-to-change public/internal contract that locks in early mistakes.
- **Precedents/metis:**
  - Concept-graph noise diagnosis: matcher fixes were insufficient because query construction used transcript-tail text; source-of-truth/provenance was the real issue.
  - ToolCallId provenance workstream: stable identity exists at ingest but is not persisted; exact recovery wants an identity spine, not turn-number heuristics.
  - Context assembly/codec work: honest recovery recipes, working-set pins, and provenance headers improved reliability by making representation explicit.
  - Repeated harness lesson: if the harness cannot say what an artifact is, where it came from, whether it is model-visible/queryable/exportable, and how to recover it, later systems parse prose and drift.

### Situation Model

- **Explains:**
  - The successor is justified only if the current abstraction limit is structural: transcript/provider-shaped messages are serving as runtime truth for too many consumers.
  - The first-order problem is not language, repo, or UI polish. It is the lack of a canonical provenance model with explicit projections.
  - The first proof must cross the hard seam: submit input → preserve intent/provenance → assemble context → stream provider/tool lifecycle → persist/replay → client consumes RPC. A pure event-log demo or pure UI demo does not prove the aim.
  - oh-omp should be mined for contracts because it encodes real daily-driver scar tissue; it should not be copied because it also encodes the wrong spine.
- **May hide:**
  - The event/provenance model may become too abstract and slow the operator down; explicitness can turn into ceremony.
  - RPC may create lifecycle, cancellation, streaming, and backpressure complexity that a monolithic TUI avoided.
  - Some oh-omp behavior we think is unused may be load-bearing in rare but important workflows.
  - Context assembly may need more than event provenance: model-specific prompt semantics, tool availability, and budget policy may dominate complexity.
  - A same-monorepo start may accidentally import old internals and re-entangle the successor.
- **Evidence quality:**
  - Observed: concept graph query contamination, stopword/generic matcher failure, missing persisted toolCallId, request-time context injection as developer messages, slash command expansion discarding structure, `AgentMessage[]` becoming the shared transform surface.
  - Inferred: these symptoms share a root in message/content-as-truth; event/provenance projections should simplify them.
  - Assumed: a small successor kernel can be simpler than oh-omp while preserving daily-driver essentials; RPC overhead and protocol complexity are manageable.

### Assumptions and Open Questions

- What is the **minimum viable kernel loop** that genuinely tests the architecture? — If too small, it proves nothing; if too large, it becomes a rewrite swamp. Answer before `/solution-space`.
- What canonical state shape is sufficient: append-only event log, state machine with event audit trail, or hybrid? — Wrong choice affects replay, projection, migrations, and debugging.
- What must RPC expose initially: submit, stream events, cancel, approve tool, inspect prompt, replay, session load? — Overexpose too early and the protocol fossilizes; underexpose and clients become privileged hacks.
- Which oh-omp behaviors are **daily-driver essential** vs legacy/accidental? — Risk: feature parity creep or dropping a load-bearing workflow. Requires contract-mining inventory.
- What is the first storage layer: in-memory + WAL, SQLite, event-sourced files, or something else? — Affects replay, corruption recovery, schema evolution, and speed.
- How native should the first implementation be? — Risk: TypeScript-only hides future performance problems; native-first slows ontology learning. Decide by spike requirements, not preference.
- What is the cutover strategy? — Risk: indefinite dual systems. Need explicit dogfood and daily-driver gates.
- How will agents contribute safely? — Risk: parallel ontology drift. Need bounded mapping/testing/review roles before implementation agents.
- What would prove greenfield wrong? — Must define before building: if vertical slice is not simpler/clearer than oh-omp, stop or shrink.

### Frame-Stress Signals

- The first vertical slice needs heuristic transcript parsing for concept/memory intent → architecture has not escaped the failure mode.
- Provider messages or UI timeline become canonical again → old spine has reappeared under a new name.
- RPC protocol starts mirroring terminal UI state instead of kernel lifecycle events → UI-first drift.
- The project plan starts tracking feature parity or module ports instead of daily-driver outcomes and kernel invariants → rewrite-for-rewrite's-sake drift.
- Agents are assigned broad implementation before event/projection/RPC contracts are frozen enough for review → architecture entropy risk.
- A second production harness persists without cutover gates or kill criteria → parallel-system failure.
- The spike cannot produce an inspectable provider request/context trace/replay for a small real task → core value proposition unproven.
- Maintaining selected oh-omp behavior requires importing large old subsystems wholesale → successor boundary is not clean enough.
- Latency/backpressure/cancellation over RPC make normal tool/model streaming worse than oh-omp → headless boundary may be wrong or too early.
- The event/provenance model becomes so verbose that ordinary feature work slows dramatically → over-modeled kernel.

### Ready for Solution Space?

**Yes, with two required inputs to carry forward.** The objective, constraints, terrain, blast radius, assumptions, and stress signals are explicit enough to compare build structures. `/solution-space` must not jump to implementation; it should choose the **first proof shape**: package/repo boundary, canonical state model candidate, RPC surface candidate, contract-mining plan, and vertical spike/kill criteria. The main unresolved facts — exact essential oh-omp workflows and storage/native split — can be retired inside the first planning/spike phase, not before choosing the solution direction.

---

## Investigation Addendum — Memex reuse scan

**Scope:** Fast reuse assessment of sibling repo `/Users/drazen/playground/ai-omnibus/memex` and workspace spec `/Users/drazen/playground/ai-omnibus/docs/2026-01-10-memex-spec.md` while framing the successor-agent-kernel problem space.

### Findings

Memex is directly relevant. Many ideas we are now naming for the successor already exist there in partial form: Tauri-free business logic, context space, context assembler, LanceDB storage, retrieval events, tool-call persistence, embedding daemon/hosted embeddings, MCP read access, module-owned storage/tools/context contributions, and streaming agentic loop events.

However, memex is **not** a drop-in successor kernel. It is a knowledge/desktop-agent system with useful substrate crates and patterns, but it still has important mismatches with the desired headless coding-agent kernel.

### Reusable candidates

| Area | Memex artifact | Reuse level | Notes |
|---|---|---|---|
| Tauri-free core boundary | `memex-core` | high as precedent, medium as code | `lib.rs` explicitly describes frontend-independent business logic usable by TUI/HTTP/MCP. This validates the headless-core direction. But core has frontend binding leakage (`ts_rs` exports to `muse-ui`) and app-specific concepts. |
| Context assembly | `memex-core/src/context/*` | high as precedent, selective code reuse | Has `ContextSpace`, `ContextAssembler`, simhash-gated cache, token budget enforcement, assembly report, module context contributions, recent tool calls, reminders. Strong conceptual precursor. Mismatch: assembler still consumes `messages: &[Message]` and includes compaction/message-history assumptions; successor should consume event/provenance projections. |
| Assembly report / observability | `context/report.rs`, `ContextSpace.assembly_report` | high | Directly aligned with inspectable provider/context trace. Need inspect further before reuse, but concept should carry forward. |
| Storage / vector search | `memex-storage` | medium-high | LanceDB schemas and table ops for distillations/documents/evaluations/tool_calls/retrieval_events are mature enough to mine. But successor may need an event log + artifact store, not only LanceDB tables. |
| Tool-call persistence | `memex-storage/src/tool_calls.rs` | high as design input, medium as code | Stores `id`, `conversation_id`, `message_id`, tool name/input/result/error/embedding, BTree index, lookup by ID, recent calls, vector search. This is close to our tool-result locator/recovery needs, though successor needs lifecycle events (started/streamed/completed/canceled) and stable provider `toolCallId`, not just post-hoc stored call rows. |
| Retrieval telemetry | `memex-storage/src/retrieval_events.rs` | high as design input | Logs retrieved item, query embedding, distance, timestamp; supports retrieval stats and stale/noise GC. This maps well to concept/recall relevance audits and memory self-improvement. |
| Embeddings | `memex-embedding` | medium | Provides hosted embedding, OpenAI fallback, daemon over Unix socket, 2560-dim constant. Useful substrate, but hosted/license/cloud dependency means it cannot be required for the core loop. |
| Agentic loop | `memex-core/src/agentic/engine.rs` | medium as precedent, low-medium as code | Has streaming `AgenticEventEnvelope`, max iterations, cancellation token, tool wave planner (parallel/effect/terminal), tool result distillation. Valuable patterns. But it is Claude/tool/model-specific and not the desired RPC kernel protocol as-is. |
| Module system | `memex-core/src/modules/*` | medium-high as precedent | `MemexModule` exposes tools, system prompt sections, context contributions, storage init, lifecycle. This is close to a kernel capability/module contract. Needs adaptation to coding tools, event visibility, and RPC/client semantics. |
| MCP server | `memex-mcp` | low as code, medium as precedent | Node MCP server shells out to `memex` CLI for read-only search. Good proof of external access, but not suitable as kernel RPC; it is stateless, read-only, CLI-mediated. |
| Provider abstraction | `attractor` crate | needs follow-up | Search found provider stream types (`Request`, `StreamEvent`, adapters). Potentially very relevant for provider projection; not inspected deeply yet. |
| Headless shell | `agent-shell` | needs follow-up | Uses `memex_core::agentic::run_agentic_loop_streaming` and `ContextAssembler` from a shell. Potential prototype evidence for non-Tauri frontend. Needs deeper read before reuse decision. |

### Non-reuse warnings

- Memex context assembly still centers on `conversation: Vec<Message>` and `assemble(conversation_id, messages)`. It improves on oh-omp but does not fully solve the successor's core requirement: event/provenance-first canonical state with provider messages as projection.
- Some `memex-core` types export TS bindings directly to `muse-ui`, so the core is not perfectly UI-agnostic despite the intended boundary.
- `ContextSpace.to_system_context()` formats assembled context as prompt markdown sections. Useful, but successor must keep the structured assembly trace as canonical and treat markdown/provider text as a projection.
- `memex-storage` is LanceDB-first. That is excellent for vector/search artifacts but may not be the right primary event log. The successor likely needs both: an append-only event/artifact log and vector/search projections.
- The MCP server is not an RPC kernel; it is read-only JSON-RPC over stdio that shells out to CLI.
- Embedding stack is useful but cloud/license-dependent; successor core must degrade without embeddings.

### Problem-space impact

Memex changes the terrain materially: the successor should not start from a blank page. There is reusable code and, more importantly, proven local metis for context assembly, retrieval telemetry, tool-call storage, module-owned storage/context, and streaming agent loops.

But memex also reinforces the central risk: it began solving the same problems and still retained a message-shaped context boundary in important places. The successor must decide what to reuse **below** the canonical boundary (storage, embeddings, tool-call lookup, reports, module contracts) while avoiding reuse that preserves `messages -> context` as the truth path.

### Follow-up before solution-space

- Read `attractor` stream/provider types and decide whether provider projection should reuse it or only copy concepts.
- Read `agent-shell/src/chat.rs` to see how cleanly a non-Tauri frontend uses `memex-core`.
- Read `context/report.rs` and `context/budget.rs` for assembly trace/budget reuse.
- Read `memex-storage/src/sessions.rs` and `messages.rs` to understand whether Memex session state is closer to event log than oh-omp.
- Identify whether `memex-storage` can be vendored/reused directly in a successor package or whether it should be mined into a new storage kernel.

### Revised problem-space constraint

| Constraint | Type | Reason | Question? |
|---|---|---|---|
| Mine memex before designing successor primitives | hard | Memex already contains local implementations of context assembly, storage, retrieval telemetry, embedding, tool-call memory, and frontend-independent core ideas. Ignoring it would repeat work and miss local metis. | No; depth of reuse remains open. |
| Do not inherit memex's message-shaped assembly boundary blindly | hard | The successor's core aim is to avoid context/memory over rendered/provider-ish messages. Memex improves the boundary but does not fully invert it. | No; individual modules may still be reused below the boundary. |

---

## Investigation Addendum — Memex follow-up deep dive

**Scope:** Follow-up reads requested before solution-space: `attractor`, `agent-shell`, `context/report.rs`, `context/budget.rs`, `memex-storage/src/sessions.rs`, and `memex-storage/src/messages.rs`. Goal was to decide whether Memex gives us clean reusable implementation pieces or only conceptual precedent.

### Detailed findings

#### 1. `attractor` is a strong provider-projection candidate, not a kernel state model

`attractor` is a provider-agnostic LLM client crate with clear request/response/stream/message/tool abstractions:
- `Request { model, messages, provider, tools, tool_choice, response_format, temperature, max_tokens, reasoning_effort, metadata, provider_options }`
- `Message { role, content: Vec<ContentPart>, name, tool_call_id }`
- `ContentKind::{Text, Image, Audio, Document, ToolCall, ToolResult, Thinking}`
- `ToolCallData { id, name, arguments }` and `ToolResultData { tool_call_id, content, is_error }`
- `StreamEventType::{StreamStart, TextDelta, ReasoningDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Finish, Error, ProviderEvent}`

**Reuse verdict:** high for provider projection. This is close to what the successor should emit *to providers* and receive *from providers*. But it must not become canonical kernel state. Its `Request.messages: Vec<Message>` is still provider-shaped; successor state should project into `attractor::Request`, not be stored as it.

**Problem-space implication:** Add `attractor` to solution-space as a candidate dependency for provider adapters/stream normalization. Do not design a provider abstraction from scratch until `attractor` is evaluated for model coverage and active health.

#### 2. `agent-shell` is a frontend precedent, not the target RPC architecture

`agent-shell/src/chat.rs` shows a useful non-main-app shell over `memex_core`:
- lazy shared `ClaudeClient`;
- per-conversation cancellation tokens with request sequencing;
- shared `AssemblerCache`;
- early `Thinking` event emission;
- `run_agentic_loop_streaming(..., emit, cancel_token)`;
- event envelope sent over `tauri::Emitter` as `agentic:update`.

**Reuse verdict:** medium as a lifecycle pattern. It proves memex-core can drive a frontend-ish shell with streaming and cancellation. It is not headless RPC: it is Tauri-bound (`tauri::Emitter`), uses globals, and takes `history: Vec<Message>` + `user_message` rather than a canonical event/provenance input.

**Problem-space implication:** Mine its cancellation/request-sequencing and streaming lifecycle, but do not reuse it as successor server architecture. The successor RPC stream should be kernel lifecycle events, not Tauri UI events.

#### 3. Memex `AgenticEvent` envelope is too UI-shaped for successor RPC

`AgenticEventEnvelope { conversation_id, #[serde(flatten)] event }` routes events to frontend tabs. `AgenticEvent` includes:
- `Thinking`, `ThinkingChunk`, `Retrying`;
- `ToolStart { name }`, `ToolComplete { name, result, is_error }`;
- `TextChunk`, `Done`, `Error`, `Cancelled`;
- `DebugLog`, `CellCreated`, `SkillCreated`, `Usage`, `ActionsReady`, `BackgroundToolError`.

**Reuse verdict:** medium as event taxonomy source, low as direct protocol. It lacks stable turn/request/event IDs on every event, has tool events keyed by name not call ID, and contains UI/app-specific events (`CellCreated`, `ActionsReady`, TS export to `muse-ui`).

**Problem-space implication:** Successor RPC should learn from the taxonomy but require stronger envelope invariants: session_id, turn_id, request_id, event_id, parent_event_id/tool_call_id where relevant, monotonic sequence, visibility/debug category, and replay semantics.

#### 4. `context/report.rs` is strongly reusable conceptually, but its queries reveal the same trap

`AssemblyReport` captures searches performed, included/excluded section stats, theme clusters, and budget. It renders a markdown report with:
- hot query derived from last 3 messages;
- warm query derived from last 15 messages;
- cache hit/miss;
- included counts/tokens/themes;
- available-for-expansion clusters;
- budget summary.

**Reuse verdict:** high for assembly-trace shape, low for query source. The report should be carried forward as a structured trace/projection, but hot/warm queries derived from message windows are exactly the failure mode we diagnosed in oh-omp concept graph.

**Problem-space implication:** Successor should have a first-class `AssemblyTrace` inspired by this, but source fields must be provenance/intent/query-plan based, not `last N messages`. Markdown rendering is a UI/model projection of the trace, not the trace itself.

#### 5. `context/budget.rs` is useful but too static/message-based for successor budget planning

Budget module has explicit allocation (`conversation`, `distillations`, `documents`, `modules`), dynamic rebalancing from empty sections, per-section budget reports, and truncation helpers. It uses a fixed `TOTAL_BUDGET = 128000` and rough `chars/4` token estimates, with conversation truncation over `&[Message]`.

**Reuse verdict:** medium. Carry forward the concepts — budget sections, dynamic rebalancing, per-section drop reports — but not fixed constants or message-history truncation as the central policy.

**Problem-space implication:** Successor budget planning should be model-window aware, projection aware, and artifact/locator aware. It should report exactly what was dropped and how to recover/expand it.

#### 6. `memex-storage` session/message tables are not the successor event log

`sessions.rs` stores notebook-like sessions and cells: sessions with `cell_order`, cells with `cell_type` and `content`. `messages.rs` stores provider/conversation-like rows with `role`, `content`, graph columns (`parent_id`, `branch_from`, `version`, etc.), optional summary, and optional embedding. It creates BTree indexes on `id`/`conversation_id` and supports migrations/backfills.

**Reuse verdict:** low for canonical successor state, medium for storage patterns. This is still message/cell-shaped state, not a provenance event log. It also exports TS bindings to `muse-ui`, another UI coupling warning. However, LanceDB table patterns, migrations, graph columns, summary/embedding backfill, and indexing are useful implementation examples.

**Problem-space implication:** Do not base successor canonical state on Memex `messages` or `sessions`. Design an event/provenance log separately, then decide which memex storage helpers/table patterns can be reused for projections.

### Revised reuse matrix

| Artifact | Direct dependency? | Mine concepts? | Main reason |
|---|---:|---:|---|
| `attractor` | likely yes for provider projection | yes | Clean provider request/message/stream/tool abstractions; not canonical state |
| `memex-core/context/report.rs` | maybe partial | yes | Strong assembly trace/report shape; query source must change |
| `memex-core/context/budget.rs` | maybe partial | yes | Budget sections/drop reports useful; static/message-based policy unsuitable |
| `memex-storage/tool_calls.rs` | maybe partial | yes | Tool-call lookup/persistence close to our identity needs, but needs lifecycle events |
| `memex-storage/retrieval_events.rs` | maybe partial | yes | Retrieval audit telemetry maps directly to memory relevance audits |
| `memex-storage/messages.rs` | no as canonical | yes | Good LanceDB patterns; message-shaped state is the wrong truth model |
| `memex-storage/sessions.rs` | no as canonical | yes | Notebook/cell state not successor kernel event log |
| `agent-shell` | no | yes | Useful cancellation/streaming shell; Tauri/global/message-history bound |
| `AgenticEventEnvelope` | no | yes | UI event taxonomy useful; lacks strong replay/provenance IDs |
| `memex-embedding` | maybe optional | yes | Useful embedding client/daemon/hosted stack; core must degrade without it |

### Stronger problem-space conclusion

Memex reduces blank-page risk but does not eliminate the need for a successor kernel design. The likely best path is **reuse below the projection boundary**: provider normalization (`attractor`), storage/table patterns, retrieval telemetry, assembly report concepts, budget reporting concepts, and perhaps embedding infrastructure. The successor must still define its own canonical event/provenance log, RPC event envelope, context assembly inputs, and visibility/projection model.

### New open questions for solution-space

- Should `attractor` become the provider projection crate in the first spike, or should the first spike keep a minimal provider shim to avoid dependency drag?
- Should LanceDB be used for the canonical event log, or only for searchable/vector projections? Memex evidence suggests LanceDB is strong for projections but awkward for append-only canonical event history.
- What is the minimum successor RPC envelope that fixes Memex/oh-omp weaknesses: `session_id`, `turn_id`, `request_id`, `event_id`, `seq`, `kind`, `parent_event_id`, `visibility`, `payload`, `trace_refs`?
- Can Memex `AssemblyReport` be generalized into a structured `AssemblyTrace` without carrying hot/warm message-window assumptions?
- Which memex crates can be imported directly without UI/Tauri binding leakage? `attractor` looks cleanest; `memex-core` less so.

---

## Investigation Addendum — `context-assembler-ref` synthesis

**Scope:** Corrected target after initial false start. The relevant repo is `/Users/drazen/playground/ai-omnibus/context-assembler-ref`, not the similarly named `worktrees/task-7v-*` copies. This pass read its planning docs, architecture brief, requirements, envelope/projection/storage docs, assembler engine, service routes, policy engine, retrieval pipeline, and dead-letter replay CLI docs/source.

### Executive synthesis

`context-assembler-ref` is the strongest local precedent so far for the successor-agent-kernel. It is not just a context-assembly library; it is a context platform prototype named **The Feed** with:
- canonical source envelopes;
- typed extension capsules;
- deterministic idempotency;
- source/write model and assembler/read model separation;
- projection runtime contracts;
- policy-as-data kill switches;
- dead-letter replay planning/audit;
- `/assemble` as structured context retrieval without LLM invocation;
- `/message` as retrieval-augmented generation over SSE;
- contract fixtures and projection gates as first-class readiness criteria.

The core lesson is stronger than memex's: **context should be a platform contract, not an app-local memory heuristic.** However, it still remains a retrieval/context platform, not a full coding-agent kernel. It has message-shaped prompt construction and LLM/SSE paths that should not become the successor's canonical loop.

### High-value primitives to carry forward

| Primitive | Location / Evidence | Reuse posture | Successor implication |
|---|---|---|---|
| Canonical envelope | `assembler-envelope/src/envelope.rs`, prebuild checklist | High as design, possible code reuse | Successor events need stable core fields, append-only versioning, source-owned payload, `ingested_at`, partitioning, and validation. |
| Typed extensions | `assembler-envelope/src/extension.rs` | High | Use typed extension capsules for optional domain-specific data instead of untyped metadata sprawl. Invalid extensions should not corrupt hot path. |
| Deterministic idempotency | `compute_idempotency_key(source, source_event_id, source_schema_version)` | High | Every externally sourced event/tool artifact should have deterministic replay-safe identity separate from generated event IDs. |
| Source/read-model split | storage topology + projection runtime docs | Very high | The successor must separate source-of-truth events from query/read/projection stores. This directly avoids message-projection confusion. |
| Projection runtime contract | `context-assembler-solution-space-projection-runtime.md` | High | Projection should have explicit checkpoints, idempotency, dead-letter handling, and CI fixture gates, not ad-hoc background jobs. |
| Source declaration v0 | `context-assembler-source-declaration-v0.md` | High | Sources/capabilities should declare schema, projections, scope, and validation. This may be better than implicit plugin registration. |
| Contract fixtures + projection gates | requirements/prebuild checklist | Very high | Drift must be test failure. Each source/projection should ship canonical fixtures and expected read-model outputs. |
| Retrieval policy kill switch | `policy.rs`, checklist | High | Retrieval/memory sources need ops controls that disable serving without stopping ingest/projection. Important for noisy concept/memory sources. |
| Policy-as-data | `SourcePolicy { enabled, weight_override, reason, updated_by }` | High | Policy changes should be audited and replayable; successor should avoid hardcoded source weights and hidden toggles. |
| Degraded-but-safe retrieval | `retrieval.rs` | High | If embed/vector/search fails, return no/partial context with explicit degradation reasons, not hard failure or silent stale context. |
| `/assemble` structured retrieval | `routes.rs`, phase 05-02 | Very high | A context API that returns structured items/scores/sources without invoking LLM is directly useful for kernel internals and external agents. |
| MMR + simhash + recency pipeline | `retrieval.rs`, `scoring.rs`, engine modules | Medium-high | Useful retrieval mechanics, but scoring constants/keyword detection are app-specific and must not become unexplained policy. |
| Dead-letter replay plan/apply/status | docs + `assembler-cli/src/replay.rs`, `audit.rs` | Very high | Recovery workflows should be deterministic, previewable, hash-confirmed, idempotent, and audited. This is exactly the operational discipline the successor needs. |
| Build-now guardrails | `context-assembler-build-now-guardrails.md` | High | Build can start before every ops detail is perfect, but production cutover requires contract fixtures, replay, kill switches, SLO/runbooks. |
| Agent self-integration prompt | phase 05-02, `docs/agent-integration-prompt.md` | Medium-high | The idea that an agent can integrate by reading a self-contained contract is powerful. Successor RPC/API should be teachable to agents this way. |

### Important mismatches / do-not-copy boundaries

- `assembler-engine::construct_prompt` returns provider-ish `ChatMessage` vectors and inserts `Retrieved Context` as system text. This is useful as a provider projection, but not as canonical successor state.
- The `/message` route is a retrieval-augmented chat endpoint that keeps in-memory-ish session history and streams `{delta}` SSE. The successor kernel needs richer lifecycle events with stable IDs, tool events, assembly traces, replay semantics, and UI-agnostic envelopes.
- `MessageRequest { message, session_id }` is too weak for the successor. We need explicit turn/request/event identity, raw input, command intent, tool lifecycle, context assembly trace, and visibility/projection metadata.
- Retrieval scoring includes keyword-based `is_code_query` and recency constants. Useful experiments, but the successor should put source weighting and task policy into explicit policy/read models, not hidden scorer heuristics.
- The service is Azure/Cosmos/EventHub-oriented. The topology concepts are reusable; the concrete cloud dependencies are not necessarily right for the local headless daily-driver kernel.
- `/assemble` is close to what we need, but it still accepts an opaque query string. For the successor, the query should be produced from structured intent/provenance projections, not transcript parsing.

### Strongest synthesis with memex

Memex and `context-assembler-ref` complement each other:

- **Memex** gives local code for context assembly, storage schemas, retrieval telemetry, tool-call memory, module contracts, embeddings, and provider/client experiments.
- **context-assembler-ref** gives stronger platform discipline: canonical envelopes, source declarations, projection runtime, contract fixtures, kill switches, dead-letter replay, source/read-model separation, and agent-self-integration API shape.

The successor should synthesize them as follows:

1. **Canonical truth:** take the envelope/source/read-model discipline from `context-assembler-ref`, not memex messages/sessions and not oh-omp `AgentMessage[]`.
2. **Provider projection:** evaluate `memex/attractor` for provider request/stream normalization.
3. **Context API shape:** take `/assemble` as a core projection concept: structured context retrieval without LLM invocation.
4. **Assembly trace:** combine memex `AssemblyReport` with `context-assembler-ref` source attribution/degradation/policy signals into a structured `AssemblyTrace`.
5. **Storage:** use an append-only local event/artifact log for canonical state; use LanceDB/vector stores/Cosmos-like read models only as projections.
6. **Operations:** import `context-assembler-ref` stop-lines: contract fixtures, projection gates, replay CLI, retrieval kill switch, SLOs before serious dogfood/cutover.
7. **Agent integration:** APIs/protocol should be self-describing enough that an agent can register/push/pull or inspect context from docs/skills, but this must be backed by typed contracts, not prompt lore alone.

### Revised problem-space model

The successor should not merely be “an event/provenance-native coding agent.” It should be a **local agent kernel plus context platform**:

- The **kernel** owns turn lifecycle, tool lifecycle, provider projection, RPC stream, session replay, and UI/client projections.
- The **context platform** owns source declarations, ingest envelopes, retrieval/projection read models, policy controls, assembly trace, and degradation/replay operations.
- They meet at typed projections: provider request, context assembly, memory retrieval, tool/artifact locator, UI timeline, transcript/export.

This avoids two bad extremes:
- baking memory/context into the agent loop as app-local heuristics;
- building a generic Feed service that cannot represent coding-agent turn/tool/provider lifecycle.

### Carry-forward constraints

| Constraint | Type | Reason | Question? |
|---|---|---|---|
| Mine `context-assembler-ref` before designing kernel/context contracts | hard | It contains the most mature local thinking on canonical envelopes, projections, policy, and recovery. | No |
| Do not make `/message`-style RAG chat the successor core | hard | The successor needs a tool-using agent kernel, not a context service wrapped around chat history. | No |
| `/assemble`-style structured retrieval should exist independently of LLM invocation | hard | This is the clean seam for context assembly, debugging, external agents, and relevance audits. | No |
| Canonical state must be separate from read models/projections | hard | `context-assembler-ref` correctly treats source facts/envelopes and assembly vectors/views differently. | No |
| Projection drift must be caught by fixtures/gates | hard | Without contract fixtures, source/read-model drift becomes runtime noise. | No |
| Retrieval sources need kill switches from day one | hard | Noisy memory/concept sources must be disable-able in serving without stopping ingest. | No |
| Replay/recovery must be plan/apply/audit, not ad-hoc scripts | hard | Daily-driver reliability requires deterministic recovery and forensic traceability. | No |

### New open questions for solution-space

- Should the first successor spike implement a local version of the `context-assembler-ref` envelope (`Envelope`) directly, or design a coding-agent-specific `KernelEvent` that embeds Feed-style fields?
- Should `/assemble` be an internal kernel RPC method from day one, or a separate context-platform service endpoint inside the same process?
- What is the first projection runtime? In-process projector over a local append-only log, SQLite triggers, async worker, or explicit command/rebuild?
- What store backs canonical events locally: SQLite event table, append-only JSONL + snapshots, sled/redb, or something else? `context-assembler-ref` is cloud/Cosmos oriented, so this remains open.
- Which invariants from `context-assembler-ref` become non-negotiable cutover gates: contract fixtures, kill switch, dead-letter replay, source declarations, SLOs?
- How do source declarations map to coding-agent sources: user input, slash command expansion, tool call, tool result, subagent result, context injection, concept fact, recall artifact, external repo code symbol?
- How do we avoid duplicating the concept platform and the agent kernel into two half-integrated systems? Need a crisp boundary and a small first vertical slice.

### Frame-stress additions

- If successor context retrieval has no `/assemble`-like structured API and only appears as provider prompt text, the design is regressing to opaque prompt assembly.
- If projections can drift without golden fixtures, we are rebuilding another implicit memory system.
- If retrieval source disablement requires code changes or restarts, the operational model is too weak.
- If replay requires manual database edits or bespoke scripts, the event/projection architecture is not production-grade enough for daily-driver trust.
- If the first spike cannot show source envelope -> projection -> assemble -> provider request with traceable IDs, it has not tested the hard part.

---

## Architecture Clarification — remote context platform + local agent kernel

**Prompt:** “Are we thinking remote context platform, tighter than what we have in `context-assembler-ref` (or not), and then local agent kernel loop?”

### Current answer

**Yes, but with a sharper boundary:**

- The **agent kernel loop** should be local-first and own the interactive daily-driver lifecycle: turns, tools, cancellation, provider projection, UI/RPC stream, session replay, local artifacts, and client coordination.
- The **context platform** should be service-shaped and remote-capable, but not necessarily remote-first in the first spike. It owns source declarations, ingest envelopes, projection/read models, retrieval policy, `/assemble`, assembly trace, and replay/recovery for projections.
- The first build can run both in one local process or local daemon, but the API boundary should be honest enough that the context platform could later move remote without changing kernel semantics.

### Why not make the remote context platform the whole agent?

`context-assembler-ref`’s `/message` route is a useful RAG/context demo, but the successor needs a coding-agent kernel, not a remote chat endpoint. The kernel must handle:

- provider-specific streaming;
- tool call lifecycle and approvals;
- terminal/editor/web client events;
- cancellation/backpressure;
- local file-system and shell affordances;
- turn/session replay;
- ephemeral working state;
- prompt/provider projection;
- subagent orchestration later.

Those are latency-sensitive and local-environment-sensitive. They belong in the local kernel. The context platform should not own the agent’s live control loop.

### Why keep a context-platform boundary at all?

Because context/memory has different scaling and operational semantics from the local tool loop:

- sources can be local, repo-derived, remote, organizational, or historical;
- projections can be rebuilt independently;
- noisy retrieval sources need kill switches;
- source declarations and contract fixtures should govern ingestion/projection drift;
- `/assemble` should be callable by agents, evals, and debugging tools without invoking the agent loop;
- relevance telemetry/retrieval audits should outlive one UI/client;
- remote context may later be shared across machines, repos, or teams.

So the boundary is not “remote because network is cool.” It is “context is a platform concern; the agent loop is an interactive control concern.”

### Tighter than `context-assembler-ref`?

**Tighter in scope, stronger in contracts.**

`context-assembler-ref` is a general context platform prototype. For the successor, the context platform should be narrower and more opinionated around coding-agent needs:

- source declarations for coding-agent artifacts first: user input, slash command expansion, tool call, tool result, file/read result, grep/search result, subagent result, concept fact, recall artifact, repo symbol, context injection;
- `/assemble` returns structured context items and an assembly trace, not provider messages;
- source/read-model separation is mandatory;
- policy kill switches and source weights are first-class;
- every projection has fixtures/gates;
- degradation reasons are explicit;
- source IDs and artifact locators are stable and recoverable.

But it should be **less ambitious operationally at first** than `context-assembler-ref`: no Azure/Cosmos/EventHub dependency, no production cloud topology, no generic SaaS platform scope, no full remote multi-tenant story in the first spike.

### Local-first, remote-capable topology

Recommended mental model:

```text
Frontend clients
  └─ RPC/SSE/WebSocket/stdio client protocol
      └─ Local Agent Kernel
          ├─ local event/artifact log
          ├─ turn + tool lifecycle
          ├─ provider projection
          ├─ UI timeline projection
          ├─ calls Context Platform API
          └─ emits inspectable traces

Context Platform
  ├─ source declarations
  ├─ ingest envelopes
  ├─ projection/read models
  ├─ retrieval policy / kill switches
  ├─ /assemble structured context
  ├─ assembly trace
  └─ replay/rebuild/audit operations
```

Deployment in phase 1 can be:

```text
one local binary/process with two internal modules and a real interface boundary
```

or:

```text
local kernel daemon + local context daemon over localhost RPC
```

But the first spike should avoid distributed-systems complexity unless the interface boundary is otherwise too blurry.

### Boundary rule

The kernel may ask:

- “Given this structured intent/task/source scope, assemble context under budget.”
- “Ingest this typed event/artifact into source X.”
- “Explain why this context item was included.”
- “Disable/weight source X for serving.”
- “Replay/rebuild projection Y from checkpoint Z.”

The context platform must not decide:

- whether a tool may run;
- how a UI renders live progress;
- how to stream provider deltas to clients;
- how to map provider tool calls to local tool execution lifecycle;
- how to mutate local files or shell state;
- how to drive the agent loop.

### First-spike implication

The spike should prove the seam, not remote deployment:

1. Local kernel accepts a user turn over RPC.
2. Kernel persists canonical local turn/tool/provider events.
3. Kernel emits structured source envelopes/artifacts to context platform boundary.
4. Kernel asks `/assemble` with structured intent, not transcript text.
5. Context platform returns structured context items + trace + degradation/policy info.
6. Kernel projects provider request, streams response/tool lifecycle to client.
7. Replay can show event IDs, source envelope IDs, context item IDs, and provider request trace.

### Frame-stress signal

If the first spike makes the context platform responsible for the live agent loop, we are rebuilding a remote RAG chat service. If the first spike makes the local kernel parse transcript text for context, we are rebuilding oh-omp. The seam is correct only if each side can explain what it owns and what it refuses to own.

---

## Investigation Addendum — Memex cloud workers and remote-context calculus

**Prompt:** Embeddings are remote anyway; memex cloud workers carried much of the platform and proved powerful. Reconsider whether the context platform should be remote/local given that pattern.

### Finding

This is a real complication and likely improves the case for a remote-capable context platform. In Memex, the cloud worker layer is not incidental deployment glue; it is a platform pattern: one license credential unlocks LLM proxying, embedding proxying, and storage proxying while keeping infrastructure credentials away from clients and routing users to isolated storage.

Read artifacts:
- `memex/docs/cloud-provisioning-spec.md`
- `memex/cloud/llm-proxy/worker.ts`
- `memex/cloud/embed-proxy/worker.ts`
- `memex/cloud/storage-proxy/worker.ts`
- `memex/cloud/admin/src/index.ts`
- `memex/memex-storage/src/cloud.rs`
- `memex/server/src/main.rs`, `models/event.rs`, `routes/events.rs`, `db.rs`

### Memex worker pattern

Memex cloud decomposes platform responsibilities into edge workers:

| Worker / service | Role | Pattern worth carrying |
|---|---|---|
| Admin worker | Provisions users, creates R2 buckets/tokens, stores mapping in D1, signs license JWT, supports revoke/migration/modules | One credential + per-user resource isolation + admin control plane |
| LLM proxy | Validates JWT, swaps license for upstream API key, routes Anthropic/MiniMax, rewrites model/unsupported fields, streams upstream response | Thin auth/routing/compat layer around expensive remote model calls |
| Embed proxy | Validates JWT, forwards OpenAI-compatible `/v1/embeddings`, supports gzip pass-through, legacy `/embed` shim | Embeddings as remote service with compatibility shim and shared auth |
| Storage proxy | Validates JWT from Bearer or AWS SigV4 access key, looks up per-user R2 credentials in D1/KV, validates object paths, proxies S3 ops | Cloud object/vector storage without exposing infrastructure creds |
| Feed server | Global event log / knowledge store over LanceDB with POST/GET events, namespace/type/actor/since/cursor filters | Simple remote event feed primitive; useful but not sufficient as successor canonical event model |

### Latency implication

The earlier “keep context local for latency” assumption is weaker than stated. In Memex-style deployment, expensive pieces are already network-bound:

- LLM call is remote;
- embedding call is remote;
- cloud LanceDB/R2 storage may be remote;
- remote retrieval may require embedding + vector search anyway.

If the kernel calls a local context module that then calls remote embedding/storage, the path is:

```text
kernel -> local context -> remote embed -> remote vector/storage -> local context -> kernel
```

If the context platform is co-located with embedding/storage, the path can become:

```text
kernel -> remote context platform -> local-to-platform embed/vector/storage -> kernel
```

So remote context can be latency-neutral or faster, especially when it avoids multiple client↔cloud round trips and runs retrieval near the data. The right latency boundary is not simply “local good, remote bad”; it is “keep live control local, co-locate retrieval compute with remote data/embeddings when those are remote anyway.”

### Revised topology stance

The successor should support **three deployment modes** conceptually:

1. **Local-only mode:** kernel + context platform + local stores/optional local embeddings in one process/daemon. Best for offline/privacy/debug.
2. **Local kernel + remote context platform:** kernel owns live tool/provider/UI loop; remote context owns embeddings/vector/search/projections/policy. Likely best for shared memory and cloud embeddings/storage.
3. **Hybrid cache mode:** kernel keeps a local hot cache/working set and delegates cold/semantic/global context to remote platform.

The first spike can still run local-first for simplicity, but the API should be shaped so mode 2 is not a retrofit.

### Boundary refinement

Keep local:

- live agent turn state;
- tool execution and approvals;
- filesystem/shell operations;
- provider stream fanout to UI clients;
- cancellation/backpressure;
- local artifact cache and replay for the current session.

Remote-capable / platform-owned:

- embedding generation;
- vector/projection read models;
- long-term event/source feed;
- source declarations and contract fixtures;
- retrieval policies/kill switches;
- `/assemble` structured context;
- relevance telemetry and retrieval audit;
- cross-device/org shared memory;
- credential mediation for model/storage services.

### What to steal from memex cloud

- **Single user credential:** License/session token authorizes context/embedding/storage/model services; clients do not hold upstream infra credentials.
- **Thin edge proxies:** Workers should validate, route, normalize, and stream; avoid embedding app-specific reasoning in edge code.
- **Compatibility shims with removal path:** Embed proxy supports legacy `/embed` while preferring OpenAI-compatible `/v1/embeddings`. Successor should version protocols and deprecate intentionally.
- **Per-user isolation:** Remote context storage should be scoped by user/workspace with hard isolation, not only logical filters.
- **Credential caching:** Storage proxy uses D1 + KV caching for credentials. Context platform will need similar low-latency auth/scope lookup.
- **Revocation/control plane:** Admin worker has revoke/migrate/module controls. Context platform needs source/module entitlement and kill-switch control plane.
- **Path/input hardening:** Storage proxy's object-key validation is the right posture for any remote artifact API.
- **Cloud services as optional acceleration:** Local mode should degrade gracefully; cloud mode should centralize costly shared services.

### What not to inherit blindly

- Worker code duplicates JWT verification and error helpers across proxies. Successor should factor auth/token validation into shared library/contract if possible.
- Storage proxy's SigV4 JWT-in-access-key trick is pragmatic for LanceDB/R2, but should not become the general API auth model unless required by client libraries.
- Feed server event model is too small for successor canonical state: `id,type,source,namespace,actor,ts,payload` lacks turn/request/tool/projection/replay semantics. Useful remote feed precedent, not enough as kernel event envelope.
- Remote LLM proxy should not own agent loop semantics; it is upstream routing/auth only.
- Admin/provisioning complexity should not block first spike; start with local/dev token or simple auth, then graduate to cloud worker pattern.

### Revised problem-space assumption

Previous assumption: “Remote context may add latency; local-first context probably safer.”

Revised assumption: **remote context may be the right performance boundary when embeddings/vector storage are remote anyway, but the live agent control loop should remain local.** First spike should not require cloud deployment, but its contracts should make remote context deployment natural.

### New solution-space question

Should first spike explicitly model the context platform API as network/RPC even if implemented in-process, so that local kernel + remote context platform is a first-class future deployment? The memex worker evidence pushes toward “yes”: define the boundary as if remote, instantiate locally first.

---

## Architecture Decision — canonical remote context platform contract in v0

**Prompt:** “There has to be canonical use it like this way; no compromises especially in v0. Embeddings are remote anyway; network latency is nothing compared to terrible local embedding models.”

### Decision

The successor architecture has one canonical context path:

```text
local agent kernel -> context platform API -> structured /assemble response -> provider projection
```

The context platform API is not optional, not a later deployment mode, and not one of several peer paths. The local agent kernel must use the platform contract from v0. There may be development deployments where the platform process runs on the same machine, and there may eventually be local embedding backends, but those are backend/deployment details behind the same platform API. The kernel must not grow a separate local context assembler path.

### Revised stance

Replace the previous “local-only / remote / hybrid modes” framing with:

- **Canonical:** local live agent kernel + context platform API.
- **Default v0 backend:** remote/platform-hosted embeddings, vector/projection stores, source policy, and `/assemble`.
- **Allowed optimization:** local hot cache and local artifact cache, strictly as caches/projections, never as a second truth or bypass around `/assemble`.
- **Future optimization:** if local embeddings become good enough, run the same context platform locally or attach a local embedding backend behind the platform contract. No kernel change.

### Why this is not a compromise

The important invariant is not where the platform process runs. The important invariant is that context flows through one source/projection/policy contract. A “local-only context shortcut” in v0 would immediately recreate parallel systems: local heuristics for speed, remote semantic memory for quality, and no clear truth when they disagree.

The user-corrected performance model:

- current local embedding quality is not good enough to justify architecture concessions;
- LLM calls are remote;
- good embeddings are remote;
- vector/search storage is often remote or cloud-adjacent;
- one extra kernel -> platform round trip is not the dominant cost;
- bad local retrieval quality is far more expensive than network latency because it degrades the agent’s world.

Therefore v0 should spend complexity budget on making the platform path fast and reliable, not on preserving a local fallback architecture.

### Performance posture

The canonical platform path must still be engineered for daily-driver latency:

- co-locate `/assemble`, embedding calls, vector search, and projection stores where practical;
- batch embeddings and retrieval requests;
- use source/policy-aware caches on the platform side;
- allow kernel-side hot caches only for replay/working-set/display and only with platform-issued IDs/ETags;
- pre-ingest tool results and source envelopes asynchronously where possible;
- prefetch likely context after tool results and before the next user turn;
- stream partial assembly trace/status if retrieval is slow;
- surface degradation reasons instead of silently falling back to weak local heuristics;
- measure p50/p95 `/assemble` latency as a first-class gate.

### Local cache rule

Local kernel caches may contain:

- current turn artifacts;
- provider request/response trace;
- recent tool result blobs for replay;
- last successful `/assemble` response for inspection;
- platform-issued working-set pins or context item handles.

They may not contain:

- independent semantic ranking policy;
- independent vector search path;
- local-only source weights;
- a second concept/recall resolver;
- transcript-parsing fallback that bypasses platform intent/query planning.

If the platform is unavailable, the kernel may continue only in explicitly degraded mode with no hidden semantic-memory substitute. Degraded mode should be visible in the UI/RPC stream and recorded in replay.

### First-spike implication

The first spike must include the real seam:

1. Kernel accepts user turn locally over RPC.
2. Kernel records canonical turn/tool/provider events locally.
3. Kernel emits typed source envelopes/artifacts to the platform boundary.
4. Kernel calls platform `/assemble` over a network-shaped interface, even if the implementation is temporarily localhost.
5. Platform performs or simulates remote embedding/vector/projection retrieval behind the platform API.
6. Platform returns structured context items, IDs, source attribution, scores, policy decisions, and degradation info.
7. Kernel projects provider request from that response and records traceable IDs.
8. Client can inspect the chain: turn event -> source envelope -> platform context item -> provider message.

A spike that directly links a local assembler library into the kernel without exercising the platform API does not prove the architecture.

### Updated hard constraints

| Constraint | Type | Reason | Question? |
|---|---|---|---|
| The kernel must use the context platform API in v0 | hard | Prevents local/remote parallel context systems and establishes the one canonical contract immediately. | No |
| Remote embeddings are the default quality baseline | hard for v0 | Current local embedding models are not good enough to justify design compromise; retrieval quality outranks a small network round trip. | Revisit only when local models produce comparable retrieval quality. |
| Local context caches are caches only | hard | A cache may improve latency but must not become semantic authority. | No |
| `/assemble` is the only semantic context assembly path | hard | Keeps source policy, scoring, trace, and degradation centralized and inspectable. | No |
| Platform deployment may move local later without kernel semantics changing | hard | Local embeddings/backend are an implementation of the platform, not a second architecture. | No |

### Frame-stress additions

- If solution-space offers “local-only mode” as a first-class v0 path, it is violating this decision.
- If kernel code can assemble semantic context without calling the platform contract, the architecture has split.
- If degraded mode silently uses transcript parsing or local recall as a substitute for platform `/assemble`, the old failure mode is back.
- If performance work reduces latency by bypassing source declarations, policy, or traceability, it is a false optimization.
- If future local embeddings require kernel changes instead of platform backend changes, the boundary was wrong.

---

## Architecture Decision — remote session/context continuity, local agent auth

**Prompt:** Remote context stores also make session resumption and sharing easy. The one thing to keep local is agent auth; oh-omp handled that well.

### Decision

Remote context/session stores are not only about retrieval quality. They are also the canonical continuity layer for:

- session resumption across machines;
- sharing sessions/context with other clients or agents;
- cross-device working memory;
- durable source/projection state;
- replay/debug traces that outlive one local process;
- stable handles for context items, artifacts, tool results, and source envelopes.

The local agent kernel should keep **agent/provider auth local**. It may obtain platform/session tokens and call remote context services, but provider credentials, OAuth refresh handling, credential selection, and local operator auth controls should remain under local kernel control unless the user explicitly opts into a proxy/managed credential path.

### Why this matters

Remote context store gives us the thing oh-omp struggles to provide locally: a durable, shareable, resumable state plane that is not tied to one terminal session, one local SQLite file, or one machine. That strengthens the case for canonical remote context/platform usage in v0.

But agent auth is different. Provider credentials are operator trust material, not context material. They decide what models/tools the live local agent can call and how costs/rate limits are managed. Keeping them local preserves:

- user control over model/provider credentials;
- lower blast radius if the remote context platform is compromised;
- compatibility with environment/keychain/OAuth flows;
- offline/dev operation for provider credentials where possible;
- separation between context sharing and model-spend authority.

### oh-omp auth pattern to preserve

oh-omp’s `AuthStorage` pattern is valuable and should be mined for the successor local kernel:

- credential storage is backed by a local `AuthCredentialStore`;
- runtime API-key overrides are not persisted;
- credentials are reloaded into an in-memory cache;
- OAuth credentials are deduplicated by identity;
- provider credential selection supports deterministic session-to-credential mapping and round-robin/load balancing;
- usage limits, backoff, and refresh are local runtime concerns;
- serialized auth can be passed to subagent workers intentionally, not leaked through session/context stores.

This is the right shape: credentials are local kernel capability, not remote context-platform state.

### Remote platform auth vs local provider auth

Separate two auth planes:

| Plane | Owner | Purpose | Examples |
|---|---|---|---|
| Platform/session auth | Remote context platform + local kernel token client | Authenticate user/workspace to context/session/source/projection APIs | session token, workspace token, source ingest token, sharing grants |
| Agent/provider auth | Local agent kernel | Authorize live model/provider/tool calls and manage operator credentials | Anthropic OAuth/API key, OpenAI key, model role credentials, local MCP credentials |

The context platform may mediate optional cloud services (embedding proxy, storage proxy, maybe LLM proxy in managed mode), but the canonical coding-agent kernel must not require remote custody of provider auth.

### Sharing and resumption model

Remote context/session continuity should support:

- kernel starts on machine A, records turn/source/artifact envelopes to platform;
- kernel on machine B resumes by fetching session/source/projection state;
- UI clients attach to the same session via platform/kernel RPC;
- shared sessions expose context/artifacts according to grants/policies, not by copying local credential stores;
- tool-result artifacts and assembly traces are addressable by stable remote IDs;
- provider credentials are re-resolved locally on the machine running the kernel.

This means a resumed session can understand what happened without inheriting authority to spend/use another machine’s provider credentials. That is the desired separation.

### Implications for first spike

The first spike should model session identity and platform persistence as remote-capable from day one:

1. Kernel has local provider auth store or stub modeled after oh-omp `AuthStorage`.
2. Kernel authenticates to the context platform with a separate dev/platform token.
3. Kernel writes source envelopes, context trace refs, and resumable session metadata to the platform.
4. Kernel can stop and restart locally, then resume by reading platform session/context state.
5. Provider auth is reloaded locally, not restored from platform session state.
6. Sharing grants affect context/session visibility but do not grant provider credentials.

### Updated constraints

| Constraint | Type | Reason | Question? |
|---|---|---|---|
| Remote context/session store is the canonical continuity layer | hard | Enables resumption, sharing, cross-device memory, and stable artifact/context handles. | No |
| Agent/provider auth remains local kernel state | hard | Prevents context sharing from becoming credential sharing and preserves operator control over spend/rate limits. | No |
| Platform auth and provider auth are separate planes | hard | Avoids confused-deputy failures and remote context compromise escalating to provider access. | No |
| Session resumption must not require copying local credential stores | hard | Resumed sessions should understand history without inheriting authority. | No |
| Optional managed proxy paths must be explicit opt-ins | hard | Memex-style LLM/storage/embedding proxies are useful, but remote provider custody must not be implicit. | Revisit only as a separate product/security decision. |

### Frame-stress additions

- If remote context sharing also shares provider credentials by default, the trust boundary is wrong.
- If session resumption requires local SQLite/session-file copying, remote continuity failed.
- If provider auth is stored in source/context envelopes, the platform boundary is leaking secrets.
- If local kernel cannot re-resolve provider auth independently after resume, auth is too entangled with context state.
- If platform tokens can be used as provider tokens, the auth planes are confused.

---

## Pragmatic First Micro-slice — read-only agent with remote context continuity

**Prompt:** “What is the first micro slice that we can do, but that is still useful end to end?”

### Recommendation

Build the smallest useful vertical slice as:

```text
local headless kernel + canonical context-platform API + one read-only tool + real provider call + remote session resume
```

Working name: **Slice 0 — Remote-context read-only coding Q&A**.

This is not a toy echo loop. It should answer real questions about a local repo, use local provider auth, call the context platform for `/assemble`, run one local read-only tool, persist source/artifact/context handles remotely, and resume the session after kernel restart without copying local session files.

### Why this slice

It crosses every architectural seam that matters while avoiding the expensive surfaces:

- proves local kernel vs context platform boundary;
- proves platform/session auth is separate from provider auth;
- proves provider request is a projection, not canonical state;
- proves context comes from `/assemble`, not transcript parsing;
- proves tool result identity and source-envelope ingest;
- proves remote continuity/resumption;
- proves UI can be a thin RPC client;
- avoids edit/apply, subagents, shell, MCP, slash commands, rich TUI, multi-tool approval, and long-term migration complexity.

If this slice is clean, the architecture has legs. If this slice is messy, broader implementation should stop.

### User-visible end-to-end behavior

From a small terminal client or CLI:

1. Start local kernel.
2. Authenticate locally to provider using existing oh-omp-style auth/env stub.
3. Connect kernel to context platform with a separate dev/platform token.
4. Ask: `What is the concept graph resolver doing in this repo?`
5. Kernel calls platform `/assemble` with structured intent and gets initial context/trace, likely empty or repo/session-scoped.
6. Model asks to read a file, or kernel/tool planner runs one allowed read-only tool.
7. Kernel executes `read_file(path)` locally.
8. Kernel emits a `tool_result` source envelope/artifact to context platform.
9. Kernel calls `/assemble` again or includes the tool result via platform-issued context handle.
10. Provider answers.
11. Kill/restart kernel.
12. Resume the same remote session from another kernel process.
13. Ask: `What did we inspect? Continue from there.`
14. Kernel rehydrates session/context handles from platform, re-resolves provider auth locally, and answers without copying local session state.

That is useful: it is already a resumable, inspectable, read-only coding assistant shell over the new architecture.

### Explicit non-goals for Slice 0

- No file edits.
- No shell execution.
- No subagents.
- No TUI beyond minimal streaming CLI.
- No slash command system.
- No concept graph migration.
- No broad oh-omp feature parity.
- No local semantic assembler fallback.
- No multi-provider abstraction beyond one working provider projection.
- No production auth/provisioning UI; dev tokens are acceptable.

### Required contracts

#### Kernel RPC/client contract

Minimal methods/events:

```text
submit_turn(session_id?, text) -> stream KernelEvent
resume_session(session_id) -> SessionSnapshot
inspect_turn(turn_id) -> TurnTrace
cancel(request_id)
```

Minimal stream events:

```text
turn_started
platform_assemble_started
platform_assemble_completed
provider_request_built
provider_delta
tool_call_requested
tool_call_started
tool_call_completed
source_envelope_ingested
turn_completed
turn_failed
```

Every event must carry:

```text
session_id, turn_id, request_id, event_id, seq, timestamp
```

Tool events additionally carry `tool_call_id`. Context events carry platform `assemble_id` / context item IDs / source envelope IDs.

#### Context platform API

Minimum endpoints or equivalent interface:

```text
POST /sessions                      -> session_id
POST /sources/ingest                -> source_envelope_id / artifact_id
POST /assemble                      -> assemble_id, context_items[], trace, degradation[]
GET  /sessions/{id}/snapshot        -> resumable session/context handles
GET  /traces/{assemble_id}          -> assembly trace
```

The platform can be localhost/dev-hosted in Slice 0, but the call must be network-shaped. No direct in-process assembler library call from kernel as the canonical route.

#### Local provider auth

Use a minimal local credential resolver modeled after oh-omp `AuthStorage`:

- read provider auth from local config/env/dev store;
- do not put provider credentials into platform envelopes;
- on resume, re-resolve locally;
- platform token cannot call provider.

### Data model minimum

Slice 0 only needs these source/envelope kinds:

| Kind | Owner | Purpose |
|---|---|---|
| `user_turn` | kernel -> platform | remote continuity and sharing of user intent/history |
| `assistant_turn` | kernel -> platform | remote continuity and replay |
| `tool_call` | kernel -> platform | stable local tool lifecycle identity |
| `tool_result` | kernel -> platform | artifact/context source for future `/assemble` |
| `provider_request_trace` | kernel -> platform or local trace with remote handle | prompt/provider projection inspectability |
| `assembly_trace_ref` | platform -> kernel | context provenance |

No generalized event ontology yet. Do not solve all future event kinds. But each kind must use canonical IDs, idempotency, timestamps, source/projection separation, and redaction/visibility fields from day one.

### Tool minimum

Implement exactly one local tool:

```text
read_file(path) -> content artifact + preview + source envelope
```

Why `read_file`:

- useful for coding Q&A;
- deterministic;
- no mutation risk;
- produces artifact text worth indexing/assembling;
- exercises local filesystem authority that remote context platform must not own.

Do not implement `bash` first. Bash adds lifecycle, sandbox, approval, streaming, and security concerns before the context seam is proven.

### Platform storage minimum

Do not overbuild the remote store. Accept either:

- a thin adaptation of `context-assembler-ref` concepts; or
- a fresh minimal platform service with SQLite/Postgres + embedding/vector backend; or
- a hosted dev service backed by existing memex/context infra.

But it must support:

- remote session ID;
- source envelope persistence;
- artifact/result persistence;
- `/assemble` returning structured items and trace;
- restart/resume from session ID;
- platform auth separate from provider auth.

LanceDB/vector store may be used as projection storage, but canonical session/source envelopes should not be hidden inside provider-shaped messages.

### What can be fake vs must be real

| Component | Slice 0 standard |
|---|---|
| Provider call | real, one provider only |
| Provider auth | real local auth/env/dev store |
| Kernel RPC stream | real enough for CLI client |
| Context platform API | real network-shaped boundary |
| `/assemble` | real response with trace; retrieval quality may be simple initially but must not bypass platform |
| Embeddings | real remote if available; if unavailable, platform may return deterministic lexical results but must label degraded mode |
| Tool execution | real `read_file` only |
| Session resume | real: stop process and resume by remote session ID |
| Sharing | may be simulated by second local client/kernel using same platform session |
| Rich UI | fake/minimal |
| Edit/apply | absent |

### Acceptance criteria

Slice 0 is done only if:

1. A user can run one read-only coding Q&A turn through the local kernel.
2. The provider request is inspectable and references platform context item IDs / tool artifact IDs.
3. The kernel never constructs semantic context by parsing transcript text.
4. `/assemble` is called over the platform contract on every turn.
5. `read_file` result is ingested as a source envelope/artifact with stable ID.
6. Killing and restarting the kernel can resume the same session from platform state.
7. Provider credentials remain local and are not present in platform stored envelopes/traces.
8. A second client/kernel can inspect or resume the session without copying local files, but cannot use the first machine's provider credentials.
9. Degraded retrieval is explicit in stream/trace if embeddings or vector search are unavailable.
10. The implementation has one path. No local semantic fallback, no parallel context assembler.

### Why this is the right micro-slice

Smaller slices are possible but less useful:

- A pure `/assemble` demo does not prove agent/kernel/provider/tool lifecycle.
- A pure chat loop does not prove context platform or remote continuity.
- A provider-stream demo does not prove source envelopes or resumption.
- A remote session store demo does not prove context assembly.

This slice is the smallest one that exercises the whole shape while staying safe and read-only.

### Stop/pivot triggers

- If the kernel needs transcript parsing to make `/assemble` useful, stop: intent/source contract is wrong.
- If platform persistence is too slow for a single read-only turn, stop and instrument latency before adding features.
- If resumption requires local files other than provider auth/config, stop: remote continuity failed.
- If platform stores provider credentials, stop: auth boundary violated.
- If the tool result cannot be addressed by stable remote ID after restart, stop: artifact/source model is wrong.
- If the code starts adding edit/bash/TUI/subagent support before this works, stop: scope creep.

### Next implementation-planning question

Choose whether Slice 0 should:

1. adapt `context-assembler-ref` as the initial platform service;
2. build a tiny fresh platform service using its envelope/projection ideas; or
3. use memex storage/embedding pieces for the platform backend while defining a new API.

This is the first real `/solution-space` fork. The micro-slice itself should stay fixed.

---

## Build Decomposition — contract-first usable slice, then parallel agents

**Prompt:** “No micro slice can be complete. Identify what we need and split it into subagents that can implement different bits, but end up with something usable.”

### Reframe

The first “micro-slice” is not a single implementation task. It is the smallest **usable integration target**:

```text
read-only resumable coding Q&A
  local kernel
  -> canonical context platform API
  -> one read-only local tool
  -> real provider call with local auth
  -> remote session/context continuity
  -> minimal CLI client
```

To avoid parallel systems, we must not let agents invent their own interfaces. The first move is a small **Contract Freeze** phase that defines the shared envelope/API types. After that, agents can safely implement independent lanes against those contracts.

### Required pieces

| Piece | Why required for “usable” | Can parallelize? |
|---|---|---|
| Shared contracts | Prevents agents from inventing incompatible event/context/session/provider shapes | No, first |
| Context platform service | Canonical `/sessions`, `/sources/ingest`, `/assemble`, trace/snapshot store | Yes after contracts |
| Local kernel daemon | Owns turn lifecycle, local provider auth, tool lifecycle, platform calls, provider projection | Yes after contracts |
| Provider adapter | Real model call/stream using local credentials; no platform credential leakage | Yes after kernel contract |
| Read-only tool runtime | `read_file` with artifact/source envelope and stable tool_call_id | Yes after contracts |
| CLI client | Submit/resume/inspect thin client over kernel RPC | Yes after kernel RPC contract |
| Integration harness | Proves end-to-end, restart/resume, no-secret leakage, no local context fallback | Yes, but depends on contracts and stubs |
| Contract fixtures | Golden source envelope, `/assemble` response, kernel event stream, provider trace | Yes after contracts |

### Phase 0 — Contract Freeze (single owner, short, blocking)

Do this before dispatching implementation agents. Output should be committed docs/types, not prose only.

Required contracts:

1. **ID model**
   - `session_id`
   - `turn_id`
   - `request_id`
   - `event_id`
   - `seq`
   - `tool_call_id`
   - `source_envelope_id`
   - `artifact_id`
   - `assemble_id`
   - `context_item_id`

2. **Kernel stream event envelope**

```ts
type KernelEvent = {
  session_id: string;
  turn_id: string;
  request_id: string;
  event_id: string;
  seq: number;
  ts: string;
  kind: KernelEventKind;
  parent_event_id?: string;
  tool_call_id?: string;
  assemble_id?: string;
  artifact_id?: string;
  payload: unknown;
};
```

Minimum event kinds:

```text
turn_started
platform_assemble_started
platform_assemble_completed
provider_request_built
provider_delta
tool_call_requested
tool_call_started
tool_call_completed
source_envelope_ingested
turn_completed
turn_failed
```

3. **Context platform API**

```text
POST /sessions
GET  /sessions/{session_id}/snapshot
POST /sources/ingest
POST /assemble
GET  /traces/{assemble_id}
```

4. **Source envelope v0**

Must support:

```text
user_turn
assistant_turn
tool_call
tool_result
provider_request_trace
assembly_trace_ref
```

Required fields: stable ID, idempotency key, source kind, session/turn linkage, visibility, redaction class, payload locator or inline payload, created_at.

5. **Assembly response v0**

```ts
type AssemblyResponse = {
  assemble_id: string;
  context_items: ContextItem[];
  trace: AssemblyTrace;
  degradation: DegradationNotice[];
  policy: PolicySnapshot;
};
```

Context items must carry source IDs and recovery/inspection handles. Provider text is a projection, not the canonical assembly result.

6. **Kernel RPC v0**

```text
submit_turn(session_id?: string, text: string) -> stream KernelEvent
resume_session(session_id: string) -> SessionSnapshot
inspect_turn(turn_id: string) -> TurnTrace
cancel(request_id: string) -> CancelResult
```

7. **Auth boundary**

- platform token authenticates only platform/session/context APIs;
- provider auth resolved only by local kernel;
- platform envelopes/traces must not contain provider credentials;
- resumed sessions re-resolve provider auth locally.

### Agent lanes after Contract Freeze

#### Lane A — Contracts / fixtures owner

**Files/areas:** new successor contract package/docs; golden fixtures.

**Responsibilities:**
- Define shared TS/Rust/JSON schema or OpenAPI-ish contracts for kernel events, platform API, source envelopes, assembly response, session snapshot.
- Provide golden fixtures for: one user turn, one tool call/result, one `/assemble` response, one kernel event stream.
- Provide validation helpers used by other lanes.

**Acceptance:** Other lanes can compile/run against the fixtures without importing each other’s internals.

#### Lane B — Context platform v0

**Responsibilities:**
- Implement network-shaped platform service.
- `POST /sessions` creates remote session.
- `POST /sources/ingest` stores source envelopes/artifacts.
- `POST /assemble` returns structured context items + trace.
- `GET /sessions/{id}/snapshot` returns resumable handles.
- `GET /traces/{id}` returns assembly trace.
- Use dev token auth.
- Start with simple retrieval if needed, but all retrieval must flow through `/assemble` and report degraded mode if embeddings/vector search are not real yet.

**Acceptance:** Can run standalone and pass contract fixtures. Kernel can restart and recover session snapshot from platform.

#### Lane C — Local kernel v0

**Responsibilities:**
- Implement local kernel daemon exposing RPC/stream API.
- Manage session/turn/request IDs.
- Resolve provider auth locally via env/dev store modeled after oh-omp `AuthStorage`.
- Call platform `/assemble` every turn.
- Orchestrate provider call and read-only tool execution.
- Emit ordered `KernelEvent` stream.
- Persist local replay trace for current process but rely on platform for remote continuity.

**Acceptance:** With fake provider and fake platform, can submit/resume/inspect turn and emit valid event stream.

#### Lane D — Provider adapter v0

**Responsibilities:**
- Implement one real provider call/stream path.
- Prefer evaluating `memex/attractor` as provider projection if dependency cost is acceptable; otherwise implement minimal adapter with same projection boundary.
- Provider credentials come only from local kernel auth resolver.
- Return deltas/tool-call requests in kernel-compatible shape.

**Acceptance:** Can answer a simple prompt through the kernel without platform seeing provider credentials.

#### Lane E — Read-only tool runtime

**Responsibilities:**
- Implement exactly `read_file(path)`.
- Enforce path validation/root policy.
- Emit `tool_call` and `tool_result` envelopes.
- Produce artifact preview + full artifact locator.
- Do not implement `bash`, edit, or shell.

**Acceptance:** Provider/tool planner can request read_file; result is ingested into platform and addressable after kernel restart.

#### Lane F — CLI client

**Responsibilities:**
- Minimal CLI to connect to kernel RPC.
- Commands: `new`, `send`, `resume`, `inspect`, `cancel` if cheap.
- Render event stream plainly.
- Show `assemble_id`, context item IDs, tool_call_id, artifact_id where relevant.

**Acceptance:** A human can run the read-only Q&A flow without custom curl commands.

#### Lane G — Integration/e2e verification

**Responsibilities:**
- Compose platform + kernel + CLI + fake provider for deterministic test.
- Compose platform + kernel + real provider for manual smoke.
- Test restart/resume.
- Test no provider secrets in platform stored envelopes/traces.
- Test kernel cannot answer semantically without platform `/assemble` call unless explicit degraded/no-context mode is surfaced.

**Acceptance:** One command or documented script proves end-to-end flow and prints trace IDs.

### Dependency graph

```text
Phase 0: Contracts / fixtures
  ├─ Lane B: Context platform
  ├─ Lane C: Kernel
  ├─ Lane D: Provider adapter
  ├─ Lane E: Read-only tool
  ├─ Lane F: CLI
  └─ Lane G: Integration harness
        depends on B + C + F, can start with stubs immediately after contracts
```

Detailed sequencing:

1. Contract Freeze.
2. Build stubs for platform and provider so kernel/CLI can progress.
3. Build platform and kernel in parallel against fixtures.
4. Build read_file and provider adapter in parallel.
5. CLI can start once kernel RPC fixture exists.
6. Integration lane starts with stubs, then swaps in real platform/provider/tool.
7. Final hardening focuses only on the end-to-end read-only Q&A flow.

### What not to split across agents

Do not split these until after Slice 0 works:

- event ontology design;
- context platform vs kernel ownership;
- auth boundary;
- provider abstraction expansion;
- tool system generalization;
- UI framework;
- edit/bash/subagent support;
- storage backend migration.

Those are architecture decisions, not parallel implementation chores.

### Usable target definition

The lanes are done only when this works from a user’s perspective:

```text
$ successor-kernel start
$ successor-cli new
$ successor-cli send "What is the concept graph resolver doing in this repo? Read the relevant file."
  ... streamed events ...
  platform_assemble_completed assemble_id=...
  tool_call_started tool_call_id=... read_file packages/.../resolver.ts
  tool_call_completed artifact_id=...
  source_envelope_ingested source_envelope_id=...
  provider_delta ... answer ...
  turn_completed

# kill/restart kernel

$ successor-cli resume <session_id>
$ successor-cli send "What did we inspect? Continue from there."
  ... resumes from remote session/context handles, provider auth local ...
```

No local session-file copy. No platform provider secrets. No hidden transcript parsing.

### Practical subagent dispatch rule

Use subagents only after Phase 0 contracts are concrete. Each implementation agent gets:

- exact files/package lane;
- contract fixture paths;
- non-goals;
- acceptance command or manual smoke;
- statement that they must not broaden scope.

Parallelism is safe only because each lane depends on the same fixed contract, not on each agent’s interpretation of the architecture.

### Immediate next action

Do not implement all lanes yet. First create the Phase 0 contract artifact:

```text
.oh/workstreams/successor-agent-kernel/SLICE-0-CONTRACT.md
```

It should freeze the JSON/event/API shapes enough to dispatch agents. After that, assign lanes B–G in parallel.

---

## Correction — Slice 0 implementation stack is Rust, not TypeScript

**Prompt:** User rejected the TypeScript/Bun stack for Slice 0: “I hate TypeScript ecosystem with a passion; it gives us nothing for the slice 0.”

### Decision

Slice 0 implementation is **Rust-first**. The earlier TypeScript-shaped contract/decomposition snippets in this frame are superseded by:

```text
.oh/workstreams/successor-agent-kernel/SLICE-0-CONTRACT.md
```

The canonical Slice 0 package/crate plan is now:

```text
crates/successor-protocol/          # shared serde/schemars types, JSON fixtures, contract tests
crates/successor-context-platform/  # HTTP JSON context/session platform service
crates/successor-kernel/            # local headless agent kernel daemon
crates/successor-cli/               # minimal CLI client
```

Wire boundary remains language-neutral JSON over HTTP/SSE. The contract fixtures under `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/` are the implementation-neutral source of truth.

### Rationale

Rust fits Slice 0 better because the hard problems are contracts, streaming, storage, replay, correctness, and service boundaries. The local advanced precedents we are mining — `context-assembler-ref`, memex Rust crates, and `attractor` — are Rust-shaped. Provider SDK convenience is not sufficient reason to carry TypeScript ecosystem complexity into the new kernel.

Cloud/edge workers may still be TypeScript later if the remote platform deploys to Cloudflare-style infrastructure, but that is an edge deployment detail, not the Slice 0 kernel/platform stack.

### Updated implementation constraint

Implementation agents must treat `SLICE-0-CONTRACT.md` as authoritative. If this `FRAME.md` contains older TypeScript-looking examples in prior sections, those examples are historical planning residue and not contract law.

---

## Slice 0 Scope Clarification — seam first, no embeddings/full assembler yet

**Prompt:** “So we are not yet doing embeddings, or the whole context assembly machinery?”

### Decision

Correct: Slice 0 does **not** implement embeddings, vector search, MMR, source weighting, background indexing, retrieval telemetry, or the whole context assembly machinery.

Slice 0 implements the **canonical seam** only:

```text
kernel -> context platform /assemble -> structured context response + trace -> provider projection
```

The platform must exist and the kernel must call it every turn. But `/assemble` may initially be simple and deterministic: stored source envelopes/artifacts, lexical matching, recency ordering, or explicit `no_context` before enough sources exist.

If embeddings/vector search are absent, that absence must be visible as degradation in the assembly response and kernel event stream. There must be no silent local fallback in the kernel.

### Why this is still valuable

This still proves the hard architecture invariants:

- context is platform-owned;
- kernel does not parse transcript text for semantic context;
- source envelopes/artifacts become remote resumable state;
- provider request is a projection over platform context items;
- restart/resume works through platform session state;
- degradation is explicit rather than hidden.

Retrieval quality comes later. The first usable slice tests ownership, identity, traceability, auth separation, and continuity.

### Deferred to Slice 1+

- remote embedding service integration;
- vector index/read model;
- MMR/diversity ranking;
- source weights and policy tuning;
- retrieval telemetry and audits;
- background projection workers;
- budget-aware multi-section assembly;
- source declarations beyond the Slice 0 source kinds.

### Frame-stress signal

If agents start implementing embeddings or a rich assembler before the Slice 0 seam works end-to-end, scope has drifted. If agents bypass `/assemble` because the simple assembler is low quality, the architecture has failed its first invariant.

---

## Architecture Decision — stable IDs for everything replayable

**Prompt:** oh-omp is missing stable IDs for everything happening — tool calls, messages, errors, etc.; does the eventing system address this?

### Decision

Yes. Slice 0’s eventing system must be an **identity spine**, not just an event stream. Every durable, replayable, inspectable, shareable, or user-visible thing gets a stable ID at creation time.

This is an explicit correction of the oh-omp failure mode where some identifiers exist transiently (`event.toolCallId`, provider block IDs, in-memory dedup keys) but are not consistently persisted across recall, expansion, replay, UI, or session resumption.

### Required stable IDs

| Thing | ID | Owner | Purpose |
|---|---|---|---|
| session | `session_id` | platform | remote continuity/sharing |
| turn | `turn_id` | kernel | user/assistant turn lifecycle |
| request | `request_id` | kernel | cancel/retry/stream lifecycle |
| event | `event_id` + `seq` | kernel/platform by emitter | ordered replay and audit |
| transcript/message projection | `message_id` | kernel | stable UI/transcript/replay reference |
| tool lifecycle | `tool_call_id` | kernel | request/start/result/error correlation |
| source content | `source_envelope_id` | platform | canonical persisted content handle |
| large artifact | `artifact_id` | platform | recoverable content handle |
| context assembly | `assemble_id` | platform | one assembly operation |
| context item | `context_item_id` | platform | included/rejected context reference |
| trace | `trace_id` | kernel/platform | inspectable reasoning/projection trace |
| provider stream item | `provider_event_id` | kernel | replayable provider delta/event reference |
| error | `error_id` | kernel/platform where produced | error correlation, retries, support/debug |

### Rules

- IDs are assigned before side effects whenever possible.
- A failed operation is still addressable by ID.
- Tool events share the same `tool_call_id` across requested/started/completed/failed/result envelope.
- User-visible messages get `message_id` even though provider messages are only projections.
- Provider messages are not canonical state; if displayed/traced/persisted, their projections still carry stable `message_id`/`trace_id` links.
- Errors get `error_id`; error text alone is not identity.
- Source envelope IDs and artifact IDs are the continuity handles after restart/resume.
- IDs must not encode secrets or provider credentials.

### Contract update

`SLICE-0-CONTRACT.md` now adds:

- `message_id` prefix `msg_`;
- `error_id` prefix `err_`;
- `provider_event_id` prefix `pevt_`;
- stable identity invariant section;
- event identity requirements by kind;
- `error` as a source envelope kind;
- fixture event stream updated with explicit message/error/provider-event fields.

### Frame-stress signal

If an implementation can only answer “which tool result/error/message?” by scanning text, sequence position, provider block content, or turn number alone, the identity spine is insufficient. Slice 0 should make correlation boring: IDs connect every event, tool, message, artifact, error, context item, and provider projection.

---

## Architecture Decision — everything meaningful is a persisted raw event

**Prompt:** “I think we can generalize that elegantly: everything is an event, events have IDs, raw events are persisted.”

### Decision

Yes. The Slice 0 identity model is now event-sourced:

```text
RawEvent log is truth. Projections are rebuildable views.
```

Everything that matters is recorded as a raw event. Every raw event has a stable `event_id`. Raw events are persisted append-only by the context platform. Messages, tool calls, tool results, provider deltas, errors, source envelopes, artifacts, assemblies, context items, and traces are either raw events or handles/projections derived from raw events.

### Why this is cleaner

The previous phrasing risked creating many peer truth models: message table, tool-call table, source-envelope table, error table, assembly table. That repeats oh-omp’s failure mode in a cleaner outfit. The corrected model is:

- raw events are occurrence facts;
- entity IDs identify the durable things the event is about;
- source envelopes/artifacts/context items/traces are handles/projections;
- projections may be indexed, queried, compacted, shared, or rebuilt;
- raw event history remains the audit/replay substrate.

### Raw event shape

Slice 0 contract now defines `platform.raw_event.v0` with:

- `event_id`;
- `idempotency_key`;
- `event_type`;
- `session_id`, `turn_id`, `request_id`;
- `seq`, `occurred_at`;
- `producer`;
- `causation_event_id`;
- `correlation_id`;
- `entity_ids` for message/tool/source/artifact/assemble/context/trace/error/provider-event handles;
- visibility and redaction;
- payload;
- optional artifact.

Canonical endpoint:

```text
POST /events
```

`POST /sources/ingest` is no longer canonical in Slice 0. A source envelope is content/projection data associated with a raw event, not a separate source of truth.

### Event type examples

```text
user_turn.recorded
assistant_turn.recorded
tool_call.requested
tool_call.started
tool_call.completed
tool_call.failed
tool_result.recorded
provider_request.built
provider_delta.recorded
assembly.requested
assembly.completed
error.recorded
```

### Implementation rule

When something happens: append the raw event first or as close to first as possible, then update projections. If an operation fails, append an error event with `error_id`; do not represent failure only by missing success.

### Fixture update

Slice 0 fixtures now include:

```text
raw-event-user-turn.json
raw-event-tool-result.json
```

The kernel event stream fixture now uses `raw_event_appended` instead of `source_envelope_ingested`. Source envelope fixtures remain only as convenience/projection fixtures, not canonical event-log truth.

### Frame-stress signal

If an implementation has to ask “which table is canonical for this thing?” the design drifted. The answer should be boring: the raw event log is canonical; every other store is a projection, index, cache, or handle table.

---

## Review Amendment — core tool catalog stubs and deterministic replay provenance

**Prompt:** Port the core oh-omp tool set, even as little more than stubs; strengthen causality so provenance means deterministic replay of the event stream into exact session state.

### Decision

Two amendments are now hard requirements for Slice 0 contract revision.

### 1. Port the core oh-omp tool catalog as protocol-visible definitions

Slice 0 should not execute the whole oh-omp tool system, but it should model the core tool surface from day one. The successor should publish/understand a tool catalog derived from oh-omp `BUILTIN_TOOLS` / `HIDDEN_TOOLS` so provider/tool protocol, stable IDs, rejection behavior, and replay provenance are tested against the real shape we eventually need.

Executable in Slice 0: hardened read/discovery subset only, such as `read`, `find`, `grep`, and preferably successor `search_files`.

Stubbed/rejected in Slice 0: mutation, shell/runtime, subagent, browser, notebook, external/web/GitHub, and workflow/control tools unless explicitly promoted for a smoke path.

Unsupported/stubbed tools must not be silent no-ops. If the model asks for an unavailable tool, the kernel records:

```text
tool_call.requested
tool_call.rejected
error.recorded
```

with stable `tool_call_id`, `error_id`, original arguments, policy reason, and causation/correlation links. This proves protocol compatibility and provenance without taking on dangerous execution scope.

### 2. Deterministic replay is the provenance bar

Causality is necessary but not strong enough. The target invariant is:

```text
raw events + artifacts + projection code version -> byte-identical session projection
```

A replay from an empty projection store must reconstruct the same session state deterministically under the same protocol/projection versions:

- session snapshot;
- transcript/message projection;
- tool lifecycle projection;
- error projection;
- source envelope and artifact index;
- assembly trace/context item projection;
- provider request/response trace projection;
- CLI-inspectable turn trace.

Replay must not re-run tools, providers, filesystem reads, network calls, embeddings, clocks, or random ID generation. Those are side effects/observations and must already be recorded in raw events/artifacts. If replay needs the current filesystem/provider/network to rebuild state, provenance failed.

Projection code must be deterministic and versioned. If semantics change, introduce explicit projection/schema versioning or migration events. Do not silently reinterpret old raw events.

### Review artifact update

`SLICE-0-CONTRACT.md` and `SLICE-0-REVIEW.md` now include these requirements. The pending amendment task must carry them into the final contract/fixtures before implementation agents run.

### Frame-stress signal

If the implementation can replay only “roughly equivalent” state, that is not enough. If unsupported tools disappear instead of producing replayable `tool_call.rejected` / `error.recorded` facts, the tool protocol has a provenance hole.

---

## Execute — t_jd8l Slice 0 contract amendment after design review

### Execution Complete

**Task:** `t_jd8l — Amend Slice 0 contract after design review`

**Aim achieved:** Produced a dispatch-ready amended Slice 0 contract and fixture set that resolves the review blockers: raw event vs stream frame identity, platform event ordering/read APIs, deterministic replay provenance, core oh-omp tool catalog stubs, useful read/discovery path, hardened read authority, error envelope, safe sharing defaults, and causal replay fixtures.

### Declared Success Criteria

- Separate persisted raw event identity/order from live stream-frame identity/order.
- Add platform-owned `session_seq` and event/artifact read APIs.
- Freeze the successful provider/tool/assemble state machine, including post-tool `/assemble`.
- Port core oh-omp tool catalog as protocol-visible definitions/stubs while executing only safe read/discovery tools.
- Ensure unsupported tools emit deterministic `tool_call.requested` -> `tool_call.rejected` -> `error.recorded` raw events.
- Decide useful Slice 0 read path (`search_files` + `read`) rather than path-explicit-only smoke.
- Harden `read` so workspace root is kernel/session-owned and model supplies only relative path.
- Add shared `ErrorEnvelopeV0` and HTTP status mapping.
- Set file artifact defaults to sensitive/non-shareable.
- Rewrite fixtures so they prove causality and deterministic replay shape, not just JSON parsing.

### Delivered Characteristics

- Rust-first Slice 0 contract: met.
- Raw event log as truth; projections rebuildable: met.
- `KernelFrame` vs `RawEvent` separation: met.
- Platform APIs include `POST /events`, event pagination, event read, artifact read, snapshot, `/assemble`, trace read: met.
- Tool catalog includes executable read/discovery subset and stubbed oh-omp core surface: met.
- State machine includes pre-tool, post-locator, and post-read `/assemble`: met.
- Deterministic replay acceptance gate: met at contract/fixture level; implementation validator still belongs to integration lane.
- Embeddings/full assembler remain deferred: met.

### Changes

- `.oh/workstreams/successor-agent-kernel/SLICE-0-CONTRACT.md`: replaced with amended dispatch-ready contract.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/tool-catalog.json`: added tool catalog fixture.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-successful-turn.json`: added causally valid successful-turn raw event stream.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/raw-events-unsupported-tool.json`: added unsupported-tool rejection/error event stream.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/kernel-frame-stream.json`: added live stream frame fixture with `frame_id`/`stream_seq`, not raw event IDs.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-request-pre-tool.json`: added pre-tool assemble request.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-response-pre-tool.json`: added pre-tool degraded/no-context response.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-request-post-read.json`: added post-read assemble request.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/assemble-response-post-read.json`: added post-read response including read artifact context item.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/session-snapshot.json`: rewrote snapshot projection from raw events.
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/expected-session-projection.json`: added deterministic replay target projection.
- Removed obsolete pre-amendment fixtures: old kernel event stream, generic assemble request/response, single raw-event/source-envelope examples.

### Verification

- Parsed every remaining Slice 0 JSON fixture successfully.
- Verified fixture set exactly matches contract-required canonical files.
- Verified `raw-events-successful-turn.json` and `raw-events-unsupported-tool.json` have dense monotonic `session_seq`.
- Verified `causation_event_id` only points to earlier events.
- Verified post-locator/post-read assembly references only sources already produced by prior raw events.
- Verified unsupported-tool fixture includes `tool_call.requested`, `tool_call.rejected`, and `error.recorded`.
- Verified kernel frame fixture uses `frame_id`/`stream_seq` and does not contain stale `event_id`/`seq` envelope fields.
- Verified snapshot/projection `last_raw_event_seq` matches successful raw event count.
- Verified fixtures contain no provider credential-like strings (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `Authorization`, `Bearer`, `sk-*`, `refresh_token`, `oauth`).
- Verified contract contains amended terms and no stale `KernelEvent`, `kernel.event.v0`, `POST /sources/ingest`, or `source_envelope_ingested` canonical language.

### Risk Retirement

| Risk / Assumption / Stop Trigger | Status | Tempting Patch This Check Fails | Evidence / Route |
|---|---|---|---|
| RawEvent and live stream frames collapse into one ambiguous event model | Retired by evidence | Reusing `KernelEvent.event_id`/`seq` for live frames and persisted facts | Contract now defines `RawEvent.event_id/session_seq` and `KernelFrame.frame_id/stream_seq`; grep check rejects stale `KernelEvent`/`kernel.event.v0`. |
| Resume cannot rebuild from raw event log | Retired by evidence | Snapshot only returns IDs with no event/artifact read APIs | Contract adds `GET /sessions/{session_id}/events`, `GET /events/{event_id}`, `GET /artifacts/{artifact_id}`. |
| Tool result bypasses platform context after local read | Retired by evidence | Kernel passes read output straight to provider without post-tool `/assemble` | State machine requires post-locator and post-read `/assemble`; fixtures encode post-read request/response. |
| Slice is not useful because model cannot locate relevant file | Retired by evidence | Only implementing `read` and requiring path-explicit prompt | Contract includes executable `search_files` plus `read`, `find`, `grep`; smoke path uses locator+read. |
| Porting only one tool hides oh-omp tool protocol drift | Retired by evidence | Model requests `bash`/`edit` and request disappears or no-ops | Contract/fixture require core catalog definitions and unsupported-tool raw events `tool_call.requested` -> `tool_call.rejected` -> `error.recorded`. |
| Model controls filesystem root | Retired by evidence | Tool schema accepts `root` from provider | Contract says root is trusted session/kernel config; tool args accept relative path only. |
| Local file artifacts become shareable by default | Retired by evidence | Fixture/implementation sets `share: true` for read artifacts | Contract defaults file artifacts to `redaction: sensitive`, `visibility.share: false`; fixtures follow that. |
| Error text lacks stable identity | Retired by evidence | HTTP/tool errors are strings without IDs | Contract adds `ErrorEnvelopeV0`; unsupported-tool fixture includes `error_id`. |
| Fixtures parse but encode impossible causal story | Retired by evidence | Context item references future tool artifact | Validation checks dense seq, backward causation, prior source production before assembly reference. |
| Deterministic replay is asserted but not represented | Partially retired / implementation gate remains | Contract says replayable but no expected projection exists | Added `expected-session-projection.json` and fixture validation target; full replay validator remains integration-lane acceptance. |
| Provider auth leaks into platform state | Retired by evidence | Store provider token in raw events/fixtures | Credential-like scan over fixtures passed; contract forbids provider credentials in platform state. |
| Scope drifts into embeddings/full assembler | Retired by evidence | Add vector/embedding requirements to Slice 0 | Contract preserves deterministic/degraded `/assemble`, embeddings deferred. |

### Needs Human Verification

- Whether the core catalog grouping is broad enough for the first implementation lane, or whether additional oh-omp hidden tools need protocol entries before dispatch.
- Whether `search_files` + `read` is the desired Slice 0 smoke path instead of path-explicit prompt.

### Notes

Implementation lanes are now unblocked by `t_jd8l` once task status is marked done. Integration lane must implement or explicitly own a failing TODO for deterministic replay validation if full replay code is not built in its first pass.

---

## Provider Target Decision — Anthropic and OpenAI shapes, local subscription auth later

**Prompt:** Provider target should accept Anthropic and OpenAI API shapes and support subscription logins, though subscription login does not have to be in Slice 0.

### Decision

The successor provider boundary must not be Anthropic-only. Slice 0 may execute one real provider path first, but the provider projection contract must accept and normalize both major API shape families:

- **Anthropic Messages-style:** messages, content blocks, `tool_use`, `tool_result`, streaming event blocks.
- **OpenAI-compatible:** Chat Completions and/or Responses API message/item shapes, `tool_calls`, tool outputs, streaming deltas/events.

The kernel records provider observations in successor IDs and raw events. Provider-specific IDs may be metadata, but stable replay identity remains:

```text
tool_call_id, provider_event_id, message_id, trace_id, raw event_id/session_seq
```

### Slice 0 scope

Slice 0 can use one real provider for the smoke path. Default remains direct Anthropic HTTP from Rust unless OpenAI-compatible direct HTTP is faster to implement. The important Slice 0 requirement is that the provider-normalized types and traces do not encode Anthropic-only assumptions.

OpenAI-compatible support may be contract/fixture/schema-level in Slice 0 if implementing the second live provider would slow the slice.

### Auth roadmap

Provider auth remains local kernel state. Required long-term auth modes:

- local API keys/dev tokens;
- local OAuth/subscription login flows similar in spirit to oh-omp `AuthStorage`;
- deterministic local credential selection/refresh/backoff;
- no provider credentials or subscription tokens in platform raw events, artifacts, traces, or fixtures.

Subscription login support is not required for Slice 0 execution, but the auth resolver interface must not preclude it.

### Frame-stress signal

If implementation names the provider abstraction `Anthropic*`, stores Anthropic content-blocks as canonical kernel state, or cannot represent OpenAI tool-call/result semantics without changing raw event ontology, the provider boundary is too narrow. If subscription/OAuth tokens are persisted to the remote context platform, the auth boundary is broken.

---

## Provider Target Decision — Anthropic and OpenAI shapes, local subscription auth later

**Prompt:** Provider target should accept Anthropic and OpenAI API shapes, and support subscription logins eventually, though not necessarily in Slice 0.

### Decision

The successor provider projection layer should be **provider-shape bilingual**:

```text
normalized provider projection
  ├─ Anthropic Messages-shaped adapter
  └─ OpenAI-compatible Chat/Responses-shaped adapter
```

Slice 0 may execute only one real provider path, preferably direct Anthropic HTTP because Anthropic tool-use exercises the local tool seam well. But the contract must not encode Anthropic-only assumptions into canonical raw events, tool lifecycle, message IDs, or deterministic replay.

OpenAI-compatible shape support may be protocol/fixture/stub-level in Slice 0, but the normalized event model must already be able to represent:

- provider request built;
- provider tool/function call observed;
- tool result sent back to provider;
- provider response recorded;
- streamed deltas as live frames if used;
- coarse provider observations as replay facts.

### Auth decision

Provider auth remains a local kernel plane. It should eventually support:

- API keys;
- OAuth/subscription logins;
- local canonical auth/model state files;
- controlled propagation into isolated local runtime/session contexts when needed.

Subscription login implementation is **not required in Slice 0**, but the architecture must not preclude it. The existing oh-omp subscription/OAuth container propagation pattern is relevant precedent: canonical local OMP auth/model state can be copied into isolated runtime session data dirs without giving the remote context platform provider credentials.

Hard boundary: provider credentials, OAuth refresh tokens, subscription session material, and copied auth state files must never enter platform raw events, artifacts, traces, fixtures, or remote context/session state.

### Contract impact

`SLICE-0-CONTRACT.md` now states:

- provider architecture target accepts Anthropic and OpenAI-compatible shapes;
- Slice 0 executable path may still be Anthropic first;
- OpenAI-shaped mapping may be protocol-supported/stubbed initially;
- all provider shapes normalize into the same raw events (`provider_request.built`, `provider_tool_call.observed`, `provider_response.recorded`);
- subscription/OAuth support is future local-kernel auth work, not Slice 0 and not remote-platform custody.

### Frame-stress signal

If implementation stores provider auth in platform events, platform artifacts, or session snapshots, the auth boundary is broken. If OpenAI-shaped tool calls require a different canonical event model from Anthropic tool calls, provider projection has leaked into kernel truth.

---

## Auth Plane Decision — MEMEX_LICENSE for context platform, oh-omp auth for providers

**Prompt:** Context platform auth should be `MEMEX_LICENSE` shaped; only provider credentials follow the oh-omp shape.

### Decision

Yes. There are two distinct auth shapes:

| Plane | Shape | Scope | Custody |
|---|---|---|---|
| Context platform auth | `MEMEX_LICENSE`-shaped licence/entitlement token | sessions, raw events, artifacts, `/assemble`, traces, sharing/inspection | platform + kernel token client |
| Provider auth | oh-omp-style local credential auth | Anthropic/OpenAI-compatible provider calls, model spend, OAuth/subscription state, credential rotation/backoff | local kernel only |

`MEMEX_LICENSE` is not a provider credential. It must not authorize provider/model calls or imply spend authority. Provider API keys, OAuth refresh tokens, subscription session material, copied auth state files, account/model selection, and usage-limit backoff belong only to the local provider-auth resolver.

Canonical environment naming from current repo precedent is `MEMEX_LICENSE` (`packages/coding-agent/src/context/recall/embed.ts`). If a `MEMEX_LICENCE` alias is ever accepted, it is only an alias for the same platform entitlement plane, not a separate auth concept.

### Contract impact

`SLICE-0-CONTRACT.md` now states:

- context platform auth is `MEMEX_LICENSE`-shaped entitlement auth;
- provider credentials follow oh-omp-style local auth;
- context platform licence auth does not authorize provider calls;
- provider credentials/subscription tokens never enter raw events, artifacts, traces, fixtures, snapshots, or remote platform state.

### Frame-stress signal

If an implementation stores provider OAuth/subscription material in platform raw events or treats `MEMEX_LICENSE` as a provider spend credential, the auth boundary is broken. If provider auth code is reused to validate context platform access, the planes have been conflated.

---

## Auth Plane Decision — context platform uses MEMEX_LICENSE shape; providers use oh-omp auth shape

**Prompt:** Context platform auth should be MEMEX_LICENCE shaped; only provider credentials follow the oh-omp shape.

### Decision

Correct. The two auth planes have different shapes and must not be conflated.

```text
context platform auth  = MEMEX_LICENSE-shaped license/entitlement token
provider auth          = oh-omp-shaped local credential/subscription auth
```

Existing repo precedent uses `MEMEX_LICENSE` spelling (`packages/coding-agent/src/context/recall/embed.ts`). The contract now uses `MEMEX_LICENSE` as canonical; accepting `MEMEX_LICENCE` as a compatibility alias is optional implementation detail.

### Context platform auth

The context platform only needs to know whether this kernel/client is entitled to access remote context/session/event/artifact APIs. This should look like a Memex license/workspace token:

- bearer token / license string;
- validates platform access;
- scopes session/event/artifact operations;
- no model provider authority;
- no provider credential storage;
- no oh-omp AuthStorage shape.

### Provider auth

Provider credentials are a local kernel concern and follow the oh-omp local-auth pattern:

- API keys;
- OAuth/subscription login material;
- refresh/backoff/provider selection;
- local canonical auth/model state;
- optional controlled local propagation into isolated runtime/session contexts.

Provider credentials must never enter platform raw events, artifacts, traces, fixtures, projections, or session snapshots.

### Frame-stress signal

If implementation stores provider credentials under `MEMEX_LICENSE` or treats a platform license token as authority to call Anthropic/OpenAI, the boundary is broken. If context platform auth imports oh-omp provider AuthStorage semantics, the platform auth layer is overfit and wrong.

---

## Auth Plane Decision — context platform uses MEMEX_LICENSE shape, provider creds use oh-omp shape

**Prompt:** “Auth for the context platform should be MEMEX_LICENCE shaped; only the provider credentials follow the oh-omp shape.”

### Decision

Yes. There are two deliberately different auth systems:

| Plane | Shape | Owner | Purpose |
|---|---|---|---|
| Context platform auth | `MEMEX_LICENSE`-shaped license/entitlement token (`MEMEX_LICENCE` may be an alias if desired) | context platform + local kernel client | authorize session/event/artifact/context APIs |
| Provider auth | oh-omp-shaped local provider auth | local kernel only | authorize Anthropic/OpenAI-compatible provider calls and subscription/API-key state |

The context platform token is product/workspace/session entitlement. It is not a provider API key, not OAuth subscription state, and not model spend authority.

The provider credential plane follows the oh-omp local-auth posture: local API keys, subscription/OAuth state, model selection, refresh/backoff, and controlled propagation into local isolated runtime contexts. It never goes to the remote context platform.

### Contract impact

`SLICE-0-CONTRACT.md` now states:

- platform API requests use `Authorization: Bearer <MEMEX_LICENSE-shaped platform entitlement token>`;
- platform/license tokens cannot authorize provider calls;
- provider auth resolver is local-only and is the only plane with oh-omp-shaped provider credentials/subscription login;
- provider credentials, OAuth refresh tokens, subscription material, and copied auth state files never enter platform raw events, artifacts, traces, fixtures, projections, or license records.

### Frame-stress signal

If an implementation uses oh-omp provider `AuthStorage` to authenticate to the context platform, it has conflated planes. If an implementation stores `MEMEX_LICENSE` as provider auth or sends provider subscription/OAuth material to context platform APIs, the boundary is broken.

---

## Auth Plane Clarification — MEMEX licence for platform, oh-omp auth for providers

**Prompt:** Context platform auth should be `MEMEX_LICENCE` shaped; only provider credentials follow the oh-omp shape.

### Decision

There are two separate auth shapes:

| Plane | Shape | Owner | Grants | Must not grant |
|---|---|---|---|---|
| Context platform auth | MEMEX licence/entitlement shaped (`MEMEX_LICENSE` preferred env spelling; `MEMEX_LICENCE` acceptable alias if desired) | context platform + local kernel client | access to session/context/event/artifact APIs, workspace entitlement, sharing/quota | provider spend authority |
| Provider auth | oh-omp local-auth shaped | local kernel only | provider API keys, OAuth/subscription tokens, account/model selection, refresh/backoff, controlled local propagation | remote context/session access by itself |

The context platform token is not provider auth and should not reuse oh-omp provider credential storage semantics. It is closer to a product licence/workspace entitlement. Provider credentials remain local kernel state and may use oh-omp-style auth storage/subscription login machinery.

### Slice 0 impact

- Platform API requests use `Authorization: Bearer <memex_license_token>`, sourced from `MEMEX_LICENSE` / optional `MEMEX_LICENCE` alias in dev.
- Provider API keys are local dev/provider auth, not platform auth.
- Subscription/OAuth provider login is future local-kernel auth work, not Slice 0 and not context-platform custody.
- Raw events, artifacts, traces, fixtures, session snapshots, and platform projections must contain neither provider credentials nor subscription tokens.

### Frame-stress signal

If a MEMEX licence token can call Anthropic/OpenAI directly, the auth planes are collapsed. If provider OAuth/subscription state is stored in platform raw events or remote session state, the provider auth boundary is broken.