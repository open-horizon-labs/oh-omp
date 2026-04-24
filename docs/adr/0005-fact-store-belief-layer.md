# ADR 0005: Fact Store Belief Layer

- Status: Proposed
- Date: 2026-04-24
- Decision makers: Harness maintainers
- Depends on: ADR 0003 (tiered memory + assembler), ADR 0004 (tool-result-to-memory bridge)

## Context

oh-omp has two adjacent continuity systems:

- **Recall** stores evidence-shaped snippets for similar past context.
- **Memory artifacts** synthesize guidance, workflows, lessons, and locator-backed context.

Neither is designed to answer “what current scoped facts should the assistant believe?” Users still need to restate durable preferences, project decisions, owners, dates, and corrections across sessions.

A Fact Store introduces a third tier: a small, local belief database for normalized assertions with provenance and correction semantics. The dissent on this decision found that the direction is right, but the first slice must be conservative enough to avoid trust, privacy, and ontology debt.

## Decision

Introduce a dedicated `facts` module, but constrain the first implementation slice to **manual collection only**.

The initial Fact Store is:

1. Separate from recall and memory.
2. Local to the agent data directory.
3. Backed by SQLite.
4. Allowlisted by fact kind, not arbitrary ontology predicates.
5. Resolver-on-read, with no materialized `fact_current` table yet.
6. Explicit about privacy deletion vs belief retraction.
7. Safe for bounded prompt injection, but not automatically wired into assembly until the injection behavior is proven.

## First-Slice Scope

### Collection

Allowed in the first slice:

- CLI/manual add.
- In-session `/facts add`.
- Explicit “remember that …” can be mapped to manual add in a later slice.

Not allowed in the first slice:

- Autonomous extraction.
- Auto-promotion from `.oh/*.md` files.
- Auto-promotion from assistant-authored plans.
- Auto-extraction of personal or sensitive facts.

### Fact kinds

The first slice uses a small allowlist:

- `user_preference`
- `project_decision`
- `project_constraint`
- `date_deadline`
- `ownership`
- `environment_tooling`

Each fact still stores `subject`, `predicate`, and JSON `object`, but `kind` is the primary contract. Arbitrary predicates are allowed only inside an allowlisted kind and can be tightened later once dogfood data shows repeated patterns.

### Privacy and deletion

The store distinguishes two operations:

- **Retract**: marks an assertion as no longer active while preserving history and explanation.
- **Erase**: redacts object, canonical text, evidence, supersession, and tags for privacy. It is the operation users need when “forget” means payload removal.

Secret facts are rejected by the manual path. Sensitive facts require a future explicit-consent flow and are not injected by default.

### Resolution

The first slice resolves on read:

- `active` facts are candidates.
- `retracted`, `erased`, `superseded`, `expired`, and `disputed` facts are omitted from active results by default.
- Expired facts are omitted unless history is requested.
- Source authority and recency are used to select one active assertion for the same subject/predicate/scope.
- Current user instructions, repo state, runtime output, and explicit corrections still outrank stored facts.

No `fact_current` table is created until resolver rules stabilize.

### Prompt injection

The module may format a `<known-facts>` block, but assembly wiring must stay bounded and separately reviewed:

- Max fact count.
- Max character budget.
- Omission reasons for debug traces.
- No `secret` or `sensitive` facts.
- No `personal` facts unless explicitly allowed.
- A precedence note that current user/repo/runtime evidence outranks stored facts.

The Fact Store supplies scoped beliefs. It does not become a second context manager.

## Consequences

### Positive

- Preserves clean boundaries: recall is evidence, memory is guidance, facts are beliefs.
- Gives users inspectable and correctable continuity.
- Keeps autonomous extraction out until trust is proven.
- Avoids early schema debt from a large ontology or graph model.
- Keeps assembler cutover constraints intact.

### Negative

- Manual-first collection means slower initial accumulation.
- Resolver-on-read may need optimization later.
- Users must learn another visible continuity surface.
- The allowlist may reject useful facts until the schema evolves.

## Implementation Notes

Initial files live under:

```text
packages/coding-agent/src/facts/
├── index.ts
├── prompt-format.ts
├── resolver.ts
├── schema.ts
└── storage.ts
```

Manual command surfaces:

- `oh-omp facts add ...`
- `oh-omp facts view`
- `oh-omp facts search ...`
- `oh-omp facts explain ...`
- `oh-omp facts retract ...`
- `oh-omp facts erase ...`
- `/facts ...` delegates to the same command logic in interactive mode.

## Open Questions

- When should explicit natural-language “remember that …” become a structured manual add flow?
- What consent UX is acceptable for personal facts?
- When is it safe to add candidate extraction and review?
- Which predicates recur often enough to become a stricter schema?
