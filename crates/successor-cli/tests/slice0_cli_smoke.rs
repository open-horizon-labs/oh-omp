//! D2 `BlackBoxIntegrationSmoke` reopen (task 245
//! `D2CliSmokeSeamAdjudication`): the compiled `successor-cli` binary
//! exercised as a genuine black box against a REAL context-platform HTTP
//! server (via the reopen's additive
//! `successor_context_platform::http::serve`) and a REAL kernel HTTP server
//! (`successor_kernel::http::serve`), wired together exactly as production
//! would (the kernel's `KernelPlatformClient` points at the real platform's
//! bound address). Provider/id/clock seams mirror
//! `crates/successor-kernel/tests/slice0_kernel_rpc.rs`'s `scripted_state`
//! helper so turn outcomes stay deterministic without a real provider call.
//!
//! Scope: D1 (`slice0_cli_contract.rs`) already covers the CLI's grammar,
//! exit-code buckets, statelessness, and JSON/SSE passthrough shape against
//! a bare kernel double whose platform is deliberately unreachable. This
//! file proves the oracles that require a live, real platform underneath
//! the kernel: a real bucket-0 terminal success, a real bucket-5 typed
//! error envelope produced by an actual platform 404 (not a local parse
//! failure, which D1 already covers), session-id preservation across all
//! three hops (platform store -> kernel frames -> CLI stdout), SSE
//! byte-exactness against the wire bytes of the very same real turn (via a
//! raw `reqwest` subscription that this file's own minimal reverse proxy
//! relays, not a decode/re-render round trip), resume/inspect freshness
//! proven across separate CLI processes, and a sentinel leak scan of a
//! fully controlled spawn environment. D1-owned buckets 2/3/4
//! (grammar/usage errors, bootstrap failures, transport failures) are not
//! re-proven here.

use std::{
	io::ErrorKind,
	net::TcpListener as StdTcpListener,
	path::PathBuf,
	process::Command,
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, Ordering},
	},
};

use futures_util::StreamExt as _;
use successor_context_platform::{
	auth::PlatformLicense, http::serve as platform_serve, routes::PlatformState,
};
use successor_kernel::{
	http::{AppState, serve as kernel_serve},
	id_factory::{RealClock, RealIdFactory},
	platform_client::{EntitlementToken, KernelPlatformClient},
	provider::auth::ProviderSlot,
	runner::{ScriptedProviderExecutor, ScriptedRound},
};
use successor_protocol::provider::ProviderApiShapeV0;
use tokio::net::{TcpListener, TcpStream};

const LICENSE: &str = "dev-license-d2-cli-smoke-abc123";
const SENTINEL_LICENSE: &str = "d2-memex-license-sentinel-do-not-leak-cli-smoke";
const SENTINEL_KEY: &str = "sk-ant-d2-sentinel-do-not-leak-cli-smoke9f3c1a2b";

const fn cli_bin() -> &'static str {
	env!("CARGO_BIN_EXE_successor-cli")
}

#[derive(Debug)]
struct CliOutput {
	status: i32,
	stdout: Vec<u8>,
	stderr: Vec<u8>,
}

/// Spawns the compiled `successor-cli` binary with a fully controlled
/// environment: `env_clear` first, so a spawned process can never inherit
/// host-machine secrets, then only `PATH` (needed to resolve dynamic
/// loader dependencies on some platforms) and the caller's explicit `env`
/// entries are set.
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
		stdout: output.stdout,
		stderr: output.stderr,
	}
}

fn temp_db_path(label: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir().join(format!("d2-cli-smoke-{label}-{}-{n}.sqlite3", std::process::id()))
}

fn cleanup_sqlite_files(path: &std::path::Path) {
	for suffix in ["", "-journal", "-wal", "-shm"] {
		let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
	}
}

fn wait_until_reachable(addr: std::net::SocketAddr) {
	for _ in 0..200 {
		if std::net::TcpStream::connect(addr).is_ok() {
			return;
		}
		std::thread::sleep(std::time::Duration::from_millis(10));
	}
	panic!("{addr} never became reachable");
}

/// A live harness: a real platform HTTP server (the reopen's new
/// `platform::http::serve`) plus a real kernel HTTP server
/// (`kernel::http::serve`), wired together exactly as production does, both
/// bound on ephemeral loopback ports and kept alive on background OS
/// threads for the harness's lifetime -- long enough for multiple, separate
/// CLI processes to hit the same urls (needed by the cross-process
/// freshness oracle).
struct Harness {
	kernel_addr:   std::net::SocketAddr,
	platform_addr: std::net::SocketAddr,
	db_path:       PathBuf,
}

impl Harness {
	fn kernel_base_url(&self) -> String {
		format!("http://{}", self.kernel_addr)
	}

	fn platform_base_url(&self) -> String {
		format!("http://{}", self.platform_addr)
	}

	/// `rounds` drives every turn this harness's kernel executes: a fresh
	/// `ScriptedProviderExecutor` is built (and `rounds` cloned) per turn, so
	/// multiple turns against the same harness all replay the same script.
	fn start(label: &str, rounds: Vec<ScriptedRound>) -> Self {
		let db_path = temp_db_path(label);

		let platform_std_listener =
			StdTcpListener::bind("127.0.0.1:0").expect("bind an ephemeral platform port");
		let platform_addr = platform_std_listener
			.local_addr()
			.expect("platform listener has a local addr");
		let db_path_for_platform = db_path.clone();
		std::thread::spawn(move || {
			let runtime = tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.expect("build a background tokio runtime for the platform harness");
			runtime.block_on(async move {
				platform_std_listener
					.set_nonblocking(true)
					.expect("set platform listener non-blocking");
				let listener = TcpListener::from_std(platform_std_listener)
					.expect("adopt the platform listener into tokio");
				let state = PlatformState::connect(
					db_path_for_platform
						.to_str()
						.expect("db path is valid utf-8"),
				)
				.await
				.expect("connect the platform to a fresh sqlite db");
				let _ = platform_serve(listener, PlatformLicense::new(LICENSE), Arc::new(state)).await;
			});
		});
		wait_until_reachable(platform_addr);

		let kernel_std_listener =
			StdTcpListener::bind("127.0.0.1:0").expect("bind an ephemeral kernel port");
		let kernel_addr = kernel_std_listener
			.local_addr()
			.expect("kernel listener has a local addr");
		let platform_v0_url = format!("http://{platform_addr}/v0");
		std::thread::spawn(move || {
			let runtime = tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.expect("build a background tokio runtime for the kernel harness");
			let state = AppState::new(
				KernelPlatformClient::new(platform_v0_url, EntitlementToken::new(LICENSE)),
				Arc::new(RealIdFactory::new()),
				Arc::new(RealClock),
				std::env::temp_dir(),
				ProviderSlot::Anthropic,
				move || {
					Ok(ScriptedProviderExecutor::new(
						"scripted",
						ProviderApiShapeV0::AnthropicMessages,
						"scripted-model",
						rounds.clone(),
					))
				},
			);
			runtime.block_on(async move {
				kernel_std_listener
					.set_nonblocking(true)
					.expect("set kernel listener non-blocking");
				let listener = TcpListener::from_std(kernel_std_listener)
					.expect("adopt the kernel listener into tokio");
				let _ = kernel_serve(listener, state).await;
			});
		});
		wait_until_reachable(kernel_addr);

		Self { kernel_addr, platform_addr, db_path }
	}
}

impl Drop for Harness {
	fn drop(&mut self) {
		cleanup_sqlite_files(&self.db_path);
	}
}

fn successful_round(text: &str) -> Vec<ScriptedRound> {
	vec![ScriptedRound::Final { text: text.to_owned(), summary: text.to_owned() }]
}

/// Extracts the first `session_id` field found in a byte blob containing
/// one or more `KernelFrameV0`-shaped JSON objects (SSE `data:` lines or a
/// bare JSON body) -- every kernel frame carries `session_id`
/// (`routes::submit_turn`), so this works uniformly without a full SSE
/// parser.
fn extract_session_id(bytes: &[u8]) -> String {
	let text = std::str::from_utf8(bytes).expect("payload is utf8");
	let key = "\"session_id\":\"";
	let start = text.find(key).expect("payload carries a session_id field") + key.len();
	let end = text[start..]
		.find('"')
		.expect("session_id value is a terminated json string");
	text[start..start + end].to_owned()
}

/// `write_json_passthrough` (render.rs) adds a trailing newline only when
/// one is not already present; undo that one, optional, well-documented
/// byte before comparing cli stdout to a raw http body it should otherwise
/// match exactly.
fn strip_one_added_trailing_newline(stdout: &[u8]) -> &[u8] {
	stdout.strip_suffix(b"\n").unwrap_or(stdout)
}

/// A direct, synchronous HTTP GET against the live harness, bypassing the
/// cli entirely -- used as an independent ground truth for freshness and
/// id-preservation assertions.
fn http_get_body(url: &str) -> Vec<u8> {
	let runtime = tokio::runtime::Runtime::new().expect("build a runtime for a direct http read");
	runtime.block_on(async {
		reqwest::Client::new()
			.get(url)
			.send()
			.await
			.expect("direct http get must succeed")
			.bytes()
			.await
			.expect("read response body")
			.to_vec()
	})
}

/// A direct, synchronous, authenticated HTTP GET against the platform's own
/// surface (which requires the `MEMEX_LICENSE`-shaped bearer entitlement).
fn http_get_body_authenticated(url: &str, license: &str) -> Vec<u8> {
	let runtime =
		tokio::runtime::Runtime::new().expect("build a runtime for a direct authenticated http read");
	runtime.block_on(async {
		reqwest::Client::new()
			.get(url)
			.bearer_auth(license)
			.send()
			.await
			.expect("direct authenticated http get must succeed")
			.bytes()
			.await
			.expect("read response body")
			.to_vec()
	})
}

// ---------------------------------------------------------------------
// 1. bucket-0: a real platform + real kernel + scripted-provider turn completes
//    with a terminal success frame.
// ---------------------------------------------------------------------

#[test]
fn ask_over_a_real_platform_and_kernel_completes_with_a_terminal_success_frame() {
	let harness = Harness::start("bucket0", successful_round("hello from the scripted provider"));
	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--kernel-url",
			&harness.kernel_base_url(),
		],
		&[],
	);
	assert_eq!(
		output.status, 0,
		"a real platform + real kernel + scripted-provider turn must complete: {output:?}"
	);
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		stdout.contains("[turn completed]"),
		"stdout must render the terminal success frame's own text: {stdout}"
	);
}

// ---------------------------------------------------------------------
// 2. bucket-5: a genuine platform 404 (not a local parse failure -- d1 already
//    covers `kernel_rpc.invalid_parameter`) surfaces as a typed kernel error
//    envelope.
// ---------------------------------------------------------------------

#[test]
fn resume_against_a_real_but_nonexistent_session_surfaces_a_platform_backed_typed_error_envelope() {
	let harness = Harness::start("bucket5", Vec::new());
	let output = run_cli(
		&[
			"resume",
			"--session-id",
			"ses_does-not-exist-d2cli",
			"--kernel-url",
			&harness.kernel_base_url(),
		],
		&[],
	);
	assert_eq!(
		output.status, 5,
		"a real platform 404 must be a kernel-returned typed error: {output:?}"
	);

	let envelope: serde_json::Value =
		serde_json::from_slice(&output.stdout).expect("cli stdout is a valid json error envelope");
	assert_eq!(
		envelope["code"], "kernel_rpc.platform_unavailable",
		"a real platform-side 404 must round-trip through kernel_rpc.platform_unavailable (distinct \
		 from d1's local kernel_rpc.invalid_parameter): {envelope}"
	);
}

// ---------------------------------------------------------------------
// 3. id preservation: the session id minted at the platform store, embedded in
//    every kernel frame, and printed to cli stdout must be the exact same
//    string at all three hops.
// ---------------------------------------------------------------------

#[test]
fn session_id_is_preserved_from_the_platform_store_through_kernel_frames_to_cli_stdout() {
	let harness = Harness::start("idpreserve", successful_round("id preservation check"));
	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--format",
			"sse",
			"--kernel-url",
			&harness.kernel_base_url(),
		],
		&[],
	);
	assert_eq!(output.status, 0, "the seeding turn must complete: {output:?}");

	// hop 2 -> 3: the id embedded in the cli's own rendered sse stdout.
	let session_id_in_cli_stdout = extract_session_id(&output.stdout);

	// hop 1: the platform's own independent record of the session, read
	// directly (authenticated, bypassing the cli and the kernel's frame
	// stream entirely).
	let platform_body = http_get_body_authenticated(
		&format!("{}/v0/sessions/{session_id_in_cli_stdout}/snapshot", harness.platform_base_url()),
		LICENSE,
	);
	let platform_session_id = extract_session_id(&platform_body);

	assert_eq!(
		platform_session_id, session_id_in_cli_stdout,
		"the platform's own stored session_id must match the id that flowed through kernel frames \
		 into cli stdout"
	);
}

// ---------------------------------------------------------------------
// 4. resume/inspect freshness across separate cli processes: each of several
//    independent os processes must freshly derive the identical, correct answer
//    from the live kernel -- never a cached or fabricated copy of a prior
//    invocation.
// ---------------------------------------------------------------------

#[test]
fn separate_resume_and_inspect_cli_processes_each_freshly_reflect_the_live_kernel() {
	let harness = Harness::start("freshness", successful_round("freshness check"));

	let ask_output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--format",
			"sse",
			"--kernel-url",
			&harness.kernel_base_url(),
		],
		&[],
	);
	assert_eq!(ask_output.status, 0, "the seeding turn must complete: {ask_output:?}");
	let session_id = extract_session_id(&ask_output.stdout);

	// process #1 (resume) vs. a direct, independent read of the same live
	// kernel: proves resume is a fresh passthrough, not a cached/fabricated
	// value.
	let resume_output_1 = run_cli(
		&["resume", "--session-id", &session_id, "--kernel-url", &harness.kernel_base_url()],
		&[],
	);
	assert_eq!(
		resume_output_1.status, 0,
		"resume must succeed for a real, freshly-created session: {resume_output_1:?}"
	);
	let direct_resume_body =
		http_get_body(&format!("{}/v0/resume/{session_id}", harness.kernel_base_url()));
	assert_eq!(
		strip_one_added_trailing_newline(&resume_output_1.stdout),
		direct_resume_body.as_slice(),
		"process #1's resume stdout must be byte-identical (module the one permitted added newline) \
		 to a direct read of the live kernel"
	);

	// process #2: an entirely separate os process, spawned after process
	// #1 has already exited, must independently derive the identical
	// answer -- there is no daemon, cache, or shared state between cli
	// invocations.
	let resume_output_2 = run_cli(
		&["resume", "--session-id", &session_id, "--kernel-url", &harness.kernel_base_url()],
		&[],
	);
	assert_eq!(
		resume_output_1.stdout, resume_output_2.stdout,
		"two separate cli processes reading the same live session must produce byte-identical output"
	);

	// process #3 (`inspect session`), cross-checked against a direct read
	// of the kernel's own attach_session route.
	let inspect_output = run_cli(
		&[
			"inspect",
			"session",
			"--session-id",
			&session_id,
			"--kernel-url",
			&harness.kernel_base_url(),
		],
		&[],
	);
	assert_eq!(
		inspect_output.status, 0,
		"inspect session must succeed for a real session: {inspect_output:?}"
	);
	let direct_inspect_body =
		http_get_body(&format!("{}/v0/sessions/{session_id}", harness.kernel_base_url()));
	assert_eq!(
		strip_one_added_trailing_newline(&inspect_output.stdout),
		direct_inspect_body.as_slice(),
		"a separate `inspect session` cli process must be byte-identical to a direct read of the \
		 live kernel"
	);
}

// ---------------------------------------------------------------------
// 5. sentinel leak scan: --kernel-url mode never consumes MEMEX_LICENSE or
//    ANTHROPIC_API_KEY, proven with a fully controlled spawn env that injects
//    sentinel values for both.
// ---------------------------------------------------------------------

#[test]
fn kernel_url_mode_never_leaks_or_depends_on_injected_sentinel_secrets() {
	let harness = Harness::start("sentinel", successful_round("sentinel leak scan"));
	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--kernel-url",
			&harness.kernel_base_url(),
		],
		&[("MEMEX_LICENSE", SENTINEL_LICENSE), ("ANTHROPIC_API_KEY", SENTINEL_KEY)],
	);
	assert_eq!(
		output.status, 0,
		"--kernel-url mode must succeed even under poisoned MEMEX_LICENSE/ANTHROPIC_API_KEY env \
		 vars, proving non-consumption: {output:?}"
	);
	let stdout = String::from_utf8_lossy(&output.stdout);
	let stderr = String::from_utf8_lossy(&output.stderr);
	assert!(
		!stdout.contains(SENTINEL_LICENSE),
		"stdout must never contain the injected license sentinel"
	);
	assert!(
		!stdout.contains(SENTINEL_KEY),
		"stdout must never contain the injected provider key sentinel"
	);
	assert!(
		!stderr.contains(SENTINEL_LICENSE),
		"stderr must never contain the injected license sentinel"
	);
	assert!(
		!stderr.contains(SENTINEL_KEY),
		"stderr must never contain the injected provider key sentinel"
	);
}

// ---------------------------------------------------------------------
// 6. sse byte-exactness against a direct http subscription to the same real
//    turn (ruling 7 forbids proving fidelity via decode+re-render).
// ---------------------------------------------------------------------

/// A minimal single-request HTTP/1.1 reverse proxy in front of a real
/// kernel: relays exactly one `POST /v0/turns` request by making the
/// upstream call itself with `reqwest` -- a genuine, independent "direct
/// HTTP subscription" to the kernel's SSE stream -- and captures the
/// payload bytes it forwards. This captures the literal bytes of the one
/// real turn the CLI itself asks for, with zero re-encoding of frame
/// content (only the outer HTTP chunk framing is redone, which is pure
/// transport plumbing, not application data): no axum/tower dependency is
/// introduced, only `tokio::net::TcpStream`'s inherent non-blocking
/// primitives plus the crate's existing `reqwest` dependency.
struct SseCapturingProxy {
	addr:     std::net::SocketAddr,
	captured: Arc<Mutex<Vec<u8>>>,
}

impl SseCapturingProxy {
	async fn start(upstream_base_url: String) -> Self {
		let listener = TcpListener::bind("127.0.0.1:0")
			.await
			.expect("bind an ephemeral proxy port");
		let addr = listener
			.local_addr()
			.expect("proxy listener has a local addr");
		let captured = Arc::new(Mutex::new(Vec::new()));
		let captured_for_task = Arc::clone(&captured);
		tokio::spawn(async move {
			if let Ok((stream, _)) = listener.accept().await {
				relay_one_turn_request(stream, &upstream_base_url, &captured_for_task).await;
			}
		});
		Self { addr, captured }
	}

	fn base_url(&self) -> String {
		format!("http://{}", self.addr)
	}

	fn captured_bytes(&self) -> Vec<u8> {
		self
			.captured
			.lock()
			.expect("proxy capture mutex is not poisoned")
			.clone()
	}
}

async fn read_raw(stream: &TcpStream, buf: &mut [u8]) -> std::io::Result<usize> {
	loop {
		stream.readable().await?;
		match stream.try_read(buf) {
			Ok(n) => return Ok(n),
			Err(ref e) if e.kind() == ErrorKind::WouldBlock => {},
			Err(e) => return Err(e),
		}
	}
}

async fn write_raw_all(stream: &TcpStream, mut data: &[u8]) -> std::io::Result<()> {
	while !data.is_empty() {
		stream.writable().await?;
		match stream.try_write(data) {
			Ok(n) => data = &data[n..],
			Err(ref e) if e.kind() == ErrorKind::WouldBlock => {},
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}

async fn relay_one_turn_request(
	stream: TcpStream,
	upstream_base_url: &str,
	captured: &Arc<Mutex<Vec<u8>>>,
) {
	// Read the cli's raw request until the header/body boundary, then read
	// exactly `Content-Length` more bytes: enough to relay a single
	// `POST /v0/turns` request without a full http parser (this proxy only
	// ever fronts that one route).
	let mut request = Vec::new();
	let mut chunk = [0u8; 4096];
	let header_end = loop {
		let n = read_raw(&stream, &mut chunk)
			.await
			.expect("read from the cli's connection");
		assert!(n > 0, "cli closed the connection before sending a full request");
		request.extend_from_slice(&chunk[..n]);
		if let Some(pos) = find_subslice(&request, b"\r\n\r\n") {
			break pos + 4;
		}
	};
	let header_text = String::from_utf8_lossy(&request[..header_end]);
	let content_length: usize = header_text
		.lines()
		.find_map(|line| {
			let lower = line.to_ascii_lowercase();
			lower
				.starts_with("content-length:")
				.then(|| line.split(':').nth(1).unwrap_or("0").trim().to_owned())
		})
		.and_then(|value| value.parse().ok())
		.unwrap_or(0);
	while request.len() - header_end < content_length {
		let n = read_raw(&stream, &mut chunk)
			.await
			.expect("read the cli's request body");
		assert!(n > 0, "cli closed the connection before sending its full request body");
		request.extend_from_slice(&chunk[..n]);
	}
	let body = request[header_end..header_end + content_length].to_vec();

	// The genuine "direct HTTP subscription": reqwest, not the cli, makes
	// this request against the real kernel.
	let client = reqwest::Client::new();
	let response = client
		.post(format!("{upstream_base_url}/v0/turns"))
		.header(reqwest::header::CONTENT_TYPE, "application/json")
		.body(body)
		.send()
		.await
		.expect("the proxy's direct subscription to the kernel must succeed");
	let status = response.status();
	let content_type = response
		.headers()
		.get(reqwest::header::CONTENT_TYPE)
		.and_then(|value| value.to_str().ok())
		.unwrap_or("application/octet-stream")
		.to_owned();

	let status_line = format!(
		"HTTP/1.1 {} {}\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: \
		 close\r\n\r\n",
		status.as_u16(),
		status.canonical_reason().unwrap_or(""),
		content_type,
	);
	write_raw_all(&stream, status_line.as_bytes())
		.await
		.expect("write the proxied response head");

	let mut body_stream = response.bytes_stream();
	while let Some(next) = body_stream.next().await {
		let piece = next.expect("the kernel's own sse stream must not fail mid-turn");
		captured
			.lock()
			.expect("proxy capture mutex is not poisoned")
			.extend_from_slice(&piece);
		let chunk_head = format!("{:x}\r\n", piece.len());
		write_raw_all(&stream, chunk_head.as_bytes())
			.await
			.expect("write a chunk header");
		write_raw_all(&stream, &piece)
			.await
			.expect("write a chunk body");
		write_raw_all(&stream, b"\r\n")
			.await
			.expect("write a chunk trailer");
	}
	write_raw_all(&stream, b"0\r\n\r\n")
		.await
		.expect("write the final chunk");
}

#[test]
fn ask_format_sse_stdout_is_byte_exact_against_a_direct_subscription_to_the_real_kernel() {
	let harness = Harness::start("sse-byte-exact", successful_round("byte exact sse check"));

	// This runtime is kept alive for the whole test: the proxy's
	// accept-and-relay task is spawned onto it and continues running on its
	// worker threads independently of any specific `block_on` call, for as
	// long as the `Runtime` value itself isn't dropped.
	let runtime =
		tokio::runtime::Runtime::new().expect("build a runtime to host the sse capturing proxy");
	let proxy = runtime.block_on(SseCapturingProxy::start(harness.kernel_base_url()));

	let output = run_cli(
		&[
			"ask",
			"--workspace-root",
			".",
			"--prompt",
			"hi",
			"--format",
			"sse",
			"--kernel-url",
			&proxy.base_url(),
		],
		&[],
	);
	assert_eq!(output.status, 0, "the proxied real turn must still complete: {output:?}");

	// Give the proxy task a brief moment to finish flushing its capture
	// buffer after the cli process (and its connection) closes.
	std::thread::sleep(std::time::Duration::from_millis(50));
	let captured = proxy.captured_bytes();
	assert_eq!(
		output.stdout, captured,
		"the cli's sse stdout must be byte-exact against the payload bytes reqwest received \
		 directly from the real kernel for the same turn (proxy-relayed, not a decode/re-render)"
	);

	drop(runtime);
}
