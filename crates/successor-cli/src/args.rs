//! Owned by Lane D1 `SuccessorCliCore`: clap grammar for the CLI's ruled
//! command surface (dissent ruling `238-D1PreExecutionDissent`, ruling 2 and
//! ruling 4).
//!
//! Grammar is exact per the binding ruling:
//! ```text
//! successor-cli ask --workspace-root <path> --prompt <text> [--model <name>] [--kernel-url <url>] [--platform-url <url>] [--format text|sse]
//! successor-cli resume --session-id <ses_...> [--kernel-url <url>] [--platform-url <url>] [--format json|text]
//! successor-cli inspect session --session-id <ses_...> [--kernel-url <url>] [--platform-url <url>] [--format json|text]
//! ```
//!
//! Forbidden shapes are rejected by clap itself rather than by hand-rolled
//! validation, so the rejection is a normal usage error (exit code 2, ruling
//! 6):
//! - `ask --session-id ...` -- [`AskArgs`] simply has no such field, so clap
//!   reports it as an unrecognized argument.
//! - `--platform-url` together with `--kernel-url` -- rejected via
//!   `conflicts_with` on every subcommand that accepts both.
//! - `ask --format json` -- [`AskFormat`] only has `Text`/`Sse` variants;
//!   `json` is not a valid value for the `--format` argument.
//! - An env-var alias for `--kernel-url` -- clap's `env` feature is not enabled
//!   for this crate (ruling 4), and no `env(..)` attribute is used here, so
//!   `--kernel-url` can only ever be set from the command line.
//! - `ask --workspace-root <relative-path>` -- a custom `value_parser` rejects
//!   it at parse time (clap usage error, exit code 2), naming the flag and
//!   requiring an absolute path, before any kernel or platform request is made
//!   in either mode (Lane 4 `262-Lane4DxFixesDissent`).
//!
//! `ask --model` is an owner-authorized post-D1 grammar widening
//! (2026-07-06): it configures the in-process bootstrap's provider model, so
//! it is rejected together with `--kernel-url` (an external kernel fixes its
//! model at construction, server-side).

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
	name = "successor-cli",
	about = "Stateless CLI over the successor kernel's frozen RPC/SSE surface"
)]
pub struct Cli {
	#[command(subcommand)]
	pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
	/// Start a turn. Always creates a fresh, runner-owned session -- there
	/// is no `--session-id` on this command (C8 session-semantics ruling:
	/// submitting a turn is never "continuing" an existing session).
	Ask(AskArgs),
	/// Read back the accumulated event history and provider-auth status of
	/// an existing session.
	Resume(ResumeArgs),
	/// Inspect kernel-visible session state without starting or continuing
	/// a turn.
	Inspect(InspectArgs),
}

/// `ask`'s `--format`: human text (default) or byte-exact SSE pass-through.
/// `json` is deliberately not a variant: `ask` streams kernel frames, it
/// does not return a single JSON body (ruling 2 forbids `ask --format
/// json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[value(rename_all = "lower")]
pub enum AskFormat {
	Text,
	Sse,
}

/// `resume`/`inspect session`'s `--format`: byte-exact JSON pass-through
/// (default) or human text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[value(rename_all = "lower")]
pub enum ReadFormat {
	Json,
	Text,
}

/// Rejects a relative `--workspace-root` as a clap usage error (exit code
/// 2) at parse time, before `establish_kernel`/any kernel or platform
/// request is made -- in both in-process-bootstrap and `--kernel-url`
/// modes, since clap parses every argument unconditionally regardless of
/// which mode is later selected. Previously a relative path was accepted
/// here and only surfaced as an opaque platform 404 mid-turn.
fn parse_absolute_workspace_root(value: &str) -> Result<PathBuf, String> {
	let path = PathBuf::from(value);
	if path.is_absolute() {
		Ok(path)
	} else {
		Err(format!(
			"--workspace-root requires an absolute path (got {value:?}); relative paths are rejected \
			 before any kernel or platform request is made"
		))
	}
}

#[derive(Debug, Args)]
pub struct AskArgs {
	/// Workspace root the in-process kernel bootstraps its tool execution
	/// context against. Required even when `--kernel-url` targets an
	/// external kernel, since the workspace identity is per-turn, not
	/// per-kernel-instance.
	#[arg(long, value_parser = parse_absolute_workspace_root)]
	pub workspace_root: PathBuf,

	/// The user text for this turn.
	#[arg(long)]
	pub prompt: String,

	/// Drive an already-running kernel over its frozen HTTP/SSE surface
	/// instead of bootstrapping an ephemeral in-process one for this
	/// invocation. This mode reads no secrets (ruling 5).
	#[arg(long, conflicts_with = "platform_url")]
	pub kernel_url: Option<String>,

	/// Override the in-process kernel's platform base URL (in place of
	/// `SUCCESSOR_CONTEXT_PLATFORM_URL`/the kernel's own default).
	/// Rejected together with `--kernel-url` (ruling 2): it only has
	/// meaning when this invocation is the one bootstrapping the kernel.
	#[arg(long)]
	pub platform_url: Option<String>,

	/// Anthropic model for the in-process kernel's provider factory
	/// (owner-authorized post-D1 widening). Only meaningful when this
	/// invocation bootstraps the kernel, so it conflicts with
	/// `--kernel-url`.
	#[arg(long, default_value = crate::client::DEFAULT_MODEL, conflicts_with = "kernel_url")]
	pub model: String,

	#[arg(long, value_enum, default_value_t = AskFormat::Text)]
	pub format: AskFormat,
}

#[derive(Debug, Args)]
pub struct ResumeArgs {
	/// The session to read back. Not continued -- this is a fresh
	/// read-only snapshot/event-page/provider-auth resolution on every
	/// call.
	#[arg(long)]
	pub session_id: String,

	#[arg(long, conflicts_with = "platform_url")]
	pub kernel_url: Option<String>,

	#[arg(long)]
	pub platform_url: Option<String>,

	#[arg(long, value_enum, default_value_t = ReadFormat::Json)]
	pub format: ReadFormat,
}

#[derive(Debug, Args)]
pub struct InspectArgs {
	#[command(subcommand)]
	pub command: InspectCommand,
}

#[derive(Debug, Subcommand)]
pub enum InspectCommand {
	/// Attach to an existing session's platform snapshot for inspection.
	/// This is inspection only: it never continues a turn and never
	/// mutates session state. `ask` is the only command that starts a
	/// turn, and it always starts a fresh runner-owned session.
	Session(InspectSessionArgs),
}

#[derive(Debug, Args)]
pub struct InspectSessionArgs {
	/// The session to inspect. Inspecting a session never continues or
	/// restarts a turn on it.
	#[arg(long)]
	pub session_id: String,

	#[arg(long, conflicts_with = "platform_url")]
	pub kernel_url: Option<String>,

	#[arg(long)]
	pub platform_url: Option<String>,

	#[arg(long, value_enum, default_value_t = ReadFormat::Json)]
	pub format: ReadFormat,
}
