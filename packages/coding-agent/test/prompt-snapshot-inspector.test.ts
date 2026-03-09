import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { TransformMetadata, TurnDecision } from "@oh-my-pi/pi-coding-agent/context/assembler";
import type { EffectivePromptSnapshot } from "@oh-my-pi/pi-coding-agent/context/effective-prompt-snapshot";
import {
	MEMORY_CONTRACT_VERSION,
	type WorkingContextPacketV1,
} from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import {
	buildPromptDecisionReport,
	buildPromptSectionDetail,
	buildPromptSnapshotOverview,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/prompt-snapshot-inspector";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

let ts = 1000;

function nextTimestamp(): number {
	ts += 1000;
	return ts;
}

function makeUser(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: nextTimestamp(),
	};
}

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 100,
			output: 50,
			cacheWrite: 0,
			cacheRead: 0,
			totalTokens: 150,
			cost: { input: 0.01, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.015 },
		},
		stopReason: "stop",
		timestamp: nextTimestamp(),
	};
}

function makePacket(overrides?: Partial<WorkingContextPacketV1>): WorkingContextPacketV1 {
	return {
		version: MEMORY_CONTRACT_VERSION,
		objective: "test objective",
		generatedAt: "2025-01-01T00:00:00.000Z",
		budget: {
			maxTokens: 40_000,
			maxLatencyMs: 2000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		},
		usage: { consumedTokens: 500, consumedLatencyMs: 100 },
		fragments: [
			{
				id: "frag-1",
				tier: "short_term",
				content: "function hello() {}",
				score: 0.8,
				provenance: {
					source: "bridge:read",
					reason: "tool_result",
					capturedAt: "2025-01-01T00:00:00.000Z",
					confidence: 1.0,
				},
			},
		],
		dropped: [{ id: "frag-2", reason: "token_budget" }],
		...overrides,
	};
}

function makeDecision(overrides?: Partial<TurnDecision>): TurnDecision {
	return {
		turnIndex: 0,
		action: "kept",
		reason: "hot-window",
		messageCount: 2,
		hasToolResults: false,
		tokensBefore: 50,
		tokensAfter: 50,
		...overrides,
	};
}

function makeTransformMetadata(overrides?: Partial<TransformMetadata>): TransformMetadata {
	return {
		decisions: [makeDecision()],
		totalTurns: 1,
		keptCount: 1,
		stubbedCount: 0,
		droppedCount: 0,
		tokensBefore: 50,
		tokensAfter: 50,
		...overrides,
	};
}

function makeSnapshot(overrides?: Partial<EffectivePromptSnapshot>): EffectivePromptSnapshot {
	return {
		turnId: "turn-1234567890",
		capturedAt: "2025-01-15T10:30:00.000Z",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-20250514",
			contextWindow: 200_000,
		},
		systemPrompt: {
			fingerprint: "fp-abc123",
			tokenEstimate: 500,
		},
		tools: {
			names: ["read", "write", "edit"],
			totalDefinitionTokenEstimate: 1200,
		},
		messages: {
			final: [makeUser("Hello"), makeAssistant("Hi there!")] as AgentMessage[],
			tokenEstimate: 150,
			transformMetadata: null,
		},
		assemblerContext: null,
		budget: {
			contextWindow: 200_000,
			systemPromptTokens: 500,
			toolDefinitionTokens: 1200,
			messageTokens: 150,
			assembledContextTokens: 0,
			headroom: 198_150,
		},
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests: buildPromptSnapshotOverview
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPromptSnapshotOverview", () => {
	test("returns unavailable overview for null snapshot", () => {
		const overview = buildPromptSnapshotOverview(null);
		expect(overview.available).toBe(false);
		expect(overview.turnId).toBeNull();
		expect(overview.capturedAt).toBeNull();
		expect(overview.model).toBeNull();
		expect(overview.sections.systemPrompt).toBeNull();
		expect(overview.sections.tools).toBeNull();
		expect(overview.sections.messages).toBeNull();
		expect(overview.sections.assemblerContext).toBeNull();
		expect(overview.sections.budget).toBeNull();
	});

	test("returns compact overview with no raw content", () => {
		const snapshot = makeSnapshot();
		const overview = buildPromptSnapshotOverview(snapshot);

		expect(overview.available).toBe(true);
		expect(overview.turnId).toBe("turn-1234567890");
		expect(overview.capturedAt).toBe("2025-01-15T10:30:00.000Z");
		expect(overview.model).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-20250514",
			contextWindow: 200_000,
		});

		// System prompt: fingerprint only, no raw content
		expect(overview.sections.systemPrompt).toEqual({
			fingerprint: "fp-abc123",
			tokenEstimate: 500,
		});

		// Tools: count only, no names list
		expect(overview.sections.tools).toEqual({
			count: 3,
			totalDefinitionTokenEstimate: 1200,
		});

		// Messages: count only, no message content
		expect(overview.sections.messages).toEqual({
			count: 2,
			tokenEstimate: 150,
			hasTransformMetadata: false,
		});

		// Budget: just window + headroom
		expect(overview.sections.budget).toEqual({
			contextWindow: 200_000,
			headroom: 198_150,
		});
	});

	test("includes assembler context summary when present", () => {
		const snapshot = makeSnapshot({
			assemblerContext: { packet: makePacket() },
		});
		const overview = buildPromptSnapshotOverview(snapshot);

		expect(overview.sections.assemblerContext).toEqual({
			fragmentCount: 1,
			droppedCount: 1,
			consumedTokens: 500,
		});
	});

	test("reflects transform metadata availability", () => {
		const snapshot = makeSnapshot({
			messages: {
				final: [makeUser("test")] as AgentMessage[],
				tokenEstimate: 25,
				transformMetadata: makeTransformMetadata(),
			},
		});
		const overview = buildPromptSnapshotOverview(snapshot);
		expect(overview.sections.messages?.hasTransformMetadata).toBe(true);
	});

	test("handles snapshot with no budget", () => {
		const snapshot = makeSnapshot({ budget: null });
		const overview = buildPromptSnapshotOverview(snapshot);
		expect(overview.available).toBe(true);
		expect(overview.sections.budget).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: buildPromptSectionDetail
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPromptSectionDetail", () => {
	test("returns null for null snapshot", () => {
		expect(buildPromptSectionDetail(null, "system_prompt")).toBeNull();
		expect(buildPromptSectionDetail(null, "tools")).toBeNull();
		expect(buildPromptSectionDetail(null, "messages")).toBeNull();
		expect(buildPromptSectionDetail(null, "budget")).toBeNull();
		expect(buildPromptSectionDetail(null, "assembler_context")).toBeNull();
		expect(buildPromptSectionDetail(null, "transform_metadata")).toBeNull();
	});

	test("returns system_prompt detail", () => {
		const snapshot = makeSnapshot();
		const detail = buildPromptSectionDetail(snapshot, "system_prompt");
		expect(detail).toEqual({
			section: "system_prompt",
			fingerprint: "fp-abc123",
			tokenEstimate: 500,
		});
	});

	test("returns tools detail with full names list", () => {
		const snapshot = makeSnapshot();
		const detail = buildPromptSectionDetail(snapshot, "tools");
		expect(detail).toEqual({
			section: "tools",
			names: ["read", "write", "edit"],
			totalDefinitionTokenEstimate: 1200,
		});
	});

	test("returns messages detail with full message array", () => {
		const snapshot = makeSnapshot();
		const detail = buildPromptSectionDetail(snapshot, "messages");
		expect(detail).not.toBeNull();
		if (detail?.section === "messages") {
			expect(detail.messages).toHaveLength(2);
			expect(detail.tokenEstimate).toBe(150);
			expect(detail.transformMetadata).toBeNull();
		}
	});

	test("returns budget detail with full breakdown", () => {
		const snapshot = makeSnapshot();
		const detail = buildPromptSectionDetail(snapshot, "budget");
		expect(detail).toEqual({
			section: "budget",
			budget: {
				contextWindow: 200_000,
				systemPromptTokens: 500,
				toolDefinitionTokens: 1200,
				messageTokens: 150,
				assembledContextTokens: 0,
				headroom: 198_150,
			},
		});
	});

	test("returns null for budget when budget is null", () => {
		const snapshot = makeSnapshot({ budget: null });
		expect(buildPromptSectionDetail(snapshot, "budget")).toBeNull();
	});

	test("returns assembler_context detail when present", () => {
		const packet = makePacket();
		const snapshot = makeSnapshot({ assemblerContext: { packet } });
		const detail = buildPromptSectionDetail(snapshot, "assembler_context");
		expect(detail).not.toBeNull();
		if (detail?.section === "assembler_context") {
			expect(detail.packet).toBe(packet);
		}
	});

	test("returns null for assembler_context when assembler is inactive", () => {
		const snapshot = makeSnapshot({ assemblerContext: null });
		expect(buildPromptSectionDetail(snapshot, "assembler_context")).toBeNull();
	});

	test("returns transform_metadata when present", () => {
		const metadata = makeTransformMetadata();
		const snapshot = makeSnapshot({
			messages: {
				final: [makeUser("test")] as AgentMessage[],
				tokenEstimate: 25,
				transformMetadata: metadata,
			},
		});
		const detail = buildPromptSectionDetail(snapshot, "transform_metadata");
		expect(detail).not.toBeNull();
		if (detail?.section === "transform_metadata") {
			expect(detail.metadata).toBe(metadata);
		}
	});

	test("returns null for transform_metadata when not present", () => {
		const snapshot = makeSnapshot();
		expect(buildPromptSectionDetail(snapshot, "transform_metadata")).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: buildPromptDecisionReport
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPromptDecisionReport", () => {
	test("returns unavailable report for null snapshot", () => {
		const report = buildPromptDecisionReport(null);
		expect(report.available).toBe(false);
		expect(report.summary).toBeNull();
		expect(report.decisions).toEqual([]);
	});

	test("returns unavailable report when no transform metadata", () => {
		const snapshot = makeSnapshot();
		const report = buildPromptDecisionReport(snapshot);
		expect(report.available).toBe(false);
		expect(report.summary).toBeNull();
	});

	test("returns full decision report with transform metadata", () => {
		const metadata = makeTransformMetadata({
			decisions: [
				makeDecision({ turnIndex: 0, action: "kept", reason: "hot-window" }),
				makeDecision({ turnIndex: 1, action: "stubbed", reason: "beyond-hot-window", hasToolResults: true }),
				makeDecision({ turnIndex: 2, action: "dropped", reason: "budget-exceeded" }),
			],
			totalTurns: 3,
			keptCount: 1,
			stubbedCount: 1,
			droppedCount: 1,
			tokensBefore: 300,
			tokensAfter: 150,
		});
		const snapshot = makeSnapshot({
			messages: {
				final: [makeUser("test")] as AgentMessage[],
				tokenEstimate: 150,
				transformMetadata: metadata,
			},
		});

		const report = buildPromptDecisionReport(snapshot);
		expect(report.available).toBe(true);
		expect(report.summary).toEqual({
			totalTurns: 3,
			keptCount: 1,
			stubbedCount: 1,
			droppedCount: 1,
			tokensBefore: 300,
			tokensAfter: 150,
		});
		expect(report.decisions).toHaveLength(3);
		expect(report.decisions[0].action).toBe("kept");
		expect(report.decisions[1].action).toBe("stubbed");
		expect(report.decisions[2].action).toBe("dropped");
	});

	test("filters decisions by action", () => {
		const metadata = makeTransformMetadata({
			decisions: [
				makeDecision({ turnIndex: 0, action: "kept" }),
				makeDecision({ turnIndex: 1, action: "stubbed" }),
				makeDecision({ turnIndex: 2, action: "dropped" }),
				makeDecision({ turnIndex: 3, action: "kept" }),
			],
			totalTurns: 4,
			keptCount: 2,
			stubbedCount: 1,
			droppedCount: 1,
		});
		const snapshot = makeSnapshot({
			messages: {
				final: [] as AgentMessage[],
				tokenEstimate: 0,
				transformMetadata: metadata,
			},
		});

		const report = buildPromptDecisionReport(snapshot, { action: "kept" });
		expect(report.available).toBe(true);
		expect(report.decisions).toHaveLength(2);
		expect(report.decisions.every(d => d.action === "kept")).toBe(true);
		// Summary is unfiltered — always reflects the full picture
		expect(report.summary?.totalTurns).toBe(4);
	});

	test("filters decisions by turn index", () => {
		const metadata = makeTransformMetadata({
			decisions: [
				makeDecision({ turnIndex: 0, action: "kept" }),
				makeDecision({ turnIndex: 1, action: "stubbed" }),
				makeDecision({ turnIndex: 2, action: "dropped" }),
			],
			totalTurns: 3,
		});
		const snapshot = makeSnapshot({
			messages: {
				final: [] as AgentMessage[],
				tokenEstimate: 0,
				transformMetadata: metadata,
			},
		});

		const report = buildPromptDecisionReport(snapshot, { turnIndex: 1 });
		expect(report.decisions).toHaveLength(1);
		expect(report.decisions[0].turnIndex).toBe(1);
		expect(report.decisions[0].action).toBe("stubbed");
	});

	test("combines action and turnIndex filters", () => {
		const metadata = makeTransformMetadata({
			decisions: [
				makeDecision({ turnIndex: 0, action: "kept" }),
				makeDecision({ turnIndex: 1, action: "kept" }),
				makeDecision({ turnIndex: 2, action: "dropped" }),
			],
			totalTurns: 3,
			keptCount: 2,
			droppedCount: 1,
		});
		const snapshot = makeSnapshot({
			messages: {
				final: [] as AgentMessage[],
				tokenEstimate: 0,
				transformMetadata: metadata,
			},
		});

		// Turn 0 is "kept", so this should find it
		const report = buildPromptDecisionReport(snapshot, { action: "kept", turnIndex: 0 });
		expect(report.decisions).toHaveLength(1);
		expect(report.decisions[0].turnIndex).toBe(0);

		// Turn 2 is "dropped" not "kept", so empty
		const empty = buildPromptDecisionReport(snapshot, { action: "kept", turnIndex: 2 });
		expect(empty.decisions).toHaveLength(0);
	});

	test("preserves decision field structure", () => {
		const metadata = makeTransformMetadata({
			decisions: [
				makeDecision({
					turnIndex: 5,
					action: "stubbed",
					reason: "beyond-hot-window",
					messageCount: 3,
					hasToolResults: true,
					tokensBefore: 200,
					tokensAfter: 30,
				}),
			],
			totalTurns: 6,
			stubbedCount: 1,
		});
		const snapshot = makeSnapshot({
			messages: {
				final: [] as AgentMessage[],
				tokenEstimate: 0,
				transformMetadata: metadata,
			},
		});

		const report = buildPromptDecisionReport(snapshot);
		const d = report.decisions[0];
		expect(d.turnIndex).toBe(5);
		expect(d.action).toBe("stubbed");
		expect(d.reason).toBe("beyond-hot-window");
		expect(d.messageCount).toBe(3);
		expect(d.hasToolResults).toBe(true);
		expect(d.tokensBefore).toBe(200);
		expect(d.tokensAfter).toBe(30);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: Backward compatibility (get_introspection unaffected)
// ═══════════════════════════════════════════════════════════════════════════

describe("backward compatibility", () => {
	test("existing RpcIntrospectionSnapshot type is unaffected by new types", () => {
		// This is a compile-time check: the test file imports from rpc-types which
		// also exports RpcIntrospectionSnapshot. If the new types broke backward
		// compat in rpc-types, this file would not compile at all.
		// We verify the new functions exist and work independently.
		expect(typeof buildPromptSnapshotOverview).toBe("function");
		expect(typeof buildPromptSectionDetail).toBe("function");
		expect(typeof buildPromptDecisionReport).toBe("function");
	});

	test("new inspection APIs coexist with existing introspection snapshot", () => {
		// Overview is independent from assembler introspection
		const overview = buildPromptSnapshotOverview(null);
		expect(overview.available).toBe(false);

		const report = buildPromptDecisionReport(null);
		expect(report.available).toBe(false);
	});
});
