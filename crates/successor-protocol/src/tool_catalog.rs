//! Declarative protocol DTOs for publishing the Slice 0 tool catalog.
//!
//! These types describe catalog data that can be referenced by
//! `tool_catalog.published` raw events. They intentionally contain no
//! executable tool dispatch, no provider behavior, and no silent no-op
//! semantics.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const TOOL_CATALOG_SCHEMA_VERSION: &str = "kernel.tool_catalog.v0";

#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ToolAuthorityClassV0 {
	SafeRead,
	WorkspaceMutation,
	LocalProcess,
}

impl ToolAuthorityClassV0 {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::SafeRead => "safe_read",
			Self::WorkspaceMutation => "workspace_mutation",
			Self::LocalProcess => "local_process",
		}
	}
}

impl std::fmt::Display for ToolAuthorityClassV0 {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolAuthorityRequestV0 {
	pub classes: Vec<ToolAuthorityClassV0>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatusV0 {
	Executable,
	StubRejected,
	PolicyRejected,
}

impl ToolStatusV0 {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Executable => "executable",
			Self::StubRejected => "stub_rejected",
			Self::PolicyRejected => "policy_rejected",
		}
	}
}

impl std::fmt::Display for ToolStatusV0 {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolDefinitionV0 {
	pub name:         String,
	pub category:     String,
	pub status:       ToolStatusV0,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description:  Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub input_schema: Option<serde_json::Value>,
}

impl ToolDefinitionV0 {
	pub fn executable(
		name: impl Into<String>,
		category: impl Into<String>,
		description: impl Into<String>,
	) -> Self {
		Self {
			name:         name.into(),
			category:     category.into(),
			status:       ToolStatusV0::Executable,
			description:  Some(description.into()),
			input_schema: None,
		}
	}

	pub fn stub_rejected(name: impl Into<String>, category: impl Into<String>) -> Self {
		Self {
			name:         name.into(),
			category:     category.into(),
			status:       ToolStatusV0::StubRejected,
			description:  None,
			input_schema: None,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolCatalogV0 {
	pub schema_version:     String,
	pub catalog_id:         String,
	pub published_at:       String,
	pub projection_version: String,
	pub tools:              Vec<ToolDefinitionV0>,
}

impl ToolCatalogV0 {
	pub fn new(
		catalog_id: impl Into<String>,
		published_at: impl Into<String>,
		projection_version: impl Into<String>,
		tools: Vec<ToolDefinitionV0>,
	) -> Self {
		Self {
			schema_version: TOOL_CATALOG_SCHEMA_VERSION.to_owned(),
			catalog_id: catalog_id.into(),
			published_at: published_at.into(),
			projection_version: projection_version.into(),
			tools,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn tool_catalog_rejects_unknown_top_level_fields() {
		let value = serde_json::json!({
			 "schema_version": "kernel.tool_catalog.v0",
			 "catalog_id": "catalog_test",
			 "published_at": "2026-01-01T00:00:00Z",
			 "projection_version": "slice0.projection.v0",
			 "api_key": "sk-not-real",
			 "tools": []
		});

		assert!(
			serde_json::from_value::<ToolCatalogV0>(value).is_err(),
			"tool catalog must reject unknown top-level fields"
		);
	}

	#[test]
	fn tool_catalog_rejects_unknown_tool_definition_fields() {
		let value = serde_json::json!({
			 "schema_version": "kernel.tool_catalog.v0",
			 "catalog_id": "catalog_test",
			 "published_at": "2026-01-01T00:00:00Z",
			 "projection_version": "slice0.projection.v0",
			 "tools": [{
				  "name": "read",
				  "category": "filesystem",
				  "status": "executable",
				  "api_key": "sk-not-real"
			 }]
		});

		assert!(
			serde_json::from_value::<ToolCatalogV0>(value).is_err(),
			"tool catalog must reject unknown tool definition fields"
		);
	}

	#[test]
	fn tool_authority_class_wire_strings_are_stable() {
		assert_eq!(
			serde_json::to_value(ToolAuthorityClassV0::SafeRead).expect("serialize safe_read"),
			serde_json::json!("safe_read")
		);
		assert_eq!(
			serde_json::to_value(ToolAuthorityClassV0::WorkspaceMutation)
				.expect("serialize workspace_mutation"),
			serde_json::json!("workspace_mutation")
		);
		assert_eq!(
			serde_json::to_value(ToolAuthorityClassV0::LocalProcess).expect("serialize local_process"),
			serde_json::json!("local_process")
		);
	}

	#[test]
	fn tool_authority_request_rejects_unknown_fields_and_classes() {
		let unknown_field = serde_json::json!({
			"classes": ["safe_read"],
			"provider_policy": "sk-not-real"
		});
		assert!(
			serde_json::from_value::<ToolAuthorityRequestV0>(unknown_field).is_err(),
			"tool authority request must reject unknown fields"
		);

		let unknown_class = serde_json::json!({ "classes": ["safe_read", "network"] });
		assert!(
			serde_json::from_value::<ToolAuthorityRequestV0>(unknown_class).is_err(),
			"tool authority request must reject unknown classes at the serde boundary"
		);
	}

	#[test]
	fn tool_authority_request_round_trips_and_generates_schema() {
		let request = ToolAuthorityRequestV0 {
			classes: vec![ToolAuthorityClassV0::SafeRead, ToolAuthorityClassV0::LocalProcess],
		};

		let value = serde_json::to_value(&request).expect("serialize authority request");
		assert_eq!(value, serde_json::json!({ "classes": ["safe_read", "local_process"] }));
		let decoded: ToolAuthorityRequestV0 =
			serde_json::from_value(value).expect("deserialize authority request");
		assert_eq!(decoded, request);

		let schema = schemars::schema_for!(ToolAuthorityRequestV0);
		let schema_value = serde_json::to_value(schema).expect("schema is json");
		assert_eq!(schema_value["type"], "object");
		assert!(
			schema_value["properties"].get("classes").is_some(),
			"generated schema must expose the stable class collection field"
		);
	}
}
