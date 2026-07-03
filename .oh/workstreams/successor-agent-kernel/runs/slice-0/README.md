# Slice 0 Run Packets

Launch prep created this directory for horde lane evidence.

## Active model roster

| Role label | Model | Thinking | Status |
|---|---|---|---|
| `slice0-coder` | `anthropic/claude-sonnet-4-6` | `high` | durable agent materialized; discovery verified; canary passed (`agent://17-PermanentCoderCanary`) |
| `slice0-executor` | `anthropic/claude-sonnet-5` | `high` | user-accepted 2026-07-02 after three-gate experiment (canary §14); previously `anthropic/claude-sonnet-4-6` (`agent://19-PermanentExecutorCanary`); rebind canary evidence in canary §14 |
| `slice0-prepper` | `openai-codex/gpt-5.5` | `high` | durable agent materialized; discovery verified; canary passed (`agent://14-PermanentPrepperCanary`) |
| `slice0-reviewer` | `openai-codex/gpt-5.5` | `high` | durable agent materialized; discovery verified; canary passed (`agent://15-PermanentReviewerCanary`) |
| `slice0-drift-reviewer` | `openai-codex/gpt-5.5` | `high` | durable agent materialized; discovery verified; canary passed (`agent://18-PermanentDriftReviewerCanary`) |
| `slice0-superego-reviewer` | `openai-codex/gpt-5.5` | `high` | durable agent materialized; discovery verified; canary passed (`agent://16-PermanentSuperegoReviewerCanary`) |
| `slice0-verifier` | `openai-codex/gpt-5.5` | `high` | durable agent materialized; discovery verified; canary passed (`agent://20-PermanentVerifierCanary`) |
| `slice0-glm-executor` | `zai/glm-5.2` | `high` | experiment closed: no-op canaries passed (`agent://105`, `agent://107`) but bounded clippy execution task stalled 1h07m and was cancelled with no edits; not eligible for execution roster |
| `slice0-sonnet5-executor` | `anthropic/claude-sonnet-5` | `high` | experiment accepted and promoted to the active `slice0-executor` binding (2026-07-02); experimental label retired |

Permanent-label live canaries passed on all durable Slice 0 role labels.

## Launch rule

Wave A starts with A0, then A1. A3/A4/A5 depend on A1 shared protocol foundations. No Wave B+ implementation starts until A1/A3/A4/A5 expose compile-checked shared types and fixture gates.
