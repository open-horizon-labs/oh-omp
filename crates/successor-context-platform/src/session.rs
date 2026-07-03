//! Session domain helpers.
//!
//! Identity minting and response construction for session creation live
//! here as pure functions so they can be unit-tested without a database.
//! Persistence itself (the `sessions` table) lives in `sqlite.rs`.

use successor_protocol::ids::SessionId;
use uuid::Uuid;

/// Mints a fresh, protocol-valid `SessionId`.
///
/// `SessionId::PREFIX` already includes the trailing separator (`"ses_"`),
/// so this only needs to append an opaque, collision-resistant suffix.
#[must_use]
pub fn new_session_id() -> SessionId {
	SessionId::from_raw(format!("{}{}", SessionId::PREFIX, Uuid::new_v4().simple()))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn new_session_id_has_stable_prefix() {
		let id = new_session_id();
		assert!(id.as_str().starts_with(SessionId::PREFIX));
	}

	#[test]
	fn new_session_id_is_unique_across_calls() {
		let a = new_session_id();
		let b = new_session_id();
		assert_ne!(a.as_str(), b.as_str());
	}
}
