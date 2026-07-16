# Wave 1 Integration Summary

**Source commit:** `dfbe6de9b7` (`successor: close standalone kernel Wave 1`)
**Date:** 2026-07-16

This reviewed summary converts local ignored orchestration evidence into tracked extraction evidence. The local run logs themselves were not canonical and are not represented as history-preserved artifacts.

Wave 1 consolidated bounded read, mutation, process, registry, provider hydration, and self-hosted coding evidence.

Verified:

- `git diff --check`, Rust formatting, Clippy with warnings denied, Cargo check, and `cargo test --workspace --all-targets` passed;
- isolated fail-before/pass-after proofs fired for all four lanes;
- canonical success lifecycle is `tool_call.requested < tool_result.recorded < tool_call.completed`;
- direct Anthropic adapter, kernel transport/replay, full S8 coding workflow, and owner-observed manual CLI safe-read passed;
- exact workspace repair, focused Cargo execution, replay/resume, and credential scans passed;
- proxy-path 401/503 observations were corrected as ambient Better ccflare routing, not direct Anthropic failures. See `crates/successor-kernel/LIVE-PROVIDER.md`.

One load-sensitive process-capture failure did not reproduce: the exact test passed 5/5, its target passed, and the full workspace passed on retry. It remains a residual rather than a hidden success claim.

Generated SQLite/WAL state and raw live-session data are excluded from extraction evidence.
