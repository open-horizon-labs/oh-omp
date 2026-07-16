//! Bounded workspace mutation primitives.
//!
//! Replacement rechecks its expected source hash immediately before atomic
//! publish. This is not a hostile-concurrency compare-and-swap guarantee: an
//! external writer can still race between that recheck and publication.

use std::{
	fs::{self, OpenOptions, Permissions},
	io::Write,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Deserializer, Serialize};
use successor_protocol::artifact::ArtifactHash;

use super::{
	PathBoundError, WorkspaceRoot, compute_artifact_bytes, looks_binary,
	validate_relative_path_lexically,
};

pub const MAX_SOURCE_BYTES: usize = 1_048_576;
pub const MAX_RESULT_BYTES: usize = 1_048_576;
pub const MAX_CONTENT_BYTES: usize = 1_048_576;
pub const MAX_REPLACEMENT_BYTES: usize = 262_144;
pub const MAX_EDITS: usize = 256;
pub const MAX_DIFF_PREVIEW_BYTES: usize = 4_096;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MutationRejection {
	#[error("tool arguments are malformed")]
	MalformedArguments,
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
	#[error("path is not a regular non-symlink file")]
	NotRegularFile,
	#[error("parent directory does not exist")]
	ParentNotFound,
	#[error("path already exists")]
	AlreadyExists,
	#[error("file looks binary (contains a NUL byte)")]
	BinarySource,
	#[error("content must not contain a NUL byte")]
	NulContent,
	#[error("file must contain valid UTF-8")]
	InvalidUtf8,
	#[error("source file exceeds the maximum byte length")]
	SourceTooLarge,
	#[error("content exceeds the maximum byte length")]
	ContentTooLarge,
	#[error("replacement exceeds the maximum byte length")]
	ReplacementTooLarge,
	#[error("result exceeds the maximum byte length")]
	ResultTooLarge,
	#[error("edits must not be empty")]
	EmptyEdits,
	#[error("edits exceed the maximum count")]
	TooManyEdits,
	#[error("edit range start must not be after its end")]
	InvertedRange,
	#[error("edit position refers to a nonexistent line")]
	NonexistentLine,
	#[error("edit position is beyond the line length")]
	BeyondLine,
	#[error("edit position is not a UTF-8 boundary")]
	InvalidUtf8Boundary,
	#[error("edit ranges overlap or share an insertion anchor")]
	OverlappingEdits,
	#[error("all edits are no-ops")]
	AllNoOp,
	#[error("expected SHA-256 does not match the current file")]
	StaleHash,
	#[error("create mode must not include expected_sha256")]
	CreateWithExpectedHash,
	#[error("replace mode requires expected_sha256")]
	ReplaceWithoutExpectedHash,
	#[error("workspace mutation failed")]
	Io,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEndings {
	None,
	Lf,
	Crlf,
	Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MutationReceipt {
	pub source_kind:        String,
	pub tool_name:          String,
	pub path:               String,
	pub operation:          String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub before_sha256:      Option<ArtifactHash>,
	pub after_sha256:       ArtifactHash,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub before_byte_length: Option<u64>,
	pub after_byte_length:  u64,
	pub changed:            bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub edits_applied:      Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub mode:               Option<String>,
	pub diff_preview:       String,
	pub diff_truncated:     bool,
	pub line_endings:       LineEndings,
	pub mixed_line_endings: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptArtifact {
	pub bytes:       Vec<u8>,
	pub sha256:      ArtifactHash,
	pub byte_length: u64,
}

impl MutationReceipt {
	pub fn artifact(&self) -> ReceiptArtifact {
		let bytes = serde_json::to_vec(self).expect("MutationReceipt always serializes");
		let (sha256, byte_length) = compute_artifact_bytes(&bytes);
		ReceiptArtifact { bytes, sha256, byte_length }
	}
}

pub(crate) fn parse_arguments<T: serde::de::DeserializeOwned>(
	arguments: &serde_json::Value,
) -> Result<T, MutationRejection> {
	serde_json::from_value(arguments.clone()).map_err(|_| MutationRejection::MalformedArguments)
}

const EXPECTED_SHA256_ERROR: &str =
	"expected SHA-256 must be 64 lowercase hex characters, optionally prefixed by `sha256:`";

pub(crate) fn deserialize_expected_sha256<'de, D>(deserializer: D) -> Result<ArtifactHash, D::Error>
where
	D: Deserializer<'de>,
{
	let value = String::deserialize(deserializer)?;
	normalize_expected_sha256(value).map_err(serde::de::Error::custom)
}

pub(crate) fn deserialize_optional_expected_sha256<'de, D>(
	deserializer: D,
) -> Result<Option<ArtifactHash>, D::Error>
where
	D: Deserializer<'de>,
{
	let value = String::deserialize(deserializer)?;
	normalize_expected_sha256(value)
		.map(Some)
		.map_err(serde::de::Error::custom)
}

fn normalize_expected_sha256(value: String) -> Result<ArtifactHash, &'static str> {
	let canonical = if value.len() == 64
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	{
		format!("sha256:{value}")
	} else {
		value
	};
	ArtifactHash::parse(canonical).map_err(|_| EXPECTED_SHA256_ERROR)
}

pub(crate) fn trusted_root(workspace_root: &Path) -> Result<WorkspaceRoot, MutationRejection> {
	WorkspaceRoot::new(workspace_root).map_err(map_path_bound)
}

pub(crate) fn target_in_existing_parent(
	root: &WorkspaceRoot,
	relative: &str,
) -> Result<PathBuf, MutationRejection> {
	validate_relative_path_lexically(relative).map_err(map_path_bound)?;
	let path = Path::new(relative);
	let Some(file_name) = path.file_name() else {
		return Err(MutationRejection::NotRegularFile);
	};
	let parent = path.parent().unwrap_or_else(|| Path::new(""));
	let parent = root
		.resolve(parent.to_str().expect("String paths are valid UTF-8"))
		.map_err(map_path_bound)?;
	let metadata = fs::metadata(&parent).map_err(map_io)?;
	if !metadata.is_dir() {
		return Err(MutationRejection::ParentNotFound);
	}
	Ok(parent.join(file_name))
}

pub(crate) fn existing_regular_file(
	root: &WorkspaceRoot,
	relative: &str,
) -> Result<(PathBuf, Permissions), MutationRejection> {
	let target = target_in_existing_parent(root, relative)?;
	let metadata = fs::symlink_metadata(&target).map_err(map_io)?;
	if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
		return Err(MutationRejection::NotRegularFile);
	}
	Ok((target, metadata.permissions()))
}

pub(crate) fn read_text_source(target: &Path) -> Result<Vec<u8>, MutationRejection> {
	let bytes = fs::read(target).map_err(map_io)?;
	if bytes.len() > MAX_SOURCE_BYTES {
		return Err(MutationRejection::SourceTooLarge);
	}
	if looks_binary(&bytes) {
		return Err(MutationRejection::BinarySource);
	}
	if std::str::from_utf8(&bytes).is_err() {
		return Err(MutationRejection::InvalidUtf8);
	}
	Ok(bytes)
}

pub(crate) fn validate_content(content: &str) -> Result<(), MutationRejection> {
	if content.as_bytes().contains(&0) {
		return Err(MutationRejection::NulContent);
	}
	if content.len() > MAX_CONTENT_BYTES {
		return Err(MutationRejection::ContentTooLarge);
	}
	Ok(())
}

pub(crate) fn ensure_expected_hash(
	bytes: &[u8],
	expected: &ArtifactHash,
) -> Result<(), MutationRejection> {
	if ArtifactHash::compute(bytes) != *expected {
		return Err(MutationRejection::StaleHash);
	}
	Ok(())
}

pub(crate) fn recheck_expected_hash(
	target: &Path,
	expected: &ArtifactHash,
) -> Result<(), MutationRejection> {
	let metadata = fs::symlink_metadata(target).map_err(map_io)?;
	if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
		return Err(MutationRejection::NotRegularFile);
	}
	let bytes = read_text_source(target)?;
	ensure_expected_hash(&bytes, expected)
}

pub(crate) fn publish_replace(
	target: &Path,
	content: &[u8],
	permissions: Permissions,
	expected_sha256: &ArtifactHash,
) -> Result<(), MutationRejection> {
	let temp = write_synced_temp(
		target.parent().expect("target always has parent"),
		content,
		Some(permissions),
	)?;
	if let Err(error) = recheck_expected_hash(target, expected_sha256) {
		remove_temp(&temp);
		return Err(error);
	}
	let published = fs::rename(&temp, target).is_ok();
	if !published {
		remove_temp(&temp);
		return Err(MutationRejection::Io);
	}
	Ok(())
}

pub(crate) fn publish_create(target: &Path, content: &[u8]) -> Result<(), MutationRejection> {
	let temp = write_synced_temp(target.parent().expect("target always has parent"), content, None)?;
	match fs::hard_link(&temp, target) {
		Ok(()) => {
			remove_temp(&temp);
			Ok(())
		},
		Err(err) => {
			remove_temp(&temp);
			if err.kind() == std::io::ErrorKind::AlreadyExists {
				Err(MutationRejection::AlreadyExists)
			} else {
				Err(map_io(err))
			}
		},
	}
}

pub(crate) fn receipt(
	tool_name: &str,
	path: String,
	operation: &str,
	before: Option<&[u8]>,
	after: &[u8],
	edits_applied: Option<u32>,
	mode: Option<&str>,
) -> MutationReceipt {
	let before_byte_length = before.map(|bytes| bytes.len() as u64);
	let before_sha256 = before.map(ArtifactHash::compute);
	let (after_sha256, after_byte_length) = compute_artifact_bytes(after);
	let line_endings = line_endings(before.unwrap_or(after));
	let mixed_line_endings = line_endings == LineEndings::Mixed;
	let mut preview = format!(
		"{operation}: {} -> {after_byte_length} bytes",
		before_byte_length.map_or_else(|| "absent".to_owned(), |length| length.to_string())
	);
	let diff_truncated = preview.len() > MAX_DIFF_PREVIEW_BYTES;
	if diff_truncated {
		preview.truncate(MAX_DIFF_PREVIEW_BYTES);
	}
	MutationReceipt {
		source_kind: "tool_result".to_owned(),
		tool_name: tool_name.to_owned(),
		path,
		operation: operation.to_owned(),
		before_sha256,
		after_sha256,
		before_byte_length,
		after_byte_length,
		changed: true,
		edits_applied,
		mode: mode.map(str::to_owned),
		diff_preview: preview,
		diff_truncated,
		line_endings,
		mixed_line_endings,
	}
}

pub(crate) fn line_endings(bytes: &[u8]) -> LineEndings {
	let mut lf = false;
	let mut crlf = false;
	for (index, byte) in bytes.iter().enumerate() {
		if *byte == b'\n' {
			if index > 0 && bytes[index - 1] == b'\r' {
				crlf = true;
			} else {
				lf = true;
			}
		}
	}
	match (lf, crlf) {
		(false, false) => LineEndings::None,
		(true, false) => LineEndings::Lf,
		(false, true) => LineEndings::Crlf,
		(true, true) => LineEndings::Mixed,
	}
}

fn write_synced_temp(
	parent: &Path,
	content: &[u8],
	permissions: Option<Permissions>,
) -> Result<PathBuf, MutationRejection> {
	for _ in 0..64 {
		let temp = parent.join(format!(
			".successor-mutation-{}-{}",
			std::process::id(),
			TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
		));
		let mut file = match OpenOptions::new().write(true).create_new(true).open(&temp) {
			Ok(file) => file,
			Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
			Err(err) => return Err(map_io(err)),
		};
		let result = (|| {
			file.write_all(content).map_err(map_io)?;
			if let Some(permissions) = permissions {
				file.set_permissions(permissions).map_err(map_io)?;
			}
			file.sync_all().map_err(map_io)
		})();
		drop(file);
		if let Err(err) = result {
			remove_temp(&temp);
			return Err(err);
		}
		return Ok(temp);
	}
	Err(MutationRejection::Io)
}

fn remove_temp(temp: &Path) {
	let _ = fs::remove_file(temp);
}

fn map_path_bound(error: PathBoundError) -> MutationRejection {
	match error {
		PathBoundError::RootNotFound => MutationRejection::RootNotFound,
		PathBoundError::AbsolutePath => MutationRejection::AbsolutePath,
		PathBoundError::ParentTraversal => MutationRejection::ParentTraversal,
		PathBoundError::NotFound => MutationRejection::NotFound,
		PathBoundError::OutOfRoot => MutationRejection::OutOfRoot,
		PathBoundError::PermissionDenied => MutationRejection::PermissionDenied,
		PathBoundError::Io(_) => MutationRejection::Io,
	}
}

fn map_io(error: std::io::Error) -> MutationRejection {
	match error.kind() {
		std::io::ErrorKind::NotFound => MutationRejection::NotFound,
		std::io::ErrorKind::AlreadyExists => MutationRejection::AlreadyExists,
		std::io::ErrorKind::PermissionDenied => MutationRejection::PermissionDenied,
		_ => MutationRejection::Io,
	}
}
