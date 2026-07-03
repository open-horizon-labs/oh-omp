# Slice 0 Launch Prep Summary

**Status:** ready for Wave A execution after human runbook confirmation.

## Durable role agents

Materialized in runtime-discovered agent directory `/Users/drazen/.claude/agents`:

| Agent | Model | Thinking | Canary |
|---|---|---|---|
| `slice0-coder` | `anthropic/claude-sonnet-4-6` | `high` | `agent://17-PermanentCoderCanary` PASS |
| `slice0-executor` | `anthropic/claude-sonnet-4-6` | `high` | `agent://19-PermanentExecutorCanary` PASS |
| `slice0-prepper` | `openai-codex/gpt-5.5` | `high` | `agent://14-PermanentPrepperCanary` PASS |
| `slice0-reviewer` | `openai-codex/gpt-5.5` | `high` | `agent://15-PermanentReviewerCanary` PASS |
| `slice0-drift-reviewer` | `openai-codex/gpt-5.5` | `high` | `agent://18-PermanentDriftReviewerCanary` PASS |
| `slice0-superego-reviewer` | `openai-codex/gpt-5.5` | `high` | `agent://16-PermanentSuperegoReviewerCanary` PASS |
| `slice0-verifier` | `openai-codex/gpt-5.5` | `high` | `agent://20-PermanentVerifierCanary` PASS |

## Wave A packet stubs

Created:

- `A0-WorkspaceBootstrap.md`
- `A1-ProtocolIdsErrorsRaw.md`
- `A2-ProtocolFramesPlatformDtos.md`
- `A3-ProtocolProviderNormalization.md`
- `A4-ProtocolReplayProjection.md`
- `A5-ProtocolFixtureValidator.md`

Each packet includes model-binding evidence, aim, problem space, solution space, dissent placeholder, execute checklist, code review section, drift review section, Superego section, and delivery section.

## Remaining launch gates

- Human confirms this runbook/run packet set.
- Each actual `task` assignment must attach the runbook, dispatch map, lane packet path, owned files, non-goals, and required review gates.
- No Wave B+ work may start until A1/A3/A4/A5 expose compile-checked shared types and fixture gates.

## Explicit non-claim

This run is **not** a DeepSeek coding evaluation. Execution/coding lanes are Sonnet 4.6 high.
