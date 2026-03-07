import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolResultBridge } from "@oh-my-pi/pi-coding-agent/context/bridge";
import { MEMORY_CONTRACT_VERSION } from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import { buildIntrospectionSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-introspection";

const NOW = "2025-06-15T12:00:00.000Z";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createTestBridge(): ToolResultBridge {
	return new ToolResultBridge({ now: NOW });
}

function legacySettings(): Settings {
	return Settings.isolated({ "contextManager.mode": "legacy" });
}

function shadowSettings(): Settings {
	return Settings.isolated({
		"contextManager.mode": "shadow",
		"memories.enabled": true,
		"compaction.enabled": true,
	});
}

function assemblerSettings(): Settings {
	return Settings.isolated({
		"contextManager.mode": "assembler",
		"memories.enabled": false,
		"compaction.enabled": false,
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("buildIntrospectionSnapshot", () => {
	// ─────────────────────────────────────────────────────────────────────
	// Legacy mode (no bridge)
	// ─────────────────────────────────────────────────────────────────────

	describe("legacy mode without bridge", () => {
		test("returns legacy mode with null contract", () => {
			const snapshot = buildIntrospectionSnapshot(legacySettings(), undefined);

			expect(snapshot.mode).toBe("legacy");
			expect(snapshot.assemblerActive).toBe(false);
			expect(snapshot.contract).toBeNull();
			expect(snapshot.provenance).toEqual([]);
			expect(snapshot.budget).toBeNull();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// Shadow mode with empty bridge
	// ─────────────────────────────────────────────────────────────────────

	describe("shadow mode with empty bridge", () => {
		test("returns shadow mode with zero-count contract", () => {
			const bridge = createTestBridge();
			const snapshot = buildIntrospectionSnapshot(shadowSettings(), bridge);

			expect(snapshot.mode).toBe("shadow");
			expect(snapshot.assemblerActive).toBe(false);
			expect(snapshot.contract).not.toBeNull();
			expect(snapshot.contract!.version).toBe(MEMORY_CONTRACT_VERSION);
			expect(snapshot.contract!.locatorCount).toBe(0);
			expect(snapshot.contract!.locatorsByTier).toEqual({ long_term: 0, short_term: 0, working: 0 });
			expect(snapshot.contract!.locatorsByTrust).toEqual({ authoritative: 0, derived: 0, heuristic: 0 });
			expect(snapshot.contract!.shortTermRecordCount).toBe(1); // Bridge creates one STM record
			expect(snapshot.contract!.unresolvedLoops).toEqual([]);
			expect(snapshot.provenance).toEqual([]);
			expect(snapshot.budget).toBeNull();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// Assembler mode with populated bridge
	// ─────────────────────────────────────────────────────────────────────

	describe("assembler mode with populated bridge", () => {
		test("returns assemblerActive true", () => {
			const bridge = createTestBridge();
			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			expect(snapshot.mode).toBe("assembler");
			expect(snapshot.assemblerActive).toBe(true);
		});

		test("aggregates locator counts by tier and trust", () => {
			const bridge = createTestBridge();

			// Simulate tool results that generate locator entries
			bridge.handleToolResult("read", "call-1", { path: "src/a.ts" }, "file contents", false);
			bridge.handleToolResult("grep", "call-2", { pattern: "foo", path: "src" }, "line 1: foo", false);
			bridge.handleToolResult("lsp", "call-3", { action: "definition", file: "src/b.ts" }, "definition info", false);

			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			expect(snapshot.contract).not.toBeNull();
			expect(snapshot.contract!.locatorCount).toBe(3);
			// All bridge-generated entries are short_term tier
			expect(snapshot.contract!.locatorsByTier.short_term).toBe(3);
			expect(snapshot.contract!.locatorsByTier.long_term).toBe(0);
			expect(snapshot.contract!.locatorsByTier.working).toBe(0);
		});

		test("aggregates provenance by source", () => {
			const bridge = createTestBridge();

			bridge.handleToolResult("read", "call-1", { path: "src/a.ts" }, "file contents", false);
			bridge.handleToolResult("read", "call-2", { path: "src/b.ts" }, "other contents", false);
			bridge.handleToolResult("grep", "call-3", { pattern: "foo" }, "line 1: foo", false);

			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			expect(snapshot.provenance.length).toBe(2);

			const readProv = snapshot.provenance.find(p => p.source === "tool:read");
			expect(readProv).toBeDefined();
			expect(readProv!.count).toBe(2);
			expect(readProv!.avgConfidence).toBe(0.9);

			const grepProv = snapshot.provenance.find(p => p.source === "tool:grep");
			expect(grepProv).toBeDefined();
			expect(grepProv!.count).toBe(1);
		});

		test("surfaces unresolved loops from error results", () => {
			const bridge = createTestBridge();

			// Errors generate unresolved loops
			bridge.handleToolResult("bash", "call-1", { command: "make" }, "build failed", true);

			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			expect(snapshot.contract).not.toBeNull();
			expect(snapshot.contract!.unresolvedLoops.length).toBeGreaterThan(0);
		});

		test("returns null budget when working memory has none", () => {
			const bridge = createTestBridge();
			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			// Working memory is null by default in bridge
			expect(snapshot.budget).toBeNull();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// Payload shape
	// ─────────────────────────────────────────────────────────────────────

	describe("payload shape", () => {
		test("snapshot has all required top-level fields", () => {
			const snapshot = buildIntrospectionSnapshot(legacySettings(), undefined);

			expect(snapshot).toHaveProperty("mode");
			expect(snapshot).toHaveProperty("assemblerActive");
			expect(snapshot).toHaveProperty("contract");
			expect(snapshot).toHaveProperty("provenance");
			expect(snapshot).toHaveProperty("budget");
		});

		test("contract summary has all required fields when present", () => {
			const bridge = createTestBridge();
			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			expect(snapshot.contract).toHaveProperty("version");
			expect(snapshot.contract).toHaveProperty("locatorCount");
			expect(snapshot.contract).toHaveProperty("locatorsByTier");
			expect(snapshot.contract).toHaveProperty("locatorsByTrust");
			expect(snapshot.contract).toHaveProperty("shortTermRecordCount");
			expect(snapshot.contract).toHaveProperty("unresolvedLoops");
		});

		test("provenance entries have required fields", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult("read", "call-1", { path: "foo.ts" }, "content", false);

			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			expect(snapshot.provenance.length).toBe(1);
			const entry = snapshot.provenance[0];
			expect(entry).toHaveProperty("source");
			expect(entry).toHaveProperty("count");
			expect(entry).toHaveProperty("avgConfidence");
			expect(typeof entry.source).toBe("string");
			expect(typeof entry.count).toBe("number");
			expect(typeof entry.avgConfidence).toBe("number");
		});

		test("does not include full fragment contents in response", () => {
			const bridge = createTestBridge();
			bridge.handleToolResult(
				"read",
				"call-1",
				{ path: "large-file.ts" },
				"x".repeat(10000), // Large content
				false,
			);

			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);
			const json = JSON.stringify(snapshot);

			// Snapshot should be bounded — no full file contents
			expect(json.length).toBeLessThan(2000);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// Mutation invalidation
	// ─────────────────────────────────────────────────────────────────────

	describe("mutation invalidation", () => {
		test("locator count reflects invalidation after edits", () => {
			const bridge = createTestBridge();

			// Read a file, then edit it (mutation invalidates the read locator)
			bridge.handleToolResult("read", "call-1", { path: "src/a.ts" }, "file content", false);
			expect(bridge.contract.locatorMap.length).toBe(1);

			bridge.handleToolResult("edit", "call-2", { path: "src/a.ts" }, "edit applied", false);
			// After edit, the read locator for src/a.ts should be invalidated
			// and the edit locator should exist

			const snapshot = buildIntrospectionSnapshot(assemblerSettings(), bridge);

			// Locator count should reflect post-invalidation state
			expect(snapshot.contract!.locatorCount).toBe(bridge.contract.locatorMap.length);
		});
	});
});
