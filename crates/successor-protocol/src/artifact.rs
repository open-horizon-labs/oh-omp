//! Artifact protocol types and hash validation.
//!
//! [`ArtifactV0`] is the stable persisted artifact descriptor.
//! Artifact hash format is `sha256:` followed by exactly 64 lowercase hex
//! digits.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
	error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode},
	ids::ArtifactId,
};

/// Schema version for [`ArtifactV0`].
///
/// Always `"platform.artifact.v0"`.
pub const ARTIFACT_SCHEMA_VERSION: &str = "platform.artifact.v0";

/// Expected character count of the hex digest portion of a SHA-256 artifact
/// hash.
const SHA256_HEX_LEN: usize = 64;

/// The required prefix for all [`ArtifactHash`] values.
const SHA256_PREFIX: &str = "sha256:";

/// A validated artifact hash in `sha256:<64 lowercase hex>` format.
///
/// Use [`ArtifactHash::compute`] to derive a hash from raw bytes, or
/// [`ArtifactHash::parse`] to validate an existing string without re-computing.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, JsonSchema)]
#[serde(transparent)]
pub struct ArtifactHash(String);

impl ArtifactHash {
	/// Compute the SHA-256 hash of `bytes` and return the `sha256:<hex>` value.
	pub fn compute(bytes: &[u8]) -> Self {
		let digest = Sha256::digest(bytes);
		Self(format!("{SHA256_PREFIX}{}", hex::encode(digest)))
	}

	/// Parse and validate an existing `sha256:<64 lowercase hex>` string.
	///
	/// Returns [`ProtocolViolationCode::MalformedHash`] if the format is
	/// invalid.
	pub fn parse(value: impl Into<String>) -> ProtocolResult<Self> {
		let s: String = value.into();
		validate_hash_format(&s)?;
		Ok(Self(s))
	}

	/// Return the full `sha256:<hex>` string.
	pub fn as_str(&self) -> &str {
		&self.0
	}

	/// Return the 64-character lowercase hex digest without the `sha256:`
	/// prefix.
	pub fn hex_digest(&self) -> &str {
		&self.0[SHA256_PREFIX.len()..]
	}
}

impl std::fmt::Display for ArtifactHash {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl<'de> Deserialize<'de> for ArtifactHash {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		let s = String::deserialize(deserializer)?;
		Self::parse(s).map_err(serde::de::Error::custom)
	}
}

/// Validate that `s` is in `sha256:<64 lowercase hex>` format.
///
/// Returns [`ProtocolViolationCode::MalformedHash`] on any format violation.
fn validate_hash_format(s: &str) -> ProtocolResult<()> {
	let Some(hex) = s.strip_prefix(SHA256_PREFIX) else {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::MalformedHash,
			format!("artifact hash must start with `sha256:`, got `{s}`"),
		));
	};
	if hex.len() != SHA256_HEX_LEN {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::MalformedHash,
			format!("artifact hash hex digest must be {SHA256_HEX_LEN} characters, got {}", hex.len()),
		));
	}
	if !hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::MalformedHash,
			"artifact hash hex digest must be lowercase hexadecimal (no uppercase, no non-hex chars)",
		));
	}
	Ok(())
}

/// Validate that `declared_hash` and `declared_byte_length` match the actual
/// `bytes`.
///
/// Returns [`ProtocolViolationCode::MalformedHash`] if the hash string is
/// malformed, or [`ProtocolViolationCode::ValidationFailed`] if the computed
/// hash or byte count does not match.
pub fn validate_artifact_content(
	declared_hash: &str,
	declared_byte_length: u64,
	bytes: &[u8],
) -> ProtocolResult<()> {
	validate_hash_format(declared_hash)?;
	let computed = ArtifactHash::compute(bytes);
	if computed.as_str() != declared_hash {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			format!(
				"artifact hash mismatch: declared `{declared_hash}`, computed `{}`",
				computed.as_str()
			),
		));
	}
	let actual_len = bytes.len() as u64;
	if actual_len != declared_byte_length {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			format!(
				"artifact byte_length mismatch: declared {declared_byte_length}, actual {actual_len}"
			),
		));
	}
	Ok(())
}

/// Stable persisted artifact descriptor.
///
/// The `schema_version` field is always `"platform.artifact.v0"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactV0 {
	/// Always `"platform.artifact.v0"`.
	pub schema_version: String,
	/// Unique artifact identifier. Stable prefix: `art_`.
	pub artifact_id:    ArtifactId,
	/// MIME type of the artifact content (e.g., `"text/plain"`,
	/// `"application/json"`).
	pub media_type:     String,
	/// Content encoding (e.g., `"utf-8"`, `"base64"`, `"identity"`).
	pub encoding:       String,
	/// Content hash in `sha256:<64 lowercase hex>` format.
	pub sha256:         ArtifactHash,
	/// Byte length of the raw (pre-encoding) content.
	pub byte_length:    u64,
	/// Short human-readable preview of the content. May be truncated.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub preview:        Option<String>,
	/// Optional inline content. When absent, content is retrieved via
	/// `artifact_id`.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub content:        Option<serde_json::Value>,
}

impl ArtifactV0 {
	/// Construct an [`ArtifactV0`] with the canonical schema version.
	///
	/// Validates the supplied `sha256` string via [`ArtifactHash::parse`];
	/// returns [`ProtocolViolationCode::MalformedHash`] if the format is
	/// invalid. Use [`ArtifactHash::compute`] to derive the hash from content
	/// bytes and [`validate_artifact_content`] for full content-bound
	/// validation.
	pub fn new(
		artifact_id: ArtifactId,
		media_type: impl Into<String>,
		encoding: impl Into<String>,
		sha256: impl Into<String>,
		byte_length: u64,
	) -> ProtocolResult<Self> {
		let sha256 = ArtifactHash::parse(sha256)?;
		Ok(Self {
			schema_version: ARTIFACT_SCHEMA_VERSION.to_owned(),
			artifact_id,
			media_type: media_type.into(),
			encoding: encoding.into(),
			sha256,
			byte_length,
			preview: None,
			content: None,
		})
	}

	/// Attach a human-readable preview string.
	pub fn with_preview(mut self, preview: impl Into<String>) -> Self {
		self.preview = Some(preview.into());
		self
	}

	/// Attach optional inline content.
	pub fn with_content(mut self, content: serde_json::Value) -> Self {
		self.content = Some(content);
		self
	}

	/// The `sha256` field is typed as [`ArtifactHash`] and is always
	/// well-formed.
	///
	/// Returns `Ok(())`. Kept for API compatibility; use
	/// [`validate_artifact_content`] for full content-bound hash and
	/// byte-length validation.
	pub const fn validate_sha256(&self) -> ProtocolResult<()> {
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{error::ProtocolViolationCode, ids::ArtifactId};

	#[test]
	fn artifact_schema_version_constant() {
		assert_eq!(ARTIFACT_SCHEMA_VERSION, "platform.artifact.v0");
	}

	#[test]
	fn artifact_hash_compute_has_correct_format() {
		let hash = ArtifactHash::compute(b"hello world");
		assert!(hash.as_str().starts_with("sha256:"), "must start with sha256: prefix");
		assert_eq!(hash.hex_digest().len(), 64);
		assert!(
			hash
				.hex_digest()
				.chars()
				.all(|c| matches!(c, '0'..='9' | 'a'..='f')),
			"hex digest must be lowercase hex"
		);
	}

	#[test]
	fn artifact_hash_compute_is_deterministic() {
		let a = ArtifactHash::compute(b"test content");
		let b = ArtifactHash::compute(b"test content");
		assert_eq!(a, b);
	}

	#[test]
	fn artifact_hash_parse_valid() {
		// Known SHA-256 of empty string.
		let valid = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		let hash = ArtifactHash::parse(valid.to_owned()).unwrap();
		assert_eq!(hash.as_str(), valid);
		assert_eq!(hash.hex_digest().len(), 64);
	}

	#[test]
	fn artifact_hash_parse_missing_prefix_returns_malformed_hash() {
		let err =
			ArtifactHash::parse("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
				.unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::MalformedHash);
	}

	#[test]
	fn artifact_hash_parse_wrong_prefix_returns_malformed_hash() {
		let err = ArtifactHash::parse("md5:abc123").unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::MalformedHash);
	}

	#[test]
	fn artifact_hash_parse_uppercase_rejected() {
		// 64 chars but uppercase — must be rejected.
		let upper = format!("sha256:{}", "A".repeat(64));
		let err = ArtifactHash::parse(upper).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::MalformedHash);
	}

	#[test]
	fn artifact_hash_parse_wrong_length_rejected() {
		// 63 chars — one short.
		let short = format!("sha256:{}", "a".repeat(63));
		let err = ArtifactHash::parse(short).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::MalformedHash);
	}

	#[test]
	fn validate_artifact_content_passes_for_matching_hash_and_length() {
		let bytes = b"hello, protocol";
		let hash = ArtifactHash::compute(bytes);
		let result = validate_artifact_content(hash.as_str(), bytes.len() as u64, bytes);
		assert!(result.is_ok(), "valid hash and length must pass: {result:?}");
	}

	#[test]
	fn validate_artifact_content_rejects_hash_mismatch() {
		let bytes = b"content a";
		let wrong_hash = ArtifactHash::compute(b"content b");
		let err =
			validate_artifact_content(wrong_hash.as_str(), bytes.len() as u64, bytes).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::ValidationFailed);
	}

	#[test]
	fn validate_artifact_content_rejects_length_mismatch() {
		let bytes = b"hello";
		let hash = ArtifactHash::compute(bytes);
		let err = validate_artifact_content(hash.as_str(), 999, bytes).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::ValidationFailed);
	}

	#[test]
	fn validate_artifact_content_rejects_malformed_hash_before_computing() {
		let err = validate_artifact_content("not-a-hash", 5, b"hello").unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::MalformedHash);
	}

	#[test]
	fn artifact_v0_sets_schema_version_and_fields() {
		let id = ArtifactId::try_from("art_test1".to_owned()).unwrap();
		let hash = ArtifactHash::compute(b"body");
		let artifact = ArtifactV0::new(id, "text/plain", "utf-8", hash.as_str(), 4).unwrap();
		assert_eq!(artifact.schema_version, ARTIFACT_SCHEMA_VERSION);
		assert_eq!(artifact.media_type, "text/plain");
		assert_eq!(artifact.encoding, "utf-8");
		assert_eq!(artifact.byte_length, 4);
		assert!(artifact.preview.is_none());
		assert!(artifact.content.is_none());
	}

	#[test]
	fn artifact_v0_with_preview_and_content() {
		let id = ArtifactId::try_from("art_test2".to_owned()).unwrap();
		let hash = ArtifactHash::compute(b"{}");
		let artifact = ArtifactV0::new(id, "application/json", "utf-8", hash.as_str(), 2)
			.unwrap()
			.with_preview("empty object")
			.with_content(serde_json::json!({}));
		assert_eq!(artifact.preview.as_deref(), Some("empty object"));
		assert!(artifact.content.is_some());
	}

	#[test]
	fn artifact_v0_validate_sha256_passes() {
		let id = ArtifactId::try_from("art_test3".to_owned()).unwrap();
		let hash = ArtifactHash::compute(b"data");
		let artifact =
			ArtifactV0::new(id, "application/octet-stream", "identity", hash.as_str(), 4).unwrap();
		assert!(artifact.validate_sha256().is_ok());
	}

	#[test]
	fn artifact_v0_new_rejects_malformed_sha256() {
		let id = ArtifactId::try_from("art_test4".to_owned()).unwrap();
		let err = ArtifactV0::new(id, "text/plain", "utf-8", "not-a-hash", 0).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::MalformedHash);
	}

	#[test]
	fn artifact_hash_deserialize_valid() {
		let valid = "\"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\"";
		let hash: ArtifactHash = serde_json::from_str(valid).unwrap();
		assert_eq!(
			hash.as_str(),
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
	}

	#[test]
	fn artifact_hash_deserialize_missing_prefix_rejected() {
		let err = serde_json::from_str::<ArtifactHash>(
			"\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\"",
		);
		assert!(err.is_err(), "missing sha256: prefix must be rejected");
	}

	#[test]
	fn artifact_hash_deserialize_uppercase_rejected() {
		let upper = format!("\"sha256:{}\"", "A".repeat(64));
		let err = serde_json::from_str::<ArtifactHash>(&upper);
		assert!(err.is_err(), "uppercase hex must be rejected");
	}

	#[test]
	fn artifact_hash_deserialize_wrong_length_rejected() {
		let short = format!("\"sha256:{}\"", "a".repeat(63));
		let err = serde_json::from_str::<ArtifactHash>(&short);
		assert!(err.is_err(), "wrong digest length must be rejected");
	}
	#[test]
	fn artifact_v0_deserialize_rejects_malformed_sha256() {
		// ArtifactHash deserialization must reject malformed sha256 at the field level.
		let json = r#"{"schema_version":"platform.artifact.v0","artifact_id":"art_test5","media_type":"text/plain","encoding":"utf-8","sha256":"not-a-hash","byte_length":0}"#;
		let result = serde_json::from_str::<ArtifactV0>(json);
		assert!(
			result.is_err(),
			"malformed sha256 must be rejected during ArtifactV0 deserialization"
		);
	}
}
