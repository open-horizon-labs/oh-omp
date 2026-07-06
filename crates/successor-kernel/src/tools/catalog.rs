//! Fixture-derived Slice 0 tool catalog (Dissent ruling 3).
//!
//! Schema version, catalog identity, tool inventory, categories, and
//! statuses are sourced verbatim from the canonical, sovereign fixture
//! `fixtures/slice-0/tool-catalog.json` via the accepted A1/A2 protocol
//! surface [`successor_protocol::fixtures::tool_catalog`]. This module
//! invents no local schema version, catalog id, tool count, or per-tool
//! metadata beyond what that fixture specifies — [`slice0_catalog`] is a
//! thin, typed accessor over it, not a re-derivation — with one exception:
//! `input_schema` (see [`executable_input_schema`]).
//!
//! Of the 34 cataloged tools, four are `executable`: `search_files`,
//! `read`, `find`, and `grep`. This lane implements only `read`
//! ([`super::read`]); `search_files`, `find`, and `grep` dispatch is owned
//! by Lane C6 `KernelToolSearchFindGrep` and is not implemented here — their
//! catalog entries describe intended status only.
//!
//! Every other cataloged tool is `stub_rejected`. [`stub_rejection_reason`]
//! is a single generalized rejection-reason template applied uniformly
//! across all `stub_rejected` tools — a deterministic policy decision
//! (Dissent ruling 3), not a per-tool invention. Applying it to `bash`
//! reproduces, verbatim, the reason pinned by
//! `fixtures/slice-0/raw-events-unsupported-tool.json`
//! (`"bash is catalog-visible but not executable in Slice 0"`); no
//! bash-specific text is hand-authored separately from that template. The
//! accompanying [`REJECTION_POLICY`] and [`REJECTION_ERROR_CODE`] constants
//! are likewise taken verbatim from that same fixture.
//!
//! ## Post-acceptance amendment: real `input_schema` (<agent://252-ToolSchemaAmendmentDissent>)
//!
//! Real Anthropic rejects a tools array whose entries carry
//! `input_schema: null` with an HTTP 400. [`slice0_catalog`] therefore
//! overlays a real JSON Schema onto each of the four `executable` tools,
//! derived directly from the same kernel-local argument DTOs
//! (`tools::{search_files,read,find,grep}::*Args`) that
//! [`crate::runner`]'s `execute_tool` deserializes against — never a
//! hand-authored schema literal. The canonical fixture is amended
//! (byte-for-byte, generated from that same `schemars` output, never
//! hand-typed) to carry the identical schema bytes, so
//! [`slice0_catalog_matches_the_canonical_fixture_exactly`] keeps proving
//! the two stay in lockstep. `stub_rejected` tools keep `input_schema:
//! None`, exactly as the fixture pins them.

use successor_protocol::tool_catalog::{ToolCatalogV0, ToolStatusV0};

/// Policy label attached to every Slice 0 tool-execution rejection, taken
/// verbatim from `fixtures/slice-0/raw-events-unsupported-tool.json`.
pub const REJECTION_POLICY: &str = "slice0_read_only";

/// Stable error code attached to every Slice 0 tool-execution rejection,
/// taken verbatim from `fixtures/slice-0/raw-events-unsupported-tool.json`.
pub const REJECTION_ERROR_CODE: &str = "tool_not_executable_in_slice0";

/// Policy label for an over-budget tool-call rejection.
///
/// Attached to the raw-event trail when a provider requests a tool call
/// after the live per-turn tool-call maximum
/// (`state_machine::MAX_EXECUTABLE_TOOL_ROUNDS`) is already exhausted
/// (<agent://256> dissent ruling, item A; contract §9 amendment). Distinct
/// from [`REJECTION_POLICY`]: this rejects a request for budget reasons,
/// not because the named tool is stub-rejected in the catalog.
pub const TOOL_BUDGET_REJECTION_POLICY: &str = "slice0_tool_budget_exhausted";

/// Stable error code paired with [`TOOL_BUDGET_REJECTION_POLICY`] on the
/// `error.recorded` event for an over-budget tool-call rejection.
pub const TOOL_BUDGET_REJECTION_ERROR_CODE: &str = "tool_budget_exhausted_in_slice0";

/// The canonical Slice 0 tool catalog, exactly as pinned by
/// `fixtures/slice-0/tool-catalog.json` (34 tools; schema
/// `kernel.tool_catalog.v0`).
pub fn slice0_catalog() -> ToolCatalogV0 {
	let mut catalog = successor_protocol::fixtures::tool_catalog();
	for tool in &mut catalog.tools {
		tool.input_schema = executable_input_schema(&tool.name);
	}
	catalog
}

/// The JSON Schema for an executable Slice 0 tool's arguments, derived
/// directly from the kernel-local DTO that `execute_tool` deserializes
/// against (<agent://252-ToolSchemaAmendmentDissent>, ruling 1/4). `None`
/// for every non-executable (`stub_rejected`/`policy_rejected`) tool.
fn executable_input_schema(tool_name: &str) -> Option<serde_json::Value> {
	let schema = match tool_name {
		"search_files" => schemars::schema_for!(super::search_files::SearchFilesArgs),
		"read" => schemars::schema_for!(super::read::ReadArgs),
		"find" => schemars::schema_for!(super::find::FindArgs),
		"grep" => schemars::schema_for!(super::grep::GrepArgs),
		_ => return None,
	};
	Some(serde_json::to_value(schema).expect("tool argument schema must serialize to JSON"))
}

/// Look up a single tool's catalog status by name.
///
/// Returns `None` if `tool_name` is not present in the Slice 0 catalog at
/// all (as opposed to being present but rejected, which is
/// [`ToolStatusV0::StubRejected`]).
pub fn tool_status(tool_name: &str) -> Option<ToolStatusV0> {
	slice0_catalog()
		.tools
		.into_iter()
		.find(|tool| tool.name == tool_name)
		.map(|tool| tool.status)
}

/// The generalized Slice 0 rejection reason for any non-executable
/// cataloged tool.
///
/// One deterministic template, applied uniformly (Dissent ruling 3):
/// substituting `bash` reproduces
/// `fixtures/slice-0/raw-events-unsupported-tool.json` verbatim. This
/// function does not distinguish between `stub_rejected` and
/// `policy_rejected` tools, and does not inspect the catalog — it is a
/// pure string template over whatever tool name Slice 0 rejects.
pub fn stub_rejection_reason(tool_name: &str) -> String {
	format!("{tool_name} is catalog-visible but not executable in Slice 0")
}

/// Rejection reason for an over-budget tool-call.
///
/// Explains that the tool call was requested after the live per-turn
/// tool-call maximum was already exhausted (<agent://256> dissent ruling,
/// item A; contract §9 amendment). Parameterized by
/// `state_machine::MAX_EXECUTABLE_TOOL_ROUNDS` so the wording stays
/// accurate if that bound changes.
pub fn tool_budget_exhausted_reason(tool_name: &str, max_executable_tool_rounds: u8) -> String {
	format!(
		"tool `{tool_name}` was requested after the Slice 0 per-turn tool-call maximum of \
		 {max_executable_tool_rounds} executable rounds was already exhausted"
	)
}

#[cfg(test)]
mod tests {
	use successor_protocol::tool_catalog::TOOL_CATALOG_SCHEMA_VERSION;

	use super::*;

	#[test]
	fn slice0_catalog_matches_the_canonical_fixture_exactly() {
		assert_eq!(slice0_catalog(), successor_protocol::fixtures::tool_catalog());
	}

	#[test]
	fn slice0_catalog_has_the_pinned_schema_version_and_tool_count() {
		let catalog = slice0_catalog();
		assert_eq!(catalog.schema_version, TOOL_CATALOG_SCHEMA_VERSION);
		assert_eq!(catalog.tools.len(), 34, "Slice 0 catalog must publish exactly 34 tools");
	}

	#[test]
	fn exactly_four_tools_are_executable_and_they_are_the_safe_read_discovery_set() {
		let catalog = slice0_catalog();
		let mut executable: Vec<&str> = catalog
			.tools
			.iter()
			.filter(|tool| tool.status == ToolStatusV0::Executable)
			.map(|tool| tool.name.as_str())
			.collect();
		executable.sort_unstable();
		assert_eq!(executable, vec!["find", "grep", "read", "search_files"]);
	}

	#[test]
	fn bash_is_stub_rejected() {
		assert_eq!(tool_status("bash"), Some(ToolStatusV0::StubRejected));
	}

	#[test]
	fn unknown_tool_name_has_no_catalog_status() {
		assert_eq!(tool_status("definitely-not-a-real-tool"), None);
	}

	#[test]
	fn bash_rejection_reason_and_policy_match_the_unsupported_tool_fixture_exactly() {
		let events = successor_protocol::fixtures::raw_events_unsupported_tool();

		let rejected = events
			.iter()
			.find(|event| event.event_type.as_str() == "tool_call.rejected")
			.expect("fixture must contain a tool_call.rejected event");
		assert_eq!(
			rejected.payload["policy"].as_str(),
			Some(REJECTION_POLICY),
			"REJECTION_POLICY must match the fixture-pinned policy label"
		);
		assert_eq!(
			rejected.payload["reason"].as_str(),
			Some(stub_rejection_reason("bash").as_str()),
			"the generalized template applied to `bash` must reproduce the fixture reason verbatim"
		);

		let error = events
			.iter()
			.find(|event| event.event_type.as_str() == "error.recorded")
			.expect("fixture must contain an error.recorded event");
		assert_eq!(
			error.payload["code"].as_str(),
			Some(REJECTION_ERROR_CODE),
			"REJECTION_ERROR_CODE must match the fixture-pinned error code"
		);
	}
}
