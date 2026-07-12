//! Contract tests for the bounded `ast_grep` safe-read substrate.
//!
//! These tests consume only the public module surface. They also prove that the
//! tool remains a catalog stub until the later serial integration amendment.

use std::{
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use successor_kernel::tools::{
	ast_grep::{
		AstGrepArgs, AstGrepLanguage, AstGrepRejection, DEFAULT_LIMIT, MAX_LIMIT,
		MAX_RECEIPT_JSON_BYTES, MAX_SCAN_FILE_BYTES, MAX_SCANNED_FILES, PatternErrorKind, ast_grep,
	},
	catalog, registry,
};
use successor_protocol::{artifact::ArtifactHash, tool_catalog::ToolStatusV0};

struct TestDir(PathBuf);

impl std::ops::Deref for TestDir {
	type Target = Path;

	fn deref(&self) -> &Self::Target {
		&self.0
	}
}

impl AsRef<Path> for TestDir {
	fn as_ref(&self) -> &Path {
		&self.0
	}
}

impl Drop for TestDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

fn unique_temp_dir(label: &str) -> TestDir {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let id = COUNTER.fetch_add(1, Ordering::Relaxed);
	let dir = std::env::temp_dir().join(format!(
		"successor-kernel-ast-grep-{label}-{}-{}",
		std::process::id(),
		id
	));
	std::fs::create_dir_all(&dir).expect("create unique temp dir");
	TestDir(dir)
}

fn args(lang: AstGrepLanguage, pat: &[&str]) -> AstGrepArgs {
	AstGrepArgs {
		lang,
		pat: pat.iter().map(|s| (*s).to_owned()).collect(),
		path: ".".to_owned(),
		glob: None,
		sel: None,
		context: 0,
		limit: DEFAULT_LIMIT,
		offset: 0,
	}
}

// 1. DTO contract: `deny_unknown_fields`, the exact seven-language enum with no
//    aliases, and a constructible `schemars::JsonSchema`.
#[test]
fn ast_grep_args_dto_denies_unknown_fields_and_pins_the_exact_language_enum_with_no_aliases() {
	let schema = schemars::schema_for!(AstGrepArgs);
	let schema_json = serde_json::to_value(&schema).expect("schema serializes");
	assert!(schema_json.is_object(), "AstGrepArgs must expose a constructible JsonSchema");

	let with_unknown_field = serde_json::json!({
		"lang": "rust",
		"pat": ["fn $NAME() {}"],
		"unexpected_field": true,
	});
	let err = serde_json::from_value::<AstGrepArgs>(with_unknown_field).unwrap_err();
	assert!(err.to_string().contains("unknown field"), "got: {err}");

	for canonical in ["rust", "typescript", "tsx", "javascript", "python", "go", "json"] {
		let value = serde_json::json!({ "lang": canonical, "pat": ["x"] });
		serde_json::from_value::<AstGrepArgs>(value)
			.unwrap_or_else(|err| panic!("{canonical} must deserialize: {err}"));
	}
	for alias in ["ts", "js", "jsx", "py", "golang", "Rust", "RUST"] {
		let value = serde_json::json!({ "lang": alias, "pat": ["x"] });
		assert!(
			serde_json::from_value::<AstGrepArgs>(value).is_err(),
			"alias {alias} must not deserialize"
		);
	}
}

// 2. Single-language dispatch across all seven canonical languages; `.jsx` maps
//    to `javascript`; `.ts` and `.tsx` remain distinct extension sets.
#[test]
fn ast_grep_finds_matches_for_each_canonical_language_with_jsx_alias_and_ts_tsx_distinctness() {
	let dir = unique_temp_dir("languages");
	std::fs::write(dir.join("a.rs"), "fn one() {}\n").unwrap();
	std::fs::write(dir.join("a.py"), "def one():\n    pass\n").unwrap();
	std::fs::write(dir.join("a.go"), "func one() {}\n").unwrap();
	std::fs::write(dir.join("a.json"), "{\"name\": \"value\"}\n").unwrap();

	assert_eq!(
		ast_grep(&dir, &args(AstGrepLanguage::Rust, &["fn $NAME() {}"]))
			.unwrap()
			.matches
			.len(),
		1
	);
	assert_eq!(
		ast_grep(&dir, &args(AstGrepLanguage::Python, &["def $NAME(): pass"]))
			.unwrap()
			.matches
			.len(),
		1
	);
	assert_eq!(
		ast_grep(&dir, &args(AstGrepLanguage::Go, &["func $NAME() {}"]))
			.unwrap()
			.matches
			.len(),
		1
	);
	let json_result = ast_grep(&dir, &args(AstGrepLanguage::Json, &["{\"$KEY\": $VALUE}"])).unwrap();
	assert_eq!(json_result.matches.len(), 1);

	let ts_dir = unique_temp_dir("ts-tsx-jsx");
	std::fs::write(ts_dir.join("a.ts"), "const x = 1;\n").unwrap();
	std::fs::write(ts_dir.join("a.tsx"), "const y = 1;\n").unwrap();
	std::fs::write(ts_dir.join("a.js"), "const z = 1;\n").unwrap();
	std::fs::write(ts_dir.join("a.jsx"), "const w = 1;\n").unwrap();

	let ts_result =
		ast_grep(&ts_dir, &args(AstGrepLanguage::Typescript, &["const $NAME = 1;"])).unwrap();
	assert_eq!(
		ts_result
			.matches
			.iter()
			.map(|m| m.path.as_str())
			.collect::<Vec<_>>(),
		vec!["a.ts"]
	);

	let tsx_result = ast_grep(&ts_dir, &args(AstGrepLanguage::Tsx, &["const $NAME = 1;"])).unwrap();
	assert_eq!(
		tsx_result
			.matches
			.iter()
			.map(|m| m.path.as_str())
			.collect::<Vec<_>>(),
		vec!["a.tsx"]
	);

	let js_result =
		ast_grep(&ts_dir, &args(AstGrepLanguage::Javascript, &["const $NAME = 1;"])).unwrap();
	let mut js_paths: Vec<&str> = js_result.matches.iter().map(|m| m.path.as_str()).collect();
	js_paths.sort_unstable();
	assert_eq!(js_paths, vec!["a.js", "a.jsx"]);
}

// 3. Exact-path symlink rejection for both an in-root and an out-of-root
//    target, plus a directory scan's no-follow trap on a symlinked
//    subdirectory.
#[test]
#[cfg(unix)]
fn ast_grep_rejects_exact_symlinks_in_and_out_of_root_and_never_follows_symlinked_directories() {
	let dir = unique_temp_dir("symlink-traps");
	std::fs::write(dir.join("real.rs"), "fn real() {}\n").unwrap();
	std::os::unix::fs::symlink(dir.join("real.rs"), dir.join("in_root_link.rs")).unwrap();

	let mut in_root = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	in_root.path = "in_root_link.rs".to_owned();
	assert_eq!(ast_grep(&dir, &in_root).unwrap_err(), AstGrepRejection::SymlinkRejected);

	let outside_dir = unique_temp_dir("symlink-traps-outside");
	std::fs::write(outside_dir.join("secret.rs"), "fn secret() {}\n").unwrap();
	std::os::unix::fs::symlink(outside_dir.join("secret.rs"), dir.join("out_of_root_link.rs"))
		.unwrap();

	let mut out_of_root = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	out_of_root.path = "out_of_root_link.rs".to_owned();
	assert_eq!(ast_grep(&dir, &out_of_root).unwrap_err(), AstGrepRejection::SymlinkRejected);

	std::fs::create_dir_all(dir.join("real_dir")).unwrap();
	std::fs::write(dir.join("real_dir/nested.rs"), "fn nested() {}\n").unwrap();
	std::os::unix::fs::symlink(dir.join("real_dir"), dir.join("link_dir")).unwrap();

	// Nested-component trap: `link_dir` (created above) is a symlink, but the
	// final path component reached through it (`nested.rs`) is a regular
	// file. `symlink_metadata` on the fully-joined path transparently follows
	// symlinks in intermediate components (only the final component is left
	// unresolved), so a single final-component check would miss this.
	let mut nested_in_root = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	nested_in_root.path = "link_dir/nested.rs".to_owned();
	assert_eq!(
		ast_grep(&dir, &nested_in_root).unwrap_err(),
		AstGrepRejection::SymlinkRejected,
		"a symlinked intermediate directory component must be rejected even when the final path \
		 component is a regular file and its target is in-root"
	);

	std::os::unix::fs::symlink(&outside_dir, dir.join("link_dir_outside")).unwrap();
	let mut nested_out_of_root = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	nested_out_of_root.path = "link_dir_outside/secret.rs".to_owned();
	assert_eq!(
		ast_grep(&dir, &nested_out_of_root).unwrap_err(),
		AstGrepRejection::SymlinkRejected,
		"a symlinked intermediate directory component pointing outside root must be rejected"
	);

	let dir_result = ast_grep(&dir, &args(AstGrepLanguage::Rust, &["fn $NAME() {}"])).unwrap();
	let paths: Vec<&str> = dir_result.matches.iter().map(|m| m.path.as_str()).collect();
	assert_eq!(
		paths.iter().filter(|p| p.contains("nested.rs")).count(),
		1,
		"must not double-count via the symlinked dir"
	);
	assert!(
		!paths.iter().any(|p| p.starts_with("link_dir")),
		"must never traverse into a symlinked directory"
	);
}

// 4. Deterministic cross-file/cross-pattern ordering by (path, byte_start,
//    byte_end, pattern_index), including same-node duplicates: two different
//    patterns matching the identical AST node produce two records, ordered by
//    ascending pattern index at the tied byte range.
#[test]
fn ast_grep_orders_matches_deterministically_and_preserves_same_node_duplicates_across_patterns() {
	let dir = unique_temp_dir("global-order-and-duplicates");
	std::fs::write(dir.join("z.rs"), "fn z_fn() {}\n").unwrap();
	std::fs::write(dir.join("a.rs"), "struct A;\nfn a_fn() {}\n").unwrap();

	let result =
		ast_grep(&dir, &args(AstGrepLanguage::Rust, &["fn $NAME() {}", "struct $NAME;"])).unwrap();
	let paths: Vec<&str> = result.matches.iter().map(|m| m.path.as_str()).collect();
	assert_eq!(paths, vec!["a.rs", "a.rs", "z.rs"]);
	assert!(result.matches[0].byte_start < result.matches[1].byte_start);

	let dup_dir = unique_temp_dir("same-node-duplicate");
	std::fs::write(dup_dir.join("a.rs"), "fn foo() {}\n").unwrap();
	let dup_result =
		ast_grep(&dup_dir, &args(AstGrepLanguage::Rust, &["fn $NAME() {}", "fn foo() {}"])).unwrap();
	assert_eq!(dup_result.matches.len(), 2, "both patterns match the identical node");
	assert_eq!(dup_result.matches[0].byte_start, dup_result.matches[1].byte_start);
	assert_eq!(dup_result.matches[0].byte_end, dup_result.matches[1].byte_end);
	assert_eq!(dup_result.matches[0].pattern_index, 0);
	assert_eq!(dup_result.matches[1].pattern_index, 1);
}

// 5. Contextual selector success where the selector kind name is absent from
//    the context's literal text (matched by AST kind, not substring), plus a
//    typed, index-only failure for an invalid selector kind name.
#[test]
fn ast_grep_contextual_selector_matches_by_kind_and_reports_index_only_invalid_errors() {
	let dir = unique_temp_dir("contextual-selector");
	std::fs::write(dir.join("a.rs"), "const F: fn() -> i32 = || 1;\n").unwrap();

	let mut call = args(AstGrepLanguage::Rust, &["closure_expression"]);
	call.sel = Some("const F: fn() -> i32 = || 1;".to_owned());
	let result = ast_grep(&dir, &call).unwrap();
	assert_eq!(result.matches.len(), 1);
	assert!(
		!result.matches[0].preview.contains("closure_expression"),
		"selector kind name must not occur in the matched text"
	);

	let mut invalid = args(AstGrepLanguage::Rust, &["not_a_real_node_kind"]);
	invalid.sel = Some("const F: fn() -> i32 = || 1;".to_owned());
	let err = ast_grep(&dir, &invalid).unwrap_err();
	assert_eq!(err, AstGrepRejection::PatternCompileFailed {
		index: 0,
		kind:  PatternErrorKind::InvalidSelectorKind,
	});
}

// 6. Tolerant parse-error disclosure: a file with a syntax error still yields
//    whatever matches tree-sitter's error-tolerant tree contains (not a fatal
//    rejection), and the file is counted in `parse_error_files`.
#[test]
fn ast_grep_discloses_parse_errors_without_fatal_rejection() {
	let dir = unique_temp_dir("parse-error");
	std::fs::write(dir.join("broken.rs"), "fn ok() {}\nfn broken( {\n").unwrap();

	let result = ast_grep(&dir, &args(AstGrepLanguage::Rust, &["fn ok() {}"])).unwrap();
	assert_eq!(result.matches.len(), 1);
	assert_eq!(result.stats.parse_error_files, 1);

	// Missing-node-only construct: the parser recovers with a MISSING token
	// and produces no explicit ERROR node anywhere in the tree, so checking
	// `is_error()` alone would silently miss this class of parse error.
	let missing_dir = unique_temp_dir("parse-error-missing-node");
	std::fs::write(missing_dir.join("missing.rs"), "fn ok() {}\nfn missing_semi() { let x = 1\n}\n")
		.unwrap();
	let missing_result =
		ast_grep(&missing_dir, &args(AstGrepLanguage::Rust, &["fn ok() {}"])).unwrap();
	assert_eq!(missing_result.matches.len(), 1);
	assert_eq!(missing_result.stats.parse_error_files, 1);
}

// 7. Backslash glob normalization: a glob pattern spelled with `\` separators
//    still matches, and every output path uses `/`.
#[test]
fn ast_grep_normalizes_backslash_globs_and_emits_forward_slash_output_paths() {
	let dir = unique_temp_dir("backslash-glob");
	std::fs::create_dir_all(dir.join("subdir")).unwrap();
	std::fs::write(dir.join("subdir/a.rs"), "fn nested() {}\n").unwrap();
	std::fs::write(dir.join("top.rs"), "fn top() {}\n").unwrap();

	let mut call = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	call.glob = Some("subdir\\*.rs".to_owned());
	let result = ast_grep(&dir, &call).unwrap();
	assert_eq!(result.matches.len(), 1);
	assert_eq!(result.matches[0].path, "subdir/a.rs");
	assert!(!result.matches[0].path.contains('\\'));
}

// 8. Exact bad-file rejection vs directory skip counters: oversize, binary
//    (NUL-containing), and non-UTF-8 files are each skipped with an exact
//    counter during a directory scan, while an exact-file scan of the oversize
//    file rejects the whole call.
#[test]
fn ast_grep_directory_scan_skips_bad_files_with_exact_counters_but_exact_file_scan_rejects_them() {
	let dir = unique_temp_dir("bad-files");
	let oversize = "x".repeat((MAX_SCAN_FILE_BYTES + 1) as usize);
	std::fs::write(dir.join("big.rs"), &oversize).unwrap();
	std::fs::write(dir.join("binary.rs"), b"fn \0broken() {}\n").unwrap();
	std::fs::write(dir.join("invalid_utf8.rs"), [0x66u8, 0x6e, 0xff, 0xfe]).unwrap();
	std::fs::write(dir.join("small.rs"), "fn small() {}\n").unwrap();

	let dir_result = ast_grep(&dir, &args(AstGrepLanguage::Rust, &["fn $NAME() {}"])).unwrap();
	assert_eq!(dir_result.matches.len(), 1);
	assert_eq!(dir_result.matches[0].path, "small.rs");
	assert_eq!(dir_result.stats.skipped_files, 3);

	let mut exact = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	exact.path = "big.rs".to_owned();
	assert_eq!(ast_grep(&dir, &exact).unwrap_err(), AstGrepRejection::FileTooLarge);
}

// 9. `offset` beyond the number of matches yields an empty, non-error result,
//    and the `MAX_SCANNED_FILES` cap firing sets `truncated` with exact stats.
#[test]
fn ast_grep_offset_past_end_is_empty_and_scanned_files_cap_discloses_truncation() {
	let dir = unique_temp_dir("offset-past-end");
	std::fs::write(dir.join("a.rs"), "fn one() {}\n").unwrap();

	let mut call = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	call.offset = 50;
	let result = ast_grep(&dir, &call).unwrap();
	assert!(result.matches.is_empty());
	assert!(!result.truncated);

	let cap_dir = unique_temp_dir("scanned-files-cap");
	for index in 0..(MAX_SCANNED_FILES + 5) {
		std::fs::write(cap_dir.join(format!("f{index:05}.rs")), format!("fn f{index}() {{}}\n"))
			.unwrap();
	}
	let mut cap_call = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	cap_call.limit = MAX_LIMIT;
	let cap_result = ast_grep(&cap_dir, &cap_call).unwrap();
	assert_eq!(cap_result.stats.scanned_files, MAX_SCANNED_FILES);
	assert!(cap_result.truncated);
}

// 10. Full-window match tracking ceiling: matches are tracked up to `offset +
//     limit + 1`, not capped at some smaller constant before paging, so a match
//     far past the first 1000 is still reachable via `offset`/`limit` with an
//     exact, deterministic identity.
#[test]
fn ast_grep_tracks_matches_past_the_first_thousand_for_high_offset_paging() {
	let dir = unique_temp_dir("high-offset-tracking");
	let mut source = String::new();
	for i in 0..1500 {
		let _ = std::fmt::Write::write_fmt(&mut source, format_args!("fn f{i}() {{}}\n"));
	}
	std::fs::write(dir.join("a.rs"), &source).unwrap();

	let mut call = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	call.offset = 1000;
	call.limit = 1;
	let result = ast_grep(&dir, &call).unwrap();
	assert_eq!(result.matches.len(), 1);
	assert_eq!(result.matches[0].path, "a.rs");
	assert_eq!(result.matches[0].start_line, 1001, "the 1001st function, at offset 1000");
	assert!(result.matches[0].preview.contains("f1000"));
	assert!(result.truncated);
}

// 11. Global JSON receipt cap: many matches, each with long CRLF/multibyte/tab
//     context and previews individually within the per-match cap, still sum
//     past the 1 MiB receipt cap and get trimmed — a fact distinct from
//     `truncated` (which reflects offset/limit windowing, not the JSON cap).
//     The cap bounds the *complete* receipt (source/tool/lang/stats/truncation
//     plus matches), not the matches array alone, and `output_omitted`
//     discloses exactly how many otherwise-windowed records were dropped.
#[test]
fn ast_grep_bounds_the_serialized_receipt_independent_of_per_match_caps() {
	let dir = unique_temp_dir("receipt-cap");
	let long_comment = format!("// caf\u{00e9}\t{}\r\n", "z".repeat(600));
	let mut source = String::new();
	for i in 0..1000 {
		source.push_str(&long_comment);
		let _ = std::fmt::Write::write_fmt(&mut source, format_args!("fn f{i}() {{}}\r\n"));
		source.push_str(&long_comment);
	}
	std::fs::write(dir.join("a.rs"), &source).unwrap();

	let mut call = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	call.context = 5;
	call.limit = MAX_LIMIT;
	let result = ast_grep(&dir, &call).unwrap();
	assert!(result.bytes.len() <= MAX_RECEIPT_JSON_BYTES);
	assert!(result.output_omitted > 0);
	assert!(result.matches.len() < 1000);

	let pre_output_cap_window_size = 1000;
	assert_eq!(result.output_omitted + result.matches.len(), pre_output_cap_window_size);

	let wire: serde_json::Value = serde_json::from_slice(&result.bytes).unwrap();
	let wire_output_omitted = wire["output_omitted"]
		.as_u64()
		.expect("output_omitted must be present and numeric in the receipt JSON")
		as usize;
	assert_eq!(wire_output_omitted, result.output_omitted);
}

// 12. Exact artifact bytes/hash/length stability: identical input produces
//     byte-identical output, the hash matches `ArtifactHash::compute` over
//     those exact bytes, and the byte length matches the bytes' own length.
#[test]
fn ast_grep_artifact_bytes_hash_and_length_are_exact_and_stable_across_repeated_calls() {
	let dir = unique_temp_dir("artifact-stability");
	std::fs::write(dir.join("a.rs"), "fn one() {}\nfn two() {}\n").unwrap();

	let call = args(AstGrepLanguage::Rust, &["fn $NAME() {}"]);
	let first = ast_grep(&dir, &call).unwrap();
	let second = ast_grep(&dir, &call).unwrap();

	assert_eq!(first.bytes, second.bytes);
	assert_eq!(first.sha256, second.sha256);
	assert_eq!(first.sha256, ArtifactHash::compute(&first.bytes));
	assert_eq!(first.byte_length, first.bytes.len() as u64);
	serde_json::from_slice::<serde_json::Value>(&first.bytes)
		.expect("artifact bytes must be valid JSON");
}

// 13. Catalog/registry stub invariant: `ast_grep` is not among the executable
//     tools and is not dispatchable, exactly as before this lease's changes,
//     proving this lease did not silently wire it into the catalog/registry.
#[test]
fn ast_grep_remains_a_non_dispatchable_catalog_stub() {
	let registry = registry::slice0_registry();
	assert!(!registry.is_dispatchable("ast_grep"));
	assert_eq!(catalog::tool_status("ast_grep"), Some(ToolStatusV0::StubRejected));
}
