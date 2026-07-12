# Slice 0 Contract — Read-only Resumable Coding Q&A

**Status:** Amended contract for implementation-lane dispatch
**Workstream:** successor-agent-kernel
**Supersedes:** earlier TypeScript-shaped and source-envelope-first drafts in `FRAME.md`

## 0. Execution target

Build a Rust-first, headless successor slice that can answer a read-only coding question through:

```text
local CLI -> local kernel -> remote-shaped context platform /assemble -> provider projection -> read-only tools -> deterministic replay
```

Slice 0 is accepted only if the platform raw event stream can be replayed from an empty projection store into byte-identical session projections under the same protocol/projection versions.

## 1. Implementation stack

Slice 0 is implemented in **Rust**. Service boundaries are JSON over HTTP/SSE.

Provisional crate layout:

```text
crates/successor-protocol/          # serde/schemars types, validators, fixture replay checks
crates/successor-context-platform/  # HTTP JSON platform: sessions, raw events, artifacts, /assemble
crates/successor-kernel/            # local headless kernel daemon and provider/tool loop
crates/successor-cli/               # minimal CLI client
```

Recommended substrate:

```text
async runtime:        tokio
HTTP server:          axum
HTTP client:          reqwest
serialization:        serde, serde_json
schemas/snapshots:    schemars + insta or equivalent canonical JSON snapshots
CLI:                  clap
IDs:                  uuid
hashing:              sha2
errors:               thiserror in crates, anyhow only in binaries
tracing:              tracing, tracing-subscriber
canonical storage:    SQLite + sqlx
```

Rust is chosen because Slice 0’s hard problems are contracts, streaming, storage, replay, and correctness. Provider SDK convenience does not justify TypeScript for the kernel/platform.

## 2. Core invariants

### 2.1 Raw event log is truth

```text
Persisted RawEvent facts are canonical.
Projections are rebuildable views.
Stream frames are delivery/progress projections.
```

Everything meaningful is represented by a raw event. Raw events are immutable and append-only. Corrections, retries, redactions, rejections, failures, and derived projections are additional events.

Source envelopes, artifacts, messages, errors, context items, traces, provider request traces, and tool lifecycle views are handles/projections derived from raw events. They are not peer truth models.

### 2.2 Deterministic replay is the provenance bar

```text
raw events + artifacts + projection code version -> byte-identical session projection
```

Replay from an empty projection store must rebuild the same accepted projections under the same protocol/projection versions:

- session snapshot;
- transcript/message projection;
- tool lifecycle projection;
- error projection;
- source envelope and artifact index;
- assembly trace/context item projection;
- provider request/response trace projection;
- CLI-inspectable turn trace.

Replay **must not** re-run providers, tools, filesystem reads, network calls, embeddings, clocks, or random ID generation. Those are side effects/observations and must already be recorded in raw events and artifacts.

Projection functions must be deterministic and versioned. If projection semantics change, introduce explicit projection/schema versions or migration events.

### 2.3 Context platform is canonical

The kernel must call platform `/assemble` for semantic context on every turn phase that needs semantic context. There is no local semantic assembler fallback.

Slice 0 does not implement embeddings/vector search/full assembly. `/assemble` may use deterministic lexical/recency retrieval over raw events/artifacts, but any missing embedding/vector capability must be explicit degradation.

### 2.4 Auth planes are separate

Platform/session auth is **MEMEX_LICENSE-shaped entitlement auth** for context/session APIs. Provider auth is **oh-omp-shaped local credential auth** and stays local to the kernel. Platform licence tokens must not authorize provider calls. Provider credentials must never be stored in raw events, artifacts, traces, fixtures, or platform projections.

Canonical Slice 0 platform auth input:

```text
MEMEX_LICENSE=<license-or-dev-entitlement-token>
```

`MEMEX_LICENSE` authorizes access to the context platform only: sessions, raw events, artifacts, `/assemble`, traces, and sharing/inspection. It is not a provider API key, OAuth token, subscription token, or model spend credential. If a British-spelled `MEMEX_LICENCE` alias is ever accepted, it is only an alias for the same platform entitlement plane.

Provider credentials follow the existing oh-omp-style local provider auth plane: provider API keys, OAuth/subscription login state, credential rotation, model/account selection, usage-limit/backoff state, and local credential storage. Those credentials are re-resolved locally on resume and are never sent to the remote context platform.

### 2.5 Local authority is capability-gated

Every tool has a runtime-owned authority class: `safe_read`, `workspace_mutation`, `local_process`, and future higher authorities (§7.3). Authority classes are registry/runtime metadata, not protocol catalog fields. Default session authority is `safe_read` only. The provider (model) can request only catalog-published capabilities and can never grant itself authority; effective authority and rejection are typed, auditable, and replayable. Local process authority additionally requires a nonempty, host-configured executable allowlist (§7.4); the provider never supplies a host path or triggers a `PATH` lookup. A tool whose authority class is absent from the session's effective authority is catalog-visible but policy-rejected, never a silent no-op or panic.

## 3. ID model

All IDs are opaque strings. Use prefix + UUID where practical.

| Thing | Prefix | Owner | Notes |
|---|---|---|---|
| session | `ses_` | platform | remote continuity/sharing |
| turn | `turn_` | kernel | logical user turn |
| request | `req_` | kernel | live request/cancel group |
| raw event | `evt_` | platform, kernel may propose | persisted occurrence fact |
| stream frame | `frame_` | kernel | live delivery/progress frame |
| message projection | `msg_` | kernel/platform projection | transcript/UI/provider projection handle |
| tool call | `tool_` | kernel | same ID across lifecycle |
| source envelope | `src_` | platform projection | context-addressable source handle |
| artifact | `art_` | platform | recoverable content handle |
| assembly | `asm_` | platform | one `/assemble` operation |
| context item | `ctx_` | platform projection | one assembly candidate/item |
| trace | `trace_` | kernel/platform | inspectable projection trace |
| error | `err_` | emitter | durable error identity |
| provider event | `pevt_` | kernel | retained provider observation |
| projection version | string | protocol crate | deterministic replay version |

Ordering authority:

- `RawEvent.session_seq` is platform-assigned and total within a session.
- `KernelFrame.stream_seq` is kernel-assigned and total within a live request stream.
- Wall-clock timestamps are metadata, not ordering authority.

## 4. RawEvent v0

Canonical platform persistence uses `platform.raw_event.v0`.

```json
{
  "schema_version": "platform.raw_event.v0",
  "event_id": "evt_...",
  "session_seq": 1,
  "idempotency_key": "opaque-client-key",
  "event_type": "user_turn.recorded",
  "session_id": "ses_...",
  "turn_id": "turn_...",
  "request_id": "req_...",
  "occurred_at": "2026-06-23T12:00:00Z",
  "producer": { "kind": "kernel", "id": "local-dev-kernel" },
  "causation_event_id": null,
  "correlation_id": "req_...",
  "entity_ids": {
    "message_id": "msg_...",
    "tool_call_id": null,
    "source_envelope_id": "src_...",
    "artifact_id": null,
    "assemble_id": null,
    "context_item_ids": [],
    "trace_id": null,
    "error_id": null,
    "provider_event_id": null
  },
  "visibility": {
    "model": true,
    "transcript": true,
    "recall": true,
    "assemble": true,
    "share": false,
    "debug": true
  },
  "redaction": "sensitive",
  "payload": {},
  "artifact": null
}
```

Required rules:

- `event_id` identifies the occurrence.
- `session_seq` is assigned by platform on append; kernel may propose but platform decides.
- `entity_ids` identify durable entities the event is about.
- `causation_event_id` must reference an earlier raw event in the same session when present.
- `correlation_id` groups related events; Slice 0 uses `request_id` by default.
- `idempotency_key` is opaque and unique per `session_id`; duplicate keys return the existing append result.
- Failure is represented by raw events (`*.failed`, `*.rejected`, `error.recorded`), not absence of success.
- Raw events must not contain provider credentials.
- Large content is stored as artifact data or artifact handle; event payload still carries enough hashes/locators to verify what happened.

### 4.1 Event types used in Slice 0

```text
tool_catalog.published
user_turn.recorded
assembly.requested
assembly.completed
provider_request.built
provider_tool_call.observed
provider_response.recorded
tool_call.requested
tool_call.started
tool_call.completed
tool_call.rejected
tool_call.failed
tool_result.recorded
assistant_turn.recorded
error.recorded
```

### 4.2 ErrorEnvelopeV0

Errors are both payloads and durable identities. HTTP errors, tool rejections, provider failures, validation failures, and turn failures use this shape in payloads.

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

| HTTP | Meaning |
|---|---|
| 400 | validation/malformed request |
| 401 | missing/invalid auth |
| 403 | forbidden by auth/policy |
| 404 | not found |
| 409 | idempotency/conflict |
| 422 | semantic/schema rejection |
| 429 | rate limit |
| 500 | internal |
| 503 | platform/provider unavailable |

## 5. KernelFrame v0

Kernel stream frames are live delivery/progress projections. They are not canonical persisted facts, though they should reference raw events when available.

SSE format:

```text
event: kernel_frame
data: <KernelFrame JSON>
```

```json
{
  "schema_version": "kernel.frame.v0",
  "frame_id": "frame_...",
  "stream_seq": 1,
  "session_id": "ses_...",
  "turn_id": "turn_...",
  "request_id": "req_...",
  "ts": "2026-06-23T12:00:00Z",
  "kind": "turn_started",
  "raw_event_id": null,
  "raw_event_session_seq": null,
  "causation_frame_id": null,
  "entity_ids": {
    "message_id": null,
    "tool_call_id": null,
    "source_envelope_id": null,
    "artifact_id": null,
    "assemble_id": null,
    "context_item_ids": [],
    "trace_id": null,
    "error_id": null,
    "provider_event_id": null
  },
  "payload": {}
}
```

Allowed frame kinds:

```text
turn_started
raw_event_append_started
raw_event_appended
platform_assemble_started
platform_assemble_completed
provider_request_built
provider_delta
tool_call_requested
tool_call_started
tool_call_completed
tool_call_rejected
turn_completed
turn_failed
```

Frame rules:

- `frame_id` uses `frame_`, never `evt_`.
- `stream_seq` orders a live stream only.
- If a frame reports a persisted fact, `raw_event_id` and `raw_event_session_seq` must be present.
- Token-level provider deltas may be frames only in Slice 0. Persisted replay facts are coarse provider observations: `provider_tool_call.observed`, `provider_response.recorded`, and `provider_request.built`. `provider_delta.recorded` is out of scope unless a later slice adds it to the event-type list with schema and retention rules.

## 6. Context Platform API v0

Base URL example:

```text
http://127.0.0.1:7332/v0
```

All requests require MEMEX licence-shaped platform entitlement auth: `Authorization: Bearer <MEMEX_LICENSE>`. This token authorizes context-platform APIs only and must not authorize provider/model calls.

### 6.1 Create session

```http
POST /sessions
```

Request:

```json
{
  "workspace": {
    "id": "workspace_oh_omp",
    "label": "oh-oh-my-pi",
    "root_hint": "/Users/drazen/playground/ai-omnibus/oh-oh-my-pi"
  },
  "title": "Read-only coding Q&A",
  "created_by": { "client_kind": "kernel", "client_id": "local-dev-kernel" }
}
```

Response:

```json
{
  "session_id": "ses_...",
  "created_at": "2026-06-23T12:00:00Z"
}
```

### 6.2 Append raw event

```http
POST /events
```

Request is `RawEventV0` without trusted `session_seq`; platform assigns `session_seq`.

Response:

```json
{
  "event_id": "evt_...",
  "session_seq": 42,
  "duplicate": false,
  "stored_at": "2026-06-23T12:00:01Z",
  "source_envelope_id": "src_...",
  "artifact_id": "art_..."
}
```

`source_envelope_id` and `artifact_id` are present only when projections/handles are produced.

### 6.3 Read session events

```http
GET /sessions/{session_id}/events?after_seq=<n>&limit=<n>
```

Response:

```json
{
  "schema_version": "platform.event_page.v0",
  "session_id": "ses_...",
  "events": [],
  "next_after_seq": 42,
  "has_more": false
}
```

### 6.4 Read single event

```http
GET /events/{event_id}
```

Returns `RawEventV0` or `ErrorEnvelopeV0` with 404.

### 6.5 Read artifact

```http
GET /artifacts/{artifact_id}
```

Response:

```json
{
  "schema_version": "platform.artifact.v0",
  "artifact_id": "art_...",
  "media_type": "text/plain",
  "encoding": "utf-8",
  "sha256": "sha256:...",
  "byte_length": 1234,
  "preview": "...",
  "content": "..."
}
```

Slice 0 stores inline SQLite artifacts up to the tool limit. Object storage is deferred.

### 6.6 Get session snapshot

```http
GET /sessions/{session_id}/snapshot
```

Response is a projection from raw events:

```json
{
  "schema_version": "platform.session_snapshot.v0",
  "session_id": "ses_...",
  "created_at": "2026-06-23T12:00:00Z",
  "updated_at": "2026-06-23T12:05:00Z",
  "last_raw_event_seq": 20,
  "raw_event_ids": ["evt_..."],
  "source_envelope_ids": ["src_..."],
  "artifact_ids": ["art_..."],
  "assemble_ids": ["asm_..."],
  "last_turn_id": "turn_...",
  "last_assistant_summary": "...",
  "sharing": { "visibility": "private", "grants": [] }
}
```

### 6.7 Assemble

```http
POST /assemble
```

Request:

```json
{
  "schema_version": "platform.assemble_request.v0",
  "session_id": "ses_...",
  "turn_id": "turn_...",
  "request_id": "req_...",
  "phase": "pre_tool",
  "intent": {
    "query": "concept graph resolver",
    "raw_user_text": "Find and read the concept graph resolver; explain what it does.",
    "confidence": "explicit"
  },
  "workspace": {
    "root_hint": "/Users/drazen/playground/ai-omnibus/oh-oh-my-pi",
    "repo_id": "oh-oh-my-pi"
  },
  "budget": { "max_context_tokens": 12000, "max_items": 20 },
  "required_source_envelope_ids": [],
  "exclude_source_envelope_ids": []
}
```

Allowed `phase` values:

```text
pre_tool
post_locator
post_read
final
```

Response:

```json
{
  "schema_version": "platform.assembly_response.v0",
  "assemble_id": "asm_...",
  "session_id": "ses_...",
  "turn_id": "turn_...",
  "request_id": "req_...",
  "phase": "pre_tool",
  "created_at": "2026-06-23T12:00:02Z",
  "context_items": [],
  "trace": {
    "trace_id": "trace_...",
    "assemble_id": "asm_...",
    "query": "concept graph resolver",
    "projection_version": "slice0.projection.v0",
    "stages": [],
    "dropped": []
  },
  "degradation": [],
  "policy": {
    "enabled_sources": ["user_turn", "assistant_turn", "tool_result"],
    "disabled_sources": [],
    "weights": {}
  }
}
```

`/assemble` returns structured context, not provider messages. The kernel projects context items into provider-visible text.

### 6.8 Get assembly trace

```http
GET /traces/{assemble_id}
```

Returns `AssemblyTraceV0`.

## 7. Tool catalog v0

Slice 0 publishes a protocol-visible tool catalog based on oh-omp's core tools. The catalog has two layers. The **base catalog** (§7.1, §7.2) is the sovereign, fixture-pinned set of 35 tool definitions and their executable/stub_rejected status; it changes only through an explicit sovereign contract/fixture amendment, never as a side effect of session configuration. The **effective catalog** (§7.3) is a runtime/session-specific projection of the base catalog through the session's effective authority classes and process-allowlist configuration (§7.4); it is published per turn (`tool_catalog.published`) and may mark a base-executable tool `policy_rejected` when the session lacks the required authority. Unsupported and policy-rejected tools must both produce deterministic events, not silent no-ops.

### 7.1 Base catalog: executable tools

Base-catalog executable subset (nine tools; execution is still gated per-session by effective authority, §7.3):

| Tool | Purpose | Authority class | Notes |
|---|---|---|---|
| `search_files` | locate likely files/paths from a bounded query | `safe_read` | successor locator tool; may use walkdir/ignore + lexical/regex matching |
| `read` | read one relative file or a line range under the session workspace root | `safe_read` | offset/limit are optional positive line-range parameters; returns an artifact for exactly the returned bytes |
| `find` | glob/list files under session workspace root | `safe_read` | bounded output |
| `grep` | regex/text search under session workspace root | `safe_read` | bounded output |
| `list_dir` | list direct children of one relative directory under the session workspace root | `safe_read` | sorted, bounded, metadata-only directory listing; no file content reads; no symlink traversal |
| `ast_grep` | structural syntax-tree search/match under session workspace root | `safe_read` | returns bounded artifact bytes; the same bytes are projected to payload/provider/artifact with no reserialization drift |
| `edit` | apply one preconditioned, bounded workspace mutation | `workspace_mutation` | stale-write preconditions, atomic replacement, before/after hashes, bounded diff artifact |
| `write` | create or replace bounded file content under the session workspace root | `workspace_mutation` | same preconditioned-mutation contract as `edit` |
| `bash` | run one trusted, allowlisted executable with structured argv | `local_process` | never a shell string; requires a nonempty host-configured executable allowlist (§7.4); nonzero exit and timeout are ordinary successful receipts, not executor errors (§9.1) |

`search_files` is included so the smoke target can be useful without a path-explicit prompt. (The `read` row and the `list_dir` row/tool were amended/added by the agent://269 Lane 3 dissent ruling.)

### 7.2 Base catalog: rejected/stubbed tools

Catalog definitions should exist for these groups (26 tools), with execution rejected unless a later slice promotes them:

```text
ast_edit, lsp, notebook
python, ssh, browser
fetch, web_search, gh_*
ask, todo, todos, checkpoint, rewind, await, cancel_job, task
recall, concept_graph
calc, render_mermaid, inspect_image
submit_result, report_finding, exit_plan_mode, resolve
```

`ssh` is the sovereign amendment target for the unsupported-tool oracle fixture (`raw-events-unsupported-tool.json`), replacing the prior `bash` identity now that `bash` is a base-catalog executable tool (§7.1); the fixture is amended in place — tool identity, idempotency keys, payload, and rejection reason — not replaced, and event ordering is preserved.

On unsupported tool request:

```text
tool_call.requested
tool_call.rejected
error.recorded
```

The raw events must preserve original arguments, `tool_call_id`, `error_id`, rejection policy/reason, causation, and correlation.

A catalog publication may be recorded as `tool_catalog.published` so replay can reconstruct what tools were advertised to the provider.

### 7.3 Effective catalog and authority classes

The effective catalog is computed once per session/turn from the base catalog (§7.1, §7.2) and the session's effective authority classes, and is what `tool_catalog.published` and the provider-normalized tool list actually expose. Authority classes are runtime registry metadata; they are not added as fields on the protocol catalog entry itself.

| Authority class | Grants | Default session state |
|---|---|---|
| `safe_read` | `search_files`, `read`, `find`, `grep`, `list_dir`, `ast_grep` | always granted |
| `workspace_mutation` | `edit`, `write` | not granted by default |
| `local_process` | `bash`, further conditioned on a nonempty executable allowlist (§7.4) | not granted by default |

Under the default `safe_read`-only session, the published effective catalog exposes six executable tools (the five prior read/discovery tools plus `ast_grep`); `edit`, `write`, and `bash` remain catalog-visible but `policy_rejected`. When executable, `bash`'s effective input schema MUST narrow its `executable` argument to an enum of the session's allowlisted logical names; this makes the published effective catalog session-specific and auditable, not a new sovereign base-catalog fixture. A request against a `policy_rejected` catalog entry follows the same rejection/error raw-event pair as an unsupported base-catalog tool (§7.2).

### 7.4 Trusted process configuration

Local process authority is granted only through explicit, host-owned configuration; there is no `PATH` lookup and the provider never supplies a host path. The CLI accepts a repeated flag:

```text
--allow-executable <logical-name>=<absolute-path>
```

Parsing/validation rules:

- Parsed and validated before provider/network/auth bootstrap.
- Conflicts with `--kernel-url`: local process trust is local-only configuration and is never forwarded to an external kernel over RPC.
- Rejects an empty logical name, a duplicate logical name, a relative path, a path that does not canonicalize, a path that is not a regular file, and a path that is not executable.
- Performs no `PATH` search; the path must already be absolute and canonicalizable to an executable file.
- The provider may name only a trusted logical name in a `bash` call; it never supplies or overrides a host path.

Embedders may inject a `TrustedExecutableAllowlist` directly into local `AppState` instead of going through CLI flags. The default allowlist is empty, which keeps `bash` `policy_rejected` even when `local_process` authority is otherwise granted (§7.3).

## 8. Tool authority and argument contracts

The session workspace root is trusted kernel/session configuration. The provider/model never supplies root.

### 8.1 `read`

Arguments:

```json
{
  "path": "packages/coding-agent/src/context/concept-graph.ts",
  "max_bytes": 200000
}
```

Rules:

- `path` must be relative.
- Reject absolute paths.
- Reject `..` traversal.
- Canonicalize workspace root and candidate path.
- Reject symlink escape outside root.
- Define binary handling: Slice 0 rejects binary-looking files with `error.recorded`.
- Define truncation: if over `max_bytes`, record truncated artifact with `truncated: true` and byte counts.
- File content artifacts default to `redaction: "sensitive"` and `visibility.share: false`.

### 8.2 `search_files`

Arguments:

```json
{
  "query": "concept graph resolver",
  "max_matches": 20
}
```

Rules:

- Search only under session workspace root.
- Bounded traversal and bounded output.
- Respect `.gitignore` unless implementation explicitly records why not.
- Return path/match previews as a `tool_result.recorded` artifact.
- No hidden semantic/vector retrieval; lexical/filename/regex scoring is acceptable and must be recorded in payload/trace.

### 8.3 `find` and `grep`

`find`/`grep` may be thin wrappers around the same safe read/discovery substrate. They must obey the same root, bounds, artifact, and error rules.

### 8.4 `ast_grep`

`ast_grep` is `safe_read` authority: no mutation, no process execution. It returns bounded artifact bytes (structural matches/spans) that are projected to provider text, event payload, and persisted artifact without reserialization drift — the same bytes every time, never a re-derived summary.

### 8.5 `edit` and `write`

`edit` and `write` require `workspace_mutation` authority (§7.3). Both use the preconditioned-mutation contract: a stale-write precondition (the caller's before-hash must match the file's current hash), atomic replacement, size bounds, before/after hashes, and a bounded diff artifact. A stale-hash mismatch is a recoverable tool error (§9.1), not a rejection: the provider is told so a repair round can re-read and retry. The event payload and the provider-visible receipt project the same canonical mutation-receipt JSON as the persisted artifact.

### 8.6 `bash`

`bash` requires `local_process` authority *and* a nonempty executable allowlist (§7.4); an empty allowlist keeps `bash` `policy_rejected` even under `local_process` authority. Arguments are a trusted logical executable name plus a structured argv list — never a shell string, never `sh -c`. Nonzero process exit and timeout are ordinary, successful `bash` tool results carrying receipt status/exit/duration fields so the provider can repair from stdout/stderr summaries; they are not executor errors and must never produce `error.recorded` (§9.1). The provider-visible receipt intentionally omits raw stdout/stderr artifact bytes; the persisted artifact carries the full bounded process receipt (stdout/stderr/exit/duration) with hash and length, so provider-visible text and the persisted artifact are not required to be byte-identical for this tool.

## 9. Successful turn state machine

Slice 0's canonical fixture is a bounded read-only tool path: one locator tool call followed by one file-read tool call per turn. Post-Slice-0 live execution permits up to eight executable read/discovery tool calls per turn; the Slice 0 canonical fixture remains the richer locator+read happy path, not an exhaustive max-budget fixture. Exceeding the live per-turn tool-call maximum emits `tool_call.rejected` and `error.recorded` without changing event names or lifecycle semantics. (Amended by the agent://256 dissent ruling, item A, PROCEED-WITH-CONDITIONS.)

Happy path:

```text
1.  stream frame: turn_started
2.  raw event: tool_catalog.published (once per submitted turn -- see the continuation amendment below; never suppressed on a continuation turn)
3.  raw event: user_turn.recorded
4.  raw event: assembly.requested phase=pre_tool
5.  platform /assemble phase=pre_tool
6.  raw event: assembly.completed phase=pre_tool
7.  raw event: provider_request.built phase=initial
8.  raw event: provider_tool_call.observed tool=search_files
9.  raw event: tool_call.requested tool=search_files
10. raw event: tool_call.started tool=search_files
11. raw event: tool_result.recorded tool=search_files
12. raw event: tool_call.completed tool=search_files
13. raw event: assembly.requested phase=post_locator
14. platform /assemble phase=post_locator
15. raw event: assembly.completed phase=post_locator
16. raw event: provider_request.built phase=read_request
17. raw event: provider_tool_call.observed tool=read
18. raw event: tool_call.requested tool=read
19. raw event: tool_call.started tool=read
20. raw event: tool_result.recorded tool=read
21. raw event: tool_call.completed tool=read
22. raw event: assembly.requested phase=post_read
23. platform /assemble phase=post_read
24. raw event: assembly.completed phase=post_read
25. raw event: provider_request.built phase=final
26. raw event: provider_response.recorded
27. raw event: assistant_turn.recorded
28. stream frame: turn_completed
```

A path-explicit prompt may skip `search_files`, but fixtures must cover the richer locator+read path.

**Continuation (amended by the agent://270 dissent ruling, PROCEED-WITH-CONDITIONS.)** A submitted turn either starts a fresh, runner-owned session (`session_id` absent from the submit-turn request; unchanged Slice 0 default, byte-identical) or continues an existing session (`session_id` present and naming a session with at least one prior raw event). Continuation is a second (or later) full run of the happy path above, appended to the *same* session's raw-event stream, not a shortened or alternate lifecycle:

- The full 28-step happy path repeats verbatim for the continuation turn, including step 2 (`tool_catalog.published`): it is emitted once per *submitted turn*, unconditionally, never suppressed because the session already has a catalog event from an earlier turn.
- Raw-event `session_seq` continues monotonically from the continued session's prior tail; it is never reset to 1 for the new turn.
- The continuation turn's first raw event (`tool_catalog.published`) chains its `causation_event_id` to the continued session's prior tail event, instead of the fresh-session `causation_event_id: null` start of a causal chain.
- A `turn_id`/`request_id` pair is freshly minted for the continuation turn; it is never reused from a prior turn in the same session.
- Continuing into a session with no prior raw events (never submitted to) fails closed with a typed error before the turn's first frame, exactly like any other pre-stream failure; it never silently starts a fresh session in its place.
- Prior-turn context enters the continuation turn's provider request through platform `/assemble` only (contract §13 item 3: the kernel never constructs semantic context by parsing transcript text). `/assemble`'s `retrieve_recent_sources` stage (used whenever a phase call carries no `required_source_envelope_ids`) ranks the session's own prior artifact-bearing raw events by recency and surfaces them as context items, excluding the current turn's own artifacts (which do not exist yet at `pre_tool` time in production, and would otherwise double the fresh-session canonical fixture's fixture-pinned zero-item shape). A session with no prior artifacts (the canonical `pre_tool` fixture's shape) still degrades to zero context items.

Unsupported tool path:

```text
provider_tool_call.observed
tool_call.requested
tool_call.rejected
error.recorded
turn_failed or provider continuation with tool error, depending on provider protocol
```

### 9.1 Recoverable tool executor errors

Executor-level failures that occur after `tool_call.started` are distinct from pre-execution rejection/dispatch failures (which remain the `tool_call.rejected`/`error.recorded` pair above and never grant authority). They are structured `ToolExecutionError` values carrying a code, message, `recoverable`/`retryable` flags, provider-visible result text, and redaction-safe details. They are persisted, in order, as an `error.recorded` raw event with a stable, redaction-safe code/details, followed by the existing raw event `tool_call.failed`; the existing `tool_call_completed` frame is emitted with payload status `error` and a bounded preview. No new event or frame name is introduced, and no failure semantics are folded into an existing success event. When the error is recoverable, a provider-visible tool result string is returned and the turn continues into the next provider round so the provider can repair — for example a stale-write mismatch on `edit`/`write` (§8.5). Provider adapters SHOULD mark the tool result `is_error=true` where the wire shape supports it (e.g. Anthropic); other shapes carry status/error text without leaking details.

Nonzero `bash` process exit and timeout are explicitly not executor errors: they are ordinary successful tool results (§8.6). Argument/schema/policy failures that occur before execution remain `tool_call.rejected`/`error.recorded` and never grant authority.

If a durable raw-event append or artifact persistence fails, that is not recoverable in-memory: the turn stops rather than continuing with unverifiable state. Replay/resume must be able to project a failed tool call's facts without requiring a source artifact for that call, and must preserve every assistant/provider fact that followed it.

## 10. Provider projection v0

Provider target: **normalized local provider adapter accepting both Anthropic Messages-style and OpenAI Chat/Responses-style API shapes**.

Slice 0 has two provider support levels:

1. **Live smoke path:** one real provider path is sufficient. Default remains direct Anthropic Messages API over Rust HTTP unless implementation evidence makes an OpenAI-compatible path faster.
2. **Normative shape contract:** all provider-normalized request/tool/result/response types must be validated against fixture coverage for `anthropic_messages`, `openai_chat_completions`, and `openai_responses`. Fixture-level support is enough for non-smoke wire shapes in Slice 0, but an Anthropic-only normalized type model is not acceptable.

The protocol crate should model a provider-normalized request/stream/tool shape that can project to and ingest from:

- Anthropic Messages API shape: messages/content blocks/tool_use/tool_result/stream events;
- OpenAI Chat Completions shape: messages/tool_calls/tool outputs/stream chunks;
- OpenAI Responses shape: input/items/function calls/function_call_output/stream events.

Rules:

- Provider auth is read from local kernel auth resolver only.
- Provider credentials never enter platform raw events/artifacts/traces.
- Provider messages are projections, not canonical state.
- Provider request traces record the normalized provider shape plus the concrete `provider_api_shape` (`anthropic_messages`, `openai_chat_completions`, or `openai_responses`) with content previews/source refs, not credentials.
- Tool-use/function-call blocks must normalize into the same successor lifecycle for Anthropic and OpenAI-shaped APIs: `provider_tool_call.observed`, `tool_call.requested`, `tool_result.recorded`, and `provider_response.recorded`.
- Streaming token deltas may be `KernelFrame` only. Persist coarse provider observations needed for deterministic replay (`provider_tool_call.observed`, `provider_response.recorded`, `provider_request.built`).
- Provider-specific IDs may be stored as provider observation metadata, but successor IDs (`tool_call_id`, `provider_event_id`, `message_id`, `trace_id`) remain the stable replay identity.
- Subscription/OAuth login support is a required local provider-auth roadmap capability, modeled after oh-omp local auth, but it is not required for Slice 0 execution. Slice 0 may use API-key/dev-token local provider auth only.
- Context platform auth is not oh-omp provider auth. The context platform accepts `MEMEX_LICENSE`-shaped licence/entitlement auth only; provider API keys/OAuth/subscription material follow oh-omp local auth shape and remain kernel-local.

## 11. Session resume semantics

On resume:

1. CLI asks kernel to resume `session_id`.
2. Kernel queries `GET /sessions/{session_id}/snapshot`.
3. Kernel can fetch `GET /sessions/{session_id}/events` and artifacts as needed.
4. Kernel replays projections deterministically or requests platform projections.
5. Kernel re-resolves provider auth locally.
6. No local session-file copy is required.

A second kernel/client can inspect/resume platform session state but cannot use the first kernel’s provider credentials.

Resume and attach remain read-only: they inspect or rebuild projections from platform state and never submit a turn, append a raw event, or drive a new turn lifecycle. **Continuation is not resume or attach (amended by the agent://270 dissent ruling, PROCEED-WITH-CONDITIONS.)** `ask --session-id <existing>` submits a genuine new turn (`POST /v0/turns` with `session_id` set) against an existing session; it is a write path through the ordinary submit-turn RPC and turn lifecycle (§9), never a read-only resume/attach call, and never bypasses `/assemble` to reconstruct context from a resumed snapshot or replayed transcript directly.

## 12. Fixture contract

Fixture directory:

```text
.oh/workstreams/successor-agent-kernel/fixtures/slice-0/
```

Required canonical fixtures:

```text
tool-catalog.json
raw-events-successful-turn.json
raw-events-unsupported-tool.json
kernel-frame-stream.json
assemble-request-pre-tool.json
assemble-response-pre-tool.json
assemble-request-post-read.json
assemble-response-post-read.json
session-snapshot.json
expected-session-projection.json
provider-shape-normalization.json
```

Optional compatibility/projection examples may exist, but implementation agents must treat the above as contract law.

For Slice 0, artifact content may be embedded inside raw-event fixture `artifact` objects. If implementation moves artifacts into detached files later, the fixture set must add an explicit artifact-store fixture keyed by `artifact_id` and `sha256`.

Fixture validation rules:

- JSON parses.
- Raw event `session_seq` is monotonic and dense per session.
- `causation_event_id` references only earlier events.
- No context item references future source/artifact events.
- Source/artifact handles are produced by prior raw events.
- Artifact `sha256` values are canonical `sha256:<64 lowercase hex>` digests of the exact fixture bytes, and `byte_length` matches those bytes.
- Every `provider_request.built` payload has `provider_api_shape` and uses one of `anthropic_messages`, `openai_chat_completions`, `openai_responses`.
- `provider-shape-normalization.json` proves equivalent normalized tool-call/tool-result semantics for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses shapes.
- Unsupported tool fixture has `tool_call.requested`, `tool_call.rejected`, and `error.recorded`.
- Replay of `raw-events-successful-turn.json` into accepted projections is byte-identical to `expected-session-projection.json`.
- Fixtures contain no provider credentials, OAuth refresh tokens, subscription session material, or `MEMEX_LICENSE` values.
The following bullets are accepted target fixture law from S1. They become byte-true only through the sovereign S6 base-catalog/unsupported-fixture amendment and the predicted S7 default-effective-catalog ripple; until those stages land, the checked-in fixtures remain the pre-amendment 35/5/30 catalog with `bash` as the unsupported-tool oracle.

- Base catalog fixture (`tool-catalog.json`) is 35 tools: 9 executable (§7.1) and 26 `stub_rejected` (§7.2).
- Unsupported-tool fixture (`raw-events-unsupported-tool.json`) exercises `ssh`, not `bash`, since `bash` is now a base-catalog executable tool.
- Default `safe_read`-only fixtures (`raw-events-successful-turn.json`, `provider-shape-normalization.json`, `kernel-frame-stream.json`) show six executable tools (the prior five plus `ast_grep`) and `policy_rejected` `edit`/`write`/`bash`.
- No fixture is regenerated wholesale outside its predicted catalog/tool-identity/projection fields; a wider byte change is a contract note first, per the tool-authoring blueprint's fixture-amendment protocol, never a silent regeneration.

## 13. Acceptance criteria

Slice 0 is accepted only when:

1. CLI can submit a real read-only coding Q&A turn through kernel RPC.
2. Kernel calls platform `/assemble` for the pre-tool and post-read phases; post-locator when locator is used.
3. Kernel never constructs semantic context by parsing transcript text.
4. Provider request trace references `provider_api_shape`, platform context item IDs, raw/source/artifact IDs, and provider-normalized tool names.
5. Executable read/discovery tools append raw events and produce platform artifact handles with verified `sha256`/`byte_length`.
6. Unsupported catalog tools produce deterministic rejection/error raw events.
7. Provider normalization fixtures pass for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses shapes, even if only one live provider path is exercised.
8. Kernel restart + `session_id` resumes from platform raw events/artifacts without copying local session files.
9. Provider credentials remain local and absent from platform raw events/artifacts/traces/fixtures.
10. Degraded retrieval is explicit in stream frames and assembly traces.
11. Raw events + artifacts + projection code version rebuild byte-identical accepted projections.
12. There is exactly one semantic context path: platform `/assemble`.
11. There is exactly one semantic context path: platform `/assemble`.

## 14. Dispatch gates

Implementation agents may start only after:

- this contract is present;
- required fixtures are present;
- fixture JSON parsing passes;
- causal fixture validation passes;
- deterministic replay fixture validation is implemented or explicitly stubbed as a failing TODO owned by the integration lane;
- implementation-lane tasks reference this amended contract.

Agents must not change without returning to solution-space/review:

- Rust stack decision;
- raw event log as truth;
- stream frame vs raw event separation;
- platform `/assemble` as only semantic context path;
- provider auth local-only boundary;
- executable tool scope;
- deterministic replay acceptance gate.
