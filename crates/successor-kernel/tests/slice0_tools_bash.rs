use std::{
	collections::BTreeMap,
	fs,
	io::Write,
	path::PathBuf,
	process::Command,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::json;
use sha2::{Digest, Sha256};
use successor_kernel::tools::{
	bash::{
		BashArgs, ProcessRejection, ProcessStatus, TrustedExecutable, TrustedExecutableAllowlist,
		execute,
	},
	catalog,
	registry::slice0_registry,
};
use successor_protocol::tool_catalog::ToolStatusV0;

fn unique_temp_dir(label: &str) -> PathBuf {
	let nonce = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("system time is after Unix epoch")
		.as_nanos();
	let directory =
		std::env::temp_dir().join(format!("successor-bash-{label}-{}-{nonce}", std::process::id()));
	fs::create_dir_all(&directory).expect("create temporary directory");
	directory
}

fn helper_allowlist(helper: &str) -> TrustedExecutableAllowlist {
	let binary = std::env::current_exe().expect("current integration-test executable");
	let fixed_argv = vec![
		"--ignored".to_owned(),
		"--exact".to_owned(),
		helper.to_owned(),
		"--nocapture".to_owned(),
	];
	TrustedExecutableAllowlist::new([
		TrustedExecutable::new("helper", binary, fixed_argv).expect("trusted helper")
	])
	.expect("one trusted helper")
}

fn helper_allowlist_with_fixed_env(
	helper: &str,
	fixed_env: BTreeMap<String, String>,
) -> TrustedExecutableAllowlist {
	let binary = std::env::current_exe().expect("current integration-test executable");
	let fixed_argv = vec![
		"--ignored".to_owned(),
		"--exact".to_owned(),
		helper.to_owned(),
		"--nocapture".to_owned(),
	];
	TrustedExecutableAllowlist::new([TrustedExecutable::new("helper", binary, fixed_argv)
		.expect("trusted helper")
		.with_fixed_env(fixed_env)
		.expect("valid fixed env")])
	.expect("one trusted helper")
}

fn arguments() -> serde_json::Value {
	json!({"executable":"helper"})
}

fn decode_hex(encoded: &str) -> Vec<u8> {
	assert_eq!(encoded.len() % 2, 0, "hex capture has whole bytes");
	encoded
		.as_bytes()
		.chunks_exact(2)
		.map(|pair| {
			let pair = std::str::from_utf8(pair).expect("hex is ASCII");
			u8::from_str_radix(pair, 16).expect("capture is lowercase hex")
		})
		.collect()
}

#[test]
fn dto_rejects_shell_source_unknown_fields_and_invalid_logical_names() {
	let root = unique_temp_dir("dto");
	let allowlist = helper_allowlist("helper_streams");
	for argument in [
		json!({"executable":"helper", "command":"echo unsafe"}),
		json!({"executable":"helper", "cmd":"echo unsafe"}),
		json!({"executable":"helper", "script":"echo unsafe"}),
		json!({"executable":"helper", "stdin":"unsafe"}),
		json!({"executable":"/bin/anything"}),
		json!({"executable":"Bash"}),
		json!({"executable":"bash"}),
		json!({"executable":"sh"}),
	] {
		assert!(matches!(
			execute(&root, &allowlist, argument),
			Err(ProcessRejection::InvalidArguments | ProcessRejection::InvalidExecutable)
		));
	}
}

#[test]
fn schema_and_trusted_executable_configuration_are_closed() {
	let schema = serde_json::to_value(BashArgs::schema()).expect("schema serializes");
	let required = schema["required"].as_array().expect("schema required list");
	assert!(required.contains(&json!("executable")));
	for defaulted in ["argv", "cwd", "timeout_ms", "env"] {
		assert!(!required.contains(&json!(defaulted)), "{defaulted} is defaulted");
	}
	assert_eq!(schema["additionalProperties"], json!(false));
	assert!(
		serde_json::from_value::<BashArgs>(json!({"executable":"helper","unknown":true})).is_err()
	);
	assert!(matches!(
		TrustedExecutable::new("helper", "relative-helper", vec![]),
		Err(ProcessRejection::InvalidTrustedExecutable)
	));
}

#[test]
fn allowlist_revalidates_executable_identity_before_spawn() {
	let root = unique_temp_dir("replace-root");
	let binary = std::env::current_exe().expect("current executable");
	let executable = root.join("trusted-helper");
	let replacement = root.join("replacement-helper");
	fs::copy(&binary, &executable).expect("copy trusted executable");
	fs::copy(&binary, &replacement).expect("copy replacement executable");
	let allowlist =
		TrustedExecutableAllowlist::new([
			TrustedExecutable::new("helper", &executable, vec![]).expect("trusted copy")
		])
		.expect("allowlist");
	fs::rename(&replacement, &executable).expect("replace trusted executable inode");
	assert_eq!(execute(&root, &allowlist, arguments()), Err(ProcessRejection::ExecutableChanged));
}

#[cfg(unix)]
#[test]
fn allowlist_preserves_proxy_argv_zero_and_rejects_retargeting() {
	use std::os::unix::fs::symlink;

	let root = unique_temp_dir("proxy-path");
	let binary = std::env::current_exe().expect("current executable");
	let proxy = root.join("cargo-proxy");
	let replacement = root.join("replacement-helper");
	symlink(&binary, &proxy).expect("create trusted executable proxy");
	fs::copy(&binary, &replacement).expect("copy replacement executable");
	let fixed_argv = vec![
		"--ignored".to_owned(),
		"--exact".to_owned(),
		"helper_proxy_argv_zero".to_owned(),
		"--nocapture".to_owned(),
	];
	let allowlist =
		TrustedExecutableAllowlist::new([
			TrustedExecutable::new("helper", &proxy, fixed_argv).expect("trusted proxy")
		])
		.expect("proxy allowlist");

	let receipt = execute(&root, &allowlist, arguments()).expect("proxy helper receipt");
	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));

	fs::remove_file(&proxy).expect("remove original proxy");
	symlink(&replacement, &proxy).expect("retarget executable proxy");
	assert_eq!(execute(&root, &allowlist, arguments()), Err(ProcessRejection::ExecutableChanged));
}

#[test]
fn cwd_and_environment_policy_are_typed_and_case_exact() {
	let root = unique_temp_dir("policy");
	fs::write(root.join("file"), b"not a directory").expect("write file");
	let allowlist = helper_allowlist("helper_streams");
	for argument in [
		json!({"executable":"helper", "cwd":"/tmp"}),
		json!({"executable":"helper", "cwd":"../escape"}),
		json!({"executable":"helper", "cwd":"missing"}),
		json!({"executable":"helper", "cwd":"file"}),
	] {
		assert!(matches!(
			execute(&root, &allowlist, argument),
			Err(
				ProcessRejection::InvalidWorkingDirectory
					| ProcessRejection::WorkingDirectoryNotFound
					| ProcessRejection::WorkingDirectoryNotDirectory
			)
		));
	}
	for environment in [
		json!({"ci":"wrong case"}),
		json!({"AWS_SECRET_ACCESS_KEY":"no"}),
		json!({"CI":"bad\u{0000}value"}),
	] {
		assert_eq!(
			execute(&root, &allowlist, json!({"executable":"helper", "env":environment})),
			Err(ProcessRejection::InvalidEnvironment)
		);
	}
	#[cfg(unix)]
	{
		std::os::unix::fs::symlink(std::env::temp_dir(), root.join("outside"))
			.expect("create escape symlink");
		assert_eq!(
			execute(&root, &allowlist, json!({"executable":"helper", "cwd":"outside"})),
			Err(ProcessRejection::WorkingDirectoryOutsideRoot)
		);
	}
}

#[test]
fn separate_streams_nonzero_and_env_clear_are_receipts() {
	let root = unique_temp_dir("streams");
	let allowlist = helper_allowlist("helper_streams");
	let receipt =
		execute(&root, &allowlist, json!({"executable":"helper", "env":{"CI":"hermetic"}}))
			.expect("helper receipt");
	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));
	assert!(receipt.stdout.provider_text.contains("stdout-hermetic"));
	assert!(receipt.stderr.provider_text.contains("stderr-hermetic"));
	assert!(receipt.provider_result_text().contains("local_process"));
	assert_eq!(receipt.artifact.stdout.summary, receipt.stdout);

	let nonzero = execute(&root, &helper_allowlist("helper_nonzero"), arguments())
		.expect("nonzero remains receipt");
	assert_eq!(nonzero.status, ProcessStatus::Exited);
	assert_ne!(nonzero.exit_code, Some(0));
}

#[test]
fn with_fixed_env_rejects_invalid_keys_and_over_bound_values() {
	let executable = || {
		TrustedExecutable::new("helper", std::env::current_exe().expect("current executable"), vec![])
			.expect("trusted helper")
	};
	for key in [
		"",
		"1START",
		"lower",
		"HAS=EQUALS",
		"HAS\u{0}NUL",
		"MIXEDcase",
		"LANG",
		"CI",
		"PATHS",
		"PATH_",
		"path",
	] {
		let mut fixed_env = BTreeMap::new();
		fixed_env.insert(key.to_owned(), "value".to_owned());
		assert!(
			matches!(
				executable().with_fixed_env(fixed_env),
				Err(ProcessRejection::InvalidTrustedExecutable)
			),
			"key {key:?} must be rejected"
		);
	}

	let mut oversize_key = BTreeMap::new();
	oversize_key.insert(format!("A{}", "A".repeat(16 * 1024)), "value".to_owned());
	assert!(matches!(
		executable().with_fixed_env(oversize_key),
		Err(ProcessRejection::InvalidTrustedExecutable)
	));

	let mut nul_value = BTreeMap::new();
	nul_value.insert("PATH".to_owned(), "bad\u{0}value".to_owned());
	assert!(matches!(
		executable().with_fixed_env(nul_value),
		Err(ProcessRejection::InvalidTrustedExecutable)
	));

	let mut oversize_value = BTreeMap::new();
	oversize_value.insert("PATH".to_owned(), "x".repeat(17 * 1024));
	assert!(matches!(
		executable().with_fixed_env(oversize_value),
		Err(ProcessRejection::InvalidTrustedExecutable)
	));

	assert!(executable().with_fixed_env(BTreeMap::new()).is_ok());
}

#[test]
fn trusted_executable_debug_redacts_fixed_env_values() {
	const SENTINEL: &str = "fixed-env-debug-sentinel-1d71";
	let mut fixed_env = BTreeMap::new();
	fixed_env.insert("PATH".to_owned(), SENTINEL.to_owned());
	let executable = TrustedExecutable::new(
		"helper",
		std::env::current_exe().expect("current executable"),
		vec![],
	)
	.expect("trusted helper")
	.with_fixed_env(fixed_env)
	.expect("valid fixed env");

	let executable_debug = format!("{executable:?}");
	assert!(executable_debug.contains("PATH"));
	assert!(!executable_debug.contains(SENTINEL));
	let allowlist = TrustedExecutableAllowlist::new([executable]).expect("one trusted helper");
	assert!(!format!("{allowlist:?}").contains(SENTINEL));
}

#[test]
fn provider_and_fixed_env_key_collision_is_rejected_even_with_matching_values() {
	let root = unique_temp_dir("fixed-env-collision");
	let mut fixed_env = BTreeMap::new();
	fixed_env.insert("PATH".to_owned(), "/usr/bin".to_owned());
	let allowlist = helper_allowlist_with_fixed_env("helper_streams", fixed_env);

	let matching =
		execute(&root, &allowlist, json!({"executable":"helper", "env":{"PATH":"/usr/bin"}}));
	assert_eq!(matching, Err(ProcessRejection::InvalidEnvironment));
	assert!(!format!("{matching:?}").contains("/usr/bin"));

	let differing =
		execute(&root, &allowlist, json!({"executable":"helper", "env":{"PATH":"/different"}}));
	assert_eq!(differing, Err(ProcessRejection::InvalidEnvironment));
}

#[test]
fn merged_fixed_and_provider_env_obeys_the_total_byte_bound() {
	let root = unique_temp_dir("fixed-env-merged-bound");
	let mut fixed_env = BTreeMap::new();
	fixed_env.insert("PATH".to_owned(), "x".repeat(14 * 1024));
	let allowlist = helper_allowlist_with_fixed_env("helper_noop", fixed_env);
	let result = execute(
		&root,
		&allowlist,
		json!({
			"executable": "helper",
			"env": {
				"CI": "y".repeat(14 * 1024),
				"NO_COLOR": "y".repeat(14 * 1024),
				"TERM": "y".repeat(14 * 1024),
				"CARGO_TERM_COLOR": "y".repeat(14 * 1024),
			}
		}),
	);
	assert_eq!(result, Err(ProcessRejection::InvalidEnvironment));
}

#[test]
fn empty_fixed_env_leaves_process_environment_unchanged() {
	let root = unique_temp_dir("fixed-env-empty");
	let executable =
		TrustedExecutable::new("helper", std::env::current_exe().expect("current executable"), vec![
			"--ignored".to_owned(),
			"--exact".to_owned(),
			"helper_streams".to_owned(),
			"--nocapture".to_owned(),
		])
		.expect("trusted helper")
		.with_fixed_env(BTreeMap::new())
		.expect("empty fixed env is valid");
	let allowlist = TrustedExecutableAllowlist::new([executable]).expect("allowlist");

	let receipt =
		execute(&root, &allowlist, json!({"executable":"helper", "env":{"CI":"hermetic"}}))
			.expect("helper receipt");
	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));
	assert_eq!(receipt.env_keys, vec!["CI".to_owned()]);
}

#[test]
fn fixed_env_is_visible_to_the_child_process() {
	let root = unique_temp_dir("fixed-env-visible");
	let mut fixed_env = BTreeMap::new();
	fixed_env.insert("PATH".to_owned(), "fixed-visible-value".to_owned());
	let allowlist = helper_allowlist_with_fixed_env("helper_fixed_env", fixed_env);

	let receipt = execute(&root, &allowlist, arguments()).expect("fixed-env helper receipt");
	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));
	assert!(receipt.stdout.provider_text.contains("fixed-visible-value"));
}

#[test]
fn fixed_env_value_is_never_directly_serialized_when_the_child_does_not_echo_it() {
	let root = unique_temp_dir("fixed-env-silent");
	const SENTINEL: &str = "fixed-env-must-not-be-serialized-directly-9f21";
	let mut fixed_env = BTreeMap::new();
	fixed_env.insert("PATH".to_owned(), SENTINEL.to_owned());
	let allowlist = helper_allowlist_with_fixed_env("helper_noop", fixed_env);

	let receipt = execute(&root, &allowlist, arguments()).expect("silent helper receipt");
	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));
	assert_eq!(receipt.env_keys, vec!["PATH".to_owned()]);
	assert!(!receipt.stdout.provider_text.contains(SENTINEL));
	assert!(!receipt.stderr.provider_text.contains(SENTINEL));
	assert!(!receipt.provider_result_text().contains(SENTINEL));
	assert!(
		!receipt
			.artifact
			.canonical_bytes()
			.windows(SENTINEL.len())
			.any(|window| window == SENTINEL.as_bytes())
	);
	assert!(!format!("{receipt:?}").contains(SENTINEL));
}

#[test]
fn fixed_and_provider_env_keys_form_a_sorted_union_in_the_receipt() {
	let root = unique_temp_dir("fixed-env-union");
	let mut fixed_env = BTreeMap::new();
	fixed_env.insert("PATH".to_owned(), "/usr/bin".to_owned());
	let allowlist = helper_allowlist_with_fixed_env("helper_noop", fixed_env);

	let receipt =
		execute(&root, &allowlist, json!({"executable":"helper", "env":{"CI":"hermetic"}}))
			.expect("union receipt");
	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));
	assert_eq!(receipt.env_keys, vec!["CI".to_owned(), "PATH".to_owned()]);
	assert_eq!(receipt.artifact.env_keys, receipt.env_keys);
}

#[test]
fn flood_hashes_every_drained_byte_beyond_both_capture_caps() {
	let root = unique_temp_dir("flood");
	let receipt =
		execute(&root, &helper_allowlist("helper_flood"), arguments()).expect("flood receipt");
	let retained_cap_hash =
		format!("{:x}", Sha256::digest(decode_hex(&receipt.artifact.stdout.captured_raw_hex)));
	assert!(receipt.stdout.raw_byte_length >= 1_200_000);
	assert_ne!(
		receipt.stdout.sha256, retained_cap_hash,
		"full-stream hash must not hash only retained bytes"
	);
	assert!(receipt.stdout.provider_truncated);
	assert!(receipt.stdout.artifact_truncated);
	assert!(receipt.stdout.provider_omitted_bytes > 0);
	assert!(receipt.stdout.artifact_omitted_bytes > 0);
	assert_eq!(receipt.artifact.stdout.captured_raw_hex.len(), 2 * 1024 * 1024);
	let provider: serde_json::Value =
		serde_json::from_str(&receipt.provider_result_text()).expect("provider result is JSON");
	assert!(provider.get("artifact").is_none());
	assert!(provider.pointer("/stdout/captured_raw_hex").is_none());
	assert!(provider.pointer("/stderr/captured_raw_hex").is_none());
	assert!(receipt.provider_result_text().len() < receipt.artifact.canonical_bytes().len() / 8);
}

#[test]
fn invalid_utf8_and_timeout_tree_cleanup_have_explicit_outcomes() {
	let root = unique_temp_dir("timeout");
	let invalid = execute(&root, &helper_allowlist("helper_invalid_utf8"), arguments())
		.expect("invalid UTF-8 is captured");
	assert!(invalid.stdout.invalid_utf8);
	assert!(invalid.stdout.provider_text.contains('\u{fffd}'));

	let marker = root.join("descendant-pid");
	let start = Instant::now();
	let timeout = execute(
		&root,
		&helper_allowlist("helper_timeout_with_descendant"),
		json!({"executable":"helper", "timeout_ms":100, "env":{"CI":marker.display().to_string()}}),
	)
	.expect("timeout terminates the process group");
	assert_eq!(timeout.status, ProcessStatus::TimedOut);
	assert!(timeout.timed_out);
	assert!(start.elapsed() < Duration::from_secs(3));
	let pid: i32 = fs::read_to_string(marker)
		.expect("descendant marker")
		.trim()
		.parse()
		.expect("pid");
	assert_pid_gone(pid, "descendant must not survive timeout");
}

#[test]
fn child_exit_with_descendant_pipe_is_not_an_ordinary_success() {
	let root = unique_temp_dir("held-pipe");
	let marker = root.join("descendant-pid");
	let started = Instant::now();
	let result = execute(
		&root,
		&helper_allowlist("helper_exit_with_descendant_pipe"),
		json!({"executable":"helper", "env":{"CI":marker.display().to_string()}}),
	);
	assert_eq!(result, Err(ProcessRejection::CaptureFailed));
	let pid = fs::read_to_string(marker)
		.expect("descendant marker")
		.trim()
		.parse()
		.expect("pid");
	assert_pid_gone(pid, "pipe-holder descendant must not survive cleanup");
	assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn child_exit_with_closed_stream_descendant_is_not_an_ordinary_success() {
	let root = unique_temp_dir("closed-stream-descendant");
	let marker = root.join("descendant-pid");
	let result = execute(
		&root,
		&helper_allowlist("helper_exit_with_descendant_closed_streams"),
		json!({"executable":"helper", "env":{"CI":marker.display().to_string()}}),
	);
	assert_eq!(result, Err(ProcessRejection::CaptureFailed));
	let pid = fs::read_to_string(marker)
		.expect("descendant marker")
		.trim()
		.parse()
		.expect("pid");
	assert_pid_gone(pid, "closed-stream descendant must not survive residual cleanup");
}

#[test]
fn bash_is_catalog_executable_and_registry_dispatchable() {
	assert_eq!(catalog::tool_status("bash"), Some(ToolStatusV0::Executable));
	assert!(slice0_registry().is_dispatchable("bash"));
}

#[cfg(unix)]
fn assert_pid_gone(pid: i32, message: &str) {
	let deadline = Instant::now() + Duration::from_secs(2);
	while Instant::now() < deadline {
		// SAFETY: probing this test-owned pid with signal 0 does not deliver a signal.
		if unsafe { libc::kill(pid, 0) } == -1 {
			return;
		}
		std::thread::sleep(Duration::from_millis(10));
	}
	// SAFETY: failure cleanup only targets the marker PID created by this test.
	unsafe { libc::kill(pid, libc::SIGKILL) };
	panic!("{message}");
}

#[cfg(not(unix))]
fn assert_pid_gone(_: i32, _: &str) {}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_streams() {
	assert_eq!(std::env::var("CI").as_deref(), Ok("hermetic"));
	assert!(std::env::var("PATH").is_err(), "env_clear must remove inherited PATH");
	println!("stdout-hermetic");
	eprintln!("stderr-hermetic");
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a proxy-path allowlist"]
fn helper_proxy_argv_zero() {
	let argv_zero = PathBuf::from(std::env::args_os().next().expect("helper argv zero"));
	assert_eq!(argv_zero.file_name().and_then(|name| name.to_str()), Some("cargo-proxy"));
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_nonzero() {
	panic!("intentional nonzero helper exit");
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_fixed_env() {
	let value = std::env::var("PATH").expect("fixed env variable visible to child");
	println!("fixed-visible:{value}");
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_argv_echo() {
	let received: Vec<String> = std::env::args().collect();
	println!("argv-echo::{}", received.join("\u{1}"));
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_noop() {}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_flood() {
	let mut output = std::io::stdout().lock();
	output
		.write_all(&vec![b'x'; 1_200_000])
		.expect("write flood");
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_invalid_utf8() {
	let mut output = std::io::stdout().lock();
	output
		.write_all(&[b'a', 0xe2, 0x82, 0xac, 0xff, b'z'])
		.expect("write invalid bytes");
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_timeout_with_descendant() {
	ignore_term();
	spawn_descendant();
	loop {
		std::thread::sleep(Duration::from_secs(1));
	}
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_exit_with_descendant_pipe() {
	spawn_descendant();
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_exit_with_descendant_closed_streams() {
	spawn_descendant_closed_streams();
}

#[test]
#[ignore = "hermetic local-process helper; selected only through a fixed allowlist prefix"]
fn helper_descendant() {
	ignore_term();
	fs::write(
		std::env::var("CI").expect("marker path supplied via allowed CI"),
		std::process::id().to_string(),
	)
	.expect("write marker");
	loop {
		std::thread::sleep(Duration::from_secs(1));
	}
}

#[allow(
	clippy::zombie_processes,
	reason = "the helper intentionally leaves a descendant for executor cleanup coverage"
)]
fn spawn_descendant() {
	let executable = std::env::current_exe().expect("current executable");
	let marker = PathBuf::from(std::env::var("CI").expect("marker path supplied via allowed CI"));
	let child = Command::new(executable)
		.args(["--ignored", "--exact", "helper_descendant", "--nocapture"])
		.env("CI", &marker)
		.spawn()
		.expect("spawn descendant");
	let _ = child.id();
	let deadline = Instant::now() + Duration::from_secs(1);
	while !marker.exists() && Instant::now() < deadline {
		std::thread::sleep(Duration::from_millis(5));
	}
	assert!(marker.exists(), "descendant must publish its marker before helper returns");
}

#[allow(
	clippy::zombie_processes,
	reason = "the helper intentionally leaves a closed-stream descendant for executor cleanup \
	          coverage"
)]
fn spawn_descendant_closed_streams() {
	let executable = std::env::current_exe().expect("current executable");
	let marker = PathBuf::from(std::env::var("CI").expect("marker path supplied via allowed CI"));
	let child = Command::new(executable)
		.args(["--ignored", "--exact", "helper_descendant", "--nocapture"])
		.env("CI", &marker)
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.spawn()
		.expect("spawn closed-stream descendant");
	let _ = child.id();
	let deadline = Instant::now() + Duration::from_secs(1);
	while !marker.exists() && Instant::now() < deadline {
		std::thread::sleep(Duration::from_millis(5));
	}
	assert!(marker.exists(), "descendant must publish its marker before helper returns");
}

#[cfg(unix)]
fn ignore_term() {
	// SAFETY: test-only helper installs SIG_IGN for its own process.
	unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
}

#[cfg(not(unix))]
fn ignore_term() {}

#[test]
fn provider_argv_shell_metacharacters_remain_literal_data() {
	let root = unique_temp_dir("argv-shell-metacharacters");
	let marker = root.join("shell-metacharacter-injection-marker");
	let payload = format!(
		"$(touch {marker}) `touch {marker}` ; touch {marker} && touch {marker} | tee {marker} > \
		 {marker}",
		marker = marker.display()
	);
	let allowlist = helper_allowlist("helper_argv_echo");

	let receipt =
		execute(&root, &allowlist, json!({"executable": "helper", "argv": [payload.clone()]}))
			.expect("literal argv payload is accepted and the helper runs to completion");

	assert_eq!(receipt.status, ProcessStatus::Exited);
	assert_eq!(receipt.exit_code, Some(0));
	assert!(
		receipt.stdout.provider_text.contains(&payload),
		"the child must receive the shell metacharacters as one untouched literal argument"
	);
	assert!(
		!marker.exists(),
		"shell metacharacters embedded in a single argv entry must never be interpreted as an extra \
		 command or shell expansion"
	);
}
