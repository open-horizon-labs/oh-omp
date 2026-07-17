# Old-Source Tombstone Specification

Wave 4 applies this specification only after a verified destination candidate and approved authority record exist.

## Source repository changes

Remove the four successor crate directories, active successor fixture implementation, and `standalone/successor/` scaffold from normal development. Replace them with:

- `docs/successor-agent-kernel-moved.md`: destination URL, destination authoritative commit, source-retirement commit, migration date, read-only history note, and incident/rollback contact procedure;
- a short root documentation link to that pointer if the old repository has a successor entry point;
- no re-exports, compatibility crates, copied fixtures, submodules, subtree sync, or generated mirrors.

The source pointer must state that all successor issues, changes, releases, and fixtures belong only to `https://github.com/open-horizon-labs/successor-agent-kernel` after authority flip.

Source-retained governance evidence under `docs/extraction/successor-agent-kernel/`—including Wave 4 publication and concrete authority-transfer records—remains in the retired source repository. It is not copied into regenerated candidate identity inputs.

## Authority rules

- Before source retirement, source is the only mutable implementation and the destination candidate is read-only.
- After source retirement lands and before destination activation, both repositories are frozen: `source_retired_destination_pending_activation`.
- If destination activation cannot land, revert the source-retirement commit and record `source_retained`; do not mutate destination as authority.
- After destination activation, emergency fixes land only in destination.
- Concrete authority evidence is committed after activation so it can reference the activation commit without self-reference.
- Rollback first freezes and decommissions the current authority, records the decision, and only then transfers authority. Both repositories are never mutable simultaneously.

## Wave 4 deletion inventory

Wave 3 must provide an exact tracked path list. Wave 4 may delete only those reviewed source paths, including `standalone/successor/`, and may not remove unrelated `.oh`, ADR, package, or workspace content.

Generated `successor-context-platform.sqlite3*` files are local state, not tombstone content or migration evidence.
