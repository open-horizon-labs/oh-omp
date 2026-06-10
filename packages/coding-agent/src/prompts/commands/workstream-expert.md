---
description: Interactively build or update a durable Workstream Expert System without coding
---

Interactively build or update a durable Workstream Expert System for this raw workstream seed:

```text
$@
```

This command is builder-only. It **MUST NOT** implement code changes, open PRs, edit product code, or run task execution. Its purpose is to explicitly create or update the persistent expert system that future `/workstream` runs execute under.

## Core contract

A Workstream Expert System is durable per conceptual workstream, not per task. A project may have multiple Workstream Expert Systems. This command identifies the conceptual workstream, resolves existing expert systems, persists the Step 0 / OH Workstream Frame contract, and stops after Superego-reviewed persistence.

## Interactive rule

This command is explicitly interactive. Use `ask` when a material choice affects identity, source authority, persistence, overwrite/update behavior, or blocking scope.

You **MUST** ask the user before proceeding when:

- multiple existing Workstream Expert Systems could apply,
- no persistence path/store is known,
- creating a new expert system may duplicate an existing conceptual workstream,
- canonical source artifacts are inaccessible,
- the user must authorize a bounded substitute frame,
- updating an existing expert system would materially change durable workstream law,
- the workstream boundary is ambiguous,
- closure/delivery authority cannot be derived from canonical sources.

You **MUST NOT** ask for trivia that tools can determine. Inspect existing files, docs, and expert-system artifacts first.

## Required role order

1. Inspect the repo for existing Workstream Expert Systems. Preferred v0 filesystem locations include `.oh/workstreams/*/EXPERT-SYSTEM.md`, but also search for existing Kraken-style or project-specific expert-system artifacts if the seed implies one.
2. Invoke `beancounter` to produce the `## OH Workstream Frame` from the raw workstream seed. The frame must identify conceptual workstream identity, canonical sources, acceptance criteria, existing expert-system candidates, persistence needs, and stop conditions.
3. Ensure canonical source artifacts were read and acceptance criteria were mapped. If any required artifact is unavailable, stop for Superego and ask the user whether to block or authorize a bounded substitute frame.
4. Invoke `superego` to perform the Superego OH Frame Review.
5. If Superego returns `BLOCK`, ask the user only for the blocking material uncertainty.
6. If Superego returns `REVISE`, revise the OH Workstream Frame before building/updating the expert system.
7. Ask the user to choose the target persistence/update path if it remains ambiguous after inspection. Recommend `.oh/workstreams/<workstream-id>/EXPERT-SYSTEM.md` for v0 when no project convention exists.
8. Invoke `workstream-expert` to build a new or update an existing durable `# Workstream Expert System` from the approved OH Workstream Frame, canonical sources, acceptance criteria map, existing expert system if any, persistence target, and Superego corrections.
9. Invoke `superego` to review the Workstream Expert System for source fidelity, criterion preservation, workstream identity, persistence scope, durable-vs-task-local separation, closure authority, verification gates, and spec-substitution resistance.
10. If Superego returns `BLOCK`, do not persist the update unless the user explicitly authorizes a revised bounded frame. If Superego returns `REVISE`, revise and re-review before persistence.
11. Persist the approved expert system at the agreed path/store using file tools when filesystem persistence is selected.
12. Stop. Do not invoke coder execution.

## Persistence output

The final response must include:

```markdown
## Workstream Expert Builder Packet

**Builder-only:** yes

**Workstream ID:**

**Conceptual workstream:**

**Existing expert system reused:** yes | no | none found

**Artifact path / store:**

**Created or updated:** created | updated | blocked

**Canonical sources read:**

**Acceptance criteria mapped:** yes | no | partial

**OH Workstream Frame status:** allowed | revised | blocked

**Superego expert-system review:** allowed | revised | blocked

**Step 0 contract persisted:** yes | no | blocked

**Durable laws added/changed:**

**Task-specific deltas recorded but not promoted:**

**Human decisions made:**

**Human decision still needed:** none | choose workstream boundary | authorize substitute source | approve durable-law update | choose persistence path | other

**Do not code:** confirmed

**Next suggested command:**
[Usually `/workstream <task>` once the expert system is approved.]
```

## Friction log

Include a brief friction log if anything blocked, required clarification, or should become native behavior.
