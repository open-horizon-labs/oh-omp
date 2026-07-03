use successor_protocol::{
	canonical_json::{to_canonical_projection_json_bytes, to_canonical_projection_json_string},
	error::ProtocolViolationCode,
	ids::SessionId,
	projection::SessionProjectionV0,
	raw_event::{RawEventType, RawEventV0},
	replay::project_session,
};

fn successful_events() -> Vec<RawEventV0> {
	serde_json::from_str(include_str!(
		"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
		 raw-events-successful-turn.json"
	))
	.unwrap()
}

const fn expected_projection() -> &'static str {
	include_str!(
		"../../../.oh/workstreams/successor-agent-kernel/fixtures/slice-0/\
		 expected-session-projection.json"
	)
}

#[test]
fn replay_successful_turn_matches_expected_projection_bytes() {
	let projection = project_session(&successful_events()).unwrap();
	let actual = to_canonical_projection_json_bytes(&projection).unwrap();

	assert_eq!(actual, expected_projection().as_bytes());
}

#[test]
fn replay_successful_turn_is_deterministic() {
	let events = successful_events();
	let first = to_canonical_projection_json_string(&project_session(&events).unwrap());
	let second = to_canonical_projection_json_string(&project_session(&events).unwrap());

	assert_eq!(first, second);
}

#[test]
fn expected_projection_round_trips_to_canonical_bytes() {
	let projection = serde_json::from_str::<SessionProjectionV0>(expected_projection()).unwrap();

	assert_eq!(to_canonical_projection_json_string(&projection), expected_projection());
}

#[test]
fn replay_rejects_duplicate_sequence() {
	let mut events = successful_events();
	events[1].session_seq = events[0].session_seq;

	assert!(project_session(&events).is_err());
}

#[test]
fn replay_rejects_sequence_gap() {
	let mut events = successful_events();
	events[1].session_seq = 3;

	assert!(project_session(&events).is_err());
}

#[test]
fn replay_rejects_cross_session_events() {
	let mut events = successful_events();
	events[1].session_id =
		SessionId::try_from("ses_00000000-0000-4000-8000-000000000099".to_owned()).unwrap();

	assert!(project_session(&events).is_err());
}

#[test]
fn replay_rejects_missing_assistant_summary_authority() {
	let mut events = successful_events();
	let assistant_event = events
		.iter_mut()
		.find(|event| event.event_type == RawEventType::AssistantTurnRecorded)
		.unwrap();
	assistant_event
		.payload
		.as_object_mut()
		.unwrap()
		.remove("summary");

	let err = project_session(&events).unwrap_err();

	assert_eq!(err.code, ProtocolViolationCode::ReplayMismatch);
}

#[test]
fn replay_rejects_unsupported_provider_api_shape() {
	let mut events = successful_events();
	let provider_event = events
		.iter_mut()
		.find(|event| event.event_type == RawEventType::ProviderRequestBuilt)
		.unwrap();
	provider_event.payload.as_object_mut().unwrap().insert(
		"provider_api_shape".to_owned(),
		serde_json::Value::String("unsupported_shape".to_owned()),
	);

	let err = project_session(&events).unwrap_err();

	assert_eq!(err.code, ProtocolViolationCode::UnsupportedProviderApiShape);
}
