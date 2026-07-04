//! Owned by Lane C1 `KernelPlatformClient`.
//!
//! Kernel-side error seam for the platform HTTP client (Dissent ruling 1):
//! wraps the HTTP status code together with the protocol `ErrorEnvelopeV0`
//! when the platform returns one. This is never a parallel error envelope —
//! the platform's `ErrorEnvelopeV0` is carried through verbatim when
//! present. Transport failures and malformed response bodies are classified
//! into a small set of redacted categories: request/response bytes are
//! never retained or echoed.

use std::fmt;

use successor_protocol::error::ErrorEnvelopeV0;

/// Coarse category for a failed HTTP transport (Dissent ruling 1: detail is
/// redacted, no request/response bytes are retained).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportFailureCategory {
	/// Failed to establish or maintain the connection (refused, DNS, TLS
	/// handshake, reset).
	Connect,
	/// The request or response exceeded its deadline.
	Timeout,
	/// The response body could not be streamed or decoded to completion.
	Body,
	/// Any other transport-level failure not covered above.
	Other,
}

impl fmt::Display for TransportFailureCategory {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let label = match self {
			Self::Connect => "connect",
			Self::Timeout => "timeout",
			Self::Body => "body",
			Self::Other => "other",
		};
		f.write_str(label)
	}
}

/// Kernel-side error for a failed
/// [`crate::platform_client::KernelPlatformClient`] call.
///
/// `Debug` and `Display` are safe to log: neither variant carries the
/// bearer token, and the platform never echoes the caller-presented or
/// expected credential in its own `ErrorEnvelopeV0` (proved by
/// `successor-context-platform::http` tests). Transport and decode
/// failures never carry response bytes, only a coarse category.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlatformClientError {
	/// The platform returned a non-2xx response carrying a well-formed
	/// `ErrorEnvelopeV0` body. This is the only variant that carries
	/// server-authored detail; there is no separate kernel envelope. Boxed
	/// because `ErrorEnvelopeV0` is large relative to the other variants.
	#[error("platform returned {status} {}: {}", envelope.code, envelope.message)]
	Protocol { status: u16, envelope: Box<ErrorEnvelopeV0> },

	/// The platform returned a non-2xx response whose body did not parse
	/// as an `ErrorEnvelopeV0`. Body bytes are never retained or echoed.
	#[error("platform returned status {status} with a non-envelope body")]
	UnrecognizedStatus { status: u16 },

	/// The response body did not parse as JSON at all — for example, the
	/// configured base URL pointed at a non-platform listener. Body bytes
	/// are never retained or echoed.
	#[error("platform response body was not valid JSON")]
	MalformedResponse,

	/// The underlying HTTP transport failed before a complete response was
	/// received. Detail is redacted to a coarse category; the underlying
	/// `reqwest::Error` is never retained.
	#[error("platform transport failure: {category}")]
	Transport { category: TransportFailureCategory },
}

impl PlatformClientError {
	/// The HTTP status code the platform returned, when one was received.
	pub const fn http_status(&self) -> Option<u16> {
		match self {
			Self::Protocol { status, .. } | Self::UnrecognizedStatus { status } => Some(*status),
			Self::MalformedResponse | Self::Transport { .. } => None,
		}
	}

	/// The platform's own error envelope, when the failure carried one.
	pub fn envelope(&self) -> Option<&ErrorEnvelopeV0> {
		match self {
			Self::Protocol { envelope, .. } => Some(envelope.as_ref()),
			_ => None,
		}
	}

	/// A coarse, typed retry signal for callers that own their own retry
	/// policy (backoff, attempt counts, circuit breaking). This method only
	/// classifies; it never retries and never sleeps.
	pub fn is_retryable(&self) -> bool {
		match self {
			Self::Protocol { envelope, .. } => envelope.retryable,
			Self::Transport { .. } => true,
			Self::UnrecognizedStatus { .. } | Self::MalformedResponse => false,
		}
	}
}
