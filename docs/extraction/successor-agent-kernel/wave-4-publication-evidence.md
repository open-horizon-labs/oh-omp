# Wave 4 Private Candidate Publication Evidence

**Date:** 2026-07-16
**State:** source authoritative; destination candidate published read-only

## Identities

- Source repository: `https://github.com/open-horizon-labs/oh-omp`
- Source cut: `77132b843e5958cf311121bc36864b932047f55a`
- Destination repository: `https://github.com/open-horizon-labs/successor-agent-kernel`
- Destination visibility: private
- Destination default branch: `main`
- Published candidate: `31148f9159859ff0b856390edda83e2230c51611`

The owner authorized source publication and private candidate creation. Source retirement and authority transfer were not authorized. `destination.writable=false` in the authority record means no successor changes are authorized there; it is a governance state, not a claim that GitHub administrators lack write capability.

The exact durable mapping line is:

```text
77132b843e5958cf311121bc36864b932047f55a 31148f9159859ff0b856390edda83e2230c51611
```

The full commit-map digest was verified against the ephemeral local generation workspace. GitHub clones do not contain `.git/filter-repo/commit-map`; the evidence does not claim remote re-verifiability of that artifact.

## Verification

Before repository creation, the final candidate passed:

- locked formatting, Clippy/check, and full all-target tests;
- committed-lock integrity with no post-command diff;
- exactly four packages at version `0.1.0` with approved author/repository metadata;
- canonical path-dependency confinement;
- slice-0 fixture byte parity;
- exact tracked inventory: 171 expected, 171 actual, zero missing or extra;
- source-cut to candidate commit-map verification;
- retained source history;
- one local branch `main`, no remotes, and clean worktree;
- published-read-only schema validation and premature-flip rejection.

After repository creation:

- GitHub reported visibility `PRIVATE` and default branch `main`;
- remote `main` resolved to the exact candidate commit;
- a fresh private-remote clone resolved to the same commit and clean `main` branch;
- source `successor-main` remained synchronized with origin and authoritative.

## Publication corrections

The publication gate caught two process-definition defects before remote creation:

1. The authority schema lacked a published-but-non-authoritative candidate state. `source_authoritative_candidate_published_read_only` was added, reviewed, validated, committed, and pushed before regenerating the candidate.
2. `cargo generate-lockfile` was incorrectly used as a reproducibility probe. Because crates.io is moving, regeneration selected newer compatible versions. The candidate lockfile was restored; evidence now correctly requires a committed lockfile, `--locked` commands, and a clean post-command diff.
3. Future regeneration now filters explicit pre-publication extraction-control files. This publication result/evidence and concrete authority records remain source-retained and are excluded, preventing candidate identity self-reference.

## Remaining Wave 4 gate

Source remains the sole mutable authority. Authority transfer requires a separate owner decision and these still-open steps:

1. create and review the exact source-retirement/tombstone commit;
2. create the concrete `authority-record.v0.json` with source-retirement and destination authority commits;
3. verify no successor changes landed after source cut; otherwise regenerate the candidate;
4. land source retirement;
5. create the destination authority commit and record the final transition;
6. independently verify source is retired and destination is the sole authorized mutation location.

If source retirement cannot land, the private candidate remains non-authoritative or is deleted; source remains authoritative.
