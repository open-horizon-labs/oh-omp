//! Context Platform HTTP server entrypoint.
//!
//! Reads `MEMEX_LICENSE` from the environment and binds the `/v0` platform
//! router built by lane B1 (`crate::http::build_router`), wired to a single
//! `SQLite` database (lane B6, `crate::routes::PlatformState`).

use anyhow::Context;
use successor_context_platform::{
	auth::PlatformLicense, http::build_router, routes::PlatformState,
};

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8787";
const DEFAULT_DB_PATH: &str = "successor-context-platform.sqlite3";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
	tracing_subscriber::fmt::init();

	let license = PlatformLicense::from_env()
		.context("MEMEX_LICENSE must be set to a non-empty platform entitlement value")?;

	let db_path =
		std::env::var("SUCCESSOR_CONTEXT_PLATFORM_DB").unwrap_or_else(|_| DEFAULT_DB_PATH.to_owned());
	let state = std::sync::Arc::new(
		PlatformState::connect(&db_path)
			.await
			.with_context(|| format!("failed to connect platform database at {db_path}"))?,
	);

	let bind_addr = std::env::var("SUCCESSOR_CONTEXT_PLATFORM_ADDR")
		.unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_owned());
	let listener = tokio::net::TcpListener::bind(&bind_addr)
		.await
		.with_context(|| format!("failed to bind {bind_addr}"))?;

	tracing::info!(addr = %bind_addr, "successor-context-platform listening");

	axum::serve(listener, build_router(license, state))
		.await
		.context("server error")?;
	Ok(())
}
