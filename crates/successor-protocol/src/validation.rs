//! Slice 0 canonical fixture bundle validator (A5).
//!
//! Composes accepted A1-A4 protocol APIs into a single bundle-level pass over
//! the fixtures exposed by [`crate::fixtures`]. Pure and deterministic: no
//! I/O, clocks, randomness, or side effects beyond reading the fixture bytes
//! already embedded at compile time by [`crate::fixtures`]. Findings are
//! collected into a [`ProtocolViolationSet`] rather than failing fast
//! wherever the underlying accepted APIs allow it.
//!
//! # Scope
//!
//! This validator covers exactly:
//! - Raw-event structural validity (via [`RawEventV0::validate_structure`]) and
//!   dense single-session `session_seq` ordering, for both the successful-turn
//!   and unsupported-tool canonical raw-event streams.
//! - ID prefix validity, reasserted via the accepted `TryFrom<String>`
//!   constructors on every typed ID field a raw event carries.
//! - Artifact hash format (via [`ArtifactHash::parse`]) and, where a raw
//!   event's artifact reference carries inline fixture `content`,
//!   content/byte-length consistency (via [`validate_artifact_content`]).
//! - Provider API shape validity, via the dedicated
//!   [`ProviderShapeNormalizationFixtureV0::validate`] report.
//! - Tool-catalog validity: schema version and non-empty, non-blank tool
//!   entries.
//! - Successful-turn replay-projection match against the expected projection
//!   bytes, via [`project_session`] + [`to_canonical_projection_json_bytes`].
//! - **Causation and future references.** `causation_event_id`, when present,
//!   must name a strictly earlier event in the same session
//!   ([`ProtocolViolationCode::CausationViolation`]). The forward-pointing
//!   entity references carried in `entity_ids` -- `source_envelope_id`,
//!   `artifact_id`, `assemble_id`, `context_item_ids`, and `trace_id` -- must
//!   each resolve to an entity first introduced at or before the referencing
//!   event ([`ProtocolViolationCode::FutureReference`]).
//! - **Duplicate idempotency keys.** `idempotency_key` is unique per
//!   `session_id`: a canonical raw-event stream represents already-persisted
//!   append results, and the platform dedupes repeated-key appends into the
//!   existing event rather than creating a new one. Two distinct events sharing
//!   an `idempotency_key` within one session is therefore an impossible
//!   persisted state ([`ProtocolViolationCode::DuplicateIdempotencyKey`]).
//! - **Credential leakage.** Raw-event `payload` bodies and inline artifact
//!   `content` are scanned for credential-shaped keys and high-confidence
//!   credential value patterns ([`ProtocolViolationCode::CredentialLeakage`]).
//!   The same scan, plus a defense-in-depth reassertion of every typed ID
//!   field's prefix (mirroring [`check_raw_event_id_prefixes`]), also covers
//!   the two `assemble-response-*.json` fixtures' typed [`AssemblyResponseV0`]
//!   accessors ([`crate::fixtures::assemble_response_pre_tool`],
//!   [`crate::fixtures::assemble_response_post_read`]).
//! - **Unsupported-tool lifecycle.** The `raw-events-unsupported-tool.json`
//!   stream's `provider_tool_call.observed` -> `tool_call.requested` ->
//!   `tool_call.rejected` -> `error.recorded` chain is checked for exactly-once
//!   coverage, in-order `session_seq`, causation chaining between consecutive
//!   lifecycle events, a consistent `tool_call_id`/tool name across all four
//!   events, a shared `error_id` between the rejection and the recorded error,
//!   and that the referenced tool is present in the tool catalog with a
//!   non-executable status (via [`validate_unsupported_tool_lifecycle`]).
//!
//! # Out of scope
//!
//! - **Unsupported-tool lifecycle *projection* semantics.** Distinct from the
//!   raw-event chain checked by [`validate_unsupported_tool_lifecycle`]:
//!   whether the unsupported-tool stream can be projected into a
//!   [`SessionProjectionV0`] at all is pending A2 adjudication. This module
//!   only asserts that [`project_session`] rejects it, and treats that
//!   rejection as expected, not a bundle failure.

use std::collections::HashMap;

use crate::{
	artifact::{ArtifactHash, ArtifactV0, validate_artifact_content},
	canonical_json::to_canonical_projection_json_bytes,
	error::{ProtocolViolation, ProtocolViolationCode, ProtocolViolationSet},
	fixtures,
	ids::{
		ArtifactId, AssembleId, ContextItemId, ErrorId, EventId, MessageId, ProviderEventId,
		RequestId, SessionId, SourceEnvelopeId, ToolCallId, TraceId, TurnId,
	},
	platform_api::AssemblyResponseV0,
	projection::SessionProjectionV0,
	provider_shape_fixture::ProviderShapeNormalizationFixtureV0,
	raw_event::{RawEventArtifactRef, RawEventType, RawEventV0},
	replay::project_session,
	tool_catalog::{TOOL_CATALOG_SCHEMA_VERSION, ToolCatalogV0, ToolStatusV0},
};

/// Result of a bundle-level validation check: `Ok(())` when clean, or every
/// collected [`ProtocolViolation`] otherwise.
pub type FixtureValidationResult = Result<(), ProtocolViolationSet>;

/// Folds a `Vec` of findings into a [`FixtureValidationResult`]. An empty
/// `Vec` is success; a non-empty `Vec` becomes a [`ProtocolViolationSet`].
fn collect(violations: Vec<ProtocolViolation>) -> FixtureValidationResult {
	let mut iter = violations.into_iter();
	let Some(first) = iter.next() else {
		return Ok(());
	};
	let mut set = ProtocolViolationSet::from_one(first);
	for violation in iter {
		set.push(violation);
	}
	Err(set)
}

/// Appends every violation from `result` (if any) onto `violations`, for
/// composing multiple checks into one bundle-level result.
fn extend(violations: &mut Vec<ProtocolViolation>, result: FixtureValidationResult) {
	if let Err(set) = result {
		violations.extend(set.violations().iter().cloned());
	}
}

/// Reasserts ID prefix validity via the accepted `TryFrom<String>`
/// constructor for `T`. Every ID field on a canonically parsed [`RawEventV0`]
/// has already passed through this exact constructor during deserialization,
/// so this only fires for values assembled by hand (e.g. adversarial mutation
/// tests) that bypass the deserializer.
fn recheck_id_prefix<T>(raw: &str) -> Result<(), ProtocolViolation>
where
	T: TryFrom<String, Error = ProtocolViolation>,
{
	T::try_from(raw.to_owned()).map(|_| ())
}

/// Reasserts ID prefix validity for every typed ID field a raw event carries.
fn check_raw_event_id_prefixes(violations: &mut Vec<ProtocolViolation>, event: &RawEventV0) {
	let mut push = |result: Result<(), ProtocolViolation>| {
		if let Err(v) = result {
			violations.push(v);
		}
	};

	push(recheck_id_prefix::<SessionId>(event.session_id.as_str()));
	push(recheck_id_prefix::<EventId>(event.event_id.as_str()));
	push(recheck_id_prefix::<RequestId>(event.request_id.as_str()));
	push(recheck_id_prefix::<RequestId>(event.correlation_id.as_str()));
	if let Some(turn_id) = &event.turn_id {
		push(recheck_id_prefix::<TurnId>(turn_id.as_str()));
	}
	if let Some(causation_event_id) = &event.causation_event_id {
		push(recheck_id_prefix::<EventId>(causation_event_id.as_str()));
	}

	let entity_ids = &event.entity_ids;
	if let Some(id) = &entity_ids.message_id {
		push(recheck_id_prefix::<MessageId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.tool_call_id {
		push(recheck_id_prefix::<ToolCallId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.source_envelope_id {
		push(recheck_id_prefix::<SourceEnvelopeId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.artifact_id {
		push(recheck_id_prefix::<ArtifactId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.assemble_id {
		push(recheck_id_prefix::<AssembleId>(id.as_str()));
	}
	for id in &entity_ids.context_item_ids {
		push(recheck_id_prefix::<ContextItemId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.trace_id {
		push(recheck_id_prefix::<TraceId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.error_id {
		push(recheck_id_prefix::<ErrorId>(id.as_str()));
	}
	if let Some(id) = &entity_ids.provider_event_id {
		push(recheck_id_prefix::<ProviderEventId>(id.as_str()));
	}

	if let Some(artifact) = &event.artifact
		&& let Some(id) = &artifact.artifact_id
	{
		push(recheck_id_prefix::<ArtifactId>(id.as_str()));
	}
}

/// Reasserts artifact hash format (via [`ArtifactHash::parse`]) and, when the
/// artifact reference carries inline fixture `content`, content/byte-length
/// consistency (via [`validate_artifact_content`]). Artifact refs without
/// inline content can only have their hash format reasserted: byte-for-byte
/// consistency needs the actual bytes, which canonical fixtures do not always
/// inline.
fn check_raw_event_artifact(
	violations: &mut Vec<ProtocolViolation>,
	artifact: &RawEventArtifactRef,
) {
	if let Err(v) = ArtifactHash::parse(artifact.sha256.as_str().to_owned()) {
		violations.push(v);
	}
	if let Some(content) = &artifact.content
		&& let Err(v) = validate_artifact_content(
			artifact.sha256.as_str(),
			artifact.byte_length,
			content.as_bytes(),
		) {
		violations.push(v);
	}
}

/// Dense single-session `session_seq` ordering: a raw-event stream must be
/// sorted, gap-free, 1-based, and scoped to exactly one `session_id`.
///
/// No accepted A1-A4 module exposes this as a public check
/// ([`crate::replay`]'s equivalent is a private helper used inside
/// [`project_session`]), so it is reimplemented here against the identical
/// semantics, reading only public [`RawEventV0`] fields.
fn check_dense_single_session_sequencing(
	violations: &mut Vec<ProtocolViolation>,
	events: &[RawEventV0],
) {
	let Some(first) = events.first() else {
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ReplayMismatch,
			"raw-event stream must not be empty",
		));
		return;
	};

	for (index, event) in events.iter().enumerate() {
		let expected_seq = index as u64 + 1;
		if event.session_seq != expected_seq {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ReplayMismatch,
				format!(
					"raw-event stream must be sorted and dense by session_seq: expected \
					 {expected_seq}, got {}",
					event.session_seq
				),
			));
		}
		if event.session_id != first.session_id {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ReplayMismatch,
				"raw-event stream must not contain more than one session_id",
			));
		}
	}
}

/// Checks that `causation_event_id` and forward-pointing entity references
/// never name an event/entity that has not yet been produced in the stream.
///
/// - `causation_event_id`, when present, must name an event with a strictly
///   smaller `session_seq` than the referencing event
///   ([`ProtocolViolationCode::CausationViolation`]).
/// - `entity_ids.source_envelope_id`, `entity_ids.artifact_id`,
///   `entity_ids.assemble_id`, `entity_ids.context_item_ids`, and
///   `entity_ids.trace_id`, when present, must name an entity first introduced
///   at or before the referencing event's `session_seq`
///   ([`ProtocolViolationCode::FutureReference`]). An entity's introduction
///   point is the `session_seq` of its *producer* event: turn-recording events
///   introduce `source_envelope_id`; events carrying an inline `artifact` body
///   introduce `artifact_id`; `assembly.requested` introduces `assemble_id`;
///   `assembly.completed` introduces `context_item_ids`; provider
///   request/response events introduce their own `trace_id`. All other
///   appearances are references and must resolve to a producer at or before the
///   referencing event's `session_seq`.
fn check_causation_and_future_references(
	violations: &mut Vec<ProtocolViolation>,
	events: &[RawEventV0],
) {
	let event_seq_by_id: HashMap<&EventId, u64> = events
		.iter()
		.map(|event| (&event.event_id, event.session_seq))
		.collect();

	let source_envelope_intro = earliest_introduction(events.iter().filter_map(|event| {
		matches!(
			event.event_type,
			RawEventType::UserTurnRecorded
				| RawEventType::AssistantTurnRecorded
				| RawEventType::ToolResultRecorded
				| RawEventType::ProviderResponseRecorded
		)
		.then(|| {
			event
				.entity_ids
				.source_envelope_id
				.as_ref()
				.map(|id| (id, event.session_seq))
		})
		.flatten()
	}));
	let artifact_intro = earliest_introduction(events.iter().flat_map(|event| {
		let mut intros: Vec<(&ArtifactId, u64)> = Vec::new();
		if let Some(artifact) = &event.artifact {
			if let Some(id) = &artifact.artifact_id {
				intros.push((id, event.session_seq));
			}
			if let Some(id) = &event.entity_ids.artifact_id {
				intros.push((id, event.session_seq));
			}
		}
		intros
	}));
	let assemble_intro = earliest_introduction(events.iter().filter_map(|event| {
		(event.event_type == RawEventType::AssemblyRequested)
			.then(|| {
				event
					.entity_ids
					.assemble_id
					.as_ref()
					.map(|id| (id, event.session_seq))
			})
			.flatten()
	}));
	let trace_intro = earliest_introduction(events.iter().filter_map(|event| {
		matches!(
			event.event_type,
			RawEventType::AssemblyRequested
				| RawEventType::ProviderRequestBuilt
				| RawEventType::ProviderResponseRecorded
		)
		.then(|| {
			event
				.entity_ids
				.trace_id
				.as_ref()
				.map(|id| (id, event.session_seq))
		})
		.flatten()
	}));
	let context_item_intro = earliest_introduction(events.iter().flat_map(|event| {
		let seq = event.session_seq;
		let is_producer = event.event_type == RawEventType::AssemblyCompleted;
		event
			.entity_ids
			.context_item_ids
			.iter()
			.filter(move |_| is_producer)
			.map(move |id| (id, seq))
	}));

	for event in events {
		if let Some(causation_id) = &event.causation_event_id {
			match event_seq_by_id.get(causation_id) {
				Some(&seq) if seq < event.session_seq => {},
				Some(_) => violations.push(ProtocolViolation::new(
					ProtocolViolationCode::CausationViolation,
					format!(
						"event {} causation_event_id {causation_id} does not reference a strictly \
						 earlier event in the same session",
						event.event_id
					),
				)),
				None => violations.push(ProtocolViolation::new(
					ProtocolViolationCode::CausationViolation,
					format!(
						"event {} causation_event_id {causation_id} does not reference any event in \
						 this stream",
						event.event_id
					),
				)),
			}
		}

		check_not_forward_reference(
			violations,
			event,
			event.entity_ids.source_envelope_id.as_ref(),
			&source_envelope_intro,
			"source_envelope_id",
		);
		check_not_forward_reference(
			violations,
			event,
			event.entity_ids.artifact_id.as_ref(),
			&artifact_intro,
			"artifact_id",
		);
		check_not_forward_reference(
			violations,
			event,
			event.entity_ids.assemble_id.as_ref(),
			&assemble_intro,
			"assemble_id",
		);
		check_not_forward_reference(
			violations,
			event,
			event.entity_ids.trace_id.as_ref(),
			&trace_intro,
			"trace_id",
		);
		for context_item_id in &event.entity_ids.context_item_ids {
			check_not_forward_reference(
				violations,
				event,
				Some(context_item_id),
				&context_item_intro,
				"context_item_id",
			);
		}
	}
}

/// Builds a map from entity ID to the smallest `session_seq` at which it is
/// introduced (first appears) across a raw-event stream.
fn earliest_introduction<'a, T: Eq + std::hash::Hash>(
	ids: impl Iterator<Item = (&'a T, u64)>,
) -> HashMap<&'a T, u64> {
	let mut first_seen: HashMap<&'a T, u64> = HashMap::new();
	for (id, seq) in ids {
		first_seen.entry(id).or_insert(seq);
	}
	first_seen
}

/// Pushes a [`ProtocolViolationCode::FutureReference`] violation if
/// `referenced` is `Some` and was not introduced at or before `event`.
fn check_not_forward_reference<T: Eq + std::hash::Hash + std::fmt::Display>(
	violations: &mut Vec<ProtocolViolation>,
	event: &RawEventV0,
	referenced: Option<&T>,
	introduced_at: &HashMap<&T, u64>,
	field_name: &str,
) {
	let Some(id) = referenced else { return };
	match introduced_at.get(id) {
		Some(&seq) if seq <= event.session_seq => {},
		_ => violations.push(ProtocolViolation::new(
			ProtocolViolationCode::FutureReference,
			format!(
				"event {} references {field_name} {id} that is not introduced at or before this event",
				event.event_id
			),
		)),
	}
}

/// Per-session uniqueness of `idempotency_key`.
///
/// A canonical raw-event stream represents already-persisted append results:
/// the platform treats `idempotency_key` as unique per `session_id`, and a
/// duplicate-key append returns the existing event's result rather than
/// creating a new one. Two distinct, differently-identified events sharing an
/// `idempotency_key` within one session therefore describes an impossible
/// persisted state.
fn check_duplicate_idempotency_keys(
	violations: &mut Vec<ProtocolViolation>,
	events: &[RawEventV0],
) {
	let mut first_seen: HashMap<&str, &EventId> = HashMap::new();
	for event in events {
		let key = event.idempotency_key.as_str();
		if let Some(&first_event_id) = first_seen.get(key) {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::DuplicateIdempotencyKey,
				format!(
					"idempotency_key '{key}' is reused by event {} (first used by event \
					 {first_event_id}); a persisted raw-event stream must not contain two distinct \
					 events sharing an idempotency_key within a session",
					event.event_id
				),
			));
		} else {
			first_seen.insert(key, &event.event_id);
		}
	}
}

/// High-confidence credential-shaped key substrings, matched
/// case-insensitively against JSON object keys. Mirrors
/// `provider_shape_fixture`'s private scanner vocabulary so raw-event
/// payload/content scanning stays consistent with the accepted provider
/// shape fixture check, without depending on that module's private helpers.
const CREDENTIAL_KEY_PATTERNS: &[&str] = &[
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"secret",
	"password",
	"memex_license",
	"memex_licence",
	"refresh_token",
	"access_token",
	"auth_token",
	"client_secret",
];

/// High-confidence credential-shaped value substrings, matched
/// case-insensitively against JSON string values.
const CREDENTIAL_VALUE_PATTERNS: &[&str] = &[
	"memex_license",
	"memex_licence",
	"authorization: bearer",
	"sk-ant-api",
	"sk-proj-",
	"refresh_token",
	"access_token",
	"client_secret",
];

/// Recursively scans a JSON value for credential-shaped field names and
/// high-confidence credential string values.
fn scan_value_for_credentials(
	violations: &mut Vec<ProtocolViolation>,
	value: &serde_json::Value,
	path: &str,
) {
	match value {
		serde_json::Value::Object(map) => {
			for (key, child) in map {
				let key_lower = key.to_lowercase();
				let full_path = if path.is_empty() {
					key.clone()
				} else {
					format!("{path}.{key}")
				};
				if CREDENTIAL_KEY_PATTERNS
					.iter()
					.any(|pattern| key_lower.contains(pattern))
				{
					violations.push(ProtocolViolation::new(
						ProtocolViolationCode::CredentialLeakage,
						format!("credential-looking key `{key}` found at path `{full_path}`"),
					));
				}
				scan_value_for_credentials(violations, child, &full_path);
			}
		},
		serde_json::Value::Array(items) => {
			for (index, item) in items.iter().enumerate() {
				scan_value_for_credentials(violations, item, &format!("{path}[{index}]"));
			}
		},
		serde_json::Value::String(text) => {
			let text_lower = text.to_lowercase();
			if CREDENTIAL_VALUE_PATTERNS
				.iter()
				.any(|pattern| text_lower.contains(pattern))
			{
				violations.push(ProtocolViolation::new(
					ProtocolViolationCode::CredentialLeakage,
					format!("credential-looking value found at path `{path}`"),
				));
			}
		},
		_ => {},
	}
}

/// Scans a raw event's `payload` and, when present, its artifact's inline
/// `content` for credential-shaped keys/values.
fn check_raw_event_credentials(violations: &mut Vec<ProtocolViolation>, event: &RawEventV0) {
	scan_value_for_credentials(violations, &event.payload, &format!("{}.payload", event.event_id));
	if let Some(artifact) = &event.artifact
		&& let Some(content) = &artifact.content
	{
		let content_lower = content.to_lowercase();
		if CREDENTIAL_VALUE_PATTERNS
			.iter()
			.any(|pattern| content_lower.contains(pattern))
		{
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::CredentialLeakage,
				format!(
					"credential-looking value found in inline artifact content for event {}",
					event.event_id
				),
			));
		}
	}
}

/// Scans a standalone [`ArtifactV0`]'s inline `content` for credential-shaped
/// substrings.
///
/// This is the public, content-scoped entry point onto the same credential
/// pattern vocabulary ([`CREDENTIAL_KEY_PATTERNS`],
/// [`CREDENTIAL_VALUE_PATTERNS`]) [`check_raw_event_credentials`] uses for
/// raw-event `payload`/inline-artifact scanning, for callers (the Context
/// Platform's artifact store) that persist a standalone artifact rather than a
/// full raw event, and so have no `RawEventV0` to hand to the private
/// raw-event-scoped scanner.
///
/// Slice 0 inline artifact content is unstructured text (e.g. a log excerpt,
/// an env dump) with no JSON key structure, so in addition to
/// [`scan_value_for_credentials`]'s value-pattern scanning this rejects
/// assignment-shaped leaks: a [`CREDENTIAL_KEY_PATTERNS`] token immediately
/// followed by `=`/`:` and a secret-like literal value. Bare mentions of
/// credential key words (documentation, or source code such as
/// `api_key = read_config()`) are legitimate tool output and are NOT
/// flagged. This does not alter [`check_raw_event_credentials`] or any other
/// existing scanning path: one scanning implementation and vocabulary, two
/// entry points.
pub fn scan_artifact_content(artifact: &ArtifactV0) -> FixtureValidationResult {
	let mut violations = Vec::new();
	if let Some(content) = &artifact.content {
		scan_value_for_credentials(
			&mut violations,
			content,
			&format!("{}.content", artifact.artifact_id),
		);
		if let serde_json::Value::String(text) = content {
			let text_lower = text.to_lowercase();
			if contains_assignment_shaped_credential(&text_lower) {
				violations.push(ProtocolViolation::new(
					ProtocolViolationCode::CredentialLeakage,
					format!(
						"assignment-shaped credential leak found in artifact {} content",
						artifact.artifact_id
					),
				));
			}
		}
	}
	collect(violations)
}

/// Returns true when lowercased free text contains an assignment-shaped
/// credential leak: a credential key pattern immediately followed by `=` or
/// `:` and a secret-like literal value.
fn contains_assignment_shaped_credential(text_lower: &str) -> bool {
	for pattern in CREDENTIAL_KEY_PATTERNS {
		let mut search_from = 0;
		while let Some(relative) = text_lower[search_from..].find(pattern) {
			let after = search_from + relative + pattern.len();
			let tail = text_lower[after..]
				.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '_')
				.trim_start();
			if let Some(value) = tail.strip_prefix(['=', ':']) {
				let token: String = value
					.trim_start()
					.trim_start_matches(['"', '\''])
					.chars()
					.take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
					.collect();
				if is_secret_like_token(&token) {
					return true;
				}
			}
			search_from = after;
		}
	}
	false
}

/// A literal token is secret-like when it is long, opaque, and not code or
/// placeholder shaped.
fn is_secret_like_token(token: &str) -> bool {
	token.len() >= 16
		&& !token.contains('(')
		&& !token.starts_with('<')
		&& !token.starts_with('$')
		&& !token.starts_with('{')
}

/// Validates one raw-event stream.
///
/// Checks structural validity ([`RawEventV0::validate_structure`]), dense
/// single-session sequencing, ID prefix validity, artifact hash/content
/// consistency, causation/forward-reference soundness, per-session
/// idempotency-key uniqueness, and credential-shaped payload/content scans.
/// Applies to both the successful-turn and unsupported-tool canonical
/// raw-event fixtures.
pub fn validate_raw_event_stream(events: &[RawEventV0]) -> FixtureValidationResult {
	let mut violations = Vec::new();

	check_dense_single_session_sequencing(&mut violations, events);
	check_causation_and_future_references(&mut violations, events);
	check_duplicate_idempotency_keys(&mut violations, events);
	for event in events {
		if let Err(v) = event.validate_structure() {
			violations.push(v);
		}
		check_raw_event_id_prefixes(&mut violations, event);
		check_raw_event_credentials(&mut violations, event);
		if let Some(artifact) = &event.artifact {
			check_raw_event_artifact(&mut violations, artifact);
		}
	}

	collect(violations)
}

/// Provider API shape validity.
///
/// Delegates to the accepted
/// [`ProviderShapeNormalizationFixtureV0::validate`] report, which enforces
/// schema versions, required event types, exactly-once coverage of the three
/// required provider API shapes, and absence of credential-shaped keys.
pub fn validate_provider_shape_normalization(
	fixture: &ProviderShapeNormalizationFixtureV0,
) -> FixtureValidationResult {
	let report = fixture.validate();
	if report.is_ok() {
		return Ok(());
	}

	let mut violations: Vec<ProtocolViolation> = report
		.errors
		.iter()
		.map(|message| {
			ProtocolViolation::new(ProtocolViolationCode::ValidationFailed, message.clone())
		})
		.collect();
	if violations.is_empty() {
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			"provider shape normalization fixture failed validation with no recorded error messages",
		));
	}

	collect(violations)
}

/// Tool-catalog validity: schema version matches the accepted constant, and
/// every tool definition has a non-blank `name` and `category`.
pub fn validate_tool_catalog(catalog: &ToolCatalogV0) -> FixtureValidationResult {
	let mut violations = Vec::new();

	if catalog.schema_version != TOOL_CATALOG_SCHEMA_VERSION {
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			format!(
				"tool catalog schema_version must be '{TOOL_CATALOG_SCHEMA_VERSION}', got '{}'",
				catalog.schema_version
			),
		));
	}
	if catalog.tools.is_empty() {
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			"tool catalog must contain at least one tool definition",
		));
	}
	for tool in &catalog.tools {
		if tool.name.trim().is_empty() {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				"tool definition name must not be blank",
			));
		}
		if tool.category.trim().is_empty() {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!("tool definition '{}' category must not be blank", tool.name),
			));
		}
	}

	collect(violations)
}

/// Successful-turn replay-projection match.
///
/// Replays `events` through the accepted [`project_session`] pass and
/// compares its canonical JSON bytes against `expected_projection`'s
/// canonical JSON bytes byte-for-byte.
pub fn validate_successful_turn_replay(
	events: &[RawEventV0],
	expected_projection: &SessionProjectionV0,
) -> FixtureValidationResult {
	let projected = match project_session(events) {
		Ok(projection) => projection,
		Err(violation) => return Err(ProtocolViolationSet::from_one(violation)),
	};
	let actual_bytes = match to_canonical_projection_json_bytes(&projected) {
		Ok(bytes) => bytes,
		Err(violation) => return Err(ProtocolViolationSet::from_one(violation)),
	};
	let expected_bytes = match to_canonical_projection_json_bytes(expected_projection) {
		Ok(bytes) => bytes,
		Err(violation) => return Err(ProtocolViolationSet::from_one(violation)),
	};

	if actual_bytes == expected_bytes {
		Ok(())
	} else {
		Err(ProtocolViolationSet::from_one(ProtocolViolation::new(
			ProtocolViolationCode::ReplayMismatch,
			"replayed successful-turn projection does not match the expected projection's canonical \
			 bytes",
		)))
	}
}

/// Asserts that the unsupported-tool raw-event stream is rejected by replay.
///
/// Unsupported-tool lifecycle projection semantics are pending A2
/// adjudication; the accepted A4 replay pass rejects `error.recorded` events
/// by design, and that rejection is the expected, in-scope outcome here, not
/// a bundle failure.
pub fn validate_unsupported_tool_projection_is_rejected(
	events: &[RawEventV0],
) -> FixtureValidationResult {
	match project_session(events) {
		Ok(_) => Err(ProtocolViolationSet::from_one(ProtocolViolation::new(
			ProtocolViolationCode::ReplayMismatch,
			"unsupported-tool raw-event stream unexpectedly projected successfully; unsupported-tool \
			 lifecycle projection semantics are pending A2 adjudication and this stream must be \
			 rejected by project_session",
		))),
		Err(_) => Ok(()),
	}
}

/// Validates the unsupported-tool raw-event lifecycle.
///
/// Checks the `provider_tool_call.observed` -> `tool_call.requested` ->
/// `tool_call.rejected` -> `error.recorded` chain for a catalog-visible,
/// non-executable tool.
///
/// In addition to [`validate_raw_event_stream`]'s structural checks, this
/// asserts:
/// - Each of the four lifecycle event types appears exactly once, in that exact
///   order by `session_seq`.
/// - Each lifecycle event's `causation_event_id` points at the immediately
///   preceding lifecycle event.
/// - `entity_ids.tool_call_id` and the tool name (`payload.tool_name`, or, for
///   `error.recorded`, `payload.details.tool_name`) are identical and non-null
///   across all four events.
/// - `tool_call.rejected` and `error.recorded` share one non-null
///   `entity_ids.error_id`.
/// - The referenced tool is present in `catalog` and its status is not
///   [`ToolStatusV0::Executable`] (catalog-visible but non-executable).
pub fn validate_unsupported_tool_lifecycle(
	events: &[RawEventV0],
	catalog: &ToolCatalogV0,
) -> FixtureValidationResult {
	let mut violations = Vec::new();

	let expected_order = [
		RawEventType::ProviderToolCallObserved,
		RawEventType::ToolCallRequested,
		RawEventType::ToolCallRejected,
		RawEventType::ErrorRecorded,
	];

	let mut lifecycle_events: Vec<&RawEventV0> = Vec::with_capacity(expected_order.len());
	for expected_type in &expected_order {
		let matches: Vec<&RawEventV0> = events
			.iter()
			.filter(|event| &event.event_type == expected_type)
			.collect();
		match matches.len() {
			1 => lifecycle_events.push(matches[0]),
			0 => violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!("unsupported-tool lifecycle stream is missing a `{expected_type}` event"),
			)),
			count => violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!(
					"unsupported-tool lifecycle stream must carry exactly one `{expected_type}` event, \
					 found {count}"
				),
			)),
		}
	}

	if lifecycle_events.len() != expected_order.len() {
		return collect(violations);
	}

	for window in lifecycle_events.windows(2) {
		let previous = window[0];
		let current = window[1];
		if previous.session_seq >= current.session_seq {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!(
					"unsupported-tool lifecycle event `{}` (seq {}) must occur strictly after `{}` \
					 (seq {})",
					current.event_type, current.session_seq, previous.event_type, previous.session_seq
				),
			));
		}
		if current.causation_event_id.as_ref() != Some(&previous.event_id) {
			violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!(
					"unsupported-tool lifecycle event `{}` must set causation_event_id to the \
					 immediately preceding `{}` event `{}`",
					current.event_type, previous.event_type, previous.event_id
				),
			));
		}
	}

	let rejected = lifecycle_events[2];
	let error_recorded = lifecycle_events[3];

	let tool_call_ids: Vec<Option<&ToolCallId>> = lifecycle_events
		.iter()
		.map(|event| event.entity_ids.tool_call_id.as_ref())
		.collect();
	if tool_call_ids[0].is_none() || tool_call_ids.iter().any(|id| *id != tool_call_ids[0]) {
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			"unsupported-tool lifecycle events must share one non-null entity_ids.tool_call_id",
		));
	}

	let tool_names: Vec<Option<&str>> = lifecycle_events
		.iter()
		.map(|event| payload_tool_name(&event.payload))
		.collect();
	if tool_names[0].is_none() || tool_names.iter().any(|name| *name != tool_names[0]) {
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			"unsupported-tool lifecycle events must share one non-null tool name across \
			 payload.tool_name (or payload.details.tool_name for error.recorded)",
		));
	}

	if rejected.entity_ids.error_id.is_none()
		|| rejected.entity_ids.error_id != error_recorded.entity_ids.error_id
	{
		violations.push(ProtocolViolation::new(
			ProtocolViolationCode::ValidationFailed,
			"tool_call.rejected and error.recorded must share one non-null entity_ids.error_id",
		));
	}

	if let Some(tool_name) = tool_names[0] {
		match catalog.tools.iter().find(|tool| tool.name == tool_name) {
			None => violations.push(ProtocolViolation::new(
				ProtocolViolationCode::ValidationFailed,
				format!(
					"unsupported-tool lifecycle references tool `{tool_name}` which is not present in \
					 the tool catalog"
				),
			)),
			Some(tool) if tool.status == ToolStatusV0::Executable => {
				violations.push(ProtocolViolation::new(
					ProtocolViolationCode::ValidationFailed,
					format!(
						"unsupported-tool lifecycle references tool `{tool_name}` but the tool catalog \
						 marks it executable; the rejected-tool lifecycle only applies to \
						 catalog-visible, non-executable tools"
					),
				));
			},
			Some(_) => {},
		}
	}

	collect(violations)
}

/// Reads a raw event payload's tool name, checking the common top-level
/// `tool_name` field first and falling back to `details.tool_name` (the
/// shape `error.recorded` events use to carry tool context).
fn payload_tool_name(payload: &serde_json::Value) -> Option<&str> {
	if let Some(name) = payload.get("tool_name").and_then(serde_json::Value::as_str) {
		return Some(name);
	}
	payload.get("details")?.get("tool_name")?.as_str()
}

/// Reasserts ID prefix validity and scans for credential leakage.
///
/// Reasserts ID prefix validity for every typed ID field an
/// [`AssemblyResponseV0`] carries (mirroring `check_raw_event_id_prefixes`'s
/// defense-in-depth pattern via [`recheck_id_prefix`]) and scans the fully
/// serialized response for credential-shaped keys/values via
/// [`scan_value_for_credentials`]. Covers both canonical
/// `assemble-response-{pre-tool,post-read}.json` fixtures through their
/// typed [`crate::fixtures::assemble_response_pre_tool`] /
/// [`crate::fixtures::assemble_response_post_read`] accessors.
pub fn validate_assembly_response(response: &AssemblyResponseV0) -> FixtureValidationResult {
	let mut violations = Vec::new();
	{
		let mut push = |result: Result<(), ProtocolViolation>| {
			if let Err(violation) = result {
				violations.push(violation);
			}
		};
		push(recheck_id_prefix::<AssembleId>(response.assemble_id.as_str()));
		push(recheck_id_prefix::<SessionId>(response.session_id.as_str()));
		push(recheck_id_prefix::<TurnId>(response.turn_id.as_str()));
		push(recheck_id_prefix::<RequestId>(response.request_id.as_str()));
		push(recheck_id_prefix::<AssembleId>(response.trace.assemble_id.as_str()));
		push(recheck_id_prefix::<TraceId>(response.trace.trace_id.as_str()));
		for item in &response.context_items {
			push(recheck_id_prefix::<ContextItemId>(item.context_item_id.as_str()));
			push(recheck_id_prefix::<SourceEnvelopeId>(item.source_envelope_id.as_str()));
			push(recheck_id_prefix::<ArtifactId>(item.artifact_id.as_str()));
		}
	}

	let response_json = serde_json::to_value(response).expect(
		"AssemblyResponseV0 always serializes: no non-string map keys, no NaN/Infinity floats",
	);
	scan_value_for_credentials(
		&mut violations,
		&response_json,
		&format!("assembly_response.{}", response.assemble_id.as_str()),
	);

	collect(violations)
}

/// Validates the entire Slice 0 canonical fixture bundle.
///
/// Sourced from [`crate::fixtures`]. Pure and deterministic. Collects every
/// violation across every in-scope check rather than failing on the first
/// one; see the module docs for what is covered and what is intentionally
/// out of scope.
pub fn validate_fixture_bundle() -> FixtureValidationResult {
	let mut violations = Vec::new();

	let successful_turn = fixtures::raw_events_successful_turn();
	extend(&mut violations, validate_raw_event_stream(&successful_turn));
	extend(
		&mut violations,
		validate_successful_turn_replay(&successful_turn, &fixtures::expected_session_projection()),
	);

	let catalog = fixtures::tool_catalog();

	let unsupported_tool = fixtures::raw_events_unsupported_tool();
	extend(&mut violations, validate_raw_event_stream(&unsupported_tool));
	extend(&mut violations, validate_unsupported_tool_projection_is_rejected(&unsupported_tool));
	extend(&mut violations, validate_unsupported_tool_lifecycle(&unsupported_tool, &catalog));

	extend(
		&mut violations,
		validate_provider_shape_normalization(&fixtures::provider_shape_normalization()),
	);

	extend(&mut violations, validate_tool_catalog(&catalog));

	extend(&mut violations, validate_assembly_response(&fixtures::assemble_response_pre_tool()));
	extend(&mut violations, validate_assembly_response(&fixtures::assemble_response_post_read()));

	collect(violations)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn assignment_shaped_credential_detection_flags_real_leaks_only() {
		assert!(contains_assignment_shaped_credential(
			"aws_secret_access_key=wjalrxutnfemik7mdengbpxrficyexamplekey"
		));
		assert!(contains_assignment_shaped_credential("api_key: wjalrxutnfemik7mdengbpxrficy"));
		assert!(!contains_assignment_shaped_credential(
			"the api_key parameter controls request auth"
		));
		assert!(!contains_assignment_shaped_credential("let api_key = read_config();"));
		assert!(!contains_assignment_shaped_credential("password: <your-password-here>"));
		assert!(!contains_assignment_shaped_credential(
			"client_secret documentation and secret handling notes"
		));
	}

	#[test]
	fn canonical_fixture_bundle_validates_clean() {
		assert_eq!(validate_fixture_bundle(), Ok(()));
	}

	#[test]
	fn canonical_assembly_responses_validate_clean() {
		assert_eq!(validate_assembly_response(&fixtures::assemble_response_pre_tool()), Ok(()));
		assert_eq!(validate_assembly_response(&fixtures::assemble_response_post_read()), Ok(()));
	}

	#[test]
	fn assembly_response_credential_injection_is_rejected() {
		let mut response = fixtures::assemble_response_post_read();
		assert!(
			!response.context_items.is_empty(),
			"canonical post_read fixture must carry a context item to mutate"
		);
		response.context_items[0].rendered_text =
			"leaked access_token=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_owned();

		let result = validate_assembly_response(&response);
		assert!(result.is_err(), "a credential-shaped rendered_text must be rejected");
		assert!(
			result
				.unwrap_err()
				.violations()
				.iter()
				.any(|v| v.code == ProtocolViolationCode::CredentialLeakage),
			"rejection must be attributed to CredentialLeakage"
		);
	}

	#[test]
	fn canonical_successful_turn_stream_validates_clean() {
		assert_eq!(validate_raw_event_stream(&fixtures::raw_events_successful_turn()), Ok(()));
	}

	#[test]
	fn canonical_unsupported_tool_stream_validates_clean() {
		assert_eq!(validate_raw_event_stream(&fixtures::raw_events_unsupported_tool()), Ok(()));
	}

	#[test]
	fn canonical_unsupported_tool_stream_is_rejected_by_project_session() {
		assert_eq!(
			validate_unsupported_tool_projection_is_rejected(&fixtures::raw_events_unsupported_tool()),
			Ok(())
		);
	}

	#[test]
	fn canonical_unsupported_tool_lifecycle_validates_clean() {
		let events = fixtures::raw_events_unsupported_tool();
		let catalog = fixtures::tool_catalog();
		assert_eq!(validate_unsupported_tool_lifecycle(&events, &catalog), Ok(()));
	}

	#[test]
	fn canonical_provider_shape_normalization_validates_clean() {
		assert_eq!(
			validate_provider_shape_normalization(&fixtures::provider_shape_normalization()),
			Ok(())
		);
	}

	#[test]
	fn canonical_tool_catalog_validates_clean() {
		assert_eq!(validate_tool_catalog(&fixtures::tool_catalog()), Ok(()));
	}

	#[test]
	fn canonical_successful_turn_replays_to_expected_projection() {
		assert_eq!(
			validate_successful_turn_replay(
				&fixtures::raw_events_successful_turn(),
				&fixtures::expected_session_projection()
			),
			Ok(())
		);
	}

	#[test]
	fn gapped_session_seq_is_rejected_as_replay_mismatch() {
		let mut events = fixtures::raw_events_successful_turn();
		let mut second = events[1].clone();
		second = RawEventV0 { session_seq: second.session_seq + 1, ..second };
		events[1] = second;

		let result = validate_raw_event_stream(&events);
		let Err(violations) = result else {
			panic!("expected a gapped session_seq to be rejected");
		};
		assert!(
			violations
				.violations()
				.iter()
				.any(|v| v.code == ProtocolViolationCode::ReplayMismatch)
		);
	}

	#[test]
	fn duplicated_session_seq_is_rejected_as_replay_mismatch() {
		let mut events = fixtures::raw_events_successful_turn();
		let first_seq = events[0].session_seq;
		events[1] = RawEventV0 { session_seq: first_seq, ..events[1].clone() };

		let result = validate_raw_event_stream(&events);
		let Err(violations) = result else {
			panic!("expected a duplicated session_seq to be rejected");
		};
		assert!(
			violations
				.violations()
				.iter()
				.any(|v| v.code == ProtocolViolationCode::ReplayMismatch)
		);
	}
}
