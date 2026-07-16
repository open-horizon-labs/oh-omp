use std::{
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use serde_json::json;
use successor_kernel::tools::{
	bash::{TrustedExecutable, TrustedExecutableAllowlist},
	catalog, find, grep, list_dir, read, registry, search_files,
};
use successor_protocol::{artifact::ArtifactHash, fixtures, tool_catalog::ToolStatusV0};

fn unique_temp_dir(label: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir()
		.join(format!("successor-kernel-tool-registry-{label}-{}-{n}", std::process::id()))
}

fn seed_workspace(label: &str) -> PathBuf {
	let root = unique_temp_dir(label);
	std::fs::create_dir_all(root.join("nested")).expect("create seeded workspace");
	std::fs::write(root.join("hello.txt"), b"hello registry\nsecond line\n")
		.expect("seed hello.txt");
	std::fs::write(root.join("nested/other.rs"), b"fn main() { println!(\"hello\"); }\n")
		.expect("seed nested source");
	root
}

#[test]
fn registry_executable_roster_matches_catalog_order_exactly() {
	let registry = registry::slice0_registry();
	let catalog = catalog::slice0_catalog();
	let executable_from_catalog: Vec<&str> = catalog
		.tools
		.iter()
		.filter(|tool| tool.status == ToolStatusV0::Executable)
		.map(|tool| tool.name.as_str())
		.collect();
	let executable_from_registry: Vec<&str> = registry.executable_names().collect();

	assert_eq!(catalog, fixtures::tool_catalog(), "registry work must not perturb catalog bytes");
	assert_eq!(catalog.tools.len(), 35, "Slice 0 catalog must remain the 35-entry fixture");
	assert_eq!(
		executable_from_registry,
		vec!["search_files", "read", "find", "grep", "list_dir", "ast_grep", "edit", "write", "bash"],
		"registry executable order is a byte-sensitive contract because provider catalog order is \
		 fixed"
	);
	assert_eq!(
		executable_from_registry, executable_from_catalog,
		"the registry must not add, drop, or reorder executable names relative to the catalog"
	);
}

#[test]
fn edit_and_write_expected_sha256_schemas_use_bare_lowercase_hex_and_write_hash_is_optional() {
	let catalog = catalog::slice0_catalog();

	let edit_tool = catalog
		.tools
		.iter()
		.find(|tool| tool.name == "edit")
		.expect("catalog must define an edit tool");
	let write_tool = catalog
		.tools
		.iter()
		.find(|tool| tool.name == "write")
		.expect("catalog must define a write tool");

	let edit_schema = edit_tool
		.input_schema
		.as_ref()
		.expect("edit tool must carry a generated schema");
	let write_schema = write_tool
		.input_schema
		.as_ref()
		.expect("write tool must carry a generated schema");

	let edit_hash = &edit_schema["properties"]["expected_sha256"];
	let write_hash = &write_schema["properties"]["expected_sha256"];

	assert_eq!(
		edit_hash["pattern"],
		json!("^(sha256:)?[0-9a-f]{64}$"),
		"edit expected_sha256 pattern must accept the sha256: prefix or bare lowercase hex"
	);
	assert_eq!(
		write_hash["pattern"],
		json!("^(sha256:)?[0-9a-f]{64}$"),
		"write expected_sha256 pattern must match edit's exactly"
	);

	let edit_description = edit_hash["description"]
		.as_str()
		.expect("edit description must be a string");
	let write_description = write_hash["description"]
		.as_str()
		.expect("write description must be a string");
	assert!(
		edit_description.contains("bare lowercase hex"),
		"edit expected_sha256 description must name bare lowercase hex, got {edit_description:?}"
	);
	assert!(
		write_description.contains("bare lowercase hex"),
		"write expected_sha256 description must name bare lowercase hex, got {write_description:?}"
	);

	assert_eq!(
		edit_hash["type"],
		json!("string"),
		"edit expected_sha256 property type must be exactly string, not an optional/null-union type"
	);
	assert_eq!(
		write_hash["type"],
		json!("string"),
		"write expected_sha256 property type must be exactly string, not an optional/null-union type"
	);

	assert!(
		edit_hash.get("default").is_none(),
		"edit expected_sha256 must not advertise a schema default"
	);
	assert!(
		write_hash.get("default").is_none(),
		"write expected_sha256 must not advertise a schema default now that optionality is \
		 expressed via absence from required"
	);

	let edit_required: Vec<&str> = edit_schema["required"]
		.as_array()
		.expect("edit schema must declare a required array")
		.iter()
		.map(|value| value.as_str().expect("required entries must be strings"))
		.collect();
	let write_required: Vec<&str> = write_schema["required"]
		.as_array()
		.expect("write schema must declare a required array")
		.iter()
		.map(|value| value.as_str().expect("required entries must be strings"))
		.collect();

	assert!(
		edit_required.contains(&"expected_sha256"),
		"edit's expected_sha256 precondition must remain required, got {edit_required:?}"
	);
	assert!(
		!write_required.contains(&"expected_sha256"),
		"write's expected_sha256 must not be globally required, got {write_required:?}"
	);
}

#[test]
fn every_executable_catalog_entry_dispatches_and_every_stub_does_not() {
	let registry = registry::slice0_registry();
	let root = seed_workspace("dispatchability");
	let mut allowlist = TrustedExecutableAllowlist::default();
	allowlist
		.insert(
			TrustedExecutable::new("echo", Path::new("/bin/echo"), Vec::new())
				.expect("valid trusted executable"),
		)
		.expect("insert trusted executable");
	let ctx =
		registry::ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
	let catalog = catalog::slice0_catalog();
	let hello_sha256 = ArtifactHash::compute(b"hello registry\nsecond line\n").to_string();

	for tool in &catalog.tools {
		if tool.status == ToolStatusV0::Executable {
			let args = match tool.name.as_str() {
				"search_files" => json!({ "query": "hello" }),
				"read" => json!({ "path": "hello.txt" }),
				"list_dir" => json!({ "path": "." }),
				"find" => json!({ "glob": "**/*.txt" }),
				"grep" => json!({ "pattern": "hello" }),
				"ast_grep" => json!({ "lang": "rust", "pat": ["fn $NAME() {}"] }),
				"edit" => json!({
					"path": "hello.txt",
					"expected_sha256": hello_sha256,
					"edits": [{
						"start": { "line": 1, "column": 0 },
						"end": { "line": 1, "column": 14 },
						"replacement": "hello updated",
					}],
				}),
				"write" => json!({
					"path": "written_by_registry_test.txt",
					"mode": "create",
					"content": "hello from write",
				}),
				"bash" => json!({ "executable": "echo" }),
				other => panic!("unexpected executable tool in catalog: {other}"),
			};
			assert!(registry.is_dispatchable(&tool.name), "{} must have registry dispatch", tool.name);
			registry
				.execute(&ctx, &tool.name, &args)
				.unwrap_or_else(|err| panic!("{} must dispatch successfully: {err}", tool.name));
		} else {
			assert!(
				!registry.is_dispatchable(&tool.name),
				"non-executable catalog entry {} must not have registry dispatch",
				tool.name
			);
		}
	}

	std::fs::remove_dir_all(root).expect("cleanup seeded workspace");
}

#[test]
fn unknown_tool_name_is_not_dispatchable_and_fails_before_any_executor_path() {
	let registry = registry::slice0_registry();
	let root = seed_workspace("unknown");
	let allowlist = TrustedExecutableAllowlist::default();
	let ctx =
		registry::ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };

	assert!(!registry.is_dispatchable("definitely_not_real"));
	let err = registry
		.execute(&ctx, "definitely_not_real", &json!({}))
		.expect_err("unknown tool names must not dispatch");
	assert!(
		err.contains("has no dispatch wiring"),
		"unknown dispatch error must stay typed and diagnosable, got {err:?}"
	);

	std::fs::remove_dir_all(root).expect("cleanup seeded workspace");
}

#[test]
fn registry_uses_existing_dto_parsers_and_tool_result_bytes() {
	let registry = registry::slice0_registry();
	let root = seed_workspace("semantics");
	let allowlist = TrustedExecutableAllowlist::default();
	let ctx =
		registry::ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };

	let malformed = registry
		.execute(&ctx, "read", &json!({ "path": "hello.txt", "max_bytes": 10 }))
		.expect_err(
			"read DTO deny_unknown_fields must remain the source of malformed-argument failures",
		);
	assert!(
		malformed.contains("unknown field `max_bytes`"),
		"unexpected malformed-argument error: {malformed}"
	);

	let search_direct =
		search_files::search_files(&root, "hello", 20).expect("direct search_files succeeds");
	let search_registry = registry
		.execute(&ctx, "search_files", &json!({ "query": "hello" }))
		.expect("registry search_files succeeds");
	assert_eq!(search_registry.artifact.sha256, search_direct.sha256);
	assert_eq!(search_registry.artifact.byte_length, search_direct.byte_length);
	assert_eq!(
		search_registry.artifact.content.as_deref(),
		Some(String::from_utf8_lossy(&search_direct.bytes).as_ref())
	);
	assert_eq!(
		search_registry.payload["matches"],
		serde_json::to_value(&search_direct.matches).expect("serialize matches")
	);

	let read_direct = read::read(&root, "hello.txt", None, None).expect("direct read succeeds");
	let read_registry = registry
		.execute(&ctx, "read", &json!({ "path": "hello.txt" }))
		.expect("registry read succeeds");
	assert_eq!(read_registry.artifact.sha256, read_direct.sha256);
	assert_eq!(read_registry.artifact.byte_length, read_direct.byte_length);
	assert_eq!(
		read_registry.provider_result_text,
		format!(
			"expected_sha256: {}\ncontent_scope: full_file\ncontent_truncated: false\ncontent:\n{}",
			read_direct.file_sha256,
			String::from_utf8_lossy(&read_direct.bytes),
		),
	);
	assert_eq!(read_registry.payload["expected_sha256"], read_direct.file_sha256.as_str());
	assert_eq!(read_registry.payload["content_scope"], "full_file");
	assert_eq!(read_registry.payload["provider_result_truncated"], false);

	let list_direct = list_dir::list_dir(&root, ".").expect("direct list_dir succeeds");
	let list_registry = registry
		.execute(&ctx, "list_dir", &json!({ "path": "." }))
		.expect("registry list_dir succeeds");
	assert_eq!(list_registry.artifact.sha256, list_direct.sha256);
	assert_eq!(
		list_registry.payload["entries"],
		serde_json::to_value(&list_direct.entries).expect("serialize entries")
	);

	let find_direct = find::find(&root, "**/*.txt", 2_000).expect("direct find succeeds");
	let find_registry = registry
		.execute(&ctx, "find", &json!({ "glob": "**/*.txt" }))
		.expect("registry find succeeds");
	assert_eq!(find_registry.artifact.sha256, find_direct.sha256);
	assert_eq!(
		find_registry.payload["matches"],
		serde_json::to_value(&find_direct.entries).expect("serialize entries")
	);

	let grep_direct = grep::grep(&root, "hello", 2_000).expect("direct grep succeeds");
	let grep_registry = registry
		.execute(&ctx, "grep", &json!({ "pattern": "hello" }))
		.expect("registry grep succeeds");
	assert_eq!(grep_registry.artifact.sha256, grep_direct.sha256);
	assert_eq!(
		grep_registry.payload["matches"],
		serde_json::to_value(&grep_direct.matches).expect("serialize matches")
	);

	std::fs::remove_dir_all(root).expect("cleanup seeded workspace");
}

#[test]
fn registry_read_uses_the_whole_file_hash_for_selected_ranges() {
	let registry = registry::slice0_registry();
	let root = seed_workspace("ranged-read-precondition");
	let allowlist = TrustedExecutableAllowlist::default();
	let ctx =
		registry::ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
	let whole_file = b"hello registry\nsecond line\n";
	let read_direct =
		read::read(&root, "hello.txt", std::num::NonZeroU32::new(2), std::num::NonZeroU32::new(1))
			.expect("direct ranged read succeeds");
	let read_registry = registry
		.execute(&ctx, "read", &json!({ "path": "hello.txt", "offset": 2, "limit": 1 }))
		.expect("registry ranged read succeeds");

	assert_eq!(read_direct.bytes, b"second line\n");
	assert_eq!(read_direct.file_sha256, ArtifactHash::compute(whole_file));
	assert_ne!(read_direct.file_sha256, read_direct.sha256);
	assert_eq!(read_registry.artifact.sha256, read_direct.sha256);
	assert_eq!(
		read_registry.provider_result_text,
		format!(
			"expected_sha256: {}\ncontent_scope: selected_range\ncontent_truncated: \
			 false\ncontent:\nsecond line\n",
			read_direct.file_sha256,
		),
	);
	assert_eq!(read_registry.payload["expected_sha256"], read_direct.file_sha256.as_str());
	assert_eq!(read_registry.payload["content_scope"], "selected_range");
	assert_eq!(read_registry.payload["provider_result_truncated"], false);

	std::fs::remove_dir_all(root).expect("cleanup ranged-read workspace");
}

#[test]
fn registry_read_marks_provider_content_truncated_within_the_byte_budget() {
	let registry = registry::slice0_registry();
	let root = seed_workspace("large-read-bound");
	let tail = "TAIL-MUST-BE-OMITTED";
	let false_prefix_length = format!(
		"expected_sha256: {}\ncontent_scope: full_file\ncontent_truncated: false\ncontent:\n",
		ArtifactHash::compute(&[]),
	)
	.len();
	let content_length = 200_000 - false_prefix_length + 1;
	let large_text = format!("{}{tail}", "x".repeat(content_length - tail.len()));
	assert_eq!(false_prefix_length + large_text.len(), 200_001);
	std::fs::write(root.join("large.txt"), &large_text).expect("seed large text file");
	let allowlist = TrustedExecutableAllowlist::default();
	let ctx =
		registry::ToolExecutionContext { workspace_root: &root, process_allowlist: &allowlist };
	let result = registry
		.execute(&ctx, "read", &json!({ "path": "large.txt" }))
		.expect("registry large read succeeds");
	let expected_hash = ArtifactHash::compute(large_text.as_bytes());
	let expected_prefix = format!(
		"expected_sha256: {expected_hash}\ncontent_scope: full_file\ncontent_truncated: \
		 true\ncontent:\n"
	);

	assert!(result.provider_result_text.starts_with(&expected_prefix));
	assert!(result.provider_result_text.len() <= 200_000);
	let visible_content = result
		.provider_result_text
		.strip_prefix(&expected_prefix)
		.expect("provider result has the expected metadata prefix");
	assert!(visible_content.len() < large_text.len());
	assert!(!result.provider_result_text.contains(tail));
	assert_eq!(result.payload["expected_sha256"], expected_hash.as_str());
	assert_eq!(result.payload["content_scope"], "full_file");
	assert_eq!(result.payload["provider_result_truncated"], true);
	assert_eq!(result.artifact.sha256, expected_hash);
	assert_eq!(result.artifact.content.as_deref(), Some(large_text.as_str()));

	std::fs::remove_dir_all(root).expect("cleanup large-read workspace");
}
