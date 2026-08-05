import { describe, expect, test } from "bun:test";
import type { TransformMetadata, TurnDecision } from "@oh-my-pi/pi-coding-agent/context/assembler";
import { formatAssemblySummary } from "@oh-my-pi/pi-coding-agent/context/assembly-summary";
import type { EffectivePromptSnapshot } from "@oh-my-pi/pi-coding-agent/context/effective-prompt-snapshot";

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot factory
// ═══════════════════════════════════════════════════════════════════════════

function makeSnapshot(overrides: {
	meta?: TransformMetadata | null;
	budget?: EffectivePromptSnapshot["budget"];
}): EffectivePromptSnapshot {
	return {
		turnId: "turn-1",
		capturedAt: new Date().toISOString(),
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200_000 },
		systemPrompt: { fingerprint: "abc123", tokenEstimate: 5_000 },
		tools: { names: ["read", "write"], totalDefinitionTokenEstimate: 3_000 },
		messages: {
			final: [],
			tokenEstimate: 50_000,
			transformMetadata: overrides.meta !== undefined ? overrides.meta : null,
		},
		assemblerContext: null,
		budget: overrides.budget !== undefined ? overrides.budget : null,
	};
}

function makeDecision(turnIndex: number, action: TurnDecision["action"], reason: TurnDecision["reason"]): TurnDecision {
	return {
		turnIndex,
		action,
		reason,
		messageCount: 2,
		hasToolResults: action === "stubbed",
		tokensBefore: 1000,
		tokensAfter: action === "dropped" ? 0 : action === "stubbed" ? 200 : 1000,
		sourceTags: [],
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("formatAssemblySummary", () => {
	test("returns null when no metadata and no budget", () => {
		const snapshot = makeSnapshot({ meta: null, budget: null });
		expect(formatAssemblySummary(snapshot)).toBeNull();
	});

	test("includes turn composition with kept/stubbed/dropped counts", () => {
		const meta: TransformMetadata = {
			decisions: [
				makeDecision(0, "dropped", "budget-exceeded"),
				makeDecision(1, "dropped", "budget-exceeded"),
				makeDecision(2, "stubbed", "beyond-hot-window"),
				makeDecision(3, "stubbed", "beyond-hot-window"),
				makeDecision(4, "stubbed", "beyond-hot-window"),
				makeDecision(5, "kept", "hot-window"),
				makeDecision(6, "kept", "hot-window"),
				makeDecision(7, "kept", "hot-window"),
			],
			totalTurns: 8,
			keptCount: 3,
			stubbedCount: 3,
			compressedCount: 0,
			droppedCount: 2,
			tokensBefore: 8000,
			tokensAfter: 4600,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }));
		expect(result).toContain("8 turns");
		expect(result).toContain("3 kept");
		expect(result).toContain("3 stubbed (turns 2-4)");
		expect(result).toContain("2 budget-dropped");
	});

	test("includes pinned working-set count when present", () => {
		const meta: TransformMetadata = {
			decisions: [
				makeDecision(0, "kept", "working-set"),
				makeDecision(1, "stubbed", "beyond-hot-window"),
				makeDecision(2, "kept", "hot-window"),
				makeDecision(3, "kept", "hot-window"),
			],
			totalTurns: 4,
			keptCount: 3,
			stubbedCount: 1,
			compressedCount: 0,
			droppedCount: 0,
			tokensBefore: 4000,
			tokensAfter: 3200,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }));
		expect(result).toContain("1 pinned (working set)");
	});

	test("omits pinned count when no working-set pins exist", () => {
		const meta: TransformMetadata = {
			decisions: [makeDecision(0, "kept", "hot-window")],
			totalTurns: 1,
			keptCount: 1,
			stubbedCount: 0,
			compressedCount: 0,
			droppedCount: 0,
			tokensBefore: 1000,
			tokensAfter: 1000,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }));
		expect(result).not.toContain("pinned");
	});

	test("includes budget usage and headroom", () => {
		const budget: EffectivePromptSnapshot["budget"] = {
			contextWindow: 200_000,
			systemPromptTokens: 5_000,
			toolDefinitionTokens: 3_000,
			messageTokens: 50_000,
			assembledContextTokens: 0,
			headroom: 142_000,
			hydrationBudgetMax: 0,
			messageBudgetMin: 0,
		};
		const result = formatAssemblySummary(makeSnapshot({ budget }));
		expect(result).toContain("Budget:");
		expect(result).toContain("58K/200K tokens");
		expect(result).toContain("142K headroom");
	});

	test("combines turns and budget with pipe separator", () => {
		const meta: TransformMetadata = {
			decisions: [makeDecision(0, "kept", "hot-window")],
			totalTurns: 1,
			keptCount: 1,
			stubbedCount: 0,
			compressedCount: 0,
			droppedCount: 0,
			tokensBefore: 1000,
			tokensAfter: 1000,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const budget: EffectivePromptSnapshot["budget"] = {
			contextWindow: 200_000,
			systemPromptTokens: 5_000,
			toolDefinitionTokens: 3_000,
			messageTokens: 50_000,
			assembledContextTokens: 0,
			headroom: 142_000,
			hydrationBudgetMax: 0,
			messageBudgetMin: 0,
		};
		const result = formatAssemblySummary(makeSnapshot({ meta, budget }))!;
		expect(result).toStartWith("[Assembly: ");
		expect(result).toEndWith("]");
		expect(result).toContain(" | Budget:");
	});

	test("shows single stubbed turn without range", () => {
		const meta: TransformMetadata = {
			decisions: [makeDecision(0, "stubbed", "beyond-hot-window"), makeDecision(1, "kept", "hot-window")],
			totalTurns: 2,
			keptCount: 1,
			stubbedCount: 1,
			compressedCount: 0,
			droppedCount: 0,
			tokensBefore: 2000,
			tokensAfter: 1200,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }))!;
		expect(result).toContain("1 stubbed (turn 0)");
	});

	test("omits stubbed clause when zero stubbed", () => {
		const meta: TransformMetadata = {
			decisions: [makeDecision(0, "kept", "hot-window"), makeDecision(1, "kept", "hot-window")],
			totalTurns: 2,
			keptCount: 2,
			stubbedCount: 0,
			compressedCount: 0,
			droppedCount: 0,
			tokensBefore: 2000,
			tokensAfter: 2000,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }))!;
		expect(result).not.toContain("stubbed");
	});

	test("omits dropped clause when zero dropped", () => {
		const meta: TransformMetadata = {
			decisions: [makeDecision(0, "kept", "hot-window")],
			totalTurns: 1,
			keptCount: 1,
			stubbedCount: 0,
			compressedCount: 0,
			droppedCount: 0,
			tokensBefore: 1000,
			tokensAfter: 1000,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }))!;
		expect(result).not.toContain("dropped");
	});

	test("budget-only snapshot still produces summary", () => {
		const budget: EffectivePromptSnapshot["budget"] = {
			contextWindow: 128_000,
			systemPromptTokens: 4_000,
			toolDefinitionTokens: 2_000,
			messageTokens: 100_000,
			assembledContextTokens: 5_000,
			headroom: 17_000,
			hydrationBudgetMax: 0,
			messageBudgetMin: 0,
		};
		const result = formatAssemblySummary(makeSnapshot({ meta: null, budget }))!;
		expect(result).toStartWith("[Assembly: Budget:");
		expect(result).toContain("111K/128K tokens");
		expect(result).toContain("17K headroom");
	});

	test("returns null for zero context window budget", () => {
		const budget: EffectivePromptSnapshot["budget"] = {
			contextWindow: 0,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			messageTokens: 0,
			assembledContextTokens: 0,
			headroom: 0,
			hydrationBudgetMax: 0,
			messageBudgetMin: 0,
		};
		const result = formatAssemblySummary(makeSnapshot({ meta: null, budget }));
		expect(result).toBeNull();
	});

	test("non-contiguous stubbed turns show full range", () => {
		const meta: TransformMetadata = {
			decisions: [
				makeDecision(0, "dropped", "budget-exceeded"),
				makeDecision(1, "stubbed", "beyond-hot-window"),
				makeDecision(2, "kept", "no-tool-results"),
				makeDecision(3, "stubbed", "beyond-hot-window"),
				makeDecision(4, "kept", "hot-window"),
			],
			totalTurns: 5,
			keptCount: 2,
			stubbedCount: 2,
			compressedCount: 0,
			droppedCount: 1,
			tokensBefore: 5000,
			tokensAfter: 2400,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};
		const result = formatAssemblySummary(makeSnapshot({ meta }))!;
		expect(result).toContain("2 stubbed (turns 1-3)");
	});

	test("reports recovery truncation and exclusions without misclassifying them", () => {
		const meta: TransformMetadata = {
			decisions: [
				makeDecision(0, "compressed", "recovery-anchor-truncated"),
				makeDecision(1, "dropped", "recovery-excluded"),
			],
			totalTurns: 2,
			keptCount: 0,
			stubbedCount: 0,
			compressedCount: 1,
			droppedCount: 1,
			tokensBefore: 2000,
			tokensAfter: 1000,
			scoredCount: 0,
			conversationCompressedKeys: [],
			recovery: {
				trigger: "empty-selection",
				outcome: "recovered",
				attempts: 2,
				originalTurnCount: 2,
				selectedOriginalTurnIndexes: [0],
				outputMessageCount: 1,
				outputTokens: 1000,
				anchorTruncated: true,
				controlPrompt: "truncated",
				initial: {
					outputMessageCount: 0,
					keptCount: 0,
					stubbedCount: 0,
					compressedCount: 0,
					droppedCount: 2,
					tokensAfter: 0,
				},
			},
		};

		const result = formatAssemblySummary(makeSnapshot({ meta }))!;
		expect(result).toContain("1 recovery-anchor-truncated");
		expect(result).toContain("1 recovery-excluded");
		expect(result).toContain("recovery: recovered with truncated anchor and truncation nudge");
		expect(result).not.toContain("codec-compressed");
		expect(result).not.toContain("budget-dropped");
	});

	test("reports an unrecoverable anchor reason", () => {
		const meta: TransformMetadata = {
			decisions: [makeDecision(0, "dropped", "recovery-excluded")],
			totalTurns: 1,
			keptCount: 0,
			stubbedCount: 0,
			compressedCount: 0,
			droppedCount: 1,
			tokensBefore: 1000,
			tokensAfter: 0,
			scoredCount: 0,
			conversationCompressedKeys: [],
			recovery: {
				trigger: "empty-selection",
				outcome: "unrecoverable",
				attempts: 0,
				originalTurnCount: 1,
				selectedOriginalTurnIndexes: [],
				outputMessageCount: 0,
				outputTokens: 0,
				anchorTruncated: false,
				controlPrompt: "omitted",
				unrecoverableAnchorReason: "text-anchor-exceeds-recoverable-budget",
				initial: {
					outputMessageCount: 0,
					keptCount: 0,
					stubbedCount: 0,
					compressedCount: 0,
					droppedCount: 1,
					tokensAfter: 0,
				},
			},
		};

		const result = formatAssemblySummary(makeSnapshot({ meta }))!;
		expect(result).toContain("recovery: unrecoverable (text-anchor-exceeds-recoverable-budget)");
	});

	test("reports oversized hot-window compression separately from ordinary codecs", () => {
		const meta: TransformMetadata = {
			decisions: [
				makeDecision(0, "compressed", "codec-compressed"),
				makeDecision(1, "compressed", "overflow-summarized"),
				makeDecision(2, "compressed", "hot-window-oversize-compressed"),
			],
			totalTurns: 3,
			keptCount: 0,
			stubbedCount: 0,
			compressedCount: 3,
			droppedCount: 0,
			tokensBefore: 3000,
			tokensAfter: 1200,
			scoredCount: 0,
			conversationCompressedKeys: [],
		};

		const result = formatAssemblySummary(makeSnapshot({ meta }));
		expect(result).toContain("1 codec-compressed");
		expect(result).toContain("1 overflow-summarized");
		expect(result).toContain("1 oversized hot-window compressed");
	});
});
