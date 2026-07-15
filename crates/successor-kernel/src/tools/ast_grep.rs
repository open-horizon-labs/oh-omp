//! Bounded ast-grep structural search over a single caller-declared language.
//!
//! The parser dependencies are pinned to `0.39.9` to remain compatible with the
//! workspace's single tree-sitter `0.25` native-library resolution. Parsing is
//! fully in-process and this module owns its language mapping and safety
//! bounds.
//!
//! `ast_grep` is a catalog executable in the `safe_read` authority class. The
//! pinned native parser stack can stall when independent parses run
//! concurrently, so this module serializes only the `ast_grep` execution
//! boundary. Other tools and the rest of the kernel remain concurrent.
//!
//! Authority class: `safe_read` only. No subprocess, environment lookup,
//! network access, or persistent cache; every parse happens in-process against
//! bytes this module itself reads. Symlinks are never followed: an exact `path`
//! argument is a typed rejection if any lexical path component (not only the
//! final one) is a symlink, even when the symlink's target is inside the
//! workspace root, and directory scans use the same symlink-free walk as
//! [`super::find`]/[`super::grep`].
//!
//! Disclosed scanning policy, mirroring [`super::grep`]'s disclosed policy:
//! - `path` resolving to a directory scans every file under it (via
//!   [`super::find::walk_workspace`]) whose extension matches `lang`'s
//!   canonical extension set; a bad file (oversize, binary-looking, or invalid
//!   UTF-8) is skipped with an exact counter, never a rejection.
//! - `path` resolving to a single file is an exact-file scan: `lang` is used to
//!   parse it regardless of whether its extension matches, and any of the above
//!   defects (plus a non-regular-file target) reject the whole call.
//! - Every `pat` entry (and, if present, `sel`) is compiled once, up front,
//!   before any file is scanned; a compile failure rejects the whole call with
//!   a typed, index-only diagnostic that never echoes pattern, selector, or
//!   source text.
//! - With no `sel`, each `pat[i]` is an ordinary ast-grep pattern
//!   (`Pattern::try_new`). With `sel`, `sel` supplies the contextual parse
//!   context and each `pat[i]` is the node-kind selector extracted from it
//!   (`Pattern::contextual(sel, pat[i], lang)` — the selector need not occur
//!   anywhere in `sel`'s literal text, since it selects by AST kind, not by
//!   substring).
//! - Matches are ordered deterministically by (workspace-relative path, byte
//!   start, byte end, pattern index); `offset`/`limit` are applied only after
//!   this global order is established. Because the underlying walk already
//!   visits files in non-decreasing relative-path order and each file's own
//!   matches are sorted before being appended, the scan can stop as soon as it
//!   has proven the first `offset + limit + 1` matches in that order — any
//!   match found afterwards is provably not earlier in the order than what was
//!   already retained.
//! - Caps: at most [`MAX_WALK_ENTRIES`] walk entries, [`MAX_SCANNED_FILES`]
//!   source files, [`MAX_SCAN_FILE_BYTES`] bytes per file,
//!   [`MAX_TOTAL_SOURCE_BYTES`] bytes of source read in total, and
//!   [`MAX_TRACKED_MATCHES`] matches ever buffered in memory. Hitting any of
//!   these caps before the deterministic order is fully proven for the
//!   requested window forces `truncated = true`, since completeness can no
//!   longer be proven.
//! - The serialized receipt is bounded to [`MAX_RECEIPT_JSON_BYTES`]: this cap
//!   applies to the complete receipt JSON (source/tool/lang/stats/truncation
//!   metadata plus matches), not the matches array alone. Trailing match
//!   records are dropped, deterministically, until the full receipt fits, and
//!   `output_omitted` discloses the exact count of records dropped solely for
//!   this reason (zero when none were dropped) — a distinct fact from
//!   `truncated`, which reflects `offset`/`limit` windowing over the full match
//!   set.
//! - Calls are serialized at this module's public execution boundary because
//!   the pinned native parser stack does not complete reliably under concurrent
//!   parses.

use std::{path::Path, sync::Mutex};

use ast_grep_core::{Language as CoreLanguage, Pattern, PatternError, tree_sitter::LanguageExt};
use ast_grep_language::{Go, JavaScript, Json, Python, Rust, Tsx, TypeScript};
use successor_protocol::artifact::ArtifactHash;

use super::{
	PathBoundError, WorkspaceRoot, compute_artifact_bytes,
	find::{DEFAULT_MAX_WALK_ENTRIES, DiscoveryWalkError, walk_workspace},
	grep::truncate_preview,
	looks_binary,
};

/// Minimum number of `pat` entries a call must supply.
pub const MIN_PATTERNS: usize = 1;
/// Maximum number of `pat` entries a call may supply.
pub const MAX_PATTERNS: usize = 8;
/// Maximum byte length of a single `pat` entry.
pub const MAX_PATTERN_BYTES: usize = 4096;
/// Maximum byte length of `sel`.
pub const MAX_SELECTOR_BYTES: usize = 1024;
/// Maximum byte length of `glob`.
pub const MAX_GLOB_BYTES: usize = 4096;
/// Maximum number of context lines on each side of a match.
pub const MAX_CONTEXT_LINES: u8 = 5;
/// Default `limit` when the caller omits it.
pub const DEFAULT_LIMIT: u32 = 100;
/// Maximum `limit` a call may request.
pub const MAX_LIMIT: u32 = 1_000;
/// Maximum `offset` a call may request.
pub const MAX_OFFSET: u32 = 100_000;
/// Maximum number of walk entries visited during a directory scan (matches
/// [`DEFAULT_MAX_WALK_ENTRIES`] exactly; kept as a distinct, documented
/// constant so this module's cap is legible on its own).
pub const MAX_WALK_ENTRIES: usize = DEFAULT_MAX_WALK_ENTRIES;
/// Maximum number of source files a single directory scan will read and parse.
pub const MAX_SCANNED_FILES: usize = 1_000;
/// Maximum byte length of a single file this module will read and parse.
pub const MAX_SCAN_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Maximum total bytes of source this module will read and parse across every
/// file in a single directory scan.
pub const MAX_TOTAL_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum number of matches ever buffered in memory at once. The ceiling
/// covers the largest accepted `offset + limit` window plus one truncation
/// sentinel.
pub const MAX_TRACKED_MATCHES: usize = 101_001;
/// Maximum byte length of the serialized receipt payload.
pub const MAX_RECEIPT_JSON_BYTES: usize = 1024 * 1024;
/// Serializes the pinned native parser stack while keeping the rest of the
/// kernel concurrent.
static AST_GREP_EXECUTION_LOCK: Mutex<()> = Mutex::new(());

/// The seven languages this lease supports. No aliases: a caller must spell the
/// canonical name exactly (e.g. `"typescript"`, not `"ts"`).
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AstGrepLanguage {
	Rust,
	Typescript,
	Tsx,
	Javascript,
	Python,
	Go,
	Json,
}

impl AstGrepLanguage {
	/// Canonical, lowercase, no-dot extensions scanned for this language during
	/// a directory scan. `.jsx` maps to [`AstGrepLanguage::Javascript`]; `.ts`
	/// and `.tsx` remain distinct (typescript never matches a `.tsx` file and
	/// vice versa).
	const fn extensions(self) -> &'static [&'static str] {
		match self {
			Self::Rust => &["rs"],
			Self::Typescript => &["ts", "mts", "cts"],
			Self::Tsx => &["tsx"],
			Self::Javascript => &["js", "mjs", "cjs", "jsx"],
			Self::Python => &["py", "pyi"],
			Self::Go => &["go"],
			Self::Json => &["json"],
		}
	}

	fn matches_extension(self, relative: &str) -> bool {
		let Some(ext) = relative.rsplit('.').next().filter(|ext| *ext != relative) else {
			return false;
		};
		self
			.extensions()
			.iter()
			.any(|candidate| candidate.eq_ignore_ascii_case(ext))
	}
}

/// Coarse, redaction-safe classification of an [`ast_grep_core::PatternError`].
/// Deliberately carries no pattern, selector, or source text: only which of the
/// five upstream failure shapes occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PatternErrorKind {
	/// The pattern text failed to parse under `lang`'s grammar.
	ParseFailed,
	/// The pattern parsed to no AST root at all.
	NoAstRoot,
	/// The pattern parsed to more than one top-level AST node.
	MultipleAstRoots,
	/// `sel`'s selector kind name is not a valid node kind for `lang`.
	InvalidSelectorKind,
	/// `sel`'s selector kind name does not occur anywhere in the contextual
	/// parse.
	SelectorNotFoundInContext,
}

impl std::fmt::Display for PatternErrorKind {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let label = match self {
			Self::ParseFailed => "parse_failed",
			Self::NoAstRoot => "no_ast_root",
			Self::MultipleAstRoots => "multiple_ast_roots",
			Self::InvalidSelectorKind => "invalid_selector_kind",
			Self::SelectorNotFoundInContext => "selector_not_found_in_context",
		};
		f.write_str(label)
	}
}

const fn classify_pattern_error(err: &PatternError) -> PatternErrorKind {
	match err {
		PatternError::Parse(_) => PatternErrorKind::ParseFailed,
		PatternError::NoContent(_) => PatternErrorKind::NoAstRoot,
		PatternError::MultipleNode(_) => PatternErrorKind::MultipleAstRoots,
		PatternError::InvalidKind(_) => PatternErrorKind::InvalidSelectorKind,
		PatternError::NoSelectorInContext { .. } => PatternErrorKind::SelectorNotFoundInContext,
	}
}

/// Typed rejection produced by [`ast_grep`]. Deterministic and redaction-safe:
/// no variant carries pattern text, selector text, source content, or absolute
/// paths.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AstGrepRejection {
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
	#[error("path is a symlink; ast_grep never follows symlinks")]
	SymlinkRejected,
	#[error("path is neither a regular file nor a directory")]
	NotAFileOrDirectory,
	#[error("file looks binary (contains a NUL byte)")]
	BinaryLooking,
	#[error("file is not valid UTF-8")]
	InvalidUtf8,
	#[error("file exceeds the per-file scan size limit")]
	FileTooLarge,
	#[error("glob pattern is invalid: {0}")]
	InvalidGlob(String),
	#[error("glob exceeds the glob byte limit")]
	GlobTooLarge,
	#[error("glob must not contain a NUL byte")]
	GlobContainsNul,
	#[error("pat must contain between 1 and 8 entries")]
	PatternCountOutOfBounds,
	#[error("pat[{0}] must not be empty")]
	EmptyPattern(usize),
	#[error("pat[{index}] exceeds the per-pattern byte limit")]
	PatternTooLarge { index: usize },
	#[error("sel exceeds the selector byte limit")]
	SelectorTooLarge,
	#[error("context must be between 0 and 5")]
	ContextOutOfBounds,
	#[error("limit must be between 1 and 1000")]
	LimitOutOfBounds,
	#[error("offset must be at most 100000")]
	OffsetOutOfBounds,
	#[error("pat[{index}] failed to compile: {kind}")]
	PatternCompileFailed { index: usize, kind: PatternErrorKind },
	#[error("workspace walk failed: {0}")]
	Io(String),
}

fn map_path_bound(err: PathBoundError) -> AstGrepRejection {
	match err {
		PathBoundError::RootNotFound => AstGrepRejection::RootNotFound,
		PathBoundError::AbsolutePath => AstGrepRejection::AbsolutePath,
		PathBoundError::ParentTraversal => AstGrepRejection::ParentTraversal,
		PathBoundError::NotFound => AstGrepRejection::NotFound,
		PathBoundError::OutOfRoot => AstGrepRejection::OutOfRoot,
		PathBoundError::PermissionDenied => AstGrepRejection::PermissionDenied,
		PathBoundError::Io(message) => AstGrepRejection::Io(message),
	}
}

fn map_walk_error(err: DiscoveryWalkError) -> AstGrepRejection {
	match err {
		DiscoveryWalkError::RootNotFound => AstGrepRejection::RootNotFound,
		DiscoveryWalkError::PermissionDenied => AstGrepRejection::PermissionDenied,
		DiscoveryWalkError::Io(message) => AstGrepRejection::Io(message),
	}
}

/// One structural match from [`ast_grep`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AstGrepMatch {
	pub path:                     String,
	pub pattern_index:            usize,
	pub byte_start:               usize,
	pub byte_end:                 usize,
	pub start_line:               u64,
	pub end_line:                 u64,
	pub start_byte_column:        usize,
	pub end_byte_column:          usize,
	pub preview:                  String,
	pub preview_truncated:        bool,
	pub context_before:           Vec<String>,
	pub context_before_truncated: Vec<bool>,
	pub context_after:            Vec<String>,
	pub context_after_truncated:  Vec<bool>,
}

/// Disclosed, exact scan statistics for a single [`ast_grep`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct AstGrepStats {
	pub walked_entries:     usize,
	pub scanned_files:      usize,
	pub skipped_files:      usize,
	pub parse_error_files:  usize,
	pub total_source_bytes: u64,
}

/// Artifact-backed content produced by a successful [`ast_grep`] call.
///
/// Mirrors [`super::grep::GrepArtifactContent`]'s shape: typed content plus
/// raw bytes/hash/length for a later lane to assign a persisted artifact id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstGrepArtifactContent {
	pub lang:           AstGrepLanguage,
	pub matches:        Vec<AstGrepMatch>,
	pub stats:          AstGrepStats,
	pub truncated:      bool,
	pub output_omitted: usize,
	pub bytes:          Vec<u8>,
	pub sha256:         ArtifactHash,
	pub byte_length:    u64,
}

#[derive(serde::Serialize)]
struct AstGrepArtifactPayload<'a> {
	source_kind:    &'static str,
	tool_name:      &'static str,
	lang:           AstGrepLanguage,
	matches:        &'a [AstGrepMatch],
	stats:          AstGrepStats,
	truncated:      bool,
	output_omitted: usize,
}

/// Arguments for the `ast_grep` tool: bounded ast-grep-pattern structural
/// search scoped to a single caller-declared language per call.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AstGrepArgs {
	/// The single language every `pat` (and `sel`, if present) is compiled and
	/// every scanned file is parsed against.
	pub lang:    AstGrepLanguage,
	/// 1 to 8 ast-grep pattern strings (or, with `sel` present, node-kind
	/// selectors), each at most 4096 bytes.
	pub pat:     Vec<String>,
	/// Workspace-relative file or directory to scan. Defaults to `.`.
	#[serde(default = "AstGrepArgs::default_path")]
	pub path:    String,
	/// Optional glob restricting a directory scan's candidate files.
	#[serde(default)]
	pub glob:    Option<String>,
	/// Optional contextual-pattern parse context. When present, each `pat[i]` is
	/// a node-kind selector extracted from this context rather than an ordinary
	/// ast-grep pattern.
	#[serde(default)]
	pub sel:     Option<String>,
	/// Number of source lines of context to include on each side of a match (0
	/// to 5). Defaults to 0.
	#[serde(default)]
	pub context: u8,
	/// Maximum number of matches to return (1 to 1000). Defaults to 100.
	#[serde(default = "AstGrepArgs::default_limit")]
	pub limit:   u32,
	/// Number of leading matches (in the deterministic order) to skip before
	/// `limit` is applied. At most 100000. Defaults to 0.
	#[serde(default)]
	pub offset:  u32,
}

impl AstGrepArgs {
	fn default_path() -> String {
		".".to_owned()
	}

	const fn default_limit() -> u32 {
		DEFAULT_LIMIT
	}

	fn validate(&self) -> Result<(), AstGrepRejection> {
		if self.pat.len() < MIN_PATTERNS || self.pat.len() > MAX_PATTERNS {
			return Err(AstGrepRejection::PatternCountOutOfBounds);
		}
		for (index, pat) in self.pat.iter().enumerate() {
			if pat.is_empty() {
				return Err(AstGrepRejection::EmptyPattern(index));
			}
			if pat.len() > MAX_PATTERN_BYTES {
				return Err(AstGrepRejection::PatternTooLarge { index });
			}
		}
		if let Some(sel) = &self.sel
			&& sel.len() > MAX_SELECTOR_BYTES
		{
			return Err(AstGrepRejection::SelectorTooLarge);
		}
		if self.context > MAX_CONTEXT_LINES {
			return Err(AstGrepRejection::ContextOutOfBounds);
		}
		if self.limit == 0 || self.limit > MAX_LIMIT {
			return Err(AstGrepRejection::LimitOutOfBounds);
		}
		if self.offset > MAX_OFFSET {
			return Err(AstGrepRejection::OffsetOutOfBounds);
		}
		Ok(())
	}
}

/// Validates `glob` (bounded, NUL-free) and normalizes any backslash path
/// separator to `/` so glob matching is platform-independent and always keyed
/// against the `/`-normalized relative paths this module produces.
fn normalize_glob(glob: &str) -> Result<String, AstGrepRejection> {
	if glob.len() > MAX_GLOB_BYTES {
		return Err(AstGrepRejection::GlobTooLarge);
	}
	if glob.contains('\0') {
		return Err(AstGrepRejection::GlobContainsNul);
	}
	Ok(glob.replace('\\', "/"))
}

/// Compiles every `pat` entry (and, with `sel`, every selector) against `lang`,
/// returning them in `pat` order. A failure identifies the offending index and
/// a redaction-safe [`PatternErrorKind`], never pattern/selector/source text.
fn compile_patterns<L: CoreLanguage + Clone>(
	pat: &[String],
	sel: Option<&str>,
	lang: &L,
) -> Result<Vec<Pattern>, AstGrepRejection> {
	pat.iter()
		.enumerate()
		.map(|(index, entry)| {
			let compiled = match sel {
				Some(context) => Pattern::contextual(context, entry, lang.clone()),
				None => Pattern::try_new(entry, lang.clone()),
			};
			compiled.map_err(|err| AstGrepRejection::PatternCompileFailed {
				index,
				kind: classify_pattern_error(&err),
			})
		})
		.collect()
}

struct RawMatch {
	pattern_index:     usize,
	byte_start:        usize,
	byte_end:          usize,
	start_line:        u64,
	end_line:          u64,
	start_column:      usize,
	end_column:        usize,
	preview:           String,
	preview_truncated: bool,
}

/// Parses `source` under `lang`, finds every `patterns[i]` match, and returns
/// them sorted by `(byte_start, byte_end, pattern_index)`, capped at
/// `remaining_capacity` per pattern (safe because DFS pre-order visits a
/// well-formed AST's nodes in non-decreasing byte-start order, so the first `n`
/// matches of any single pattern in iteration order are exactly that pattern's
/// `n` earliest-starting matches; the true global top-`remaining_capacity`
/// prefix can therefore never omit a match that ranked within it, since no
/// single pattern could contribute more than `remaining_capacity` matches to
/// that prefix). Also reports whether the parse tree contains any tree-sitter
/// `ERROR` node.
fn scan_source<L: LanguageExt + Clone>(
	lang: &L,
	source: &str,
	patterns: &[Pattern],
	remaining_capacity: usize,
) -> (Vec<RawMatch>, bool) {
	let doc = lang.ast_grep(source);
	let root = doc.root();
	let has_parse_error = root.dfs().any(|node| node.is_error() || node.is_missing());

	let mut raw = Vec::new();
	for (pattern_index, pattern) in patterns.iter().enumerate() {
		for node_match in root.find_all(pattern).take(remaining_capacity) {
			let node = node_match.get_node();
			let range = node.range();
			let start = node.start_pos();
			let end = node.end_pos();
			let (preview, preview_truncated) = truncate_preview(&node.text());
			raw.push(RawMatch {
				pattern_index,
				byte_start: range.start,
				byte_end: range.end,
				start_line: start.line() as u64 + 1,
				end_line: end.line() as u64 + 1,
				start_column: start.byte_point().1,
				end_column: end.byte_point().1,
				preview,
				preview_truncated,
			});
		}
	}
	raw.sort_by(|a, b| {
		(a.byte_start, a.byte_end, a.pattern_index).cmp(&(b.byte_start, b.byte_end, b.pattern_index))
	});
	raw.truncate(remaining_capacity);
	(raw, has_parse_error)
}

/// Extracts up to `context` lines of `source` before/after the 1-based,
/// inclusive `[start_line, end_line]` span, terminator-stripped (CRLF counts as
/// one ending, tabs preserved), each capped at [`MAX_PREVIEW_BYTES`] bytes.
fn context_lines(
	lines: &[&str],
	start_line: u64,
	end_line: u64,
	context: u8,
) -> (Vec<String>, Vec<bool>, Vec<String>, Vec<bool>) {
	let context = context as u64;
	let start_index = start_line.saturating_sub(1);
	let end_index = end_line.saturating_sub(1);

	let before_start = start_index.saturating_sub(context);
	let mut before = Vec::new();
	let mut before_truncated = Vec::new();
	for index in before_start..start_index {
		if let Some(line) = lines.get(index as usize) {
			let (text, truncated) = truncate_preview(line);
			before.push(text);
			before_truncated.push(truncated);
		}
	}

	let after_end = (end_index + 1 + context).min(lines.len() as u64);
	let mut after = Vec::new();
	let mut after_truncated = Vec::new();
	for index in (end_index + 1)..after_end {
		if let Some(line) = lines.get(index as usize) {
			let (text, truncated) = truncate_preview(line);
			after.push(text);
			after_truncated.push(truncated);
		}
	}

	(before, before_truncated, after, after_truncated)
}

/// Resolves `path` under `root_path`, rejecting a symlink in any lexical
/// path component (not only the final one) even when its target is inside
/// the workspace root (the same containment substrate as
/// [`super::WorkspaceRoot::resolve`], plus this module's stricter
/// no-symlink rule).
fn resolve_exact_path(
	root_path: &Path,
	workspace_root: &WorkspaceRoot,
	path: &str,
) -> Result<std::path::PathBuf, AstGrepRejection> {
	super::validate_relative_path_lexically(path).map_err(map_path_bound)?;
	// Reject a symlink in *any* lexical path component, not only the final one:
	// `symlink_metadata` on the fully-joined path transparently follows symlinks
	// in intermediate directory components (only the final component is left
	// unresolved), so a single check on `root_path.join(path)` would miss e.g.
	// `link_dir/file.rs` where `link_dir` is a symlink but `file.rs` is not.
	let mut walked = root_path.to_path_buf();
	for component in Path::new(path).components() {
		walked.push(component);
		match std::fs::symlink_metadata(&walked) {
			Ok(metadata) if metadata.file_type().is_symlink() => {
				return Err(AstGrepRejection::SymlinkRejected);
			},
			Ok(_) => {},
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				return Err(AstGrepRejection::NotFound);
			},
			Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
				return Err(AstGrepRejection::PermissionDenied);
			},
			Err(err) => return Err(AstGrepRejection::Io(err.to_string())),
		}
	}
	workspace_root.resolve(path).map_err(map_path_bound)
}

enum ScanTarget {
	File(std::path::PathBuf),
	Directory(std::path::PathBuf),
}

fn classify_target(canonical: &Path) -> Result<ScanTarget, AstGrepRejection> {
	let metadata = std::fs::metadata(canonical).map_err(|err| {
		if err.kind() == std::io::ErrorKind::NotFound {
			AstGrepRejection::NotFound
		} else if err.kind() == std::io::ErrorKind::PermissionDenied {
			AstGrepRejection::PermissionDenied
		} else {
			AstGrepRejection::Io(err.to_string())
		}
	})?;
	if metadata.is_dir() {
		Ok(ScanTarget::Directory(canonical.to_path_buf()))
	} else if metadata.is_file() {
		Ok(ScanTarget::File(canonical.to_path_buf()))
	} else {
		Err(AstGrepRejection::NotAFileOrDirectory)
	}
}

/// Reads `canonical` as an exact-file scan target: rejects (rather than skips)
/// an oversize, binary-looking, or non-UTF-8 file, since exact-file failures
/// reject the whole call.
fn read_exact_file(canonical: &Path) -> Result<String, AstGrepRejection> {
	let metadata =
		std::fs::metadata(canonical).map_err(|err| AstGrepRejection::Io(err.to_string()))?;
	if metadata.len() > MAX_SCAN_FILE_BYTES {
		return Err(AstGrepRejection::FileTooLarge);
	}
	let bytes = std::fs::read(canonical).map_err(|err| AstGrepRejection::Io(err.to_string()))?;
	if looks_binary(&bytes) {
		return Err(AstGrepRejection::BinaryLooking);
	}
	String::from_utf8(bytes).map_err(|_| AstGrepRejection::InvalidUtf8)
}

/// A source file read and validated during a directory scan.
struct ScannedFile {
	relative: String,
	source:   String,
}

/// Walks `canonical_dir`, filtering to `lang`'s extensions (and `glob`, if
/// present), reading every candidate whose size/binary/UTF-8 checks pass. Bad
/// files are skipped with an exact counter rather than rejecting the call.
/// Stops once [`MAX_SCANNED_FILES`] files or [`MAX_TOTAL_SOURCE_BYTES`] total
/// bytes have been read, or once `track_cap` matches' worth of files have
/// provably been collected by the caller (checked by the caller after each
/// file).
fn collect_directory_files(
	root_path: &Path,
	canonical_dir: &Path,
	lang: AstGrepLanguage,
	glob: Option<&globset::GlobMatcher>,
) -> Result<(Vec<ScannedFile>, AstGrepStats, bool), AstGrepRejection> {
	let walk = walk_workspace(canonical_dir, MAX_WALK_ENTRIES).map_err(map_walk_error)?;

	let mut files = Vec::new();
	let mut skipped_files = 0usize;
	let mut total_source_bytes = 0u64;
	let mut scan_truncated = walk.truncated;

	'walk: for relative_to_dir in &walk.relative_paths {
		if !lang.matches_extension(relative_to_dir) {
			continue;
		}
		if let Some(glob) = glob
			&& !glob.is_match(relative_to_dir)
		{
			continue;
		}
		if files.len() >= MAX_SCANNED_FILES {
			scan_truncated = true;
			break 'walk;
		}

		let Ok(canonical) = walk.workspace_root.resolve(relative_to_dir) else {
			skipped_files += 1;
			continue;
		};
		let Ok(metadata) = std::fs::metadata(&canonical) else {
			skipped_files += 1;
			continue;
		};
		if metadata.len() > MAX_SCAN_FILE_BYTES {
			skipped_files += 1;
			continue;
		}
		if total_source_bytes.saturating_add(metadata.len()) > MAX_TOTAL_SOURCE_BYTES {
			scan_truncated = true;
			break 'walk;
		}
		let Ok(bytes) = std::fs::read(&canonical) else {
			skipped_files += 1;
			continue;
		};
		if looks_binary(&bytes) {
			skipped_files += 1;
			continue;
		}
		let Ok(source) = String::from_utf8(bytes) else {
			skipped_files += 1;
			continue;
		};

		total_source_bytes += metadata.len();
		let Ok(root_relative) = canonical.strip_prefix(root_path) else {
			skipped_files += 1;
			continue;
		};
		files.push(ScannedFile {
			relative: root_relative.to_string_lossy().replace('\\', "/"),
			source,
		});
	}

	let stats = AstGrepStats {
		walked_entries: walk.relative_paths.len(),
		scanned_files: files.len(),
		skipped_files,
		parse_error_files: 0,
		total_source_bytes,
	};
	Ok((files, stats, scan_truncated))
}

fn build_match(
	relative: &str,
	pattern_index_offset: usize,
	raw: RawMatch,
	lines: &[&str],
	context: u8,
) -> AstGrepMatch {
	let (context_before, context_before_truncated, context_after, context_after_truncated) =
		context_lines(lines, raw.start_line, raw.end_line, context);
	AstGrepMatch {
		path: relative.to_owned(),
		pattern_index: raw.pattern_index + pattern_index_offset,
		byte_start: raw.byte_start,
		byte_end: raw.byte_end,
		start_line: raw.start_line,
		end_line: raw.end_line,
		start_byte_column: raw.start_column,
		end_byte_column: raw.end_column,
		preview: raw.preview,
		preview_truncated: raw.preview_truncated,
		context_before,
		context_before_truncated,
		context_after,
		context_after_truncated,
	}
}

/// Runs the whole scan for a concrete, already-selected language `lang`. The
/// public [`ast_grep`] entry point dispatches to this once per
/// [`AstGrepLanguage`] variant; `Pattern` itself is not generic over the
/// language, only parsing and node traversal are, so this is the single generic
/// core shared by every language arm.
fn run<L: CoreLanguage + LanguageExt + Clone>(
	lang: L,
	lang_tag: AstGrepLanguage,
	root_path: &Path,
	args: &AstGrepArgs,
) -> Result<AstGrepArtifactContent, AstGrepRejection> {
	args.validate()?;

	let glob_matcher = match &args.glob {
		Some(pattern) => {
			let normalized = normalize_glob(pattern)?;
			Some(
				globset::GlobBuilder::new(&normalized)
					.literal_separator(false)
					.build()
					.map_err(|err| AstGrepRejection::InvalidGlob(err.to_string()))?
					.compile_matcher(),
			)
		},
		None => None,
	};

	let patterns = compile_patterns(&args.pat, args.sel.as_deref(), &lang)?;

	let workspace_root = WorkspaceRoot::new(root_path).map_err(map_path_bound)?;
	let canonical = resolve_exact_path(root_path, &workspace_root, &args.path)?;
	// `canonical` (and everything the walk resolves) has been through
	// `std::fs::canonicalize`, which can rewrite `root_path` itself (e.g. macOS
	// resolves `/tmp` to `/private/tmp`). Every `strip_prefix` below must compare
	// against the same canonicalized root, not the caller's raw `root_path`, or
	// it silently fails on every file.
	let canonical_root =
		std::fs::canonicalize(root_path).map_err(|err| AstGrepRejection::Io(err.to_string()))?;

	let window_len = (args.offset as usize)
		.saturating_add(args.limit as usize)
		.saturating_add(1);
	let track_cap = window_len.min(MAX_TRACKED_MATCHES);

	let (files, mut stats, mut truncated) = match classify_target(&canonical)? {
		ScanTarget::Directory(dir) => {
			collect_directory_files(&canonical_root, &dir, lang_tag, glob_matcher.as_ref())?
		},
		ScanTarget::File(file) => {
			let source = read_exact_file(&file)?;
			let root_relative = file.strip_prefix(&canonical_root).map_or_else(
				|_| args.path.clone(),
				|relative| relative.to_string_lossy().replace('\\', "/"),
			);
			(
				vec![ScannedFile { relative: root_relative, source: source.clone() }],
				AstGrepStats {
					walked_entries:     1,
					scanned_files:      1,
					skipped_files:      0,
					parse_error_files:  0,
					total_source_bytes: source.len() as u64,
				},
				false,
			)
		},
	};

	let mut matches: Vec<AstGrepMatch> = Vec::new();
	let mut parse_error_files = 0usize;

	for file in &files {
		if matches.len() >= track_cap {
			truncated = true;
			break;
		}
		let remaining = track_cap - matches.len();
		let (raw_matches, has_parse_error) = scan_source(&lang, &file.source, &patterns, remaining);
		if has_parse_error {
			parse_error_files += 1;
		}
		if raw_matches.is_empty() {
			continue;
		}
		let lines: Vec<&str> = file.source.lines().collect();
		for raw in raw_matches {
			matches.push(build_match(&file.relative, 0, raw, &lines, args.context));
		}
	}
	stats.parse_error_files = parse_error_files;

	let offset = args.offset as usize;
	let limit = args.limit as usize;
	if matches.len() > offset + limit {
		truncated = true;
	}
	let windowed: Vec<AstGrepMatch> = matches.into_iter().skip(offset).take(limit).collect();

	let (final_matches, output_omitted, bytes) = bound_receipt(lang_tag, stats, truncated, windowed);
	let (sha256, byte_length) = compute_artifact_bytes(&bytes);

	Ok(AstGrepArtifactContent {
		lang: lang_tag,
		matches: final_matches,
		stats,
		truncated,
		output_omitted,
		bytes,
		sha256,
		byte_length,
	})
}

/// Drops trailing match records, deterministically, until the *complete*
/// receipt JSON (not the matches array alone) fits within
/// [`MAX_RECEIPT_JSON_BYTES`]. Returns the (possibly shortened) match list,
/// the exact count of records dropped (`output_omitted`, zero when none
/// were), and the exact serialized bytes used for the artifact hash/length.
fn bound_receipt(
	lang_tag: AstGrepLanguage,
	stats: AstGrepStats,
	truncated: bool,
	mut matches: Vec<AstGrepMatch>,
) -> (Vec<AstGrepMatch>, usize, Vec<u8>) {
	// Bounds the *complete* receipt JSON (source/tool/lang/stats/truncation
	// fields plus matches), not the matches array in isolation. Receipt size is
	// monotonic in the retained prefix length: removing one serialized match
	// saves more bytes than the at-most-one-byte digit growth of
	// `output_omitted`. Binary search therefore finds the largest fitting prefix
	// exactly without repeatedly serializing every intermediate tail.
	let original_len = matches.len();
	let serialize_prefix = |retained: usize| {
		let payload = AstGrepArtifactPayload {
			source_kind: "tool_result",
			tool_name: "ast_grep",
			lang: lang_tag,
			matches: &matches[..retained],
			stats,
			truncated,
			output_omitted: original_len - retained,
		};
		serde_json::to_vec(&payload).expect("AstGrepArtifactPayload always serializes")
	};

	let full_bytes = serialize_prefix(original_len);
	if full_bytes.len() <= MAX_RECEIPT_JSON_BYTES || original_len == 0 {
		return (matches, 0, full_bytes);
	}

	let mut lower = 0usize;
	let mut upper = original_len - 1;
	let mut retained = 0usize;
	while lower <= upper {
		let candidate = lower + (upper - lower) / 2;
		if serialize_prefix(candidate).len() <= MAX_RECEIPT_JSON_BYTES {
			retained = candidate;
			lower = candidate + 1;
		} else if candidate == 0 {
			break;
		} else {
			upper = candidate - 1;
		}
	}
	let bytes = serialize_prefix(retained);
	matches.truncate(retained);
	(matches, original_len - retained, bytes)
}

/// Bounded ast-grep-pattern structural search over `path`.
///
/// Scans `path` (a file or a directory) under `root_path` for every
/// `args.pat` (or, with `sel`, selector) match against `args.lang`'s grammar.
/// See the module docs for the full disclosed policy.
pub fn ast_grep(
	root_path: &Path,
	args: &AstGrepArgs,
) -> Result<AstGrepArtifactContent, AstGrepRejection> {
	let _execution_guard = match AST_GREP_EXECUTION_LOCK.lock() {
		Ok(guard) => guard,
		Err(poisoned) => poisoned.into_inner(),
	};
	match args.lang {
		AstGrepLanguage::Rust => run(Rust, args.lang, root_path, args),
		AstGrepLanguage::Typescript => run(TypeScript, args.lang, root_path, args),
		AstGrepLanguage::Tsx => run(Tsx, args.lang, root_path, args),
		AstGrepLanguage::Javascript => run(JavaScript, args.lang, root_path, args),
		AstGrepLanguage::Python => run(Python, args.lang, root_path, args),
		AstGrepLanguage::Go => run(Go, args.lang, root_path, args),
		AstGrepLanguage::Json => run(Json, args.lang, root_path, args),
	}
}
