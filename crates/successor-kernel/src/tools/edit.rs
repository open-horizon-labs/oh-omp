use std::{num::NonZeroU32, path::Path};

use schemars::{JsonSchema, schema::RootSchema};
use serde::Deserialize;
use successor_protocol::artifact::ArtifactHash;

use super::{
	mutation::{
		MAX_EDITS, MAX_REPLACEMENT_BYTES, MAX_RESULT_BYTES, MutationReceipt, MutationRejection,
		deserialize_expected_sha256, ensure_expected_hash, existing_regular_file, parse_arguments,
		publish_replace, read_text_source, receipt, trusted_root,
	},
	validate_relative_path_lexically,
};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditArgs {
	pub path:            String,
	/// SHA-256 precondition from the latest read; accepts `sha256:<64 lowercase
	/// hex>` or bare lowercase hex.
	#[serde(deserialize_with = "deserialize_expected_sha256")]
	#[schemars(with = "String", regex(pattern = "^(sha256:)?[0-9a-f]{64}$"))]
	pub expected_sha256: ArtifactHash,
	pub edits:           Vec<EditRange>,
}

impl EditArgs {
	pub fn schema() -> RootSchema {
		schemars::schema_for!(Self)
	}
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditRange {
	pub start:       EditPosition,
	pub end:         EditPosition,
	pub replacement: String,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditPosition {
	pub line:   NonZeroU32,
	pub column: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ByteRange {
	start:      usize,
	end:        usize,
	edit_index: usize,
}

pub fn execute(
	workspace_root: &Path,
	arguments: &serde_json::Value,
) -> Result<MutationReceipt, MutationRejection> {
	let args: EditArgs = parse_arguments(arguments)?;
	validate_relative_path_lexically(&args.path).map_err(|error| match error {
		super::PathBoundError::AbsolutePath => MutationRejection::AbsolutePath,
		super::PathBoundError::ParentTraversal => MutationRejection::ParentTraversal,
		_ => MutationRejection::Io,
	})?;
	if args.edits.is_empty() {
		return Err(MutationRejection::EmptyEdits);
	}
	if args.edits.len() > MAX_EDITS {
		return Err(MutationRejection::TooManyEdits);
	}
	for edit in &args.edits {
		if edit.replacement.as_bytes().contains(&0) {
			return Err(MutationRejection::NulContent);
		}
		if edit.replacement.len() > MAX_REPLACEMENT_BYTES {
			return Err(MutationRejection::ReplacementTooLarge);
		}
	}

	let root = trusted_root(workspace_root)?;
	let (target, permissions) = existing_regular_file(&root, &args.path)?;
	let before = read_text_source(&target)?;
	ensure_expected_hash(&before, &args.expected_sha256)?;
	let byte_ranges = resolve_ranges(&before, &args.edits)?;
	let after = apply_ranges(&before, &args.edits, &byte_ranges)?;
	if after == before {
		return Err(MutationRejection::AllNoOp);
	}

	publish_replace(&target, &after, permissions, &args.expected_sha256)?;
	Ok(receipt(
		"edit",
		args.path,
		"edit",
		Some(&before),
		&after,
		Some(args.edits.len() as u32),
		None,
	))
}

fn resolve_ranges(source: &[u8], edits: &[EditRange]) -> Result<Vec<ByteRange>, MutationRejection> {
	let mut ranges = Vec::with_capacity(edits.len());
	for (edit_index, edit) in edits.iter().enumerate() {
		let start = position_to_offset(source, edit.start)?;
		let end = position_to_offset(source, edit.end)?;
		if start > end {
			return Err(MutationRejection::InvertedRange);
		}
		ranges.push(ByteRange { start, end, edit_index });
	}
	// The derived order pins same-coordinate application during reverse traversal.
	ranges.sort();
	for pair in ranges.windows(2) {
		if ranges_conflict(pair[0], pair[1]) {
			return Err(MutationRejection::OverlappingEdits);
		}
	}
	Ok(ranges)
}

fn position_to_offset(source: &[u8], position: EditPosition) -> Result<usize, MutationRejection> {
	let wanted_line = position.line.get() as usize;
	let mut line_start = 0;
	let mut current_line = 1;
	while current_line < wanted_line {
		let Some(next_lf) = source[line_start..].iter().position(|byte| *byte == b'\n') else {
			return Err(MutationRejection::NonexistentLine);
		};
		line_start += next_lf + 1;
		current_line += 1;
	}
	let line_end = source[line_start..]
		.iter()
		.position(|byte| *byte == b'\n')
		.map_or(source.len(), |offset| line_start + offset);
	let column = position.column as usize;
	if column > line_end - line_start {
		return Err(MutationRejection::BeyondLine);
	}
	let offset = line_start + column;
	if !std::str::from_utf8(source)
		.expect("source UTF-8 was validated before range resolution")
		.is_char_boundary(offset)
	{
		return Err(MutationRejection::InvalidUtf8Boundary);
	}
	Ok(offset)
}

fn ranges_conflict(left: ByteRange, right: ByteRange) -> bool {
	if left.start == left.end && right.start == right.end {
		return left.start == right.start;
	}
	if left.start == left.end {
		return point_is_strictly_inside(left.start, right);
	}
	if right.start == right.end {
		return point_is_strictly_inside(right.start, left);
	}
	left.start < right.end && right.start < left.end
}

fn point_is_strictly_inside(point: usize, range: ByteRange) -> bool {
	point != range.start && (range.start..range.end).contains(&point)
}

fn apply_ranges(
	source: &[u8],
	edits: &[EditRange],
	ranges: &[ByteRange],
) -> Result<Vec<u8>, MutationRejection> {
	let replacement_total = edits.iter().try_fold(0usize, |total, edit| {
		total
			.checked_add(edit.replacement.len())
			.ok_or(MutationRejection::ResultTooLarge)
	})?;
	let removed_total = ranges.iter().try_fold(0usize, |total, range| {
		total
			.checked_add(range.end - range.start)
			.ok_or(MutationRejection::ResultTooLarge)
	})?;
	let result_length = source
		.len()
		.checked_sub(removed_total)
		.and_then(|length| length.checked_add(replacement_total))
		.ok_or(MutationRejection::ResultTooLarge)?;
	if result_length > MAX_RESULT_BYTES {
		return Err(MutationRejection::ResultTooLarge);
	}
	let mut result = source.to_vec();
	for range in ranges.iter().rev() {
		result.splice(range.start..range.end, edits[range.edit_index].replacement.bytes());
	}
	Ok(result)
}
