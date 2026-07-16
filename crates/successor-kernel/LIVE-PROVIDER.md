# Successor Live-Provider Runbook

## Purpose

Use this runbook for every live Anthropic gate in the successor workstream. The developer shell is intentionally proxy-configured, so ambient `ANTHROPIC_*` variables do not prove that a command is using Anthropic directly.

## Configuration hazard

The shell can contain two distinct provider configurations at the same time:

- `DIRECT_ANTHROPIC_API_KEY`: the credential for direct calls to Anthropic.
- `ANTHROPIC_API_KEY`: the credential consumed by successor; ambiently this may be a Better ccflare/proxy credential rather than the direct credential.
- `ANTHROPIC_BASE_URL`: ambiently this may point at the Better ccflare proxy rather than `https://api.anthropic.com`.

Successor reads `ANTHROPIC_API_KEY`; it does not automatically substitute `DIRECT_ANTHROPIC_API_KEY`. A command that sets only `SUCCESSOR_LIVE_PROVIDER_SMOKE=1` can therefore exercise the proxy while appearing to be a direct-provider test.

The known proxy configuration uses `http://100.79.84.159:8888`. HTTP 401 or 503 from a command that inherited that URL is proxy-path evidence, not direct-Anthropic evidence.

## Mandatory rules

1. Never rely on ambient `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` for a direct gate.
2. Pin the direct key mapping and official URL on the same command invocation.
3. Pin the model explicitly; the Wave 1 proven model is `claude-sonnet-4-6`.
4. Use command-scoped environment assignments. Do not globally overwrite the proxy configuration merely to run a gate.
5. Never print either key. Preflight may report only whether variables are set and whether their values match.
6. Pass the low-cost adapter and kernel controls before running full S8.
7. Attribute an error only after identifying which boundary returned it: proxy, Anthropic, context platform, or kernel assertion.

## Secret-safe preflight

```bash
if [[ -n "${DIRECT_ANTHROPIC_API_KEY:-}" ]]; then
  echo "DIRECT_ANTHROPIC_API_KEY=set"
else
  echo "DIRECT_ANTHROPIC_API_KEY=unset"
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY=set"
else
  echo "ANTHROPIC_API_KEY=unset"
fi

if [[ -n "${DIRECT_ANTHROPIC_API_KEY:-}" &&
      -n "${ANTHROPIC_API_KEY:-}" &&
      "$DIRECT_ANTHROPIC_API_KEY" == "$ANTHROPIC_API_KEY" ]]; then
  echo "ambient_credential_binding=direct"
else
  echo "ambient_credential_binding=not-direct"
fi

printf 'ambient_ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-<unset>}"
```

`ambient_credential_binding=not-direct` is expected in a proxy-configured shell. It is not a blocker because every direct command below overrides both values locally.

## Canonical direct prefix

Apply these assignments to each command rather than exporting them globally:

```bash
ANTHROPIC_API_KEY="$DIRECT_ANTHROPIC_API_KEY" \
ANTHROPIC_BASE_URL="https://api.anthropic.com" \
SUCCESSOR_LIVE_PROVIDER_SMOKE=1 \
SUCCESSOR_LIVE_PROVIDER_MODEL="claude-sonnet-4-6" \
<command>
```

## Gate sequence

Run from the repository root.

### 1. Adapter-only canary

This is the cheapest typed authentication/provider check. It calls Anthropic directly and does not involve the context platform or kernel tool loop.

```bash
ANTHROPIC_API_KEY="$DIRECT_ANTHROPIC_API_KEY" \
ANTHROPIC_BASE_URL="https://api.anthropic.com" \
SUCCESSOR_LIVE_PROVIDER_SMOKE=1 \
SUCCESSOR_LIVE_PROVIDER_MODEL="claude-sonnet-4-6" \
cargo test -p successor-kernel \
  provider::anthropic::tests::live_smoke_against_real_anthropic_messages_api \
  -- --exact --nocapture
```

### 2. Kernel transport and replay canary

```bash
ANTHROPIC_API_KEY="$DIRECT_ANTHROPIC_API_KEY" \
ANTHROPIC_BASE_URL="https://api.anthropic.com" \
SUCCESSOR_LIVE_PROVIDER_SMOKE=1 \
SUCCESSOR_LIVE_PROVIDER_MODEL="claude-sonnet-4-6" \
cargo test -p successor-kernel --test slice0_end_to_end \
  live_smoke_against_the_real_anthropic_messages_api_produces_a_replayable_terminal_frame \
  -- --ignored --exact --nocapture
```

Acceptance requires terminal `turn_completed`; process exit alone is insufficient.

### 3. Full S8 coding gate

Run only after both controls pass.

```bash
ANTHROPIC_API_KEY="$DIRECT_ANTHROPIC_API_KEY" \
ANTHROPIC_BASE_URL="https://api.anthropic.com" \
SUCCESSOR_LIVE_PROVIDER_SMOKE=1 \
SUCCESSOR_LIVE_PROVIDER_MODEL="claude-sonnet-4-6" \
cargo test -p successor-kernel --test slice0_end_to_end \
  s8_live_anthropic_provider_repairs_disposable_rust_crate_and_replays_after_resume \
  -- --ignored --exact --nocapture
```

Acceptance requires the test's complete contract: successful tool lifecycle, exact mutation, passing focused Cargo invocation, terminal `turn_completed`, replay/resume equality, and secret scans.

### 4. Manual CLI safe-read gate

This gate has two independent credentials:

- Anthropic: direct mapping shown above.
- Context platform: `MEMEX_LICENSE` must be valid for the selected `--platform-url`.

Verify the platform URL and entitlement before launching the CLI. A platform response such as `401 auth_required: invalid platform entitlement` occurs before the provider path and says nothing about the direct Anthropic key.

```bash
ANTHROPIC_API_KEY="$DIRECT_ANTHROPIC_API_KEY" \
ANTHROPIC_BASE_URL="https://api.anthropic.com" \
./target/debug/successor-cli ask \
  --workspace-root "$PWD" \
  --platform-url "$SUCCESSOR_CONTEXT_PLATFORM_URL" \
  --model "claude-sonnet-4-6" \
  --tool-authority "safe_read" \
  --tool-authority-ceiling "safe_read" \
  --prompt "Read the root Cargo.toml and summarize the successor crates. Do not modify anything." \
  --format text
```

Acceptance requires a success terminal, not merely process exit zero.

## Failure attribution

| Observed failure | Required interpretation |
|---|---|
| HTTP 401/503 while ambient base URL points at Better ccflare | Proxy-path failure; do not attribute it to direct Anthropic. |
| HTTP 401 with the official URL and explicit direct-key mapping | Direct credential rejection; verify the direct key without printing it. |
| `platform returned 401 auth_required: invalid platform entitlement` | Context-platform entitlement failure before Anthropic. Verify `MEMEX_LICENSE` and `--platform-url`. |
| Kernel assertion reports only `turn_failed` | Inspect the persisted terminal payload or run the adapter canary; the assertion alone does not identify the boundary. |
| Adapter canary passes but kernel canary fails | Authentication and direct transport work; investigate kernel/provider projection separately. |
| Kernel canary passes but S8 fails | Investigate tool lifecycle, authority, workspace mutation, process execution, or replay; do not relabel it as transport failure. |

## Proven result

On 2026-07-16, with the command-scoped direct mapping, official URL, and `claude-sonnet-4-6`:

- adapter-only canary: PASS;
- kernel transport/replay canary: PASS;
- full S8 coding gate: PASS in 18.9 seconds.

The immediately preceding HTTP 401/503 and `turn_failed` observations inherited the ambient Better ccflare configuration and were not direct-Anthropic failures.
