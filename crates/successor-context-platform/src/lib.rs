//! Successor context platform crate.
//!
//! Owns the Context Platform HTTP API (`SLICE-0-CONTRACT.md` §6,
//! `SLICE-0-DISPATCH-MAP.md` §4.2): sessions, raw events, artifacts, and
//! `/assemble`. Lane B1 (`PlatformAuthHttpShell`) lands the crate shell,
//! the platform entitlement auth boundary, and error-envelope mapping.
//! Storage, artifacts, projection/replay, assembly, and the real route
//! handlers are added by later platform lanes (B2-B6).

pub mod artifacts;
pub mod auth;
pub mod error;
pub mod http;
pub mod idempotency;
pub mod projection;
pub mod replay;
pub mod session;
pub mod source_index;
pub mod sqlite;
pub mod store;
pub mod trace_index;
