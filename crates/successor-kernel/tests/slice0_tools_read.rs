//! Integration coverage for Lane C5 `KernelToolCatalogAndRead`, extended by
//! the <agent://269> Lane 3 dissent ruling with ranged-read coverage.
//!
//! Exercises the crate's public surface only:
//! `successor_kernel::tools::catalog` and `successor_kernel::tools::read`. The
//! root-bounding substrate (`WorkspaceRoot`, `PathBoundError`) is `pub(crate)`
//! by design (Dissent ruling 1) and is intentionally not reachable from here.

use std::path::{Path, PathBuf};

use successor_kernel::tools::{
	catalog::{
		REJECTION_ERROR_CODE, REJECTION_POLICY, slice0_catalog, stub_rejection_reason, tool_status,
	},
	read::{ReadArgs, ReadRejection, read},
};
use successor_protocol::{
	artifact::{ArtifactHash, validate_artifact_content},
	fixtures,
	tool_catalog::ToolStatusV0,
};

fn unique_temp_dir(label: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"successor-kernel-slice0-tools-read-{label}-{}-{}",
		std::process::id(),
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("system clock must be after the epoch")
			.as_nanos()
	));
	std::fs::create_dir_all(&dir).expect("must create unique temp dir");
	dir
}

// ---------------------------------------------------------------------
// Catalog: fixture fidelity (typed round-trip, count/ids/statuses)
// ---------------------------------------------------------------------

#[test]
fn catalog_round_trips_the_canonical_fixture_exactly() {
	let kernel_catalog = slice0_catalog();
	let fixture_catalog = fixtures::tool_catalog();
	assert_eq!(
		kernel_catalog, fixture_catalog,
		"kernel catalog must equal the sovereign fixture byte-for-byte in typed form"
	);
}

#[test]
fn catalog_has_35_tools_with_expected_ids_and_statuses() {
	let catalog = slice0_catalog();
	assert_eq!(catalog.tools.len(), 35);

	let mut names: Vec<&str> = catalog
		.tools
		.iter()
		.map(|tool| tool.name.as_str())
		.collect();
	names.sort_unstable();
	names.dedup();
	assert_eq!(catalog.tools.len(), names.len(), "tool names must be unique");

	for expected in
		["search_files", "read", "find", "grep", "list_dir", "ast_grep", "edit", "write", "bash"]
	{
		assert_eq!(
			tool_status(expected),
			Some(ToolStatusV0::Executable),
			"{expected} must be catalog-executable"
		);
	}
	for expected in ["ssh", "ast_edit", "lsp", "task", "submit_result"] {
		assert_eq!(
			tool_status(expected),
			Some(ToolStatusV0::StubRejected),
			"{expected} must be catalog stub_rejected"
		);
	}
}

// ---------------------------------------------------------------------
// Catalog: unsupported tool invocation (ssh) rejected per fixture semantics
// ---------------------------------------------------------------------

#[test]
fn ssh_rejection_matches_the_unsupported_tool_fixture() {
	let events = fixtures::raw_events_unsupported_tool();
	let rejected = events
		.iter()
		.find(|event| event.event_type.as_str() == "tool_call.rejected")
		.expect("unsupported-tool fixture must contain tool_call.rejected");
	let error = events
		.iter()
		.find(|event| event.event_type.as_str() == "error.recorded")
		.expect("unsupported-tool fixture must contain error.recorded");

	assert_eq!(rejected.payload["tool_name"].as_str(), Some("ssh"));
	assert_eq!(rejected.payload["policy"].as_str(), Some(REJECTION_POLICY));
	assert_eq!(rejected.payload["reason"].as_str(), Some(stub_rejection_reason("ssh").as_str()));
	assert_eq!(error.payload["code"].as_str(), Some(REJECTION_ERROR_CODE));
	assert_eq!(tool_status("ssh"), Some(ToolStatusV0::StubRejected));
}

// ---------------------------------------------------------------------
// Read: happy path artifact hash/byte_length via validate_artifact_content
// ---------------------------------------------------------------------

#[test]
fn read_of_a_fixture_known_file_yields_a_valid_artifact() {
	let root = unique_temp_dir("happy");
	let content = b"successor kernel slice 0 read tool fixture content\n";
	std::fs::write(root.join("notes.txt"), content).unwrap();

	let artifact =
		read(&root, "notes.txt", None, None).expect("read of an in-root file must succeed");

	assert_eq!(artifact.bytes, content);
	assert_eq!(artifact.byte_length, content.len() as u64);
	assert_eq!(artifact.sha256, ArtifactHash::compute(content));
	validate_artifact_content(artifact.sha256.as_str(), artifact.byte_length, &artifact.bytes)
		.expect("artifact fields must validate via the accepted protocol helper");

	std::fs::remove_dir_all(&root).ok();
}

// ---------------------------------------------------------------------
// Read: each rejection is distinct and typed
// ---------------------------------------------------------------------

#[test]
fn read_rejects_absolute_path() {
	let root = unique_temp_dir("abs");
	assert_eq!(read(&root, "/etc/passwd", None, None), Err(ReadRejection::AbsolutePath));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_rejects_parent_traversal() {
	let root = unique_temp_dir("dotdot");
	assert_eq!(read(&root, "../../etc/passwd", None, None), Err(ReadRejection::ParentTraversal));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_rejects_nonexistent_file() {
	let root = unique_temp_dir("missing");
	assert_eq!(read(&root, "does/not/exist.txt", None, None), Err(ReadRejection::NotFound));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_rejects_nul_containing_file_as_binary_looking() {
	let root = unique_temp_dir("binary");
	std::fs::write(root.join("blob.bin"), [b'a', b'b', 0u8, b'c']).unwrap();
	assert_eq!(read(&root, "blob.bin", None, None), Err(ReadRejection::BinaryLooking));
	std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn read_rejects_symlink_escape_the_string_prefix_trap() {
	// `workspace_evil` shares a string prefix with `workspace` but must
	// never be treated as contained in it. A naive
	// `candidate_str.starts_with(root_str)` check would incorrectly accept
	// this path; component-wise containment must reject it.
	let base = unique_temp_dir("escape-base");
	let workspace = base.join("workspace");
	let evil = base.join("workspace_evil");
	std::fs::create_dir_all(&workspace).unwrap();
	std::fs::create_dir_all(&evil).unwrap();
	std::fs::write(evil.join("secret.txt"), b"top secret").unwrap();
	std::os::unix::fs::symlink(&evil, workspace.join("escape")).unwrap();

	assert_eq!(read(&workspace, "escape/secret.txt", None, None), Err(ReadRejection::OutOfRoot));
	std::fs::remove_dir_all(&base).ok();
}

#[cfg(unix)]
#[test]
fn read_rejects_permission_denied_file_where_portable() {
	use std::os::unix::fs::PermissionsExt;

	if std::env::var_os("SUCCESSOR_SKIP_ROOT_SENSITIVE_TESTS").is_some() {
		return;
	}

	let root = unique_temp_dir("perm");
	let file_path = root.join("locked.txt");
	std::fs::write(&file_path, b"cannot read me").unwrap();
	std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o000)).unwrap();

	let outcome = read(&root, "locked.txt", None, None);
	std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o644)).ok();
	std::fs::remove_dir_all(&root).ok();

	match outcome {
		Err(ReadRejection::PermissionDenied) => {},
		Ok(_) => eprintln!(
			"permission-denied test skipped: running with privileges that bypass file mode bits"
		),
		Err(other) => panic!("expected PermissionDenied or a privileged bypass, got {other:?}"),
	}
}

#[test]
fn read_rejects_a_directory_as_not_a_file() {
	let root = unique_temp_dir("dir");
	std::fs::create_dir_all(root.join("subdir")).unwrap();
	assert_eq!(read(&root, "subdir", None, None), Err(ReadRejection::NotAFile));
	std::fs::remove_dir_all(&root).ok();
}

// ---------------------------------------------------------------------
// Read: root-bounding precedence — lexical rejection before root I/O
// ---------------------------------------------------------------------

#[test]
fn read_precedence_absolute_path_wins_over_missing_root() {
	let base = unique_temp_dir("missing-root-abs");
	let missing_root = base.join("does-not-exist");
	assert_eq!(read(&missing_root, "/etc/passwd", None, None), Err(ReadRejection::AbsolutePath));
	std::fs::remove_dir_all(&base).ok();
}

#[test]
fn read_precedence_parent_traversal_wins_over_missing_root() {
	let base = unique_temp_dir("missing-root-dotdot");
	let missing_root = base.join("does-not-exist");
	assert_eq!(
		read(&missing_root, "../outside.txt", None, None),
		Err(ReadRejection::ParentTraversal)
	);
	std::fs::remove_dir_all(&base).ok();
}

#[cfg(unix)]
#[test]
fn read_precedence_unreadable_root_with_malformed_path_rejects_lexically_first() {
	use std::os::unix::fs::PermissionsExt;

	let base = unique_temp_dir("unreadable-root");
	let locked_parent = base.join("locked_parent");
	let root = locked_parent.join("workspace");
	std::fs::create_dir_all(&root).unwrap();
	std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o000)).unwrap();

	// Even if a privileged runner (root/CI) bypasses these permission bits
	// entirely, this assertion still holds: the lexical check on
	// `relative_path` runs before `WorkspaceRoot::new` ever attempts to
	// canonicalize `root`, so the outcome does not depend on permission
	// enforcement.
	let outcome_abs = read(&root, "/etc/passwd", None, None);
	let outcome_dotdot = read(&root, "../outside.txt", None, None);

	std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o755)).ok();
	std::fs::remove_dir_all(&base).ok();

	assert_eq!(outcome_abs, Err(ReadRejection::AbsolutePath));
	assert_eq!(outcome_dotdot, Err(ReadRejection::ParentTraversal));
}

// ---------------------------------------------------------------------
// Root with trailing separator normalizes correctly
// ---------------------------------------------------------------------

#[test]
fn root_with_trailing_separator_normalizes_correctly() {
	let root = unique_temp_dir("trailing-sep");
	std::fs::write(root.join("hello.txt"), b"hi").unwrap();

	let mut with_slash = root.as_os_str().to_owned();
	with_slash.push("/");

	let plain = read(&root, "hello.txt", None, None).expect("plain root read must succeed");
	let slashed = read(Path::new(&with_slash), "hello.txt", None, None)
		.expect("trailing-slash root read must succeed");
	assert_eq!(plain, slashed);

	std::fs::remove_dir_all(&root).ok();
}

// ---------------------------------------------------------------------
// Ranged read (agent://269 Lane 3 dissent ruling)
// ---------------------------------------------------------------------

fn make_five_line_file(root: &Path) {
	std::fs::write(root.join("lines.txt"), b"one\ntwo\nthree\nfour\nfive\n").unwrap();
}

#[test]
fn read_offset_and_limit_returns_exactly_the_requested_in_range_lines() {
	let root = unique_temp_dir("ranged-in-range");
	make_five_line_file(&root);

	let artifact =
		read(&root, "lines.txt", std::num::NonZeroU32::new(2), std::num::NonZeroU32::new(2))
			.expect("an in-range offset/limit read must succeed");
	assert_eq!(artifact.bytes, b"two\nthree\n");
	assert_eq!(artifact.byte_length, artifact.bytes.len() as u64);
	assert_eq!(artifact.sha256, ArtifactHash::compute(&artifact.bytes));

	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_offset_only_returns_from_that_line_to_the_end_of_the_file() {
	let root = unique_temp_dir("ranged-offset-only");
	make_five_line_file(&root);

	let artifact = read(&root, "lines.txt", std::num::NonZeroU32::new(4), None)
		.expect("an offset-only read must succeed");
	assert_eq!(artifact.bytes, b"four\nfive\n");

	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_limit_only_returns_the_first_n_lines_from_the_start() {
	let root = unique_temp_dir("ranged-limit-only");
	make_five_line_file(&root);

	let artifact = read(&root, "lines.txt", None, std::num::NonZeroU32::new(2))
		.expect("a limit-only read must succeed");
	assert_eq!(artifact.bytes, b"one\ntwo\n");

	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_offset_beyond_end_of_file_returns_empty_content_not_an_error() {
	let root = unique_temp_dir("ranged-out-of-range");
	make_five_line_file(&root);

	let artifact = read(&root, "lines.txt", std::num::NonZeroU32::new(50), None)
		.expect("an out-of-range offset must succeed with empty content, not error");
	assert_eq!(artifact.bytes, b"");
	assert_eq!(artifact.byte_length, 0);
	assert_eq!(artifact.sha256, ArtifactHash::compute(b""));

	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_without_offset_or_limit_still_returns_the_whole_file() {
	let root = unique_temp_dir("ranged-default");
	make_five_line_file(&root);

	let whole = read(&root, "lines.txt", None, None).expect("a whole-file read must succeed");
	assert_eq!(whole.bytes, b"one\ntwo\nthree\nfour\nfive\n");

	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_args_rejects_zero_offset_and_zero_limit_and_unknown_fields_as_malformed() {
	let rejected_offset: Result<ReadArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "offset": 0 }));
	assert!(rejected_offset.is_err(), "a zero offset must be rejected as malformed, not clamped");

	let rejected_limit: Result<ReadArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "limit": 0 }));
	assert!(rejected_limit.is_err(), "a zero limit must be rejected as malformed, not clamped");

	let rejected_max_bytes: Result<ReadArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "a.txt", "max_bytes": 200_000 }));
	assert!(
		rejected_max_bytes.is_err(),
		"a legacy max_bytes field must be rejected as malformed, not silently ignored"
	);
}
