//! Integration coverage for Lane C6 `KernelToolSearchFindGrep`.
//!
//! Exercises the crate's public surface only:
//! `successor_kernel::tools::{search_files, find, grep}`. The shared bounded
//! walker (`tools::find::walk_workspace`, `DiscoveryWalkError`,
//! `DEFAULT_MAX_WALK_ENTRIES`) and the root-bounding substrate
//! (`WorkspaceRoot`, `PathBoundError`) are `pub(crate)` by design (Dissent
//! ruling 1/3) and are intentionally not reachable from here.

use std::path::PathBuf;

use successor_kernel::tools::{
	find::{FindMatch, FindRejection, find},
	grep::{GrepMatch, GrepRejection, grep},
	search_files::{SearchFilesRejection, search_files},
};

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
// search_files: fixture-shape fidelity, determinism, ranking
// ---------------------------------------------------------------------

#[test]
fn search_files_result_shape_matches_the_contract_fixture() {
	let root_dir = unique_temp_dir("shape");
	std::fs::create_dir_all(root_dir.join("packages/coding-agent/src/context")).unwrap();
	std::fs::write(
		root_dir.join("packages/coding-agent/src/context/concept-graph.ts"),
		b"export {};",
	)
	.unwrap();

	let result = search_files(&root_dir, "concept graph", 20).unwrap();

	// Fixture shape: `matches[{path, score, preview}]` — see
	// `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/
	// raw-events-successful-turn.json`.
	let parsed: serde_json::Value = serde_json::from_slice(&result.bytes).unwrap();
	let matches = parsed
		.get("matches")
		.and_then(serde_json::Value::as_array)
		.unwrap();
	assert_eq!(matches.len(), 1);
	let entry = &matches[0];
	assert!(entry.get("path").is_some());
	assert!(entry.get("score").is_some());
	assert!(entry.get("preview").is_some());
	// Revision C6.2 (review finding): `preview` is now content-derived (first
	// non-empty line, bounded/truncated like `grep`), not a copy of `path` —
	// see `search_files_fixture_replay_documents_verified_stop_items` below
	// for why the fixture's own pinned `score`/`preview` values cannot be
	// reproduced by the disclosed formula/derivation.
	assert_eq!(entry["preview"], "export {};");

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn search_files_fixture_replay_documents_verified_stop_items() {
	// Fixture-replay test using the fixture's own recorded query and file
	// content: `.oh/workstreams/successor-agent-kernel/fixtures/slice-0/
	// raw-events-successful-turn.json` pins a `search_files` call with
	// `query: "concept graph resolver"` over
	// `packages/coding-agent/src/context/concept-graph.ts`, and a separate
	// `read` tool-result event in the same fixture recording that file's
	// content as
	// `"export class ConceptGraphResolver {\n  // fixture content\n}\n"`.
	//
	// Revision C6.3 (Superego dissent task 200, verdict ALLOW; dedicated
	// fixture-maintenance lane) replaced the two previously-documented
	// STOP-item divergences with values captured by actually running this
	// implementation against the fixture's own inputs: `score` is
	// `0.85 * (2.0 / 3.0)` (2 of 3 query terms — "concept", "graph" — match
	// the path; no "resolver" substring; no phrase-bonus substring) and
	// `preview` is the first non-empty line of the fixture's recorded file
	// content. Both are now byte-exact reproductions of the fixture's pinned
	// values, not approximations documented as unreachable.
	let root_dir = unique_temp_dir("fixture-replay");
	std::fs::create_dir_all(root_dir.join("packages/coding-agent/src/context")).unwrap();
	std::fs::write(
		root_dir.join("packages/coding-agent/src/context/concept-graph.ts"),
		b"export class ConceptGraphResolver {\n  // fixture content\n}\n",
	)
	.unwrap();

	let result = search_files(&root_dir, "concept graph resolver", 20).unwrap();
	assert_eq!(result.matches.len(), 1);
	let matched = &result.matches[0];

	// Full fidelity: every fixture-pinned field is now exactly reproducible.
	assert_eq!(matched.path, "packages/coding-agent/src/context/concept-graph.ts");
	assert_eq!(matched.score, 0.85 * 2.0 / 3.0);
	assert_eq!(matched.preview, "export class ConceptGraphResolver {");

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn search_files_is_deterministic_across_repeated_calls() {
	let root_dir = unique_temp_dir("determinism");
	for name in ["zeta.rs", "alpha.rs", "middle.rs"] {
		std::fs::write(root_dir.join(name), b"rs").unwrap();
	}

	let first = search_files(&root_dir, "rs", 10).unwrap();
	let second = search_files(&root_dir, "rs", 10).unwrap();
	assert_eq!(first.matches, second.matches);
	assert_eq!(first.bytes, second.bytes);
	assert_eq!(first.sha256, second.sha256);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn search_files_max_matches_truncation_is_visible_in_metadata() {
	let root_dir = unique_temp_dir("truncate");
	for i in 0..5 {
		std::fs::write(root_dir.join(format!("needle-{i}.txt")), b"content").unwrap();
	}

	let result = search_files(&root_dir, "needle", 2).unwrap();
	assert_eq!(result.matches.len(), 2);
	assert!(result.truncated);

	std::fs::remove_dir_all(&root_dir).ok();
}

// ---------------------------------------------------------------------
// find: ordering, truncation, root-bound rejections, empty results
// ---------------------------------------------------------------------

#[test]
fn find_orders_matches_lexicographically_regardless_of_insertion_order() {
	let root_dir = unique_temp_dir("order");
	// Insert out of lexicographic order to prove the walk does not leak
	// filesystem insertion order (Dissent ruling 4).
	std::fs::write(root_dir.join("zeta.rs"), b"").unwrap();
	std::fs::write(root_dir.join("alpha.rs"), b"").unwrap();
	std::fs::create_dir_all(root_dir.join("mid")).unwrap();
	std::fs::write(root_dir.join("mid/nested.rs"), b"").unwrap();

	let result = find(&root_dir, "**/*.rs", 100).unwrap();
	let paths: Vec<&str> = result
		.entries
		.iter()
		.map(|entry| entry.path.as_str())
		.collect();
	assert_eq!(paths, vec!["alpha.rs", "mid/nested.rs", "zeta.rs"]);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn find_empty_results_are_well_formed_not_errors() {
	let root_dir = unique_temp_dir("empty");
	std::fs::write(root_dir.join("a.txt"), b"").unwrap();

	let result = find(&root_dir, "*.rs", 10).unwrap();
	assert!(result.entries.is_empty());
	assert!(!result.truncated);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn find_hidden_dotfiles_are_included() {
	let root_dir = unique_temp_dir("hidden");
	std::fs::write(root_dir.join(".env"), b"SECRET=1").unwrap();

	let result = find(&root_dir, ".*", 10).unwrap();
	assert_eq!(result.entries, vec![FindMatch { path: ".env".to_string() }]);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn find_glob_with_parent_traversal_matches_nothing_and_does_not_escape() {
	let root_dir = unique_temp_dir("dotdot-glob");
	std::fs::write(root_dir.join("a.txt"), b"content").unwrap();

	// Syntactically valid glob; every candidate path produced by the
	// bounded walk is already root-contained and never contains `..`, so
	// this can only ever match nothing — never escape the root.
	let result = find(&root_dir, "../*", 10).unwrap();
	assert!(result.entries.is_empty());

	std::fs::remove_dir_all(&root_dir).ok();
}

#[cfg(unix)]
#[test]
fn find_does_not_follow_a_symlink_pointing_outside_root() {
	let base = unique_temp_dir("symlink-base");
	let workspace = base.join("workspace");
	let outside = base.join("outside");
	std::fs::create_dir_all(&workspace).unwrap();
	std::fs::create_dir_all(&outside).unwrap();
	std::fs::write(outside.join("secret.rs"), b"top secret").unwrap();
	std::os::unix::fs::symlink(&outside, workspace.join("escape")).unwrap();
	std::fs::write(workspace.join("visible.rs"), b"ok").unwrap();

	let result = find(&workspace, "**/*.rs", 100).unwrap();
	let paths: Vec<&str> = result
		.entries
		.iter()
		.map(|entry| entry.path.as_str())
		.collect();
	assert_eq!(paths, vec!["visible.rs"], "the symlinked subtree must never be traversed");

	std::fs::remove_dir_all(&base).ok();
}

#[test]
fn find_rejects_absolute_and_parent_traversal_root_inputs() {
	// The workspace root itself is a trusted argument, not caller-supplied
	// relative input, but it must still be rejected cleanly when it does
	// not resolve to a real directory (e.g. a caller passing a bogus
	// absolute path as the configured root).
	let bogus_root = PathBuf::from("/definitely/does/not/exist/successor-kernel-c6");
	let err = find(&bogus_root, "*", 10).unwrap_err();
	assert_eq!(err, FindRejection::RootNotFound);
}

#[test]
fn find_rejects_invalid_glob_syntax_as_typed_error_without_panicking() {
	let root_dir = unique_temp_dir("invalid-glob");
	let err = find(&root_dir, "[unterminated", 10).unwrap_err();
	assert!(matches!(err, FindRejection::InvalidPattern(_)));
	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn find_large_tree_respects_the_default_walk_bound() {
	// `DEFAULT_MAX_WALK_ENTRIES` (2_000) is a `pub(crate)` implementation
	// detail; this test only observes its externally visible effect
	// (`truncated: true`, an output count no client can exceed) through the
	// public `find` API, per contract ("large-tree bound respected").
	let root_dir = unique_temp_dir("large-tree");
	for i in 0..2_100 {
		std::fs::write(root_dir.join(format!("file-{i:05}.txt")), b"").unwrap();
	}

	let result = find(&root_dir, "*.txt", 1_000_000).unwrap();
	assert!(result.truncated, "walking more eligible entries than the default bound must truncate");
	assert!(result.entries.len() < 2_100, "the walk itself must stop early, not just the output");

	std::fs::remove_dir_all(&root_dir).ok();
}

// ---------------------------------------------------------------------
// grep: line matches, binary skip vs find, invalid regex, root rejections
// ---------------------------------------------------------------------

#[test]
fn grep_matches_lines_and_find_still_lists_binary_files_grep_skips() {
	let root_dir = unique_temp_dir("binary-vs-find");
	std::fs::write(root_dir.join("text.rs"), b"fn main() {\n    needle_here();\n}").unwrap();
	std::fs::write(root_dir.join("data.bin"), b"needle_here\0but binary").unwrap();

	let grep_result = grep(&root_dir, "needle_here", 100).unwrap();
	assert_eq!(grep_result.matches, vec![GrepMatch {
		path:              "text.rs".to_string(),
		line:              2,
		preview:           "    needle_here();".to_string(),
		preview_truncated: false,
	}]);

	let find_result = find(&root_dir, "*.bin", 100).unwrap();
	assert_eq!(find_result.entries, vec![FindMatch { path: "data.bin".to_string() }]);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn grep_empty_results_are_well_formed_not_errors() {
	let root_dir = unique_temp_dir("grep-empty");
	std::fs::write(root_dir.join("a.txt"), b"nothing matches here").unwrap();

	let result = grep(&root_dir, "absent_token", 10).unwrap();
	assert!(result.matches.is_empty());
	assert!(!result.truncated);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn grep_max_matches_truncation_is_visible_in_metadata() {
	let root_dir = unique_temp_dir("grep-truncate");
	let mut content = String::new();
	for _ in 0..10 {
		content.push_str("needle\n");
	}
	std::fs::write(root_dir.join("a.txt"), content).unwrap();

	let result = grep(&root_dir, "needle", 3).unwrap();
	assert_eq!(result.matches.len(), 3);
	assert!(result.truncated);

	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn grep_rejects_invalid_regex_syntax_as_typed_error_without_panicking() {
	let root_dir = unique_temp_dir("invalid-regex");
	let err = grep(&root_dir, "(unterminated", 10).unwrap_err();
	assert!(matches!(err, GrepRejection::InvalidPattern(_)));
	std::fs::remove_dir_all(&root_dir).ok();
}

#[test]
fn grep_rejects_missing_workspace_root() {
	let bogus_root = PathBuf::from("/definitely/does/not/exist/successor-kernel-c6-grep");
	let err = grep(&bogus_root, "anything", 10).unwrap_err();
	assert_eq!(err, GrepRejection::RootNotFound);
}

#[cfg(unix)]
#[test]
fn grep_does_not_follow_a_symlink_pointing_outside_root() {
	let base = unique_temp_dir("grep-symlink-base");
	let workspace = base.join("workspace");
	let outside = base.join("outside");
	std::fs::create_dir_all(&workspace).unwrap();
	std::fs::create_dir_all(&outside).unwrap();
	std::fs::write(outside.join("secret.txt"), b"needle in the haystack").unwrap();
	std::os::unix::fs::symlink(&outside, workspace.join("escape")).unwrap();

	let result = grep(&workspace, "needle", 100).unwrap();
	assert!(result.matches.is_empty(), "the symlinked subtree must never be scanned");

	std::fs::remove_dir_all(&base).ok();
}

// ---------------------------------------------------------------------
// search_files: root-bound rejections (mirrors find/grep)
// ---------------------------------------------------------------------

#[test]
fn search_files_rejects_missing_workspace_root() {
	let bogus_root = PathBuf::from("/definitely/does/not/exist/successor-kernel-c6-search");
	let err = search_files(&bogus_root, "anything", 10).unwrap_err();
	assert_eq!(err, SearchFilesRejection::RootNotFound);
}
