# Per-Model Compaction Overrides Design

## Goal

Allow OMP operators to opt into model-specific compaction policies while preserving every existing compaction behavior when no override map is configured.

## Configuration

`compaction.modelOverrides` is an ordered map in the existing agent/project settings surface. Each key is either a canonical `provider/model-id` key or a Bun glob pattern. Each value is a partial overlay of the global compaction settings; it may override every supported compaction field except `modelOverrides`, which is not recursive.

Settings retain normal global-to-project deep-merge behavior. The effective map is evaluated as follows:

1. Match the active conversation model against exact keys, case-insensitively.
2. If no exact key matches, evaluate glob keys case-insensitively in final merged declaration order; the first match wins.
3. If no rule matches, use global compaction settings unchanged.

Malformed override entries produce an OMP settings diagnostic and are ignored. The next valid matching rule or global settings apply.

## Effective Policy

A pure resolver receives the global compaction settings and active conversation model, then returns a fully materialized effective settings object. It reuses OMP’s canonical model formatter and Bun glob primitive. The implementation must not cache resolved settings because temporary model switches and context promotion can change the active model between turns.

The effective policy applies to manual compaction, post-turn threshold maintenance, overflow recovery, and idle compaction. It always belongs to the active conversation model, not an alternate candidate selected to generate a compaction summary.

After a model overlay is materialized, existing OMP threshold behavior is unchanged: positive fixed token limits win over percentages; percentage limits win over legacy reserve-based thresholds; existing clamps remain authoritative.

## Compatibility

The feature is additive and opt-in. When `compaction.modelOverrides` is absent, empty, or has no matching valid rule, OMP uses the same global settings, defaults, sessions, event contracts, and compaction behavior it used before this feature.

No `/settings` editor, automatic context-window tiering, recursive override maps, session migration, protocol change, or new compaction strategy is part of the feature.

## Validation and Diagnostics

The map follows the established agent-settings configuration surface. Individual invalid entries must be diagnosed and skipped without replacing valid global settings or disabling the rest of the map. Unknown model keys remain valid configuration: custom and late-discovered models may become available after startup.

## Verification

Tests must establish exact and glob matching, ordered glob precedence, case-insensitivity, partial inheritance of every allowed compaction field, invalid-entry fallback, global/project layering, unchanged no-map behavior, model-switch behavior, context-promotion behavior, and equivalent effective-policy use across manual, threshold, overflow, and idle compaction paths.
