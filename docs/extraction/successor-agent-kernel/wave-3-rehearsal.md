# Wave 3 Extraction Rehearsal

## Fixed decisions

- Source: `https://github.com/open-horizon-labs/oh-omp`, branch `successor-main`.
- Destination: `https://github.com/open-horizon-labs/successor-agent-kernel`, branch `main` (not created in Wave 3).
- Filter tool: `git-filter-repo==2.47.0` via pinned `uvx`.
- Candidate is local, read-only, and non-authoritative.
- Initial workspace version: `0.1.0`; author: Open Horizon Labs; existing MIT notices preserved.

## Preconditions

1. `successor-main` is clean except excluded local SQLite/WAL state.
2. The Wave 3 scaffold, generated standalone `Cargo.lock`, evidence summaries, and extraction controls are committed.
3. `SOURCE_CUT` is that exact commit.
4. `uv run --with git-filter-repo==2.47.0 python -c 'import importlib.metadata; print(importlib.metadata.version("git-filter-repo"))'` reports package version `2.47.0`; separately record the CLI identity from `uvx --from git-filter-repo==2.47.0 git-filter-repo --version`.
5. `filter-paths.txt` matches the reviewed inventory.

## Exact rehearsal

Use a temporary directory outside the source checkout:

```sh
SOURCE_REPO="$(git rev-parse --show-toplevel)"
SOURCE_CUT="$(git rev-parse HEAD)"
REHEARSAL_ROOT="$(mktemp -d)"
SOURCE_CLONE="$REHEARSAL_ROOT/source"
CANDIDATE="$REHEARSAL_ROOT/candidate"

git clone --no-local "$SOURCE_REPO" "$SOURCE_CLONE"
git -C "$SOURCE_CLONE" checkout --detach "$SOURCE_CUT"
git clone --no-local "$SOURCE_CLONE" "$CANDIDATE"

uvx --from git-filter-repo==2.47.0 git-filter-repo \
  --source "$SOURCE_CLONE" \
  --target "$CANDIDATE" \
  --force \
  --path standalone/successor/ \
  --path crates/successor-protocol/ \
  --path crates/successor-context-platform/ \
  --path crates/successor-kernel/ \
  --path crates/successor-cli/ \
  --path .oh/workstreams/successor-agent-kernel/ \
  --path docs/adr/0003-tiered-memory-locator-map.md \
  --path docs/adr/0004-tool-result-assembly-bridge.md \
  --path docs/adr/0005-clean-sheet-mech-suit-runtime.md \
  --path docs/adr/0007-standalone-successor-repository-and-port-ownership.md \
  --path docs/evidence/standalone-kernel/ \
  --path docs/extraction/successor-agent-kernel/ \
  --path-rename standalone/successor/:

git -C "$CANDIDATE" remote remove origin
git -C "$CANDIDATE" switch -C main
git -C "$CANDIDATE" for-each-ref --format='%(refname:short)' refs/heads | \
  while read -r branch; do
    test "$branch" = main || git -C "$CANDIDATE" branch -D "$branch"
  done
```

`--target` must name an existing fresh Git repository; the second clone is required. If the pinned 2.47.0 CLI does not support `--source/--target`, stop rather than substituting another history tool.

The filtered repository must be on local branch `main`, have no configured remotes, and remain non-authoritative.

## Candidate verification

From the candidate root:

```sh
cargo metadata --locked --no-deps
make check-rs
make test-rs
```

Also verify:

- `Cargo.lock` is tracked; `cargo metadata --locked`, `make check-rs`, and `make test-rs` complete without changing it; do not run `cargo generate-lockfile` as verification because it intentionally resolves the newest compatible registry state;
- all package versions are `0.1.0`, author is Open Horizon Labs, and repository URL is the approved destination;
- `cargo tree --workspace` has no path dependency outside candidate root;
- no monorepo patch, Bun, package, upstream, DB/WAL, or unrelated crate path remains;
- all canonical fixture checks pass from the preserved `.oh` path;
- SHA-256 checksums of every tracked slice-0 fixture match source cut bytes;
- `git log --follow` and `.git/filter-repo/commit-map` demonstrate retained path history;
- only the approved inventory appears in `git ls-files`.

## Authority record update

Do not modify `authority-record.template.json` inside the cut or candidate. After filtering, create `docs/extraction/successor-agent-kernel/wave-3-rehearsal-result.json` **only in the authoritative source repository** from that template. Record package/CLI identity, exact argv, source cut, candidate commit, verification outcomes, and candidate state `source_authoritative_candidate_read_only`. Define `argv_sha256` as SHA-256 over UTF-8 compact JSON serialization of the argv array with no trailing newline; define `commit_map_sha256` over the raw commit-map bytes. This post-cut source evidence is intentionally absent from the already filtered candidate, avoiding a self-referential candidate commit.

The concrete Wave 4 record is `docs/extraction/successor-agent-kernel/authority-record.v0.json`. It is created only after remote existence, candidate commit, authority-record commit, and source-retirement commit are known.

## Failure and rollback rehearsal

Simulate without changing source:

1. Candidate verification failure: mark candidate discarded; source remains authoritative.
2. Source tombstone cannot land: park/discard candidate; source remains authoritative.
3. Emergency fix before flip: document candidate invalidation and new cut requirement.
4. Emergency fix after hypothetical flip: assert source stays read-only and fix routes only to destination.

## Stop conditions

Stop Wave 3 if the pinned tool is unavailable, the exact filter cannot be reproduced, candidate files exceed inventory, fixture bytes differ, root metadata is unresolved, any locked command requests or produces a lockfile change, any path dependency escapes candidate root, history/commit map is absent, destination identity changes, or authority state would become ambiguous.

Never create/push the destination or retire source in Wave 3.
