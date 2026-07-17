# Wave 3 Filtered Rehearsal Evidence

**Date:** 2026-07-16
**Authority state:** source authoritative; local candidate read-only
**Source cut:** `28b73a4b5ac9030976117e4d0b829e52a758ad38`
**Candidate commit:** `9da28be0e279f0835233dcd22c80379f982da9eb`
**Destination remote:** absent

## Extraction

- Tool package: `git-filter-repo` 2.47.0 through pinned `uvx`.
- Tool CLI identity: `a40bce548d2c`.
- Filter argv digest: `e19eedd17bdcee3dddf0d3c11518132a968082aee6c2c112330b76a1d3a14512` over compact newline-free JSON.
- Commit-map digest: `a2dccd952525e2c93af52c5980898208ab3dea50cd07337f193304262b63172a`.
- Source cut mapping: `28b73a4b5ac9030976117e4d0b829e52a758ad38 -> 9da28be0e279f0835233dcd22c80379f982da9eb`.
- Candidate branches: exactly `main`.
- Candidate remotes: none.

The actual argv and machine-readable state are in `wave-3-rehearsal-result.json`, which was written only in the authoritative source after filtering. It is intentionally absent from the filtered candidate to avoid self-reference.

## Candidate verification

| Gate | Result |
|---|---|
| `cargo metadata --locked` | PASS; exactly four successor packages |
| Package metadata | PASS; version `0.1.0`, author Open Horizon Labs, approved repository URL |
| `make check-rs` | PASS; formatting, Clippy with warnings denied, Cargo check |
| `make test-rs` | PASS; full workspace all-target tests |
| Locked resolution integrity | PASS; tracked `Cargo.lock` SHA-256 `ae05eedde31f73d60814b698fa3306d120ea816c73f00f79f7b11f44262d45f3`; locked metadata/check/test commands left it unchanged |
| Path dependency confinement | PASS; every path dependency resolves inside canonical candidate root |
| Canonical slice-0 fixture parity | PASS; recursive byte comparison matched source cut |
| Tracked inventory | PASS; 169 expected, 169 actual, zero missing, zero extra |
| Forbidden monorepo remnants | PASS; no packages/npm/Bun/upstream/database artifacts |
| History retention | PASS; runner retains multiple pre-extraction commits |
| Commit map | PASS; source cut maps to candidate commit |
| Candidate worktree | PASS; clean, exactly one local branch `main`, no remotes |

## Authority and rollback verification

The actual result validates against `authority-record.v0.schema.json`. The schema rejected:

- destination authority without source-retirement/authority commits;
- two writable repositories after flip;
- non-writable destination after flip;
- a Wave 3 candidate with an existing destination remote;
- an absent-candidate state that retained a candidate commit.

These rejection proofs implement the failed-cutover and pre/post-flip emergency rules without mutating either repository.

## Rehearsal findings and corrections

The rehearsal found and corrected preparation defects before authority transfer:

1. The initial scaffold omitted `rustfmt.toml`, causing formatting drift. The exact accepted source formatting policy now moves with the workspace.
2. The first standalone Makefile linted all test targets, unlike the accepted Wave 1 gate, and introduced unrelated source cleanup pressure. Clippy/check now match the accepted source gate; full all-target tests remain mandatory.
3. `git-filter-repo --target` requires an existing Git repository. The runbook now creates separate fresh source and target clones and removes the target's temporary local remote after filtering.
4. macOS canonicalizes `/tmp` to `/private/tmp`; dependency confinement now compares canonical roots.
5. Authority evidence was split into a pre-cut template and post-cut source-only result to prevent candidate identity self-reference.
6. The authority schema now enforces state-dependent writable/remote/commit invariants, and CI actions use immutable commit pins.
7. A later publication probe showed that `cargo generate-lockfile` can select newly published compatible registry versions. The acceptance contract was corrected: regeneration is an update operation; reproducibility is enforced by the committed lockfile, `--locked` commands, and a clean post-command diff.

## Scope and residual conditions

- No GitHub repository was created.
- Nothing was pushed.
- Source crates, fixtures, and scaffold remain authoritative.
- No source tombstone or deletion occurred.
- No Wave 5 port/provenance behavior changed.
- Wave 4 remains blocked until the destination repository is created under owner authority and the exact Wave 4 cut, candidate, source-retirement, and authority-record commits are approved.


## Owner acceptance

On 2026-07-16, the owner explicitly accepted the Wave 3 rehearsal and authorized one local source-only evidence commit. Push, destination creation, candidate mutation, source retirement, and authority transfer remain unauthorized.