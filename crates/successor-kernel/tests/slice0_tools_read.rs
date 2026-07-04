//! Integration coverage for Lane C5 `KernelToolCatalogAndRead`.
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
	read::{ReadRejection, read},
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
fn catalog_has_34_tools_with_expected_ids_and_statuses() {
	let catalog = slice0_catalog();
	assert_eq!(catalog.tools.len(), 34);

	let mut names: Vec<&str> = catalog
		.tools
		.iter()
		.map(|tool| tool.name.as_str())
		.collect();
	names.sort_unstable();
	names.dedup();
	assert_eq!(catalog.tools.len(), names.len(), "tool names must be unique");

	for expected in ["search_files", "read", "find", "grep"] {
		assert_eq!(
			tool_status(expected),
			Some(ToolStatusV0::Executable),
			"{expected} must be catalog-executable"
		);
	}
	for expected in ["bash", "edit", "write", "task", "submit_result"] {
		assert_eq!(
			tool_status(expected),
			Some(ToolStatusV0::StubRejected),
			"{expected} must be catalog stub_rejected"
		);
	}
}

// ---------------------------------------------------------------------
// Catalog: unsupported tool invocation (bash) rejected per fixture semantics
// ---------------------------------------------------------------------

#[test]
fn bash_rejection_matches_the_unsupported_tool_fixture() {
	let events = fixtures::raw_events_unsupported_tool();
	let rejected = events
		.iter()
		.find(|event| event.event_type.as_str() == "tool_call.rejected")
		.expect("unsupported-tool fixture must contain tool_call.rejected");
	let error = events
		.iter()
		.find(|event| event.event_type.as_str() == "error.recorded")
		.expect("unsupported-tool fixture must contain error.recorded");

	assert_eq!(rejected.payload["tool_name"].as_str(), Some("bash"));
	assert_eq!(rejected.payload["policy"].as_str(), Some(REJECTION_POLICY));
	assert_eq!(rejected.payload["reason"].as_str(), Some(stub_rejection_reason("bash").as_str()));
	assert_eq!(error.payload["code"].as_str(), Some(REJECTION_ERROR_CODE));
	assert_eq!(tool_status("bash"), Some(ToolStatusV0::StubRejected));
}

// ---------------------------------------------------------------------
// Read: happy path artifact hash/byte_length via validate_artifact_content
// ---------------------------------------------------------------------

#[test]
fn read_of_a_fixture_known_file_yields_a_valid_artifact() {
	let root = unique_temp_dir("happy");
	let content = b"successor kernel slice 0 read tool fixture content\n";
	std::fs::write(root.join("notes.txt"), content).unwrap();

	let artifact = read(&root, "notes.txt").expect("read of an in-root file must succeed");

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
	assert_eq!(read(&root, "/etc/passwd"), Err(ReadRejection::AbsolutePath));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_rejects_parent_traversal() {
	let root = unique_temp_dir("dotdot");
	assert_eq!(read(&root, "../../etc/passwd"), Err(ReadRejection::ParentTraversal));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_rejects_nonexistent_file() {
	let root = unique_temp_dir("missing");
	assert_eq!(read(&root, "does/not/exist.txt"), Err(ReadRejection::NotFound));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn read_rejects_nul_containing_file_as_binary_looking() {
	let root = unique_temp_dir("binary");
	std::fs::write(root.join("blob.bin"), [b'a', b'b', 0u8, b'c']).unwrap();
	assert_eq!(read(&root, "blob.bin"), Err(ReadRejection::BinaryLooking));
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

	assert_eq!(read(&workspace, "escape/secret.txt"), Err(ReadRejection::OutOfRoot));
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

	let outcome = read(&root, "locked.txt");
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
	assert_eq!(read(&root, "subdir"), Err(ReadRejection::NotAFile));
	std::fs::remove_dir_all(&root).ok();
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

	let plain = read(&root, "hello.txt").expect("plain root read must succeed");
	let slashed =
		read(Path::new(&with_slash), "hello.txt").expect("trailing-slash root read must succeed");
	assert_eq!(plain, slashed);

	std::fs::remove_dir_all(&root).ok();
}
