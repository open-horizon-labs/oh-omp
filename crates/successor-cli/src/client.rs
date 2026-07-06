//! Owned by Lane D1 `SuccessorCliCore`: kernel reachability (dissent ruling
//! rule 1) plus the HTTP/SSE client over the four frozen kernel routes, and
//! the per-command RPC drivers.
//!
//! Two mutually exclusive reachability modes, selected by `--kernel-url`:
//! - In-process bootstrap (default): binds an ephemeral loopback listener,
//!   constructs `AppState` through the kernel's own public constructors
//!   ([`AppState::with_anthropic`]), and serves it via
//!   [`successor_kernel::http::serve`] for the lifetime of this single
//!   invocation. `MEMEX_LICENSE`, `SUCCESSOR_CONTEXT_PLATFORM_URL`, and
//!   `ANTHROPIC_API_KEY` are read only through the kernel's own C3 config/auth
//!   seams -- this module never reads those values itself.
//! - External kernel (`--kernel-url <url>`): a pure HTTP/SSE client against an
//!   already-running kernel. Reads no secrets (ruling 5).
//!
//! No daemon, no PID file, no cross-invocation state (ruling 1): every
//! invocation either bootstraps its own ephemeral kernel or connects to one
//! named by `--kernel-url`; nothing survives process exit. The in-process
//! server's [`tokio::task::JoinHandle`] is aborted when [`KernelHandle`]
//! drops, so no ephemeral server outlives the command that started it.

use std::{path::PathBuf, sync::Arc};

use futures_util::StreamExt as _;
use reqwest::header::CONTENT_TYPE;
use successor_kernel::{
	config::{PLATFORM_URL_ENV, process_env_lookup, resolve_platform_entitlement_config},
	http::{AppState, serve},
	id_factory::{Clock, IdFactory, RealClock, RealIdFactory},
	platform_client::KernelPlatformClient,
};
use successor_protocol::kernel_frame::{KernelFrameKindV0, KernelFrameV0};
use tokio::net::TcpListener;

use crate::{
	args::{AskArgs, AskFormat, InspectSessionArgs, ReadFormat, ResumeArgs},
	render,
};

/// Default Anthropic model for the in-process bootstrap's provider factory:
/// the clap default for `ask --model` (owner-authorized post-D1 widening,
/// 2026-07-06) and the fixed wiring for `resume`/`inspect` bootstraps, which
/// never run turns.
pub const DEFAULT_MODEL: &str = "claude-sonnet-5";
/// Default `max_tokens` for the in-process bootstrap's provider factory.
const DEFAULT_MAX_TOKENS: u32 = 32768;

/// Bucketed process exit codes (dissent ruling 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitBucket {
	/// 3: in-process bootstrap/config failure before RPC was available.
	Bootstrap,
	/// 4: transport/protocol failure without a kernel `ErrorEnvelopeV0`.
	Transport,
	/// 5: kernel-returned typed error envelope / non-success RPC result.
	KernelResult,
}

impl ExitBucket {
	const fn code(self) -> u8 {
		match self {
			Self::Bootstrap => 3,
			Self::Transport => 4,
			Self::KernelResult => 5,
		}
	}
}

/// A failure this process reports on stderr before exiting. `message` never
/// carries `MEMEX_LICENSE`/provider credential values: bootstrap failures
/// name the missing variable, never its value; transport failures carry
/// only `reqwest::Error`'s own display (URL + reason, never header values).
struct CliFailure {
	bucket:  ExitBucket,
	message: String,
}

impl CliFailure {
	fn bootstrap(message: impl Into<String>) -> Self {
		Self { bucket: ExitBucket::Bootstrap, message: message.into() }
	}

	fn transport(message: impl Into<String>) -> Self {
		Self { bucket: ExitBucket::Transport, message: message.into() }
	}

	/// Prints the failure to stderr and returns the exit code to propagate.
	fn report(self) -> u8 {
		eprintln!("{}", self.message);
		self.bucket.code()
	}
}

/// A reachable kernel for the lifetime of this invocation: either an
/// ephemeral in-process one this process just bootstrapped, or an external
/// one named by `--kernel-url`.
struct KernelHandle {
	base_url:        String,
	http:            reqwest::Client,
	// Held only to keep the ephemeral in-process server alive for this
	// invocation; aborted on drop. `None` in external-kernel mode.
	in_process_task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for KernelHandle {
	fn drop(&mut self) {
		if let Some(handle) = self.in_process_task.take() {
			handle.abort();
		}
	}
}

/// Establishes reachability per dissent ruling 1. `platform_url_override`
/// only has an effect in the in-process bootstrap path (external mode never
/// reads it -- clap's `conflicts_with` already rejects supplying both).
async fn establish_kernel(
	kernel_url: Option<String>,
	platform_url_override: Option<String>,
	workspace_root: PathBuf,
	model: String,
) -> Result<KernelHandle, CliFailure> {
	if let Some(url) = kernel_url {
		return Ok(KernelHandle {
			base_url:        url.trim_end_matches('/').to_owned(),
			http:            reqwest::Client::new(),
			in_process_task: None,
		});
	}

	let lookup = move |name: &str| -> Option<String> {
		if name == PLATFORM_URL_ENV
			&& let Some(value) = &platform_url_override
		{
			return Some(value.clone());
		}
		process_env_lookup(name)
	};
	let entitlement = resolve_platform_entitlement_config(lookup).map_err(|_err| {
		CliFailure::bootstrap(
			"in-process mode requires MEMEX_LICENSE to be set (and non-empty); pass --kernel-url to \
			 drive an already-running kernel instead",
		)
	})?;

	let ids: Arc<dyn IdFactory> = Arc::new(RealIdFactory::new());
	let clock: Arc<dyn Clock> = Arc::new(RealClock);
	let platform = KernelPlatformClient::new(entitlement.base_url, entitlement.token);
	let state = AppState::with_anthropic(
		platform,
		ids,
		clock,
		workspace_root,
		model,
		DEFAULT_MAX_TOKENS,
		process_env_lookup,
	);

	let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|err| {
		CliFailure::bootstrap(format!("failed to bind an ephemeral loopback listener: {err}"))
	})?;
	let addr = listener.local_addr().map_err(|err| {
		CliFailure::bootstrap(format!("bound ephemeral listener has no local address: {err}"))
	})?;
	let task = tokio::spawn(async move {
		let _ = serve(listener, state).await;
	});

	Ok(KernelHandle {
		base_url:        format!("http://{addr}"),
		http:            reqwest::Client::new(),
		in_process_task: Some(task),
	})
}

/// Incrementally decodes complete `event: kernel_frame` SSE records out of
/// an arbitrary byte-chunked stream. Operates on raw bytes (never a lossy
/// UTF-8 conversion of partial chunks) so a multi-byte character split
/// across two network reads can never corrupt frame decoding.
struct SseFrameAccumulator {
	buf: Vec<u8>,
}

impl SseFrameAccumulator {
	const fn new() -> Self {
		Self { buf: Vec::new() }
	}

	fn feed(&mut self, chunk: &[u8]) -> Vec<KernelFrameV0> {
		self.buf.extend_from_slice(chunk);
		let mut out = Vec::new();
		while let Some(pos) = self.buf.windows(2).position(|window| window == b"\n\n") {
			let record: Vec<u8> = self.buf.drain(..=pos + 1).collect();
			if let Ok(text) = std::str::from_utf8(&record)
				&& let Some(data_line) = text.lines().find_map(|line| line.strip_prefix("data: "))
				&& let Ok(frame) = serde_json::from_str::<KernelFrameV0>(data_line)
			{
				out.push(frame);
			}
		}
		out
	}
}

/// Runs `ask`: submits a turn to `POST /v0/turns` and always creates a
/// fresh, runner-owned session (C8 session-semantics ruling -- there is no
/// way to target an existing session here, by design).
pub async fn run_ask(args: AskArgs) -> Result<(), u8> {
	let handle =
		establish_kernel(args.kernel_url, args.platform_url, args.workspace_root, args.model)
			.await
			.map_err(CliFailure::report)?;

	let response = handle
		.http
		.post(format!("{}/v0/turns", handle.base_url))
		.header(CONTENT_TYPE, "application/json")
		.body(
			serde_json::json!({ "user_text": args.prompt, "session_id": args.session_id }).to_string(),
		)
		.send()
		.await
		.map_err(|err| {
			CliFailure::transport(format!("submitting the turn failed: {err}")).report()
		})?;

	let status = response.status();
	let is_sse = response
		.headers()
		.get(CONTENT_TYPE)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| value.starts_with("text/event-stream"));

	if !is_sse {
		// The turn failed before any frame was emitted (e.g. platform
		// unreachable at session creation): the kernel's own JSON
		// ErrorEnvelopeV0 body, unchanged (ruling 3).
		let bytes = response.bytes().await.map_err(|err| {
			CliFailure::transport(format!("reading the error body failed: {err}")).report()
		})?;
		let mut stdout = std::io::stdout();
		render::write_json_passthrough(&mut stdout, &bytes).map_err(|err| {
			CliFailure::transport(format!("writing to stdout failed: {err}")).report()
		})?;
		return if status.is_success() {
			Ok(())
		} else {
			Err(ExitBucket::KernelResult.code())
		};
	}

	let mut stream = response.bytes_stream();
	let mut accumulator = SseFrameAccumulator::new();
	let mut terminal_kind: Option<KernelFrameKindV0> = None;
	let mut stdout = std::io::stdout();

	while let Some(chunk) = stream.next().await {
		let chunk = chunk.map_err(|err| {
			CliFailure::transport(format!("reading the turn stream failed: {err}")).report()
		})?;
		if args.format == AskFormat::Sse {
			render::write_sse_chunk(&mut stdout, &chunk).map_err(|err| {
				CliFailure::transport(format!("writing to stdout failed: {err}")).report()
			})?;
		}
		for frame in accumulator.feed(&chunk) {
			if args.format == AskFormat::Text {
				render::render_frame_text(&mut stdout, &frame).map_err(|err| {
					CliFailure::transport(format!("writing to stdout failed: {err}")).report()
				})?;
			}
			if matches!(frame.kind, KernelFrameKindV0::TurnCompleted | KernelFrameKindV0::TurnFailed) {
				terminal_kind = Some(frame.kind);
			}
		}
	}

	match terminal_kind {
		Some(KernelFrameKindV0::TurnCompleted) => Ok(()),
		Some(KernelFrameKindV0::TurnFailed) => Err(ExitBucket::KernelResult.code()),
		_ => Err(ExitBucket::Transport.code()),
	}
}

/// Runs `resume`: reads back a session's accumulated event history via
/// `GET /v0/resume/{session_id}`. Never continues or restarts a turn.
pub async fn run_resume(args: ResumeArgs) -> Result<(), u8> {
	let workspace_root = current_workspace_root();
	let handle = establish_kernel(
		args.kernel_url,
		args.platform_url,
		workspace_root,
		DEFAULT_MODEL.to_owned(),
	)
	.await
	.map_err(CliFailure::report)?;
	run_read_only_get(&handle, &format!("/v0/resume/{}", args.session_id), args.format).await
}

/// Runs `inspect session`: attaches to (inspects) an existing session's
/// platform snapshot via `GET /v0/sessions/{session_id}`. Inspection only --
/// never continues or restarts a turn.
pub async fn run_inspect_session(args: InspectSessionArgs) -> Result<(), u8> {
	let workspace_root = current_workspace_root();
	let handle = establish_kernel(
		args.kernel_url,
		args.platform_url,
		workspace_root,
		DEFAULT_MODEL.to_owned(),
	)
	.await
	.map_err(CliFailure::report)?;
	run_read_only_get(&handle, &format!("/v0/sessions/{}", args.session_id), args.format).await
}

/// Shared GET dispatcher for `resume`/`inspect session`: both are pure
/// read-only JSON-body routes on the frozen kernel surface, differing only
/// in path.
async fn run_read_only_get(
	handle: &KernelHandle,
	path: &str,
	format: ReadFormat,
) -> Result<(), u8> {
	let response = handle
		.http
		.get(format!("{}{path}", handle.base_url))
		.send()
		.await
		.map_err(|err| {
			CliFailure::transport(format!("request to the kernel failed: {err}")).report()
		})?;
	let status = response.status();
	let bytes = response.bytes().await.map_err(|err| {
		CliFailure::transport(format!("reading the response body failed: {err}")).report()
	})?;

	let mut stdout = std::io::stdout();
	let write_result = match format {
		ReadFormat::Json => render::write_json_passthrough(&mut stdout, &bytes),
		ReadFormat::Text => render::render_json_as_text(&mut stdout, &bytes),
	};
	write_result
		.map_err(|err| CliFailure::transport(format!("writing to stdout failed: {err}")).report())?;

	if status.is_success() {
		Ok(())
	} else {
		Err(ExitBucket::KernelResult.code())
	}
}

/// `resume`/`inspect session` have no `--workspace-root` flag in the ruled
/// grammar. Neither route touches `AppState::workspace_root` (both are thin
/// reads through the platform client), so any value bootstrapped here is
/// inert wiring, never contract-facing.
fn current_workspace_root() -> PathBuf {
	std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
