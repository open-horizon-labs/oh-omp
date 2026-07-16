use std::path::Path;

use schemars::{JsonSchema, schema::RootSchema};
use serde::{Deserialize, Serialize};
use successor_protocol::artifact::ArtifactHash;

use super::{
	mutation::{
		MutationReceipt, MutationRejection, deserialize_optional_expected_sha256,
		ensure_expected_hash, existing_regular_file, parse_arguments, publish_create,
		publish_replace, read_text_source, receipt, target_in_existing_parent, trusted_root,
		validate_content,
	},
	validate_relative_path_lexically,
};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WriteArgs {
	pub path:            String,
	pub mode:            WriteMode,
	pub content:         String,
	/// SHA-256 precondition for replace mode; accepts `sha256:<64 lowercase
	/// hex>` or bare lowercase hex.
	#[serde(
		default,
		deserialize_with = "deserialize_optional_expected_sha256",
		skip_serializing_if = "Option::is_none"
	)]
	#[schemars(with = "String", regex(pattern = "^(sha256:)?[0-9a-f]{64}$"))]
	pub expected_sha256: Option<ArtifactHash>,
}

impl WriteArgs {
	pub fn schema() -> RootSchema {
		schemars::schema_for!(Self)
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WriteMode {
	Create,
	Replace,
}

impl WriteMode {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Create => "create",
			Self::Replace => "replace",
		}
	}
}

pub fn execute(
	workspace_root: &Path,
	arguments: &serde_json::Value,
) -> Result<MutationReceipt, MutationRejection> {
	let args: WriteArgs = parse_arguments(arguments)?;
	validate_relative_path_lexically(&args.path).map_err(|error| match error {
		super::PathBoundError::AbsolutePath => MutationRejection::AbsolutePath,
		super::PathBoundError::ParentTraversal => MutationRejection::ParentTraversal,
		_ => MutationRejection::Io,
	})?;
	validate_content(&args.content)?;
	let root = trusted_root(workspace_root)?;
	match args.mode {
		WriteMode::Create => create(&root, args),
		WriteMode::Replace => replace(&root, args),
	}
}

fn create(
	root: &super::WorkspaceRoot,
	args: WriteArgs,
) -> Result<MutationReceipt, MutationRejection> {
	if args.expected_sha256.is_some() {
		return Err(MutationRejection::CreateWithExpectedHash);
	}
	let target = target_in_existing_parent(root, &args.path)?;
	match std::fs::symlink_metadata(&target) {
		Ok(metadata) if metadata.file_type().is_symlink() => {
			return Err(MutationRejection::NotRegularFile);
		},
		Ok(_) => return Err(MutationRejection::AlreadyExists),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
		Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
			return Err(MutationRejection::PermissionDenied);
		},
		Err(_) => return Err(MutationRejection::Io),
	}
	publish_create(&target, args.content.as_bytes())?;
	Ok(receipt(
		"write",
		args.path,
		"write",
		None,
		args.content.as_bytes(),
		None,
		Some(WriteMode::Create.as_str()),
	))
}

fn replace(
	root: &super::WorkspaceRoot,
	args: WriteArgs,
) -> Result<MutationReceipt, MutationRejection> {
	let Some(expected_sha256) = args.expected_sha256.as_ref() else {
		return Err(MutationRejection::ReplaceWithoutExpectedHash);
	};
	let (target, permissions) = existing_regular_file(root, &args.path)?;
	let before = read_text_source(&target)?;
	ensure_expected_hash(&before, expected_sha256)?;
	publish_replace(&target, args.content.as_bytes(), permissions, expected_sha256)?;
	Ok(receipt(
		"write",
		args.path,
		"write",
		Some(&before),
		args.content.as_bytes(),
		None,
		Some(WriteMode::Replace.as_str()),
	))
}
