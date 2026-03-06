import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ArtifactResolver,
	type BridgeConfig,
	CATEGORY_FRESHNESS,
	classifyResult,
	createArtifactRetriever,
	createCompositeRetriever,
	createReReadRetriever,
	TOOL_CATEGORY_MAP,
	TOOL_RESULT_CATEGORIES,
	ToolResultBridge,
} from "@oh-my-pi/pi-coding-agent/context/bridge";
import type { MemoryLocatorEntry } from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import { MEMORY_CONTRACT_VERSION } from "@oh-my-pi/pi-coding-agent/context/memory-contract";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

const NOW = "2025-06-15T12:00:00.000Z";

function makeBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return { now: NOW, ...overrides };
}

function createTestBridge(overrides: Partial<BridgeConfig> = {}): ToolResultBridge {
	return new ToolResultBridge(makeBridgeConfig(overrides));
}

// ═══════════════════════════════════════════════════════════════════════════
// Classification tests
// ═══════════════════════════════════════════════════════════════════════════

describe("classify", () => {
	describe("TOOL_CATEGORY_MAP coverage", () => {
		const expectedTools = [
			// Builtin tools
			"ast_grep",
			"ast_edit",
			"render_mermaid",
			"ask",
			"bash",
			"python",
			"calc",
			"ssh",
			"edit",
			"find",
			"grep",
			"lsp",
			"notebook",
			"read",
			"browser",
			"checkpoint",
			"rewind",
			"task",
			"cancel_job",
			"await",
			"todo_write",
			"fetch",
			"web_search",
			"write",
			// Hidden tools
			"submit_result",
			"report_finding",
			"exit_plan_mode",
			"resolve",
		];

		for (const tool of expectedTools) {
			test(`covers ${tool}`, () => {
				expect(TOOL_CATEGORY_MAP[tool]).toBeDefined();
				expect(TOOL_RESULT_CATEGORIES).toContain(TOOL_CATEGORY_MAP[tool].category);
			});
		}
	});

	describe("classifyResult", () => {
		test("classifies read tool as 'read' category", () => {
			const result = classifyResult("read", { path: "src/main.ts" }, "file content", false);
			expect(result.category).toBe("read");
			expect(result.trust).toBe("authoritative");
			expect(result.touchedPaths).toEqual(["src/main.ts"]);
			expect(result.isError).toBe(false);
		});

		test("classifies grep tool as 'lookup' category", () => {
			const result = classifyResult("grep", { pattern: "foo", path: "src/" }, "matches", false);
			expect(result.category).toBe("lookup");
			expect(result.trust).toBe("authoritative");
		});

		test("classifies edit tool as 'mutation' category", () => {
			const result = classifyResult("edit", { path: "src/main.ts" }, "ok", false);
			expect(result.category).toBe("mutation");
			expect(result.trust).toBe("authoritative");
			expect(result.touchedPaths).toEqual(["src/main.ts"]);
		});

		test("classifies write tool as 'mutation' category", () => {
			const result = classifyResult("write", { path: "src/new.ts" }, "ok", false);
			expect(result.category).toBe("mutation");
			expect(result.touchedPaths).toEqual(["src/new.ts"]);
		});

		test("classifies bash tool as 'execution' category", () => {
			const result = classifyResult("bash", {}, "output", false);
			expect(result.category).toBe("execution");
			expect(result.trust).toBe("derived");
		});

		test("classifies todo_write as 'control' category", () => {
			const result = classifyResult("todo_write", {}, "ok", false);
			expect(result.category).toBe("control");
		});

		test("classifies task tool as 'subagent' category", () => {
			const result = classifyResult("task", {}, "result", false);
			expect(result.category).toBe("subagent");
		});

		test("classifies unknown tool as 'execution' with heuristic trust", () => {
			const result = classifyResult("custom_tool", { path: "x.ts" }, "data", false);
			expect(result.category).toBe("execution");
			expect(result.trust).toBe("heuristic");
		});

		test("error execution results get session-length TTL", () => {
			const result = classifyResult("bash", {}, "error!", true);
			expect(result.category).toBe("execution");
			expect(result.isError).toBe(true);
			expect(result.freshness.ttlMs).toBe(Number.MAX_SAFE_INTEGER);
		});

		test("error read results do NOT get session-length TTL", () => {
			const result = classifyResult("read", { path: "missing.ts" }, "not found", true);
			expect(result.category).toBe("read");
			expect(result.isError).toBe(true);
			// read errors use category default, not session-length
			expect(result.freshness.ttlMs).toBe(CATEGORY_FRESHNESS.read.ttlMs);
		});

		test("detects artifact references in result", () => {
			const result = classifyResult("bash", {}, "Output truncated. Full output: artifact://42", false);
			expect(result.hasArtifact).toBe(true);
		});

		test("no artifact reference when result has no artifact URL", () => {
			const result = classifyResult("bash", {}, "normal output", false);
			expect(result.hasArtifact).toBe(false);
		});

		test("extracts paths from common arg names", () => {
			const result = classifyResult("read", { path: "a.ts", file: "b.ts" }, "", false);
			expect(result.touchedPaths).toContain("a.ts");
			expect(result.touchedPaths).toContain("b.ts");
		});

		test("extracts directory args for grep/find", () => {
			const result = classifyResult("grep", { pattern: "x", directory: "src/" }, "", false);
			expect(result.touchedPaths).toContain("src/");
		});

		test("extracts notebook path", () => {
			const result = classifyResult("notebook", { notebook_path: "test.ipynb" }, "", false);
			expect(result.touchedPaths).toContain("test.ipynb");
		});

		test("extracts symbols from lsp args", () => {
			const result = classifyResult("lsp", { query: "MyClass", file: "src/x.ts" }, "", false);
			expect(result.touchedSymbols).toContain("MyClass");
			expect(result.touchedPaths).toContain("src/x.ts");
		});

		test("handles non-object args gracefully", () => {
			const result = classifyResult("bash", null as any, "output", false);
			expect(result.touchedPaths).toEqual([]);
		});

		test("handles non-string result for artifact detection", () => {
			const result = classifyResult("bash", {}, { complex: "result" }, false);
			expect(result.hasArtifact).toBe(false);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Bridge tests
// ═══════════════════════════════════════════════════════════════════════════

describe("ToolResultBridge", () => {
	describe("initialization", () => {
		test("creates empty contract with version and STM", () => {
			const bridge = createTestBridge();
			const contract = bridge.contract;
			expect(contract.version).toBe(MEMORY_CONTRACT_VERSION);
			expect(contract.locatorMap).toEqual([]);
			expect(contract.longTerm).toEqual([]);
			expect(contract.shortTerm).toHaveLength(1);
			expect(contract.working).toBeNull();
		});

		test("STM record has correct initial state", () => {
			const bridge = createTestBridge();
			const stm = bridge.contract.shortTerm[0];
			expect(stm.id).toBe("bridge-stm");
			expect(stm.touchedPaths).toEqual([]);
			expect(stm.touchedSymbols).toEqual([]);
			expect(stm.unresolvedLoops).toEqual([]);
			expect(stm.updatedAt).toBe(NOW);
		});
	});

	describe("locator generation", () => {
		test("generates locator for read tool result", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("read", "call-1", { path: "src/main.ts" }, "content", false);

			const locators = bridge.contract.locatorMap;
			expect(locators).toHaveLength(1);
			expect(locators[0].key).toBe("read:call-1");
			expect(locators[0].tier).toBe("short_term");
			expect(locators[0].where).toBe("src/main.ts");
			expect(locators[0].how.method).toBe("read");
			expect(locators[0].trust).toBe("authoritative");
		});

		test("generates locator for grep tool result", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("grep", "call-2", { pattern: "TODO", path: "src/" }, "matches", false);

			const locators = bridge.contract.locatorMap;
			expect(locators).toHaveLength(1);
			expect(locators[0].key).toBe("grep:call-2");
			expect(locators[0].how.method).toBe("grep");
			expect(locators[0].how.params?.pattern).toBe("TODO");
		});

		test("generates locator with artifact params when artifact URL detected", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("bash", "call-3", {}, "artifact://42", false);

			const locators = bridge.contract.locatorMap;
			expect(locators).toHaveLength(1);
			expect(locators[0].how.params?.artifactId).toBe("42");
		});

		test("extracts non-numeric artifact IDs", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("bash", "call-3b", {}, "artifact://6-Extensions-12", false);

			const locators = bridge.contract.locatorMap;
			expect(locators).toHaveLength(1);
			expect(locators[0].how.params?.artifactId).toBe("6-Extensions-12");
		});

		test("does NOT generate locator for control tools", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("todo_write", "call-4", {}, "ok", false);
			bridge.handleToolResult("ask", "call-5", {}, "yes", false);
			bridge.handleToolResult("checkpoint", "call-6", {}, "saved", false);
			bridge.handleToolResult("rewind", "call-7", {}, "done", false);

			expect(bridge.contract.locatorMap).toHaveLength(0);
		});

		test("generates locator for mutation tool", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("edit", "call-8", { path: "src/foo.ts" }, "ok", false);

			expect(bridge.contract.locatorMap).toHaveLength(1);
			expect(bridge.contract.locatorMap[0].freshness.ttlMs).toBe(0);
		});

		test("locator freshness has invalidatedBy paths for lookup/read", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("read", "call-9", { path: "src/a.ts" }, "content", false);

			const locator = bridge.contract.locatorMap[0];
			expect(locator.freshness.invalidatedBy).toContain("src/a.ts");
		});

		test("sets lower confidence for error results", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("bash", "call-10", {}, "error", true);

			const locator = bridge.contract.locatorMap[0];
			expect(locator.provenance.confidence).toBe(0.5);
		});

		test("sets higher confidence for success results", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("bash", "call-11", {}, "ok", false);

			const locator = bridge.contract.locatorMap[0];
			expect(locator.provenance.confidence).toBe(0.9);
		});
	});

	describe("STM accumulation", () => {
		test("accumulates touched paths across multiple tool calls", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("read", "c2", { path: "b.ts" }, "y", false);

			const stm = bridge.contract.shortTerm[0];
			expect(stm.touchedPaths).toContain("a.ts");
			expect(stm.touchedPaths).toContain("b.ts");
		});

		test("deduplicates touched paths", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("grep", "c2", { path: "a.ts", pattern: "x" }, "y", false);

			const stm = bridge.contract.shortTerm[0];
			expect(stm.touchedPaths.filter(p => p === "a.ts")).toHaveLength(1);
		});

		test("accumulates touched symbols from lsp", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("lsp", "c1", { query: "MyFunc", file: "x.ts" }, "def", false);
			bridge.handleToolResult("lsp", "c2", { query: "MyClass", file: "y.ts" }, "def", false);

			const stm = bridge.contract.shortTerm[0];
			expect(stm.touchedSymbols).toContain("MyFunc");
			expect(stm.touchedSymbols).toContain("MyClass");
		});

		test("tracks errors as unresolved loops", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("bash", "c1", { path: "x.ts" }, "err", true);

			const stm = bridge.contract.shortTerm[0];
			expect(stm.unresolvedLoops).toContain("bash:x.ts");
		});

		test("tracks locator keys in STM", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("grep", "c2", { pattern: "y" }, "z", false);

			const stm = bridge.contract.shortTerm[0];
			expect(stm.locatorKeys).toContain("read:c1");
			expect(stm.locatorKeys).toContain("grep:c2");
		});

		test("does NOT accumulate STM for control tools", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("todo_write", "c1", {}, "ok", false);

			const stm = bridge.contract.shortTerm[0];
			expect(stm.touchedPaths).toEqual([]);
			expect(stm.locatorKeys).toEqual([]);
		});
	});

	describe("file-edit invalidation", () => {
		test("mutation invalidates existing lookup locators for same path", () => {
			const bridge = createTestBridge();

			// Add a read locator for a.ts
			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "content", false);
			expect(bridge.contract.locatorMap).toHaveLength(1);

			// Edit the same file — should invalidate the read locator
			bridge.handleToolResult("edit", "c2", { path: "a.ts" }, "ok", false);

			// Only the edit locator should remain (read locator invalidated)
			const keys = bridge.contract.locatorMap.map(l => l.key);
			expect(keys).not.toContain("read:c1");
			expect(keys).toContain("edit:c2");
		});

		test("mutation does NOT invalidate locators for different paths", () => {
			const bridge = createTestBridge();

			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "content", false);
			bridge.handleToolResult("edit", "c2", { path: "b.ts" }, "ok", false);

			const keys = bridge.contract.locatorMap.map(l => l.key);
			expect(keys).toContain("read:c1");
			expect(keys).toContain("edit:c2");
		});

		test("multiple edits invalidate multiple lookup locators", () => {
			const bridge = createTestBridge();

			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("grep", "c2", { path: "a.ts", pattern: "foo" }, "y", false);
			bridge.handleToolResult("read", "c3", { path: "b.ts" }, "z", false);

			// Edit a.ts — should invalidate c1 and c2
			bridge.handleToolResult("write", "c4", { path: "a.ts" }, "ok", false);

			const keys = bridge.contract.locatorMap.map(l => l.key);
			expect(keys).not.toContain("read:c1");
			expect(keys).not.toContain("grep:c2");
			expect(keys).toContain("read:c3");
			expect(keys).toContain("write:c4");
		});

		test("STM locatorKeys are pruned when locators are invalidated", () => {
			const bridge = createTestBridge();

			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("read", "c2", { path: "b.ts" }, "y", false);
			expect(bridge.contract.shortTerm[0].locatorKeys).toContain("read:c1");
			expect(bridge.contract.shortTerm[0].locatorKeys).toContain("read:c2");

			// Edit a.ts — invalidates read:c1
			bridge.handleToolResult("edit", "c3", { path: "a.ts" }, "ok", false);

			const stmKeys = bridge.contract.shortTerm[0].locatorKeys;
			expect(stmKeys).not.toContain("read:c1");
			expect(stmKeys).toContain("read:c2");
			expect(stmKeys).toContain("edit:c3");
		});
	});

	describe("locator eviction", () => {
		test("evicts oldest locators when at capacity", () => {
			const bridge = createTestBridge({ maxLocatorEntries: 3 });

			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("read", "c2", { path: "b.ts" }, "y", false);
			bridge.handleToolResult("read", "c3", { path: "c.ts" }, "z", false);
			expect(bridge.contract.locatorMap).toHaveLength(3);

			// This should evict c1
			bridge.handleToolResult("read", "c4", { path: "d.ts" }, "w", false);
			expect(bridge.contract.locatorMap).toHaveLength(3);

			const keys = bridge.contract.locatorMap.map(l => l.key);
			expect(keys).not.toContain("read:c1");
			expect(keys).toContain("read:c2");
			expect(keys).toContain("read:c3");
			expect(keys).toContain("read:c4");
		});

		test("STM locatorKeys are pruned when locators are evicted", () => {
			const bridge = createTestBridge({ maxLocatorEntries: 2 });

			bridge.handleToolResult("read", "c1", { path: "a.ts" }, "x", false);
			bridge.handleToolResult("read", "c2", { path: "b.ts" }, "y", false);
			expect(bridge.contract.shortTerm[0].locatorKeys).toContain("read:c1");

			// Adding c3 evicts c1
			bridge.handleToolResult("read", "c3", { path: "c.ts" }, "z", false);

			const stmKeys = bridge.contract.shortTerm[0].locatorKeys;
			expect(stmKeys).not.toContain("read:c1");
			expect(stmKeys).toContain("read:c2");
			expect(stmKeys).toContain("read:c3");
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Retriever tests
// ═══════════════════════════════════════════════════════════════════════════

describe("retrievers", () => {
	const tmpDir = path.join(os.tmpdir(), `bridge-test-${Date.now()}`);

	// Setup and teardown for retriever tests
	async function setup(): Promise<void> {
		await fs.mkdir(tmpDir, { recursive: true });
		await Bun.write(path.join(tmpDir, "42.bash.log"), "artifact content");
		await Bun.write(path.join(tmpDir, "test-file.ts"), "file content");
	}

	function makeResolver(dir: string): ArtifactResolver {
		return {
			async getPath(id: string): Promise<string | null> {
				const files = await fs.readdir(dir);
				const match = files.find(f => f.startsWith(`${id}.`));
				return match ? path.join(dir, match) : null;
			},
		};
	}

	function makeLocator(overrides: Partial<MemoryLocatorEntry> = {}): MemoryLocatorEntry {
		return {
			key: "test-key",
			tier: "short_term",
			where: "test",
			how: { method: "read" },
			cost: { estimatedTokens: 100, estimatedLatencyMs: 50 },
			freshness: { ttlMs: 300_000, invalidatedBy: [] },
			trust: "authoritative",
			provenance: { source: "test", reason: "test", capturedAt: NOW, confidence: 0.9 },
			...overrides,
		};
	}

	describe("artifactRetriever", () => {
		test("reads artifact content by ID", async () => {
			await setup();
			const retriever = createArtifactRetriever(makeResolver(tmpDir));
			const entry = makeLocator({ how: { method: "read", params: { artifactId: "42" } } });
			const content = await retriever(entry);
			expect(content).toBe("artifact content");
		});

		test("returns null for missing artifact", async () => {
			await setup();
			const retriever = createArtifactRetriever(makeResolver(tmpDir));
			const entry = makeLocator({ how: { method: "read", params: { artifactId: "999" } } });
			const content = await retriever(entry);
			expect(content).toBeNull();
		});

		test("returns null when no artifactId in params", async () => {
			await setup();
			const retriever = createArtifactRetriever(makeResolver(tmpDir));
			const entry = makeLocator({ how: { method: "read" } });
			const content = await retriever(entry);
			expect(content).toBeNull();
		});
	});

	describe("reReadRetriever", () => {
		test("reads file by path", async () => {
			await setup();
			const retriever = createReReadRetriever();
			const entry = makeLocator({
				how: { method: "read", params: { filePath: path.join(tmpDir, "test-file.ts") } },
			});
			const content = await retriever(entry);
			expect(content).toBe("file content");
		});

		test("returns null for missing file", async () => {
			const retriever = createReReadRetriever();
			const entry = makeLocator({
				how: { method: "read", params: { filePath: "/nonexistent/file.ts" } },
			});
			const content = await retriever(entry);
			expect(content).toBeNull();
		});

		test("returns null when no filePath in params", async () => {
			const retriever = createReReadRetriever();
			const entry = makeLocator({ how: { method: "read" } });
			const content = await retriever(entry);
			expect(content).toBeNull();
		});
	});

	describe("compositeRetriever", () => {
		test("prefers artifact over file re-read", async () => {
			await setup();
			const retriever = createCompositeRetriever(makeResolver(tmpDir));
			const entry = makeLocator({
				how: {
					method: "read",
					params: {
						artifactId: "42",
						filePath: path.join(tmpDir, "test-file.ts"),
					},
				},
			});
			const content = await retriever(entry);
			expect(content).toBe("artifact content");
		});

		test("falls back to file re-read when no artifact", async () => {
			await setup();
			const retriever = createCompositeRetriever(makeResolver(tmpDir));
			const entry = makeLocator({
				how: {
					method: "read",
					params: { filePath: path.join(tmpDir, "test-file.ts") },
				},
			});
			const content = await retriever(entry);
			expect(content).toBe("file content");
		});

		test("returns null when neither artifact nor file available", async () => {
			await setup();
			const retriever = createCompositeRetriever(makeResolver(tmpDir));
			const entry = makeLocator({ how: { method: "read" } });
			const content = await retriever(entry);
			expect(content).toBeNull();
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// extractPaths tests
// ═══════════════════════════════════════════════════════════════════════════

describe("extractPaths (via classify)", () => {
	test("extracts path from read args", () => {
		const result = classifyResult("read", { path: "src/main.ts" }, "", false);
		expect(result.touchedPaths).toContain("src/main.ts");
	});

	test("extracts multiple path-like args", () => {
		const result = classifyResult("read", { path: "a.ts", file: "b.ts", target: "c.ts" }, "", false);
		expect(result.touchedPaths).toContain("a.ts");
		expect(result.touchedPaths).toContain("b.ts");
		expect(result.touchedPaths).toContain("c.ts");
	});

	test("skips empty string paths", () => {
		const result = classifyResult("read", { path: "" }, "", false);
		expect(result.touchedPaths).toEqual([]);
	});

	test("skips non-string paths", () => {
		const result = classifyResult("read", { path: 42 }, "", false);
		expect(result.touchedPaths).toEqual([]);
	});
});
