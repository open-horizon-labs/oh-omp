# Old-Source Tombstone Specification

Wave 4 applies this specification only after a verified destination candidate and approved authority record exist.

## Source repository changes

Remove the four successor crate directories, active successor fixture implementation, and `standalone/successor/` scaffold from normal development. Replace them with:

- `docs/successor-agent-kernel-moved.md`: destination URL, destination authoritative commit, source-retirement commit, migration date, read-only history note, and incident/rollback contact procedure;
- a short root documentation link to that pointer if the old repository has a successor entry point;
- no re-exports, compatibility crates, copied fixtures, submodules, subtree sync, or generated mirrors.

The source pointer must state that all successor issues, changes, releases, and fixtures belong only to `https://github.com/open-horizon-labs/successor-agent-kernel` after authority flip.

## Authority rules

- Before authority flip, source is the only mutable implementation and the destination candidate is read-only.
- If the tombstone cannot land, authority does not flip. Discard or park the candidate and keep source authoritative.
- Emergency fixes before flip land only in source and invalidate the candidate/cut commit.
- Emergency fixes after flip land only in destination.
- Rollback first freezes and decommissions the current authority, records the decision, and only then transfers authority. Both repositories are never mutable simultaneously.

## Wave 4 deletion inventory

Wave 3 must provide an exact tracked path list. Wave 4 may delete only those reviewed source paths, including `standalone/successor/`, and may not remove unrelated `.oh`, ADR, package, or workspace content.

Generated `successor-context-platform.sqlite3*` files are local state, not tombstone content or migration evidence.
