//! Owned by Lane C8 `KernelLocalRpc`: axum handlers for the local RPC/SSE
//! route surface.
//!
//! Every handler drives the real accepted C1/C2/C3/C7 seams (no fake or
//! stubbed runner behaviour). `submit_turn` in particular never opens an SSE
//! response until the turn has genuinely started emitting frames — see the
//! module-level comment inside that function for why.

use std::sync::Arc;

use axum::{
	Json,
	body::{Body, Bytes},
	extract::{Path, Query, State},
	http::{StatusCode, header},
	response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use successor_protocol::{
	ids::{RequestId, SessionId},
	kernel_frame::{KernelFrameKindV0, KernelFrameV0},
	platform_api::{CreateSessionRequestV0, CreatedByV0, WorkspaceV0},
	raw_event::EntityIdsV0,
};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::{StreamExt as _, wrappers::ReceiverStream};

use crate::{
	api::{
		CreateSessionRequest, CreateSessionResponse, KernelRpcError, KernelRpcResult, ResumeQuery,
		ResumeResponse, SessionAttachResponse, SubmitTurnRequest, build_envelope,
		invalid_parameter_error, malformed_body_error, platform_error_to_rpc_error,
		turn_failure_to_rpc_error,
	},
	frame_sink::{FrameFields, FrameSink},
	http::AppState,
	runner::{ProviderExecutor, TurnInput, TurnRunner},
	sse::render_kernel_frame_sse,
	stream::KernelFrameStream,
};

fn decode_body<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
	serde_json::from_slice(bytes).map_err(|err| err.to_string())
}

fn parse_session_id(raw: &str) -> Result<SessionId, String> {
	raw.parse::<SessionId>()
		.map_err(|violation| violation.to_string())
}

fn internal_error<P: ProviderExecutor + Send + Sync + 'static>(
	state: &AppState<P>,
	correlation_id: &RequestId,
	message: impl Into<String>,
) -> KernelRpcError {
	KernelRpcError::new(
		StatusCode::INTERNAL_SERVER_ERROR,
		build_envelope(
			state.ids.error_id(),
			correlation_id,
			"kernel_rpc.internal",
			message,
			false,
			false,
		),
	)
}

/// `POST /v0/sessions` — the "create" half of the ruled create/attach-session
/// route: a thin wrapper over
/// [`crate::platform_client::KernelPlatformClient::create_session`].
pub async fn create_session<P: ProviderExecutor + Send + Sync + 'static>(
	State(state): State<AppState<P>>,
	body: Bytes,
) -> KernelRpcResult<Json<CreateSessionResponse>> {
	let correlation_id = state.ids.request_id();
	let request: CreateSessionRequest = decode_body(&body)
		.map_err(|detail| malformed_body_error(state.ids.error_id(), &correlation_id, &detail))?;

	let workspace_label = state.workspace_root.display().to_string();
	let create_request = CreateSessionRequestV0 {
		workspace:  WorkspaceV0 {
			id:        "workspace-1".to_owned(),
			label:     workspace_label.clone(),
			root_hint: workspace_label,
		},
		title:      request.title,
		created_by: CreatedByV0 {
			client_kind: "kernel_local_rpc".to_owned(),
			client_id:   "successor-kernel".to_owned(),
		},
	};

	let response = state
		.platform
		.create_session(&create_request)
		.await
		.map_err(|err| platform_error_to_rpc_error(state.ids.error_id(), &correlation_id, &err))?;
	Ok(Json(response))
}

/// `GET /v0/sessions/{session_id}` — the "attach" half of the ruled
/// create/attach-session route: a thin wrapper over
/// [`crate::platform_client::KernelPlatformClient::read_snapshot`].
pub async fn attach_session<P: ProviderExecutor + Send + Sync + 'static>(
	State(state): State<AppState<P>>,
	Path(session_id): Path<String>,
) -> KernelRpcResult<Json<SessionAttachResponse>> {
	let correlation_id = state.ids.request_id();
	let session_id = parse_session_id(&session_id)
		.map_err(|detail| invalid_parameter_error(state.ids.error_id(), &correlation_id, &detail))?;

	let snapshot = state
		.platform
		.read_snapshot(&session_id)
		.await
		.map_err(|err| platform_error_to_rpc_error(state.ids.error_id(), &correlation_id, &err))?;
	Ok(Json(snapshot))
}

/// `GET /v0/resume/{session_id}` — Dissent ruling 5.
///
/// A fresh platform snapshot/event page and a fresh provider-auth resolution on
/// every call (`state.provider_factory` is never cached); no local session
/// cache/file, no second store.
pub async fn resume<P: ProviderExecutor + Send + Sync + 'static>(
	State(state): State<AppState<P>>,
	Path(session_id): Path<String>,
	Query(query): Query<ResumeQuery>,
) -> KernelRpcResult<Json<ResumeResponse>> {
	let correlation_id = state.ids.request_id();
	let session_id = parse_session_id(&session_id)
		.map_err(|detail| invalid_parameter_error(state.ids.error_id(), &correlation_id, &detail))?;

	let snapshot = state
		.platform
		.read_snapshot(&session_id)
		.await
		.map_err(|err| platform_error_to_rpc_error(state.ids.error_id(), &correlation_id, &err))?;
	let events = state
		.platform
		.read_session_events(&session_id, query.after_seq, query.limit)
		.await
		.map_err(|err| platform_error_to_rpc_error(state.ids.error_id(), &correlation_id, &err))?;
	let provider_auth_resolved = (state.provider_factory)().is_ok();

	Ok(Json(ResumeResponse { session_id, snapshot, events, provider_auth_resolved }))
}

async fn send_frame(tx: &mpsc::Sender<Bytes>, frame: &KernelFrameV0) -> Result<(), ()> {
	match render_kernel_frame_sse(frame) {
		Ok(rendered) => tx
			.send(Bytes::from(rendered.into_bytes()))
			.await
			.map_err(|_| ()),
		Err(err) => {
			tracing::warn!(error = %err, "failed to render a kernel frame for SSE; dropping the frame");
			Ok(())
		},
	}
}

/// `POST /v0/turns` — submit a turn and stream its kernel frames verbatim.
///
/// This never opens the SSE response until the turn has genuinely started
/// emitting real, C2-rendered frames (`render_kernel_frame_sse` /
/// `KernelFrameStream::subscribe`, Dissent ruling 7). If the turn fails
/// before any frame exists — the platform is unreachable at session
/// creation, before any session/turn identity was ever assigned — a normal
/// JSON [`KernelRpcError`] is returned instead of a stream with nothing
/// genuine to send. A subscriber is created before the turn is spawned so no
/// frame can be missed to a race; on any later failure this synthesizes one
/// terminal `turn_failed` [`KernelFrameV0`] (via the same accepted
/// [`FrameSink::emit`] every other frame goes through — no second schema) so
/// clients always see a definite end to the stream.
pub async fn submit_turn<P: ProviderExecutor + Send + Sync + 'static>(
	State(state): State<AppState<P>>,
	body: Bytes,
) -> Response {
	let correlation_id = state.ids.request_id();

	let request: SubmitTurnRequest = match decode_body(&body) {
		Ok(request) => request,
		Err(detail) => {
			return malformed_body_error(state.ids.error_id(), &correlation_id, &detail)
				.into_response();
		},
	};
	if request.tool_authority.is_some() {
		return KernelRpcError::new(
			StatusCode::UNPROCESSABLE_ENTITY,
			build_envelope(
				state.ids.error_id(),
				&correlation_id,
				"kernel_rpc.tool_authority_unsupported",
				"explicit tool_authority requests are not supported by this kernel version",
				false,
				false,
			),
		)
		.into_response();
	}

	let provider = match (state.provider_factory)() {
		Ok(provider) => provider,
		Err(failure) => {
			return turn_failure_to_rpc_error(state.ids.error_id(), &correlation_id, &failure)
				.into_response();
		},
	};

	// Fresh per-turn C2 stream (C8 review task 230): a single AppState-level
	// KernelFrameStream would let two concurrent `POST /v0/turns` requests
	// subscribe to and publish on the very same broadcast channel, so either
	// SSE response could emit the other turn's frames or terminate on the
	// other turn's terminal frame. Each turn gets its own live stream, built
	// through the public constructor (never `publish_with`), subscribed to
	// before the runner is driven.
	let frame_stream = KernelFrameStream::new();
	let mut receiver = frame_stream.subscribe();
	let runner = TurnRunner::new(
		state.platform.clone(),
		FrameSink::new(frame_stream.clone()),
		Arc::clone(&state.ids),
		Arc::clone(&state.clock),
		provider,
		state.workspace_root.clone(),
	);
	let session_id = request.session_id.clone();
	let input: TurnInput = request.into();
	let mut task = tokio::spawn(async move {
		match session_id {
			Some(session_id) => runner.continue_turn(input, session_id).await,
			None => runner.execute_turn(input).await,
		}
	});

	// Gate: race the turn's first frame against the turn task finishing
	// outright. Only the former commits us to an SSE response.
	enum Gate {
		Frame(Box<Result<KernelFrameV0, broadcast::error::RecvError>>),
		Done(Result<crate::turn_trace::TurnAttempt, tokio::task::JoinError>),
	}
	let gate = tokio::select! {
		biased;
		frame = receiver.recv() => Gate::Frame(Box::new(frame)),
		joined = &mut task => Gate::Done(joined),
	};

	let first_frame = match gate {
		Gate::Frame(boxed) => match *boxed {
			Ok(frame) => frame,
			Err(broadcast::error::RecvError::Lagged(_)) => {
				return internal_error(
					&state,
					&correlation_id,
					"kernel_frame stream lagged before the turn's first frame",
				)
				.into_response();
			},
			Err(broadcast::error::RecvError::Closed) => {
				return internal_error(
					&state,
					&correlation_id,
					"kernel_frame stream closed before the turn's first frame",
				)
				.into_response();
			},
		},
		Gate::Done(Ok(attempt)) => {
			// The turn finished before it ever emitted a frame — by
			// construction that only happens for a failure (a success always
			// ends with at least a `turn_started`/`turn_completed` pair).
			return match attempt.outcome {
				Ok(_) => internal_error(
					&state,
					&correlation_id,
					"turn completed without emitting any frame, which should be unreachable",
				)
				.into_response(),
				Err(failure) => {
					turn_failure_to_rpc_error(state.ids.error_id(), &correlation_id, &failure)
						.into_response()
				},
			};
		},
		Gate::Done(Err(_join_error)) => {
			return internal_error(
				&state,
				&correlation_id,
				"turn task panicked before emitting any frame",
			)
			.into_response();
		},
	};

	let (tx, rx) = mpsc::channel::<Bytes>(64);
	let terminal_sink = FrameSink::new(frame_stream.clone());
	let ids = Arc::clone(&state.ids);
	let clock = Arc::clone(&state.clock);

	tokio::spawn(async move {
		if send_frame(&tx, &first_frame).await.is_err() {
			// Client disconnected immediately; this receiver is simply
			// dropped. Other subscribers and the shared stream are
			// unaffected (broadcast semantics), and the turn keeps running.
			return;
		}
		loop {
			tokio::select! {
				biased;
				frame = receiver.recv() => match frame {
					Ok(frame) => if send_frame(&tx, &frame).await.is_err() { return },
					Err(broadcast::error::RecvError::Lagged(_)) => {},
					Err(broadcast::error::RecvError::Closed) => break,
				},
				joined = &mut task => {
					// Frames are always published before `execute_turn`
					// returns, but this branch may have been selected before
					// every already-published frame was drained above.
					while let Ok(frame) = receiver.try_recv() {
						if send_frame(&tx, &frame).await.is_err() { return }
					}
					if let Ok(attempt) = joined
						&& let Err(failure) = &attempt.outcome
						&& let Some(last) = attempt.trace.frames().last()
					{
						let synthetic = terminal_sink.emit(FrameFields {
							frame_id: ids.frame_id(),
							session_id: last.session_id.clone(),
							turn_id: last.turn_id.clone(),
							request_id: last.request_id.clone(),
							kind: KernelFrameKindV0::TurnFailed,
							ts: clock.now(),
							payload: serde_json::json!({ "failure": failure.to_string() }),
							raw_event_ref: None,
							causation_frame_id: Some(last.frame_id.clone()),
							entity_ids: EntityIdsV0::default(),
						});
						if let Ok(frame) = synthetic {
							let _ = send_frame(&tx, &frame).await;
						}
					}
					break;
				},
			}
		}
	});

	let stream = ReceiverStream::new(rx).map(Ok::<Bytes, std::convert::Infallible>);
	Response::builder()
		.status(StatusCode::OK)
		.header(header::CONTENT_TYPE, "text/event-stream")
		.header(header::CACHE_CONTROL, "no-cache")
		.body(Body::from_stream(stream))
		.expect("static SSE response headers are always valid")
		.into_response()
}
