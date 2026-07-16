# ADR 0007: Standalone Successor Repository and Port Ownership

- Status: Accepted
- Date: 2026-07-16
- Decision makers: Harness maintainers
- Depends on: ADR 0005 (clean-sheet runtime direction)
- Qualifies: ADR 0003 and ADR 0004 for successor integration; those ADRs remain authoritative for the oh-omp assembler implementation

## Context

ADR 0005 accepted a clean-sheet runtime direction alongside the constrained oh-omp fork. The successor has since proven a replayable vertical coding loop with durable events, provider normalization, tool authority, safe reads, workspace mutation, bounded process execution, live frames, restart/resume, and black-box context-platform integration.

Wave 1 closed that baseline at commit `dfbe6de9b7`. The implementation is now structurally close to an independent product, but it still lives inside the oh-omp monorepo and inherits monorepo workspace metadata. Its current `KernelPlatformClient` also combines two conceptually different responsibilities behind one HTTP client:

- durable storage and replay of canonical agent events;
- context intake, retrieval, assembly, and trace production.

Leaving those responsibilities implicit would let current deployment topology become accidental product ownership. Copying the implementation into another repository would create dual authority. Combining repository extraction with a runtime refactor would make behavior drift difficult to distinguish from migration defects.

Wave 2 therefore freezes three one-way-door decisions before any physical extraction:

1. the standalone product and repository boundary;
2. semantic ownership of the logical `AgentJournal` and `ContextAssembler` ports;
3. the history-preserving, single-authority extraction and rollback method.

Wave 2 changes architecture records only. It does not refactor the current runtime, change protocol bytes, move files, or create a destination repository.

## Decision

### 1. Product and Repository Aim

The successor is a **headless, replayable agentic execution kernel** that can use journal, context, provider, and tool implementations through explicit contracts.

Its product responsibilities are:

- command/session/turn lifecycle;
- canonical agent-event meaning and replay;
- provider projection and normalization;
- tool catalog, authority, dispatch, mutation, and bounded process semantics;
- live frame emission and durable/live reconciliation;
- cancellation, idempotency, and crash-boundary rules as those capabilities are added.

It is not:

- a TUI or web UI;
- an embeddings, intake, retrieval, or knowledge-graph product;
- a permanent context-platform service implementation;
- an oh-omp compatibility layer or feature-parity rewrite.

The initial standalone repository will contain one Rust workspace with:

- `successor-protocol`;
- `successor-kernel`;
- `successor-cli`;
- `successor-context-platform` as reference/integration scaffolding;
- canonical fixtures and black-box tests;
- independently owned root workspace metadata, lint policy, CI, and committed `Cargo.lock`;
- ADR 0007 and the architecture decisions required to interpret it;
- selected, tracked workstream evidence required to audit the extraction.

Workspace membership does not imply permanent product-service ownership. In particular, `successor-context-platform` is included initially to preserve black-box proofs and avoid a repository move plus service decomposition in one change.

The destination remote URL, repository slug, default branch, and old-source pointer format are Wave 3 inventory outputs. Wave 4 may not begin until they are recorded and approved.

### 2. Two Logical Ports, Independent of Transport

The successor recognizes two distinct logical ports:

```text
AgentJournal
ContextAssembler
```

A single process, database, HTTP base URL, or client struct may implement both ports. Operational co-location does not merge their contracts or transfer semantic ownership.

The current combined `KernelPlatformClient` is an implementation artifact, not the conceptual boundary. A later port split must preserve accepted black-box behavior and protocol compatibility.

### 3. `AgentJournal` Ownership

The kernel owns the **meaning** of the agent journal:

- canonical agent-event ontology and payload semantics;
- legal lifecycle state transitions and terminal states;
- identity, causation, correlation, and visibility rules;
- provider/tool/authority event meaning;
- replay interpretation and reducer behavior;
- when a kernel decision must become durable;
- validation that committed event order is legal.

An `AgentJournal` adapter or platform implementation owns durable mechanics:

- append storage and transactional durability;
- monotonic per-session `session_seq` assignment;
- `stored_at` assignment;
- duplicate/idempotency/conflict outcomes;
- pagination, reads, and snapshot transport;
- artifact byte custody and retrieval;
- storage-engine recovery.

These authorities are complementary, not interchangeable. The kernel must not fabricate durable sequence numbers. The platform must not decide whether an event transition is legal merely because it can append bytes. Replay consumes platform-assigned sequence and validates it against kernel-owned lifecycle rules.

A kernel-owned external-operation decision must be durably represented before, or atomically with, invoking that operation when replay correctness depends on the decision. For context assembly, the final port contract requires the assembly request decision to be journaled before or atomically with `ContextAssembler` execution.

### 4. `ContextAssembler` Ownership

The context platform owns context implementation and explanation semantics behind `ContextAssembler`:

- source declarations and intake envelopes;
- retrieval and read-model projections;
- ranking and freshness policy;
- required-source resolution;
- token/byte budgeting and deterministic selection;
- degradation and source kill switches;
- context item provenance;
- assembly trace identity, content, persistence, and recovery;
- deterministic replay/rebuild operations when explicitly supported.

The kernel owns the caller side of the contract:

- when an assembly is requested;
- the caller-supplied phase, required-source, workspace, query, and budget inputs;
- validation of the structured response;
- provider request projection from accepted context items;
- recording which context item IDs influenced each provider request;
- turn progression, tool authority, provider API shape, and live frames.

`ContextAssembler` returns structured context items, trace, policy, and degradation information. It must not:

- emit provider messages;
- advance turn state;
- approve or execute tools;
- own provider normalization;
- own UI/live-frame projection;
- reinterpret canonical agent events.

The assembler owns assembly trace identity. Kernel journal events may reference the returned `assemble_id` and assembler trace ID, but the kernel must not mint a competing identity and present it as the assembly explanation.

### 5. No Second Context Path

All retrieved, ranked, summarized, historical, policy-filtered, or budgeted context must enter a provider request through `ContextAssembler` output. The kernel must not grow a second semantic assembler through:

- direct retrieval or ranking;
- transcript parsing as memory;
- prompt-memory fallback;
- local summarization that bypasses assembler provenance;
- untracked context hydration.

One narrow path is not an assembler bypass: the kernel may send the just-produced tool result through the provider protocol's required tool-result continuation mechanism. That payload is current lifecycle evidence, not retrieved context.

Provider-request evidence must distinguish:

- context item IDs supplied by `ContextAssembler`;
- tool-result payloads carried as provider-protocol continuation.

Additional context beyond that immediate continuation must come through `ContextAssembler`.

### 6. Replay and Missing Assembly Explanations

Agent replay is grounded in `AgentJournal`. If an assembly trace is unavailable after restart, replay may continue only with an explicit unavailable/degraded explanation state.

The kernel must not silently reassemble historical context or imply that a newly generated trace explains an old provider request. Reassembly or trace rebuilding is valid only through a deterministic `ContextAssembler` replay/rebuild operation whose invocation and result are recorded.

### 7. Reference Context Platform

`successor-context-platform` moves with the initial standalone workspace only as:

- a reference adapter for `AgentJournal` and `ContextAssembler`;
- the substrate for deterministic integration and black-box tests;
- a local development implementation.

It is not a declaration that the kernel repository permanently owns the context/intake product. A future remote platform may replace it without changing kernel event semantics or provider/tool lifecycle behavior.

Later extraction or replacement of the reference platform requires:

- stable logical port contracts;
- relocated black-box proof ownership;
- no loss of canonical fixtures or replay evidence;
- one implementation authority at every point in the transition.

### 8. Known Current Non-Conformance

This ADR freezes the target contract; it does not falsely declare the Wave 1 implementation fully conformant.

| Current behavior | Target invariant | Disposition |
|---|---|---|
| Kernel and reference assembler mint different trace identifiers. | `ContextAssembler` owns assembly trace identity; journal events reference returned identities. | Wave 5 port-correctness debt. |
| Current runner invokes assembly before appending `assembly.requested`, then appends requested/completed markers after the response. | Assembly intent is durable before, or atomic with, external assembly execution. | Wave 5 port-correctness debt. |
| Assembly trace cache is in-process and not durable across restart. | Assembler owns durable trace recovery; unavailable history is explicitly degraded. | Wave 5 provenance/port-correctness debt. |
| `KernelPlatformClient` combines journal and assembler methods. | Two logical ports remain distinct regardless of transport co-location. | Wave 5 refactor, preserving black-box behavior. |
| Same-turn tool results use provider-protocol continuation while assembled context is projected separately. | Immediate continuation is allowed, but provenance must distinguish it from assembled context. | Preserve behavior; strengthen evidence in Wave 5. |

No Wave 2 commit may claim to close these correctness debts. They close only when their firing proofs and black-box gates pass in the owning later wave.

### 9. Standalone Workspace Contract

The new repository owns its root workspace contract. The current oh-omp root metadata is evidence, not authority.

The standalone root must define and test:

- exact workspace members and exclusions;
- workspace package version, edition, license, authors, and repository identity;
- workspace lint policy;
- build/test profiles needed by successor crates;
- dependency and patch policy with no unresolved monorepo-local paths;
- committed `Cargo.lock`, because the workspace ships binaries;
- CI commands and supported toolchain;
- release/versioning policy.

Wave 3 must create a reviewed, tracked extraction scaffold for this root contract before the cut commit. The filter operation may path-rename that scaffold into the destination root. The current monorepo `Cargo.toml` must not be copied as the destination authority, and destination metadata must not be generated ad hoc after the cut.

The standalone candidate must build and test without non-successor local production dependencies, missing path patches, unresolved workspace inheritance, or hidden monorepo metadata.

### 10. Canonical Evidence Boundary

History preservation applies only to tracked bytes.

Wave 3 must inventory exact source paths for:

- the four successor crates;
- canonical fixtures and black-box proofs;
- standalone root workspace and CI scaffold;
- `Cargo.lock` policy and artifact;
- ADR 0007 and required predecessor decisions;
- selected workstream closure evidence;
- old-source pointer/tombstone content.

Ignored or untracked workstream files are non-canonical unless they are deliberately converted into reviewed, tracked, immutable evidence before the pinned cut commit. Local orchestration journals may remain local and must not be represented as history-preserved artifacts.

Protocol fixtures, event fixtures, and black-box proofs have one mutable authority. No duplicate fixture set may remain active in the old repository after cutover.

### 11. History-Preserving Extraction Method

The physical extraction will use a one-time, path-filtered `git filter-repo` operation from a pinned Wave 3 cut commit.

The extraction may select and path-rename multiple reviewed source paths into the standalone layout. It must preserve relevant file history even though destination commit IDs are necessarily rewritten.

The extraction is not a synchronization mechanism. The following are prohibited as authority models:

- copy-and-squash import;
- recurring directory copy;
- bidirectional mirroring;
- subtree-sync workflow;
- submodule-based dual development;
- continuing normal successor development in the old monorepo after authority flips.

Wave 3 performs the exact filter in an isolated rehearsal and records:

- source cut commit;
- filter command/configuration;
- source-to-destination path map;
- rewritten destination candidate commit;
- independent build/test results;
- artifact/fixture/evidence inventory;
- destination remote/branch and source-pointer plan.

Wave 4 repeats the accepted method for the real authority transfer. It must not combine extraction with behavioral refactoring.

### 12. Single-Authority Cutover

The cutover is a controlled authority state machine:

1. **Source authoritative:** successor changes land only in the monorepo.
2. **Freeze:** pin the cut commit; prohibit behavior changes in both source and destination candidate.
3. **Candidate:** generate the filtered destination, apply only the rehearsed layout/metadata transformation, and keep it non-authoritative and read-only.
4. **Verify:** run the accepted standalone checks and compare black-box evidence.
5. **Retire source:** land the reviewed old-source pointer/tombstone change that removes the old implementation and active fixtures from normal development.
6. **Flip authority:** record exact source-retirement and destination commits; designate the destination as the sole mutable authority.
7. **Unfreeze destination:** subsequent successor work lands only in the standalone repository.

Creating or pushing a verified candidate does not itself transfer authority.

If the source pointer/tombstone cannot land, authority does not flip. The destination candidate remains parked read-only or is discarded. The source remains the sole mutable authority.

Emergency-fix rule:

- before authority flip, a required fix lands only in the source, invalidates the candidate, and forces a new pinned cut and rehearsal result;
- after authority flip, a required fix lands only in the destination;
- rollback first freezes/decommissions the current authority, then explicitly transfers authority; it never makes both repositories mutable.

Cross-repository atomicity is achieved through freeze plus an explicit authority record, not by pretending two Git commits can be transactional.

### 13. Wave Responsibilities and Stop Conditions

#### Wave 2 — Boundary Freeze

Wave 2 closes only when:

- this ADR maps every canonical acceptance criterion;
- architecture review finds no unresolved ownership contradiction;
- drift review confirms no capability or implementation expansion;
- Superego returns `ALLOW`;
- owner acceptance is explicit.

#### Wave 3 — Extraction Rehearsal

Wave 3 owns exact inventory and rehearsal. It must stop before Wave 4 if any of the following remains true:

- destination remote/branch or source-pointer format is undecided;
- root workspace/CI/lockfile scaffold is not tracked and reviewed;
- a successor crate retains an unresolved local dependency outside the boundary;
- canonical evidence exists only in ignored or untracked files;
- the filtered candidate cannot pass independent checks;
- fixture or protocol authority would remain duplicated;
- the cutover/rollback commands are not reproducible from recorded inputs.

#### Wave 4 — Physical Extraction

Wave 4 performs only the rehearsed history-preserving move, verification, source retirement, and authority flip. It does not refactor ports or fix runtime correctness debt.

#### Wave 5 — Port and Provenance Correctness

Wave 5 may implement the target logical port split and close the known trace, ordering, provenance, and recovery debts, subject to behavior-preserving black-box gates.

## Options Considered

### Keep successor in the oh-omp monorepo

Rejected. It preserves root metadata convenience but keeps the clean-sheet product inside the upstream-sync collision zone and leaves product ownership ambiguous.

### Copy or squash the successor directories into a new repository

Rejected. It discards useful provenance and creates a high risk of two plausible mutable implementations.

### Use recurring subtree splits, submodules, or mirrors

Rejected. These are synchronization topologies, not a one-time authority transfer, and they invite dual fixture/protocol ownership.

### Split protocol, kernel, CLI, and context platform into separate repositories now

Rejected. The contracts are still moving, and current black-box tests depend on coordinated local changes. Premature splitting would replace compile-time coordination with release choreography.

### Extract only protocol, kernel, and CLI

Rejected for the initial move. Leaving the reference platform behind would break the current black-box proof substrate and combine repository extraction with service decomposition.

### Treat the combined platform HTTP client as one conceptual port

Rejected. Durable journal mechanics and context assembly have different semantic owners even when deployed together.

### Refactor ports during physical extraction

Rejected. Migration and behavior changes require different evidence. The extraction must prove the same accepted system in a new authority location before port cleanup begins.

## Consequences

### Positive

- The successor gains a repository boundary aligned with its product aim.
- Agent lifecycle meaning cannot accidentally migrate into the context platform.
- Context retrieval can evolve independently without creating a second kernel memory path.
- The reference platform preserves current integration evidence without becoming permanent product ownership.
- History and canonical fixtures move through one reproducible extraction method.
- Cutover and emergency fixes preserve one mutable implementation.
- Known Wave 1 correctness debt is explicit and assigned rather than hidden by migration language.

### Negative

- Initial extraction keeps a reference platform crate in the kernel repository even though it is not permanent product scope.
- `git filter-repo` rewrites destination commit IDs and requires an auditable source/destination map.
- Wave 3 must create and review standalone root metadata before extraction.
- The freeze and source-retirement sequence temporarily pauses successor feature work.
- Later separation of the reference platform requires another governed move after ports stabilize.

## Guardrails

- One mutable successor implementation, protocol fixture set, and black-box proof authority at all times.
- No runtime or protocol refactor in Wave 2 or Wave 4.
- No physical extraction before independent Wave 3 rehearsal passes.
- No direct-provider, tool, UI, retrieval, or other capability expansion under this ADR.
- No in-kernel semantic context assembler or untracked context hydration path.
- No competing kernel-minted assembly trace identity.
- No silent historical reassembly when the original explanation is unavailable.
- No destination authority while the old source remains an active development location.
- No claim that Wave 2 closes Wave 5 trace, ordering, provenance, or recovery debt.

## Verification Requirements

Before this ADR becomes Accepted:

1. Map every Wave 2 acceptance criterion to a decision or guardrail above.
2. Verify the ownership model against the implemented runner, platform client, and reference assembler.
3. Verify extraction assumptions against all four crate manifests and root workspace inheritance.
4. Obtain independent port-ownership and extraction-authority dissent.
5. Resolve every material dissent finding in this text or explicitly block acceptance.
6. Obtain drift review confirming documentation-only scope.
7. Obtain Superego `ALLOW` with no unresolved ownership contradiction.
8. Record owner acceptance.

## References

- ADR 0003: Tiered Memory and Locator Map
- ADR 0004: Tool Result to Context Assembly Bridge
- ADR 0005: Clean-Sheet Mech Suit Runtime
- `.oh/workstreams/successor-agent-kernel/FRAME.md`
- `.oh/workstreams/successor-agent-kernel/STANDALONE-KERNEL-WAVE-MAP.md`
- `.oh/workstreams/successor-agent-kernel/PARALLEL-WAVE-PROTOCOL.md`
- `crates/successor-kernel/src/runner.rs`
- `crates/successor-kernel/src/platform_client.rs`
- `crates/successor-context-platform/src/assembly.rs`
- Wave 1 closure commit `dfbe6de9b7`
