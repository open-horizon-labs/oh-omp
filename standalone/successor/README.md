# Successor Agent Kernel

A headless, replayable agentic execution kernel.

The workspace contains:

- `successor-protocol`: canonical event, frame, tool, provider, and replay contracts;
- `successor-kernel`: turn lifecycle, provider projection, authority, tools, and replay semantics;
- `successor-cli`: command-line client and local-kernel bootstrap;
- `successor-context-platform`: reference/integration implementation for journal and context ports.

The context platform is included to preserve black-box proof; it is not permanent kernel product ownership. UI, intake, embeddings, and retrieval products remain external.

Architecture is frozen by `docs/adr/0007-standalone-successor-repository-and-port-ownership.md`. Wave 3 candidates are non-authoritative rehearsal artifacts until the source-retirement and authority-flip protocol completes.

## Development

```sh
make check-rs
make test-rs
```

Direct Anthropic gates must follow `crates/successor-kernel/LIVE-PROVIDER.md`; ambient proxy configuration is not direct-provider evidence.
