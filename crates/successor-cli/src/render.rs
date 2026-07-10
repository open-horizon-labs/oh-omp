//! Owned by Lane D1 `SuccessorCliCore`: pure output formatting (dissent
//! ruling 3, output pass-through only).
//!
//! - JSON routes' bodies (including `ErrorEnvelopeV0`) are written
//!   byte-for-byte unchanged (a trailing newline may be added).
//! - `ask --format sse` writes received SSE bytes byte-for-byte.
//! - "text" rendering is human-only: it never becomes a fixture oracle, and it
//!   never fabricates a field the kernel didn't already return.

use std::io::{self, Write};

use successor_protocol::kernel_frame::{KernelFrameKindV0, KernelFrameV0};

/// Writes `bytes` unchanged, adding a trailing newline only if one isn't
/// already present (ruling 3 permits a trailing newline).
pub fn write_json_passthrough(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
	writer.write_all(bytes)?;
	if bytes.last() != Some(&b'\n') {
		writer.write_all(b"\n")?;
	}
	writer.flush()
}

/// Writes one SSE chunk exactly as received on the wire: no re-framing, no
/// re-encoding, no buffering beyond what's needed to flush promptly.
pub fn write_sse_chunk(writer: &mut impl Write, chunk: &[u8]) -> io::Result<()> {
	writer.write_all(chunk)?;
	writer.flush()
}

/// Human-only rendering of one decoded kernel frame for `ask --format
/// text` (the default). Best-effort: payload fields this rendering doesn't
/// recognize are silently skipped rather than fabricated or dumped raw.
pub fn render_frame_text(writer: &mut impl Write, frame: &KernelFrameV0) -> io::Result<()> {
	match frame.kind {
		KernelFrameKindV0::ProviderDelta => {
			if let Some(text) = frame.payload.get("text").and_then(|value| value.as_str()) {
				write!(writer, "{text}")?;
			}
			Ok(())
		},
		KernelFrameKindV0::ToolCallRequested => {
			let tool = frame
				.payload
				.get("tool_name")
				.and_then(|value| value.as_str())
				.unwrap_or("tool");
			writeln!(writer, "\n[requesting {tool}]")
		},
		KernelFrameKindV0::ToolCallRejected => {
			let reason = frame
				.payload
				.get("reason")
				.and_then(|value| value.as_str())
				.unwrap_or("tool call rejected");
			writeln!(writer, "\n[{reason}]")
		},
		KernelFrameKindV0::TurnCompleted => writeln!(writer, "\n[turn completed]"),
		KernelFrameKindV0::TurnFailed => {
			let detail = turn_failed_detail(&frame.payload);
			writeln!(writer, "\n[turn failed: {detail}]")
		},
		_ => Ok(()),
	}
}

/// Resolves the human-readable failure detail for a `turn_failed` frame's
/// text-mode rendering.
///
/// Payload shapes vary by producer: some carry a nested typed error
/// envelope (`payload.error.message` / `payload.error.code`, matching
/// `ErrorEnvelopeV0`'s shape), others a flat top-level `message` / `detail`
/// / `reason` field, others a bare string payload, and some none at all.
/// This searches in that order -- nested envelope first, then flat fields,
/// then the payload-as-string case -- and always falls back to the literal
/// `"turn failed"` rather than ever printing a raw JSON blob. JSON/SSE
/// pass-through output is untouched by this; it only affects the text-mode
/// bracketed render.
///
/// The resolved detail is sanitized to a single line with tabs and
/// newlines collapsed to spaces, so a multi-line or tab-containing message
/// never corrupts the single-line `[turn failed: ...]` render.
fn turn_failed_detail(payload: &serde_json::Value) -> String {
	let raw = payload
		.get("error")
		.and_then(|error| {
			error
				.get("message")
				.and_then(serde_json::Value::as_str)
				.or_else(|| error.get("code").and_then(serde_json::Value::as_str))
		})
		.or_else(|| payload.get("message").and_then(serde_json::Value::as_str))
		.or_else(|| payload.get("detail").and_then(serde_json::Value::as_str))
		.or_else(|| payload.get("reason").and_then(serde_json::Value::as_str))
		.or_else(|| payload.as_str())
		.unwrap_or("turn failed");
	sanitize_single_line(raw)
}

/// Collapses `value` to a single tab-free line: tabs and newlines become a
/// single space, and the result is trimmed. Falls back to `"turn failed"` if
/// the sanitized result would be empty (e.g. a payload field that was only
/// whitespace).
fn sanitize_single_line(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	let mut last_was_space = false;
	for ch in value.chars() {
		let normalized = match ch {
			'\t' | '\n' | '\r' => ' ',
			other => other,
		};
		if normalized == ' ' {
			if !last_was_space {
				out.push(' ');
			}
			last_was_space = true;
		} else {
			out.push(normalized);
			last_was_space = false;
		}
	}
	let trimmed = out.trim();
	if trimmed.is_empty() {
		"turn failed".to_owned()
	} else {
		trimmed.to_owned()
	}
}

/// Human-only rendering for `resume`/`inspect session --format text`:
/// re-indents the already-received JSON body for readability. Never adds,
/// renames, or drops a field the kernel didn't already return; falls back
/// to the raw pass-through if the body isn't valid JSON.
pub fn render_json_as_text(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
	match serde_json::from_slice::<serde_json::Value>(bytes) {
		Ok(value) => {
			let pretty = serde_json::to_string_pretty(&value)
				.unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned());
			writeln!(writer, "{pretty}")
		},
		Err(_) => write_json_passthrough(writer, bytes),
	}
}

#[cfg(test)]
mod tests {
	use successor_protocol::ids::{FrameId, RequestId, SessionId, TurnId};

	use super::*;

	fn render_turn_failed(payload: serde_json::Value) -> String {
		let frame = KernelFrameV0::new(
			FrameId::try_from("frame_1".to_owned()).expect("valid frame id"),
			1,
			SessionId::try_from("ses_test0000000000000001".to_owned()).expect("valid session id"),
			TurnId::try_from("turn_test0000000000000001".to_owned()).expect("valid turn id"),
			RequestId::try_from("req_test0000000000000001".to_owned()).expect("valid request id"),
			KernelFrameKindV0::TurnFailed,
			"2024-01-01T00:00:00Z",
			payload,
		);
		let mut out = Vec::new();
		render_frame_text(&mut out, &frame).expect("render_frame_text must not fail");
		String::from_utf8(out).expect("rendered text is valid utf-8")
	}

	#[test]
	fn provider_delta_renders_answer_before_turn_completed_marker() {
		let session_id =
			SessionId::try_from("ses_test0000000000000001".to_owned()).expect("valid session id");
		let turn_id =
			TurnId::try_from("turn_test0000000000000001".to_owned()).expect("valid turn id");
		let request_id =
			RequestId::try_from("req_test0000000000000001".to_owned()).expect("valid request id");
		let provider_delta = KernelFrameV0::new(
			FrameId::try_from("frame_1".to_owned()).expect("valid frame id"),
			1,
			session_id.clone(),
			turn_id.clone(),
			request_id.clone(),
			KernelFrameKindV0::ProviderDelta,
			"2024-01-01T00:00:00Z",
			serde_json::json!({"text": "answer text"}),
		);
		let turn_completed = KernelFrameV0::new(
			FrameId::try_from("frame_2".to_owned()).expect("valid frame id"),
			2,
			session_id,
			turn_id,
			request_id,
			KernelFrameKindV0::TurnCompleted,
			"2024-01-01T00:00:01Z",
			serde_json::json!({"finish_reason": "stop"}),
		);
		let mut out = Vec::new();
		render_frame_text(&mut out, &provider_delta).expect("provider_delta render must not fail");
		render_frame_text(&mut out, &turn_completed).expect("turn_completed render must not fail");
		let rendered = String::from_utf8(out).expect("rendered text is valid utf-8");

		assert_eq!(rendered, "answer text\n[turn completed]\n");
	}

	#[test]
	fn turn_failed_prefers_a_nested_error_envelope_message_over_the_literal_fallback() {
		let rendered = render_turn_failed(serde_json::json!({
			"error": {
				"code": "tool_rejected",
				"message": "the requested tool is not on the published catalog"
			}
		}));
		assert_eq!(
			rendered, "\n[turn failed: the requested tool is not on the published catalog]\n",
			"a nested envelope's message must replace the literal '[turn failed: turn failed]' \
			 fallback"
		);
	}

	#[test]
	fn turn_failed_falls_back_to_the_nested_envelope_code_when_message_is_absent() {
		let detail = turn_failed_detail(&serde_json::json!({"error": {"code": "tool_rejected"}}));
		assert_eq!(detail, "tool_rejected");
	}

	#[test]
	fn turn_failed_uses_a_flat_top_level_message_when_no_error_envelope_is_present() {
		let detail = turn_failed_detail(&serde_json::json!({"message": "boom"}));
		assert_eq!(detail, "boom");
	}

	#[test]
	fn turn_failed_prefers_the_nested_envelope_over_a_flat_top_level_field() {
		let detail = turn_failed_detail(&serde_json::json!({
			"error": {"message": "nested wins"},
			"message": "flat loses"
		}));
		assert_eq!(detail, "nested wins");
	}

	#[test]
	fn turn_failed_falls_back_through_detail_then_reason_when_message_is_absent() {
		assert_eq!(turn_failed_detail(&serde_json::json!({"detail": "d"})), "d");
		assert_eq!(turn_failed_detail(&serde_json::json!({"reason": "r"})), "r");
	}

	#[test]
	fn turn_failed_accepts_a_bare_string_payload() {
		let detail = turn_failed_detail(&serde_json::json!("boom"));
		assert_eq!(detail, "boom");
	}

	#[test]
	fn turn_failed_never_panics_and_falls_back_to_the_literal_for_an_absent_or_null_payload() {
		assert_eq!(turn_failed_detail(&serde_json::json!({})), "turn failed");
		assert_eq!(turn_failed_detail(&serde_json::Value::Null), "turn failed");
		assert_eq!(turn_failed_detail(&serde_json::json!([1, 2, 3])), "turn failed");
	}

	#[test]
	fn turn_failed_detail_is_sanitized_to_a_single_tab_free_line() {
		let detail = turn_failed_detail(&serde_json::json!({"message": "line one\n\tline two"}));
		assert_eq!(detail, "line one line two");
		assert!(!detail.contains('\t'));
		assert!(!detail.contains('\n'));
	}

	#[test]
	fn turn_failed_never_prints_a_raw_json_blob_for_an_envelope_with_no_string_fields() {
		let detail = turn_failed_detail(&serde_json::json!({"error": {"nested": {"blob": true}}}));
		assert_eq!(detail, "turn failed");
	}
}
