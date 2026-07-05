//! Owned by Lane D1 `SuccessorCliCore`: the stateless CLI over the frozen
//! successor kernel RPC/SSE surface (dissent ruling
//! `238-D1PreExecutionDissent`).
//!
//! Every invocation either bootstraps its own ephemeral in-process kernel or
//! drives an already-running one named by `--kernel-url` (ruling 1). Nothing
//! survives process exit: no daemon, no PID file, no local session store.

mod args;
mod client;
mod render;

use clap::Parser as _;

use crate::args::{Cli, Command, InspectCommand};

#[tokio::main]
async fn main() -> std::process::ExitCode {
	let cli = Cli::parse();

	let result = match cli.command {
		Command::Ask(ask_args) => client::run_ask(ask_args).await,
		Command::Resume(resume_args) => client::run_resume(resume_args).await,
		Command::Inspect(inspect_args) => match inspect_args.command {
			InspectCommand::Session(session_args) => client::run_inspect_session(session_args).await,
		},
	};

	match result {
		Ok(()) => std::process::ExitCode::SUCCESS,
		Err(code) => std::process::ExitCode::from(code),
	}
}
