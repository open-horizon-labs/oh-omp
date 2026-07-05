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
			let detail = frame
				.payload
				.get("message")
				.or_else(|| frame.payload.get("detail"))
				.or_else(|| frame.payload.get("reason"))
				.and_then(|value| value.as_str())
				.unwrap_or("turn failed");
			writeln!(writer, "\n[turn failed: {detail}]")
		},
		_ => Ok(()),
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
