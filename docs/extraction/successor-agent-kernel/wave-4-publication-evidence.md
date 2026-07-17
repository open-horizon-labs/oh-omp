# Wave 4 Private Candidate Publication Evidence

**Date:** 2026-07-16
**State:** source authoritative; destination candidate published read-only

## Final identities

- Source repository: `https://github.com/open-horizon-labs/oh-omp`
- Source cut: `f72b95dc763f06765ea83d82251f0f11e834fa06`
- Destination repository: `https://github.com/open-horizon-labs/successor-agent-kernel`
- Destination visibility: private
- Destination default branch: `main`
- Published candidate: `f8196dd6b252ca70edf3bc04112ca352b43bafad`

The owner authorized source publication and private candidate creation. Source retirement and authority transfer were not authorized. `destination.writable=false` means no successor changes are authorized there; it is a governance state, not a claim that GitHub administrators lack write capability.

The exact durable mapping line is:

```text
f72b95dc763f06765ea83d82251f0f11e834fa06 f8196dd6b252ca70edf3bc04112ca352b43bafad
```

The full commit-map digest was verified against the ephemeral local generation workspace. GitHub clones do not contain `.git/filter-repo/commit-map`; the evidence does not claim remote re-verifiability of that artifact.

## Verification

Before final publication, the explicit-filter candidate passed:

- locked formatting, Clippy/check, and full all-target tests;
- committed-lock integrity with no post-command diff;
- exactly four packages at version `0.1.0` with approved author/repository metadata;
- canonical path-dependency confinement;
- slice-0 fixture byte parity;
- exact tracked inventory: 171 expected, 171 actual, zero missing or extra;
- source-cut to candidate commit-map verification and retained history;
- exactly one local branch `main` and a clean worktree;
- published-read-only schema validation and premature-flip rejection;
- explicit exclusion of Wave 4 publication/authority records from candidate identity inputs.

The private remote was first created from verified candidate `31148f9159859ff0b856390edda83e2230c51611`. After governance controls were corrected and committed, `main` was updated with force-with-lease requiring that exact old commit. Final remote `main` is `f8196dd6b252ca70edf3bc04112ca352b43bafad`.

A fresh private-remote clone resolved to final candidate `f8196dd6b252ca70edf3bc04112ca352b43bafad`, clean branch `main`, and contained no source-only Wave 4 publication or concrete authority record.

## Publication corrections

The publication gate caught and corrected these process-definition defects before authority transfer:

1. Added explicit `source_authoritative_candidate_published_read_only` state.
2. Replaced the invalid `cargo generate-lockfile` reproducibility probe with committed-lock `--locked` integrity.
3. Replaced directory-wide extraction-control filtering with explicit pre-publication files, excluding source-only Wave 4 governance evidence.
4. Defined `writable` as governance-authorized mutation rather than provider ACL capability.
5. Persisted the exact mapping line and scoped full commit-map verification to the ephemeral generation workspace.

## Remaining Wave 4 gate

Source remains the sole mutable authority. Authority transfer still requires a separate owner decision and:

1. exact source-retirement/tombstone commit review;
2. concrete `authority-record.v0.json` with source-retirement and destination authority commits;
3. verification that no candidate-input changes landed after source cut;
4. source retirement landing before destination authority activation;
5. independent verification that source is retired and destination is the sole authorized mutation location.

If source retirement cannot land, the private candidate remains non-authoritative or is deleted; source remains authoritative.
