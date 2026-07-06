# Parallel-Wave Protocol (post-acceptance amendments)

Owner-approved 2026-07-06. Generalizes SLICE-0-DISPATCH-MAP §5/§10 wave discipline
to post-acceptance amendment work: multiple full dissent→execute→review cycles run
concurrently as one wave. Durable law (SLICE-0-REVIEW-LEARNINGS §1-14) binds every
leg. Precedent basis: Slice 0 waves A-D (parallel lanes, serial gates); amendment
series tasks 252-260 (serial cycles this protocol parallelizes).

## Definitions

- **Lane**: one bounded change with its own dissent, execution, and review legs,
  over an explicitly named owned file set (3-5 files; no globs).
- **Wave**: a set of lanes whose owned file sets are pairwise disjoint, launched
  from a single pinned HEAD (the wave base).
- **Orchestrator**: the main-session agent. Sole authority for merge order,
  integration gates, commits/pushes, and cross-lane adjudication.

## Phase cycle

1. **Parallel dissents** (read-only; one dispatch, N superego tasks).
   Each dissent: checkout proof against the wave base, file:line-grounded rulings,
   forbidden patterns, and an explicit owned-file list for its lane.
2. **Cross-ruling check** (orchestrator). Compare rulings: file-ownership overlap,
   contract/fixture-amendment claims, contradictory boundary law. Any conflict
   demotes a lane to the next wave, or triggers a superego adjudication before
   execution. Nothing executes under contested law.
3. **Parallel executions** (isolated). One dispatch, N executor tasks, each in an
   isolated tree (patch mode or per-lane worktree), each bound to its own ruling
   artifact. Every executor: checkout proof, firing proof for each new/strengthened
   test, quoted per-package validation. No executor runs workspace-wide gates.
4. **Merge + integration gate** (orchestrator; the irreducible serial point).
   Apply lane patches in ruled dependency order onto the wave base. Then, on the
   merged tree: `make check-rs`, full per-crate suites, byte-identity oracles, and
   at least one live smoke of the affected path, gated on success terminal frames
   (never exit codes alone — see the defeated-gate record in f4fdc9b00). Per-lane
   green is not merged green; the 8-round budget defect (fixed at 0ffc764be) is the
   standing proof.
5. **Parallel reviews**. One dispatch, N reviewer tasks over per-lane diffs at the
   merged HEAD, judging ruling compliance, oracle strength, and cross-lane bleed.
6. **Fix rounds**. File-disjoint findings may be fixed in parallel; otherwise
   serial. Mechanical closures with firing proof follow the A5 precedent (no
   re-review); design-level findings re-enter at phase 1 as their own lane.
7. **Wave closure**. Commits pushed with per-lane provenance (task ids, verdicts,
   firing proofs, live evidence); pending legs and accepted deviations named in
   commit messages, never silent.

## Hard rules

1. **File-disjoint ownership.** A lane names every file it may touch. Two lanes
   sharing a file never run in the same wave.
2. **One amendment lane per wave.** At most one lane per wave may amend
   SLICE-0-CONTRACT.md, sovereign fixtures, or byte-pinned oracles. All other
   lanes must be amendment-free; ripple discovered mid-execution = stop-and-report,
   never regenerate.
3. **Orchestrator-only serial points.** Merge order, integration gate, commit,
   push, record corrections. No lane commits.
4. **Gates assert success terminals.** Live verification asserts turn_completed /
   the success frame of the path under test (learnings §14). Exit codes and
   "no error output" are not gates.
5. **Firing proofs are per-lane mandatory.** Every regression test demonstrates
   fail-before/pass-after inside the lane that introduces it.
6. **No test weakening anywhere** (§14: strengthen only). A lane needing a test
   relaxed has discovered a contract question: route to dissent, not to the diff.
7. **Checkout proof first** for every leg of every lane, against the pinned wave
   base; mismatch = stop.
8. **Honest records.** False or defeated verification claims are corrected in
   place by record-correction commits (f4fdc9b00 / 1073e918c precedent).
9. **Injected-context hygiene.** Every dispatched leg ignores auto-injected
   concept-graph/recalled context unrelated to its lane.

## Cost and sizing

Parallel executors multiply spend (task 257: ~$48). Wave size 2-4 lanes; prefer a
second wave over a fifth lane. A lane too big to state per the dispatch rule
(Target / Inputs / Forbidden / Acceptance) is not ready.

## Wave 1 board (proposed)

| Lane | Scope (owned files) | Status |
|---|---|---|
| 1. Provider-native conversation projection | runner.rs, provider/anthropic.rs, provider/projection.rs, hydration test | Ruled (256 item B; review 259 P1-2) — executor-ready |
| 3. New tools per TOOL-AUTHORING-BLUEPRINT | new tools/*.rs, catalog.rs, discovery tests | Needs lane dissent |
| 4. DX: workspace-root usage error, failure-payload rendering, replay_mismatch | cli args.rs/render.rs, platform replay.rs + tests | Needs lane dissent |
| 2. Multi-turn sessions | (deferred) | Depends on Lane 1 projection shape — next wave |

Lanes 1 and 3 both graze runner.rs/catalog.rs edges: Wave 1 dissents must rule the
boundary explicitly or the pair is sequenced across waves.
