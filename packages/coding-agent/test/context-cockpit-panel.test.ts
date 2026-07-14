import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { TransformMetadata } from "@oh-my-pi/pi-coding-agent/context/assembler";
import {
	captureEffectivePromptSnapshot,
	type EffectivePromptSnapshot,
} from "@oh-my-pi/pi-coding-agent/context/effective-prompt-snapshot";
import type { RecallDebugEntry, RecallDebugTrace } from "@oh-my-pi/pi-coding-agent/context/recall";
import { type CockpitProjectionState, projectCockpitContext } from "@oh-my-pi/pi-coding-agent/modes/cockpit";
import { ContextCockpitPanel, ContextCockpitSplitView } from "@oh-my-pi/pi-coding-agent/modes/components";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";

let timestamp = 1000;
beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme unavailable");
	setThemeInstance(theme);
});

function nextTimestamp(): number {
	timestamp += 1000;
	return timestamp;
}

function makeUser(text: string): UserMessage {
	return {
		role: "user",
		content: text,
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
				action: "compressed",
				reason: "conversation-compressed",
				messageCount: 2,
				hasToolResults: false,
				tokensBefore: 500,
				tokensAfter: 120,
				sourceTags: [],
			},
		],
		totalTurns: 2,
		keptCount: 1,
		stubbedCount: 0,
		compressedCount: 1,
		droppedCount: 0,
		tokensBefore: 500,
		tokensAfter: 120,
		scoredCount: 0,
		...overrides,
	};
}

function makeRecallEntry(overrides?: Partial<RecallDebugEntry>): RecallDebugEntry {
	return {
		rank: 1,
		rowKey: "session:1:user:0",
		role: "user",
		turn: 1,
		toolName: null,
		timestamp: 1000,
		ageMs: 5000,
		age: "5s ago",
		band: "recent",
		sessionId: "session-1",
		projectCwd: "/repo",
		sameSession: true,
		sameProject: true,
		source: "semantic",
		semanticRank: 1,
		keywordRank: null,
		textPreview: "Earlier context about cockpit projection",
		...overrides,
	};
}

function makeRecallTrace(overrides?: Partial<RecallDebugTrace>): RecallDebugTrace {
	return {
		turnId: "turn-1",
		capturedAt: "2026-05-21T00:00:00.000Z",
		attempted: true,
		injected: true,
		cacheHit: false,
		durationMs: 12,
		failure: null,
		query: {
			text: "context cockpit",
			charCount: 15,
			estimatedTokens: 4,
			hotWindowTurns: 3,
			embeddingGenerated: true,
			originalCharCount: 15,
			effectiveCharCount: 15,
			projectedTokenCount: 4,
			effectiveTokenCount: 4,
			queryTruncated: false,
			toolResultRawCharCount: 0,
			toolResultEffectiveCharCount: 0,
			toolResults: { encoded: 0, stubbed: 0, counts: {} },
		},
		retrieval: {
			mode: "hybrid",
			projectScope: "current",
			roleFilter: null,
			recentWindowMs: 86_400_000,
			topK: 8,
			semanticCandidates: 2,
			keywordCandidates: 1,
			resolvedKeywordCandidates: 1,
			fusedCandidates: 2,
		},
		selected: [makeRecallEntry()],
		dropped: [makeRecallEntry({ rank: 2, rowKey: "session:1:assistant:1", role: "assistant" })],
		injectedText: "Earlier context about cockpit projection",
		injectedTokenEstimate: 9,
		...overrides,
	};
}

function makeSnapshot(turnId = "turn-1", message = "Fix the context cockpit projection"): EffectivePromptSnapshot {
	return captureEffectivePromptSnapshot({
		turnId,
		model: makeModel(),
		systemPrompt: "You are a helpful coding assistant.",
		tools: [makeTool("read"), makeTool("edit")],
		finalMessages: [makeUser(message)],
		transformMetadata: makeTransformMetadata(),
		assemblerPacket: null,
		assemblerBudget: { maxTokens: 50_000, maxLatencyMs: 2000, hydrationBudgetMax: 10_000, messageBudgetMin: 20_000 },
	});
}

function summaryForSnapshot(snapshot: EffectivePromptSnapshot): CockpitProjectionState["recentSnapshots"][number] {
	return {
		turnId: snapshot.turnId,
		capturedAt: snapshot.capturedAt,
		model: `${snapshot.model.provider}/${snapshot.model.id}`,
		messageCount: snapshot.messages.final.length,
		messageTokens: snapshot.messages.tokenEstimate,
		headroom: snapshot.budget?.headroom ?? null,
	};
}

function makeState(overrides?: { recall?: RecallDebugTrace | null }): CockpitProjectionState {
	const snapshot = makeSnapshot();
	const recall = overrides?.recall === undefined ? makeRecallTrace() : overrides.recall;
	return {
		context: projectCockpitContext({ current: snapshot, recall }),
		recentSnapshots: [summaryForSnapshot(snapshot)],
		timelineBlocks: [
			{
				id: "tool-call-1",
				kind: "tool",
				status: "done",
				label: "read",
				summary: "Tool read completed",
				metadata: { toolCallId: "call-1" },
				detailRef: { kind: "timeline-block", blockId: "tool-call-1" },
				expandable: true,
				createdAt: 1,
				updatedAt: 2,
			},
		],
		selectedBlockId: "tool-call-1",
	};
}

function renderPlain(panel: ContextCockpitPanel, width = 100): string {
	return panel
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

class StaticLines implements Component {
	constructor(readonly lines: string[]) {}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

describe("ContextCockpitPanel", () => {
	test("renders populated context, recall, assembly, and timeline summaries", () => {
		const panel = new ContextCockpitPanel(makeState());

		const output = renderPlain(panel);

		expect(output).toContain("Context Cockpit");
		expect(output).toContain("anthropic/claude-sonnet-4-20250514");
		expect(output).toContain("Recall: 1 selected / 1 dropped");
		expect(output).toContain("Assembly: assembly summary represented");
		expect(output).toContain("System prompt");
		expect(output).toContain("Passive recall");
		expect(output).toContain("Recent activity");
		expect(output).toContain("Tool read completed");
		expect(output).toContain("Recent turns");
		expect(output).toContain("turn-1");
	});

	test("renders recent turns and real previous-turn deltas", () => {
		const previous = makeSnapshot("turn-1", "Initial cockpit question");
		const current = makeSnapshot("turn-2", "Continue the cockpit projection with more context");
		const state = makeState();
		state.context = projectCockpitContext({ current, previous, recall: makeRecallTrace({ turnId: "turn-2" }) });
		state.recentSnapshots = [summaryForSnapshot(current), summaryForSnapshot(previous)];
		const panel = new ContextCockpitPanel(state);

		const output = renderPlain(panel);

		expect(output).toContain("Changed since previous");
		expect(output).toContain("Headroom");
		expect(output).toContain("Recent turns");
		expect(output).toContain("turn-2");
		expect(output).toContain("turn-1");
	});

	test("renders missing snapshot and missing recall states explicitly", () => {
		const state: CockpitProjectionState = {
			context: projectCockpitContext({ current: null, recall: null }),
			recentSnapshots: [],
			timelineBlocks: [],
			selectedBlockId: null,
		};
		const panel = new ContextCockpitPanel(state);

		const output = renderPlain(panel);

		expect(output).toContain("No effective context snapshot captured yet.");
		expect(output).toContain("No passive recall trace captured for this context");
		expect(output).toContain("No session activity projected yet.");
		expect(output).not.toContain("Changed since previous");
		expect(output).not.toContain("Recent turns");
	});

	test("renders warnings for recall mismatches", () => {
		const panel = new ContextCockpitPanel(makeState({ recall: makeRecallTrace({ turnId: "turn-other" }) }));

		const output = renderPlain(panel);

		expect(output).toContain("Warnings");
		expect(output).toContain("Recall trace turn-other does not match snapshot turn-1");
	});

	test("sanitizes tabs/newlines and truncates long rendered lines", () => {
		const state = makeState();
		state.context.sections[0] = {
			...state.context.sections[0],
			label: "Budget\tsection",
			summary: `line one\nline two\t${"x".repeat(120)}`,
		};
		const panel = new ContextCockpitPanel(state);

		const lines = panel.render(60).map(line => Bun.stripANSI(line));
		const output = lines.join("\n");

		expect(output).toContain("Budget section");
		expect(output).toContain("line one line two");
		expect(lines.every(line => line.length <= 60)).toBe(true);
	});

	test("closes on escape and ctrl-c", () => {
		const panel = new ContextCockpitPanel(makeState());
		let closeCount = 0;
		panel.onClose = () => {
			closeCount += 1;
		};

		panel.handleInput("\x1b");
		panel.handleInput("\x03");

		expect(closeCount).toBe(2);
	});

	test("selects rows and expands source-backed details", () => {
		const panel = new ContextCockpitPanel(makeState());
		panel.focused = true;

		panel.handleInput("\r");
		let output = renderPlain(panel);
		expect(output).toContain("context window:");
		expect(output).toContain("headroom:");

		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		output = renderPlain(panel);
		expect(output).toContain("fingerprint:");
		expect(output).toContain("tokens:");
	});

	test("navigates to recall row and expands recall provenance", () => {
		const panel = new ContextCockpitPanel(makeState());
		panel.focused = true;

		for (let i = 0; i < 7; i++) panel.handleInput("\x1b[B");
		panel.handleInput("\r");

		const output = renderPlain(panel);
		expect(output).toContain("selected: 1 · dropped: 1");
		expect(output).toContain("Earlier context about cockpit projection");
	});
});

describe("ContextCockpitSplitView", () => {
	test("renders cockpit as a right-side member on wide terminals", () => {
		const left = new StaticLines(["chat line one", "chat line two"]);
		const right = new ContextCockpitPanel(makeState());
		const split = new ContextCockpitSplitView(left, right);

		const output = split
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(output).toContain("chat line one");
		expect(output).toContain("Context Cockpit");
		expect(output).toContain("Passive recall");
	});

	test("renders cockpit at the min-width boundary", () => {
		const left = new StaticLines(["chat line one"]);
		const right = new ContextCockpitPanel(makeState());
		const split = new ContextCockpitSplitView(left, right);

		const output = split
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(output).toContain("chat line one");
		expect(output).toContain("Context Cockpit");
	});

	test("falls back to the main content only on narrow terminals", () => {
		const left = new StaticLines(["chat line one", "chat line two"]);
		const right = new ContextCockpitPanel(makeState());
		const split = new ContextCockpitSplitView(left, right);

		const output = split
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(output).toContain("chat line one");
		expect(output).not.toContain("Context Cockpit");
	});

	test("bottom-aligns the cockpit so it remains visible with long transcripts", () => {
		const left = new StaticLines(Array.from({ length: 40 }, (_, index) => `chat line ${index + 1}`));
		const right = new ContextCockpitPanel(makeState());
		const split = new ContextCockpitSplitView(left, right);

		const tail = split
			.render(120)
			.slice(-20)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(tail).toContain("chat line 40");
		expect(tail).toContain("Passive recall");
	});

	test("can hide the cockpit while preserving main content", () => {
		const left = new StaticLines(["chat line one"]);
		const right = new ContextCockpitPanel(makeState());
		const split = new ContextCockpitSplitView(left, right);

		expect(split.toggleVisible()).toBe(false);
		const output = split
			.render(140)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(output).toContain("chat line one");
		expect(output).not.toContain("Context Cockpit");
	});
});
