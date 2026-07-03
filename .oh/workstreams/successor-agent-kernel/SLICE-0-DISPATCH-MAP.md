# Slice 0 Dispatch Map — Stable Interfaces First

**Status:** Wave 0 decomposition artifact; no implementation authority by itself  
**Date:** 2026-06-24  
**Authority:** `SLICE-0-CONTRACT.md` + canonical fixtures under `fixtures/slice-0/`  
**Purpose:** make later subagent waves safe by freezing cross-lane interfaces before code is written.

---

## 1. Execute pre-flight declaration

**Task:** decompose Slice 0 into strict implementation lanes with stable interfaces.

**Aim:** enable a later horde of implementation agents without letting them invent incompatible kernels.

**Selected approach:** foundation-first dispatch: protocol DTOs + fixture validator first, then platform/kernel/provider/tool/CLI lanes behind typed interfaces.

**Scope:** decomposition, file ownership, dependency graph, stable API contracts, validation gates, forbidden shortcuts.

**Out of scope:** runtime implementation, crate creation, fixture edits, contract weakening, provider/OAuth subscription implementation, full implementation-agent dispatch.

**Success:** a future orchestrator can assign bounded tasks with 3–5 explicit files each, and every cross-lane dependency is expressed as a stable interface owned by one lane.

**Critical assumptions:**

- Root `Cargo.toml` already uses `members = ["crates/*"]`, so new successor crates can be added without broad workspace rewrites.
- `SLICE-0-CONTRACT.md` and fixtures are sovereign.
- RawEvent is canonical persisted truth.
- KernelFrame is live/progress projection only.
- Context platform auth is `MEMEX_LICENSE`-shaped entitlement auth.
- Provider auth is oh-omp-shaped local credential auth and remains local.
- Provider projection supports `anthropic_messages`, `openai_chat_completions`, and `openai_responses` at normalized type/fixture level.
- Only one live provider path is required for Slice 0.

**Accepted trade-offs:**

- More up-front interface work to reduce horde drift.
- More crates/modules than the absolute minimum, because stable ownership matters more than first-pass terseness.
- Deterministic fixture validation precedes user-visible behavior.

**Invalidated if:** stable protocol types cannot model the canonical fixtures without changing the event ontology or weakening provider/auth boundaries.

**Stop/pivot if:** any lane needs to edit contract/fixtures to pass, invents a second semantic context path, stores provider credentials on the platform, or requires downstream lanes to define duplicate DTOs.

---

## 2. Sovereign rules for all future agents

1. Do not edit `SLICE-0-CONTRACT.md` unless explicitly assigned a contract-maintenance task.
2. Do not edit canonical fixtures unless explicitly assigned a fixture-maintenance task.
3. Do not weaken fixtures to make implementation pass.
4. Do not add raw event types outside the contract.
5. Do not add `provider_delta.recorded` in Slice 0.
6. Do not persist token-level provider deltas.
7. Do not treat provider wire messages as canonical state.
8. Do not parse transcript text to recover semantic context.
9. Do not create any semantic context path except platform `/assemble`.
10. Do not use `MEMEX_LICENSE` as provider/model-call authority.
11. Do not send provider API keys/OAuth/subscription material to the context platform.
12. Do not implement subscription/OAuth provider login in Slice 0 unless separately authorized.
13. Do not create local per-crate copies of shared protocol DTOs.
14. Do not let CLI become a session store, replay engine, or provider client.

---

## 3. Dependency graph

```text
Wave A: Workspace + Protocol Foundation
  WorkspaceBootstrap
    -> ProtocolCoreFoundation
       -> ProviderNormalizationFoundation
       -> ReplayProjectionFoundation
       -> FixtureValidatorFoundation

Wave B: Platform Foundation
  ContextPlatformAuth
  ContextPlatformStorageAppend
  ContextPlatformArtifactStore
  ContextPlatformProjectionReplay
  ContextPlatformAssembly
    -> ContextPlatformHttpApi

Wave C: Kernel Foundation
  KernelPlatformClient
  KernelFrameStream
  LocalProviderAuthResolver
  ProviderProjectionAdapter
  ReadDiscoveryToolExecutor
    -> TurnSessionRunner
       -> KernelLocalRpcSse

Wave D: CLI + Integration
  SuccessorCli
  BlackBoxIntegrationSmoke
  FinalVerifier
```

Hard release rule:

```text
No implementation horde beyond Wave A may start until ProtocolCoreFoundation,
ProviderNormalizationFoundation, ReplayProjectionFoundation, and
FixtureValidatorFoundation expose compile-checked shared types and fixture gates.
```

---

## 4. Stable interface catalog

### 4.1 `successor-protocol` crate

**Owner:** Protocol foundation lanes  
**Consumers:** all other successor crates  
**Proposed crate:** `crates/successor-protocol`

This crate owns every public JSON shape and every fixture-facing type. Downstream crates must import these types rather than defining local equivalents.

#### Modules and exported contracts

| Module | Stable exports | Notes |
|---|---|---|
| `ids.rs` | typed/newtype IDs for `session_id`, `event_id`, `turn_id`, `message_id`, `source_envelope_id`, `artifact_id`, `tool_call_id`, `trace_id`, `assemble_id`, `provider_event_id`, `frame_id`, `request_id` | ID prefixes validated here. |
| `error.rs` | `ErrorEnvelopeV0`, `ProtocolViolation`, `ProtocolViolationCode`, `ProtocolViolationSet`, `ProtocolResult<T>` | Error codes are stable; English messages are not API. |
| `raw_event.rs` | `RawEventV0`, `EventTypeV0`, `ProducerV0`, `EntityIdsV0`, `VisibilityV0`, `RedactionV0`, `InlineArtifactV0`, `RawEventAppendRequestV0`, `RawEventAppendResponseV0` | RawEvent is canonical persisted truth. |
| `artifact.rs` | `ArtifactV0`, `ArtifactDescriptorV0`, `ArtifactRefV0` | Slice 0 artifacts are inline and hash-verified. |
| `kernel_frame.rs` | `KernelFrameV0`, `KernelFrameKindV0`, `KernelFramePayloadV0`, `KernelFrameValidationReportV0` | KernelFrame is live-only. |
| `platform_api.rs` | `CreateSessionRequestV0`, `CreateSessionResponseV0`, `EventPageV0`, `SessionSnapshotV0`, `AssembleRequestV0`, `AssemblyResponseV0`, `AssemblyTraceV0`, `ContextItemV0`, `DegradationV0`, `PolicyV0` | Transport auth is bearer `MEMEX_LICENSE`; not payload auth. |
| `provider.rs` | `ProviderApiShapeV0`, `ProviderNormalizedRequestV0`, `ProviderNormalizedToolCallV0`, `ProviderNormalizedToolResultV0`, `ProviderNormalizedResponseV0`, `ProviderShapeNormalizationFixtureV0` | `ProviderApiShapeV0` values are exactly `anthropic_messages`, `openai_chat_completions`, `openai_responses`. |
| `tool_catalog.rs` | `ToolCatalogV0`, `ToolDefinitionV0`, `ToolExecutionModeV0` | Only `search_files`, `read`, `find`, `grep` executable in Slice 0. |
| `projection.rs` | `ExpectedSessionProjectionV0`, `SessionProjectionV0`, `ReplayInputV0` | Pure projection shapes. |
| `replay.rs` | `project_session(input: &ReplayInputV0) -> ProtocolResult<SessionProjectionV0>` | No fs/network/provider/tool/clock/random dependencies. |
| `canonical_json.rs` | `to_canonical_json_bytes<T>(value: &T) -> ProtocolResult<Vec<u8>>` | Used for byte-identical projection checks. |
| `fixtures.rs` | `Slice0FixtureBundleV0`, `FixtureValidationReportV0`, `validate_slice0_fixture_bundle(bundle: &Slice0FixtureBundleV0) -> ProtocolResult<FixtureValidationReportV0>` | Dispatch gate for later horde waves. |
| `validation.rs` | `validate_raw_event_batch`, `validate_append_candidate`, `validate_kernel_frame_stream`, `validate_provider_shape_fixture` | Shared validation logic. |

#### Stable function signatures

```rust
validate_raw_event_batch(events: &[RawEventV0]) -> ProtocolResult<RawEventBatchReportV0>
validate_append_candidate(event: &RawEventV0) -> ProtocolResult<AppendCandidateReportV0>
validate_kernel_frame_stream(frames: &[KernelFrameV0]) -> ProtocolResult<KernelFrameStreamReportV0>
validate_provider_shape_fixture(fixture: &ProviderShapeNormalizationFixtureV0) -> ProtocolResult<ProviderShapeReportV0>
project_session(input: &ReplayInputV0) -> ProtocolResult<SessionProjectionV0>
to_canonical_json_bytes<T>(value: &T) -> ProtocolResult<Vec<u8>>
validate_slice0_fixture_bundle(bundle: &Slice0FixtureBundleV0) -> ProtocolResult<FixtureValidationReportV0>
```

#### Protocol validation must fail

- non-dense per-session `session_seq`;
- future/same/cross-session causation;
- invalid ID prefixes;
- unknown event types;
- duplicate idempotency keys;
- future source/artifact/context references;
- missing `provider_api_shape` on `provider_request.built`;
- provider shape outside the three allowed values;
- malformed or content-mismatched artifact hashes;
- credential-like strings in recursive payload/artifact/fixture values;
- unsupported-tool fixtures missing requested/rejected/error lifecycle;
- replay output not byte-identical to `expected-session-projection.json`.

Important nuance: `provider_api_shape` is required at `provider_request.built` and provider request traces. Do not make a universal rule over every provider-related raw event until fixtures and contract are explicitly amended.

---

### 4.2 Context platform HTTP API

**Owner:** `crates/successor-context-platform`  
**Consumers:** kernel platform client, CLI inspect/resume, integration smoke

All endpoints are JSON over HTTP under `/v0` and require:

```http
Authorization: Bearer <MEMEX_LICENSE>
```

This is context-platform entitlement only, not provider auth.

#### Endpoints

| Endpoint | Request | Response | Authority |
|---|---|---|---|
| `POST /sessions` | `CreateSessionRequestV0` | `CreateSessionResponseV0` | Platform creates session. |
| `POST /events` | `RawEventAppendRequestV0` | `RawEventAppendResponseV0` | Platform assigns `session_seq`. |
| `GET /sessions/{session_id}/events?after_seq&limit` | query | `EventPageV0` | Read platform raw events. |
| `GET /events/{event_id}` | path | `RawEventV0` | Read single raw event. |
| `GET /artifacts/{artifact_id}` | path | `ArtifactV0` | Read inline Slice 0 artifact. |
| `GET /sessions/{session_id}/snapshot` | path | `SessionSnapshotV0` | Deterministic projection. |
| `POST /assemble` | `AssembleRequestV0` | `AssemblyResponseV0` | Sole semantic context path. |
| `GET /traces/{assemble_id}` | path | `AssemblyTraceV0` | Inspect assembly trace. |

#### Platform-internal traits

These traits are internal to the platform crate; they must not leak SQLite row structs or table names into protocol/kernel/CLI crates.

```rust
trait RawEventAppendStore {
    fn create_session(&self, request: CreateSessionRequestV0) -> PlatformResult<CreateSessionResponseV0>;
    fn append_event(&self, request: RawEventAppendRequestV0) -> PlatformResult<RawEventAppendResponseV0>;
    fn read_event(&self, event_id: EventId) -> PlatformResult<Option<RawEventV0>>;
    fn read_session_events(&self, session_id: SessionId, after_seq: Option<u64>, limit: usize) -> PlatformResult<EventPageV0>;
}

trait ArtifactStoreV0 {
    fn put_inline_artifact(&self, event_id: EventId, artifact: ArtifactV0) -> PlatformResult<ArtifactRecordV0>;
    fn get_artifact(&self, artifact_id: ArtifactId) -> PlatformResult<Option<ArtifactV0>>;
}

trait AssemblyServiceV0 {
    fn assemble(&self, request: AssembleRequestV0) -> PlatformResult<AssemblyResponseV0>;
    fn get_trace(&self, assemble_id: AssembleId) -> PlatformResult<Option<AssemblyTraceV0>>;
}
```

#### Platform validation gates

- missing/invalid `MEMEX_LICENSE` returns `ErrorEnvelopeV0` 401;
- provider-key-shaped credentials are rejected as platform auth;
- client-supplied `session_seq` is ignored/rejected; platform assigns dense ordering;
- duplicate `(session_id, idempotency_key)` returns existing append result with `duplicate=true`;
- append rejects future causation and future references;
- `/assemble` returns context items/traces/degradation only, never provider messages;
- no platform store/traces/artifacts contain provider credentials or raw `MEMEX_LICENSE` values;
- replay/snapshot from raw events + artifacts matches canonical fixtures.

---

### 4.3 Kernel local RPC/SSE API

**Owner:** `crates/successor-kernel`  
**Consumers:** CLI, integration smoke

Local kernel APIs are distinct from remote context-platform APIs.

#### Proposed endpoints

| Endpoint | Request | Response |
|---|---|---|
| `POST /v0/turns` | `AskTurnRequestV0` | `text/event-stream` of `KernelFrameV0` |
| `POST /v0/resume` | `ResumeRequestV0` | `ResumeResponseV0` |
| `GET /v0/sessions/{session_id}/snapshot` | path | `SessionSnapshotV0` passthrough/projection |
| `GET /v0/sessions/{session_id}/events?after_seq&limit` | query | `EventPageV0` passthrough |
| `GET /v0/turns/{turn_id}/trace` | path | deterministic turn trace projection |
| `GET /v0/health` | none | platform/provider readiness |

SSE format:

```text
event: kernel_frame
data: <KernelFrameV0 JSON>
```

#### Stable DTOs

```rust
struct AskTurnRequestV0 {
    session_id: Option<SessionId>,
    workspace_root: String,
    prompt: String,
    request_id: Option<RequestId>,
    provider: Option<ProviderSelectionV0>,
    output_mode: Option<OutputModeV0>,
}

struct ResumeRequestV0 {
    session_id: SessionId,
    workspace_root: Option<String>,
}

struct ResumeResponseV0 {
    session_snapshot: SessionSnapshotV0,
    last_raw_event_seq: u64,
    provider_auth_resolved: bool,
}
```

#### Kernel traits

```rust
trait RawEventAppendClient {
    fn create_session(&self, request: CreateSessionRequestV0) -> KernelResult<CreateSessionResponseV0>;
    fn append_raw_event(&self, request: RawEventAppendRequestV0) -> KernelResult<RawEventAppendResponseV0>;
    fn get_session_events(&self, session_id: SessionId, after_seq: Option<u64>, limit: usize) -> KernelResult<EventPageV0>;
    fn get_artifact(&self, artifact_id: ArtifactId) -> KernelResult<ArtifactV0>;
    fn get_session_snapshot(&self, session_id: SessionId) -> KernelResult<SessionSnapshotV0>;
    fn assemble(&self, request: AssembleRequestV0) -> KernelResult<AssemblyResponseV0>;
    fn get_assembly_trace(&self, assemble_id: AssembleId) -> KernelResult<AssemblyTraceV0>;
}

trait KernelFrameSink {
    fn emit(&self, frame: KernelFrameV0) -> KernelResult<()>;
}

trait ProviderAuthResolver {
    fn resolve(&self, selection: ProviderSelectionV0) -> KernelResult<ProviderAuthMaterial>;
}

trait ProviderAdapter {
    fn send(&self, request: ProviderNormalizedRequestV0, auth: ProviderAuthMaterial, stream: &dyn KernelFrameSink) -> KernelResult<ProviderTurnOutputV0>;
}

trait ToolExecutor {
    fn execute(&self, call: ProviderNormalizedToolCallV0, ctx: ToolExecutionContextV0) -> KernelResult<ToolExecutionOutcomeV0>;
}
```

`ProviderAuthMaterial` must be non-serializable/debug-redacted and must not appear in protocol DTOs.

#### Turn runner contract

`TurnSessionRunner` owns orchestration only. It consumes the traits above and emits KernelFrames. It must not implement provider wire formats, auth storage, filesystem traversal, or platform HTTP internals inline.

Required happy-path order:

1. publish tool catalog when needed;
2. record user turn;
3. `assembly.requested` / `/assemble` / `assembly.completed` for `pre_tool`;
4. `provider_request.built` initial;
5. normalize provider tool call;
6. tool lifecycle for locator;
7. `post_locator` assembly when locator used;
8. provider request for read;
9. tool lifecycle for read;
10. `post_read` assembly;
11. final provider request;
12. provider response recorded;
13. assistant turn recorded;
14. `turn_completed` frame.

---

### 4.4 Provider projection and auth

**Owner:** provider lanes inside `crates/successor-kernel`, shared normalized types in `successor-protocol`

#### Stable provider shape enum

```rust
enum ProviderApiShapeV0 {
    AnthropicMessages,
    OpenAiChatCompletions,
    OpenAiResponses,
}
```

JSON values remain exact:

```text
anthropic_messages
openai_chat_completions
openai_responses
```

#### Stable functions

```rust
build_provider_request(input: ProviderBuildInputV0) -> KernelResult<ProviderRequestBuiltV0>
normalize_provider_tool_call(shape: ProviderApiShapeV0, wire_event: serde_json::Value, ids: CanonicalSuccessorIdsV0) -> KernelResult<ProviderNormalizedToolCallV0>
project_tool_result(shape: ProviderApiShapeV0, result: ProviderNormalizedToolResultV0) -> KernelResult<ProviderWireToolResultV0>
normalize_provider_response(shape: ProviderApiShapeV0, wire_response: serde_json::Value, ids: CanonicalSuccessorIdsV0) -> KernelResult<ProviderNormalizedResponseV0>
```

#### Required provider gates

- `provider-shape-normalization.json` passes for all three shapes;
- live smoke path uses at least one real provider adapter;
- every `provider_request.built` has `provider_api_shape`;
- provider request traces include provider-normalized tool names and context item IDs;
- provider-specific tool IDs are metadata only;
- no provider SDK/wire object becomes canonical state;
- no provider credentials in raw events, traces, artifacts, fixtures, SSE, or CLI output.

---

### 4.5 Read/discovery tool executor

**Owner:** tool lanes inside `crates/successor-kernel`

Executable Slice 0 tools:

```text
search_files
read
find
grep
```

All other catalog-visible tools are deterministic stubs/rejections.

#### Stable behavior

- workspace root comes from trusted kernel/session configuration, not provider input;
- paths must be relative to workspace root;
- reject absolute paths, `..`, symlink escape, binary-looking reads, and over-budget output;
- successful outputs produce artifacts with canonical `sha256` and `byte_length`;
- unsupported tools produce deterministic `provider_tool_call.observed`, `tool_call.requested`, `tool_call.rejected`, `error.recorded` path;
- no write/edit/shell/web/subagent/LSP/ast-grep execution in Slice 0.

---

### 4.6 CLI contract

**Owner:** `crates/successor-cli`

CLI is a stateless client/renderer. It does not own sessions, provider auth, replay, semantic context, or tools.

#### Proposed commands

```text
successor-cli ask \
  --workspace-root <path> \
  --prompt <text> \
  [--session-id <ses_...>] \
  [--kernel-url <url>] \
  [--platform-url <url>] \
  [--format text|json|sse]

successor-cli resume \
  --session-id <ses_...> \
  [--workspace-root <path>] \
  [--kernel-url <url>] \
  [--format json]

successor-cli inspect session \
  --session-id <ses_...> \
  [--kernel-url <url>] \
  --format json
```

#### CLI must not

- create a local session DB/cache;
- call providers directly;
- call tools directly;
- append turn raw events directly;
- parse transcript text into context;
- print provider credentials, OAuth tokens, subscription material, or raw `MEMEX_LICENSE` values;
- sanitize away contract-critical IDs from machine-readable output.

---

## 5. Implementation wave plan

Each future task below is intentionally bounded to 3–5 files, except where noted as a split marker. If a task needs more files, split it further before dispatch.

### Wave A — interface freeze

#### A0. WorkspaceBootstrap

**Owns:**

- `Cargo.toml`
- `crates/successor-protocol/Cargo.toml`
- `crates/successor-context-platform/Cargo.toml`
- `crates/successor-kernel/Cargo.toml`
- `crates/successor-cli/Cargo.toml`

**Unblocks:** every crate task.

**Gate:** dependency direction only allows:

```text
successor-cli -> successor-protocol
successor-cli -> successor-kernel client DTOs only if split crate exists later
successor-kernel -> successor-protocol
successor-context-platform -> successor-protocol
successor-protocol -> no successor crate
```

No circular dependencies.

#### A1. ProtocolIdsErrorsRaw

**Owns:**

- `crates/successor-protocol/src/lib.rs`
- `crates/successor-protocol/src/ids.rs`
- `crates/successor-protocol/src/error.rs`
- `crates/successor-protocol/src/raw_event.rs`
- `crates/successor-protocol/src/artifact.rs`

**Gate:** raw events and artifacts parse successful/unsupported fixtures and reject invalid IDs/hashes/credential leakage.

#### A2. ProtocolFramesPlatformDtos

**Owns:**

- `crates/successor-protocol/src/kernel_frame.rs`
- `crates/successor-protocol/src/platform_api.rs`
- `crates/successor-protocol/src/tool_catalog.rs`
- `crates/successor-protocol/tests/kernel_frame_fixture.rs`

**Gate:** `kernel-frame-stream.json` validates and platform DTOs match contract field names.

#### A3. ProtocolProviderNormalization

**Owns:**

- `crates/successor-protocol/src/provider.rs`
- `crates/successor-protocol/src/provider_shape_fixture.rs`
- `crates/successor-protocol/tests/provider_shape_normalization.rs`

**Gate:** provider-shape normalization fixture passes for all three shapes.

#### A4. ProtocolReplayProjection

**Owns:**

- `crates/successor-protocol/src/projection.rs`
- `crates/successor-protocol/src/replay.rs`
- `crates/successor-protocol/src/canonical_json.rs`
- `crates/successor-protocol/tests/replay_successful_turn.rs`

**Gate:** replay from successful raw events + artifacts is byte-identical to `expected-session-projection.json`.

#### A5. ProtocolFixtureValidator

**Owns:**

- `crates/successor-protocol/src/fixtures.rs`
- `crates/successor-protocol/src/validation.rs`
- `crates/successor-protocol/tests/slice0_fixture_contract.rs`

**Gate:** all canonical fixtures parse and all adversarial fixture mutation checks fail the tempting wrong patches.

### Wave B — platform foundation

#### B1. PlatformAuthHttpShell

**Owns:**

- `crates/successor-context-platform/src/lib.rs`
- `crates/successor-context-platform/src/main.rs`
- `crates/successor-context-platform/src/http.rs`
- `crates/successor-context-platform/src/auth.rs`
- `crates/successor-context-platform/src/error.rs`

**Gate:** all routes reject missing/invalid `MEMEX_LICENSE`; provider-looking tokens are not platform auth.

#### B2. PlatformStorageAppend

**Owns:**

- `crates/successor-context-platform/src/store.rs`
- `crates/successor-context-platform/src/sqlite.rs`
- `crates/successor-context-platform/src/session.rs`
- `crates/successor-context-platform/src/idempotency.rs`
- `crates/successor-context-platform/migrations/0001_slice0.sql`

**Gate:** dense transactionally assigned `session_seq`, idempotency, causation, and artifact integrity.

#### B3. PlatformArtifactsIndexes

**Owns:**

- `crates/successor-context-platform/src/artifacts.rs`
- `crates/successor-context-platform/src/source_index.rs`
- `crates/successor-context-platform/tests/slice0_artifacts.rs`

**Gate:** artifact API returns inline content with matching hash/length and no replay re-read.

#### B4. PlatformProjectionReplay

**Owns:**

- `crates/successor-context-platform/src/projection.rs`
- `crates/successor-context-platform/src/replay.rs`
- `crates/successor-context-platform/src/trace_index.rs`
- `crates/successor-context-platform/tests/slice0_replay.rs`

**Gate:** empty projection store can rebuild snapshot/projection from raw events/artifacts only.

#### B5. PlatformAssembly

**Owns:**

- `crates/successor-context-platform/src/assemble.rs`
- `crates/successor-context-platform/src/retrieval.rs`
- `crates/successor-context-platform/tests/slice0_assemble.rs`

**Gate:** pre-tool/post-read fixtures match; degraded retrieval is explicit; no provider messages.

#### B6. PlatformRoutesContract

**Owns:**

- `crates/successor-context-platform/src/routes.rs`
- `crates/successor-context-platform/tests/slice0_platform_contract.rs`

**Gate:** all endpoints return protocol DTOs/ErrorEnvelopeV0 and hide SQLite details.

### Wave C — kernel foundation

#### C1. KernelPlatformClient

**Owns:**

- `crates/successor-kernel/src/platform_client.rs`
- `crates/successor-kernel/src/platform_http.rs`
- `crates/successor-kernel/src/platform_error.rs`

**Gate:** platform client sends only `MEMEX_LICENSE` to platform, trusts platform-assigned `session_seq`, and never carries provider credentials.

#### C2. KernelFrameStream

**Owns:**

- `crates/successor-kernel/src/frame_sink.rs`
- `crates/successor-kernel/src/stream.rs`
- `crates/successor-kernel/src/sse.rs`

**Gate:** SSE is exactly `event: kernel_frame`; stream seq dense; persisted-fact frames reference raw event ID/seq.

#### C3. KernelProviderAuth

**Owns:**

- `crates/successor-kernel/src/provider/auth.rs`
- `crates/successor-kernel/src/provider/credentials.rs`
- `crates/successor-kernel/src/config.rs`

**Gate:** provider auth is local-only, redacted, not serializable to protocol/platform, and re-resolves on resume.

#### C4. KernelProviderProjection

**Owns:**

- `crates/successor-kernel/src/provider/mod.rs`
- `crates/successor-kernel/src/provider/projection.rs`
- `crates/successor-kernel/src/provider/anthropic.rs`
- `crates/successor-kernel/tests/slice0_provider_shapes.rs`

**Gate:** provider-shape fixture passes; live smoke adapter uses normalized DTOs; traces contain `provider_api_shape` and no secrets.

#### C5. KernelToolCatalogAndRead

**Owns:**

- `crates/successor-kernel/src/tools/mod.rs`
- `crates/successor-kernel/src/tools/catalog.rs`
- `crates/successor-kernel/src/tools/read.rs`
- `crates/successor-kernel/tests/slice0_tools_read.rs`

**Gate:** catalog matches fixture; read is root-bounded; artifact hashes/byte lengths are correct.

#### C6. KernelToolSearchFindGrep

**Owns:**

- `crates/successor-kernel/src/tools/search_files.rs`
- `crates/successor-kernel/src/tools/find.rs`
- `crates/successor-kernel/src/tools/grep.rs`
- `crates/successor-kernel/tests/slice0_tools_discovery.rs`

**Gate:** lexical/discovery only, bounded output, root bounded, no shelling out.

#### C7. KernelTurnRunner

**Owns:**

- `crates/successor-kernel/src/runner.rs`
- `crates/successor-kernel/src/state_machine.rs`
- `crates/successor-kernel/src/id_factory.rs`
- `crates/successor-kernel/src/turn_trace.rs`
- `crates/successor-kernel/tests/slice0_kernel_contract.rs`

**Gate:** exact Slice 0 lifecycle with assemblies, provider requests, tool lifecycle, provider response, assistant turn, and frames.

#### C8. KernelLocalRpc

**Owns:**

- `crates/successor-kernel/src/http.rs`
- `crates/successor-kernel/src/routes.rs`
- `crates/successor-kernel/src/api.rs`
- `crates/successor-kernel/src/lib.rs`

**Gate:** local RPC/SSE exposes runner only; resume uses platform snapshot/events/artifacts; no provider secret inspection endpoint.

### Wave D — CLI and integration

#### D1. SuccessorCliCore

**Owns:**

- `crates/successor-cli/src/main.rs`
- `crates/successor-cli/src/args.rs`
- `crates/successor-cli/src/client.rs`
- `crates/successor-cli/src/render.rs`
- `crates/successor-cli/tests/slice0_cli_contract.rs`

**Gate:** stateless CLI submits through kernel RPC/SSE and preserves IDs in JSON/SSE output.

#### D2. BlackBoxIntegrationSmoke

**Owns:**

- `crates/successor-cli/tests/slice0_cli_smoke.rs`
- `crates/successor-kernel/tests/slice0_end_to_end.rs`
- `crates/successor-context-platform/tests/slice0_platform_replay.rs`
- `crates/successor-protocol/tests/slice0_fixture_contract.rs`

**Gate:** deterministic smoke passes; opt-in live provider path recorded separately; sentinel credential leak scan passes.

---

## 6. Horde release gates

Implementation horde may proceed only after these gates are satisfied in order.

### Gate 1 — protocol freeze

- `successor-protocol` compiles independently.
- Fixtures parse into shared DTOs.
- `ProviderApiShapeV0` includes exactly the three required values.
- Replay projection API is pure over in-memory inputs.
- No downstream crate has duplicate RawEvent/KernelFrame/platform/provider DTOs.

### Gate 2 — fixture referee

- `validate_slice0_fixture_bundle` passes canonical fixtures.
- Injected mutation checks fail:
  - placeholder hash;
  - wrong byte length;
  - missing `provider_api_shape` on `provider_request.built`;
  - unknown provider shape;
  - future causation;
  - future source/artifact reference;
  - nested credential-looking value;
  - missing unsupported-tool rejection/error path;
  - projection mismatch.

### Gate 3 — platform contract

- platform endpoints require `MEMEX_LICENSE`;
- provider-looking credentials rejected as platform auth;
- platform assigns sequence;
- raw events/artifacts replay deterministically;
- `/assemble` returns context items/traces/degradation only.

### Gate 4 — kernel interfaces

- kernel local RPC/SSE route names and DTOs frozen;
- provider auth resolver redacted/local-only;
- provider projection fixture passes;
- tool executor root/bounds/rejection checks pass;
- runner emits exact lifecycle and never constructs context outside `/assemble`.

### Gate 5 — CLI/integration

- CLI is stateless;
- resume works with fresh local state using `session_id` + platform;
- black-box deterministic smoke proves end-to-end wiring;
- opt-in live provider smoke proves one real provider path before final Slice 0 acceptance;
- leak scan covers platform store, artifacts, traces, SSE, and CLI output.

---

## 7. Risk-retirement matrix

| Risk / assumption / trigger | Status target | Tempting wrong patch this check fails | Evidence/check required |
|---|---|---|---|
| Downstream lanes define duplicate DTOs before protocol is frozen | Retired by evidence | each crate copies JSON fixture fields locally | grep/check confirms RawEvent/KernelFrame/platform/provider DTOs only live in `successor-protocol`, downstream imports them |
| Fixture validator is too weak | Retired by evidence | regex-only hash validation or semantic JSON comparison | mutation tests fail wrong digest, wrong byte length, provider shape omission, future causation, secret leakage, and byte mismatch |
| RawEvent and KernelFrame semantics collapse | Retired by evidence | persist streaming token deltas as raw events | no `provider_delta.recorded` enum; replay uses raw events/artifacts only; deleting frame logs does not change replay |
| Provider normalization becomes Anthropic-only | Retired by evidence | live Anthropic works, OpenAI is opaque passthrough | `provider-shape-normalization.json` validates all three shapes into same normalized lifecycle |
| Auth planes collapse | Retired by evidence | reuse provider AuthStorage for platform or `MEMEX_LICENSE` for provider | negative tests reject provider-key-shaped platform auth; provider secrets never appear in platform records/traces/SSE/CLI |
| Platform trusts kernel sequence | Retired by evidence | accept fixture `session_seq` from append request | append tests prove platform allocates dense sequence and rejects/ignores client sequence |
| `/assemble` returns provider messages | Retired by evidence | platform returns Anthropic/OpenAI messages for speed | response DTO has context items/traces only; provider request builder is sole projection step |
| Kernel constructs context from transcript/tool text | Retired by evidence | skip `/assemble` when tool result has enough content | platform double fails if required assemble phases not called; context item IDs come from assembly response |
| Tool executor escapes root or broadens authority | Retired by evidence | path prefix checks or dispatch unknown tools to shell/oh-omp | tests cover absolute path, `..`, symlink escape, binary-looking file, unsupported bash/edit/web/subagent tools |
| Replay re-runs side effects | Retired by evidence | if artifact missing, read file path again | replay test runs without workspace/provider/network and uses raw events/artifacts only |
| CLI becomes second store | Retired by evidence | cache sessions under user dir and resume from cache | fresh local state resume succeeds from platform only; CLI has no persistence layer |
| Silent degraded retrieval | Retired by evidence | empty context items with 200 OK | assembly responses/traces/frames include `embeddings_unavailable`/`no_context` when applicable |
| Live provider never exercised | Accepted until final gate | fixture-only provider path treated as final | deterministic smoke can pass earlier, but final Slice 0 requires opt-in one-live-provider smoke evidence |

---

## 8. Stop/pivot triggers for implementation horde

Stop and route back to contract/problem review if any implementation lane reports:

- contract and fixtures cannot both be satisfied;
- protocol types require changing raw event ontology;
- OpenAI Chat/Responses cannot normalize without provider-shape redesign;
- platform auth needs provider credentials;
- resume needs local session file copying;
- replay needs filesystem/provider/tool/network side effects;
- `/assemble` cannot return useful context without becoming provider-message builder;
- tool execution requires write/shell/web/subagent authority;
- implementation agents need to edit the same core files concurrently.

---

## 9. Minor clerical precondition

A non-blocking contract cleanup remains: the acceptance criteria currently has duplicate “There is exactly one semantic context path: platform `/assemble`” wording/numbering after strengthening. It does not change interfaces, but contract-maintenance may remove the duplicate before implementation dispatch to reduce confusion.

Do not let implementation agents interpret the duplicate as two context paths.

---

## 10. Dispatch rule

The horde is safe only if each implementation task can be stated as:

```text
Target: 3–5 explicit files
Inputs: stable protocol/platform/kernel trait or DTO contract
Forbidden: named shortcuts
Acceptance: targeted check that fails a tempting wrong patch
```

If a task cannot be expressed that way, it is not ready for horde execution.
