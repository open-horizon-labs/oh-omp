# oh-ship: Ship oh-omp

Synchronize the fork with upstream, verify, bump version, tag, and push. CI handles the build and publish.

## Flow

```
fetch upstream -> merge -> verify -> bump version -> changelog -> commit -> tag -> push
```

## Procedure

### 1. Sync with upstream

```bash
git fetch upstream
git merge upstream/main --no-edit
```

If there are merge conflicts, stop and present them to the user. Do not auto-resolve.

### 2. Verify

```bash
bun check
```

If this fails after the merge, the merge introduced breakage. Stop and report.

### 3. Determine version

The fork has its own independent version starting at `0.1.0`. This is the npm/release version.

The upstream base version is tracked in `npm/oh-omp/upstream.json` for reference only:
```json
{ "base": "13.9.2", "mergedAt": "2026-03-08" }
```

After syncing upstream, update `upstream.json` with the new base version and date.

Ask the user what kind of bump: patch, minor, or major. Default to patch.

**Why independent versioning?** The fork's release cadence diverges from upstream.
Coupling versions (e.g., +100 major offset, pre-release tags) creates
version drift that's hard to reason about. Clean semver, tracked lineage.

### 4. Bump version

Update `version` in `npm/oh-omp/package.json` only. The workspace packages
keep upstream versions (they're not published to npm under the fork scope).

### 5. Update changelogs

For each `packages/*/CHANGELOG.md` that has entries under `## [Unreleased]`:
1. Add a new version header below `## [Unreleased]`: `## [X.Y.Z] - YYYY-MM-DD`
2. Move the unreleased entries under the new header
3. Leave an empty `## [Unreleased]` section at the top

Skip packages with no unreleased entries.

### 6. Commit and tag

```bash
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
```

### 7. Push

```bash
git push origin main --follow-tags
```

Push to `origin` only. Never push to `upstream`.

The tag push triggers `.github/workflows/release.yml` which handles: build on each platform, npm publish `@oh-labs/oh-omp`, and GitHub release creation.

## Post-ship verification

After pushing, check that:
1. The GitHub Actions workflow started: `gh run list --workflow=release.yml --limit=1`
2. Report the workflow URL to the user

## Important

- NEVER push to upstream
- NEVER publish to npm manually -- CI handles it
- If `bun check` fails after merge, do NOT proceed with the release
- The npm scope is `@oh-labs`, packages are `@oh-labs/oh-omp`, `@oh-labs/oh-omp-darwin-arm64`, `@oh-labs/oh-omp-linux-x64`
