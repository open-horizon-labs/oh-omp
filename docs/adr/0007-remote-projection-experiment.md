# ADR 0007: Bounded Remote Projection Experiment

- Status: Accepted (scope amendment; experiment not implemented)
- Date: 2026-09-27
- Decision makers: Principal and harness maintainers
- Scope: [open-horizon-labs/oh-kernel#776](https://github.com/open-horizon-labs/oh-kernel/issues/776)
- Authorization: principal authorization dispatch `cd1362f7-02c0-4343-8f9e-092378a78d86`
- Depends on: ADR 0001 (constrained fork strategy), ADR 0002 (RPC compatibility contract; read-only)

## Context

ADR 0001 makes context assembly, observability, provenance, and bounded budget enforcement the narrow additive scope of this fork. Issue #776 requires a bounded experiment that may need additive harness support for remote projections and user interventions. The existing context-only wording would otherwise prohibit that narrowly authorized work.

This is an exception for one experiment, not a new general mission for the fork. The issue's proposed logical projection and intervention operations are design inputs, not shipped API signatures. This ADR does not choose a wire protocol, claim that a projection bridge or renderer already exists, or authorize a new runtime.

The experiment spans repositories. This ADR governs only the harness portion: any harness change must preserve the kernel's existing compatibility, principal/session authority, and secret-custody boundaries. Kernel and mobile changes remain subject to their own review and contracts.

## Decision

Authorize a bounded, additive, compatibility-preserving, opt-in remote projection/interaction experiment for issue #776. The authorization permits only the harness work needed to test the issue's hypothesis and does not authorize a product surface, a release, a deployment, or a broad expansion of the fork's mission.

### Existing runtime reuse

Any implementation proposed under this ADR must use the harness's existing runtime seams, including extension tools or handlers, structured session state/history, existing event surfaces, context integration, and agent controls, where those seams are applicable. It must not introduce a second agent runtime, session engine, memory/context manager, or generic distributed-state system. Existing principal/session routing and secret custody remain authoritative.

The experiment is limited to the two bounded proof cases and evidence described by issue #776. It does not authorize a fixed widget catalog, a universal widget or UI DSL, indiscriminate transport of all tool details, automatic discovery/generalization, or migration of every existing tool to a new schema.

### Compatibility and unchanged defaults

ADR 0002 remains the compatibility authority. Additions must preserve event names, lifecycle semantics, completion signaling, and the versioned RPC/SSE contract; no breaking change may be hidden inside this experiment. Existing terminal and headless commands, interaction lifecycles, and failure behavior remain unchanged.

Remote projection is opt-in. A disabled, unavailable, incompatible, or failed projection consumer must not prevent ordinary terminal/headless operation or change existing command behavior. Every implementation PR that introduces a compatibility seam must include mixed-version compatibility checks for the relevant existing/new harness and consumer combinations, including confirmation that the existing contract still behaves correctly. This requirement does not prescribe a transport or wire format.

### Browser and generated-content boundary

A browser or phone view is an optional consumer and is not on the critical path. The experiment must remain useful for compatibility and terminal/headless verification without a browser.

Generated or extension-authored HTML/CSS/JS is presentation data in an isolated view, not an execution authority or a trusted sandbox. It must not receive host credentials, arbitrary host access, arbitrary tool invocation, or arbitrary privileged code execution. Effectful operations must continue through existing trusted host authorization and accurate target/action handling. If the required isolation and egress boundaries cannot be met within the experiment budget, stop and report the failure rather than weakening them or substituting a generic prompt/chip UI.

### Review and stop conditions

Every PR implementing this exception requires principal review before merge. The issue and this ADR authorize no merge, release, production deployment, or autonomous follow-on work.

The experiment has a fixed budget of five focused engineering days. At the budget boundary, stop and report evidence, limitations, and a proceed/stop/narrow verdict. Any further iteration requires a named remaining hypothesis, an explicit new cap, and fresh authorization.

Stop and return for re-evaluation if the work requires a breaking protocol change, changes existing terminal/headless behavior, puts a browser on the critical path, introduces a second runtime or context manager, grants arbitrary privileged generated code, transports unrelated tool details, or cannot satisfy the isolation/authority boundary. Such a change needs a new decision; it is not covered by this exception.

## Consequences

### Positive

- The harness can support the narrow #776 experiment without silently contradicting ADR 0001.
- Terminal/headless users and existing orchestrators retain the default path and compatibility contract.
- Reusing existing runtime seams keeps authority, persistence, and failure behavior inspectable.
- Explicit mixed-version checks and principal review make incremental cross-repository work visible before merge.

### Negative

- The experiment adds review and compatibility work without becoming a supported general remote UI platform.
- Some useful-looking features must remain out of scope until a separate decision authorizes them.
- An isolation or compatibility failure may end the experiment rather than permit a weaker implementation.

## Verification and evidence

- Canonical acceptance contract: issue [#776](https://github.com/open-horizon-labs/oh-kernel/issues/776).
- Authorization evidence: dispatch `cd1362f7-02c0-4343-8f9e-092378a78d86` on 2026-09-27.
- Compatibility authority: [ADR 0002](0002-rpc-compatibility-contract.md), which this amendment does not edit.
- The expected verification for later implementation PRs is focused mixed-version compatibility and boundary evidence; this documentation-only amendment requires no tests or build.
