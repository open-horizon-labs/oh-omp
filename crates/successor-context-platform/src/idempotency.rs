//! Idempotency-key fingerprinting and duplicate-request classification.
//!
//! The append boundary treats `(session_id, idempotency_key)` as a durable
//! unique identity for one client-intended write. A content fingerprint over
//! the canonical request bytes lets the store distinguish a byte-identical
//! retry (replay) from a second, different event that collided on the same
//! key (a client bug). The fingerprint is computed over
//! `RawEventAppendRequestV0` as received: that DTO already omits
//! `session_seq`, the only field the platform assigns, so no additional
//! field stripping is required before hashing.

use sha2::{Digest, Sha256};
use successor_protocol::{
	canonical_json::to_canonical_json_bytes, error::ProtocolResult,
	platform_api::RawEventAppendRequestV0,
};

/// Stable content fingerprint for an append request, used to detect whether
/// a repeated `idempotency_key` carries the same logical request or a
/// different one.
pub fn fingerprint(request: &RawEventAppendRequestV0) -> ProtocolResult<String> {
	let bytes = to_canonical_json_bytes(request)?;
	let digest = Sha256::digest(&bytes);
	Ok(format!("{digest:x}"))
}

/// Outcome of comparing an incoming request's fingerprint against a stored
/// record's fingerprint for the same `(session_id, idempotency_key)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdempotencyOutcome {
	/// The incoming request is a byte-identical replay of a previously
	/// accepted request. The caller must return the stored response with
	/// `duplicate` forced to `true`, without allocating a new sequence.
	Replay,
	/// The incoming request reuses the idempotency key with a different
	/// fingerprint. The caller must reject with `DuplicateIdempotencyKey`
	/// and must not allocate a sequence.
	Conflict,
}

/// Classifies an incoming request's fingerprint against a stored record's
/// fingerprint.
///
/// Callers must only invoke this once a stored record for the key is known
/// to exist; a missing record is not represented here because it belongs
/// to the caller's "allocate a new sequence" branch, not to a comparison
/// outcome.
#[must_use]
pub fn classify(stored_fingerprint: &str, candidate_fingerprint: &str) -> IdempotencyOutcome {
	if stored_fingerprint == candidate_fingerprint {
		IdempotencyOutcome::Replay
	} else {
		IdempotencyOutcome::Conflict
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_request(idempotency_key: &str, payload: serde_json::Value) -> RawEventAppendRequestV0 {
		let json = format!(
			r#"{{
			"schema_version": "platform.raw_event.v0",
			"event_id": "evt_fingerprint_{idempotency_key}",
			"idempotency_key": "{idempotency_key}",
			"event_type": "tool_catalog.published",
			"session_id": "ses_fingerprint",
			"turn_id": null,
			"request_id": "req_fingerprint",
			"occurred_at": "2026-06-23T12:00:00Z",
			"producer": {{ "kind": "kernel", "id": "local-dev-kernel" }},
			"causation_event_id": null,
			"correlation_id": "req_fingerprint",
			"entity_ids": {{ "message_id": null, "tool_call_id": null, "source_envelope_id": null, "artifact_id": null, "assemble_id": null, "context_item_ids": [], "trace_id": null, "error_id": null, "provider_event_id": null }},
			"visibility": {{ "model": true, "transcript": false, "recall": false, "assemble": false, "share": false, "debug": true }},
			"redaction": "public",
			"payload": {payload},
			"artifact": null
		}}"#,
		);
		serde_json::from_str(&json).unwrap()
	}

	#[test]
	fn fingerprint_is_deterministic_for_identical_requests() {
		let a = make_request("idem-1", serde_json::json!({ "k": "v" }));
		let b = make_request("idem-1", serde_json::json!({ "k": "v" }));
		assert_eq!(fingerprint(&a).unwrap(), fingerprint(&b).unwrap());
	}

	#[test]
	fn fingerprint_differs_when_payload_differs() {
		let a = make_request("idem-1", serde_json::json!({ "k": "v" }));
		let b = make_request("idem-1", serde_json::json!({ "k": "different" }));
		assert_ne!(fingerprint(&a).unwrap(), fingerprint(&b).unwrap());
	}

	#[test]
	fn classify_same_fingerprint_is_replay() {
		let a = make_request("idem-1", serde_json::json!({ "k": "v" }));
		let fp = fingerprint(&a).unwrap();
		assert_eq!(classify(&fp, &fp), IdempotencyOutcome::Replay);
	}

	#[test]
	fn classify_different_fingerprint_is_conflict() {
		assert_eq!(classify("aaaa", "bbbb"), IdempotencyOutcome::Conflict);
	}
}
