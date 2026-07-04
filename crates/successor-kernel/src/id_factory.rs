//! Owned by Lane C7 `KernelTurnRunner`.
//!
//! Identity and time seams for [`crate::runner::TurnRunner`] (C7 Dissent
//! ruling 3).
//!
//! Production code never invents an identifier or a timestamp by hand:
//! every kernel-owned identifier (raw event, turn, request, message,
//! tool-call, frame, trace, provider-event, error) is minted through
//! [`IdFactory`], and every timestamp is read through [`Clock`]. Replay
//! tests substitute [`ScriptedIdFactory`] / [`ScriptedClock`] to reproduce a
//! fixture's exact identifiers and timestamps; production wiring uses
//! [`RealIdFactory`] / [`RealClock`]. Neither seam derives a value from
//! event content — a content-derived identifier would be indistinguishable
//! from a cache key and would violate the "real `UUIDv4`" requirement for
//! production identifiers.
//!
//! `successor-kernel` carries no `uuid`, `rand`, `chrono`, or `time`
//! dependency, and this lane may not add one (Dissent ruling 1: no Cargo
//! changes). [`RealIdFactory`] mints UUIDv4-shaped identifiers using only
//! `std`, drawing entropy from `std::collections::hash_map::RandomState`
//! (which itself seeds from the OS random source on construction) mixed
//! with a monotonic per-process counter and the current time. [`RealClock`]
//! formats `SystemTime` as RFC 3339 by hand using Howard Hinnant's
//! `civil_from_days` algorithm.

use std::{
	collections::VecDeque,
	hash::{BuildHasher, Hasher},
	sync::{
		Mutex,
		atomic::{AtomicU64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use successor_protocol::ids::{
	ArtifactId, ErrorId, EventId, FrameId, MessageId, ProviderEventId, RequestId, SourceEnvelopeId,
	ToolCallId, TraceId, TurnId,
};

/// Mints kernel-owned identifiers for one turn.
///
/// Every method returns a freshly minted, previously-unused identifier.
/// Implementations must never derive an identifier from event content
/// (Dissent ruling 3): from the caller's perspective the value must be
/// indistinguishable from a random `UUIDv4` with the type's stable prefix.
pub trait IdFactory: Send + Sync {
	/// Mints a raw-event identifier (`evt_` prefix).
	fn event_id(&self) -> EventId;
	/// Mints a turn identifier (`turn_` prefix).
	fn turn_id(&self) -> TurnId;
	/// Mints a request identifier (`req_` prefix).
	fn request_id(&self) -> RequestId;
	/// Mints a message identifier (`msg_` prefix).
	fn message_id(&self) -> MessageId;
	/// Mints a tool-call identifier (`tool_` prefix).
	fn tool_call_id(&self) -> ToolCallId;
	/// Mints a kernel-frame identifier (`frame_` prefix).
	fn frame_id(&self) -> FrameId;
	/// Mints a trace identifier (`trace_` prefix).
	fn trace_id(&self) -> TraceId;
	/// Mints a provider-event identifier (`pevt_` prefix).
	fn provider_event_id(&self) -> ProviderEventId;
	/// Mints an error identifier (`err_` prefix).
	fn error_id(&self) -> ErrorId;
	/// Mints a source-envelope identifier (`src_` prefix). The kernel
	/// proposes this value (mirrors `event_id`'s "platform, kernel may
	/// propose" ownership): the platform's append store echoes back
	/// whatever `entity_ids.source_envelope_id` the request carries—it
	/// does not mint one itself.
	fn source_envelope_id(&self) -> SourceEnvelopeId;
	/// Mints an artifact identifier (`art_` prefix). Same proposal model
	/// as `source_envelope_id`: the platform's artifact store echoes the
	/// request's `entity_ids.artifact_id` rather than assigning one.
	fn artifact_id(&self) -> ArtifactId;
	/// Mints a kernel-internal tool-catalog snapshot identifier
	/// (`catalog_` prefix). Not a `successor_protocol::ids` typed identifier
	/// (that crate is not owned by this lane): `tool_catalog.published`'s
	/// payload only needs an opaque, freshly-minted, non-content-derived
	/// label, so this returns a raw prefixed string rather than a new
	/// protocol-level ID type.
	fn catalog_id(&self) -> String;
}

/// Reads the current time for one turn.
///
/// Returns an RFC 3339 UTC timestamp with second precision and a literal
/// `Z` offset, matching the canonical fixtures' `occurred_at`/`ts` shape
/// (e.g. `"2026-06-23T12:00:00Z"`).
pub trait Clock: Send + Sync {
	fn now(&self) -> String;
}

// ---------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------

/// Mints real UUIDv4-shaped identifiers without a `uuid` crate dependency.
///
/// Entropy is drawn from `std::collections::hash_map::RandomState` (which
/// seeds itself from the OS random source on construction), mixed with a
/// monotonic in-process counter and the current wall-clock time so that
/// concurrent `RealIdFactory` instances cannot collide.
#[derive(Debug, Default)]
pub struct RealIdFactory {
	counter: AtomicU64,
}

impl RealIdFactory {
	pub const fn new() -> Self {
		Self { counter: AtomicU64::new(0) }
	}

	fn random_u64(&self) -> u64 {
		let tick = self.counter.fetch_add(1, Ordering::Relaxed);
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or_default();
		// `RandomState::new()` seeds itself from the OS random source on
		// every construction; hashing varying inputs through it yields
		// unpredictable, non-content-derived bits without a `rand` crate.
		let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
		hasher.write_u64(tick);
		hasher.write_u128(nanos);
		hasher.write_usize(std::ptr::from_ref(self) as usize);
		hasher.finish()
	}

	fn new_uuid_v4(&self) -> String {
		let hi = self.random_u64();
		let lo = self.random_u64();
		let mut bytes = [0u8; 16];
		bytes[..8].copy_from_slice(&hi.to_be_bytes());
		bytes[8..].copy_from_slice(&lo.to_be_bytes());
		// RFC 4122 version 4 / variant 1 bits.
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		format_uuid_bytes(&bytes)
	}
}

fn format_uuid_bytes(bytes: &[u8; 16]) -> String {
	format!(
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:\
		 02x}{:02x}",
		bytes[0],
		bytes[1],
		bytes[2],
		bytes[3],
		bytes[4],
		bytes[5],
		bytes[6],
		bytes[7],
		bytes[8],
		bytes[9],
		bytes[10],
		bytes[11],
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15]
	)
}

macro_rules! impl_id_factory_method {
	($method:ident, $ty:ty) => {
		fn $method(&self) -> $ty {
			<$ty>::from_raw(format!("{}{}", <$ty>::PREFIX, self.new_uuid_v4()))
		}
	};
}

impl IdFactory for RealIdFactory {
	impl_id_factory_method!(event_id, EventId);

	impl_id_factory_method!(turn_id, TurnId);

	impl_id_factory_method!(request_id, RequestId);

	impl_id_factory_method!(message_id, MessageId);

	impl_id_factory_method!(tool_call_id, ToolCallId);

	impl_id_factory_method!(frame_id, FrameId);

	impl_id_factory_method!(trace_id, TraceId);

	impl_id_factory_method!(provider_event_id, ProviderEventId);

	impl_id_factory_method!(error_id, ErrorId);

	impl_id_factory_method!(source_envelope_id, SourceEnvelopeId);

	impl_id_factory_method!(artifact_id, ArtifactId);

	fn catalog_id(&self) -> String {
		format!("catalog_{}", self.new_uuid_v4())
	}
}

/// Reads the real wall clock, formatted as RFC 3339 UTC with second
/// precision.
#[derive(Debug, Default, Clone, Copy)]
pub struct RealClock;

impl Clock for RealClock {
	fn now(&self) -> String {
		let unix_secs = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_secs())
			.unwrap_or_default();
		format_unix_seconds_as_rfc3339(unix_secs)
	}
}

/// Converts a Unix timestamp (whole seconds) to an RFC 3339 UTC string with
/// second precision, e.g. `"2026-06-23T12:00:00Z"`.
///
/// Implements Howard Hinnant's `civil_from_days` algorithm by hand since
/// this crate carries no `chrono`/`time` dependency.
fn format_unix_seconds_as_rfc3339(unix_secs: u64) -> String {
	let days = i64::try_from(unix_secs / 86_400).unwrap_or(i64::MAX);
	let secs_of_day = unix_secs % 86_400;
	let (year, month, day) = civil_from_days(days);
	let hour = secs_of_day / 3600;
	let minute = (secs_of_day % 3600) / 60;
	let second = secs_of_day % 60;
	format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant's `civil_from_days`: days since `1970-01-01` -> `(y, m,
/// d)`. See <https://howardhinnant.github.io/date_algorithms.html>.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
	let z = z + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = u64::try_from(z - era * 146_097).unwrap_or(0); // [0, 146096]
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
	let y = i64::try_from(yoe).unwrap_or(0) + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
	let mp = (5 * doy + 2) / 153; // [0, 11]
	let d = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1); // [1, 31]
	let m = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1); // [1, 12]
	let year = if m <= 2 { y + 1 } else { y };
	(year, m, d)
}

// ---------------------------------------------------------------------
// Replay / test seams
// ---------------------------------------------------------------------

/// Test/replay seam: mints identifiers from a pre-scripted sequence.
///
/// All [`IdFactory`] methods share a single underlying queue: the script is
/// a flat list of fully-prefixed identifier strings (e.g.
/// `"evt_00000000-0000-4000-8000-000000000001"`), supplied in the exact
/// order the runner will request them. Each method validates that the
/// popped value carries the expected type's prefix, so a mis-ordered script
/// fails immediately with a clear panic rather than silently mislabeling an
/// identifier.
///
/// Panics (loudly, at the call site) when the script is exhausted, rather
/// than falling back to a different generation strategy: a replay test that
/// runs out of scripted identifiers has a wrong fixture-to-runner call
/// count, and that must fail immediately rather than degrade into
/// non-deterministic behavior.
#[derive(Debug)]
pub struct ScriptedIdFactory {
	remaining: Mutex<VecDeque<String>>,
}

impl ScriptedIdFactory {
	pub fn new(script: impl IntoIterator<Item = impl Into<String>>) -> Self {
		Self { remaining: Mutex::new(script.into_iter().map(Into::into).collect()) }
	}

	fn next_raw(&self, requested_for: &'static str) -> String {
		self
			.remaining
			.lock()
			.expect("ScriptedIdFactory mutex poisoned")
			.pop_front()
			.unwrap_or_else(|| {
				panic!("ScriptedIdFactory script exhausted while requesting a {requested_for}")
			})
	}
}

macro_rules! impl_scripted_id_factory_method {
	($method:ident, $ty:ty, $label:literal) => {
		fn $method(&self) -> $ty {
			let raw = self.next_raw($label);
			<$ty>::try_from(raw.clone()).unwrap_or_else(|_| {
				panic!("scripted {} `{raw}` must carry the `{}` prefix", $label, <$ty>::PREFIX)
			})
		}
	};
}

impl IdFactory for ScriptedIdFactory {
	impl_scripted_id_factory_method!(event_id, EventId, "event_id");

	impl_scripted_id_factory_method!(turn_id, TurnId, "turn_id");

	impl_scripted_id_factory_method!(request_id, RequestId, "request_id");

	impl_scripted_id_factory_method!(message_id, MessageId, "message_id");

	impl_scripted_id_factory_method!(tool_call_id, ToolCallId, "tool_call_id");

	impl_scripted_id_factory_method!(frame_id, FrameId, "frame_id");

	impl_scripted_id_factory_method!(trace_id, TraceId, "trace_id");

	impl_scripted_id_factory_method!(provider_event_id, ProviderEventId, "provider_event_id");

	impl_scripted_id_factory_method!(error_id, ErrorId, "error_id");

	impl_scripted_id_factory_method!(source_envelope_id, SourceEnvelopeId, "source_envelope_id");

	impl_scripted_id_factory_method!(artifact_id, ArtifactId, "artifact_id");

	fn catalog_id(&self) -> String {
		self.next_raw("catalog_id")
	}
}

/// Test/replay seam: reads timestamps from a pre-scripted sequence.
///
/// Panics loudly when exhausted, for the same reason as
/// [`ScriptedIdFactory`].
#[derive(Debug)]
pub struct ScriptedClock {
	remaining: Mutex<VecDeque<String>>,
}

impl ScriptedClock {
	pub fn new(script: impl IntoIterator<Item = impl Into<String>>) -> Self {
		Self { remaining: Mutex::new(script.into_iter().map(Into::into).collect()) }
	}
}

impl Clock for ScriptedClock {
	fn now(&self) -> String {
		self
			.remaining
			.lock()
			.expect("ScriptedClock mutex poisoned")
			.pop_front()
			.expect("ScriptedClock script exhausted: runner requested more timestamps than scripted")
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn real_id_factory_mints_correctly_prefixed_distinct_ids() {
		let factory = RealIdFactory::new();
		let a = factory.event_id();
		let b = factory.event_id();
		assert!(a.as_str().starts_with(EventId::PREFIX));
		assert_ne!(a, b, "two consecutive event ids must not collide");
	}

	#[test]
	fn real_id_factory_produces_rfc4122_version_and_variant_bits() {
		let factory = RealIdFactory::new();
		let turn = factory.turn_id();
		let suffix = turn.as_str().strip_prefix(TurnId::PREFIX).expect("prefix");
		let hex_only: String = suffix.chars().filter(|c| *c != '-').collect();
		assert_eq!(hex_only.len(), 32, "uuid suffix must be 32 hex digits: {suffix}");
		assert_eq!(&hex_only[12..13], "4", "version nibble must be 4: {suffix}");
		let variant_nibble = u8::from_str_radix(&hex_only[16..17], 16).expect("hex nibble");
		assert_eq!(variant_nibble & 0b1100, 0b1000, "variant bits must be RFC 4122: {suffix}");
	}

	#[test]
	fn real_clock_formats_a_known_epoch_second_as_expected_rfc3339() {
		// 2021-01-01T00:00:00Z, a widely-cited reference Unix timestamp.
		assert_eq!(format_unix_seconds_as_rfc3339(1_609_459_200), "2021-01-01T00:00:00Z");
		assert_eq!(format_unix_seconds_as_rfc3339(0), "1970-01-01T00:00:00Z");
	}

	#[test]
	fn scripted_id_factory_returns_values_in_call_order_and_validates_prefix() {
		let factory = ScriptedIdFactory::new([
			"evt_00000000-0000-4000-8000-000000000001",
			"turn_00000000-0000-4000-8000-000000000001",
		]);
		assert_eq!(factory.event_id().as_str(), "evt_00000000-0000-4000-8000-000000000001");
		assert_eq!(factory.turn_id().as_str(), "turn_00000000-0000-4000-8000-000000000001");
	}

	#[test]
	#[should_panic(expected = "script exhausted")]
	fn scripted_id_factory_panics_loudly_when_exhausted() {
		let factory = ScriptedIdFactory::new(Vec::<String>::new());
		let _ = factory.event_id();
	}

	#[test]
	#[should_panic(expected = "must carry the")]
	fn scripted_id_factory_panics_on_prefix_mismatch() {
		let factory = ScriptedIdFactory::new(["turn_00000000-0000-4000-8000-000000000001"]);
		let _ = factory.event_id();
	}

	#[test]
	fn scripted_clock_returns_timestamps_in_call_order() {
		let clock = ScriptedClock::new(["2026-06-23T12:00:00Z", "2026-06-23T12:00:01Z"]);
		assert_eq!(clock.now(), "2026-06-23T12:00:00Z");
		assert_eq!(clock.now(), "2026-06-23T12:00:01Z");
	}

	#[test]
	#[should_panic(expected = "script exhausted")]
	fn scripted_clock_panics_loudly_when_exhausted() {
		let clock = ScriptedClock::new(Vec::<String>::new());
		let _ = clock.now();
	}
}
