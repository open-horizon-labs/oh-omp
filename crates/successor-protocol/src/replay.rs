//! Pure deterministic replay from raw events into session projections.

use std::collections::HashMap;

use crate::{
	error::{ProtocolResult, ProtocolViolation, ProtocolViolationCode},
	ids::{ArtifactId, ErrorId, EventId, RequestId, ToolCallId},
	projection::{
		ArtifactProjectionV0, AssemblyProjectionV0, EXPECTED_PROJECTION_SCHEMA_VERSION,
		ErrorProjectionV0, MessageRole, PROJECTION_VERSION, ProviderTraceProjectionV0,
		SessionProjectionV0, SessionSummaryV0, ToolCallProjectionV0, ToolCallStatus,
		TranscriptEntryV0,
	},
	provider::ProviderApiShapeV0,
	raw_event::{RAW_EVENT_SCHEMA_VERSION, RawEventType, RawEventV0},
};

#[derive(Debug, Default)]
struct ToolState {
	tool_name:            Option<String>,
	requested_event_id:   Option<EventId>,
	result_event_id:      Option<EventId>,
	completed_event_id:   Option<EventId>,
	artifact_id:          Option<ArtifactId>,
	started_event_id:     Option<EventId>,
	error_event_id:       Option<EventId>,
	error_id:             Option<ErrorId>,
	failed_event_id:      Option<EventId>,
	error_code:           Option<String>,
	error_message:        Option<String>,
	error_recoverable:    Option<bool>,
	error_retryable:      Option<bool>,
	error_correlation_id: Option<RequestId>,
	error_details:        Option<serde_json::Value>,
}

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
	let mut errors = Vec::new();
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
				if state.requested_event_id.is_some() {
					return Err(violation("duplicate tool_call.requested for the same tool_call_id"));
				}
				state.tool_name = Some(required_payload_str(event, "tool_name")?.to_owned());
				state.requested_event_id = Some(event.event_id.clone());
			},
			RawEventType::ToolCallStarted => {
				let tool_call_id = required_tool_call_id(event)?;
				let state = tool_states.entry(tool_call_id).or_default();
				if state.requested_event_id.is_none() {
					return Err(violation("tool_call.started before tool_call.requested"));
				}
				if state.started_event_id.is_some() {
					return Err(violation("duplicate tool_call.started for the same tool_call_id"));
				}
				if event.causation_event_id != state.requested_event_id {
					return Err(violation(
						"tool_call.started does not causally chain from tool_call.requested",
					));
				}
				state.started_event_id = Some(event.event_id.clone());
			},
			RawEventType::ToolResultRecorded => {
				let tool_call_id = required_tool_call_id(event)?;
				let state = tool_states.entry(tool_call_id).or_default();
				if state.started_event_id.is_none() {
					return Err(violation("tool_result.recorded before tool_call.started"));
				}
				if state.failed_event_id.is_some() {
					return Err(violation("tool_result.recorded on an already-failed tool call"));
				}
				if state.error_event_id.is_some() {
					return Err(violation("tool_result.recorded on an errored tool call"));
				}
				if state.result_event_id.is_some() {
					return Err(violation("duplicate tool_result.recorded for the same tool_call_id"));
				}
				if event.causation_event_id != state.started_event_id {
					return Err(violation(
						"tool_result.recorded does not causally chain from tool_call.started",
					));
				}
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
				if state.failed_event_id.is_some() {
					return Err(violation("tool_call.completed on an already-failed tool call"));
				}
				if state.error_event_id.is_some() {
					return Err(violation("tool_call.completed on an errored tool call"));
				}
				if state.completed_event_id.is_some() {
					return Err(violation("duplicate tool_call.completed for the same tool_call_id"));
				}
				if event.causation_event_id != state.result_event_id {
					return Err(violation(
						"tool_call.completed does not causally chain from tool_result.recorded",
					));
				}
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
					result_event_id: Some(
						state
							.result_event_id
							.clone()
							.ok_or_else(|| violation("tool_call.completed missing result event"))?,
					),
					completed_event_id: Some(
						state
							.completed_event_id
							.clone()
							.ok_or_else(|| violation("tool_call.completed missing completed event"))?,
					),
					artifact_id: Some(
						state
							.artifact_id
							.clone()
							.ok_or_else(|| violation("tool_call.completed missing artifact_id"))?,
					),
					started_event_id: None,
					error_event_id: None,
					failed_event_id: None,
					error_id: None,
				});
			},
			RawEventType::ErrorRecorded => {
				// Only accepted as the third link of a complete recoverable
				// executor-failure chain: tool_call.requested ->
				// tool_call.started -> error.recorded -> tool_call.failed,
				// all for the same tool_call_id, each causally chained to
				// the previous event. Every other shape (including the
				// catalog-rejection chain, which never emits
				// tool_call.started) is rejected exactly as before.
				let Some(tool_call_id) = event.entity_ids.tool_call_id.clone() else {
					return Err(violation(
						"successful-turn projection does not accept error.recorded events",
					));
				};
				let state = tool_states.get(&tool_call_id);
				let started_event_id = state.and_then(|state| state.started_event_id.clone());
				let invalid_error_transition = state.is_some_and(|state| {
					state.result_event_id.is_some()
						|| state.artifact_id.is_some()
						|| state.completed_event_id.is_some()
						|| state.error_event_id.is_some()
						|| state.failed_event_id.is_some()
				});
				if started_event_id.is_none() || invalid_error_transition {
					return Err(violation(
						"successful-turn projection does not accept error.recorded events",
					));
				}
				if event.causation_event_id != started_event_id {
					return Err(violation(
						"error.recorded does not causally chain from tool_call.started",
					));
				}
				let error_id = event
					.entity_ids
					.error_id
					.clone()
					.ok_or_else(|| violation("error.recorded missing error_id"))?;
				let code = required_payload_str(event, "code")?.to_owned();
				let message = required_payload_str(event, "message")?.to_owned();
				let recoverable = required_payload_bool(event, "recoverable")?;
				let retryable = required_payload_bool(event, "retryable")?;
				let correlation_id: RequestId =
					required_payload_str(event, "correlation_id")?.parse()?;
				let details = required_payload_value(event, "details")?;

				let state = tool_states.entry(tool_call_id).or_default();
				state.error_id = Some(error_id);
				state.error_event_id = Some(event.event_id.clone());
				state.error_code = Some(code);
				state.error_message = Some(message);
				state.error_recoverable = Some(recoverable);
				state.error_retryable = Some(retryable);
				state.error_correlation_id = Some(correlation_id);
				state.error_details = Some(details);
			},
			RawEventType::ToolCallFailed => {
				let tool_call_id = required_tool_call_id(event)?;
				let error_event_id = tool_states
					.get(&tool_call_id)
					.and_then(|state| state.error_event_id.clone());
				let already_terminal = tool_states.get(&tool_call_id).is_some_and(|state| {
					state.completed_event_id.is_some() || state.failed_event_id.is_some()
				});
				if error_event_id.is_none() || already_terminal {
					return Err(violation(
						"tool_call.failed before error.recorded, or on an already-terminal tool call",
					));
				}
				if event.causation_event_id != error_event_id {
					return Err(violation(
						"tool_call.failed does not causally chain from error.recorded",
					));
				}
				let failed_error_id = event
					.entity_ids
					.error_id
					.clone()
					.ok_or_else(|| violation("tool_call.failed missing error_id"))?;
				let chain_error_id = tool_states
					.get(&tool_call_id)
					.and_then(|state| state.error_id.clone());
				if chain_error_id.as_ref() != Some(&failed_error_id) {
					return Err(violation("tool_call.failed error_id does not match error.recorded"));
				}
				if required_payload_str(event, "status")? != "failed" {
					return Err(violation("tool_call.failed payload status must be `failed`"));
				}

				let state = tool_states.entry(tool_call_id.clone()).or_default();
				state.failed_event_id = Some(event.event_id.clone());

				tools.push(ToolCallProjectionV0 {
					tool_call_id:       tool_call_id.clone(),
					tool_name:          state
						.tool_name
						.clone()
						.ok_or_else(|| violation("tool_call.failed before tool_call.requested"))?,
					status:             ToolCallStatus::Failed,
					requested_event_id: state
						.requested_event_id
						.clone()
						.ok_or_else(|| violation("tool_call.failed missing requested event"))?,
					result_event_id:    None,
					completed_event_id: None,
					artifact_id:        None,
					started_event_id:   state.started_event_id.clone(),
					error_event_id:     state.error_event_id.clone(),
					failed_event_id:    state.failed_event_id.clone(),
					error_id:           state.error_id.clone(),
				});
				errors.push(ErrorProjectionV0 {
					error_id: failed_error_id,
					tool_call_id,
					error_event_id: state
						.error_event_id
						.clone()
						.ok_or_else(|| violation("tool_call.failed missing error event"))?,
					code: state
						.error_code
						.clone()
						.ok_or_else(|| violation("error.recorded payload missing code"))?,
					message: state
						.error_message
						.clone()
						.ok_or_else(|| violation("error.recorded payload missing message"))?,
					recoverable: state
						.error_recoverable
						.ok_or_else(|| violation("error.recorded payload missing recoverable"))?,
					retryable: state
						.error_retryable
						.ok_or_else(|| violation("error.recorded payload missing retryable"))?,
					correlation_id: state
						.error_correlation_id
						.clone()
						.ok_or_else(|| violation("error.recorded payload missing correlation_id"))?,
					details: state
						.error_details
						.clone()
						.ok_or_else(|| violation("error.recorded payload missing details"))?,
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
			RawEventType::ToolCatalogPublished
			| RawEventType::AssemblyRequested
			| RawEventType::ProviderToolCallObserved
			| RawEventType::ToolCallRejected => {},
		}
	}

	for (tool_call_id, state) in &tool_states {
		let is_completed = state.completed_event_id.is_some();
		let is_failed = state.failed_event_id.is_some();
		if is_completed == is_failed {
			return Err(violation(format!(
				"tool_call_id `{}` never reached exactly one terminal state (requested-only, \
				 started-only, result-without-completed, or error-without-failed are all rejected)",
				tool_call_id.as_str()
			)));
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
		errors,
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

fn required_payload_bool(event: &RawEventV0, key: &str) -> ProtocolResult<bool> {
	event
		.payload
		.get(key)
		.and_then(|value| value.as_bool())
		.ok_or_else(|| violation(format!("{} payload missing bool field `{key}`", event.event_type)))
}

fn required_payload_value(event: &RawEventV0, key: &str) -> ProtocolResult<serde_json::Value> {
	event
		.payload
		.get(key)
		.cloned()
		.ok_or_else(|| violation(format!("{} payload missing field `{key}`", event.event_type)))
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
