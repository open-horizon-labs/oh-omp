# Per-Model Compaction Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, model-specific overlays for every OMP compaction setting without changing behavior for configurations that omit the map.

**Architecture:** A pure compaction-policy resolver materializes global settings plus the first matching per-model partial overlay. `AgentSession` resolves the policy from the active conversation model at every compaction decision and execution path. The resolver reuses OMP’s canonical model formatter and Bun glob primitive; the existing global settings remain the fallback.

**Tech Stack:** TypeScript, Bun, `Bun.Glob`, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-21-per-model-compaction-overrides-design.md`

## Global Constraints

- The feature is opt-in: no `compaction.modelOverrides` map means byte-for-byte equivalent global compaction policy selection.
- Map keys match the active conversation model case-insensitively: exact canonical key first, then first matching Bun glob in final merged declaration order.
- Each map value is a partial overlay of every compaction setting except recursive `modelOverrides`.
- Invalid entries emit diagnostics and are skipped; unknown model keys are valid and inert until matched.
- Use OMP’s settings layering, model formatter, and Bun glob primitive; add no dependency and no duplicate matcher or merge framework.
- Apply the effective policy to manual, threshold, overflow, and idle compaction; never select policy from the separate summarizer candidate model.
- Preserve OMP’s existing fixed-token, percentage, reserve fallback, clamping, event, session, and protocol behavior after policy materialization.

---

### Task 1: Define and resolve model compaction overlays

**Files:**
- Create: `packages/coding-agent/src/config/compaction-policy.ts`
- Modify: `packages/coding-agent/src/session/compaction/compaction.ts`
- Modify: `packages/coding-agent/src/session/compaction/index.ts`
- Test: `packages/coding-agent/test/compaction.test.ts`

**Interfaces:**
- Consumes: `Model` from `@oh-my-pi/pi-ai`; OMP’s exported `formatModelString(model)`; the full typed compaction settings group.
- Produces: `resolveCompactionSettingsForModel(settings, model?)` returning a fully materialized scalar `CompactionSettings` object; an absent active model returns the global scalar settings.
- Produces: `CompactionModelOverride`, a non-recursive partial over every scalar compaction field: `enabled`, `strategy`, `thresholdPercent`, `thresholdTokens`, `handoffSaveToDisk`, `remoteEnabled`, `reserveTokens`, `keepRecentTokens`, `autoContinue`, `remoteEndpoint`, `idleEnabled`, `idleThresholdTokens`, and `idleTimeoutSeconds`.

- [ ] **Step 1: Write failing pure-policy tests**

Add tests that construct a 1M model, a 500k model, and an unmatched 128k model, then assert:

```ts
const settings = {
  ...DEFAULT_COMPACTION_SETTINGS,
  thresholdTokens: -1,
  thresholdPercent: 70,
  modelOverrides: {
    "openai-codex/gpt-5.6-terra": { thresholdTokens: 225_000 },
    "openai-codex/*": { thresholdTokens: 200_000 },
  },
};

expect(resolveCompactionSettingsForModel(settings, terra)).toMatchObject({ thresholdTokens: 225_000 });
expect(resolveCompactionSettingsForModel(settings, fiveHundredK)).toMatchObject({ thresholdTokens: 200_000 });
expect(resolveCompactionSettingsForModel(settings, small)).toMatchObject({ thresholdTokens: -1, thresholdPercent: 70 });
```

Cover case-insensitive exact matching, exact-over-glob priority, first matching glob priority, global/project merged glob order, omitted-field inheritance, every allowed scalar field, invalid non-object entries, invalid field values, and absent/empty-map identity behavior.

- [ ] **Step 2: Run the focused policy tests to verify failure**

Run:

```bash
bun --cwd=packages/coding-agent test test/compaction.test.ts
```

Expected: FAIL because `resolveCompactionSettingsForModel` and `modelOverrides` do not exist.

- [ ] **Step 3: Implement the pure resolver**

Create `config/compaction-policy.ts` so configuration types do not depend on session code. Move the full `CompactionSettings` interface from `settings-schema.ts` into that module and add `modelOverrides` there as `Record<string, unknown>` at the configuration boundary. Export the scalar `ResolvedCompactionSettings` type and the non-recursive `CompactionModelOverride` type. Have both `settings-schema.ts` and `compaction.ts` import the shared type; keep `compaction.ts`’s public type export for existing consumers. Use `formatModelString(model).toLowerCase()` for canonical identity. Partition entries into exact and glob candidates. Check exact keys case-insensitively, then evaluate glob patterns in `Object.entries()` order with `new Glob(pattern.toLowerCase()).match(modelKey)`. Validate the complete override object before matching: reject arrays, unknown keys, wrong primitive types, non-finite numbers, invalid `strategy`, nested `modelOverrides`, and malformed patterns. Emit each invalid-map-entry warning once per merged map object through OMP’s logger, then skip that entry. Materialize a valid partial setting over a fresh scalar global object; do not cache materialized policies.

```ts
export function resolveCompactionSettingsForModel(
  settings: CompactionSettings,
  model: Model | undefined,
): ResolvedCompactionSettings {
  const base = withoutModelOverrides(settings);
  const override = model
    ? findModelCompactionOverride(settings.modelOverrides, formatModelString(model))
    : undefined;
  return override ? { ...base, ...override } : base;
}
```

Keep `shouldCompact`, `prepareCompaction`, and compaction execution on the resolved scalar settings, not map metadata. Re-export the resolver and settings types from the compaction barrel.

- [ ] **Step 4: Run focused policy tests to verify pass**

Run:

```bash
bun --cwd=packages/coding-agent test test/compaction.test.ts
```

Expected: PASS, including legacy threshold behavior without a map.

- [ ] **Step 5: Commit the isolated policy module**

```bash
git add packages/coding-agent/src/config/compaction-policy.ts packages/coding-agent/src/session/compaction/compaction.ts packages/coding-agent/src/session/compaction/index.ts packages/coding-agent/test/compaction.test.ts
git commit -m "feat: resolve per-model compaction settings"
```

### Task 2: Expose the additive settings map

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Test: `packages/coding-agent/test/settings-manager.test.ts`

**Interfaces:**
- Consumes: shared `CompactionSettings` and `CompactionModelOverride` types from `config/compaction-policy.ts`.
- Produces: `compaction.modelOverrides` through `settings.getGroup("compaction")` while retaining existing global settings and defaults.

- [ ] **Step 1: Write failing settings-layering tests**

Add a settings-manager fixture with global and project configuration:

```yaml
compaction:
  thresholdPercent: 70
  modelOverrides:
    "openai-codex/*":
      thresholdTokens: 200000
```

and a project overlay:

```yaml
compaction:
  modelOverrides:
    "openai-codex/gpt-5.6-terra":
      thresholdTokens: 225000
```

Assert `getGroup("compaction").modelOverrides` contains both rules in final deep-merged declaration order and existing configurations with no map return an empty map.

- [ ] **Step 2: Run settings tests to verify failure**

Run:

```bash
bun --cwd=packages/coding-agent test test/settings-manager.test.ts
```

Expected: FAIL because the schema does not expose `compaction.modelOverrides` through the typed group.

- [ ] **Step 3: Add the schema-backed setting**

Add `compaction.modelOverrides` as a `record` setting with an empty default and no `/settings` UI control. Type its record values as `CompactionModelOverride` while retaining raw-configuration boundary validation in the policy resolver. Replace the schema-local duplicate `CompactionSettings` declaration with the shared full type, so `Settings.getGroup("compaction")` exposes the map automatically. Reuse the existing settings deep-merge path; do not add a special configuration loader, runtime setting mutation, or alter existing defaults.

- [ ] **Step 4: Run settings tests to verify pass**

Run:

```bash
bun --cwd=packages/coding-agent test test/settings-manager.test.ts
```

Expected: PASS, proving agent/global plus project layering and no-map compatibility.

- [ ] **Step 5: Commit schema integration**

```bash
git add packages/coding-agent/src/config/settings-schema.ts packages/coding-agent/test/settings-manager.test.ts
git commit -m "feat: configure per-model compaction overrides"
```

### Task 3: Use effective settings for every compaction path

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Modify: `packages/coding-agent/src/modes/controllers/event-controller.ts`
- Test: `packages/coding-agent/test/agent-session-compaction.test.ts`
- Test: `packages/coding-agent/test/agent-session-auto-compaction-x-initiator.test.ts`
- Test: `packages/coding-agent/test/modes/controllers/event-controller-idle-compaction.test.ts`

**Interfaces:**
- Consumes: `resolveCompactionSettingsForModel(settings, activeModel)`.
- Produces: one resolved settings object per compaction trigger and execution using the active conversation model.

- [ ] **Step 1: Write failing session behavior tests**

Add tests that switch between two mock models and verify that the next completed response selects the active model’s policy. Include temporary model switching and a context-promotion scenario where the failed response uses the original model policy and the next completed response uses the promoted model policy. Add path assertions that manual compaction, threshold compaction, and overflow recovery receive the same resolved policy for an active model with overrides to `strategy`, `keepRecentTokens`, `remoteEnabled`, `remoteEndpoint`, `handoffSaveToDisk`, `autoContinue`, and threshold fields. Add idle-controller tests proving its enablement, threshold, and timeout are resolved against the session’s active model both when scheduling and when firing.

- [ ] **Step 2: Run session tests to verify failure**

Run:

```bash
bun --cwd=packages/coding-agent test test/agent-session-compaction.test.ts test/agent-session-auto-compaction-x-initiator.test.ts test/modes/controllers/event-controller-idle-compaction.test.ts
```

Expected: FAIL because `AgentSession` passes only the global compaction group to each compaction path.

- [ ] **Step 3: Resolve policy at the active-model boundary**

Add one private `AgentSession` helper that reads the global compaction group and calls the policy resolver for `this.model`. Use it in threshold evaluation and the automatic/manual/overflow execution paths, including handoff artifact saving. Pass the already resolved settings through the auto-compaction flow so `strategy`, remote settings, cut-point settings, continuation, and handoff behavior all agree on the same active-model policy. In `EventController`, resolve the global group against `this.ctx.session.model` before idle scheduling, retain that resolved snapshot in the timer closure, and re-resolve at fire time before the threshold re-check to handle an intervening model switch. Do not change compaction candidate selection; candidates remain summarizer selection only.

- [ ] **Step 4: Run session tests to verify pass**

Run:

```bash
bun --cwd=packages/coding-agent test test/agent-session-compaction.test.ts test/agent-session-auto-compaction-x-initiator.test.ts test/modes/controllers/event-controller-idle-compaction.test.ts
```

Expected: PASS for model switches, promotion, manual, threshold, overflow, and idle paths.

- [ ] **Step 5: Commit runtime integration**

```bash
git add packages/coding-agent/src/session/agent-session.ts packages/coding-agent/src/modes/controllers/event-controller.ts packages/coding-agent/test/agent-session-compaction.test.ts packages/coding-agent/test/agent-session-auto-compaction-x-initiator.test.ts packages/coding-agent/test/modes/controllers/event-controller-idle-compaction.test.ts
git commit -m "feat: apply compaction overrides by active model"
```

### Task 4: Document and validate the additive configuration API

**Files:**
- Modify: `docs/config-usage.md`
- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-21-per-model-compaction-overrides-design.md`
- Modify: `docs/superpowers/plans/2026-08-21-per-model-compaction-overrides.md`

**Interfaces:**
- Consumes: the finalized `compaction.modelOverrides` schema and resolver semantics.
- Produces: user-facing YAML reference and changelog entry that state opt-in compatibility and precedence.

- [ ] **Step 1: Write documentation acceptance examples**

Add a configuration example containing named 1M and 500k rules plus a global 70% fallback. State exact-before-glob precedence, first-matching-glob order, case-insensitive matching, partial inheritance, invalid-entry diagnostics, normal global/project merge semantics, and all-path application.

- [ ] **Step 2: Run documentation index generation**

Run:

```bash
bun --cwd=packages/coding-agent run generate-docs-index
```

Expected: PASS and update the generated documentation index only if the repository’s generator changes it.

- [ ] **Step 3: Add changelog entry and align design artifacts**

Add a user-facing changelog entry describing opt-in per-model compaction overrides and no behavior change without configuration. Update the spec and plan only if implementation revealed a decision mismatch; otherwise leave their approved semantics unchanged.

- [ ] **Step 4: Run focused verification**

Run:

```bash
bun --cwd=packages/coding-agent test test/compaction.test.ts test/settings-manager.test.ts test/agent-session-compaction.test.ts test/agent-session-auto-compaction-x-initiator.test.ts test/modes/controllers/event-controller-idle-compaction.test.ts
bun check:ts
```

Expected: PASS.

- [ ] **Step 5: Commit documentation and verification changes**

```bash
git add docs/config-usage.md packages/coding-agent/CHANGELOG.md docs/superpowers/specs/2026-08-21-per-model-compaction-overrides-design.md docs/superpowers/plans/2026-08-21-per-model-compaction-overrides.md packages/coding-agent/src/internal-urls/docs-index.generated.ts
git commit -m "docs: describe per-model compaction overrides"
```

## Plan Self-Review

- **Spec coverage:** Task 1 implements matching, inheritance, diagnostics, and compatibility; Task 2 exposes the additive settings map and layered configuration; Task 3 applies the effective policy across all required paths; Task 4 documents the public API and verifies the complete changed contract.
- **Placeholder scan:** No unresolved placeholders, deferred work, or unspecified test behavior remains.
- **Type consistency:** `CompactionModelOverride` and `resolveCompactionSettingsForModel` are defined in Task 1 and consumed by Tasks 2 and 3; `compaction.modelOverrides` is the single public configuration key throughout.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-21-per-model-compaction-overrides.md`. The lifecycle continues with issue creation, triage, and BGraph-governed execution.
