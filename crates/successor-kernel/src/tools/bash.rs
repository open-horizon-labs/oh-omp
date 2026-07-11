//! Structured, allowlisted local-process execution for the catalog-compatible
//! `bash` tool name. This module deliberately never parses or invokes shell
//! source.
//!
//! This is not a filesystem or network sandbox. It bounds executable selection,
//! environment inheritance, working directory, output, timeout, and (on Unix)
//! the spawned process group. Registry/catalog integration remains
//! intentionally deferred.

use std::{
	collections::BTreeMap,
	fs,
	io::{self, Read},
	path::{Path, PathBuf},
	process::{Child, Command, ExitStatus, Stdio},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
		mpsc::{self, Receiver, RecvTimeoutError},
	},
	thread,
	time::{Duration, Instant},
};

use schemars::schema::RootSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{PathBoundError, WorkspaceRoot, validate_relative_path_lexically};

const MAX_TIMEOUT_MS: u32 = 300_000;
const MAX_ARG_COUNT: usize = 256;
const MAX_STRING_BYTES: usize = 16 * 1024;
const MAX_ARGUMENT_BYTES: usize = 128 * 1024;
const MAX_ENV_VALUE_BYTES: usize = 16 * 1024;
const MAX_ENV_BYTES: usize = 64 * 1024;
const PROVIDER_CAPTURE_BYTES: usize = 64 * 1024;
const ARTIFACT_CAPTURE_BYTES: usize = 1024 * 1024;
const POST_EXIT_DRAIN: Duration = Duration::from_millis(250);
const TERMINATION_GRACE: Duration = Duration::from_millis(250);
const GROUP_REAP_GRACE: Duration = Duration::from_secs(1);
const READER_POLL: Duration = Duration::from_millis(5);

const SHELL_LOGICAL_NAMES: &[&str] = &["bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh"];
const ENV_ALLOWLIST: &[&str] = &["CI", "NO_COLOR", "TERM", "CARGO_TERM_COLOR", "RUST_BACKTRACE"];

/// Provider-facing arguments. Unknown keys, including shell-source and stdin
/// keys, are refused by serde before a process can be spawned.
#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BashArgs {
	pub executable: String,
	#[serde(default)]
	pub argv:       Vec<String>,
	#[serde(default = "default_cwd")]
	pub cwd:        String,
	#[serde(default = "default_timeout_ms")]
	pub timeout_ms: u32,
	#[serde(default)]
	pub env:        BTreeMap<String, String>,
}

impl BashArgs {
	pub fn schema() -> RootSchema {
		schemars::schema_for!(Self)
	}
}

fn default_cwd() -> String {
	".".to_owned()
}

const fn default_timeout_ms() -> u32 {
	30_000
}

/// One host-configured executable entry. `fixed_argv` is host-owned and is
/// useful for wrappers or hermetic test binaries; provider argv is appended
/// after it.
#[derive(Debug, Clone)]
pub struct TrustedExecutable {
	logical_name:   String,
	canonical_path: PathBuf,
	fixed_argv:     Vec<String>,
	identity:       ExecutableIdentity,
}

impl TrustedExecutable {
	pub fn new(
		logical_name: impl Into<String>,
		path: impl AsRef<Path>,
		fixed_argv: Vec<String>,
	) -> Result<Self, ProcessRejection> {
		let logical_name = logical_name.into();
		validate_logical_name(&logical_name)
			.map_err(|_| ProcessRejection::InvalidTrustedExecutable)?;
		if !path.as_ref().is_absolute()
			|| fixed_argv
				.iter()
				.any(|argument| !valid_string(argument, MAX_STRING_BYTES))
		{
			return Err(ProcessRejection::InvalidTrustedExecutable);
		}
		let canonical_path =
			fs::canonicalize(path).map_err(|_| ProcessRejection::InvalidTrustedExecutable)?;
		let identity =
			executable_identity(&canonical_path).ok_or(ProcessRejection::InvalidTrustedExecutable)?;
		Ok(Self { logical_name, canonical_path, fixed_argv, identity })
	}
}

/// Injected host allowlist. There is intentionally no production default or
/// PATH search: every executable must be selected by this host-owned mapping.
#[derive(Debug, Clone, Default)]
pub struct TrustedExecutableAllowlist {
	entries: BTreeMap<String, TrustedExecutable>,
}

impl TrustedExecutableAllowlist {
	pub fn new(
		entries: impl IntoIterator<Item = TrustedExecutable>,
	) -> Result<Self, ProcessRejection> {
		let mut allowlist = Self::default();
		for entry in entries {
			allowlist.insert(entry)?;
		}
		Ok(allowlist)
	}

	pub fn insert(&mut self, entry: TrustedExecutable) -> Result<(), ProcessRejection> {
		if self.entries.contains_key(&entry.logical_name) {
			return Err(ProcessRejection::InvalidTrustedExecutable);
		}
		self.entries.insert(entry.logical_name.clone(), entry);
		Ok(())
	}

	fn select(&self, logical_name: &str) -> Result<&TrustedExecutable, ProcessRejection> {
		let executable = self
			.entries
			.get(logical_name)
			.ok_or(ProcessRejection::ExecutableNotAllowed)?;
		if executable_identity(&executable.canonical_path).as_ref() != Some(&executable.identity) {
			return Err(ProcessRejection::ExecutableChanged);
		}
		Ok(executable)
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecutableIdentity {
	#[cfg(unix)]
	device: u64,
	#[cfg(unix)]
	inode:  u64,
}

fn executable_identity(path: &Path) -> Option<ExecutableIdentity> {
	let metadata = fs::metadata(path).ok()?;
	if !metadata.is_file() {
		return None;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		if metadata.mode() & 0o111 == 0 {
			return None;
		}
		Some(ExecutableIdentity { device: metadata.dev(), inode: metadata.ino() })
	}
	#[cfg(not(unix))]
	{
		Some(ExecutableIdentity {})
	}
}

/// Failures are intentionally redaction-safe: no provider argument, path,
/// stream, or inherited-environment contents are included in their Display
/// implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProcessRejection {
	#[error("arguments are malformed or exceed local-process bounds")]
	InvalidArguments,
	#[error("executable logical name is not permitted")]
	InvalidExecutable,
	#[error("trusted executable configuration is invalid")]
	InvalidTrustedExecutable,
	#[error("executable is not in the trusted allowlist")]
	ExecutableNotAllowed,
	#[error("trusted executable changed after allowlist construction")]
	ExecutableChanged,
	#[error("working directory is invalid")]
	InvalidWorkingDirectory,
	#[error("working directory is outside the workspace root")]
	WorkingDirectoryOutsideRoot,
	#[error("working directory does not exist")]
	WorkingDirectoryNotFound,
	#[error("working directory is not a directory")]
	WorkingDirectoryNotDirectory,
	#[error("environment is not permitted")]
	InvalidEnvironment,
	#[error("process could not be spawned")]
	SpawnFailed,
	#[error("process stream capture failed")]
	CaptureFailed,
	#[error("process-tree termination or reaping failed")]
	TerminationFailed,
	#[error("process-tree containment is unsupported on this platform")]
	ProcessTreeUnsupported,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
	Exited,
	Signaled,
	TimedOut,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamSummary {
	pub provider_text: String,
	pub raw_byte_length: u64,
	pub sha256: String,
	pub invalid_utf8: bool,
	pub provider_truncated: bool,
	pub provider_omitted_bytes: u64,
	pub provider_boundary_truncated: bool,
	pub provider_boundary_omitted_bytes: u64,
	pub artifact_truncated: bool,
	pub artifact_omitted_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamArtifact {
	pub summary:          StreamSummary,
	/// Hex is deterministic JSON-safe raw capture without adding an encoding
	/// dependency. It is never provider-serialized because `ProcessReceipt`
	/// skips the enclosing artifact.
	pub captured_raw_hex: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProcessArtifact {
	pub source_kind:            String,
	pub tool_name:              String,
	pub execution_kind:         String,
	pub executable:             String,
	pub argv_count:             usize,
	pub cwd:                    String,
	pub env_keys:               Vec<String>,
	pub status:                 ProcessStatus,
	pub exit_code:              Option<i32>,
	pub signal:                 Option<i32>,
	pub duration_ms:            u64,
	pub timed_out:              bool,
	pub process_tree_supported: bool,
	pub stdout:                 StreamArtifact,
	pub stderr:                 StreamArtifact,
}

impl ProcessArtifact {
	/// Stable serde bytes for future event integration. Struct field order and
	/// BTreeMap-derived environment key ordering make identical artifacts hash
	/// identically on supported serde versions.
	pub fn canonical_bytes(&self) -> Vec<u8> {
		serde_json::to_vec(self).expect("ProcessArtifact serialization is infallible")
	}

	pub fn canonical_sha256(&self) -> String {
		format!("{:x}", Sha256::digest(self.canonical_bytes()))
	}

	pub fn canonical_byte_length(&self) -> u64 {
		u64::try_from(self.canonical_bytes().len()).unwrap_or(u64::MAX)
	}
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProcessReceipt {
	pub source_kind:            String,
	pub tool_name:              String,
	pub execution_kind:         String,
	pub executable:             String,
	pub argv_count:             usize,
	pub cwd:                    String,
	pub env_keys:               Vec<String>,
	pub status:                 ProcessStatus,
	pub exit_code:              Option<i32>,
	pub signal:                 Option<i32>,
	pub duration_ms:            u64,
	pub timed_out:              bool,
	pub process_tree_supported: bool,
	pub stdout:                 StreamSummary,
	pub stderr:                 StreamSummary,
	/// Trusted integration may persist this separately. Provider JSON
	/// deliberately contains only the bounded receipt summary.
	#[serde(skip)]
	pub artifact:               ProcessArtifact,
}

impl ProcessReceipt {
	/// Deterministic provider-visible JSON containing bounded stream summaries.
	pub fn provider_result_text(&self) -> String {
		serde_json::to_string(self).expect("ProcessReceipt serialization is infallible")
	}
}

/// Executes one structured, allowlisted local process. No catalog, registry, or
/// authority decision is made here; callers must retain `bash` as
/// non-dispatchable until its serial integration is accepted.
pub fn execute(
	workspace_root: &Path,
	allowlist: &TrustedExecutableAllowlist,
	arguments: Value,
) -> Result<ProcessReceipt, ProcessRejection> {
	#[cfg(not(unix))]
	{
		let _ = (workspace_root, allowlist, arguments);
		return Err(ProcessRejection::ProcessTreeUnsupported);
	}

	#[cfg(unix)]
	{
		let args: BashArgs =
			serde_json::from_value(arguments).map_err(|_| ProcessRejection::InvalidArguments)?;
		validate_args(&args)?;
		let executable = allowlist.select(&args.executable)?;
		let cwd_path = resolve_cwd(workspace_root, &args.cwd)?;
		let started = Instant::now();

		let mut command = Command::new(&executable.canonical_path);
		command
			.args(&executable.fixed_argv)
			.args(&args.argv)
			.current_dir(cwd_path)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.env_clear()
			.envs(&args.env);
		configure_process_group(&mut command);
		let child = command.spawn().map_err(|_| ProcessRejection::SpawnFailed)?;
		let mut guard = ProcessGuard::new(child);

		let Some(stdout) = guard.child_mut().stdout.take() else {
			return guard.fail(ProcessRejection::CaptureFailed);
		};
		let Some(stderr) = guard.child_mut().stderr.take() else {
			return guard.fail(ProcessRejection::CaptureFailed);
		};
		if set_nonblocking(&stdout).is_err() || set_nonblocking(&stderr).is_err() {
			return guard.fail(ProcessRejection::CaptureFailed);
		}

		let cancel = Arc::new(AtomicBool::new(false));
		let (sender, receiver) = mpsc::channel();
		let Ok(stdout_thread) =
			spawn_reader(StreamKind::Stdout, stdout, sender.clone(), cancel.clone())
		else {
			return guard.fail(ProcessRejection::CaptureFailed);
		};
		let Ok(stderr_thread) = spawn_reader(StreamKind::Stderr, stderr, sender, cancel.clone())
		else {
			let mut readers = ReaderSet::one(receiver, stdout_thread, cancel);
			return fail_with_readers(&mut guard, &mut readers, ProcessRejection::CaptureFailed);
		};
		let mut readers = ReaderSet::two(receiver, stdout_thread, stderr_thread, cancel);

		let wait = wait_for_direct_child(
			guard.child_mut(),
			Duration::from_millis(u64::from(args.timeout_ms)),
		);
		let (status, timed_out) = match wait {
			Ok(Some(status)) => (status, false),
			Ok(None) => {
				if guard.terminate_and_reap().is_err() {
					let _ = readers.cancel_and_join();
					return Err(ProcessRejection::TerminationFailed);
				}
				let captures = readers.collect(TERMINATION_GRACE, || guard.terminate_and_reap())?;
				if guard.disarm_after_clean_group().is_err() {
					return Err(ProcessRejection::TerminationFailed);
				}
				return Ok(finish_receipt(args, started, status_after_timeout(&guard), true, captures));
			},
			Err(()) => {
				return fail_with_readers(&mut guard, &mut readers, ProcessRejection::CaptureFailed);
			},
		};

		if guard.group_has_members().is_err() {
			return fail_with_readers(&mut guard, &mut readers, ProcessRejection::TerminationFailed);
		}
		if guard.group_has_members().unwrap_or(false) {
			return fail_with_readers(&mut guard, &mut readers, ProcessRejection::CaptureFailed);
		}
		let captures = readers.collect(POST_EXIT_DRAIN, || guard.terminate_and_reap())?;
		if guard.group_has_members().is_err() {
			return fail_with_readers(&mut guard, &mut readers, ProcessRejection::TerminationFailed);
		}
		if guard.group_has_members().unwrap_or(false) {
			return fail_with_readers(&mut guard, &mut readers, ProcessRejection::CaptureFailed);
		}
		if guard.disarm_after_clean_group().is_err() {
			return fail_with_readers(&mut guard, &mut readers, ProcessRejection::TerminationFailed);
		}
		Ok(finish_receipt(args, started, status, timed_out, captures))
	}
}

#[cfg(unix)]
const fn status_after_timeout(guard: &ProcessGuard) -> ExitStatus {
	guard
		.status
		.expect("terminated guard always retains a reaped exit status")
}

#[cfg(unix)]
fn fail_with_readers(
	guard: &mut ProcessGuard,
	readers: &mut ReaderSet,
	rejection: ProcessRejection,
) -> Result<ProcessReceipt, ProcessRejection> {
	let terminated = guard.terminate_and_reap();
	let joined = readers.cancel_and_join();
	if terminated.is_err() {
		return Err(ProcessRejection::TerminationFailed);
	}
	if joined.is_err() {
		return Err(ProcessRejection::CaptureFailed);
	}
	Err(rejection)
}

#[cfg(unix)]
fn finish_receipt(
	args: BashArgs,
	started: Instant,
	status: ExitStatus,
	timed_out: bool,
	captures: (ReaderCapture, ReaderCapture),
) -> ProcessReceipt {
	let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
	let (process_status, exit_code, signal) = receipt_status(status, timed_out);
	let env_keys: Vec<String> = args.env.keys().cloned().collect();
	let stdout = captures.0.into_stream();
	let stderr = captures.1.into_stream();
	let artifact = ProcessArtifact {
		source_kind: "tool_result".to_owned(),
		tool_name: "bash".to_owned(),
		execution_kind: "local_process".to_owned(),
		executable: args.executable.clone(),
		argv_count: args.argv.len(),
		cwd: args.cwd.clone(),
		env_keys: env_keys.clone(),
		status: process_status.clone(),
		exit_code,
		signal,
		duration_ms,
		timed_out,
		process_tree_supported: true,
		stdout,
		stderr,
	};
	ProcessReceipt {
		source_kind: "tool_result".to_owned(),
		tool_name: "bash".to_owned(),
		execution_kind: "local_process".to_owned(),
		executable: args.executable,
		argv_count: args.argv.len(),
		cwd: args.cwd,
		env_keys,
		status: process_status,
		exit_code,
		signal,
		duration_ms,
		timed_out,
		process_tree_supported: true,
		stdout: artifact.stdout.summary.clone(),
		stderr: artifact.stderr.summary.clone(),
		artifact,
	}
}

fn validate_args(args: &BashArgs) -> Result<(), ProcessRejection> {
	validate_logical_name(&args.executable)?;
	if args.timeout_ms == 0 || args.timeout_ms > MAX_TIMEOUT_MS || args.argv.len() > MAX_ARG_COUNT {
		return Err(ProcessRejection::InvalidArguments);
	}
	let argument_bytes = args.argv.iter().try_fold(0_usize, |total, argument| {
		if !valid_string(argument, MAX_STRING_BYTES) {
			return None;
		}
		total.checked_add(argument.len())
	});
	if !matches!(argument_bytes, Some(total) if total <= MAX_ARGUMENT_BYTES) {
		return Err(ProcessRejection::InvalidArguments);
	}
	validate_relative_path_lexically(&args.cwd)
		.map_err(|_| ProcessRejection::InvalidWorkingDirectory)?;
	if !valid_string(&args.cwd, MAX_STRING_BYTES) {
		return Err(ProcessRejection::InvalidWorkingDirectory);
	}
	let mut environment_bytes = 0_usize;
	for (key, value) in &args.env {
		if !ENV_ALLOWLIST.contains(&key.as_str())
			|| !valid_string(value, MAX_ENV_VALUE_BYTES)
			|| key.contains('\0')
		{
			return Err(ProcessRejection::InvalidEnvironment);
		}
		environment_bytes = environment_bytes
			.checked_add(key.len())
			.and_then(|total| total.checked_add(value.len()))
			.ok_or(ProcessRejection::InvalidEnvironment)?;
	}
	if environment_bytes > MAX_ENV_BYTES {
		return Err(ProcessRejection::InvalidEnvironment);
	}
	Ok(())
}

fn valid_string(value: &str, maximum: usize) -> bool {
	!value.contains('\0') && value.len() <= maximum
}

fn validate_logical_name(logical_name: &str) -> Result<(), ProcessRejection> {
	let bytes = logical_name.as_bytes();
	if bytes.is_empty()
		|| bytes[0] < b'a'
		|| bytes[0] > b'z'
		|| !bytes.iter().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
		}) || SHELL_LOGICAL_NAMES.contains(&logical_name)
	{
		return Err(ProcessRejection::InvalidExecutable);
	}
	Ok(())
}

fn resolve_cwd(workspace_root: &Path, cwd: &str) -> Result<PathBuf, ProcessRejection> {
	validate_relative_path_lexically(cwd).map_err(|_| ProcessRejection::InvalidWorkingDirectory)?;
	let root = WorkspaceRoot::new(workspace_root).map_err(map_root_error)?;
	let resolved = root.resolve(cwd).map_err(map_cwd_error)?;
	if !resolved.is_dir() {
		return Err(ProcessRejection::WorkingDirectoryNotDirectory);
	}
	Ok(resolved)
}

fn map_root_error(error: PathBoundError) -> ProcessRejection {
	match error {
		PathBoundError::RootNotFound | PathBoundError::NotFound => {
			ProcessRejection::WorkingDirectoryNotFound
		},
		PathBoundError::OutOfRoot => ProcessRejection::WorkingDirectoryOutsideRoot,
		_ => ProcessRejection::InvalidWorkingDirectory,
	}
}

fn map_cwd_error(error: PathBoundError) -> ProcessRejection {
	match error {
		PathBoundError::NotFound | PathBoundError::RootNotFound => {
			ProcessRejection::WorkingDirectoryNotFound
		},
		PathBoundError::OutOfRoot => ProcessRejection::WorkingDirectoryOutsideRoot,
		_ => ProcessRejection::InvalidWorkingDirectory,
	}
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
	use std::os::unix::process::CommandExt;
	command.process_group(0);
}

#[cfg(unix)]
struct ProcessGuard {
	child:      Child,
	process_id: u32,
	status:     Option<ExitStatus>,
	armed:      bool,
}

#[cfg(unix)]
impl ProcessGuard {
	fn new(child: Child) -> Self {
		let process_id = child.id();
		Self { child, process_id, status: None, armed: true }
	}

	const fn child_mut(&mut self) -> &mut Child {
		&mut self.child
	}

	fn fail(&mut self, rejection: ProcessRejection) -> Result<ProcessReceipt, ProcessRejection> {
		if self.terminate_and_reap().is_err() {
			return Err(ProcessRejection::TerminationFailed);
		}
		Err(rejection)
	}

	fn terminate_and_reap(&mut self) -> Result<(), ProcessRejection> {
		if !self.armed {
			return Ok(());
		}
		let mut failed = signal_group(self.process_id, libc::SIGTERM).is_err();
		match self.group_has_members() {
			Ok(true) => {
				thread::sleep(TERMINATION_GRACE);
				match self.group_has_members() {
					Ok(true) if signal_group(self.process_id, libc::SIGKILL).is_err() => {
						failed = true;
					},
					Err(_) => failed = true,
					Ok(_) => {},
				}
			},
			Err(_) => failed = true,
			Ok(false) => {},
		}
		if self.force_reap_direct_child().is_err() {
			failed = true;
		}
		if wait_for_group_gone(self.process_id).is_err() {
			failed = true;
		}
		if failed {
			return Err(ProcessRejection::TerminationFailed);
		}
		self.armed = false;
		Ok(())
	}

	fn force_reap_direct_child(&mut self) -> Result<(), ProcessRejection> {
		if self.status.is_some() {
			return Ok(());
		}
		match self.child.try_wait() {
			Ok(Some(status)) => {
				self.status = Some(status);
				return Ok(());
			},
			Ok(None) | Err(_) => {
				let _ = self.child.kill();
			},
		}
		self.reap_direct_child()
	}

	fn reap_direct_child(&mut self) -> Result<(), ProcessRejection> {
		if self.status.is_some() {
			return Ok(());
		}
		let deadline = Instant::now() + GROUP_REAP_GRACE;
		loop {
			match self.child.try_wait() {
				Ok(Some(status)) => {
					self.status = Some(status);
					return Ok(());
				},
				Ok(None) if Instant::now() < deadline => thread::sleep(READER_POLL),
				Ok(None) | Err(_) => return Err(ProcessRejection::TerminationFailed),
			}
		}
	}

	fn group_has_members(&self) -> Result<bool, ProcessRejection> {
		group_has_members(self.process_id)
	}

	fn disarm_after_clean_group(&mut self) -> Result<(), ProcessRejection> {
		self.reap_direct_child()?;
		if self.group_has_members()? {
			return Err(ProcessRejection::TerminationFailed);
		}
		self.armed = false;
		Ok(())
	}
}

#[cfg(unix)]
impl Drop for ProcessGuard {
	fn drop(&mut self) {
		if self.armed {
			let _ = self.terminate_and_reap();
		}
	}
}

#[cfg(unix)]
fn wait_for_direct_child(child: &mut Child, timeout: Duration) -> Result<Option<ExitStatus>, ()> {
	let deadline = Instant::now() + timeout;
	loop {
		match child.try_wait() {
			Ok(Some(status)) => return Ok(Some(status)),
			Ok(None) if Instant::now() >= deadline => return Ok(None),
			Ok(None) => thread::sleep(READER_POLL),
			Err(_) => return Err(()),
		}
	}
}

#[cfg(unix)]
fn signal_group(process_id: u32, signal: libc::c_int) -> Result<(), ProcessRejection> {
	let group = i32::try_from(process_id).map_err(|_| ProcessRejection::TerminationFailed)?;
	// SAFETY: `kill` receives a negative process-group id created by CommandExt.
	let result = unsafe { libc::kill(-group, signal) };
	if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
		return Ok(());
	}
	Err(ProcessRejection::TerminationFailed)
}

#[cfg(unix)]
fn group_has_members(process_id: u32) -> Result<bool, ProcessRejection> {
	let group = i32::try_from(process_id).map_err(|_| ProcessRejection::TerminationFailed)?;
	// SAFETY: signal 0 probes the process group without delivering a signal.
	let result = unsafe { libc::kill(-group, 0) };
	if result == 0 {
		return Ok(true);
	}
	match io::Error::last_os_error().raw_os_error() {
		Some(libc::ESRCH) => Ok(false),
		_ => Err(ProcessRejection::TerminationFailed),
	}
}

#[cfg(unix)]
fn wait_for_group_gone(process_id: u32) -> Result<(), ProcessRejection> {
	let deadline = Instant::now() + GROUP_REAP_GRACE;
	loop {
		if !group_has_members(process_id)? {
			return Ok(());
		}
		if Instant::now() >= deadline {
			return Err(ProcessRejection::TerminationFailed);
		}
		thread::sleep(READER_POLL);
	}
}

#[cfg(unix)]
fn set_nonblocking<R: std::os::fd::AsRawFd>(reader: &R) -> io::Result<()> {
	let descriptor = reader.as_raw_fd();
	// SAFETY: fcntl only inspects/modifies flags on this owned pipe descriptor.
	let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: the descriptor remains owned by the caller while this flag is set.
	if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

struct ReaderCapture {
	raw_byte_length:  u64,
	hash:             Sha256,
	provider_capture: Vec<u8>,
	artifact_capture: Vec<u8>,
	utf8:             Utf8Tracker,
}

impl ReaderCapture {
	fn new() -> Self {
		Self {
			raw_byte_length:  0,
			hash:             Sha256::new(),
			provider_capture: Vec::with_capacity(PROVIDER_CAPTURE_BYTES),
			artifact_capture: Vec::with_capacity(ARTIFACT_CAPTURE_BYTES),
			utf8:             Utf8Tracker::default(),
		}
	}

	fn push(&mut self, bytes: &[u8]) {
		self.raw_byte_length = self
			.raw_byte_length
			.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
		self.hash.update(bytes);
		append_bounded(&mut self.provider_capture, bytes, PROVIDER_CAPTURE_BYTES);
		append_bounded(&mut self.artifact_capture, bytes, ARTIFACT_CAPTURE_BYTES);
		self.utf8.push(bytes);
	}

	fn into_stream(mut self) -> StreamArtifact {
		self.utf8.finish();
		let (provider_text, provider_capture_length, boundary_omitted_bytes) =
			provider_text_from_capture(&self.provider_capture, self.utf8.invalid);
		let provider_omitted_bytes = self
			.raw_byte_length
			.saturating_sub(u64::try_from(provider_capture_length).unwrap_or(u64::MAX));
		let artifact_length = u64::try_from(self.artifact_capture.len()).unwrap_or(u64::MAX);
		let artifact_omitted_bytes = self.raw_byte_length.saturating_sub(artifact_length);
		StreamArtifact {
			summary:          StreamSummary {
				provider_text,
				raw_byte_length: self.raw_byte_length,
				sha256: format!("{:x}", self.hash.finalize()),
				invalid_utf8: self.utf8.invalid,
				provider_truncated: provider_omitted_bytes > 0,
				provider_omitted_bytes,
				provider_boundary_truncated: boundary_omitted_bytes > 0,
				provider_boundary_omitted_bytes: boundary_omitted_bytes,
				artifact_truncated: artifact_omitted_bytes > 0,
				artifact_omitted_bytes,
			},
			captured_raw_hex: hex_encode(&self.artifact_capture),
		}
	}
}

fn provider_text_from_capture(capture: &[u8], invalid_utf8: bool) -> (String, usize, u64) {
	if invalid_utf8 {
		return (String::from_utf8_lossy(capture).into_owned(), capture.len(), 0);
	}
	match std::str::from_utf8(capture) {
		Ok(text) => (text.to_owned(), capture.len(), 0),
		Err(error) if error.error_len().is_none() => {
			let complete = error.valid_up_to();
			(
				std::str::from_utf8(&capture[..complete])
					.expect("valid_utf8 prefix reported by Utf8Error")
					.to_owned(),
				complete,
				u64::try_from(capture.len().saturating_sub(complete)).unwrap_or(u64::MAX),
			)
		},
		Err(_) => (String::from_utf8_lossy(capture).into_owned(), capture.len(), 0),
	}
}

fn append_bounded(destination: &mut Vec<u8>, source: &[u8], maximum: usize) {
	let remaining = maximum.saturating_sub(destination.len());
	destination.extend_from_slice(&source[..source.len().min(remaining)]);
}

#[derive(Default)]
struct Utf8Tracker {
	pending: Vec<u8>,
	invalid: bool,
}

impl Utf8Tracker {
	fn push(&mut self, bytes: &[u8]) {
		self.pending.extend_from_slice(bytes);
		loop {
			match std::str::from_utf8(&self.pending) {
				Ok(_) => {
					self.pending.clear();
					return;
				},
				Err(error) => {
					let valid = error.valid_up_to();
					if let Some(invalid_length) = error.error_len() {
						self.invalid = true;
						self.pending.drain(..valid + invalid_length);
					} else {
						self.pending.drain(..valid);
						return;
					}
				},
			}
		}
	}

	const fn finish(&mut self) {
		if !self.pending.is_empty() {
			self.invalid = true;
		}
	}
}

#[derive(Clone, Copy)]
enum StreamKind {
	Stdout,
	Stderr,
}

fn spawn_reader<R>(
	kind: StreamKind,
	mut reader: R,
	sender: mpsc::Sender<(StreamKind, Result<ReaderCapture, ()>)>,
	cancel: Arc<AtomicBool>,
) -> io::Result<thread::JoinHandle<()>>
where
	R: Read + Send + 'static,
{
	thread::Builder::new().spawn(move || {
		let mut capture = ReaderCapture::new();
		let mut buffer = [0_u8; 8192];
		let result = loop {
			if cancel.load(Ordering::Acquire) {
				break Err(());
			}
			match reader.read(&mut buffer) {
				Ok(0) => break Ok(capture),
				Ok(length) => capture.push(&buffer[..length]),
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(READER_POLL),
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				Err(_) => break Err(()),
			}
		};
		let _ = sender.send((kind, result));
	})
}

struct ReaderSet {
	receiver:      Receiver<(StreamKind, Result<ReaderCapture, ()>)>,
	stdout_thread: Option<thread::JoinHandle<()>>,
	stderr_thread: Option<thread::JoinHandle<()>>,
	cancel:        Arc<AtomicBool>,
}

impl ReaderSet {
	const fn one(
		receiver: Receiver<(StreamKind, Result<ReaderCapture, ()>)>,
		stdout_thread: thread::JoinHandle<()>,
		cancel: Arc<AtomicBool>,
	) -> Self {
		Self { receiver, stdout_thread: Some(stdout_thread), stderr_thread: None, cancel }
	}

	const fn two(
		receiver: Receiver<(StreamKind, Result<ReaderCapture, ()>)>,
		stdout_thread: thread::JoinHandle<()>,
		stderr_thread: thread::JoinHandle<()>,
		cancel: Arc<AtomicBool>,
	) -> Self {
		Self {
			receiver,
			stdout_thread: Some(stdout_thread),
			stderr_thread: Some(stderr_thread),
			cancel,
		}
	}

	fn collect<F>(
		&mut self,
		maximum_wait: Duration,
		mut terminate: F,
	) -> Result<(ReaderCapture, ReaderCapture), ProcessRejection>
	where
		F: FnMut() -> Result<(), ProcessRejection>,
	{
		let deadline = Instant::now() + maximum_wait;
		let mut stdout = None;
		let mut stderr = None;
		while stdout.is_none() || stderr.is_none() {
			let remaining = deadline.saturating_duration_since(Instant::now());
			match self.receiver.recv_timeout(remaining) {
				Ok((StreamKind::Stdout, Ok(capture))) => stdout = Some(capture),
				Ok((StreamKind::Stderr, Ok(capture))) => stderr = Some(capture),
				Ok((_, Err(()))) | Err(RecvTimeoutError::Disconnected | RecvTimeoutError::Timeout) => {
					let termination_failed = terminate().is_err();
					let _ = self.cancel_and_join();
					if termination_failed {
						return Err(ProcessRejection::TerminationFailed);
					}
					return Err(ProcessRejection::CaptureFailed);
				},
			}
		}
		if self.join_all().is_err() {
			let terminated = terminate();
			return if terminated.is_err() {
				Err(ProcessRejection::TerminationFailed)
			} else {
				Err(ProcessRejection::CaptureFailed)
			};
		}
		Ok((
			stdout.expect("stdout capture is collected"),
			stderr.expect("stderr capture is collected"),
		))
	}

	fn cancel_and_join(&mut self) -> Result<(), ()> {
		self.cancel.store(true, Ordering::Release);
		self.join_all()
	}

	fn join_all(&mut self) -> Result<(), ()> {
		let stdout = self
			.stdout_thread
			.take()
			.map_or(Ok(()), |thread| thread.join().map_err(|_| ()));
		let stderr = self
			.stderr_thread
			.take()
			.map_or(Ok(()), |thread| thread.join().map_err(|_| ()));
		stdout.and(stderr)
	}
}

fn receipt_status(
	status: ExitStatus,
	timed_out: bool,
) -> (ProcessStatus, Option<i32>, Option<i32>) {
	if timed_out {
		return (ProcessStatus::TimedOut, None, None);
	}
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt;
		if let Some(signal) = status.signal() {
			return (ProcessStatus::Signaled, None, Some(signal));
		}
	}
	(ProcessStatus::Exited, status.code(), None)
}

fn hex_encode(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len().saturating_mul(2));
	for byte in bytes {
		output.push(char::from(HEX[usize::from(byte >> 4)]));
		output.push(char::from(HEX[usize::from(byte & 0x0f)]));
	}
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn utf8_tracker_accepts_a_scalar_split_between_reads() {
		let mut tracker = Utf8Tracker::default();
		tracker.push(&[0xe2, 0x82]);
		tracker.push(&[0xac]);
		tracker.finish();
		assert!(!tracker.invalid);
	}

	#[test]
	fn utf8_tracker_records_invalid_tail_after_all_stream_bytes() {
		let mut tracker = Utf8Tracker::default();
		tracker.push(&[0xe2, 0x82]);
		tracker.finish();
		assert!(tracker.invalid);
	}

	#[test]
	fn provider_prefix_drops_only_an_incomplete_terminal_scalar() {
		let mut bytes = vec![b'x'; PROVIDER_CAPTURE_BYTES - 2];
		bytes.extend_from_slice(&[0xe2, 0x82]);
		let (text, retained, omitted) = provider_text_from_capture(&bytes, false);
		assert_eq!(text.len(), PROVIDER_CAPTURE_BYTES - 2);
		assert_eq!(retained, PROVIDER_CAPTURE_BYTES - 2);
		assert_eq!(omitted, 2);
		assert!(!text.contains('\u{fffd}'));
	}

	struct PanickingRead;

	impl Read for PanickingRead {
		fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
			panic!("reader panic seam")
		}
	}

	struct WouldBlockUntilCancelled(Arc<AtomicBool>);

	impl Read for WouldBlockUntilCancelled {
		fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
			if self.0.load(Ordering::Acquire) {
				return Ok(0);
			}
			Err(io::Error::from(io::ErrorKind::WouldBlock))
		}
	}

	#[test]
	fn reader_panic_cancels_and_joins_the_other_reader() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (sender, receiver) = mpsc::channel();
		let stdout = spawn_reader(StreamKind::Stdout, PanickingRead, sender.clone(), cancel.clone())
			.expect("spawn panic seam");
		let stderr = spawn_reader(
			StreamKind::Stderr,
			WouldBlockUntilCancelled(cancel.clone()),
			sender,
			cancel.clone(),
		)
		.expect("spawn would-block seam");
		let mut readers = ReaderSet::two(receiver, stdout, stderr, cancel.clone());
		assert!(matches!(
			readers.collect(Duration::from_millis(20), || Ok(())),
			Err(ProcessRejection::CaptureFailed)
		));
		assert!(cancel.load(Ordering::Acquire));
		assert!(readers.stdout_thread.is_none() && readers.stderr_thread.is_none());
	}

	struct ErrorRead;

	impl Read for ErrorRead {
		fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
			Err(io::Error::other("read error seam"))
		}
	}

	#[test]
	fn reader_error_cancels_and_joins_the_other_reader() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (sender, receiver) = mpsc::channel();
		let stdout = spawn_reader(StreamKind::Stdout, ErrorRead, sender.clone(), cancel.clone())
			.expect("spawn error seam");
		let stderr = spawn_reader(
			StreamKind::Stderr,
			WouldBlockUntilCancelled(cancel.clone()),
			sender,
			cancel.clone(),
		)
		.expect("spawn would-block seam");
		let mut readers = ReaderSet::two(receiver, stdout, stderr, cancel.clone());
		assert!(matches!(
			readers.collect(Duration::from_millis(50), || Ok(())),
			Err(ProcessRejection::CaptureFailed)
		));
		assert!(cancel.load(Ordering::Acquire));
		assert!(readers.stdout_thread.is_none() && readers.stderr_thread.is_none());
	}

	#[cfg(unix)]
	#[test]
	fn dropping_process_guard_terminates_and_reaps_the_direct_child() {
		let executable = std::env::current_exe().expect("current unit-test executable");
		let mut command = Command::new(executable);
		command
			.args([
				"--ignored",
				"--exact",
				"tools::bash::tests::process_guard_drop_helper",
				"--nocapture",
			])
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());
		configure_process_group(&mut command);
		let child = command.spawn().expect("spawn process-guard helper");
		let process_id = child.id();
		drop(ProcessGuard::new(child));
		assert!(!group_has_members(process_id).expect("probe helper process group"));
	}

	#[cfg(unix)]
	#[test]
	#[ignore = "hermetic process-guard helper selected only by its parent unit test"]
	fn process_guard_drop_helper() {
		loop {
			thread::sleep(Duration::from_secs(1));
		}
	}
}
