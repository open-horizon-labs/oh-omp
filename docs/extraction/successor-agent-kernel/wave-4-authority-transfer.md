# Wave 4 Authority Transfer

## Preconditions

- Source authority: `open-horizon-labs/oh-omp`, branch `successor-main`.
- Published private candidate `C`: `open-horizon-labs/successor-agent-kernel`, branch `main`, commit `f8196dd6b252ca70edf3bc04112ca352b43bafad`.
- Owner separately authorizes source retirement `R`, destination activation `A`, destination evidence `B`, source governance follow-up `G`, and any rollback.

## Post-publication staleness boundary

Candidate `C` is stale and must be regenerated if anything changes after source cut `f72b95dc763f06765ea83d82251f0f11e834fa06` under:

- `crates/successor-*`;
- `standalone/successor/`;
- `.oh/workstreams/successor-agent-kernel/fixtures/`;
- ADR 0007 or any runtime/workspace dependency input.

Post-publication files under `docs/extraction/successor-agent-kernel/` are source-retained governance material. Changes there do not alter runtime/fixture candidate identity and are delivered to destination in evidence commit `B`. Immediately before `R`, a path-scoped diff from the source cut to the approved source base must prove no candidate-input change. Any match stops transfer and requires candidate regeneration.

## Execution contract

- Every leg uses a fresh isolated clone/worktree with a clean index.
- Before `R`, record an owner-approved exact source base `S0`; require local and `origin/successor-main` both equal `S0`.
- Require destination remote `main == C` before `R` and again before `A`.
- Source target branch is `successor-main`; destination target branch is `main`.
- Solo-maintainer default is direct push, but each R/A/B/G push requires its own explicit owner authorization. A PR may replace direct push only by owner decision.
- Record pre-push HEAD, expected remote HEAD/lease, post-push remote HEAD, branch, repository URL, and authority state for every leg.
- Any branch mismatch, dirty checkout, lease mismatch, remote HEAD drift, candidate-input drift, or failed verification stops transfer.

## Transfer sequence

1. **Freeze:** prohibit successor implementation, fixture, and scaffold changes in both repositories.
2. **Prepare `R`:** in an isolated source branch remove the four successor crates, root workspace membership, active slice-0 fixture directory, and `standalone/successor/`; add `docs/successor-agent-kernel-moved.md`. Preserve ADRs and source-retained governance evidence.
3. **Verify `R`:** source Rust checks pass without successor workspace members; exact deletion inventory and pointer content receive review and explicit owner approval.
4. **Land `R`:** push with the approved source-base lease. Authority becomes `source_retired_destination_pending_activation`: both repositories have governance `writable=false`.
5. **Activate `A`:** from destination candidate `C`, add `docs/extraction/successor-agent-kernel/authority-activation.md` naming `C`, source cut, and `R`; push with lease requiring remote `main == C`. Commit `A` is the authority commit. Destination becomes the sole authorized mutation location.
6. **Record `B`:** in destination add the latest authority schema/governance docs plus concrete `authority-record.v0.json` with `source.retirement_commit=R`, `destination.candidate_commit=C`, and `destination.authority_commit=A`; validate, review, authorize, and push.
7. **Record `G`:** in retired source update the pointer with `A` and `B`, and optionally copy the concrete record as source-retained governance evidence. This governance-only commit does not restore successor implementation authority.
8. **Verify:** source has no successor crates/scaffold/active fixtures; destination contains `A` and `B`; concrete record validates; future successor work routes only to destination.

The concrete record is committed in `B`, after `A`, so it can reference `A` without self-reference.

## Failure handling

- Before `R`: source remains authoritative; discard retirement work or regenerate a stale candidate.
- After `R`, before `A`: no repository is mutable for successor work. Reverting `R` is permitted only with explicit owner/incident authorization; record `source_retained`, keep destination unactivated/unwritable, and stop until the owner accepts recovery or a regenerated transfer.
- After `A`: destination is authoritative. Failure to create `B` is an evidence-repair incident in destination; source must not be reactivated implicitly.
- Any lease mismatch stops transfer and requires re-verification.

## Explicit non-goals

No runtime refactor, port correction, release, package publication, public visibility change, or Wave 5 behavior work is part of authority transfer.
