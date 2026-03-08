import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { assemble, formatAssembledContext } from "@oh-my-pi/pi-coding-agent/context/assembler";
import type {
	MemoryContractV1,
	MemoryProvenance,
	WorkingContextPacketV1,
} from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import { MEMORY_CONTRACT_VERSION } from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import {
	isAssemblerActive,
	isLegacyActive,
	isShadowMode,
	validateContextManagerConfig,
} from "@oh-my-pi/pi-coding-agent/context-manager";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

const NOW = "2025-06-15T12:00:00.000Z";

function makeProvenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
	return {
		source: "test",
		reason: "test-fixture",
		capturedAt: NOW,
		confidence: 0.9,
		...overrides,
	};
}

function makeEmptyContract(): MemoryContractV1 {
	return {
		version: MEMORY_CONTRACT_VERSION,
		locatorMap: [],
		longTerm: [],
		shortTerm: [],
		working: null,
	};
}

function makePacket(fragmentContents: string[]): WorkingContextPacketV1 {
	return {
		version: MEMORY_CONTRACT_VERSION,
		objective: "test",
		generatedAt: NOW,
		budget: {
			maxTokens: 4096,
			maxLatencyMs: 2000,
			reservedTokens: { objective: 256, codeContext: 2048, executionState: 512 },
		},
		usage: { consumedTokens: 0, consumedLatencyMs: 0 },
		fragments: fragmentContents.map((content, i) => ({
			id: `frag-${i}`,
			tier: "short_term" as const,
			content,
			locatorKey: `key-${i}`,
			score: 0.8 - i * 0.1,
			provenance: makeProvenance(),
		})),
		dropped: [],
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// formatAssembledContext
// ═══════════════════════════════════════════════════════════════════════════

describe("formatAssembledContext", () => {
	test("returns null for empty fragments", () => {
		const packet = makePacket([]);
		expect(formatAssembledContext(packet)).toBeNull();
	});

	test("formats single fragment with XML structure", () => {
		const packet = makePacket(["file content here"]);
		const result = formatAssembledContext(packet);
		expect(result).not.toBeNull();
		expect(result).toContain("<assembled-context>");
		expect(result).toContain("</assembled-context>");
		expect(result).toContain('<fragment key="key-0" tier="short_term">');
		expect(result).toContain("file content here");
		expect(result).toContain("</fragment>");
	});

	test("formats multiple fragments in order", () => {
		const packet = makePacket(["first content", "second content", "third content"]);
		const result = formatAssembledContext(packet)!;
		const firstIdx = result.indexOf("first content");
		const secondIdx = result.indexOf("second content");
		const thirdIdx = result.indexOf("third content");
		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});

	test("preserves fragment keys and tiers", () => {
		const packet = makePacket(["content"]);
		const result = formatAssembledContext(packet)!;
		expect(result).toContain('key="key-0"');
		expect(result).toContain('tier="short_term"');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Single-manager invariant
// ═══════════════════════════════════════════════════════════════════════════

describe("single-manager invariant", () => {
	test("legacy mode: legacy active, assembler inactive", () => {
		const settings = Settings.isolated({ "contextManager.mode": "legacy" });
		expect(isLegacyActive(settings)).toBe(true);
		expect(isAssemblerActive(settings)).toBe(false);
		expect(isShadowMode(settings)).toBe(false);
	});

	test("shadow mode: legacy active, assembler inactive, shadow observing", () => {
		const settings = Settings.isolated({ "contextManager.mode": "shadow" });
		expect(isLegacyActive(settings)).toBe(true);
		expect(isAssemblerActive(settings)).toBe(false);
		expect(isShadowMode(settings)).toBe(true);
	});

	test("assembler mode: legacy inactive, assembler active", () => {
		const settings = Settings.isolated({ "contextManager.mode": "assembler" });
		expect(isLegacyActive(settings)).toBe(false);
		expect(isAssemblerActive(settings)).toBe(true);
		expect(isShadowMode(settings)).toBe(false);
	});

	test("legacy and assembler are never both active", () => {
		for (const mode of ["legacy", "shadow", "assembler"] as const) {
			const settings = Settings.isolated({ "contextManager.mode": mode });
			const legacy = isLegacyActive(settings);
			const assembler = isAssemblerActive(settings);
			// Mutual exclusion: at most one primary is active
			expect(legacy && assembler).toBe(false);
		}
	});

	test("assembler mode requires legacy subsystems disabled", () => {
		// memories enabled → conflict
		expect(() =>
			validateContextManagerConfig(
				Settings.isolated({
					"contextManager.mode": "assembler",
					"memories.enabled": true,
				}),
			),
		).toThrow(/conflicts/);
		// both disabled → valid
		expect(() =>
			validateContextManagerConfig(
				Settings.isolated({
					"contextManager.mode": "assembler",
					"memories.enabled": false,
				}),
			),
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Assembler kernel integration
// ═══════════════════════════════════════════════════════════════════════════

describe("assembler kernel integration", () => {
	test("assemble produces empty packet from empty contract", async () => {
		const contract = makeEmptyContract();
		const turn = {
			turnId: "t1",
			objective: "test objective",
			activePaths: [],
			activeSymbols: [],
			unresolvedLoops: [],
		};
		const packet = await assemble(contract, turn, { now: NOW });
		expect(packet.fragments).toHaveLength(0);
		expect(formatAssembledContext(packet)).toBeNull();
	});

	test("assemble produces fragments from contract with locator entries", async () => {
		// Build a contract with locator entries directly (avoiding bridge STM
		// self-invalidation where touchedPaths overlap invalidatedBy tags).
		const contract: MemoryContractV1 = {
			version: MEMORY_CONTRACT_VERSION,
			locatorMap: [
				{
					key: "read:call-1",
					tier: "short_term",
					where: "src/main.ts",
					how: { method: "read", params: { filePath: "src/main.ts" } },
					cost: { estimatedTokens: 50, estimatedLatencyMs: 10 },
					freshness: { ttlMs: 300_000, invalidatedBy: [] },
					trust: "authoritative",
					provenance: makeProvenance(),
				},
				{
					key: "grep:call-2",
					tier: "short_term",
					where: "src/",
					how: { method: "grep", params: { pattern: "TODO" } },
					cost: { estimatedTokens: 30, estimatedLatencyMs: 10 },
					freshness: { ttlMs: 120_000, invalidatedBy: [] },
					trust: "authoritative",
					provenance: makeProvenance(),
				},
			],
			longTerm: [],
			shortTerm: [],
			working: null,
		};

		const turn = {
			turnId: "t1",
			objective: "fix bugs",
			activePaths: ["src/main.ts"],
			activeSymbols: [],
			unresolvedLoops: [],
		};

		const retriever = async () => "retrieved content";
		const packet = await assemble(contract, turn, { now: NOW, retriever });

		expect(packet.fragments.length).toBeGreaterThan(0);
		const text = formatAssembledContext(packet);
		expect(text).not.toBeNull();
		expect(text).toContain("<assembled-context>");
		expect(text).toContain("retrieved content");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Legacy injection gating
// ═══════════════════════════════════════════════════════════════════════════

describe("legacy injection gating", () => {
	test("isLegacyActive gates memory injection", () => {
		// In assembler mode, isLegacyActive is false → memory instructions should not be injected
		const assemblerSettings = Settings.isolated({
			"contextManager.mode": "assembler",
			"memories.enabled": false,
		});
		expect(isLegacyActive(assemblerSettings)).toBe(false);

		// In legacy mode, isLegacyActive is true → memory instructions should be injected
		const legacySettings = Settings.isolated({ "contextManager.mode": "legacy" });
		expect(isLegacyActive(legacySettings)).toBe(true);

		// In shadow mode, isLegacyActive is true → memory instructions should be injected
		const shadowSettings = Settings.isolated({ "contextManager.mode": "shadow" });
		expect(isLegacyActive(shadowSettings)).toBe(true);
	});

	test("shadow mode: bridge populates but does not inject", () => {
		const settings = Settings.isolated({ "contextManager.mode": "shadow" });
		// Bridge should be active (for observation)
		expect(isShadowMode(settings) || isAssemblerActive(settings)).toBe(true);
		// But assembler should NOT inject
		expect(isAssemblerActive(settings)).toBe(false);
		// Legacy IS the primary
		expect(isLegacyActive(settings)).toBe(true);
	});
});
