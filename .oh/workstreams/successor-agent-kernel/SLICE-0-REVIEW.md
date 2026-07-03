# Slice 0 Design Review — Successor Agent Kernel

**Status:** Historical review; original blockers superseded by `t_jd8l` amendment plus provider/auth/fixture strengthening pass
**Date:** 2026-06-23
**Reviewed artifacts:**

- `.oh/workstreams/successor-agent-kernel/SLICE-0-CONTRACT.md`
- `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/*.json`
- Recent tail of `.oh/workstreams/successor-agent-kernel/FRAME.md`
- Independent reviews: `agent://0-SkepticalSlice0Review`, `agent://0-ArchitectureSlice0Review`

## Verdict

**ORIGINAL VERDICT:** REVISE before implementation dispatch. **CURRENT STATUS:** amended contract is dispatchable after the post-review strengthening pass; use `SLICE-0-CONTRACT.md` as authority.

The architecture direction is right. Do not throw it away.

What is solid:

- Rust-first implementation.
- JSON/HTTP/SSE wire boundary.
- Local kernel owns live control loop and provider auth.
- Remote context/session platform owns continuity and `/assemble`.
- No embeddings/full assembler in Slice 0.
- Raw persisted event log as canonical truth.
- Stable IDs for every durable/replayable/user-visible thing.
- Provider messages as projections, not canonical state.
- Read-only local authority first.

But the current contract is not yet safe to hand to parallel implementation agents. It leaves too much room for incompatible implementations exactly around the seams Slice 0 is meant to prove: event ordering, raw-event projection boundaries, provider/tool loop, resume APIs, read-file authority, and useful file discovery.

## Highest-level correction

Keep the elegant principle:

```text
RawEvent log is truth. Projections are rebuildable views.
```

But sharpen the model:

```text
Persisted raw events are domain facts.
Stream frames are delivery/progress projections over those facts.
Indexes, source envelopes, artifacts, traces, messages, and context items are handles or projections.
```

Do not let `KernelEvent` and `RawEvent` become two peer event truths using the same identifiers and sequence semantics.

## What we definitely want

### 1. Canonical remote event/session store

Remote context/session state is the continuity layer. This is essential for:

- resume across machines;
- sharing without copying local files;
- durable inspection;
- rebuilding projections;
- future context retrieval;
- future model/task telemetry.

### 2. Local provider auth

Provider credentials stay local to the kernel. Sharing session state must not share spend authority.

### 3. Platform `/assemble` from v0

Even if degraded/lexical, `/assemble` must exist and be called. No local semantic fallback.

### 4. Stable identity spine

Every durable thing gets an ID:

- session;
- turn;
- request;
- raw event;
- message projection;
- tool call;
- artifact;
- source envelope;
- assembly;
- context item;
- trace;
- error;
- provider event if retained.

### 5. Rust stack

Rust is the right Slice 0 implementation substrate. TypeScript should not be the kernel/platform implementation language.

## False assumptions found

### False assumption 1: one `/assemble` call per turn is enough

It is not enough for a tool-using turn.

A useful read-only Q&A turn needs at least:

```text
user_turn.raw_event
pre-tool /assemble
provider request
provider tool request
local tool execution
tool_result.raw_event
post-tool /assemble
provider continuation/final answer
assistant_turn.raw_event
turn complete
```

If the kernel passes tool-result content directly to the provider without the post-tool `/assemble`, the context platform seam is bypassed.

### False assumption 2: ID-only session snapshots prove resume

A snapshot containing only IDs is not enough unless there is a defined way to fetch/replay those IDs.

The platform needs at least one of:

- `GET /sessions/{session_id}/events?after_seq=...`
- `GET /events/{event_id}`
- `GET /artifacts/{artifact_id}`
- `GET /sources/{source_envelope_id}`

or an explicit guarantee that `/assemble` plus snapshot handles is the only supported reconstruction mechanism. The first option is cleaner and matches the event-sourced claim.

### False assumption 3: fixture JSON parsing means contract freeze

The fixtures parse, but the current fixture timeline is causally wrong: the assembly response includes a tool-result context item before the tool result has happened.

For an event-sourced system, fixture causality matters more than JSON syntax.

### False assumption 4: `read_file` alone makes “read the relevant file” useful

With only `read_file`, the model needs to already know the path.

Current target prompt:

```text
What is the concept graph resolver doing in this repo? Read the relevant file.
```

is not deterministic without one of:

1. path-explicit prompt;
2. pre-seeded platform path/source manifest;
3. a second read-only locator tool such as `search_files`.

If we want the slice to be genuinely useful, add `search_files`. If we want to preserve one-tool minimalism, change the smoke target to a path-explicit prompt.

### False assumption 5: provider/tool streaming can be hand-waved

Anthropic tool use is a protocol loop. If Slice 0 uses Anthropic, the contract must say how tool requests, tool results, and final provider continuation are represented.

Non-streaming provider responses can be converted into synthetic stream frames, but tool-use support is still required if the slice is to prove local tool execution.

### False assumption 6: model-provided `root` is safe

`read_file` arguments currently include `root`. That is unsafe.

Workspace root must be trusted session/kernel configuration. The provider/model may request only a relative path under that root.

### False assumption 7: every live delta should be a platform raw event

“Everything meaningful is an event” is right, but token-level provider deltas and progress frames can explode the event log without adding Slice 0 value.

Amendment: durable domain facts are raw events. Live transport frames are stream projections unless explicitly retained. If provider deltas are retained, persist coarse chunks or a completed provider-response event, not necessarily every token.

### False assumption 8: causal validity is enough for provenance

Causal fixture validity is necessary, but too weak. The target is deterministic replay: given the persisted raw event stream and artifact records, replay from an empty projection store must rebuild the same session projection exactly under the same protocol/projection versions.

Replay must not re-run tools, providers, filesystem reads, network calls, embeddings, clocks, or random ID generation. Those are side effects/observations and must already be recorded as events/artifacts. If replay needs the current filesystem or provider to recreate state, provenance has failed.

### False assumption 9: minimal tool count means minimal architecture risk

Only implementing `read_file`/`search_files` avoids execution scope, but it does not prove the successor can model oh-omp’s real tool surface. Tool protocol drift is a core migration risk. Slice 0 should port the core oh-omp tool catalog as protocol-visible definitions, while keeping dangerous/complex tools stubbed or rejected deterministically.

## Blocking amendments before implementation agents

### A1. Separate raw event identity from stream-frame identity

Current ambiguity:

- `KernelEvent.event_id` and `RawEvent.event_id` both use `evt_`.
- `raw_event_appended.payload.event_id` refers to the persisted raw event, while the stream envelope `event_id` refers to the live stream frame.
- both have `seq` fields with unclear ownership.

Recommended amendment:

```text
RawEvent.event_id      -> evt_...
RawEvent.session_seq   -> platform-assigned append order within session
KernelFrame.frame_id   -> frame_... or kevt_...
KernelFrame.stream_seq -> request-stream-local order
```

If we keep the name `KernelEvent`, it should be clear it is a transport/progress event, not the canonical raw event log.

### A2. Define platform-owned ordering and event read API

Add:

```http
GET /sessions/{session_id}/events?after_seq=<n>&limit=<n>
GET /events/{event_id}
GET /artifacts/{artifact_id}
```

Minimum response for event listing:

```json
{
  "session_id": "ses_...",
  "events": [/* RawEventV0 */],
  "next_after_seq": 42,
  "has_more": false
}
```

`POST /events` response should include:

```json
{
  "event_id": "evt_...",
  "session_seq": 42,
  "duplicate": false,
  "stored_at": "...",
  "source_envelope_id": "src_...",
  "artifact_id": "art_..."
}
```

### A3. Freeze the Slice 0 state machine

Define one allowed successful turn path.

Recommended path:

```text
1. turn_started stream frame
2. user_turn.recorded raw event appended
3. assembly.requested raw event appended
4. /assemble call
5. assembly.completed raw event appended
6. provider_request.built raw event appended
7. provider/tool request observed
8. tool_call.requested raw event appended
9. tool_call.started stream frame / optional raw event
10. read_file executes
11. tool_result.recorded raw event appended with artifact/source handles
12. second /assemble with required_source_envelope_ids=[tool_result source]
13. assembly.completed raw event appended for post-tool context
14. final provider request/continuation
15. assistant_turn.recorded raw event appended
16. turn_completed stream frame
```

Slice 0 should allow max one tool round per turn unless intentionally expanded.

Unsupported tool calls should emit:

```text
error.recorded raw event
turn_failed stream frame
```

### A4. Port the core oh-omp tool catalog as protocol-visible stubs

Recommendation: Slice 0 should expose a successor tool catalog derived from oh-omp’s `BUILTIN_TOOLS`/`HIDDEN_TOOLS`, but execute only the safe read/discovery subset needed for the smoke path.

Core catalog groups to port as definitions:

```text
read/find/grep/search_tool_bm25
ast_grep/ast_edit/lsp
edit/write/notebook
bash/python/ssh/browser
fetch/web_search/gh_*
ask/todo/todos/checkpoint/rewind/await/cancel_job/task
recall/concept_graph
calc/render_mermaid/inspect_image
submit_result/report_finding/exit_plan_mode/resolve where protocol-relevant
```

Slice 0 behavior:

- executable: hardened read/discovery tools only;
- stubbed/rejected: mutation, shell/runtime, subagent, browser, notebook, external/web/GitHub unless specifically enabled;
- every model-requested tool call gets `tool_call_id`;
- unsupported tools emit `tool_call.requested`, `tool_call.rejected`, and `error.recorded` raw events;
- no silent no-op tool stubs;
- tool schema/catalog publication itself should be reproducible and optionally recorded as `tool_catalog.published`.

This proves the tool identity/provenance model against the real oh-omp surface without taking on dangerous execution scope.

### A5. Decide useful target: add `search_files` or make prompt path-explicit

Recommended: add a second read-only locator tool:

```text
search_files(query, max_matches) -> path/match preview artifact
read_file(path) -> file content artifact
```

Why: without this, the system cannot satisfy “read the relevant file” unless the user already gives the path. `search_files` is still safe, read-only, and exercises the same event/artifact/assemble machinery.

If we refuse a second tool, amend acceptance to use a path-explicit prompt:

```text
Read packages/coding-agent/src/context/concept-graph.ts and explain what it does.
```

### A6. Harden `read_file`

Change tool arguments to:

```json
{
  "path": "relative/path/from/session/root",
  "max_bytes": 200000
}
```

Rules:

- root comes only from trusted session/kernel workspace config;
- reject absolute paths;
- reject `..` traversal;
- canonicalize root and candidate;
- reject symlink escape;
- define binary handling;
- define oversize/truncation behavior;
- denied/not-found/too-large/binary failures emit raw `error.recorded` events.

### A7. Add shared error envelope

Define `ErrorEnvelopeV0` for HTTP and stream failures:

```json
{
  "schema_version": "platform.error.v0",
  "error_id": "err_...",
  "code": "validation_failed",
  "message": "...",
  "recoverable": false,
  "retryable": false,
  "correlation_id": "req_...",
  "details": {}
}
```

Minimum status mapping:

- 400 validation;
- 401 missing/invalid auth;
- 403 forbidden;
- 404 not found;
- 409 idempotency/conflict;
- 422 semantic/schema rejection;
- 429 rate limit;
- 500 internal;
- 503 platform/provider unavailable.

### A8. Fix visibility/redaction defaults

Local file content should not default to public/shareable.

Recommended defaults for `read_file` / `search_files` artifacts:

```json
{
  "redaction": "sensitive",
  "visibility": {
    "model": true,
    "transcript": true,
    "recall": true,
    "assemble": true,
    "share": false,
    "debug": true
  }
}
```

Sharing should be an explicit grant, not a fixture default.

### A9. Rewrite fixtures to prove deterministic replay, not just causality

Fixtures should encode a possible turn, not just shapes.

Minimum fixture set should include:

- user turn raw event;
- pre-tool assembly requested/completed;
- provider request built;
- tool call requested;
- tool result raw event;
- post-tool assembly requested/completed;
- assistant turn raw event;
- snapshot with `last_raw_event_seq`;
- at least one error fixture before implementation if error handling is part of Slice 0 acceptance.

Add fixture validation rules:

- no context item may reference a future source/artifact;
- `causation_event_id` must refer to an earlier event;
- session sequence must be monotonic and dense;
- source/artifact handles must be produced by prior raw events;
- assistant/source handle must have a prior raw append;
- provider credentials must not appear anywhere in platform fixtures.
- replaying fixture raw events from an empty projection store twice must produce byte-identical canonical session snapshot/transcript/tool/error/artifact/trace projections;
- replay must consume recorded tool/provider/artifact observations, never current filesystem/provider/network state;
- projection/schema version must be part of the replay contract.

## Decide now

### D1. Storage backend

Recommendation: **SQLite + sqlx** for Slice 0 platform canonical store.

Reason:

- async-friendly with tokio/axum;
- enough durability for event log and artifacts;
- migrations are explicit;
- keeps LanceDB/vector stores as future projections, not canonical truth.

Use tables roughly like:

```text
sessions
raw_events
artifacts
idempotency_keys
```

No object storage yet.

### D2. SSE resumption

Recommendation: explicitly defer durable mid-turn SSE resume.

Slice 0 guarantees:

- ordered stream frames while connected;
- final inspection/replay through platform raw events after completion/failure.

Optional in-process `Last-Event-ID` replay may exist but should not be acceptance-critical.

### D3. Schema compatibility

Recommendation:

- ignore unknown object fields;
- reject unknown `schema_version` major versions;
- reject unknown closed-enum variants;
- use open strings only where documented, e.g. future `event_type` namespaces.

### D4. Idempotency

Recommendation for Slice 0:

- treat `idempotency_key` as opaque client/kernel-provided string;
- unique per `session_id`;
- protocol crate may provide helper, but platform does not require independent recomputation.

### D5. Provider adapter

Recommendation:

- provider boundary accepts both Anthropic Messages-style and OpenAI Chat/Responses-style API shapes;
- direct HTTP from Rust, no SDK dependency required for Slice 0;
- one real provider path is sufficient for Slice 0 smoke, but provider-normalized types must not be Anthropic-only;
- must support tool-use blocks for the Slice 0 read/discovery tools in both shape families;
- non-streaming final text is acceptable if converted to stream frames, but tool-use protocol cannot be skipped;
- context platform auth should be MEMEX licence/entitlement shaped (`MEMEX_LICENSE` preferred spelling, `MEMEX_LICENCE` acceptable alias), not oh-omp provider-auth shaped;
- local provider auth resolver should follow the oh-omp auth shape for API keys and later subscription/OAuth logins; subscription login implementation is deferred beyond Slice 0;
- provider credentials, subscription tokens, OAuth refresh tokens, and local auth state files remain local kernel auth state and never enter platform raw events/artifacts/traces.

Platform auth clarification: context platform/session auth should be `MEMEX_LICENSE`-shaped entitlement auth, not oh-omp provider-auth shaped. Only provider credentials/subscription state should use the oh-omp local auth shape.

### D5.1 Platform auth versus provider auth

Recommendation:

- context platform auth should be `MEMEX_LICENSE`-shaped entitlement auth, not oh-omp provider credential auth;
- `MEMEX_LICENSE` authorizes context/session APIs only: sessions, raw events, artifacts, `/assemble`, traces, sharing/inspection;
- provider credentials follow oh-omp local auth shape: API keys, OAuth/subscription login state, credential rotation, model/account selection, usage-limit/backoff;
- provider credentials are re-resolved locally on resume and never enter platform raw events/artifacts/traces/fixtures;
- platform licence auth must never imply model spend authority.

### D6. Artifact storage

Recommendation:

- inline artifacts in SQLite up to `max_bytes` for Slice 0;
- store `sha256`, `byte_length`, `media_type`, preview, content;
- object/R2/S3 storage later.

## Decide per lane

- Exact Rust module/table layout.
- Local kernel spool implementation, provided resume does not depend on it.
- CLI display format, provided IDs are surfaced.
- Manual SSE parsing vs non-streaming synthetic deltas.
- Lexical `/assemble` ranking details.
- `search_files` implementation if accepted: `ignore`/`walkdir` + literal/regex matching, bounded output.

## Defer to Slice 1+

- embeddings;
- vector search;
- MMR/source weighting;
- background projection workers;
- retrieval telemetry/audits beyond basic trace stages;
- multi-provider abstraction;
- managed provider proxy;
- provider credential custody;
- TUI;
- slash commands;
- MCP;
- shell/bash execution;
- edit/apply execution;
- subagent execution;
- full sharing/grants UI;
- durable mid-token replay after kernel crash.

## One important addition from adjacent workstreams

The raw event spine should be designed so it can later support model/task outcome telemetry and self-improvement loops. Do not implement routing in Slice 0, but avoid closing the door on event types like:

```text
verification.completed
user_feedback.recorded
provider_choice.recorded
outcome.observed
```

This aligns with the broader model-routing direction: telemetry first, policy later.

## Post-amendment status

The original recommendation was executed by `t_jd8l` and then strengthened further after provider/auth review.

Landed after this review:

- raw event vs stream-frame separation;
- platform `session_seq` and event/artifact read APIs;
- deterministic replay fixture target;
- pre-tool/post-locator/post-read `/assemble` state machine;
- read/discovery tool scope and unsupported-tool rejection path;
- `ErrorEnvelopeV0`;
- MEMEX licence-shaped context-platform auth versus oh-omp-shaped local provider auth;
- Anthropic Messages plus OpenAI Chat/Responses provider-shape normalization fixture;
- real artifact digests/byte lengths in canonical fixtures;
- explicit `provider_api_shape` in provider request traces;
- explicit `tool_call.completed` lifecycle steps.

## Go/no-go

- **Go** for implementation lanes that reference the current `SLICE-0-CONTRACT.md`.
- **No-go** for implementation that treats this historical review's original no-go as current authority, or that ignores the post-amendment fixture contract.

The current dispatch authority is the amended contract plus canonical fixtures under `fixtures/slice-0/`.
