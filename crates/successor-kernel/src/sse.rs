//! SSE record serialization for kernel frames (Lane C2 `KernelFrameStream`).
//!
//! Hand-rolled per the SSE spec (dissent ruling 2: no SSE/event-stream
//! crate dependency). Produces `event: kernel_frame` records with `data:`
//! JSON lines built from the accepted [`KernelFrameV0`] DTO -- this module
//! never invents its own frame JSON shape, and never writes to a socket
//! itself; that is C8's job. It only renders the well-formed text record.

use successor_protocol::kernel_frame::{KERNEL_FRAME_SSE_EVENT_NAME, KernelFrameV0};

/// Error serializing a [`KernelFrameV0`] to an SSE record.
#[derive(Debug, thiserror::Error)]
#[error("failed to serialize kernel frame to JSON: {0}")]
pub struct SseSerializeError(#[from] serde_json::Error);

/// Render `frame` as one well-formed SSE `text/event-stream` record.
///
/// Format (per the SSE spec, LF-only line endings, no bare CR):
///
/// ```text
/// event: kernel_frame
/// data: <json line 1>
/// data: <json line 2>
/// ...
/// <blank line>
/// ```
///
/// `frame`'s JSON is emitted compactly via `serde_json::to_string`, which
/// never contains a raw, unescaped newline for any [`KernelFrameV0`] field
/// value (embedded newlines in string values are JSON-escaped as `\n`, two
/// characters, not a literal line break). The per-line `data:` splitting in
/// [`render_sse_record`] is defensive, spec-correct handling for the
/// general multi-line case; it is not exercised for the canonical fixture's
/// single-line compact JSON, but keeps this renderer correct if payload
/// serialization ever changes (e.g., pretty-printing).
///
/// The record always ends with exactly one trailing blank line and never
/// contains a bare `\r`.
pub fn render_kernel_frame_sse(frame: &KernelFrameV0) -> Result<String, SseSerializeError> {
	let json = serde_json::to_string(frame)?;
	Ok(render_sse_record(KERNEL_FRAME_SSE_EVENT_NAME, &json))
}

/// Render one SSE record for `event_name` carrying `data` as its payload.
///
/// `data` is split on `\n` and each resulting line is emitted as its own
/// `data:` field line, per the SSE spec's handling of multi-line data. Any
/// trailing `\r` on a line (e.g., from CRLF input) is stripped so the
/// output never contains a bare carriage return. The record always ends
/// with exactly one blank line.
fn render_sse_record(event_name: &str, data: &str) -> String {
	let mut record = String::with_capacity(data.len() + event_name.len() + 32);
	record.push_str("event: ");
	record.push_str(event_name);
	record.push('\n');
	for line in data.split('\n') {
		let line = line.strip_suffix('\r').unwrap_or(line);
		record.push_str("data: ");
		record.push_str(line);
		record.push('\n');
	}
	record.push('\n');
	record
}

#[cfg(test)]
mod tests {
	use successor_protocol::{
		ids::{FrameId, RequestId, SessionId, TurnId},
		kernel_frame::KernelFrameKindV0,
	};

	use super::*;

	fn sample_frame() -> KernelFrameV0 {
		KernelFrameV0::new(
			FrameId::try_from("frame_00000000000000000001".to_owned()).expect("valid frame_ prefix"),
			1,
			SessionId::try_from("ses_test".to_owned()).expect("valid ses_ prefix"),
			TurnId::try_from("turn_test".to_owned()).expect("valid turn_ prefix"),
			RequestId::try_from("req_test".to_owned()).expect("valid req_ prefix"),
			KernelFrameKindV0::TurnStarted,
			"2026-06-23T12:00:00Z",
			serde_json::json!({ "note": "hello" }),
		)
	}

	#[test]
	fn render_sse_record_splits_multiline_data_per_spec() {
		let record = render_sse_record("kernel_frame", "line one\nline two");
		assert_eq!(record, "event: kernel_frame\ndata: line one\ndata: line two\n\n");
	}

	#[test]
	fn render_sse_record_strips_bare_cr_from_crlf_input() {
		let record = render_sse_record("kernel_frame", "line one\r\nline two");
		assert!(!record.contains('\r'), "record must never contain a bare CR: {record:?}");
		assert_eq!(record, "event: kernel_frame\ndata: line one\ndata: line two\n\n");
	}

	#[test]
	fn render_kernel_frame_sse_uses_accepted_event_name_and_single_trailing_blank_line() {
		let record = render_kernel_frame_sse(&sample_frame()).expect("frame serializes");
		let mut lines = record.lines();
		assert_eq!(lines.next(), Some("event: kernel_frame"));
		let data_line = lines.next().expect("data line present");
		assert!(data_line.starts_with("data: "));
		assert_eq!(
			lines.next(),
			Some(""),
			"compact single-line JSON must yield exactly one data line, then the record-terminating \
			 blank line"
		);
		assert_eq!(lines.next(), None, "record must not contain a second trailing blank line");

		assert!(
			record.ends_with("\n\n"),
			"record must end with a single trailing blank line: {record:?}"
		);
		assert!(
			!record.ends_with("\n\n\n"),
			"record must not end with more than one blank line (no double-blank-line trailer): \
			 {record:?}"
		);
		assert!(!record.contains('\r'), "record must never contain a bare CR: {record:?}");
	}

	#[test]
	fn render_kernel_frame_sse_data_line_round_trips_to_the_same_frame() {
		let frame = sample_frame();
		let record = render_kernel_frame_sse(&frame).expect("frame serializes");
		let data_line = record.lines().nth(1).expect("data line present");
		let json = data_line
			.strip_prefix("data: ")
			.expect("data line has data: prefix");
		let round_tripped: KernelFrameV0 =
			serde_json::from_str(json).expect("data line is valid JSON");
		assert_eq!(round_tripped, frame);
	}
}
