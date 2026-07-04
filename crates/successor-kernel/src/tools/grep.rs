//! Lane C6 `KernelToolSearchFindGrep`: bounded regex line search (`grep`)
//! over the shared discovery walk (see [`super::find`] module docs).
//!
//! Disclosed content-scanning policy:
//! - Every candidate from the bounded walk is re-validated through
//!   [`super::WorkspaceRoot::resolve`] before its bytes are read (Dissent
//!   ruling 3: reuse the C5 containment substrate exactly for the one secondary
//!   I/O these three tools perform, rather than trusting the walk's own path
//!   bookkeeping). `find` never reads a candidate's content, so it has no
//!   second I/O to protect this way; `search_files` now also re-validates
//!   through the same substrate for its bounded content-derived preview (see
//!   [`super::search_files`] module docs) — only `read`, `grep`, and
//!   `search_files` perform this second I/O.
//! - A file is skipped (not scanned, not an error) if its content
//!   `looks_binary` — the same NUL-byte rule [`super::read::read`] uses to
//!   reject binary reads — or if it exceeds [`MAX_SCAN_FILE_BYTES`], the
//!   disclosed cap on how much of a single candidate `grep` will read into
//!   memory to scan. `find` still lists these files by name; only `grep`'s
//!   content scan skips them.
//! - Matching is line-oriented: each candidate file's bytes are decoded as
//!   UTF-8 with lossy replacement, split on `\n`, and each line is tested
//!   against the compiled regex. A match's `preview` is the matched line,
//!   truncated at a UTF-8 char boundary to at most [`MAX_PREVIEW_BYTES`] bytes;
//!   `preview_truncated` records whether truncation occurred, so a long line is
//!   bounded without silently losing the fact that it was cut.
//! - Matches are collected in the walk's deterministic path order (see
//!   [`super::find`] module docs), then by ascending line number within a file;
//!   truncation stops the scan itself (not just the output) once `max_matches`
//!   matches have been collected.

use std::path::Path;

use regex::Regex;
use successor_protocol::artifact::ArtifactHash;

use super::{
	compute_artifact_bytes,
	find::{DEFAULT_MAX_WALK_ENTRIES, DiscoveryWalkError, walk_workspace},
	looks_binary,
};

/// Maximum byte length of a single [`GrepMatch::preview`] (and, via
/// [`truncate_preview`], a `search_files` content-derived preview — see
/// [`super::search_files`] module docs). Disclosed bound, not fixture-pinned:
/// keeps a single long line from turning a match preview into an unbounded
/// content channel.
pub(crate) const MAX_PREVIEW_BYTES: usize = 512;

/// Maximum byte length of a candidate file `grep` (and `search_files`, for its
/// content-derived preview) will read into memory to scan. A candidate larger
/// than this is skipped exactly like a binary or unreadable file — the same
/// consistent silent-skip policy, rather than reading an unbounded amount of
/// file content.
pub(crate) const MAX_SCAN_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Truncates `line` to at most [`MAX_PREVIEW_BYTES`] bytes at a UTF-8 char
/// boundary (never splitting a multi-byte character), returning the
/// (possibly truncated) preview and whether truncation occurred.
pub(crate) fn truncate_preview(line: &str) -> (String, bool) {
	if line.len() <= MAX_PREVIEW_BYTES {
		return (line.to_string(), false);
	}
	let mut end = MAX_PREVIEW_BYTES;
	while !line.is_char_boundary(end) {
		end -= 1;
	}
	(line[..end].to_string(), true)
}

/// Typed rejection produced by [`grep`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GrepRejection {
	#[error("workspace root does not exist")]
	RootNotFound,
	#[error("permission denied")]
	PermissionDenied,
	#[error("workspace walk failed: {0}")]
	Io(String),
	#[error("regex pattern is invalid: {0}")]
	InvalidPattern(String),
}

fn map_walk_error(err: DiscoveryWalkError) -> GrepRejection {
	match err {
		DiscoveryWalkError::RootNotFound => GrepRejection::RootNotFound,
		DiscoveryWalkError::PermissionDenied => GrepRejection::PermissionDenied,
		DiscoveryWalkError::Io(message) => GrepRejection::Io(message),
	}
}

/// One matched line from [`grep`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GrepMatch {
	pub path:              String,
	pub line:              u64,
	pub preview:           String,
	pub preview_truncated: bool,
}

/// Artifact-backed content produced by a successful [`grep`] call.
///
/// Mirrors [`super::read::ReadArtifactContent`]'s shape: typed content plus
/// raw bytes/hash/length for a later lane (the turn runner) to assign a
/// persisted artifact id and preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrepArtifactContent {
	pub matches:     Vec<GrepMatch>,
	pub truncated:   bool,
	pub bytes:       Vec<u8>,
	pub sha256:      ArtifactHash,
	pub byte_length: u64,
}

#[derive(serde::Serialize)]
struct GrepArtifactPayload<'a> {
	matches: &'a [GrepMatch],
}

/// Bounded regex line search: scan every regular, non-symlink,
/// non-binary-looking file under `root_path`.
///
/// Uses the bounded, deterministic walk (see [`super::find`] module docs)
/// for lines matching `pattern`, returning at most `max_matches` matches.
pub fn grep(
	root_path: &Path,
	pattern: &str,
	max_matches: usize,
) -> Result<GrepArtifactContent, GrepRejection> {
	let regex = Regex::new(pattern).map_err(|err| GrepRejection::InvalidPattern(err.to_string()))?;

	let walk = walk_workspace(root_path, DEFAULT_MAX_WALK_ENTRIES).map_err(map_walk_error)?;

	let mut matches = Vec::new();
	let mut truncated = walk.truncated;
	'files: for relative in &walk.relative_paths {
		// Reuse the C5 containment substrate exactly for the actual I/O
		// target, rather than trusting the walk's own bookkeeping (Dissent
		// ruling 3).
		let Ok(canonical) = walk.workspace_root.resolve(relative) else {
			continue;
		};
		// A candidate whose size exceeds the disclosed scan bound is
		// skipped exactly like a binary or unreadable file (consistent
		// silent-skip policy), rather than read in full.
		let Ok(metadata) = std::fs::metadata(&canonical) else {
			continue;
		};
		if metadata.len() > MAX_SCAN_FILE_BYTES {
			continue;
		}
		let Ok(bytes) = std::fs::read(&canonical) else {
			continue;
		};
		if looks_binary(&bytes) {
			continue;
		}
		let text = String::from_utf8_lossy(&bytes);
		for (line_index, line) in text.split('\n').enumerate() {
			if !regex.is_match(line) {
				continue;
			}
			if matches.len() >= max_matches {
				truncated = true;
				break 'files;
			}
			let (preview, preview_truncated) = truncate_preview(line);
			matches.push(GrepMatch {
				path: relative.clone(),
				line: (line_index + 1) as u64,
				preview,
				preview_truncated,
			});
		}
	}

	let payload = GrepArtifactPayload { matches: &matches };
	let bytes = serde_json::to_vec(&payload).expect("GrepArtifactPayload always serializes");
	let (sha256, byte_length) = compute_artifact_bytes(&bytes);

	Ok(GrepArtifactContent { matches, truncated, bytes, sha256, byte_length })
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use super::*;

	fn unique_temp_dir(label: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"successor-kernel-grep-{label}-{}-{}",
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
	fn grep_finds_line_matches_and_skips_binary_files() {
		let root_dir = unique_temp_dir("basic");
		std::fs::write(root_dir.join("a.txt"), b"first line\nneedle here\nlast line").unwrap();
		std::fs::write(root_dir.join("b.bin"), b"needle\0inside binary").unwrap();

		let result = grep(&root_dir, "needle", 10).unwrap();
		assert_eq!(result.matches, vec![GrepMatch {
			path:              "a.txt".to_string(),
			line:              2,
			preview:           "needle here".to_string(),
			preview_truncated: false,
		}]);
		assert!(!result.truncated);

		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn grep_truncates_long_match_preview_and_records_metadata() {
		let root_dir = unique_temp_dir("long-preview");
		// A 2-byte UTF-8 character (`é`) straddles the MAX_PREVIEW_BYTES (512)
		// boundary; truncation must stop one byte earlier, at the last
		// UTF-8 char boundary, rather than splitting the character in half.
		let mut line = "a".repeat(511);
		line.push('é');
		line.push_str("needle");
		std::fs::write(root_dir.join("a.txt"), line.as_bytes()).unwrap();

		let result = grep(&root_dir, "needle", 10).unwrap();
		assert_eq!(result.matches.len(), 1);
		let matched = &result.matches[0];
		assert!(matched.preview_truncated);
		assert_eq!(matched.preview, "a".repeat(511));
		assert!(matched.preview.len() <= MAX_PREVIEW_BYTES);

		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn grep_skips_oversize_file_without_error() {
		let root_dir = unique_temp_dir("oversize");
		let mut oversize_content = vec![b'a'; (MAX_SCAN_FILE_BYTES + 1) as usize];
		oversize_content[0..6].copy_from_slice(b"needle");
		std::fs::write(root_dir.join("big.txt"), &oversize_content).unwrap();
		std::fs::write(root_dir.join("small.txt"), b"needle here").unwrap();

		let result = grep(&root_dir, "needle", 10).unwrap();
		assert_eq!(result.matches, vec![GrepMatch {
			path:              "small.txt".to_string(),
			line:              1,
			preview:           "needle here".to_string(),
			preview_truncated: false,
		}]);
		assert!(!result.truncated);

		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn grep_rejects_invalid_regex_as_typed_input_error() {
		let root_dir = unique_temp_dir("bad-regex");
		let err = grep(&root_dir, "(", 10).unwrap_err();
		assert!(matches!(err, GrepRejection::InvalidPattern(_)));
		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn grep_rejects_missing_root() {
		let root_dir = unique_temp_dir("missing-root");
		std::fs::remove_dir_all(&root_dir).ok();
		let err = grep(&root_dir, "anything", 10).unwrap_err();
		assert_eq!(err, GrepRejection::RootNotFound);
	}
}
