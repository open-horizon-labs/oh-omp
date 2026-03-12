# oh-ship: Ship oh-omp

Synchronize the fork with upstream, verify, bump version, tag, and push. CI handles the build and publish.

## Flow

```
fetch upstream -> merge -> resolve conflicts -> verify -> bump version -> commit -> tag -> push
```

## Procedure

### 1. Sync with upstream

```bash
git fetch upstream
git merge upstream/main --no-edit
```

If there are merge conflicts, resolve using the rules below. Do not blindly auto-resolve.

**The fork intentionally removes these upstream subsystems:**

| Subsystem | Symbols / settings removed |
|---|---|
| Auto-compaction | `#checkCompaction`, `#runAutoCompaction`, `compaction.enabled`, `skipCompactionCheck`, `auto_compaction_start/end` events, `#compactionAbortController` |
| Context promotion | `#tryContextPromotion`, `#resolveContextPromotionTarget`, `#resolveContextPromotionConfiguredTarget` |
| Tool output pruning | `#pruneToolOutputs` |
| Compaction model selection | `#getCompactionModelCandidates`, `#getModelKey` |

These are replaced by the assembler pipeline (ADR 0003).

**Conflict resolution rules:**

| Conflict type | Resolution |
|---|---|
| Upstream modifies code the fork deleted (compaction, pruning, promotion) | **Take ours** — the deletion stands |
| Upstream adds genuinely new features unrelated to removed subsystems | **Take both** — keep our code, add the new feature |
| Upstream mixes new features with removed subsystem wiring | **Take ours, then manually add the feature** without the compaction/handoff wiring |
| `bun.lock` | Take theirs, then `bun install` |
| `CHANGELOG.md` | Keep fork's `[Unreleased]`, add upstream version sections below |
| New upstream tests referencing removed settings (e.g., `compaction.enabled`) | Remove those references |

After resolving, run `bun fix:ts` for import ordering, then amend the merge commit.

### 2. Verify

```bash
bun check
```

If this fails after the merge, fix lint/type issues introduced by the merge before proceeding. Common: unused imports or classes left behind after conflict resolution.

If the failure is deeper (logic breakage from upstream changes), stop and report.

### 3. Tag hygiene

Upstream tags (`v13.x`, etc.) must NOT exist in the fork. They pollute `git describe` and break version comparison.

`git fetch upstream` can import upstream tags into the local repo. These must be cleaned **locally only** — never batch-push tags to origin.

```bash
# Delete leaked upstream tags locally
git tag | grep -v '^v0\.[0-9]' | xargs git tag -d
```

**NEVER use `git push --tags` or `git push --tags --prune`** — these push ALL local tags (including any upstream tags from `git fetch`) to origin. Always push release tags individually: `git push origin vX.Y.Z`.

The fork's tags follow `v0.x.y` semver. Only these should exist locally and on `origin`.

### 4. Determine version

The fork has its own independent semver starting at `0.1.0`. This is the npm/release version.

The upstream base is tracked in `upstream.json` (repo root):
```json
{
  "repo": "open-horizon-labs/oh-omp",
  "commit": "<full SHA of upstream/main at time of sync>",
  "synced_at": "YYYY-MM-DD"
}
```

After syncing upstream, update `upstream.json` with the new commit hash and date. Create the file if it doesn't exist.

Bump rules:
- **patch**: bug fixes, upstream sync with no user-facing changes
- **minor**: new features, breaking changes (pre-1.0 semver)
- **major**: reserved for 1.0 or fundamental architecture shifts

Check `packages/coding-agent/CHANGELOG.md` `[Unreleased]` section for a `### Breaking Changes` heading. If present, bump is at least minor.

Ask the user what kind of bump. Default to patch unless breaking changes are present.

**Why independent versioning?** The fork's release cadence diverges from upstream. Coupling versions creates drift that's hard to reason about. Clean semver, tracked lineage.

### 5. Bump version

Update `npm/oh-omp/package.json`:
- `version` field
- Both `optionalDependencies` versions (`@oh-labs/oh-omp-darwin-arm64`, `@oh-labs/oh-omp-linux-x64`) -- these must match the top-level version exactly

The workspace packages keep upstream versions (they're not published to npm under the fork scope).

### 6. Release notes

The fork CHANGELOG (`packages/coding-agent/CHANGELOG.md`) has a dual structure:

- `[Unreleased]` — fork-specific changes (assembler, budget, provenance)
- `[0.x.y]` sections — fork release history
- `[13.x.y]` sections — upstream release notes (preserved for reference)

When releasing:
1. Move `[Unreleased]` entries into a new `[0.x.y] - YYYY-MM-DD` section
2. Add a fresh `[Unreleased]` with a summary of the upstream sync
3. Upstream version sections auto-merge from upstream's CHANGELOG — do not manually edit them

### 7. Commit and tag

```bash
git add -A
git commit -m "release: vX.Y.Z

<summary of what's in this release>"
git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"
```

### 8. Push

```bash
git push origin main
git push origin vX.Y.Z
```

Push tag separately — `--follow-tags` is unreliable when the tag was just created in the same session.

Push to `origin` only. Never push to `upstream`.

The tag push triggers `.github/workflows/release.yml` which handles: build on each platform, npm publish `@oh-labs/oh-omp`, and GitHub release creation.

## Post-ship verification

After pushing:
1. Verify CI triggered: `gh run list --limit 3`
2. Confirm both the release workflow (triggered by tag) and CI workflow (triggered by push) appear
3. Report workflow status to the user

## Important

- NEVER push to upstream
- NEVER publish to npm manually -- CI handles it
- If `bun check` fails after merge, do NOT proceed with the release
- The npm scope is `@oh-labs`, packages are `@oh-labs/oh-omp`, `@oh-labs/oh-omp-darwin-arm64`, `@oh-labs/oh-omp-linux-x64`
- The upstream release script (`scripts/release.ts`) is NOT used for fork releases -- it operates on upstream's version scheme
