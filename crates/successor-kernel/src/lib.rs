//! Successor kernel crate.
//!
//! Module tree for the standalone kernel: platform client (C1), frame
//! streaming (C2), provider auth/projection (C3-C4), tool execution (C5-C6),
//! turn runner (C7), and local RPC/SSE surface (C8: `api`, `http`, `routes`,
//! wired over the accepted C1-C7 APIs). Any module not yet listed above as
//! implemented remains a shell stub pending its owning lane.

pub mod api;
pub mod config;
pub mod frame_sink;
pub mod http;
pub mod id_factory;
pub mod platform_client;
pub mod platform_error;
pub mod platform_http;
pub mod provider;
pub mod routes;
pub mod runner;
pub mod sse;
pub mod state_machine;
pub mod stream;
pub mod tools;
pub mod turn_trace;
