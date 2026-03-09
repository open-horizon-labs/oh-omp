import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { TransformMetadata, TurnDecision } from "@oh-my-pi/pi-coding-agent/context/assembler";
import {
	type CaptureSnapshotInput,
	captureEffectivePromptSnapshot,
	type EffectivePromptSnapshot,
} from "@oh-my-pi/pi-coding-agent/context/effective-prompt-snapshot";
import {
	MEMORY_CONTRACT_VERSION,
	type WorkingContextPacketV1,
} from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import {
	formatTokens,
	projectSnapshot,
	renderBudgetBar,
	renderStatusBadge,
	renderStatusCounts,
} from "@oh-my-pi/pi-coding-agent/modes/components/prompt-inspector";

import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	const t = await getThemeByName("dark");
	if (t) setThemeInstance(t);
});

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

function makeModel(overrides?: Partial<Model>): Model {
	return {
		name: "Claude Sonnet",
		provider: "anthropic",
		id: "claude-sonnet-4-20250514",
		api: "messages",
		contextWindow: 200_000,
		maxTokens: 16_384,
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		...overrides,
	};
}

function makeTool(name: string): AgentTool {
	return {
		name,
		description: `Tool ${name}`,
		parameters: { type: "object", properties: { input: { type: "string" } } },
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	} as unknown as AgentTool;
}

function makeTransformMetadata(overrides?: Partial<TransformMetadata>): TransformMetadata {
	return {
		decisions: [
			{
				turnIndex: 0,
				action: "kept",
				reason: "hot-window",
				messageCount: 2,
				hasToolResults: false,
				tokensBefore: 50,
				tokensAfter: 50,
			},
		],
		totalTurns: 1,
		keptCount: 1,
		stubbedCount: 0,
		droppedCount: 0,
		tokensBefore: 50,
		tokensAfter: 50,
		...overrides,
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
		dropped: [],
		...overrides,
	};
}

function makeInput(overrides?: Partial<CaptureSnapshotInput>): CaptureSnapshotInput {
	return {
		turnId: "turn-1234567890",
		model: makeModel(),
		systemPrompt: "You are a helpful assistant.",
		tools: [makeTool("read"), makeTool("write"), makeTool("edit")],
		finalMessages: [makeUser("Hello"), makeAssistant("Hi there!")],
		transformMetadata: null,
		assemblerPacket: null,
		assemblerBudget: null,
		...overrides,
	};
}

function makeSnapshot(overrides?: Partial<CaptureSnapshotInput>): EffectivePromptSnapshot {
	return captureEffectivePromptSnapshot(makeInput(overrides));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests: formatTokens
// ═══════════════════════════════════════════════════════════════════════════

describe("formatTokens", () => {
	test("formats small counts", () => {
		expect(formatTokens(42)).toBe("42 tok");
		expect(formatTokens(999)).toBe("999 tok");
	});

	test("formats thousands", () => {
		expect(formatTokens(1500)).toBe("1.5K tok");
		expect(formatTokens(25000)).toBe("25K tok");
	});

	test("formats large counts", () => {
		expect(formatTokens(200000)).toBe("200K tok");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: renderStatusBadge
// ═══════════════════════════════════════════════════════════════════════════

describe("renderStatusBadge", () => {
	test("returns non-empty string for each status", () => {
		expect(renderStatusBadge("included").length).toBeGreaterThan(0);
		expect(renderStatusBadge("stubbed").length).toBeGreaterThan(0);
		expect(renderStatusBadge("dropped").length).toBeGreaterThan(0);
	});

	test("includes the status text", () => {
		// ANSI codes wrap the text, but the word should be present
		expect(renderStatusBadge("included")).toContain("included");
		expect(renderStatusBadge("stubbed")).toContain("stubbed");
		expect(renderStatusBadge("dropped")).toContain("dropped");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: renderStatusCounts
// ═══════════════════════════════════════════════════════════════════════════

describe("renderStatusCounts", () => {
	test("renders all three when non-zero", () => {
		const result = renderStatusCounts({ included: 5, stubbed: 2, dropped: 1 });
		expect(result).toContain("5 included");
		expect(result).toContain("2 stubbed");
		expect(result).toContain("1 dropped");
	});

	test("omits zero counts", () => {
		const result = renderStatusCounts({ included: 3, stubbed: 0, dropped: 0 });
		expect(result).toContain("3 included");
		expect(result).not.toContain("stubbed");
		expect(result).not.toContain("dropped");
	});

	test("returns empty string when all zero", () => {
		const result = renderStatusCounts({ included: 0, stubbed: 0, dropped: 0 });
		expect(result).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: renderBudgetBar
// ═══════════════════════════════════════════════════════════════════════════

describe("renderBudgetBar", () => {
	test("returns placeholder for zero total", () => {
		const lines = renderBudgetBar([], 0, 80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("no budget data");
	});

	test("renders segments with legend", () => {
		const segments = [
			{ label: "System", value: 1000, color: "accent" },
			{ label: "Messages", value: 3000, color: "success" },
		];
		const lines = renderBudgetBar(segments, 10000, 80);
		// Bar line + 2 legend lines
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines.some(l => l.includes("System"))).toBe(true);
		expect(lines.some(l => l.includes("Messages"))).toBe(true);
	});

	test("omits zero-value segments from legend", () => {
		const segments = [
			{ label: "System", value: 1000, color: "accent" },
			{ label: "Empty", value: 0, color: "dim" },
		];
		const lines = renderBudgetBar(segments, 10000, 80);
		expect(lines.some(l => l.includes("Empty"))).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: projectSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe("projectSnapshot", () => {
	test("returns 4 base sections for minimal snapshot", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);

		expect(sections.length).toBe(4);
		expect(sections.map(s => s.kind)).toEqual(["budget", "system-prompt", "tools", "messages"]);
	});

	test("includes assembled-context section when assembler is active", () => {
		const snapshot = makeSnapshot({ assemblerPacket: makePacket() });
		const sections = projectSnapshot(snapshot);

		const kinds = sections.map(s => s.kind);
		expect(kinds).toContain("assembled-context");
	});

	test("includes dropped-items section when drops exist", () => {
		const droppedDecision: TurnDecision = {
			turnIndex: 0,
			action: "dropped",
			reason: "budget-exceeded",
			messageCount: 3,
			hasToolResults: true,
			tokensBefore: 500,
			tokensAfter: 0,
		};

		const snapshot = makeSnapshot({
			transformMetadata: makeTransformMetadata({
				decisions: [droppedDecision],
				droppedCount: 1,
			}),
		});

		const sections = projectSnapshot(snapshot);
		const kinds = sections.map(s => s.kind);
		expect(kinds).toContain("dropped-items");
	});

	test("includes dropped-items when assembler has dropped fragments", () => {
		const snapshot = makeSnapshot({
			assemblerPacket: makePacket({
				dropped: [{ id: "frag-2", reason: "token_budget" }],
			}),
		});

		const sections = projectSnapshot(snapshot);
		const kinds = sections.map(s => s.kind);
		expect(kinds).toContain("dropped-items");
	});

	test("budget section summary includes token usage", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const budgetSection = sections.find(s => s.kind === "budget")!;

		expect(budgetSection.summary).toContain("tok");
		expect(budgetSection.summary).toContain("used");
		expect(budgetSection.summary).toContain("free");
	});

	test("system-prompt section shows fingerprint prefix", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const spSection = sections.find(s => s.kind === "system-prompt")!;

		expect(spSection.summary).toContain("tok");
		expect(spSection.summary).toContain("fingerprint");
	});

	test("tools section shows count and tokens", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const toolsSection = sections.find(s => s.kind === "tools")!;

		expect(toolsSection.summary).toContain("3 tools");
		expect(toolsSection.summary).toContain("tok");
		expect(toolsSection.count).toBe(3);
	});

	test("messages section shows count and transform stats", () => {
		const snapshot = makeSnapshot({
			transformMetadata: makeTransformMetadata({
				keptCount: 3,
				stubbedCount: 2,
				droppedCount: 1,
			}),
		});
		const sections = projectSnapshot(snapshot);
		const msgsSection = sections.find(s => s.kind === "messages")!;

		expect(msgsSection.summary).toContain("msgs");
		expect(msgsSection.summary).toContain("3 kept");
		expect(msgsSection.summary).toContain("2 stubbed");
		expect(msgsSection.summary).toContain("1 dropped");
		expect(msgsSection.statusCounts).toEqual({
			included: 3,
			stubbed: 2,
			dropped: 1,
		});
	});

	test("assembled-context section shows fragment count", () => {
		const snapshot = makeSnapshot({ assemblerPacket: makePacket() });
		const sections = projectSnapshot(snapshot);
		const asmSection = sections.find(s => s.kind === "assembled-context")!;

		expect(asmSection.summary).toContain("1 fragments");
		expect(asmSection.count).toBe(1);
	});

	test("dropped-items section summarizes reasons", () => {
		const snapshot = makeSnapshot({
			assemblerPacket: makePacket({
				dropped: [
					{ id: "frag-a", reason: "token_budget" },
					{ id: "frag-b", reason: "token_budget" },
				],
			}),
		});
		const sections = projectSnapshot(snapshot);
		const droppedSection = sections.find(s => s.kind === "dropped-items")!;

		expect(droppedSection.count).toBe(2);
		expect(droppedSection.summary).toContain("token_budget");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: Section detail rendering
// ═══════════════════════════════════════════════════════════════════════════

describe("section detail rendering", () => {
	test("budget detail includes model info and bar", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "budget")!.renderDetail(80);

		expect(detail.some(l => l.includes("anthropic"))).toBe(true);
		expect(detail.some(l => l.includes("Context window"))).toBe(true);
		expect(detail.some(l => l.includes("Headroom"))).toBe(true);
	});

	test("system-prompt detail includes fingerprint", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "system-prompt")!.renderDetail(80);

		expect(detail.some(l => l.includes("Fingerprint"))).toBe(true);
		expect(detail.some(l => l.includes("Token estimate"))).toBe(true);
	});

	test("tools detail lists tool names", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "tools")!.renderDetail(80);

		expect(detail.some(l => l.includes("read"))).toBe(true);
		expect(detail.some(l => l.includes("write"))).toBe(true);
		expect(detail.some(l => l.includes("edit"))).toBe(true);
	});

	test("messages detail shows role breakdown", () => {
		const snapshot = makeSnapshot();
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "messages")!.renderDetail(80);

		expect(detail.some(l => l.includes("user"))).toBe(true);
		expect(detail.some(l => l.includes("assistant"))).toBe(true);
	});

	test("messages detail shows transform savings", () => {
		const snapshot = makeSnapshot({
			transformMetadata: makeTransformMetadata({
				tokensBefore: 1000,
				tokensAfter: 600,
			}),
		});
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "messages")!.renderDetail(80);

		expect(detail.some(l => l.includes("Saved"))).toBe(true);
	});

	test("assembled-context detail shows fragments and objective", () => {
		const snapshot = makeSnapshot({ assemblerPacket: makePacket() });
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "assembled-context")!.renderDetail(80);

		expect(detail.some(l => l.includes("test objective"))).toBe(true);
		expect(detail.some(l => l.includes("frag-1"))).toBe(true);
	});

	test("dropped-items detail shows exclusion breakdown", () => {
		const snapshot = makeSnapshot({
			assemblerPacket: makePacket({
				dropped: [
					{ id: "frag-x", reason: "token_budget" },
					{ id: "frag-y", reason: "low_score" },
				],
			}),
		});
		const sections = projectSnapshot(snapshot);
		const detail = sections.find(s => s.kind === "dropped-items")!.renderDetail(80);

		expect(detail.some(l => l.includes("token_budget"))).toBe(true);
		expect(detail.some(l => l.includes("low_score"))).toBe(true);
	});

	test("detail rendering respects narrow width without crashing", () => {
		const snapshot = makeSnapshot({
			transformMetadata: makeTransformMetadata(),
			assemblerPacket: makePacket(),
		});
		const sections = projectSnapshot(snapshot);

		// Render all sections at a very narrow width — should not throw
		for (const section of sections) {
			const detail = section.renderDetail(20);
			expect(Array.isArray(detail)).toBe(true);
			expect(detail.length).toBeGreaterThan(0);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("projection edge cases", () => {
	test("snapshot without model budget still projects all base sections", () => {
		const snapshot = makeSnapshot({ model: undefined });
		const sections = projectSnapshot(snapshot);

		// Budget section should show "No budget data" type info
		expect(sections.length).toBe(4);
		expect(sections[0].kind).toBe("budget");
		expect(sections[0].summary).toContain("No budget data");
	});

	test("snapshot with empty tools list", () => {
		const snapshot = makeSnapshot({ tools: [] });
		const sections = projectSnapshot(snapshot);
		const toolsSection = sections.find(s => s.kind === "tools")!;

		expect(toolsSection.summary).toContain("0 tools");
		expect(toolsSection.count).toBe(0);
	});

	test("snapshot with empty messages", () => {
		const snapshot = makeSnapshot({ finalMessages: [] });
		const sections = projectSnapshot(snapshot);
		const msgsSection = sections.find(s => s.kind === "messages")!;

		expect(msgsSection.summary).toContain("0 msgs");
	});

	test("snapshot with transform metadata but no drops produces no dropped section", () => {
		const snapshot = makeSnapshot({
			transformMetadata: makeTransformMetadata({
				keptCount: 3,
				stubbedCount: 0,
				droppedCount: 0,
				decisions: [
					{
						turnIndex: 0,
						action: "kept",
						reason: "hot-window",
						messageCount: 2,
						hasToolResults: false,
						tokensBefore: 50,
						tokensAfter: 50,
					},
				],
			}),
		});

		const sections = projectSnapshot(snapshot);
		const kinds = sections.map(s => s.kind);
		expect(kinds).not.toContain("dropped-items");
	});
});
