//! Lane C6 `KernelToolSearchFindGrep`: bounded lexical/filename search
//! (`search_files`).
//!
//! Disclosed relevance policy (contract §8.2: "No hidden semantic/vector
//! retrieval; lexical/filename/regex scoring is acceptable and must be
//! recorded in payload/trace" — recorded here, never presented as
//! fixture-pinned):
//! - `query` is split on ASCII whitespace into lowercase, non-empty terms. An
//!   empty query (no terms) yields a well-formed empty result, not an error.
//! - A candidate relative path is scored only if it contains at least one query
//!   term as a case-insensitive substring; candidates matching zero terms are
//!   excluded entirely (never returned with a zero score).
//! - `score = min(1.0, 0.85 * matched_terms / total_terms + phrase_bonus)`,
//!   where `phrase_bonus` is `0.15` if the whole query (lowercased, whitespace
//!   preserved) appears as a contiguous substring of the candidate path, else
//!   `0.0`. This is a simple, deterministic, filename/path-substring heuristic
//!   — not semantic/vector retrieval.
//! - Ranking is by score descending; a stable sort preserves the walk's
//!   lexicographic path order (see [`super::find`] module docs) as the
//!   tie-break for equal scores (Dissent ruling 4: disclosed, stable
//!   tie-break).
//! - `search_files` is a pure locator: it never reads file content, only the
//!   candidate's own relative-path string. The fixture-pinned result shape's
//!   `preview` field is therefore the same string as `path` — there is no
//!   content to preview.

use std::path::Path;

use successor_protocol::artifact::ArtifactHash;

use super::{
	compute_artifact_bytes,
	find::{DEFAULT_MAX_WALK_ENTRIES, DiscoveryWalkError, walk_workspace},
};

/// Typed rejection produced by [`search_files`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchFilesRejection {
	#[error("workspace root does not exist")]
	RootNotFound,
	#[error("permission denied")]
	PermissionDenied,
	#[error("workspace walk failed: {0}")]
	Io(String),
}

fn map_walk_error(err: DiscoveryWalkError) -> SearchFilesRejection {
	match err {
		DiscoveryWalkError::RootNotFound => SearchFilesRejection::RootNotFound,
		DiscoveryWalkError::PermissionDenied => SearchFilesRejection::PermissionDenied,
		DiscoveryWalkError::Io(message) => SearchFilesRejection::Io(message),
	}
}

/// One scored match from [`search_files`]. Field order matches the Slice 0
/// contract §8.2 fixture shape (`matches[{path, score, preview}]`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SearchMatch {
	pub path:    String,
	pub score:   f64,
	pub preview: String,
}

/// Artifact-backed content produced by a successful [`search_files`] call.
///
/// Mirrors [`super::read::ReadArtifactContent`]'s shape: typed content plus
/// raw bytes/hash/length for a later lane (the turn runner) to assign a
/// persisted artifact id and preview.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchFilesArtifactContent {
	pub matches:     Vec<SearchMatch>,
	pub truncated:   bool,
	pub bytes:       Vec<u8>,
	pub sha256:      ArtifactHash,
	pub byte_length: u64,
}

#[derive(serde::Serialize)]
struct SearchFilesArtifactPayload<'a> {
	matches: &'a [SearchMatch],
}

/// Bounded lexical/filename search: score every regular, non-symlink file
/// under `root_path`.
///
/// Uses the bounded, deterministic walk (see [`super::find`] module docs)
/// against `query`, and returns the top `max_matches` by score (stable
/// descending sort; ties keep the walk's lexicographic path order).
pub fn search_files(
	root_path: &Path,
	query: &str,
	max_matches: usize,
) -> Result<SearchFilesArtifactContent, SearchFilesRejection> {
	let terms: Vec<String> = query
		.split_ascii_whitespace()
		.map(str::to_ascii_lowercase)
		.collect();
	let query_lower = query.to_ascii_lowercase();

	let walk = walk_workspace(root_path, DEFAULT_MAX_WALK_ENTRIES).map_err(map_walk_error)?;

	let mut scored: Vec<SearchMatch> = Vec::new();
	if !terms.is_empty() {
		for relative in &walk.relative_paths {
			let relative_lower = relative.to_ascii_lowercase();
			let matched_terms = terms
				.iter()
				.filter(|term| relative_lower.contains(term.as_str()))
				.count();
			if matched_terms == 0 {
				continue;
			}
			let term_ratio = matched_terms as f64 / terms.len() as f64;
			let phrase_bonus = if relative_lower.contains(&query_lower) {
				0.15
			} else {
				0.0
			};
			let score = term_ratio.mul_add(0.85, phrase_bonus).min(1.0);
			scored.push(SearchMatch { path: relative.clone(), score, preview: relative.clone() });
		}
	}

	// Stable sort: descending score, ties keep the walk's lexicographic
	// path order (module docs — Dissent ruling 4 deterministic tie-break).
	scored.sort_by(|a, b| {
		b.score
			.partial_cmp(&a.score)
			.expect("scores are finite, never NaN")
	});

	let mut truncated = walk.truncated;
	if scored.len() > max_matches {
		truncated = true;
		scored.truncate(max_matches);
	}

	let payload = SearchFilesArtifactPayload { matches: &scored };
	let bytes = serde_json::to_vec(&payload).expect("SearchFilesArtifactPayload always serializes");
	let (sha256, byte_length) = compute_artifact_bytes(&bytes);

	Ok(SearchFilesArtifactContent { matches: scored, truncated, bytes, sha256, byte_length })
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use super::*;

	fn unique_temp_dir(label: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"successor-kernel-search-files-{label}-{}-{}",
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
	fn search_files_ranks_by_score_and_never_reads_content() {
		let root_dir = unique_temp_dir("basic");
		std::fs::create_dir_all(root_dir.join("docs")).unwrap();
		std::fs::create_dir_all(root_dir.join("notes")).unwrap();
		// Content is irrelevant to a locator tool: both files' content is the
		// opposite of what the query is expected to match, proving the score
		// comes from the path string alone.
		std::fs::write(root_dir.join("docs/concept graph.md"), b"UNRELATED CONTENT").unwrap();
		std::fs::write(root_dir.join("notes/concept-only.rs"), b"UNRELATED CONTENT").unwrap();

		let result = search_files(&root_dir, "concept graph", 10).unwrap();
		assert_eq!(result.matches.len(), 2);
		// The path containing the exact phrase (a literal space) ranks first.
		assert_eq!(result.matches[0].path, "docs/concept graph.md");
		assert_eq!(result.matches[0].preview, result.matches[0].path);
		assert!(result.matches[0].score > result.matches[1].score);
		assert_eq!(result.matches[1].path, "notes/concept-only.rs");
		assert!(result.matches[0].score > result.matches[1].score);

		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn search_files_empty_query_yields_well_formed_empty_result() {
		let root_dir = unique_temp_dir("empty-query");
		std::fs::write(root_dir.join("a.txt"), b"content").unwrap();

		let result = search_files(&root_dir, "   ", 10).unwrap();
		assert!(result.matches.is_empty());
		assert!(!result.truncated);

		std::fs::remove_dir_all(&root_dir).ok();
	}

	#[test]
	fn search_files_rejects_missing_root() {
		let root_dir = unique_temp_dir("missing-root");
		std::fs::remove_dir_all(&root_dir).ok();
		let err = search_files(&root_dir, "anything", 10).unwrap_err();
		assert_eq!(err, SearchFilesRejection::RootNotFound);
	}
}
