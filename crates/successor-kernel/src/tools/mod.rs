//! Shared filesystem-tool substrate, owned by Lane C5
//! `KernelToolCatalogAndRead`.
//!
//! [`WorkspaceRoot`] and [`PathBoundError`] are the safe-path containment
//! primitives shared by every filesystem-backed tool. Lane C6
//! `KernelToolSearchFindGrep` reuses this substrate for `search_files`,
//! `find`, and `grep`; this module does not implement those tools, and this
//! substrate is `pub(crate)`-only (Dissent ruling 1) — it is not part of the
//! kernel crate's public API. [`tools::read`](super::tools::read) is the one
//! public-facing tool implemented by this lane.
//!
//! Root bounding contract (Slice 0 contract §8, Dissent ruling 2):
//! 1. Only relative paths are accepted from callers. Absolute paths and any
//!    path containing a `..` component are rejected lexically, purely by
//!    inspecting the candidate's [`Component`]s — before any filesystem I/O is
//!    attempted.
//! 2. Both the trusted root and the resolved candidate are canonicalized
//!    (`std::fs::canonicalize`, which fully resolves symlinks). Containment is
//!    then checked with [`Path::starts_with`], which compares whole path
//!    *components*, never raw strings — so a sibling directory that merely
//!    shares a string prefix with the root (e.g. `root_evil` vs `root`) is
//!    never mistaken for being contained in it.
//! 3. Because canonicalization fully resolves symlinks, a candidate that is
//!    lexically nested under the root but whose real target escapes it via a
//!    symlink is rejected by the same containment check as any other
//!    out-of-root path.
//! 4. A candidate that does not exist is a distinct, typed not-found rejection
//!    ([`PathBoundError::NotFound`]); in-root content is never returned for a
//!    path that does not exist.
//! 5. The workspace root is supplied once, by the trusted host process, via
//!    [`WorkspaceRoot::new`]. It is never derived from provider/tool-call
//!    arguments, environment variables, or the process's current working
//!    directory.

pub mod catalog;
pub mod find;
pub mod grep;
pub mod read;
pub mod search_files;

use std::{
	fmt,
	path::{Component, Path, PathBuf},
};

use successor_protocol::artifact::ArtifactHash;

/// A canonicalized trusted filesystem root that bounds every path a
/// filesystem tool is allowed to touch.
///
/// Constructed once by the host process from trusted configuration — never
/// from provider/tool-call input, environment variables, or `cwd`
/// discovery. All path resolution happens through [`WorkspaceRoot::resolve`].
///
/// `pub(crate)`: this is internal tool substrate (Dissent ruling 1), reused
/// by Lane C6's `search_files`/`find`/`grep` implementations. It is
/// deliberately not exposed in any public function signature in this crate;
/// [`read::read`] takes a plain `&Path` and constructs a `WorkspaceRoot`
/// internally so its own public API never has to name this type.
#[derive(Debug, Clone)]
pub(crate) struct WorkspaceRoot {
	root: PathBuf,
}

impl WorkspaceRoot {
	/// Canonicalize `root` and adopt it as the trusted containment boundary.
	pub(crate) fn new(root: impl AsRef<Path>) -> Result<Self, PathBoundError> {
		let canonical = std::fs::canonicalize(root.as_ref()).map_err(classify_root_io)?;
		Ok(Self { root: canonical })
	}

	/// Resolve a caller-supplied relative path to a canonical path
	/// guaranteed to be contained within the trusted root.
	///
	/// Rejection order: absolute path, `..` component (both lexical, no
	/// I/O), then not-found or out-of-root (both require canonicalizing the
	/// candidate, which requires it to exist).
	pub(crate) fn resolve(&self, relative: &str) -> Result<PathBuf, PathBoundError> {
		let candidate = Path::new(relative);
		if candidate.is_absolute() {
			return Err(PathBoundError::AbsolutePath);
		}
		if candidate
			.components()
			.any(|component| matches!(component, Component::ParentDir))
		{
			return Err(PathBoundError::ParentTraversal);
		}

		let joined = self.root.join(candidate);
		let canonical = std::fs::canonicalize(&joined).map_err(classify_candidate_io)?;

		if !canonical.starts_with(&self.root) {
			return Err(PathBoundError::OutOfRoot);
		}

		Ok(canonical)
	}
}

fn classify_root_io(err: std::io::Error) -> PathBoundError {
	match err.kind() {
		std::io::ErrorKind::NotFound => PathBoundError::RootNotFound,
		std::io::ErrorKind::PermissionDenied => PathBoundError::PermissionDenied,
		_ => PathBoundError::Io(err.to_string()),
	}
}

fn classify_candidate_io(err: std::io::Error) -> PathBoundError {
	match err.kind() {
		std::io::ErrorKind::NotFound => PathBoundError::NotFound,
		std::io::ErrorKind::PermissionDenied => PathBoundError::PermissionDenied,
		_ => PathBoundError::Io(err.to_string()),
	}
}

/// Typed rejection produced while resolving a caller-supplied path against a
/// [`WorkspaceRoot`].
///
/// Each variant is a distinct, disclosed policy decision (Dissent ruling
/// 2) — callers must not collapse these into one generic failure.
/// `pub(crate)`: internal substrate, not part of the crate's public API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PathBoundError {
	/// The configured workspace root itself does not exist.
	RootNotFound,
	/// The caller supplied an absolute path; only paths relative to the
	/// workspace root are accepted.
	AbsolutePath,
	/// The caller-supplied path contains a `..` component.
	ParentTraversal,
	/// The path does not exist under the workspace root.
	NotFound,
	/// The path's canonical (symlink-resolved) form falls outside the
	/// workspace root. Covers both a lexically out-of-root path and a
	/// symlink escape.
	OutOfRoot,
	/// The operating system denied access while resolving the path.
	PermissionDenied,
	/// Any other I/O failure encountered while resolving the path. The
	/// message is diagnostic only; it is not a stable API surface.
	Io(String),
}

impl fmt::Display for PathBoundError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::RootNotFound => f.write_str("workspace root does not exist"),
			Self::AbsolutePath => f.write_str("path must be relative to the workspace root"),
			Self::ParentTraversal => f.write_str("path must not contain `..` components"),
			Self::NotFound => f.write_str("path does not exist"),
			Self::OutOfRoot => f.write_str("path resolves outside the workspace root"),
			Self::PermissionDenied => f.write_str("permission denied"),
			Self::Io(message) => write!(f, "path resolution failed: {message}"),
		}
	}
}

impl std::error::Error for PathBoundError {}

/// Whether `bytes` looks binary under the Slice 0 rule: the presence of a
/// NUL byte anywhere in the window (Dissent ruling 4). This is a single
/// deterministic rule, not content-type/MIME inference, and is shared
/// substrate any filesystem tool may reuse to skip binary content.
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
	bytes.contains(&0)
}

/// Compute the SHA-256 hash and byte length of `bytes` via the accepted
/// `successor-protocol` A1 hashing surface
/// ([`successor_protocol::artifact::ArtifactHash::compute`]).
///
/// Shared artifact-bytes helper: this crate adds no separate hashing
/// dependency, and any filesystem tool that needs to describe raw content
/// (this lane's `read`, and Lane C6's future tools) computes hash/length
/// through this one path.
pub(crate) fn compute_artifact_bytes(bytes: &[u8]) -> (ArtifactHash, u64) {
	let sha256 = ArtifactHash::compute(bytes);
	let byte_length = bytes.len() as u64;
	(sha256, byte_length)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn unique_temp_dir(label: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"successor-kernel-tools-mod-{label}-{}-{}",
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
	fn resolve_rejects_absolute_path_lexically() {
		let root_dir = unique_temp_dir("abs");
		let root = WorkspaceRoot::new(&root_dir).unwrap();
		assert_eq!(root.resolve("/etc/passwd"), Err(PathBoundError::AbsolutePath));
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn resolve_rejects_parent_traversal_lexically() {
		let root_dir = unique_temp_dir("dotdot");
		let root = WorkspaceRoot::new(&root_dir).unwrap();
		assert_eq!(root.resolve("../secret.txt"), Err(PathBoundError::ParentTraversal));
		assert_eq!(root.resolve("child/../../secret.txt"), Err(PathBoundError::ParentTraversal));
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn resolve_rejects_nonexistent_path_as_not_found() {
		let root_dir = unique_temp_dir("missing");
		let root = WorkspaceRoot::new(&root_dir).unwrap();
		assert_eq!(root.resolve("does-not-exist.txt"), Err(PathBoundError::NotFound));
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn resolve_accepts_in_root_file_and_returns_canonical_path() {
		let root_dir = unique_temp_dir("happy");
		let file_path = root_dir.join("hello.txt");
		std::fs::write(&file_path, b"hi").unwrap();

		let root = WorkspaceRoot::new(&root_dir).unwrap();
		let resolved = root.resolve("hello.txt").unwrap();
		assert_eq!(resolved, std::fs::canonicalize(&file_path).unwrap());
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn root_with_trailing_separator_normalizes_the_same_as_without() {
		let root_dir = unique_temp_dir("trailing-sep");
		std::fs::write(root_dir.join("hello.txt"), b"hi").unwrap();

		let root_no_slash = WorkspaceRoot::new(&root_dir).unwrap();
		let mut with_slash = root_dir.as_os_str().to_owned();
		with_slash.push("/");
		let root_with_slash = WorkspaceRoot::new(Path::new(&with_slash)).unwrap();

		assert_eq!(root_no_slash.root, root_with_slash.root);
		assert_eq!(
			root_no_slash.resolve("hello.txt").unwrap(),
			root_with_slash.resolve("hello.txt").unwrap()
		);
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[cfg(unix)]
	#[test]
	fn resolve_rejects_symlink_escape_even_when_lexically_in_root() {
		// The string-prefix trap: `workspace_evil` shares a string prefix
		// with `workspace` but must never be treated as contained within
		// it. A naive `candidate_str.starts_with(root_str)` check would
		// incorrectly accept this; component-wise `Path::starts_with` must
		// reject it.
		let base = unique_temp_dir("escape-base");
		let workspace = base.join("workspace");
		let evil = base.join("workspace_evil");
		std::fs::create_dir_all(&workspace).unwrap();
		std::fs::create_dir_all(&evil).unwrap();
		std::fs::write(evil.join("secret.txt"), b"top secret").unwrap();
		std::os::unix::fs::symlink(&evil, workspace.join("escape")).unwrap();

		let root = WorkspaceRoot::new(&workspace).unwrap();
		assert_eq!(root.resolve("escape/secret.txt"), Err(PathBoundError::OutOfRoot));
		std::fs::remove_dir_all(&base).ok();
	}

	#[test]
	fn looks_binary_detects_nul_byte() {
		assert!(looks_binary(b"hello\0world"));
		assert!(!looks_binary(b"hello world"));
	}

	#[test]
	fn compute_artifact_bytes_matches_protocol_hash_and_length() {
		let bytes = b"hello, kernel";
		let (sha256, byte_length) = compute_artifact_bytes(bytes);
		assert_eq!(sha256, ArtifactHash::compute(bytes));
		assert_eq!(byte_length, bytes.len() as u64);
	}
}
