//! Owned by Lane D1 `SuccessorCliCore`. Contract tests for the stateless CLI
//! over the frozen kernel RPC/SSE surface (dissent ruling
//! `238-D1PreExecutionDissent`).
//!
//! Grammar/statelessness/redaction tests spawn the real compiled
//! `successor-cli` binary (`env!("CARGO_BIN_EXE_successor-cli")`) so exit
//! codes and stdout/stderr are observed exactly as an operator would see
//! them. JSON/SSE pass-through tests run a real kernel test double built
//! directly from `successor_kernel::http::{build_router, serve}` (the
//! frozen surface itself, not a hand-rolled fake).

use std::{
	io::{Read as _, Write as _},
	net::TcpListener as StdTcpListener,
	process::Command,
};

use successor_kernel::{
	http::{AppState, serve},
	id_factory::{RealClock, RealIdFactory},
	platform_client::KernelPlatformClient,
	provider::auth::ProviderSlot,
	runner::ScriptedProviderExecutor,
};
use successor_protocol::{error::ErrorEnvelopeV0, provider::ProviderApiShapeV0};
use tokio::net::TcpListener;

const fn cli_bin() -> &'static str {
	env!("CARGO_BIN_EXE_successor-cli")
}

#[derive(Debug)]
struct CliOutput {
	status: i32,
	stdout: String,
	stderr: String,
}

/// Runs the compiled CLI with a controlled, minimal environment: only the
/// entries in `env` are set (plus whatever the OS/tokio runtime needs to
/// function, e.g. `PATH`), so tests can assert on exactly what a clean
/// invocation does or does not read.
fn run_cli(args: &[&str], env: &[(&str, &str)]) -> CliOutput {
	let mut command = Command::new(cli_bin());
	command.args(args);
	command.env_clear();
	if let Ok(path) = std::env::var("PATH") {
		command.env("PATH", path);
	}
	for (key, value) in env {
		command.env(key, value);
	}
	let output = command
		.output()
		.expect("spawn the compiled successor-cli binary");
	CliOutput {
		status: output.status.code().unwrap_or(-1),
		stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
		stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
	}
}

// ---------------------------------------------------------------------
// Grammar: forbidden shapes are rejected as ordinary clap usage errors
// (exit code 2), per dissent ruling 2.
// ---------------------------------------------------------------------

#[test]
fn ask_rejects_a_session_id_flag_that_does_not_exist_on_the_ruled_grammar() {
	let output = run_cli(
		&["ask", "--workspace-root", ".", "--prompt", "hi", "--session-id", "ses_whatever"],
		&[],
	);
	assert_eq!(
		output.status, 2,
		"unrecognized --session-id on ask must be a usage error: {output:?}"
	);
}

#[test]
fn ask_rejects_platform_url_combined_with_kernel_url() {
	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--kernel-url",
			"http://127.0.0.1:1",
			"--platform-url",
			"http://127.0.0.1:2/v0",
		],
		&[],
	);
	assert_eq!(output.status, 2, "--platform-url with --kernel-url must be rejected: {output:?}");
}

#[test]
fn resume_rejects_platform_url_combined_with_kernel_url() {
	let output = run_cli(
		&[
			"resume",
			"--session-id",
			"ses_whatever",
			"--kernel-url",
			"http://127.0.0.1:1",
			"--platform-url",
			"http://127.0.0.1:2/v0",
		],
		&[],
	);
	assert_eq!(
		output.status, 2,
		"--platform-url with --kernel-url must be rejected on resume: {output:?}"
	);
}

#[test]
fn inspect_session_rejects_platform_url_combined_with_kernel_url() {
	let output = run_cli(
		&[
			"inspect",
			"session",
			"--session-id",
			"ses_whatever",
			"--kernel-url",
			"http://127.0.0.1:1",
			"--platform-url",
			"http://127.0.0.1:2/v0",
		],
		&[],
	);
	assert_eq!(
		output.status, 2,
		"--platform-url with --kernel-url must be rejected on inspect session: {output:?}"
	);
}

#[test]
fn ask_rejects_format_json_because_ask_streams_frames_not_a_single_body() {
	let output =
		run_cli(&["ask", "--workspace-root", ".", "--prompt", "hi", "--format", "json"], &[]);
	assert_eq!(
		output.status, 2,
		"ask --format json is not a valid value for this grammar: {output:?}"
	);
}

#[test]
fn inspect_without_a_session_subcommand_is_a_usage_error() {
	let output = run_cli(&["inspect"], &[]);
	assert_eq!(output.status, 2, "inspect requires a subcommand: {output:?}");
}

#[test]
fn inspect_session_help_states_inspection_only_never_continuation() {
	let output = run_cli(&["inspect", "session", "--help"], &[]);
	assert_eq!(output.status, 0);
	assert!(
		output.stdout.to_lowercase().contains("inspect")
			&& output.stdout.to_lowercase().contains("never"),
		"inspect session --help must state this is inspection-only, never turn continuation: {}",
		output.stdout
	);
}

// ---------------------------------------------------------------------
// Statelessness: independent invocations write nothing under a controlled
// HOME/user-dir, and behave identically (no hidden cross-invocation state).
// ---------------------------------------------------------------------

#[test]
fn two_independent_invocations_write_nothing_under_a_controlled_home_dir() {
	let home = std::env::temp_dir().join(format!("successor-cli-stateless-{}", std::process::id()));
	std::fs::create_dir_all(&home).expect("create a scratch home dir");

	for _ in 0..2 {
		let output = run_cli(
			&[
				"inspect",
				"session",
				"--session-id",
				"ses_does-not-matter",
				"--kernel-url",
				"http://127.0.0.1:1",
			],
			&[("HOME", home.to_str().expect("scratch home is valid utf-8"))],
		);
		// An unreachable --kernel-url always exits 4 (transport failure);
		// what matters here is that the scratch HOME stays empty regardless.
		assert_eq!(
			output.status, 4,
			"unreachable --kernel-url must be a transport failure: {output:?}"
		);
	}

	let entries: Vec<_> = std::fs::read_dir(&home)
		.expect("read the scratch home dir")
		.collect();
	assert!(
		entries.is_empty(),
		"the CLI must create no files/dirs under HOME across invocations: {entries:?}"
	);

	let _ = std::fs::remove_dir_all(&home);
}

// ---------------------------------------------------------------------
// Exit-code buckets (dissent ruling 6) and redaction (ruling 5).
// ---------------------------------------------------------------------

#[test]
fn missing_memex_license_in_process_mode_exits_3_and_never_echoes_a_value() {
	let output = run_cli(&["ask", "--workspace-root", ".", "--prompt", "hi"], &[]);
	assert_eq!(
		output.status, 3,
		"missing MEMEX_LICENSE in in-process mode must be exit 3: {output:?}"
	);
	assert!(
		output.stderr.contains("MEMEX_LICENSE"),
		"the bootstrap failure must name the missing variable: {}",
		output.stderr
	);
}

#[test]
fn kernel_url_unreachable_exits_4_with_no_fabricated_envelope() {
	let output = run_cli(
		&["ask", "--workspace-root", ".", "--prompt", "hi", "--kernel-url", "http://127.0.0.1:1"],
		&[],
	);
	assert_eq!(
		output.status, 4,
		"an unreachable --kernel-url must be a transport failure: {output:?}"
	);
	assert!(
		serde_json::from_str::<serde_json::Value>(&output.stdout).is_err(),
		"a transport failure must never fabricate a JSON body on stdout: {}",
		output.stdout
	);
}

#[test]
fn in_process_mode_with_sentinel_secrets_never_leaks_them_on_a_platform_failure() {
	const SENTINEL_LICENSE: &str = "sentinel-memex-license-do-not-leak-d1cli";
	const SENTINEL_KEY: &str = "sk-ant-sentinel-do-not-leak-d1cli9f3c1a2b";

	// No real platform is listening on the default platform URL in a test
	// environment, so the turn fails at session creation (a kernel-returned
	// JSON error envelope, after the in-process kernel genuinely came up).
	let output = run_cli(&["ask", "--workspace-root", ".", "--prompt", "hi"], &[
		("MEMEX_LICENSE", SENTINEL_LICENSE),
		("ANTHROPIC_API_KEY", SENTINEL_KEY),
	]);
	assert_eq!(
		output.status, 5,
		"bootstrap succeeds (license present) but the RPC call itself fails: {output:?}"
	);
	assert!(
		!output.stdout.contains(SENTINEL_LICENSE),
		"stdout must never contain the license value"
	);
	assert!(
		!output.stdout.contains(SENTINEL_KEY),
		"stdout must never contain the provider key value"
	);
	assert!(
		!output.stderr.contains(SENTINEL_LICENSE),
		"stderr must never contain the license value"
	);
	assert!(
		!output.stderr.contains(SENTINEL_KEY),
		"stderr must never contain the provider key value"
	);
}

// ---------------------------------------------------------------------
// JSON pass-through + ErrorEnvelopeV0 byte fidelity against a real kernel
// test double (the frozen `build_router`/`serve` surface itself). These
// paths reject before ever touching the platform client, so an
// unreachable placeholder platform URL is enough -- no live platform
// dependency is added to this crate.
// ---------------------------------------------------------------------

fn kernel_double_base_url() -> String {
	let state = AppState::new(
		KernelPlatformClient::new("http://127.0.0.1:1/v0", "unused-test-token"),
		std::sync::Arc::new(RealIdFactory::new()),
		std::sync::Arc::new(RealClock),
		std::env::temp_dir(),
		ProviderSlot::Anthropic,
		|| {
			Ok(ScriptedProviderExecutor::new(
				"scripted",
				ProviderApiShapeV0::AnthropicMessages,
				"scripted-model",
				Vec::new(),
			))
		},
	);
	// Bind synchronously so the caller (a plain #[test], not #[tokio::test])
	// can hand the listener to a background tokio runtime.
	let std_listener = StdTcpListener::bind("127.0.0.1:0").expect("bind an ephemeral tcp port");
	std_listener
		.set_nonblocking(true)
		.expect("set the listener non-blocking for tokio");
	let addr = std_listener
		.local_addr()
		.expect("bound listener has a local addr");
	let base_url = format!("http://{addr}");

	// The background OS thread outlives this function and this test binary's
	// process teardown reclaims it; nothing here uses the frozen kernel
	// surface's own `AppState`/`serve` any differently than the CLI's own
	// in-process bootstrap does.
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.expect("build a background tokio runtime for the kernel double");
		runtime.block_on(async move {
			let listener =
				TcpListener::from_std(std_listener).expect("adopt the std listener into tokio");
			let _ = serve(listener, state).await;
		});
	});

	base_url
}

#[test]
fn resume_json_passthrough_is_byte_identical_to_a_direct_call_against_the_kernel_double() {
	let base_url = kernel_double_base_url();

	let output =
		run_cli(&["resume", "--session-id", "not-a-valid-session-id", "--kernel-url", &base_url], &[
		]);
	assert_eq!(
		output.status, 5,
		"a malformed session id is a kernel-returned typed error: {output:?}"
	);

	let trimmed = output.stdout.trim_end_matches('\n');
	assert_eq!(
		output.stdout.matches('\n').count(),
		1,
		"CLI JSON pass-through must be compact single-line JSON with exactly one trailing newline: \
		 {:?}",
		output.stdout
	);
	let envelope: ErrorEnvelopeV0 =
		serde_json::from_str(trimmed).expect("CLI stdout is a valid ErrorEnvelopeV0");
	assert_eq!(envelope.schema_version, "platform.error.v0");
	assert_eq!(envelope.code, "kernel_rpc.invalid_parameter");
	assert_eq!(
		envelope.message,
		"invalid_id_prefix: expected prefix `ses_`, got `not-a-valid-session-id`"
	);
	assert!(!envelope.recoverable);
	assert!(!envelope.retryable);
	assert_eq!(envelope.details, serde_json::json!({}));

	// `error_id`/`correlation_id` are freshly random per request (RealIdFactory),
	// so two independent requests can never be byte-identical; the achievable
	// proof of "pass-through, not reformatting" is that re-serializing the parsed
	// envelope reproduces the CLI's own stdout byte-for-byte -- no reordering, no
	// re-indentation, no added/renamed fields.
	let reserialized = serde_json::to_string(&envelope).expect("re-serialize the envelope");
	assert_eq!(
		reserialized, trimmed,
		"CLI must relay the kernel's JSON body unchanged, not a re-encoded copy of it"
	);
}

#[test]
fn inspect_session_json_passthrough_is_byte_identical_to_a_direct_call_against_the_kernel_double() {
	let base_url = kernel_double_base_url();

	let output = run_cli(
		&["inspect", "session", "--session-id", "not-a-valid-session-id", "--kernel-url", &base_url],
		&[],
	);
	assert_eq!(
		output.status, 5,
		"a malformed session id is a kernel-returned typed error: {output:?}"
	);

	let trimmed = output.stdout.trim_end_matches('\n');
	assert_eq!(
		output.stdout.matches('\n').count(),
		1,
		"CLI JSON pass-through must be compact single-line JSON with exactly one trailing newline: \
		 {:?}",
		output.stdout
	);
	let envelope: ErrorEnvelopeV0 =
		serde_json::from_str(trimmed).expect("CLI stdout is a valid ErrorEnvelopeV0");
	assert_eq!(envelope.schema_version, "platform.error.v0");
	assert_eq!(envelope.code, "kernel_rpc.invalid_parameter");
	assert_eq!(
		envelope.message,
		"invalid_id_prefix: expected prefix `ses_`, got `not-a-valid-session-id`"
	);
	assert!(!envelope.recoverable);
	assert!(!envelope.retryable);
	assert_eq!(envelope.details, serde_json::json!({}));

	let reserialized = serde_json::to_string(&envelope).expect("re-serialize the envelope");
	assert_eq!(
		reserialized, trimmed,
		"CLI must relay the kernel's JSON body unchanged, not a re-encoded copy of it"
	);
}

#[test]
fn ask_against_an_unreachable_platform_surfaces_the_kernels_json_error_envelope_not_sse() {
	let base_url = kernel_double_base_url();

	// The double's platform base URL (127.0.0.1:1) is never reachable, so
	// submit_turn fails before any frame is published: a plain JSON
	// ErrorEnvelopeV0, not an SSE stream, even though --format sse was
	// requested (ruling 3: format only governs a stream that actually
	// opens).
	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--kernel-url",
			&base_url,
			"--format",
			"sse",
		],
		&[],
	);
	assert_eq!(
		output.status, 5,
		"platform-unreachable-at-session-creation is a kernel-returned typed error: {output:?}"
	);
	let envelope: ErrorEnvelopeV0 = serde_json::from_str(output.stdout.trim_end())
		.expect("CLI stdout is a valid ErrorEnvelopeV0 even in sse mode");
	assert_ne!(
		envelope.code, "",
		"the envelope must carry the kernel's real error code, unmodified"
	);
}

// ---------------------------------------------------------------------
// SSE byte-for-byte pass-through against a minimal raw double that serves
// canned frames rendered through the accepted C2 `render_kernel_frame_sse`
// function (no second schema, no live turn required).
// ---------------------------------------------------------------------

#[test]
fn ask_format_sse_is_byte_for_byte_pass_through_and_exit_code_follows_the_terminal_frame() {
	use successor_kernel::sse::render_kernel_frame_sse;
	use successor_protocol::{
		ids::{FrameId, RequestId, SessionId, TurnId},
		kernel_frame::{KernelFrameKindV0, KernelFrameV0},
	};

	let started = KernelFrameV0::new(
		FrameId::try_from("frame_1".to_owned()).expect("valid frame id"),
		1,
		SessionId::try_from("ses_test0000000000000001".to_owned()).expect("valid session id"),
		TurnId::try_from("turn_test0000000000000001".to_owned()).expect("valid turn id"),
		RequestId::try_from("req_test0000000000000001".to_owned()).expect("valid request id"),
		KernelFrameKindV0::TurnStarted,
		"2024-01-01T00:00:00Z".to_owned(),
		serde_json::json!({}),
	);
	let completed = KernelFrameV0::new(
		FrameId::try_from("frame_2".to_owned()).expect("valid frame id"),
		2,
		SessionId::try_from("ses_test0000000000000001".to_owned()).expect("valid session id"),
		TurnId::try_from("turn_test0000000000000001".to_owned()).expect("valid turn id"),
		RequestId::try_from("req_test0000000000000001".to_owned()).expect("valid request id"),
		KernelFrameKindV0::TurnCompleted,
		"2024-01-01T00:00:01Z".to_owned(),
		serde_json::json!({}),
	);

	let mut body = render_kernel_frame_sse(&started).expect("render the started frame");
	body.push_str(&render_kernel_frame_sse(&completed).expect("render the completed frame"));
	let expected_body = body.clone();

	let listener = StdTcpListener::bind("127.0.0.1:0").expect("bind the sse double");
	let addr = listener.local_addr().expect("sse double has a local addr");
	let handle = std::thread::spawn(move || {
		let (mut stream, _) = listener.accept().expect("accept one connection");
		let mut buf = [0_u8; 4096];
		// Drain whatever the client sent (headers + body) before responding;
		// exact byte count doesn't matter since we respond with
		// Connection: close and let the OS deliver whatever was written.
		let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
		let _ = stream.read(&mut buf);
		let response = format!(
			"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
		);
		stream
			.write_all(response.as_bytes())
			.expect("write the canned sse response");
	});

	let base_url = format!("http://{addr}");
	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--kernel-url",
			&base_url,
			"--format",
			"sse",
		],
		&[],
	);
	handle.join().expect("sse double thread completes");

	assert_eq!(output.status, 0, "a turn_completed terminal frame must exit 0: {output:?}");
	assert_eq!(
		output.stdout, expected_body,
		"ask --format sse must write the received SSE bytes exactly as sent, with no re-framing"
	);
}
