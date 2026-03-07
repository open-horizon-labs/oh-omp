import { describe, expect, test } from "bun:test";
import {
	isMemoryLocatorCanonicalRetrievalMethod,
	isMemoryLocatorRetrievalMethod,
	isMemoryLocatorTrustLevel,
	isMemoryTierName,
	MEMORY_CONTRACT_VERSION,
	MEMORY_FRAGMENT_DROP_REASONS,
	MEMORY_LOCATOR_RETRIEVAL_METHODS,
	MEMORY_LOCATOR_TRUST_LEVELS,
	MEMORY_TIER_NAMES,
} from "@oh-my-pi/pi-coding-agent/context/memory-contract";

describe("MemoryContractV1", () => {
	test("pins version and memory tier taxonomy", () => {
		expect(MEMORY_CONTRACT_VERSION).toBe(1);
		expect(MEMORY_TIER_NAMES).toEqual(["long_term", "short_term", "working"]);
		expect(MEMORY_LOCATOR_TRUST_LEVELS).toEqual(["authoritative", "derived", "heuristic"]);
		expect(MEMORY_FRAGMENT_DROP_REASONS).toEqual([
			"token_budget",
			"latency_budget",
			"stale",
			"invalidated",
			"low_score",
			"retrieval_timeout",
		]);
		expect(new Set(MEMORY_TIER_NAMES).size).toBe(MEMORY_TIER_NAMES.length);
		expect(new Set(MEMORY_LOCATOR_TRUST_LEVELS).size).toBe(MEMORY_LOCATOR_TRUST_LEVELS.length);
		expect(new Set(MEMORY_FRAGMENT_DROP_REASONS).size).toBe(MEMORY_FRAGMENT_DROP_REASONS.length);
	});

	test("pins canonical locator retrieval methods", () => {
		expect(MEMORY_LOCATOR_RETRIEVAL_METHODS).toEqual([
			"read",
			"grep",
			"find",
			"lsp.definition",
			"lsp.references",
			"lsp.hover",
			"rpc.get_state",
			"rpc.get_session_stats",
			"rpc.get_messages",
			"rpc.get_branch_messages",
			"rpc.get_last_assistant_text",
			"rpc.get_introspection",
			"session.getAsyncJobSnapshot",
			"memory.read",
		]);
		expect(new Set(MEMORY_LOCATOR_RETRIEVAL_METHODS).size).toBe(MEMORY_LOCATOR_RETRIEVAL_METHODS.length);
	});

	test("classifies tiers, trust levels, and retrieval methods", () => {
		for (const tier of MEMORY_TIER_NAMES) {
			expect(isMemoryTierName(tier)).toBe(true);
		}
		for (const trustLevel of MEMORY_LOCATOR_TRUST_LEVELS) {
			expect(isMemoryLocatorTrustLevel(trustLevel)).toBe(true);
		}
		for (const method of MEMORY_LOCATOR_RETRIEVAL_METHODS) {
			expect(isMemoryLocatorCanonicalRetrievalMethod(method)).toBe(true);
			expect(isMemoryLocatorRetrievalMethod(method)).toBe(true);
		}

		expect(isMemoryLocatorCanonicalRetrievalMethod("custom.extension.fetch")).toBe(false);
		expect(isMemoryLocatorRetrievalMethod("custom.extension.fetch")).toBe(true);
		expect(isMemoryLocatorRetrievalMethod("custom")).toBe(false);
		expect(isMemoryLocatorRetrievalMethod(".invalid")).toBe(false);
		expect(isMemoryLocatorRetrievalMethod("invalid.")).toBe(false);
		expect(isMemoryTierName("ephemeral")).toBe(false);
		expect(isMemoryLocatorTrustLevel("unknown")).toBe(false);
		expect(isMemoryLocatorRetrievalMethod(42)).toBe(false);
		expect(isMemoryLocatorRetrievalMethod(null)).toBe(false);
	});
});
