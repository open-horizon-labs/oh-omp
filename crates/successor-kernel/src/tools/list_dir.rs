//! Root-bounded directory listing tool (`list_dir`).
//!
//! Added per the <agent://269> Lane 3 dissent ruling: read-only discovery
//! of the direct children of one relative directory under the workspace
//! root. This tool adds no write/edit/shell authority and does not
//! recurse — recursive discovery is `find`'s job (Lane C6), not this
//! module's.
//!
//! Listing is sorted, bounded, and metadata-only. Entry kind is read via
//! [`std::fs::DirEntry::file_type`], which (unlike [`std::fs::metadata`])
//! does not traverse symlinks: a symlinked child is reported as a symlink,
//! never silently resolved to its target's kind.

use std::path::Path;

use successor_protocol::artifact::ArtifactHash;

use super::{PathBoundError, WorkspaceRoot, compute_artifact_bytes};

/// Bound on the number of entries returned by a single [`list_dir`] call.
///
/// Entries beyond this bound are dropped and `truncated` is set on the
/// returned [`ListDirArtifactContent`] — the same bounded-output
/// convention `find`/`grep` already use for their own walks.
pub const DEFAULT_MAX_LIST_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ListDirRejection {
	#[error("workspace root does not exist")]
	RootNotFound,
	#[error("path must be relative to the workspace root")]
	AbsolutePath,
	#[error("path must not contain `..` components")]
	ParentTraversal,
	#[error("path does not exist")]
	NotFound,
	#[error("path resolves outside the workspace root")]
	OutOfRoot,
	#[error("permission denied")]
	PermissionDenied,
	#[error("path is not a directory")]
	NotADirectory,
	#[error("directory listing failed: {0}")]
	Io(String),
}

fn map_path_bound(err: PathBoundError) -> ListDirRejection {
	match err {
		PathBoundError::RootNotFound => ListDirRejection::RootNotFound,
		PathBoundError::AbsolutePath => ListDirRejection::AbsolutePath,
		PathBoundError::ParentTraversal => ListDirRejection::ParentTraversal,
		PathBoundError::NotFound => ListDirRejection::NotFound,
		PathBoundError::OutOfRoot => ListDirRejection::OutOfRoot,
		PathBoundError::PermissionDenied => ListDirRejection::PermissionDenied,
		PathBoundError::Io(message) => ListDirRejection::Io(message),
	}
}

fn map_list_io(err: std::io::Error) -> ListDirRejection {
	match err.kind() {
		std::io::ErrorKind::NotFound => ListDirRejection::NotFound,
		std::io::ErrorKind::PermissionDenied => ListDirRejection::PermissionDenied,
		_ => ListDirRejection::Io(err.to_string()),
	}
}

/// The kind of a [`ListDirEntry`], determined without following symlinks
/// (see module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListDirEntryKind {
	File,
	Directory,
	Symlink,
	Other,
}

/// One direct child of the listed directory.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ListDirEntry {
	pub name: String,
	pub kind: ListDirEntryKind,
}

/// Artifact-backed content produced by a successful [`list_dir`] call.
///
/// Mirrors [`super::read::ReadArtifactContent`]'s shape: typed content plus
/// raw bytes/hash/length for the turn runner to assign a persisted artifact
/// id and preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListDirArtifactContent {
	pub entries:     Vec<ListDirEntry>,
	pub truncated:   bool,
	pub bytes:       Vec<u8>,
	pub sha256:      ArtifactHash,
	pub byte_length: u64,
}

#[derive(serde::Serialize)]
struct ListDirArtifactPayload<'a> {
	entries:   &'a [ListDirEntry],
	truncated: bool,
}

/// Arguments for the `list_dir` tool.
///
/// Lists the direct children of one relative directory under the
/// workspace root. Any field not listed here is rejected as a malformed
/// argument rather than silently ignored.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListDirArgs {
	/// Directory to list, relative to the workspace root. Omit (or pass an
	/// empty string) to list the workspace root itself.
	#[serde(default)]
	pub path: String,
}

/// List the direct children of `relative_path` under the workspace rooted
/// at `root_path`.
///
/// Entries are sorted by name, bounded to [`DEFAULT_MAX_LIST_ENTRIES`], and
/// typed without following symlinks (<agent://269> Lane 3 dissent ruling).
pub fn list_dir(
	root_path: &Path,
	relative_path: &str,
) -> Result<ListDirArtifactContent, ListDirRejection> {
	let root = WorkspaceRoot::new(root_path).map_err(map_path_bound)?;
	list_dir_with_root(&root, relative_path)
}

/// List the direct children of `relative_path` against an
/// already-constructed [`WorkspaceRoot`]. See [`list_dir`] for the public
/// entry point most callers should use.
pub(crate) fn list_dir_with_root(
	root: &WorkspaceRoot,
	relative_path: &str,
) -> Result<ListDirArtifactContent, ListDirRejection> {
	let resolved = root.resolve(relative_path).map_err(map_path_bound)?;

	let metadata = std::fs::metadata(&resolved).map_err(map_list_io)?;
	if !metadata.is_dir() {
		return Err(ListDirRejection::NotADirectory);
	}

	let mut entries = Vec::new();
	for entry in std::fs::read_dir(&resolved).map_err(map_list_io)? {
		let entry = entry.map_err(map_list_io)?;
		let file_type = entry.file_type().map_err(map_list_io)?;
		let kind = if file_type.is_symlink() {
			ListDirEntryKind::Symlink
		} else if file_type.is_dir() {
			ListDirEntryKind::Directory
		} else if file_type.is_file() {
			ListDirEntryKind::File
		} else {
			ListDirEntryKind::Other
		};
		entries.push(ListDirEntry { name: entry.file_name().to_string_lossy().into_owned(), kind });
	}
	entries.sort_by(|a, b| a.name.cmp(&b.name));

	let truncated = entries.len() > DEFAULT_MAX_LIST_ENTRIES;
	entries.truncate(DEFAULT_MAX_LIST_ENTRIES);

	let payload = ListDirArtifactPayload { entries: &entries, truncated };
	let bytes = serde_json::to_vec(&payload).expect("ListDirArtifactPayload always serializes");
	let (sha256, byte_length) = compute_artifact_bytes(&bytes);

	Ok(ListDirArtifactContent { entries, truncated, bytes, sha256, byte_length })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn unique_temp_dir(label: &str) -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"successor-kernel-tools-list-dir-{label}-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.expect("system clock must be after the epoch")
				.as_nanos()
		));
		std::fs::create_dir_all(&dir).expect("must create unique temp dir");
		dir
	}

	#[test]
	fn list_dir_of_root_yields_sorted_entries() {
		let root = unique_temp_dir("sorted");
		std::fs::write(root.join("b.txt"), b"b").unwrap();
		std::fs::write(root.join("a.txt"), b"a").unwrap();
		std::fs::create_dir(root.join("c_dir")).unwrap();

		let artifact = list_dir(&root, "").expect("list of the root itself must succeed");
		assert_eq!(artifact.entries, vec![
			ListDirEntry { name: "a.txt".to_owned(), kind: ListDirEntryKind::File },
			ListDirEntry { name: "b.txt".to_owned(), kind: ListDirEntryKind::File },
			ListDirEntry { name: "c_dir".to_owned(), kind: ListDirEntryKind::Directory },
		]);
		assert!(!artifact.truncated);
		std::fs::remove_dir_all(&root).ok();
	}

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
		assert_eq!(list_dir(&root, "nope"), Err(ListDirRejection::NotFound));
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

		let workspace = unique_temp_dir("workspace-escape-dir");
		let outside = unique_temp_dir("outside-escape-dir");
		symlink(&outside, workspace.join("escape")).expect("symlink creation must succeed");

		assert_eq!(list_dir(&workspace, "escape"), Err(ListDirRejection::OutOfRoot));
		std::fs::remove_dir_all(&workspace).ok();
		std::fs::remove_dir_all(&outside).ok();
	}

	#[test]
	fn list_dir_reports_symlink_children_without_following_them() {
		#[cfg(unix)]
		{
			use std::os::unix::fs::symlink;

			let root = unique_temp_dir("symlink-child");
			let target = unique_temp_dir("symlink-child-target");
			symlink(&target, root.join("link")).expect("symlink creation must succeed");

			let artifact =
				list_dir(&root, "").expect("list of a dir containing a symlink must succeed");
			assert_eq!(artifact.entries, vec![ListDirEntry {
				name: "link".to_owned(),
				kind: ListDirEntryKind::Symlink,
			}]);
			std::fs::remove_dir_all(&root).ok();
			std::fs::remove_dir_all(&target).ok();
		}
	}

	#[test]
	fn list_dir_truncates_beyond_the_entry_bound() {
		let root = unique_temp_dir("truncate");
		for index in 0..(DEFAULT_MAX_LIST_ENTRIES + 5) {
			std::fs::write(root.join(format!("f{index:05}.txt")), b"x").unwrap();
		}

		let artifact = list_dir(&root, "").expect("list of an over-bound dir must still succeed");
		assert_eq!(artifact.entries.len(), DEFAULT_MAX_LIST_ENTRIES);
		assert!(artifact.truncated);
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn list_dir_with_root_applies_the_same_checks_as_list_dir() {
		let root = unique_temp_dir("with-root");
		std::fs::write(root.join("shared.txt"), b"shared").unwrap();
		let workspace_root = WorkspaceRoot::new(&root).unwrap();

		assert_eq!(list_dir_with_root(&workspace_root, ""), list_dir(&root, ""));
		assert_eq!(list_dir_with_root(&workspace_root, "/etc"), Err(ListDirRejection::AbsolutePath));
		assert_eq!(
			list_dir_with_root(&workspace_root, "../outside"),
			Err(ListDirRejection::ParentTraversal)
		);
		std::fs::remove_dir_all(&root).ok();
	}
}
