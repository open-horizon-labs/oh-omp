import { describe, expect, test } from "bun:test";
import { deriveBudget, estimateMessageTokens } from "@oh-my-pi/pi-coding-agent/context/assembler";

// ═══════════════════════════════════════════════════════════════════════════
// deriveBudget — core math
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveBudget — core math", () => {
	test("basic allocation with default percentages", () => {
		const budget = deriveBudget({
			contextWindow: 200_000,
			systemPromptTokens: 5_000,
			toolDefinitionTokens: 10_000,
			currentTurnTokens: 1_000,
		});

		// safetyReserve = floor(200_000 * 5 / 100) = 10_000
		// allocatable = 200_000 - 16_000 - 10_000 = 174_000
		expect(budget.maxTokens).toBe(174_000);
		// hydrationBudgetMax = floor(174_000 * 50 / 100) = 87_000
		expect(budget.hydrationBudgetMax).toBe(87_000);
		// messageBudgetMin = floor(174_000 * 50 / 100) = 87_000
		expect(budget.messageBudgetMin).toBe(87_000);
	});

	test("custom safety margin percentage", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 10,
		});

		// safetyReserve = floor(100_000 * 10 / 100) = 10_000
		// allocatable = 100_000 - 0 - 10_000 = 90_000
		expect(budget.maxTokens).toBe(90_000);
	});

	test("custom message and hydration percentages", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 70,
			hydrationBudgetPercent: 30,
		});

		// allocatable = 100_000
		expect(budget.maxTokens).toBe(100_000);
		expect(budget.hydrationBudgetMax).toBe(30_000);
		expect(budget.messageBudgetMin).toBe(70_000);
	});

	test("percentages that sum over 100 — both values computed independently", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 60,
			hydrationBudgetPercent: 60,
		});

		// Each is independently computed
		expect(budget.messageBudgetMin).toBe(60_000);
		expect(budget.hydrationBudgetMax).toBe(60_000);
		expect(budget.maxTokens).toBe(100_000);
	});

	test("percentages that sum under 100 — gap is implicit overflow to messages", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 30,
			hydrationBudgetPercent: 30,
		});

		expect(budget.messageBudgetMin).toBe(30_000);
		expect(budget.hydrationBudgetMax).toBe(30_000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// deriveBudget — non-negative floor
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveBudget — non-negative floor", () => {
	test("returns non-negative maxTokens when fixed costs exceed context window", () => {
		const budget = deriveBudget({
			contextWindow: 10_000,
			systemPromptTokens: 8_000,
			toolDefinitionTokens: 5_000,
			currentTurnTokens: 2_000,
		});

		// Fixed costs = 15_000 > contextWindow = 10_000
		expect(budget.maxTokens).toBeGreaterThanOrEqual(0);
		expect(budget.hydrationBudgetMax).toBeGreaterThanOrEqual(0);
		expect(budget.messageBudgetMin).toBeGreaterThanOrEqual(0);
	});

	test("returns zero allocatable when fixed costs equal context window minus safety reserve", () => {
		const budget = deriveBudget({
			contextWindow: 10_000,
			systemPromptTokens: 5_000,
			toolDefinitionTokens: 4_500,
			currentTurnTokens: 0,
			safetyMarginPercent: 5,
		});

		// safetyReserve = floor(10_000 * 5 / 100) = 500
		// allocatable = max(0, 10_000 - 9_500 - 500) = 0
		expect(budget.maxTokens).toBe(0);
		expect(budget.hydrationBudgetMax).toBe(0);
		expect(budget.messageBudgetMin).toBe(0);
	});

	test("zero context window returns all zeros", () => {
		const budget = deriveBudget({
			contextWindow: 0,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
		});

		expect(budget.maxTokens).toBe(0);
		expect(budget.hydrationBudgetMax).toBe(0);
		expect(budget.messageBudgetMin).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// deriveBudget — settings overrides
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveBudget — settings overrides", () => {
	test("default safety margin is 5%", () => {
		const budget = deriveBudget({
			contextWindow: 200_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
		});

		// safetyReserve = floor(200_000 * 5 / 100) = 10_000
		expect(budget.maxTokens).toBe(190_000);
	});

	test("default message and hydration percentages are 50%", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
		});

		expect(budget.messageBudgetMin).toBe(50_000);
		expect(budget.hydrationBudgetMax).toBe(50_000);
	});

	test("safetyMarginPercent=0 disables safety reserve", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
		});

		expect(budget.maxTokens).toBe(100_000);
	});

	test("high safety margin leaves less allocatable budget", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 20,
		});

		// safetyReserve = floor(100_000 * 20 / 100) = 20_000
		expect(budget.maxTokens).toBe(80_000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Elastic budget — messages expand into unused hydration
// ═══════════════════════════════════════════════════════════════════════════

describe("elastic budget — message expansion", () => {
	test("messages get full allocatable when no hydration", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 50,
			hydrationBudgetPercent: 50,
		});

		// Simulate elastic math from sdk.ts:
		// effectiveMessageBudget = max(messageBudgetMin, allocatable - actualHydratedTokens)
		const actualHydratedTokens = 0;
		const effectiveMessageBudget = Math.max(budget.messageBudgetMin, budget.maxTokens - actualHydratedTokens);
		expect(effectiveMessageBudget).toBe(100_000);
	});

	test("messages expand into unused hydration", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 50,
			hydrationBudgetPercent: 50,
		});

		// Hydration uses 20_000 of its 50_000 cap
		const actualHydratedTokens = 20_000;
		const effectiveMessageBudget = Math.max(budget.messageBudgetMin, budget.maxTokens - actualHydratedTokens);
		// Messages get: 100_000 - 20_000 = 80_000 (more than their 50% guarantee)
		expect(effectiveMessageBudget).toBe(80_000);
	});

	test("messages get at least their floor when hydration is saturated", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 50,
			hydrationBudgetPercent: 50,
		});

		// Hydration uses full cap
		const actualHydratedTokens = 50_000;
		const effectiveMessageBudget = Math.max(budget.messageBudgetMin, budget.maxTokens - actualHydratedTokens);
		expect(effectiveMessageBudget).toBe(50_000);
	});

	test("message floor enforced when hydration somehow exceeds cap (defensive)", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 50,
			hydrationBudgetPercent: 50,
		});

		// Hypothetical: hydration at 70_000 (shouldn't happen with proper cap enforcement)
		const actualHydratedTokens = 70_000;
		const effectiveMessageBudget = Math.max(budget.messageBudgetMin, budget.maxTokens - actualHydratedTokens);
		// max(50_000, 100_000 - 70_000) = max(50_000, 30_000) = 50_000
		expect(effectiveMessageBudget).toBe(50_000);
	});

	test("elastic math with asymmetric percentages", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
			safetyMarginPercent: 0,
			messageBudgetPercent: 70,
			hydrationBudgetPercent: 30,
		});

		// No hydration: messages get full allocatable
		const noHydration = Math.max(budget.messageBudgetMin, budget.maxTokens - 0);
		expect(noHydration).toBe(100_000);

		// 30% hydration: messages get 70%
		const fullHydration = Math.max(budget.messageBudgetMin, budget.maxTokens - 30_000);
		expect(fullHydration).toBe(70_000);

		// 10% hydration: messages get 90%
		const partialHydration = Math.max(budget.messageBudgetMin, budget.maxTokens - 10_000);
		expect(partialHydration).toBe(90_000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Hydration cap — entry-level enforcement algorithm
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replicates the entry-level cap enforcement algorithm from sdk.ts.
 * This exercises the same logic without requiring the full import chain.
 */
function enforceHydrationCap<T extends { text: string }>(results: T[], hydrationBudgetMax: number): T[] {
	if (results.length === 0) return [];

	const totalLength = results.reduce((a, r) => a + r.text.length, 0);
	const remaining = [...results];
	let remainingLength = totalLength;

	while (remaining.length > 0) {
		const wrapperChars = 40 + remaining.length * 80;
		const estimatedTokens = Math.ceil((remainingLength + wrapperChars) / 4);
		if (estimatedTokens <= hydrationBudgetMax) break;
		const dropped = remaining.pop()!;
		remainingLength -= dropped.text.length;
	}

	return remaining;
}

describe("hydration cap — entry-level enforcement", () => {
	test("entries within budget are preserved", () => {
		const entries = [{ text: "short entry 1" }, { text: "short entry 2" }];

		const result = enforceHydrationCap(entries, 10_000);
		expect(result.length).toBe(2);
	});

	test("drop lowest-MMR entries when over budget", () => {
		// Results are MMR-ranked (first = highest rank).
		const entries = [
			{ text: "a".repeat(4000) }, // ~1000 tokens
			{ text: "b".repeat(4000) }, // ~1000 tokens
			{ text: "c".repeat(4000) }, // ~1000 tokens
			{ text: "d".repeat(4000) }, // ~1000 tokens
		];

		const result = enforceHydrationCap(entries, 1500);

		// Should have dropped entries from the end (lowest MMR rank)
		expect(result.length).toBeLessThan(entries.length);
		expect(result.length).toBeGreaterThan(0);

		// Survivors are the highest-ranked entries (from the front)
		for (let i = 0; i < result.length; i++) {
			expect(result[i]).toBe(entries[i]);
		}
	});

	test("all entries dropped when budget is zero", () => {
		const entries = [{ text: "some content" }, { text: "more content" }];

		const result = enforceHydrationCap(entries, 0);
		expect(result.length).toBe(0);
	});

	test("single large entry dropped when it exceeds budget", () => {
		const entries = [
			{ text: "x".repeat(40_000) }, // ~10_000 tokens
		];

		const result = enforceHydrationCap(entries, 5_000);
		expect(result.length).toBe(0);
	});

	test("preserves entries in order (no reranking)", () => {
		const entries = [
			{ text: "first", rank: 1 },
			{ text: "second", rank: 2 },
			{ text: "third", rank: 3 },
		];

		const result = enforceHydrationCap(entries, 10_000);
		expect(result).toEqual(entries);
	});

	test("progressive dropping removes from end only", () => {
		// Each entry ~500 tokens (2000 chars / 4)
		const entries = [
			{ text: "a".repeat(2000), id: "entry-1" },
			{ text: "b".repeat(2000), id: "entry-2" },
			{ text: "c".repeat(2000), id: "entry-3" },
			{ text: "d".repeat(2000), id: "entry-4" },
			{ text: "e".repeat(2000), id: "entry-5" },
		];

		// Budget for ~2 entries: 2 * 500 tokens + some overhead
		const result = enforceHydrationCap(entries, 1200);

		// First entries survive, last entries dropped
		expect(result.length).toBeGreaterThan(0);
		expect(result.length).toBeLessThan(entries.length);
		expect(result[0].id).toBe("entry-1");
		if (result.length > 1) {
			expect(result[1].id).toBe("entry-2");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// deriveBudget — maxLatencyMs
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveBudget — maxLatencyMs", () => {
	test("returns default maxLatencyMs", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
		});

		expect(budget.maxLatencyMs).toBe(2000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// estimateMessageTokens — char/4 heuristic
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateMessageTokens — token estimation", () => {
	test("estimates tokens from string content", () => {
		const tokens = estimateMessageTokens([{ role: "user", content: "a".repeat(400) }]);
		// 400 chars / 4 = 100 tokens
		expect(tokens).toBe(100);
	});

	test("estimates tokens from text block content", () => {
		const tokens = estimateMessageTokens([{ role: "developer", content: [{ type: "text", text: "x".repeat(800) }] }]);
		// 800 chars / 4 = 200 tokens
		expect(tokens).toBe(200);
	});
});
