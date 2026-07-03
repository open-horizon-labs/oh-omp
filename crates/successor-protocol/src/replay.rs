//! Pure deterministic replay from raw events into session projections.

use std::collections::HashMap;

use crate::{
	error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode},
	ids::{ArtifactId, EventId, ToolCallId},
	projection::{
		ArtifactProjectionV0, AssemblyProjectionV0, EXPECTED_PROJECTION_SCHEMA_VERSION, MessageRole,
		PROJECTION_VERSION, ProviderTraceProjectionV0, SessionProjectionV0, SessionSummaryV0,
		ToolCallProjectionV0, ToolCallStatus, TranscriptEntryV0,
	},
	provider::ProviderApiShapeV0,
	raw_event::{RAW_EVENT_SCHEMA_VERSION, RawEventType, RawEventV0},
};

#[derive(Debug, Default)]
struct ToolState {
	tool_name:          Option<String>,
	requested_event_id: Option<EventId>,
	result_event_id:    Option<EventId>,
	completed_event_id: Option<EventId>,
	artifact_id:        Option<ArtifactId>,
}

/// Project a single-session raw-event stream into the Slice 0 expected
/// projection.
///
/// This function is intentionally pure: callers supply already-recorded raw
/// events and inline artifact metadata; replay never reads files, calls
/// tools/providers, uses clocks, or generates IDs.
pub fn project_session(events: &[RawEventV0]) -> ProtocolResult<SessionProjectionV0> {
	validate_event_order(events)?;

	let first = events
		.first()
		.ok_or_else(|| violation("cannot project an empty raw-event stream"))?;
	let session_id = first.session_id.clone();
	let last_raw_event_seq = events.last().map_or(0, |event| event.session_seq);
	let last_turn_id = events
		.iter()
		.rev()
		.find_map(|event| event.turn_id.clone())
		.ok_or_else(|| violation("projection requires at least one turn-scoped raw event"))?;

	let mut transcript = Vec::new();
	let mut tool_states: HashMap<ToolCallId, ToolState> = HashMap::new();
	let mut tools = Vec::new();
	let mut artifacts = Vec::new();
	let mut assemblies = Vec::new();
	let mut provider_traces = Vec::new();
	let mut last_assistant_summary = None;

	for event in events {
		event.validate_structure()?;
		if event.schema_version != RAW_EVENT_SCHEMA_VERSION {
			return Err(violation("raw event has unsupported schema_version"));
		}
		if event.session_id != session_id {
			return Err(violation("raw-event stream contains more than one session_id"));
		}

		match event.event_type {
			RawEventType::UserTurnRecorded => {
				transcript.push(TranscriptEntryV0 {
					message_id:         event
						.entity_ids
						.message_id
						.clone()
						.ok_or_else(|| violation("user_turn.recorded missing message_id"))?,
					role:               MessageRole::User,
					source_event_id:    event.event_id.clone(),
					source_envelope_id: event
						.entity_ids
						.source_envelope_id
						.clone()
						.ok_or_else(|| violation("user_turn.recorded missing source_envelope_id"))?,
					text:               required_payload_str(event, "text")?.to_owned(),
				});
			},
			RawEventType::AssistantTurnRecorded => {
				let text = required_payload_str(event, "text")?.to_owned();
				last_assistant_summary = Some(required_payload_str(event, "summary")?.to_owned());
				transcript.push(TranscriptEntryV0 {
					message_id: event
						.entity_ids
						.message_id
						.clone()
						.ok_or_else(|| violation("assistant_turn.recorded missing message_id"))?,
					role: MessageRole::Assistant,
					source_event_id: event.event_id.clone(),
					source_envelope_id: event
						.entity_ids
						.source_envelope_id
						.clone()
						.ok_or_else(|| violation("assistant_turn.recorded missing source_envelope_id"))?,
					text,
				});
			},
			RawEventType::ToolCallRequested => {
				let tool_call_id = required_tool_call_id(event)?;
				let state = tool_states.entry(tool_call_id).or_default();
				state.tool_name = Some(required_payload_str(event, "tool_name")?.to_owned());
				state.requested_event_id = Some(event.event_id.clone());
			},
			RawEventType::ToolResultRecorded => {
				let tool_call_id = required_tool_call_id(event)?;
				let state = tool_states.entry(tool_call_id).or_default();
				state.result_event_id = Some(event.event_id.clone());
				state.artifact_id = Some(
					event
						.entity_ids
						.artifact_id
						.clone()
						.ok_or_else(|| violation("tool_result.recorded missing artifact_id"))?,
				);
				if let (Some(artifact), Some(artifact_id)) =
					(&event.artifact, &event.entity_ids.artifact_id)
				{
					artifacts.push(ArtifactProjectionV0 {
						artifact_id:     artifact_id.clone(),
						source_event_id: event.event_id.clone(),
						sha256:          artifact.sha256.clone(),
						byte_length:     artifact.byte_length,
					});
				}
			},
			RawEventType::ToolCallCompleted => {
				let tool_call_id = required_tool_call_id(event)?;
				let state = tool_states.entry(tool_call_id.clone()).or_default();
				state.completed_event_id = Some(event.event_id.clone());
				tools.push(ToolCallProjectionV0 {
					tool_call_id,
					tool_name: state
						.tool_name
						.clone()
						.ok_or_else(|| violation("tool_call.completed before tool_call.requested"))?,
					status: ToolCallStatus::Completed,
					requested_event_id: state
						.requested_event_id
						.clone()
						.ok_or_else(|| violation("tool_call.completed missing requested event"))?,
					result_event_id: state
						.result_event_id
						.clone()
						.ok_or_else(|| violation("tool_call.completed missing result event"))?,
					completed_event_id: state
						.completed_event_id
						.clone()
						.ok_or_else(|| violation("tool_call.completed missing completed event"))?,
					artifact_id: state
						.artifact_id
						.clone()
						.ok_or_else(|| violation("tool_call.completed missing artifact_id"))?,
				});
			},
			RawEventType::AssemblyCompleted => {
				assemblies.push(AssemblyProjectionV0 {
					assemble_id:      event
						.entity_ids
						.assemble_id
						.clone()
						.ok_or_else(|| violation("assembly.completed missing assemble_id"))?,
					phase:            required_payload_str(event, "phase")?.to_owned(),
					context_item_ids: event.entity_ids.context_item_ids.clone(),
				});
			},
			RawEventType::ProviderRequestBuilt => {
				provider_traces.push(ProviderTraceProjectionV0 {
					trace_id:           event
						.entity_ids
						.trace_id
						.clone()
						.ok_or_else(|| violation("provider_request.built missing trace_id"))?,
					phase:              required_payload_str(event, "phase")?.to_owned(),
					provider_id:        required_payload_str(event, "provider_id")?.to_owned(),
					provider_api_shape: required_provider_api_shape(event)?,
					context_item_ids:   event.entity_ids.context_item_ids.clone(),
				});
			},
			RawEventType::ProviderResponseRecorded => {
				provider_traces.push(ProviderTraceProjectionV0 {
					trace_id:           event
						.entity_ids
						.trace_id
						.clone()
						.ok_or_else(|| violation("provider_response.recorded missing trace_id"))?,
					phase:              required_payload_str(event, "phase")?.to_owned(),
					provider_id:        required_payload_str(event, "provider_id")?.to_owned(),
					provider_api_shape: required_provider_api_shape(event)?,
					context_item_ids:   event.entity_ids.context_item_ids.clone(),
				});
			},
			RawEventType::ErrorRecorded => {
				return Err(violation(
					"successful-turn projection does not accept error.recorded events",
				));
			},
			RawEventType::ToolCatalogPublished
			| RawEventType::AssemblyRequested
			| RawEventType::ProviderToolCallObserved
			| RawEventType::ToolCallStarted
			| RawEventType::ToolCallRejected
			| RawEventType::ToolCallFailed => {},
		}
	}

	Ok(SessionProjectionV0 {
		schema_version: EXPECTED_PROJECTION_SCHEMA_VERSION.to_owned(),
		projection_version: PROJECTION_VERSION.to_owned(),
		session: SessionSummaryV0 {
			session_id,
			last_raw_event_seq,
			last_turn_id,
			last_assistant_summary: derive_last_assistant_summary(last_assistant_summary)?,
		},
		transcript,
		tools,
		errors: Vec::new(),
		artifacts,
		assemblies,
		provider_traces,
	})
}

fn validate_event_order(events: &[RawEventV0]) -> ProtocolResult<()> {
	if events.is_empty() {
		return Err(violation("cannot project an empty raw-event stream"));
	}
	for (index, event) in events.iter().enumerate() {
		let expected = index as u64 + 1;
		if event.session_seq != expected {
			return Err(violation(format!(
				"raw-event stream must be sorted and dense by session_seq: expected {expected}, got {}",
				event.session_seq
			)));
		}
	}
	Ok(())
}

fn required_tool_call_id(event: &RawEventV0) -> ProtocolResult<ToolCallId> {
	event
		.entity_ids
		.tool_call_id
		.clone()
		.ok_or_else(|| violation(format!("{} missing tool_call_id", event.event_type)))
}

fn required_payload_str<'a>(event: &'a RawEventV0, key: &str) -> ProtocolResult<&'a str> {
	event
		.payload
		.get(key)
		.and_then(|value| value.as_str())
		.ok_or_else(|| {
			violation(format!("{} payload missing string field `{key}`", event.event_type))
		})
}

fn required_provider_api_shape(event: &RawEventV0) -> ProtocolResult<String> {
	let raw = event
		.payload
		.get("provider_api_shape")
		.and_then(|value| value.as_str())
		.ok_or_else(|| {
			ProtocolViolation::new(
				ProtocolViolationCode::MissingProviderApiShape,
				format!("{} payload missing string field `provider_api_shape`", event.event_type),
			)
		})?;
	let value = serde_json::Value::String(raw.to_owned());
	serde_json::from_value::<ProviderApiShapeV0>(value).map_err(|_| {
		ProtocolViolation::new(
			ProtocolViolationCode::UnsupportedProviderApiShape,
			format!("unsupported provider_api_shape `{raw}`"),
		)
	})?;
	Ok(raw.to_owned())
}

fn derive_last_assistant_summary(last_assistant_summary: Option<String>) -> ProtocolResult<String> {
	last_assistant_summary
		.ok_or_else(|| violation("projection requires assistant_turn.recorded payload.summary"))
}

fn violation(message: impl Into<String>) -> ProtocolViolation {
	ProtocolViolation::new(ProtocolViolationCode::ReplayMismatch, message)
}
