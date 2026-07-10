use std::{
	path::PathBuf,
	sync::atomic::{AtomicU64, Ordering},
};

use serde_json::json;
use successor_kernel::tools::{catalog, find, grep, list_dir, read, registry, search_files};
use successor_protocol::{fixtures, tool_catalog::ToolStatusV0};

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
		vec!["search_files", "read", "find", "grep", "list_dir"],
		"registry executable order is a byte-sensitive contract because provider catalog order is \
		 fixed"
	);
	assert_eq!(
		executable_from_registry, executable_from_catalog,
		"the registry must not add, drop, or reorder executable names relative to the catalog"
	);
}

#[test]
fn every_executable_catalog_entry_dispatches_and_every_stub_does_not() {
	let registry = registry::slice0_registry();
	let root = seed_workspace("dispatchability");
	let catalog = catalog::slice0_catalog();

	for tool in &catalog.tools {
		if tool.status == ToolStatusV0::Executable {
			let args = match tool.name.as_str() {
				"search_files" => json!({ "query": "hello" }),
				"read" => json!({ "path": "hello.txt" }),
				"list_dir" => json!({ "path": "." }),
				"find" => json!({ "glob": "**/*.txt" }),
				"grep" => json!({ "pattern": "hello" }),
				other => panic!("unexpected executable tool in catalog: {other}"),
			};
			assert!(registry.is_dispatchable(&tool.name), "{} must have registry dispatch", tool.name);
			registry
				.execute(&root, &tool.name, &args)
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

	assert!(!registry.is_dispatchable("definitely_not_real"));
	let err = registry
		.execute(&root, "definitely_not_real", &json!({}))
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

	let malformed = registry
		.execute(&root, "read", &json!({ "path": "hello.txt", "max_bytes": 10 }))
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
		.execute(&root, "search_files", &json!({ "query": "hello" }))
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
		.execute(&root, "read", &json!({ "path": "hello.txt" }))
		.expect("registry read succeeds");
	assert_eq!(read_registry.artifact.sha256, read_direct.sha256);
	assert_eq!(read_registry.artifact.byte_length, read_direct.byte_length);
	assert_eq!(read_registry.provider_result_text, String::from_utf8_lossy(&read_direct.bytes));

	let list_direct = list_dir::list_dir(&root, ".").expect("direct list_dir succeeds");
	let list_registry = registry
		.execute(&root, "list_dir", &json!({ "path": "." }))
		.expect("registry list_dir succeeds");
	assert_eq!(list_registry.artifact.sha256, list_direct.sha256);
	assert_eq!(
		list_registry.payload["entries"],
		serde_json::to_value(&list_direct.entries).expect("serialize entries")
	);

	let find_direct = find::find(&root, "**/*.txt", 2_000).expect("direct find succeeds");
	let find_registry = registry
		.execute(&root, "find", &json!({ "glob": "**/*.txt" }))
		.expect("registry find succeeds");
	assert_eq!(find_registry.artifact.sha256, find_direct.sha256);
	assert_eq!(
		find_registry.payload["matches"],
		serde_json::to_value(&find_direct.entries).expect("serialize entries")
	);

	let grep_direct = grep::grep(&root, "hello", 2_000).expect("direct grep succeeds");
	let grep_registry = registry
		.execute(&root, "grep", &json!({ "pattern": "hello" }))
		.expect("registry grep succeeds");
	assert_eq!(grep_registry.artifact.sha256, grep_direct.sha256);
	assert_eq!(
		grep_registry.payload["matches"],
		serde_json::to_value(&grep_direct.matches).expect("serialize matches")
	);

	std::fs::remove_dir_all(root).expect("cleanup seeded workspace");
}
