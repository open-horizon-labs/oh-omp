//! Lane C6 `KernelToolSearchFindGrep`: bounded filename discovery (`find`).
//!
//! This module also owns the shared bounded workspace walk reused by
//! `search_files` and `grep` (Dissent ruling 3: a C6-owned walker composing
//! the C5 substrate is allowed; C6 has no separate module grant to place it
//! in its own file, so it lives here as `pub(crate)` and the sibling tool
//! files import it).
//!
//! Disclosed walk policy (Dissent ruling 4 — recorded here, never
//! presented as fixture-pinned):
//! - Traversal order is a pre-order, per-directory-sorted walk. At each
//!   directory level, entries are compared by name with a trailing `/` appended
//!   to directory names before the string comparison (so a directory named `a`
//!   sorts as `"a/"`, not `"a"`). This makes the per-level sort exactly
//!   reproduce a flat lexicographic sort of the full relative-path strings (the
//!   classic "tree vs blob" ordering used by e.g. `git ls-tree`): for any two
//!   distinct sibling names, whichever byte first differs between their
//!   (slash-suffixed-if-dir) keys is the same byte that decides the order of
//!   every full path built from them, regardless of what comes after. That
//!   means an early stop after the Nth eligible entry yields the same prefix a
//!   full collect-then-sort would, without visiting the rest of the tree —
//!   bounded traversal and determinism at once.
//! - Hidden (dot-prefixed) entries are included; there is no gitignore or
//!   hidden-file filtering (`ignore` is explicitly not a granted dependency —
//!   Dissent ruling 2; contract §8.2 "unless implementation explicitly records
//!   why not": this is that record).
//! - Symlinks are excluded from results entirely — neither traversed as
//!   directories nor listed as file candidates. This is stricter than "not
//!   followed": it makes symlink escape structurally impossible for these three
//!   tools without depending on a runtime containment check for every entry.
//! - A permission or I/O error on an individual entry/subtree is skipped rather
//!   than aborting the whole walk; the caller only sees a top-level
//!   `RootNotFound`/`PermissionDenied`/`Io` rejection if the workspace root
//!   itself cannot be established.

use std::path::Path;

use globset::GlobBuilder;
use successor_protocol::artifact::ArtifactHash;
use walkdir::WalkDir;

use super::{PathBoundError, WorkspaceRoot, compute_artifact_bytes};

/// Default cap on the number of eligible (non-symlink, regular-file)
/// entries a single discovery walk collects before reporting `truncated:
/// true` and stopping — an explicit, disclosed default (Dissent ruling 4),
/// not fixture-pinned. Bounds traversal, not just output: the walk stops
/// early once this many eligible entries have been seen.
pub(crate) const DEFAULT_MAX_WALK_ENTRIES: usize = 2_000;

/// Typed rejection produced while establishing the bounded workspace walk
/// shared by `search_files`, `find`, and `grep`. There is no
/// caller-supplied relative path at this layer — the only path resolved
/// here is the trusted workspace root itself — so this does not need
/// [`PathBoundError`]'s `AbsolutePath`/`ParentTraversal`/`NotFound`/
/// `OutOfRoot` variants, which only apply to a caller-supplied candidate.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DiscoveryWalkError {
	#[error("workspace root does not exist")]
	RootNotFound,
	#[error("permission denied")]
	PermissionDenied,
	#[error("workspace walk failed: {0}")]
	Io(String),
}

fn map_root_bound(err: PathBoundError) -> DiscoveryWalkError {
	match err {
		PathBoundError::RootNotFound => DiscoveryWalkError::RootNotFound,
		PathBoundError::PermissionDenied => DiscoveryWalkError::PermissionDenied,
		PathBoundError::Io(message) => DiscoveryWalkError::Io(message),
		// `WorkspaceRoot::new` only ever produces the three variants above
		// for the trusted root itself; the remaining `PathBoundError`
		// variants are only produced by `WorkspaceRoot::resolve` for a
		// caller-supplied relative candidate. Kept as a defensive
		// catch-all for exhaustiveness rather than relied upon.
		other => DiscoveryWalkError::Io(other.to_string()),
	}
}

fn classify_walk_io(err: std::io::Error) -> DiscoveryWalkError {
	match err.kind() {
		std::io::ErrorKind::NotFound => DiscoveryWalkError::RootNotFound,
		std::io::ErrorKind::PermissionDenied => DiscoveryWalkError::PermissionDenied,
		_ => DiscoveryWalkError::Io(err.to_string()),
	}
}

/// Result of a bounded, deterministic filesystem walk rooted at the
/// workspace root.
pub(crate) struct DiscoveryWalk {
	/// Reused by callers that must perform a second, content-reading pass
	/// over a candidate (currently only `grep`) so that read re-validates
	/// containment through the C5 substrate exactly, rather than trusting
	/// the walk's own bookkeeping for I/O.
	pub(crate) workspace_root: WorkspaceRoot,
	/// Relative paths, `/`-normalized, in the walk's deterministic order
	/// (equivalent to a flat lexicographic sort of the full relative-path
	/// strings — see module docs).
	pub(crate) relative_paths: Vec<String>,
	/// `true` if the walk stopped after `max_entries` eligible entries
	/// without exhausting the tree.
	pub(crate) truncated:      bool,
}

/// Walk `root_path` bounded to at most `max_entries` eligible (regular
/// file, non-symlink) entries, in deterministic order (see module docs).
pub(crate) fn walk_workspace(
	root_path: &Path,
	max_entries: usize,
) -> Result<DiscoveryWalk, DiscoveryWalkError> {
	let workspace_root = WorkspaceRoot::new(root_path).map_err(map_root_bound)?;
	let canonical_root = std::fs::canonicalize(root_path).map_err(classify_walk_io)?;

	let mut relative_paths = Vec::new();
	let mut truncated = false;

	let walker = WalkDir::new(&canonical_root)
		.min_depth(1)
		.follow_links(false)
		.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));

	for entry in walker {
		let Ok(entry) = entry else {
			// An unreadable subtree (e.g. a permission-denied directory)
			// is skipped rather than aborting the whole walk (disclosed
			// policy — Dissent ruling 4).
			continue;
		};
		let file_type = entry.file_type();
		if file_type.is_symlink() || !file_type.is_file() {
			continue;
		}
		if relative_paths.len() >= max_entries {
			truncated = true;
			break;
		}
		let Ok(relative) = entry.path().strip_prefix(&canonical_root) else {
			continue;
		};
		relative_paths.push(normalize_relative_path(relative));
	}

	Ok(DiscoveryWalk { workspace_root, relative_paths, truncated })
}

/// Sort key for one directory level: directory names get a trailing `/`
/// so that per-level comparison exactly reproduces a flat lexicographic
/// comparison of full relative-path strings (see module docs).
fn sort_key(entry: &walkdir::DirEntry) -> String {
	let name = entry.file_name().to_string_lossy().into_owned();
	if entry.file_type().is_dir() {
		format!("{name}/")
	} else {
		name
	}
}

fn normalize_relative_path(relative: &Path) -> String {
	relative
		.components()
		.map(|component| component.as_os_str().to_string_lossy().into_owned())
		.collect::<Vec<_>>()
		.join("/")
}

/// Typed rejection produced by [`find`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FindRejection {
	#[error("workspace root does not exist")]
	RootNotFound,
	#[error("permission denied")]
	PermissionDenied,
	#[error("workspace walk failed: {0}")]
	Io(String),
	#[error("glob pattern is invalid: {0}")]
	InvalidPattern(String),
}

fn map_walk_error(err: DiscoveryWalkError) -> FindRejection {
	match err {
		DiscoveryWalkError::RootNotFound => FindRejection::RootNotFound,
		DiscoveryWalkError::PermissionDenied => FindRejection::PermissionDenied,
		DiscoveryWalkError::Io(message) => FindRejection::Io(message),
	}
}

/// One matched path from [`find`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FindMatch {
	pub path: String,
}

/// Artifact-backed content produced by a successful [`find`] call.
///
/// Mirrors [`super::read::ReadArtifactContent`]'s shape: typed content plus
/// raw bytes/hash/length for a later lane (the turn runner) to assign a
/// persisted artifact id and preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindArtifactContent {
	pub entries:     Vec<FindMatch>,
	pub truncated:   bool,
	pub bytes:       Vec<u8>,
	pub sha256:      ArtifactHash,
	pub byte_length: u64,
}

#[derive(serde::Serialize)]
struct FindArtifactPayload<'a> {
	entries: &'a [FindMatch],
}

/// Bounded filename discovery: match `glob_pattern` against every regular,
/// non-symlink file under `root_path`.
///
/// Uses the bounded, deterministic walk (see module docs), returning at
/// most `max_results` matches in walk order.
///
/// `glob_pattern` is compiled with `literal_separator` enabled (shell-glob
/// semantics: a single `*`/`?` does not cross a `/`; `**` still matches
/// across directories) — disclosed policy, matching how `ripgrep`/`fd`
/// configure `globset` for path-glob matching rather than filename-only
/// matching.
pub fn find(
	root_path: &Path,
	glob_pattern: &str,
	max_results: usize,
) -> Result<FindArtifactContent, FindRejection> {
	let matcher = GlobBuilder::new(glob_pattern)
		.literal_separator(true)
		.build()
		.map_err(|err| FindRejection::InvalidPattern(err.to_string()))?
		.compile_matcher();

	let walk = walk_workspace(root_path, DEFAULT_MAX_WALK_ENTRIES).map_err(map_walk_error)?;

	let mut entries = Vec::new();
	let mut truncated = walk.truncated;
	for relative in walk.relative_paths {
		if !matcher.is_match(Path::new(&relative)) {
			continue;
		}
		if entries.len() >= max_results {
			truncated = true;
			break;
		}
		entries.push(FindMatch { path: relative });
	}

	let payload = FindArtifactPayload { entries: &entries };
	let bytes = serde_json::to_vec(&payload).expect("FindArtifactPayload always serializes");
	let (sha256, byte_length) = compute_artifact_bytes(&bytes);

	Ok(FindArtifactContent { entries, truncated, bytes, sha256, byte_length })
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use super::*;

	fn unique_temp_dir(label: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"successor-kernel-find-{label}-{}-{}",
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
	fn find_matches_glob_and_reports_untruncated() {
		let root_dir = unique_temp_dir("basic");
		std::fs::create_dir_all(root_dir.join("src")).unwrap();
		std::fs::write(root_dir.join("src/lib.rs"), b"fn main() {}").unwrap();
		std::fs::write(root_dir.join("README.md"), b"# hi").unwrap();

		let result = find(&root_dir, "**/*.rs", 100).unwrap();
		assert_eq!(result.entries, vec![FindMatch { path: "src/lib.rs".to_string() }]);
		assert!(!result.truncated);

		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn find_rejects_invalid_glob_as_typed_input_error() {
		let root_dir = unique_temp_dir("bad-glob");
		let err = find(&root_dir, "[", 10).unwrap_err();
		assert!(matches!(err, FindRejection::InvalidPattern(_)));
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn find_rejects_missing_root() {
		let root_dir = unique_temp_dir("missing-root");
		std::fs::remove_dir_all(&root_dir).ok();
		let err = find(&root_dir, "*", 10).unwrap_err();
		assert_eq!(err, FindRejection::RootNotFound);
	}
}
