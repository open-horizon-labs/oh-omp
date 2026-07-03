//! Opaque prefixed ID newtypes for the successor protocol.
//!
//! Every ID type validates its prefix on construction via [`TryFrom<String>`]
//! and [`FromStr`]. Deserialization also validates the prefix so invalid IDs
//! cannot round-trip through JSON silently.
//!
//! # Stable prefixes
//!
//! | Type | Prefix |
//! |---|---|
//! | [`SessionId`] | `ses_` |
//! | [`EventId`] | `evt_` |
//! | [`TurnId`] | `turn_` |
//! | [`MessageId`] | `msg_` |
//! | [`SourceEnvelopeId`] | `src_` |
//! | [`ArtifactId`] | `art_` |
//! | [`ToolCallId`] | `tool_` |
//! | [`TraceId`] | `trace_` |
//! | [`AssembleId`] | `asm_` |
//! | [`ProviderEventId`] | `pevt_` |
//! | [`FrameId`] | `frame_` |
//! | [`RequestId`] | `req_` |
//! | [`ErrorId`] | `err_` |
//! | [`ContextItemId`] | `ctx_` |

use std::{fmt, str::FromStr};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode};

/// Validate that `value` starts with `prefix` and has a non-empty suffix.
///
/// Returns [`ProtocolViolationCode::InvalidIdPrefix`] on any failure.
fn validate_id_prefix(value: &str, prefix: &str) -> ProtocolResult<()> {
	if !value.starts_with(prefix) {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::InvalidIdPrefix,
			format!("expected prefix `{prefix}`, got `{value}`"),
		));
	}
	if value.len() == prefix.len() {
		return Err(ProtocolViolation::new(
			ProtocolViolationCode::InvalidIdPrefix,
			format!("ID with prefix `{prefix}` must have a non-empty suffix"),
		));
	}
	Ok(())
}

macro_rules! define_id {
	($name:ident, $prefix:literal, $doc:literal) => {
		#[doc = $doc]
		#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, JsonSchema)]
		#[serde(transparent)]
		pub struct $name(String);

		impl $name {
			/// The stable prefix that all values of this type must carry.
			pub const PREFIX: &'static str = $prefix;

			/// Return the underlying string value.
			pub fn as_str(&self) -> &str {
				&self.0
			}

			/// Construct from a pre-validated string without prefix checking.
			///
			/// The caller must ensure the value satisfies the prefix and
			/// non-empty-suffix contract. Prefer [`TryFrom<String>`] for
			/// user-supplied or untrusted input.
			pub const fn from_raw(raw: String) -> Self {
				Self(raw)
			}
		}

		impl TryFrom<String> for $name {
			type Error = ProtocolViolation;

			fn try_from(value: String) -> Result<Self, Self::Error> {
				validate_id_prefix(&value, $prefix)?;
				Ok(Self(value))
			}
		}

		impl FromStr for $name {
			type Err = ProtocolViolation;

			fn from_str(s: &str) -> Result<Self, Self::Err> {
				Self::try_from(s.to_owned())
			}
		}

		impl<'de> Deserialize<'de> for $name {
			fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
				let s = String::deserialize(deserializer)?;
				Self::try_from(s).map_err(serde::de::Error::custom)
			}
		}

		impl fmt::Display for $name {
			fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				f.write_str(&self.0)
			}
		}
	};
}

define_id!(SessionId, "ses_", "Opaque session identifier. Stable prefix: `ses_`.");

define_id!(EventId, "evt_", "Opaque raw event identifier. Stable prefix: `evt_`.");

define_id!(TurnId, "turn_", "Opaque turn identifier. Stable prefix: `turn_`.");

define_id!(
	MessageId,
	"msg_",
	"Opaque message projection identifier. Stable prefix: `msg_`. Used by the kernel for \
	 transcript and UI message projections."
);

define_id!(
	SourceEnvelopeId,
	"src_",
	"Opaque source envelope identifier. Stable prefix: `src_`. Every persisted content item \
	 carries a `source_envelope_id`."
);

define_id!(
	ArtifactId,
	"art_",
	"Opaque artifact identifier. Stable prefix: `art_`. Large content additionally carries an \
	 `artifact_id` alongside its `source_envelope_id`."
);

define_id!(
	ToolCallId,
	"tool_",
	"Opaque tool call identifier. Stable prefix: `tool_`. A single `ToolCallId` is shared by the \
	 request, start, completion, result artifact, and any error events belonging to the same tool \
	 lifecycle."
);

define_id!(TraceId, "trace_", "Opaque trace identifier. Stable prefix: `trace_`.");

define_id!(
	AssembleId,
	"asm_",
	"Opaque assembly identifier. Stable prefix: `asm_`. Returned by the platform `/assemble` \
	 endpoint and referenced by assembly trace records."
);

define_id!(
	ProviderEventId,
	"pevt_",
	"Opaque provider event identifier. Stable prefix: `pevt_`. Used by the kernel for normalized \
	 provider stream/delta events retained for replay."
);

define_id!(
	FrameId,
	"frame_",
	"Opaque kernel stream frame identifier. Stable prefix: `frame_`. Live/progress projection \
	 only; not a persisted raw event. Must not be used as a `raw_event_id`."
);

define_id!(RequestId, "req_", "Opaque request identifier. Stable prefix: `req_`.");

define_id!(
	ErrorId,
	"err_",
	"Opaque error identifier. Stable prefix: `err_`. Every error carries an `error_id`, even when \
	 also represented by a `turn_failed` event."
);

define_id!(
	ContextItemId,
	"ctx_",
	"Opaque context item identifier. Stable prefix: `ctx_`. Identifies a single assembly candidate \
	 or item within a context assembly operation."
);

#[cfg(test)]
mod tests {
	use super::*;
	use crate::error::ProtocolViolationCode;

	#[test]
	fn session_id_valid_prefix_and_display() {
		let id = SessionId::try_from("ses_abc123".to_owned()).unwrap();
		assert_eq!(id.as_str(), "ses_abc123");
		assert_eq!(id.to_string(), "ses_abc123");
	}

	#[test]
	fn session_id_wrong_prefix_returns_invalid_id_prefix() {
		let err = SessionId::try_from("turn_abc".to_owned()).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::InvalidIdPrefix);
	}

	#[test]
	fn session_id_empty_suffix_returns_invalid_id_prefix() {
		let err = SessionId::try_from("ses_".to_owned()).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::InvalidIdPrefix);
	}

	#[test]
	fn empty_string_returns_invalid_id_prefix() {
		let err = SessionId::try_from(String::new()).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::InvalidIdPrefix);
	}

	#[test]
	fn all_id_prefix_constants_are_correct() {
		assert_eq!(SessionId::PREFIX, "ses_");
		assert_eq!(EventId::PREFIX, "evt_");
		assert_eq!(TurnId::PREFIX, "turn_");
		assert_eq!(MessageId::PREFIX, "msg_");
		assert_eq!(SourceEnvelopeId::PREFIX, "src_");
		assert_eq!(ArtifactId::PREFIX, "art_");
		assert_eq!(ToolCallId::PREFIX, "tool_");
		assert_eq!(TraceId::PREFIX, "trace_");
		assert_eq!(AssembleId::PREFIX, "asm_");
		assert_eq!(ProviderEventId::PREFIX, "pevt_");
		assert_eq!(FrameId::PREFIX, "frame_");
		assert_eq!(RequestId::PREFIX, "req_");
		assert_eq!(ErrorId::PREFIX, "err_");
		assert_eq!(ContextItemId::PREFIX, "ctx_");
	}

	#[test]
	fn tool_call_id_uses_tool_prefix() {
		let id = ToolCallId::try_from("tool_xyz".to_owned()).unwrap();
		assert_eq!(id.as_str(), "tool_xyz");
		assert_eq!(ToolCallId::PREFIX, "tool_");
	}

	#[test]
	fn from_str_validates_prefix() {
		let id: EventId = "evt_some-event-id".parse().unwrap();
		assert_eq!(id.as_str(), "evt_some-event-id");

		let err = "bad_prefix".parse::<EventId>().unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::InvalidIdPrefix);
	}

	#[test]
	fn deserialize_validates_prefix() {
		// Valid prefix deserializes successfully.
		let id: SessionId = serde_json::from_str(r#""ses_abc123""#).unwrap();
		assert_eq!(id.as_str(), "ses_abc123");

		// Invalid prefix must produce a serde deserialization error.
		let result = serde_json::from_str::<SessionId>(r#""wrong_abc""#);
		assert!(result.is_err(), "deserializing an invalid prefix must fail");
	}

	#[test]
	fn serialize_round_trips_through_json() {
		let id = ErrorId::try_from("err_42".to_owned()).unwrap();
		let json = serde_json::to_string(&id).unwrap();
		assert_eq!(json, r#""err_42""#);
		let back: ErrorId = serde_json::from_str(&json).unwrap();
		assert_eq!(id, back);
	}

	#[test]
	fn context_item_id_uses_ctx_prefix() {
		let id = ContextItemId::try_from("ctx_abc123".to_owned()).unwrap();
		assert_eq!(id.as_str(), "ctx_abc123");
		assert_eq!(ContextItemId::PREFIX, "ctx_");

		let err = ContextItemId::try_from("wrong_abc".to_owned()).unwrap_err();
		assert_eq!(err.code, crate::error::ProtocolViolationCode::InvalidIdPrefix);

		let err = ContextItemId::try_from("ctx_".to_owned()).unwrap_err();
		assert_eq!(err.code, crate::error::ProtocolViolationCode::InvalidIdPrefix);
	}

	#[test]
	fn frame_id_is_distinct_from_event_id() {
		// frame_ prefix must not be accepted as an EventId.
		let err = EventId::try_from("frame_abc".to_owned()).unwrap_err();
		assert_eq!(err.code, ProtocolViolationCode::InvalidIdPrefix);
	}
}
