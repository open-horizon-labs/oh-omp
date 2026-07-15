use std::{
	fs,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use serde_json::json;
use successor_kernel::tools::{
	catalog,
	edit::{self, EditArgs},
	mutation::{MAX_CONTENT_BYTES, MutationRejection},
	registry,
	write::{self, WriteArgs},
};
use successor_protocol::{artifact::ArtifactHash, tool_catalog::ToolStatusV0};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_temp_dir(label: &str) -> PathBuf {
	let root = std::env::temp_dir().join(format!(
		"successor-kernel-mutation-{label}-{}-{}",
		std::process::id(),
		COUNTER.fetch_add(1, Ordering::Relaxed)
	));
	fs::create_dir_all(&root).expect("must create isolated workspace");
	root
}

fn hash(bytes: &[u8]) -> String {
	ArtifactHash::compute(bytes).to_string()
}

fn edit_args(path: &str, expected: &[u8], edits: serde_json::Value) -> serde_json::Value {
	json!({"path": path, "expected_sha256": hash(expected), "edits": edits})
}

fn edit_range(
	start_line: u32,
	start_column: u32,
	end_line: u32,
	end_column: u32,
	replacement: &str,
) -> serde_json::Value {
	json!({
		"start": {"line": start_line, "column": start_column},
		"end": {"line": end_line, "column": end_column},
		"replacement": replacement,
	})
}

fn assert_no_temps(root: &Path) {
	let entries = fs::read_dir(root).expect("must read workspace");
	assert!(entries.filter_map(Result::ok).all(|entry| {
		!entry
			.file_name()
			.to_string_lossy()
			.starts_with(".successor-mutation-")
	}));
}

#[test]
fn schemas_deny_unknown_fields_and_expose_required_contract_properties() {
	let edit_schema = serde_json::to_value(EditArgs::schema()).unwrap();
	let write_schema = serde_json::to_value(WriteArgs::schema()).unwrap();
	assert!(edit_schema.to_string().contains("expected_sha256"));
	assert!(write_schema.to_string().contains("expected_sha256"));

	let root = unique_temp_dir("schema");
	fs::write(root.join("file.txt"), "old").unwrap();
	let result = edit::execute(
		&root,
		&json!({
			"path": "file.txt",
			"expected_sha256": hash(b"old"),
			"edits": [edit_range(1, 0, 1, 3, "new")],
			"unexpected": true,
		}),
	);
	assert_eq!(result.unwrap_err(), MutationRejection::MalformedArguments);
	assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"old");
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn edit_applies_original_byte_coordinates_preserving_crlf_and_hashes() {
	let root = unique_temp_dir("edit-success");
	let before = "éA\r\nB\r\n".as_bytes();
	fs::write(root.join("file.txt"), before).unwrap();
	let receipt = edit::execute(
		&root,
		&edit_args(
			"file.txt",
			before,
			json!([edit_range(1, 2, 1, 3, "LONG"), edit_range(2, 0, 2, 1, "Y"),]),
		),
	)
	.unwrap();
	let after = "éLONG\r\nY\r\n".as_bytes();
	assert_eq!(fs::read(root.join("file.txt")).unwrap(), after);
	assert_eq!(receipt.before_sha256.as_ref().unwrap().to_string(), hash(before));
	assert_eq!(receipt.after_sha256.to_string(), hash(after));
	assert_eq!(receipt.before_byte_length, Some(before.len() as u64));
	assert_eq!(receipt.after_byte_length, after.len() as u64);
	assert_eq!(receipt.edits_applied, Some(2));
	assert_eq!(serde_json::to_value(&receipt).unwrap()["line_endings"], "crlf");
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn edit_allows_boundary_insertions_in_deterministic_original_coordinate_order() {
	let root = unique_temp_dir("edit-boundaries");
	let before = b"abcdef";
	let file = root.join("file.txt");
	fs::write(&file, before).unwrap();

	let receipt = edit::execute(
		&root,
		&edit_args(
			"file.txt",
			before,
			json!([
				edit_range(1, 4, 1, 4, "E"),
				edit_range(1, 2, 1, 4, "R"),
				edit_range(1, 2, 1, 2, "S"),
			]),
		),
	)
	.unwrap();
	assert_eq!(fs::read(&file).unwrap(), b"abSREef");
	assert_eq!(receipt.edits_applied, Some(3));

	for edits in [
		json!([edit_range(1, 2, 1, 4, "R"), edit_range(1, 3, 1, 3, "I")]),
		json!([edit_range(1, 2, 1, 2, "S"), edit_range(1, 2, 1, 2, "D")]),
	] {
		fs::write(&file, before).unwrap();
		assert_eq!(
			edit::execute(&root, &edit_args("file.txt", before, edits)).unwrap_err(),
			MutationRejection::OverlappingEdits
		);
		assert_eq!(fs::read(&file).unwrap(), before);
	}
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_edit_and_replace_leave_existing_bytes_unchanged() {
	let root = unique_temp_dir("stale");
	fs::write(root.join("file.txt"), "current").unwrap();
	let stale_edit =
		edit::execute(&root, &edit_args("file.txt", b"old", json!([edit_range(1, 0, 1, 7, "new")])));
	assert_eq!(stale_edit.unwrap_err(), MutationRejection::StaleHash);
	let stale_write = write::execute(
		&root,
		&json!({
			"path": "file.txt",
			"mode": "replace",
			"content": "new",
			"expected_sha256": hash(b"old"),
		}),
	);
	assert_eq!(stale_write.unwrap_err(), MutationRejection::StaleHash);
	assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"current");
	assert_no_temps(&root);
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn overlap_duplicate_insertion_and_utf8_boundary_fail_without_mutation() {
	let root = unique_temp_dir("edit-invalid");
	let before = "éabc\n".as_bytes();
	fs::write(root.join("file.txt"), before).unwrap();
	for edits in [
		json!([edit_range(1, 0, 1, 2, "X"), edit_range(1, 1, 1, 3, "Y")]),
		json!([edit_range(1, 2, 1, 2, "X"), edit_range(1, 2, 1, 2, "Y")]),
		json!([edit_range(1, 1, 1, 1, "X")]),
	] {
		assert!(edit::execute(&root, &edit_args("file.txt", before, edits)).is_err());
		assert_eq!(fs::read(root.join("file.txt")).unwrap(), before);
	}
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn edit_handles_empty_file_insertion_and_rejects_binary_nul_noop_and_bounds() {
	let root = unique_temp_dir("edit-bounds");
	fs::write(root.join("empty.txt"), b"").unwrap();
	let receipt = edit::execute(
		&root,
		&edit_args("empty.txt", b"", json!([edit_range(1, 0, 1, 0, "first\n")])),
	)
	.unwrap();
	assert_eq!(fs::read(root.join("empty.txt")).unwrap(), b"first\n");
	assert_eq!(receipt.after_sha256.to_string(), hash(b"first\n"));

	fs::write(root.join("binary.txt"), b"a\0b").unwrap();
	assert_eq!(
		edit::execute(
			&root,
			&edit_args("binary.txt", b"a\0b", json!([edit_range(1, 0, 1, 1, "x")])),
		)
		.unwrap_err(),
		MutationRejection::BinarySource
	);
	assert_eq!(
		edit::execute(&root, &edit_args("same.txt", b"same", json!([edit_range(1, 0, 1, 0, "\0")])),)
			.unwrap_err(),
		MutationRejection::NulContent
	);
	fs::write(root.join("same.txt"), "same").unwrap();
	assert_eq!(
		edit::execute(
			&root,
			&edit_args("same.txt", b"same", json!([edit_range(1, 0, 1, 4, "same")])),
		)
		.unwrap_err(),
		MutationRejection::AllNoOp
	);
	fs::write(root.join("bound.txt"), "unchanged").unwrap();
	let too_large = "x".repeat(MAX_CONTENT_BYTES + 1);
	assert_eq!(
		write::execute(
			&root,
			&json!({
				"path": "bound.txt",
				"mode": "replace",
				"content": too_large,
				"expected_sha256": hash(b"unchanged"),
			}),
		)
		.unwrap_err(),
		MutationRejection::ContentTooLarge
	);
	assert_eq!(fs::read(root.join("bound.txt")).unwrap(), b"unchanged");
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn write_create_is_no_clobber_and_does_not_create_parents() {
	let root = unique_temp_dir("create");
	let receipt =
		write::execute(&root, &json!({"path": "new.txt", "mode": "create", "content": "created"}))
			.unwrap();
	assert_eq!(fs::read(root.join("new.txt")).unwrap(), b"created");
	assert!(receipt.before_sha256.is_none());
	assert_eq!(receipt.mode.as_deref(), Some("create"));
	assert_eq!(
		write::execute(&root, &json!({"path": "new.txt", "mode": "create", "content": "clobber"}),)
			.unwrap_err(),
		MutationRejection::AlreadyExists
	);
	assert_eq!(fs::read(root.join("new.txt")).unwrap(), b"created");
	assert!(
		write::execute(
			&root,
			&json!({"path": "missing/new.txt", "mode": "create", "content": "nope"}),
		)
		.is_err()
	);
	assert!(!root.join("missing").exists());
	assert_eq!(
		write::execute(
			&root,
			&json!({
				"path": "other.txt",
				"mode": "create",
				"content": "nope",
				"expected_sha256": hash(b"anything"),
			}),
		)
		.unwrap_err(),
		MutationRejection::CreateWithExpectedHash
	);
	assert_eq!(
		write::execute(&root, &json!({"path": "/absolute", "mode": "create", "content": "nope"}))
			.unwrap_err(),
		MutationRejection::AbsolutePath
	);
	assert_eq!(
		write::execute(&root, &json!({"path": "../escape", "mode": "create", "content": "nope"}))
			.unwrap_err(),
		MutationRejection::ParentTraversal
	);
	assert_eq!(
		write::execute(&root, &json!({"path": ".", "mode": "create", "content": "nope"}))
			.unwrap_err(),
		MutationRejection::NotRegularFile
	);
	assert_no_temps(&root);
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn write_replace_requires_hash_and_preserves_existing_permissions() {
	let root = unique_temp_dir("replace");
	let file = root.join("file.txt");
	fs::write(&file, "old").unwrap();
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
	}
	assert_eq!(
		write::execute(&root, &json!({"path": "file.txt", "mode": "replace", "content": "new"}),)
			.unwrap_err(),
		MutationRejection::ReplaceWithoutExpectedHash
	);
	let receipt = write::execute(
		&root,
		&json!({
			"path": "file.txt",
			"mode": "replace",
			"content": "new",
			"expected_sha256": hash(b"old"),
		}),
	)
	.unwrap();
	assert_eq!(fs::read(&file).unwrap(), b"new");
	assert_eq!(receipt.before_sha256.unwrap().to_string(), hash(b"old"));
	assert_eq!(receipt.after_sha256.to_string(), hash(b"new"));
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
	}
	assert_no_temps(&root);
	fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn mutation_rejects_final_symlink_and_parent_symlink_escape() {
	use std::os::unix::fs::symlink;

	let root = unique_temp_dir("symlink");
	let outside = unique_temp_dir("outside");
	fs::write(outside.join("outside.txt"), "outside").unwrap();
	symlink(outside.join("outside.txt"), root.join("link.txt")).unwrap();
	symlink(&outside, root.join("escape")).unwrap();
	assert_eq!(
		write::execute(
			&root,
			&json!({
				"path": "link.txt",
				"mode": "replace",
				"content": "new",
				"expected_sha256": hash(b"outside"),
			}),
		)
		.unwrap_err(),
		MutationRejection::NotRegularFile
	);
	assert_eq!(
		write::execute(&root, &json!({"path": "link.txt", "mode": "create", "content": "new"}),)
			.unwrap_err(),
		MutationRejection::NotRegularFile
	);
	assert_eq!(
		write::execute(
			&root,
			&json!({"path": "escape/new.txt", "mode": "create", "content": "new"}),
		)
		.unwrap_err(),
		MutationRejection::OutOfRoot
	);
	assert_eq!(fs::read(outside.join("outside.txt")).unwrap(), b"outside");
	fs::remove_dir_all(root).unwrap();
	fs::remove_dir_all(outside).unwrap();
}

#[test]
fn receipt_is_bounded_content_free_and_artifact_is_stable() {
	let root = unique_temp_dir("receipt");
	let secret = "secret-should-not-appear-in-receipt";
	let receipt = write::execute(
		&root,
		&json!({"path": "receipt.txt", "mode": "create", "content": format!("{secret}\r\nnext\n")}),
	)
	.unwrap();
	let json = serde_json::to_string(&receipt).unwrap();
	assert!(!json.contains(secret));
	assert!(receipt.diff_preview.len() <= 4_096);
	assert_eq!(serde_json::to_value(&receipt).unwrap()["line_endings"], "mixed");
	assert_eq!(serde_json::to_value(&receipt).unwrap()["mixed_line_endings"], true);
	let first = receipt.artifact();
	let second = receipt.artifact();
	assert_eq!(first.bytes, second.bytes);
	assert_eq!(first.sha256, second.sha256);
	assert_eq!(first.byte_length, first.bytes.len() as u64);
	assert_eq!(first.sha256, ArtifactHash::compute(&first.bytes));
	fs::remove_dir_all(root).unwrap();
}

#[test]
fn catalog_and_registry_now_pin_edit_and_write_as_executable() {
	let registry = registry::slice0_registry();
	for name in ["edit", "write"] {
		assert!(registry.is_dispatchable(name));
		assert_eq!(catalog::tool_status(name), Some(ToolStatusV0::Executable));
	}
}
