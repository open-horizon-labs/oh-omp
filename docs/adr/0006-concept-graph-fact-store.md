# ADR 0006: Concept Graph Seed Slice for Durable Project Facts

- Status: Proposed
- Date: 2026-05-26
- Decision makers: Harness maintainers
- Depends on: ADR 0002 (RPC compatibility), ADR 0003 (tiered memory + locator-first assembly), ADR 0004 (tool-result-to-memory bridge)

## Context

oh-omp agents currently reconstruct project understanding from recent conversation, code/repository search, tool results, and ad hoc user reminders. This is insufficient for long-running project work where correctness depends on durable conceptual knowledge: project intent, definitions, decisions, constraints, ownership, assumptions, and relationships between those facts.

The desired behavior change is that users can continue across long oh-omp sessions without repeatedly restating project intent, concepts, decisions, constraints, or ownership because the agent already carries the project's conceptual facts forward.

Prior Fact Store work established the correct boundary: recall is evidence retrieval, memory artifacts are synthesized guidance/candidates, and facts are maintained beliefs. The new requirement sharpens that design: links between facts are not optional metadata; linkage is the product. The system must behave like a concept-first fact graph, not a code graph or a transcript archive.

This decision introduces a durable belief graph and a bounded context-assembly input. It is therefore a one-way-door architecture decision that must preserve:

- ADR 0002 RPC/SSE/event compatibility,
- ADR 0003 tier separation, locator-first assembly, bounded injection, inspectable provenance, and a single active context manager,
- ADR 0004's boundary that input producers observe and produce context artifacts; the assembler alone decides what enters the prompt.

## Decision

We will implement a narrow **Concept Graph Seed Slice** before any broader knowledge graph platform.

The Concept Graph Seed Slice is a local, concept-first graph of durable project facts and typed fact-to-fact links. It is maintained mostly by the LLM through internal tools, seeded from `.oh` session artifacts, and injected into context from day one in tiny capped blocks through the existing assembler.

The graph is:

- **concept-first** — code paths and symbols may be evidence, but are not the primary ontology;
- **owned and provenance-rich** — every fact/link has evidence, authority status, lifecycle, and source locator;
- **candidate-friendly but authority-conservative** — LLMs may propose/update/link/merge/retire candidates, but promotion to active authority is gated;
- **link-first** — typed links between facts are first-class records;
- **inspectable from day one** — every injected fact/link can be explained, corrected, disputed, retired, or traced to evidence;
- **bounded in prompt assembly** — resolver output is tiny, capped, and routed through the single assembler.

## Data Model

The v1 graph has six record families.

### `Concept`

Canonical project entities/ideas that facts refer to.

Required fields:

- `id`
- `kind`: `project | system | feature | architecture | workflow | policy | role | term | artifact`
- `canonicalName`
- `canonicalKey`
- `aliases`
- `description`
- `scope`
- `status`: `candidate | active | merged | retired`
- `mergedIntoConceptId`
- `createdAt`
- `updatedAt`

Concept identity primitives are v1 requirements. Stable IDs, canonical keys, aliases, merge/supersede behavior, and duplicate detection are not deferred because duplicate concepts fragment graph retrieval.

### `ConceptFact`

A durable or candidate claim about project concepts.

Required fields:

- `id`
- `kind`: `definition | decision | constraint | assumption | goal | mechanism | ownership | workflow_convention | architecture_boundary | open_question | risk | success_signal`
- `subjectConceptId`
- `claim`
- `normalizedClaim`
- `scope`
- `status`: `candidate | active | disputed | stale | superseded | retired | erased`
- `authority`: `llm_inferred | session_artifact | current_session_artifact | adr | guardrail | outcome | user_confirmed | system_policy`
- `confidence`: `low | medium | high`
- `sensitivity`: `public | project | private | sensitive`
- `ownerRef`
- `validFrom`
- `validUntil`
- `supersededByFactId`
- `createdAt`
- `updatedAt`

### `ConceptLink`

A typed relationship between two facts. Links are the graph and must be first-class.

Required fields:

- `id`
- `fromFactId`
- `toFactId`
- `kind`: `supports | contradicts | supersedes | depends_on | scoped_by | owned_by | evidenced_by`
- `status`: `candidate | active | disputed | retired`
- `confidence`: `low | medium | high`
- `rationale`
- `evidenceIds`
- `createdAt`
- `updatedAt`

The v1 schema intentionally excludes `related_to`. If a relationship cannot be expressed as one of the allowlisted link kinds, it is not stored as a link.

### `ConceptEvidence`

Evidence supports facts and links but is not itself truth.

Required fields:

- `id`
- `sourceType`: `oh_session | adr | guardrail | outcome | user_turn | repo_file | tool_result | manual_note`
- `sourceUri`
- `locator`
- `quote`
- `summary`
- `extractedBy`: `llm | deterministic_parser | user | system`
- `extractedAt`

For `.oh` files, section-level locators are sufficient for v1, e.g. `.oh/conceptual-fact-store.md#Dissent`. More precise anchors may be added later.

### `ConceptFactEvidence`

Many-to-many evidence relation.

Required fields:

- `factId`
- `evidenceId`
- `role`: `source | supporting | conflicting | superseding`

### `ConceptGraphEvent`

Append-only graph event log for provenance, debugging, and trust.

Required fields:

- `id`
- `kind`: `concept_proposed | concept_merged | fact_proposed | fact_updated | fact_promoted | fact_disputed | fact_superseded | fact_retired | fact_erased | link_proposed | link_promoted | link_retired`
- `targetId`
- `actor`: `llm | user | system`
- `activity`
- `rationale`
- `evidenceIds`
- `createdAt`

This mirrors PROV-style separation between entity, activity, and agent without requiring PROV-O runtime infrastructure.

## Authority and Lifecycle Policy

Candidate creation and authority are separate.

The LLM may autonomously create and maintain candidate concepts, facts, links, aliases, merge proposals, supersession proposals, and dispute markers.

Promotion to active authority requires an allowed authority source for the fact kind:

| Source | Candidate creation | Active promotion |
|---|---:|---:|
| LLM inference from arbitrary session | yes | no, except low-risk repeated evidence by policy |
| Historical `.oh` session artifact | yes | usually no by itself |
| Current `.oh` session artifact | yes | yes for accepted decisions/defaults |
| ADR | yes | yes |
| Guardrail/outcome artifact | yes | yes if explicitly normative/current |
| Explicit user confirmation/correction | yes | yes |
| System policy | yes | yes |

Resolver precedence:

1. current user instruction/correction,
2. system/developer constraints,
3. ADR / guardrail / explicit policy,
4. current `.oh` session accepted decisions,
5. user-confirmed facts,
6. prior `.oh` session accepted decisions,
7. candidates from `.oh` sessions,
8. LLM-inferred candidates.

Current repository/file/runtime evidence outranks stale graph claims for implementation-state questions.

Lifecycle meanings:

- `candidate`: proposed, not authoritative;
- `active`: eligible for context injection as a fact;
- `disputed`: known conflict; must not be injected as settled truth;
- `stale`: probably outdated; may influence retrieval but not authority;
- `superseded`: replaced by a newer fact;
- `retired`: no longer relevant, preserved for history;
- `erased`: removed/redacted for privacy or policy.

Retire/supersede preserves audit history. Erase is reserved for privacy/policy deletion.

## Seeding Policy

The first pass seeds graph candidates from all `.oh` markdown session artifacts and authoritative project artifacts.

Seeder stages:

1. Inventory `.oh/**/*.md` and ADR files.
2. Parse markdown into bounded sections.
3. Classify section type and likely authority.
4. Ask the LLM/extractor for graph patches: concepts, facts, links, aliases, merge candidates, conflicts, supersessions, ignored items.
5. Require evidence for every proposed fact and link.
6. Deduplicate concepts using canonical keys, aliases, and merge candidates.
7. Run conflict/supersession pass.
8. Promote only facts/links that satisfy authority rules.
9. Emit a seed report with counts, conflicts, supersessions, duplicates, promoted facts, and unresolved candidates.

High-value seed sections include:

- `## Aim`
- `## Problem Space`
- `## Solution Space`
- `## Dissent`
- `## Recommendation`
- `## Decision`
- `## Guardrails`
- `## Accepted Defaults`
- `## Constraints`
- `## Implementation Notes`
- `## Salvage` / learnings

Execution logs, command output, temporary debugging notes, and implementation checklists are evidence at most; they are not durable facts by default.

## LLM Tool Substrate

The concept graph is an internal tool substrate for the LLM, not a user-facing graph management product.

Initial internal tool capabilities:

- `kg.search`
- `kg.explain_fact`
- `kg.explain_concept`
- `kg.show_conflicts`
- `kg.show_recent_changes`
- `kg.propose_fact`
- `kg.propose_link`
- `kg.update_candidate`
- `kg.merge_candidates`
- `kg.retire_candidate`
- `kg.mark_disputed`
- `kg.correct_fact`

Safe autonomous tools operate on the candidate graph. Promotion and active injection are gated by resolver/policy checks.

There must be no mandatory user review queue. Background candidate updates are observable to the system through event logs and inspect/explain surfaces, but the user is only interrupted for high-impact uncertainty, conflicts, or corrections at the moment they matter.

## Context Assembly Policy

The concept graph is one bounded input to the existing assembler. It must not become a second context manager.

Once the seed slice exists, dogfood injection begins from day one:

- resolver selects a tiny graph neighborhood relevant to the current task,
- output goes through the single assembler,
- injected facts/links include provenance handles, authority status, lifecycle, and correction affordances,
- current user instructions and current repository/runtime evidence outrank graph facts,
- disputed/stale/candidate facts are not injected as settled truth.

Initial injection caps:

- max facts: 6,
- max links: 6,
- max traversal depth: 1,
- max concept graph context: 800-1200 tokens,
- candidates: only conflicts or relevant uncertainty unless explicitly requested.

The context block should contain selected facts and selected links, not a graph dump.

## Inspection and Cockpit Scope

Inspection is required from day one. Cockpit integration should be first-class, but the first slice may expose CLI/internal inspection before richer UI if that is the fastest route to dogfood.

V1 inspection must answer:

- what facts shaped this context?
- why is this fact/link believed?
- what evidence supports it?
- is it candidate, active, stale, disputed, or superseded?
- what conflicts or supersessions exist?
- how can this be corrected, retired, disputed, or promoted?

V1 explicitly excludes a general-purpose graph editor, mandatory candidate review inbox, large node-link visualization, ontology editor, or user-facing graph administration workflow.

## Options Considered

### Flat Fact Store MVP

Lower complexity and closer to the prior Fact Store direction, but misses the user's core requirement: linkage between facts is the product. Support, contradiction, supersession, dependency, scope, ownership, and evidence become ad hoc metadata instead of first-class behavior.

### Full Standards Knowledge Graph

RDF/RDF-star, named graphs, PROV-O, SHACL, SPARQL, and a graph database provide strong semantics and future interoperability. This overshoots v1. It risks turning a terminal-native context system into semantic-web infrastructure before dogfood proves value.

### Cockpit-First Concept Map

A graph UI would improve trust and correction, but risks making users administer knowledge before invisible continuity is proven. Cockpit should inspect/explain/correct the graph, not become the primary product in v1.

### Concept Graph Seed Slice

A small local concept graph with LLM-maintained candidates, strict authority promotion, typed links, provenance, bounded resolver output, and day-one inspectable dogfood injection. This best balances immediate usefulness, trust, and future optionality.

## Non-Goals

- Not a code graph.
- Not an RDF/SPARQL/graph-database platform in v1.
- Not a transcript archive.
- Not a generic knowledge-base product.
- Not a user-managed graph curation workflow.
- Not a second context manager.
- Not a protocol/RPC/SSE migration.
- Not an unbounded prompt injection source.
- Not a replacement for current user instructions, repo evidence, or runtime state.

## Consequences

### Positive

- Durable conceptual continuity becomes a first-class context source.
- Fact-to-fact linkage can surface constraints, contradictions, supersessions, ownership, and dependencies that flat memory misses.
- LLM-maintained candidates bootstrap graph value without dumping review work on users.
- Authority/lifecycle/provenance rules reduce hallucinated-truth risk.
- Day-one inspection and correction makes wrong facts visible and repairable.
- The local schema can later map to RDF/PROV/SHACL or a graph database if evidence justifies it.

### Negative

- Adds durable belief-state complexity before a fact-store implementation exists.
- Requires careful ontology discipline; duplicate concepts and junk links can destroy graph usefulness.
- Dogfood injection can reduce prompt quality if caps and precedence rules are weak.
- Cockpit/inspection work may expand unless kept to explain/correct scope.
- Candidate maintenance creates internal event and provenance volume that must be managed.

## Guardrails

1. Every fact and link must cite evidence.
2. No `related_to` link kind in v1.
3. LLM inference creates candidates, not active authority.
4. Raw transcript/tool payloads are evidence, not durable truth.
5. Conflicts and staleness block settled authority.
6. Resolver output is capped and assembled by the single active context manager.
7. No mandatory user review queue.
8. Concept identity, aliasing, merge, and supersession are v1 requirements.
9. Cockpit/inspection is explain/correct first, not a graph editor.
10. Retire/supersede by default; erase only for privacy/policy.

## Verification Requirements

Before broadening beyond the seed slice, verify:

- schema validation rejects missing evidence, invalid fact/link kinds, invalid lifecycle transitions, and uncited links;
- seeder produces candidates from `.oh` artifacts with section-level provenance and a seed report;
- duplicate concept detection catches obvious aliases and merge candidates;
- conflict/supersession handling blocks settled authority for disputed facts;
- resolver obeys authority precedence, traversal depth, token caps, and current-user/repo-evidence priority;
- dogfood injection includes provenance/authority/lifecycle handles and remains small;
- inspect/explain/correct flows can trace and repair a wrong fact;
- dogfood traces show at least one avoided re-brief or missed-concept correction because a linked fact was retrieved.

## References

- `.oh/conceptual-fact-store.md`
- `.oh/fact-store.md`
- `docs/adr/0002-rpc-compatibility-contract.md`
- `docs/adr/0003-tiered-memory-locator-map.md`
- `docs/adr/0004-tool-result-assembly-bridge.md`
- W3C PROV-O: https://www.w3.org/TR/prov-o/
- W3C SHACL: https://www.w3.org/TR/shacl/
- W3C RDF 1.2 Concepts: https://www.w3.org/TR/rdf12-concepts/
- W3C RDF 1.2 Semantics: https://www.w3.org/TR/rdf12-semantics/
