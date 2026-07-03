# Lane A0 — WorkspaceBootstrap

## Model Binding

- Intended execution agent: `slice0-executor`
- Intended coding model: `anthropic/claude-sonnet-4-6`, `thinking-level=high`
- Resolved coding model evidence: durable `slice0-executor` discovery verified; permanent-label canary passed (`agent://19-PermanentExecutorCanary`)
- Reviewer model: `slice0-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://15-PermanentReviewerCanary`)
- Superego model: `slice0-superego-reviewer` / `openai-codex/gpt-5.5`, `thinking-level=high`; canary passed (`agent://16-PermanentSuperegoReviewerCanary`)
- Binding verdict: verified

## Aim

- Outcome: create the Rust workspace/crate skeleton and dependency direction for Slice 0 successor-agent-kernel.
- Contract clause(s) served: workspace bootstrap; dependency direction gate.
- Fixture(s) served: none directly; unblocks fixture-bearing protocol lanes.
- Files owned:
  - `Cargo.toml`
  - `crates/successor-protocol/Cargo.toml`
  - `crates/successor-context-platform/Cargo.toml`
  - `crates/successor-kernel/Cargo.toml`
  - `crates/successor-cli/Cargo.toml`
- Explicit non-goals: no protocol DTO implementation; no platform/kernel runtime logic; no fixture semantics.

## Problem Space

- Current state: workspace skeleton may be absent or incomplete.
- Constraints: no circular successor-crate dependencies; protocol crate depends on no successor crate.
- Named risks: dependency shortcut that leaks platform/kernel concerns into protocol.
- Edge cases: later lanes must be able to compile against crate names.
- Interface dependencies: dispatch map dependency-direction gate.
- Authority boundaries: A0 owns workspace manifests only.

## Solution Space

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| Minimal manifests only | fastest unblock | later lanes fill modules | selected |
| Implement modules too | fewer follow-up edits | violates lane ownership | outside A0 scope |

Selected approach: minimal workspace/crate manifests with allowed dependency direction only.

Invalidated if: any successor crate dependency cycle appears.

Stop/pivot if: crate layout conflicts with existing repo architecture.

## Dissent

Verdict: not needed for prep stub

If skipped, rationale: lane has not executed.

## Execute

Checklist:
- [x] owned files only plus approved bootstrap ownership expansion for mandatory Cargo target stubs
- [x] shared interfaces imported from owner crate where applicable
- [x] no forbidden shortcuts
- [x] target files added only as empty crate skeletons; no protocol/platform/kernel/CLI logic implemented
- [x] targeted validation passed
- [x] named risks retired or routed (`pi-natives` workspace inheritance preserved by restoring original workspace glob/exclude)
- [x] model binding verified for execution agent

Changed files:
- `Cargo.toml` — original `members = ["crates/*"]` and vendored-crate `exclude` list preserved, so existing workspace members such as `crates/pi-natives` keep workspace inheritance; successor crates join through the pre-existing glob.
- `crates/successor-protocol/Cargo.toml` — created; lib target; no successor deps.
- `crates/successor-context-platform/Cargo.toml` — created; lib target; depends on `successor-protocol` (path).
- `crates/successor-kernel/Cargo.toml` — created; lib target; depends only on `successor-protocol` (path), matching the A0 dependency gate.
- `crates/successor-cli/Cargo.toml` — created; `[[bin]]` target `successor-cli`; depends only on `successor-protocol` (path), matching the A0 dependency gate until a later split client DTO crate exists.
- `crates/successor-protocol/src/lib.rs` — minimal crate target stub only, added because Cargo requires target source files during manifest loading.
- `crates/successor-context-platform/src/lib.rs` — minimal crate target stub only.
- `crates/successor-kernel/src/lib.rs` — minimal crate target stub only.
- `crates/successor-cli/src/main.rs` — minimal binary target stub only.
- `Cargo.lock` — generated workspace lockfile update adding the four successor packages with the corrected A0 dependency graph; kept and documented because root workspace lockfiles are durable workspace-bootstrap artifacts.

Validation evidence:
- Command: `cargo metadata --no-deps --manifest-path Cargo.toml --format-version 1`
- Result: **PASS**.
- Workspace members observed: existing `pi-natives` plus the four successor crates. Vendored brush crates remain excluded and patched by path.
- Dependency direction confirmed by manifest inspection and metadata output: `successor-protocol` has no successor deps; `successor-context-platform` depends only on `successor-protocol`; `successor-kernel` depends only on `successor-protocol`; `successor-cli` depends only on `successor-protocol`. No cycles. No crate depends on `successor-cli`.

## Code Review

Reviewer: `slice0-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **PASS** (`overall_correctness=correct`) after correction; final review `agent://25-A0CodeReviewRerun`.

Findings:
- First review (`agent://23-A0CodeReview`) found unauthorized dependencies from `successor-kernel` to `successor-context-platform` and from `successor-cli` to platform/kernel crates.
- Rerun review found no remaining findings.

Fixes applied:
- Removed the unauthorized dependencies from `crates/successor-kernel/Cargo.toml` and `crates/successor-cli/Cargo.toml`; reran metadata successfully.

## Drift Review

Original aim: create the Rust workspace/crate skeleton and dependency direction for Slice 0 successor-agent-kernel.
Current work: workspace/crate manifests, generated lockfile entries, and mandatory no-op target stubs were created; no protocol/platform/kernel/CLI logic was implemented.
Gap: minor bootstrap expansion only; target stubs and lockfile are required for Cargo metadata/loadability.
Verdict: **minor drift accepted** (`agent://21-A0DriftReview`)
Authority boundary: clear after documenting target-stub and lockfile ownership expansion.

## Superego Review

Reviewer: `slice0-superego-reviewer`
Reviewer model: `openai-codex/gpt-5.5`, `thinking-level=high`
Verdict: **ALLOW** after correction; final review `agent://26-A0SuperegoReviewRerun`.

Frame risks:
- First Superego review (`agent://22-A0SuperegoReview`) found an evidence/ownership gap: `Cargo.lock` changed but was not recorded.
- Rerun found frame integrity holds; no hidden durable implementation decision remains.

Required corrections:
- `Cargo.lock` is now recorded as a generated durable workspace-bootstrap artifact and included in validation evidence.

## Delivery

Status: **accepted**
Residual risks:
- A0 used an approved bootstrap ownership expansion for minimal `src/lib.rs` / `src/main.rs` target stubs. Later lanes may replace/extend those stubs within their owned modules.
- The root workspace still uses the pre-existing `crates/*` member glob. This preserves existing `pi-natives` behavior but means any future crate directly under `crates/` becomes a workspace member unless excluded.
Human verification needed: none for A0; proceed to A1.