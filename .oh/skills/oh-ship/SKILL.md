# oh-ship: Ship oh-omp

Ship the fork. Upstream is source material to review selectively; it is not merged wholesale. CI handles the build and publish.

## Flow

```
review upstream candidates -> select/adapt useful changes -> verify -> bump version -> changelog -> commit -> tag -> push
```

## Principle

The fork now has its own product and architecture direction. Treat upstream as an input feed for useful fixes and ideas, not as the source of truth.

Default behavior:
- Review upstream changes since the last reviewed upstream point.
- Incorporate only changes that improve this fork.
- Leave irrelevant, incompatible, or low-value upstream changes upstream.
- Adapt useful changes to the fork architecture instead of blindly accepting upstream wiring.

A wholesale `git merge upstream/main` is no longer a feasible release path. Use selective incorporation only.

## Procedure

### 1. Review upstream candidates

Fetch upstream without importing upstream tags:

```bash
git fetch upstream main --no-tags
```

Find the last reviewed upstream commit from `upstream.json`:

```json
{
  "repo": "open-horizon-labs/oh-omp",
  "commit": "<full SHA of upstream/main at time of review>",
  "synced_at": "YYYY-MM-DD"
}
```

Compare from that commit to `upstream/main`:

```bash
git log --oneline <upstream-json-commit>..upstream/main
git diff --stat <upstream-json-commit>..upstream/main
git diff --name-status <upstream-json-commit>..upstream/main
```

If `upstream.json` does not exist, ask the user what upstream baseline to review from. Do not guess a baseline for release work.

### 2. Classify upstream changes

Use upstream as a candidate list. Classify each meaningful change before incorporating it.

| Upstream change type | Default action |
|---|---|
| Security fix | Usually adapt |
| Platform/build/signing fix | Usually adapt |
| Provider/API compatibility fix | Usually adapt |
| Small bug fix relevant to fork behavior | Usually adapt |
| CLI/TUI usability improvement | Consider |
| New feature aligned with fork aims | Cherry-pick or reimplement |
| Feature coupled to removed subsystems | Reimplement only the useful part |
| Auto-compaction/context promotion/tool pruning | Leave upstream |
| Upstream release/versioning machinery | Leave upstream |
| Product behavior irrelevant to this fork | Leave upstream |

Record the selected upstream commits or hunks in the release notes or commit body when useful.

### 3. Incorporate selected changes

Preferred methods, in order:

1. Reimplement a small change manually when that is clearer than preserving upstream structure.
2. Apply selected hunks from upstream with `git checkout -p` / patch tooling.
3. Cherry-pick without committing, then edit the result:

```bash
git cherry-pick -n <commit>
```

Do not use a full merge to pick up upstream work. If a change cannot be isolated with these methods, leave it upstream until it can be understood and adapted safely.

### 4. Fork-specific removals remain removed

**The fork intentionally removes these upstream subsystems:**

| Subsystem | Symbols / settings removed |
|---|---|
| Auto-compaction | `#checkCompaction`, `#runAutoCompaction`, `compaction.enabled`, `skipCompactionCheck`, `auto_compaction_start/end` events, `#compactionAbortController` |
| Context promotion | `#tryContextPromotion`, `#resolveContextPromotionTarget`, `#resolveContextPromotionConfiguredTarget` |
| Tool output pruning | `#pruneToolOutputs` |
| Compaction model selection | `#getCompactionModelCandidates`, `#getModelKey` |

These are replaced by the assembler pipeline (ADR 0003).

**Curation rules:**

| Situation | Resolution |
|---|---|
| Upstream modifies code the fork deleted | Leave it upstream; the deletion stands |
| Upstream adds a useful feature unrelated to removed subsystems | Incorporate the feature selectively |
| Upstream mixes useful behavior with removed subsystem wiring | Adapt only the useful behavior without the removed wiring |
| Upstream adds tests for removed settings/events | Do not copy those tests unless rewritten for fork behavior |
| `bun.lock` changes from selected dependency updates | Apply the dependency update, then run `bun install` |
| `CHANGELOG.md` has upstream release notes | Preserve useful reference sections only when they help fork users |

If a selected upstream change tries to revive compaction, promotion, pruning, or compaction model selection, stop and ask before proceeding.

### 5. Verify selected changes

After incorporating selected upstream changes and before release mechanics:

```bash
bun check
```

If this fails, fix lint/type/test issues introduced by the selected changes before proceeding.

If the failure indicates a deeper behavior break or architecture conflict, stop and report. Do not proceed with release.

### 6. Update upstream review marker

After reviewing upstream, update `upstream.json` to the upstream commit reviewed, regardless of how many changes were incorporated.

This records review lineage, not wholesale code synchronization.

```json
{
  "repo": "open-horizon-labs/oh-omp",
  "commit": "<full SHA of upstream/main reviewed>",
  "synced_at": "YYYY-MM-DD"
}
```

Use the current date for `synced_at`.

### 7. Tag hygiene

Upstream tags (`v13.x`, etc.) must NOT exist in the fork. They pollute `git describe` and break version comparison.

Prefer fetching upstream with `--no-tags`. If upstream tags leak into the local repo, clean them **locally only** — never batch-push tag changes to origin.

```bash
# Delete leaked upstream tags locally
git tag | grep -v '^v0\.[0-9]' | xargs git tag -d
```

**NEVER use `git push --tags` or `git push --tags --prune`** — these push ALL local tags, including any upstream tags from fetches, to origin. Always push release tags individually: `git push origin vX.Y.Z`.

The fork's tags follow `v0.x.y` semver. Only these should exist locally and on `origin`.

### 8. Determine version

The fork has its own independent semver starting at `0.1.0`. This is the npm/release version.

Bump rules:
- **patch**: bug fixes, selected upstream fixes with no user-facing feature change
- **minor**: new features, breaking changes (pre-1.0 semver)
- **major**: reserved for 1.0 or fundamental architecture shifts

Check `packages/coding-agent/CHANGELOG.md` `[Unreleased]` section for a `### Breaking Changes` heading. If present, bump is at least minor.

Ask the user what kind of bump. Default to patch unless breaking changes are present.

**Why independent versioning?** The fork's release cadence diverges from upstream. Coupling versions creates drift that's hard to reason about. Clean semver plus reviewed-upstream lineage is enough.

### 9. Bump version

Update `npm/oh-omp/package.json`:
- `version` field
- Both `optionalDependencies` versions (`@oh-labs/oh-omp-darwin-arm64`, `@oh-labs/oh-omp-linux-x64`) -- these must match the top-level version exactly

The workspace packages keep upstream versions unless the fork explicitly publishes them under fork scope.

### 10. Release notes

The fork CHANGELOG (`packages/coding-agent/CHANGELOG.md`) has a fork-first structure:

- `[Unreleased]` — fork-specific changes and selected upstream changes adapted into the fork
- `[0.x.y]` sections — fork release history
- Upstream release sections — optional reference only; do not treat them as required merge content

When releasing:
1. Move `[Unreleased]` entries into a new `[0.x.y] - YYYY-MM-DD` section
2. Add a fresh `[Unreleased]` section
3. Mention selected upstream fixes/features if they matter to fork users
4. Do not paste upstream release notes wholesale unless they describe changes actually incorporated into the fork

### 11. Commit and tag

```bash
git add -A
git commit -m "release: vX.Y.Z

<summary of what's in this release>"
git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"
```

### 12. Push

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
- NEVER use wholesale upstream merge to update the fork
- If `bun check` fails after selected upstream changes, do NOT proceed with the release
- The npm scope is `@oh-labs`, packages are `@oh-labs/oh-omp`, `@oh-labs/oh-omp-darwin-arm64`, `@oh-labs/oh-omp-linux-x64`
- The upstream release script (`scripts/release.ts`) is NOT used for fork releases -- it operates on upstream's version scheme
