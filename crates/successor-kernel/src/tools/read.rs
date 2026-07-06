//! Root-bounded whole-file read tool, owned by Lane C5
//! `KernelToolCatalogAndRead`.
//!
//! Slice 0 scope (Dissent ruling 5): whole-file reads only, no partial or
//! windowed reads, no pagination. [`read`] resolves `relative_path` against
//! `root_path` through the shared [`super::WorkspaceRoot`] substrate (never
//! naming that type in this module's public API — see its doc comment),
//! then hashes and measures the content via the accepted `successor-protocol`
//! A1 hashing surface: [`successor_protocol::artifact::ArtifactHash::compute`]
//! and [`successor_protocol::artifact::validate_artifact_content`]. This
//! module adds no separate hashing dependency.
//!
//! Binary detection (Dissent ruling 4): a NUL byte anywhere in the file is
//! treated as binary-looking and rejected as [`ReadRejection::BinaryLooking`].
//! No content-type/MIME sniffing is performed beyond that single rule.
//!
//! The workspace root is always supplied explicitly by the caller as
//! `root_path`; this module never falls back to an environment variable or
//! the process's current working directory.

use std::path::Path;

use successor_protocol::artifact::{ArtifactHash, validate_artifact_content};

use super::{
	PathBoundError, WorkspaceRoot, compute_artifact_bytes, looks_binary,
	validate_relative_path_lexically,
};

/// Whole-file content produced by a successful [`read`].
///
/// This is Slice 0 read-tool output, not a persisted
/// `successor_protocol::artifact::ArtifactV0` — assigning a platform
/// `ArtifactId` is a persistence concern owned by a later lane (the turn
/// runner / event pipeline). This struct carries everything a later lane
/// needs to build one once an `ArtifactId` is available: raw bytes, the
/// same [`ArtifactHash`] type `ArtifactV0` stores, and the byte length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadArtifactContent {
	/// The whole file content, exactly as read from disk.
	pub bytes:       Vec<u8>,
	/// SHA-256 of `bytes`, computed via `ArtifactHash::compute`.
	pub sha256:      ArtifactHash,
	/// `bytes.len()` as `u64`.
	pub byte_length: u64,
}

/// Typed rejection produced by [`read`].
///
/// Every variant is a distinct, disclosed policy decision (Dissent rulings
/// 2 and 4); callers must not collapse these into one generic failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadRejection {
	/// The configured workspace root itself does not exist.
	#[error("workspace root does not exist")]
	RootNotFound,
	/// The caller supplied an absolute path; only paths relative to the
	/// workspace root are accepted.
	#[error("path must be relative to the workspace root")]
	AbsolutePath,
	/// The caller-supplied path contains a `..` component.
	#[error("path must not contain `..` components")]
	ParentTraversal,
	/// The path does not exist under the workspace root.
	#[error("path does not exist")]
	NotFound,
	/// The path's canonical (symlink-resolved) form falls outside the
	/// workspace root. Covers both a lexically out-of-root path and a
	/// symlink escape.
	#[error("path resolves outside the workspace root")]
	OutOfRoot,
	/// The operating system denied access while resolving or reading the
	/// path.
	#[error("permission denied")]
	PermissionDenied,
	/// The resolved path exists but is not a regular file (for example, a
	/// directory). Slice 0 `read` is whole-file-only.
	#[error("path is not a regular file")]
	NotAFile,
	/// The read window contained a NUL byte and was rejected as
	/// binary-looking (Dissent ruling 4). No content-type inference is
	/// performed beyond this single rule.
	#[error("file looks binary (contains a NUL byte); read rejected")]
	BinaryLooking,
	/// Any other I/O failure encountered while resolving or reading the
	/// path. The message is diagnostic only; it is not a stable API
	/// surface.
	#[error("read failed: {0}")]
	Io(String),
}

fn map_path_bound(err: PathBoundError) -> ReadRejection {
	match err {
		PathBoundError::RootNotFound => ReadRejection::RootNotFound,
		PathBoundError::AbsolutePath => ReadRejection::AbsolutePath,
		PathBoundError::ParentTraversal => ReadRejection::ParentTraversal,
		PathBoundError::NotFound => ReadRejection::NotFound,
		PathBoundError::OutOfRoot => ReadRejection::OutOfRoot,
		PathBoundError::PermissionDenied => ReadRejection::PermissionDenied,
		PathBoundError::Io(message) => ReadRejection::Io(message),
	}
}

fn map_read_io(err: std::io::Error) -> ReadRejection {
	match err.kind() {
		std::io::ErrorKind::NotFound => ReadRejection::NotFound,
		std::io::ErrorKind::PermissionDenied => ReadRejection::PermissionDenied,
		_ => ReadRejection::Io(err.to_string()),
	}
}

/// Arguments for the `read` tool: read the full contents of a file under
/// the workspace root.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
pub struct ReadArgs {
	/// Path to read, relative to the workspace root.
	#[serde(default)]
	pub path: String,
}

/// Read the whole contents of `relative_path` under the workspace rooted at
/// `root_path`.
///
/// `root_path` is the trusted workspace root, supplied by the caller (the
/// host process) — never derived internally from an environment variable
/// or the current working directory. `relative_path` is caller/tool-call
/// supplied and is bounded per [`super::WorkspaceRoot::resolve`].
///
/// `relative_path` is validated lexically (absolute path, `..` components)
/// *before* `root_path` is canonicalized, so a malformed caller path is
/// rejected even when the configured root itself does not exist or cannot
/// be read — canonicalizing an untrusted root first would let a root-level
/// I/O failure (`RootNotFound`/`PermissionDenied`) mask a lexical
/// rejection the contract requires to take precedence.
pub fn read(root_path: &Path, relative_path: &str) -> Result<ReadArtifactContent, ReadRejection> {
	validate_relative_path_lexically(relative_path).map_err(map_path_bound)?;
	let root = WorkspaceRoot::new(root_path).map_err(map_path_bound)?;
	read_with_root(&root, relative_path)
}

/// Read `relative_path` against an already-constructed [`WorkspaceRoot`].
///
/// For `pub(crate)` callers (e.g. a turn runner) that construct the
/// workspace root once per session rather than canonicalizing it on every
/// tool call. [`WorkspaceRoot::resolve`] applies the same lexical checks
/// before any candidate-path I/O that [`read`] applies before root
/// construction, so precedence is identical between the two entry points.
pub(crate) fn read_with_root(
	root: &WorkspaceRoot,
	relative_path: &str,
) -> Result<ReadArtifactContent, ReadRejection> {
	let resolved = root.resolve(relative_path).map_err(map_path_bound)?;

	let metadata = std::fs::metadata(&resolved).map_err(map_read_io)?;
	if !metadata.is_file() {
		return Err(ReadRejection::NotAFile);
	}

	let bytes = std::fs::read(&resolved).map_err(map_read_io)?;
	if looks_binary(&bytes) {
		return Err(ReadRejection::BinaryLooking);
	}

	let (sha256, byte_length) = compute_artifact_bytes(&bytes);
	validate_artifact_content(sha256.as_str(), byte_length, &bytes)
		.expect("hash/length computed from these exact bytes must validate against them");

	Ok(ReadArtifactContent { bytes, sha256, byte_length })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn unique_temp_dir(label: &str) -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"successor-kernel-tools-read-{label}-{}-{}",
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
	fn read_of_known_file_yields_correct_hash_and_byte_length() {
		let root = unique_temp_dir("happy");
		let content = b"hello, slice 0 read tool\n";
		std::fs::write(root.join("greeting.txt"), content).unwrap();

		let artifact = read(&root, "greeting.txt").expect("read of an in-root file must succeed");
		assert_eq!(artifact.bytes, content);
		assert_eq!(artifact.byte_length, content.len() as u64);
		assert_eq!(artifact.sha256, ArtifactHash::compute(content));
		validate_artifact_content(artifact.sha256.as_str(), artifact.byte_length, &artifact.bytes)
			.expect("returned artifact fields must validate via the protocol helper");

		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn read_rejects_absolute_path() {
		let root = unique_temp_dir("abs");
		assert_eq!(read(&root, "/etc/passwd"), Err(ReadRejection::AbsolutePath));
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn read_rejects_parent_traversal() {
		let root = unique_temp_dir("dotdot");
		assert_eq!(read(&root, "../outside.txt"), Err(ReadRejection::ParentTraversal));
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn read_rejects_nonexistent_file_as_not_found() {
		let root = unique_temp_dir("missing");
		assert_eq!(read(&root, "nope.txt"), Err(ReadRejection::NotFound));
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn read_rejects_a_directory_as_not_a_file() {
		let root = unique_temp_dir("dir");
		std::fs::create_dir_all(root.join("subdir")).unwrap();
		assert_eq!(read(&root, "subdir"), Err(ReadRejection::NotAFile));
		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn read_rejects_nul_containing_file_as_binary_looking() {
		let root = unique_temp_dir("binary");
		std::fs::write(root.join("blob.bin"), b"prefix\0suffix").unwrap();
		assert_eq!(read(&root, "blob.bin"), Err(ReadRejection::BinaryLooking));
		std::fs::remove_dir_all(&root).ok();
	}

	#[cfg(unix)]
	#[test]
	fn read_rejects_symlink_escape_outside_root() {
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

		// Root (and some sandboxed CI runners) can bypass Unix permission
		// bits entirely; when that happens the read succeeds instead of
		// hitting PermissionDenied. This edge case is portable only under a
		// non-privileged user, hence "where portable" in the lane
		// acceptance criteria.
		match outcome {
			Err(ReadRejection::PermissionDenied) => {},
			Ok(_) => eprintln!(
				"permission-denied test skipped: running with privileges that bypass file mode bits"
			),
			Err(other) => panic!("expected PermissionDenied or a privileged bypass, got {other:?}"),
		}
	}

	#[test]
	fn root_with_trailing_separator_normalizes_correctly() {
		let root = unique_temp_dir("trailing-sep");
		std::fs::write(root.join("hello.txt"), b"hi").unwrap();

		let mut with_slash = root.as_os_str().to_owned();
		with_slash.push("/");

		let plain = read(&root, "hello.txt").unwrap();
		let slashed = read(Path::new(&with_slash), "hello.txt").unwrap();
		assert_eq!(plain, slashed);

		std::fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn read_precedence_absolute_path_wins_over_missing_root() {
		let base = unique_temp_dir("missing-root-abs");
		let missing_root = base.join("does-not-exist");
		assert_eq!(read(&missing_root, "/etc/passwd"), Err(ReadRejection::AbsolutePath));
		std::fs::remove_dir_all(&base).ok();
	}

	#[test]
	fn read_precedence_parent_traversal_wins_over_missing_root() {
		let base = unique_temp_dir("missing-root-dotdot");
		let missing_root = base.join("does-not-exist");
		assert_eq!(read(&missing_root, "../outside.txt"), Err(ReadRejection::ParentTraversal));
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

		// Even if a privileged runner (root/CI) bypasses these permission
		// bits entirely, this assertion still holds: the lexical check on
		// `relative_path` runs before `WorkspaceRoot::new` ever attempts to
		// canonicalize `root`, so the outcome does not depend on permission
		// enforcement.
		let outcome_abs = read(&root, "/etc/passwd");
		let outcome_dotdot = read(&root, "../outside.txt");

		std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o755)).ok();
		std::fs::remove_dir_all(&base).ok();

		assert_eq!(outcome_abs, Err(ReadRejection::AbsolutePath));
		assert_eq!(outcome_dotdot, Err(ReadRejection::ParentTraversal));
	}

	#[test]
	fn read_with_root_applies_the_same_checks_as_read() {
		let root = unique_temp_dir("read-with-root");
		let content = b"same substrate, two entry points\n";
		std::fs::write(root.join("shared.txt"), content).unwrap();

		let workspace_root = WorkspaceRoot::new(&root).expect("root must canonicalize");

		assert_eq!(read_with_root(&workspace_root, "shared.txt"), read(&root, "shared.txt"));
		assert_eq!(read_with_root(&workspace_root, "/etc/passwd"), Err(ReadRejection::AbsolutePath));
		assert_eq!(
			read_with_root(&workspace_root, "../outside.txt"),
			Err(ReadRejection::ParentTraversal)
		);

		std::fs::remove_dir_all(&root).ok();
	}
}
