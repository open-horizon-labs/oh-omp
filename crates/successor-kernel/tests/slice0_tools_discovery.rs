//! Integration coverage for the `list_dir` tool, added per the
//! `agent://269` Lane 3 dissent ruling.
//!
//! Exercises the crate's public surface only:
//! `successor_kernel::tools::list_dir` and `successor_kernel::tools::catalog`.
//! The root-bounding substrate (`WorkspaceRoot`, `PathBoundError`) is
//! `pub(crate)` by design and is intentionally not reachable from here.

use std::path::PathBuf;

use successor_kernel::tools::{
	catalog::{slice0_catalog, tool_status},
	list_dir::{
		DEFAULT_MAX_LIST_ENTRIES, ListDirEntry, ListDirEntryKind, ListDirRejection, list_dir,
	},
};
use successor_protocol::{fixtures, tool_catalog::ToolStatusV0};

fn unique_temp_dir(label: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"successor-kernel-slice0-tools-discovery-{label}-{}-{}",
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
// Catalog: list_dir is registered as executable in the sovereign fixture
// ---------------------------------------------------------------------

#[test]
fn list_dir_is_catalog_executable_and_the_kernel_catalog_matches_the_fixture() {
	let kernel_catalog = slice0_catalog();
	let fixture_catalog = fixtures::tool_catalog();
	assert_eq!(
		kernel_catalog, fixture_catalog,
		"kernel catalog must equal the sovereign fixture byte-for-byte in typed form"
	);
	assert_eq!(tool_status("list_dir"), Some(ToolStatusV0::Executable));
}

// ---------------------------------------------------------------------
// list_dir: bounded listing, sorted output
// ---------------------------------------------------------------------

#[test]
fn list_dir_returns_sorted_direct_children_only() {
	let root = unique_temp_dir("sorted");
	std::fs::write(root.join("zeta.txt"), b"z").unwrap();
	std::fs::write(root.join("alpha.txt"), b"a").unwrap();
	std::fs::create_dir(root.join("mid_dir")).unwrap();
	// A grandchild must never appear: list_dir lists direct children only.
	std::fs::write(root.join("mid_dir").join("grandchild.txt"), b"g").unwrap();

	let artifact = list_dir(&root, "").expect("list of the workspace root must succeed");
	assert_eq!(artifact.entries, vec![
		ListDirEntry { name: "alpha.txt".to_owned(), kind: ListDirEntryKind::File },
		ListDirEntry { name: "mid_dir".to_owned(), kind: ListDirEntryKind::Directory },
		ListDirEntry { name: "zeta.txt".to_owned(), kind: ListDirEntryKind::File },
	]);
	assert!(!artifact.truncated);

	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn list_dir_truncates_beyond_the_bound_with_a_deterministic_marker() {
	let root = unique_temp_dir("truncated");
	for index in 0..(DEFAULT_MAX_LIST_ENTRIES + 3) {
		std::fs::write(root.join(format!("f{index:06}.txt")), b"x").unwrap();
	}

	let artifact = list_dir(&root, "").expect("list of an over-bound dir must still succeed");
	assert_eq!(artifact.entries.len(), DEFAULT_MAX_LIST_ENTRIES);
	assert!(artifact.truncated, "an over-bound listing must set truncated: true");

	// Deterministic: truncation keeps the first DEFAULT_MAX_LIST_ENTRIES
	// entries in sorted order, not an arbitrary OS-ordered subset.
	assert_eq!(artifact.entries.first().unwrap().name, "f000000.txt");

	std::fs::remove_dir_all(&root).ok();
}

// ---------------------------------------------------------------------
// list_dir: root-bounding, same substrate/error class as read/find/grep
// ---------------------------------------------------------------------

#[test]
fn list_dir_rejects_absolute_path() {
	let root = unique_temp_dir("abs");
	assert_eq!(list_dir(&root, "/etc"), Err(ListDirRejection::AbsolutePath));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn list_dir_rejects_parent_traversal() {
	let root = unique_temp_dir("dotdot");
	assert_eq!(list_dir(&root, "../outside"), Err(ListDirRejection::ParentTraversal));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn list_dir_rejects_nonexistent_directory_as_not_found() {
	let root = unique_temp_dir("missing");
	assert_eq!(list_dir(&root, "does/not/exist"), Err(ListDirRejection::NotFound));
	std::fs::remove_dir_all(&root).ok();
}

#[test]
fn list_dir_rejects_a_file_as_not_a_directory() {
	let root = unique_temp_dir("file");
	std::fs::write(root.join("leaf.txt"), b"leaf").unwrap();
	assert_eq!(list_dir(&root, "leaf.txt"), Err(ListDirRejection::NotADirectory));
	std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn list_dir_rejects_symlink_escape_outside_root() {
	use std::os::unix::fs::symlink;

	// Shares the same root-bounding substrate as `read` (component-wise
	// containment via canonicalization, never a string-prefix check), so
	// this mirrors read.rs's own string-prefix-trap coverage: a symlinked
	// directory that resolves outside the workspace root is rejected, not
	// silently listed.
	let base = unique_temp_dir("escape-base");
	let workspace = base.join("workspace");
	let outside = base.join("workspace_evil");
	std::fs::create_dir_all(&workspace).unwrap();
	std::fs::create_dir_all(&outside).unwrap();
	std::fs::write(outside.join("secret.txt"), b"top secret").unwrap();
	symlink(&outside, workspace.join("escape")).expect("symlink creation must succeed");

	assert_eq!(list_dir(&workspace, "escape"), Err(ListDirRejection::OutOfRoot));
	std::fs::remove_dir_all(&base).ok();
}

// ---------------------------------------------------------------------
// list_dir: symlink children are reported, never traversed/resolved
// ---------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn list_dir_reports_a_symlink_child_as_a_symlink_without_following_it() {
	use std::os::unix::fs::symlink;

	let root = unique_temp_dir("symlink-child");
	let target = unique_temp_dir("symlink-child-target");
	std::fs::write(target.join("hidden.txt"), b"hidden").unwrap();
	symlink(&target, root.join("link_to_target")).expect("symlink creation must succeed");

	let artifact = list_dir(&root, "").expect("list of a dir containing a symlink must succeed");
	assert_eq!(artifact.entries, vec![ListDirEntry {
		name: "link_to_target".to_owned(),
		kind: ListDirEntryKind::Symlink,
	}]);

	std::fs::remove_dir_all(&root).ok();
	std::fs::remove_dir_all(&target).ok();
}

// ---------------------------------------------------------------------
// list_dir: artifact hash/byte_length describe the exact returned payload
// ---------------------------------------------------------------------

#[test]
fn list_dir_artifact_hash_and_byte_length_describe_the_exact_returned_bytes() {
	use successor_protocol::artifact::{ArtifactHash, validate_artifact_content};

	let root = unique_temp_dir("hash");
	std::fs::write(root.join("one.txt"), b"1").unwrap();

	let artifact = list_dir(&root, "").expect("list must succeed");
	assert_eq!(artifact.byte_length, artifact.bytes.len() as u64);
	assert_eq!(artifact.sha256, ArtifactHash::compute(&artifact.bytes));
	validate_artifact_content(artifact.sha256.as_str(), artifact.byte_length, &artifact.bytes)
		.expect("artifact fields must validate via the accepted protocol helper");

	std::fs::remove_dir_all(&root).ok();
}

// ---------------------------------------------------------------------
// ListDirArgs: malformed argument rejection (unknown field, non-string path)
// ---------------------------------------------------------------------

#[test]
fn list_dir_args_rejects_unknown_fields_as_malformed() {
	use successor_kernel::tools::list_dir::ListDirArgs;

	let ok: ListDirArgs = serde_json::from_value(serde_json::json!({ "path": "src" }))
		.expect("well-formed list_dir arguments must deserialize");
	assert_eq!(ok.path, "src");

	let defaults: ListDirArgs = serde_json::from_value(serde_json::json!({}))
		.expect("missing list_dir arguments must fall back to the root path, not error");
	assert_eq!(defaults.path, "");

	let rejected: Result<ListDirArgs, _> =
		serde_json::from_value(serde_json::json!({ "path": "src", "recursive": true }));
	assert!(
		rejected.is_err(),
		"an unknown field on list_dir arguments must be rejected, not silently ignored"
	);
}
