# Tool Authoring Blueprint

Durable law for authoring and amending kernel-executed tools in
`successor-kernel`. Ruled into existence by the `agent://256`
`BudgetToolsBlueprintDissent` (verdict `PROCEED-WITH-CONDITIONS`), item C.
Binding on all future tool additions/amendments unless superseded by a later
dissent ruling or contract amendment.

## 1. Authority and scope

The workspace root is kernel/session configuration, resolved once per
`TurnRunner` and passed to every tool executor as `&self.workspace_root`. The
provider (model) never supplies the root, an absolute path, or any path
component that could escape it. Tool executors accept only paths relative to
that root. Raw event names, frame kinds, RPC/SSE contract shapes, and
lifecycle/completion semantics are fixed points: a new tool or a budget/format
change must never rename an event, a frame kind, or alter turn-completion
signaling to make itself fit.

Tool executors are dispatched through a typed `ToolExecutionContext<'a>` (workspace root plus any authority-scoped configuration, e.g. the trusted executable allowlist for `local_process` tools) rather than an untyped `fn(&Path, &Value)` seam. Every registry entry declares an explicit authority class (`safe_read`, `workspace_mutation`, `local_process`, or a future class) and an availability predicate; authority classes are runtime/registry metadata, never protocol catalog fields (contract §7.3). A tool whose authority class is outside the session's effective authority, or whose availability predicate fails (e.g. `local_process` with an empty allowlist), is rejected the same way as a catalog-unsupported tool — never dispatched, never silently downgraded.

## 2. Arg DTO single source

Every tool's arguments and results are single-sourced from Rust types:
`#[derive(serde::Deserialize, schemars::JsonSchema)]` (see
`crates/successor-kernel/src/tools/read.rs`'s `ReadArgs` for the canonical
shape). The published tool catalog's JSON Schema is generated from these same
DTOs (`crates/successor-kernel/src/tools/catalog.rs`) — never hand-authored.
The provider-facing schema and the `serde_json::from_value` deserialization
used at execution time must be the same type, so schema drift and executor
drift cannot diverge silently. Adding a field to a tool's arguments means
adding it to the DTO; the catalog and the executor pick it up automatically.

## 3. Catalog registration

Every tool has a catalog entry declaring its status (e.g. published,
unsupported), category, and rejection policy for the not-yet-executable case.
A tool that is catalog-visible but not executable in Slice 0 must reject with
`TurnFailure`'s catalog-aware variant (`tool `{tool_name}` is catalog-visible
but not executable in Slice 0: {reason}`) rather than silently no-op or panic.
Registering a new tool requires amending the canonical fixture set alongside
the contract (§9 for the "9. Successful turn state machine" typed-round
mapping) — never leave an executable gap where the catalog claims support the
runtime cannot deliver.

## 4. Executor bounds and root-bounding

Every executor rejects:

- absolute paths and `..` traversal (lexical rejection before any filesystem
  call);
- paths that canonicalize outside the workspace root, including via symlink
  escape;
- binary content where a text read is expected (NUL-byte sniffing, as in
  `read.rs`'s `ReadRejection::LooksBinary`).

Every executor that can produce unbounded output (`read`, `find`, `grep`,
`search_files`) has an explicit default bound: `max_bytes` for `read`
(contract §8.1), `max_matches`/`max_entries` for search-shaped tools (§8.2,
§8.3). Ordering of results (matches, entries) is deterministic — no reliance
on filesystem iteration order without an explicit sort. When a bound is hit,
the result carries `truncated: true` plus enough evidence (byte/entry counts)
for a caller to know it was hit; never truncate silently.

## 5. Artifact contract

Every tool result that reaches `tool_result.recorded` carries: the full
content bytes, a `sha256` over those bytes, `byte_length`, and a media type.
Redaction/sharing is `false`/none in Slice 0 — no external sharing surface
exists yet. `preview` is UI/trace metadata only: a short, human-scannable
string (first line, first match) for the frame stream. `preview` must never
be the *only* representation of a successful result available downstream —
see §6.

## 6. Provider projection contract

This is the section item B of `agent://256` exists to enforce. The exact
content the model receives on the *next* provider round after a tool call
must be full bounded content for read-like outputs (the complete file body,
truncated only past the §8.1 bound with a deterministic marker), and the
complete bounded matches/entries list for search-shaped outputs — never a
`preview`-only projection, never a first-line-only projection, and never a
bare `artifact:<id>` handle standing in for content the model has not
actually seen. Artifact handles may *accompany* the content (for later
reference/dedup) but must never *replace* it. This projection is a
runtime-only value threaded from the tool executor through
`ToolDispatchSuccess::provider_result_text` into the next round's request; it
is never persisted as raw event/frame bytes, so changing it cannot perturb a
fixture-pinned byte-identity oracle (see `crates/successor-kernel/src/runner.rs`,
`execute_tool` → `dispatch_tool_call` → `execute_turn`'s `round_text`).

## 7. Raw event / frame lifecycle

Every tool call emits its full raw-event sequence
(`tool_call.requested` → `tool_call.started` → `tool_result.recorded` →
`tool_call.completed`, or the `tool_call.rejected`/`error.recorded` pair on
failure) with correct causation/correlation IDs threading back to the
originating `provider_tool_call.observed` event. Frame sanitization/preview
limits (`PREVIEW_LIMITS`-shaped truncation) apply to every frame that renders
tool content to a UI. No tool addition or budget change may rename an event
type, a frame kind, or reorder the lifecycle to accommodate new behavior.

## 8. Projection contract tests

Every tool needs, at minimum:

1. a DTO/schema round-trip test (arguments deserialize the same shape the
   catalog schema publishes);
2. a catalog registration test (status/category is what's expected, rejection
   policy fires for the unsupported case);
3. a runner/provider-projection test proving that the round *after* a
   successful call receives the intended tool-result content — not a preview,
   not an artifact handle, not the unrelated original user text. This is a
   runner-level test (see
   `crates/successor-kernel/tests/item_b_provider_result_hydration.rs` for the
   canonical shape: a recording wrapper around `ScriptedProviderExecutor`
   asserting on the literal `round_text` argument), not a `tools/*.rs`-level
   test — the executor returning correct bytes does not prove the provider
   round receives them.

## 9. Fixture amendment protocol

Canonical fixtures (C7/D2 byte-identical raw-event/frame oracles) are pinned
law. Any change follows this order: (1) contract amendment first — the
durable law (`SLICE-0-CONTRACT.md`) states the new rule before code changes
it; (2) human/dissent acceptance for any change to durable law, not an
opportunistic in-flight rewrite; (3) if a change alters what an *existing*
fixture-pinned event/frame byte contains, stop and report the exact ripple
rather than silently regenerating the fixture or adding a byte normalizer.
Runtime-only values that never reach a raw event or frame (like §6's
`round_text`) are exempt from this protocol — they cannot perturb a
byte-identity oracle by construction.

A sovereign base-catalog amendment (contract §7.1/§7.2, e.g. promoting `ast_grep`/`edit`/`write`/`bash` to executable and moving the unsupported-tool oracle from `bash` to `ssh`) follows the same order: contract law changes first, then the fixture is amended in place — tool identity, idempotency keys, payload fields, ordering — never regenerated wholesale or replaced with a new fixture file. Only the fixture bytes predicted by the contract amendment may change; any wider diff is a signal the amendment's blast radius was under-scoped, not evidence to fix by re-running a generator.

## 10. Budget interactions

Three independent budgets interact and must not be conflated:

- **Per-turn max tool rounds**: `state_machine::MAX_EXECUTABLE_TOOL_ROUNDS`
  (currently 8, per `agent://256` item A). Enforced by a runner-owned counter
  in `execute_turn`, independent of `TurnPhase::round_index`/`next()` — the
  typed 3-phase state machine (`PreTool`/`PostLocator`/`PostRead`) still
  describes only the canonical fixture's distinguished rounds; rounds beyond
  `PostRead` reuse its assemble-phase/label mapping rather than requiring a
  fourth phase.
- **Per-tool output limits**: §8's `max_bytes`/`max_matches`/`max_entries`,
  enforced by each executor (or, for the read provider-projection bound, by
  the runner's `bound_provider_visible_text`).
- **Provider `max_tokens`**: `successor-cli`'s `DEFAULT_MAX_TOKENS` (currently
  32768, per `agent://256` item A), flowing through `AppState::with_anthropic`
  into `AnthropicProviderExecutor::new` and the Anthropic request body.

Raising the tool-round budget is never a substitute for fixing provider
projection (§6): a wider budget with preview-only projection just means more
rounds where the model still cannot see its own tool results. Exceeding the
live per-turn tool-call maximum emits `tool_call.rejected` and
`error.recorded` without changing event names or lifecycle semantics
(contract §9, as amended).

## 11. Auth and authority separation

Provider credentials (API keys, OAuth/subscription material, license tokens)
never enter platform artifacts, raw events, traces, fixtures, or
provider-visible tool results. Context-platform auth (entitlement tokens) is
a separate authority from provider auth (`ProviderSlot`/API keys) — a tool
executor must never need or see provider credentials, and a provider adapter
must never need or see platform entitlement tokens.

This section's "authority" (auth planes: platform entitlement vs. provider credentials) is a different axis from the tool authority classes in §1/contract §7.3 (`safe_read`/`workspace_mutation`/`local_process`, i.e. what a tool is allowed to *do*). A tool executor can be fully authorized to run (`workspace_mutation` or `local_process` granted) while still never touching either auth plane's credentials; conversely, holding a valid platform or provider auth token never grants tool authority by itself.

## 12. Live verification checklist

Before accepting a tool addition or amendment:

1. deterministic unit/contract tests pass (`cargo test -p successor-kernel`,
   `-p successor-protocol`, `-p successor-cli`,
   `-p successor-context-platform`);
2. `cargo clippy -p successor-kernel --all-targets` is clean for the changed
   files;
3. `cargo fmt --all --check` is clean;
4. a focused live smoke (real provider, real workspace) confirms the change
   in practice when the change affects provider-visible behavior — not
   required for pure-refactor changes with no behavioral surface;
5. captured provider request/response evidence (or a capturing/recording
   `ProviderExecutor` test double, per §8.3) demonstrates the exact content
   the provider receives;
6. clean working tree proof (`git status --porcelain`) showing only the
   intended files changed.

## 13. Authority obligations

Every tool registration declares one authority class (§1) and, where relevant, an availability predicate (e.g. `local_process` requires a nonempty trusted executable allowlist). A tool must never execute merely because its base-catalog status is executable; the effective catalog and the runtime dispatch path both re-check authority immediately before execution, so a forged or malformed provider request cannot bypass the check by omission. `workspace_mutation` and `local_process` are never granted by default; a tool author adding a new authority-bearing tool must add its authority class here and to the contract's effective-catalog table (contract §7.3), never leave it implicit in executor code.

## 14. Recoverable executor-error obligations

A tool executor that fails after dispatch (as opposed to failing catalog/schema/policy checks before dispatch) must return a structured, typed error rather than panicking or returning an untyped string. The runner persists that failure as `error.recorded` followed by the existing `tool_call.failed` raw event, in that order, and emits the existing `tool_call_completed` frame with an error-status payload (contract §9.1) — a tool author must never introduce a new event or frame name to represent a tool failure. When the failure is recoverable (the dominant case — e.g. a stale mutation precondition), the executor must supply provider-visible result text sufficient for the provider to repair on its next round; recoverable failures continue the turn, they do not fail it. Nonzero process exit and timeout from `bash` are not executor errors and must be represented as an ordinary successful receipt, never routed through this error path. If a tool's raw event or artifact cannot be durably persisted, the runner must stop the turn rather than let the tool author's code continue as if the fact were recorded.