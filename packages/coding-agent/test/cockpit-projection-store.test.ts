import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { TransformMetadata } from "@oh-my-pi/pi-coding-agent/context/assembler";
import {
	captureEffectivePromptSnapshot,
	type EffectivePromptSnapshot,
} from "@oh-my-pi/pi-coding-agent/context/effective-prompt-snapshot";
import type { RecallDebugEntry, RecallDebugTrace } from "@oh-my-pi/pi-coding-agent/context/recall";
import { CockpitProjectionStore, projectCockpitContext } from "@oh-my-pi/pi-coding-agent/modes/cockpit";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

let timestamp = 1000;

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

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 5,
			cacheWrite: 0,
			cacheRead: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
				sourceTags: [],
			},
		],
		totalTurns: 1,
		keptCount: 1,
		stubbedCount: 0,
		compressedCount: 0,
		droppedCount: 0,
		tokensBefore: 50,
		tokensAfter: 50,
		scoredCount: 0,
		...overrides,
	};
}

function makeSnapshot(overrides?: {
	metadata?: TransformMetadata;
	messages?: UserMessage[];
	model?: Model;
	turnId?: string;
}): EffectivePromptSnapshot {
	return captureEffectivePromptSnapshot({
		turnId: overrides?.turnId ?? "turn-1",
		model: overrides?.model ?? makeModel(),
		systemPrompt: "You are a helpful coding assistant.",
		tools: [makeTool("read"), makeTool("edit")],
		finalMessages: overrides?.messages ?? [makeUser("Fix the context cockpit projection")],
		transformMetadata: overrides?.metadata ?? makeTransformMetadata(),
		assemblerPacket: null,
		assemblerBudget: { maxTokens: 50_000, maxLatencyMs: 2000, hydrationBudgetMax: 10_000, messageBudgetMin: 20_000 },
	});
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
		dropped: [makeRecallEntry({ rank: 2, rowKey: "session:1:assistant:1", role: "assistant", semanticRank: 2 })],
		injectedText: "Earlier context about cockpit projection",
		injectedTokenEstimate: 9,
		...overrides,
	};
}

describe("projectCockpitContext", () => {
	test("represents derived assembly summary as an expandable context section", () => {
		const snapshot = makeSnapshot({
			metadata: makeTransformMetadata({
				totalTurns: 3,
				keptCount: 2,
				stubbedCount: 1,
				tokensBefore: 120,
				tokensAfter: 90,
			}),
		});

		const state = projectCockpitContext({ current: snapshot });
		const summary = state.sections.find(section => section.id === "assembly-summary");

		expect(state.assemblySummary).toBeTruthy();
		expect(summary?.status).toBe("derived");
		expect(summary?.expandable).toBe(true);
		expect(summary?.summary).toContain("3 turns");
	});

	test("represents transform decisions as explicit expandable rows", () => {
		const snapshot = makeSnapshot({
			metadata: makeTransformMetadata({
				decisions: [
					{
						turnIndex: 0,
						action: "kept",
						reason: "hot-window",
						messageCount: 2,
						hasToolResults: false,
						tokensBefore: 50,
						tokensAfter: 50,
						sourceTags: [],
					},
					{
						turnIndex: 1,
						action: "stubbed",
						reason: "beyond-hot-window",
						messageCount: 3,
						hasToolResults: true,
						tokensBefore: 500,
						tokensAfter: 20,
						sourceTags: ["tool:read"],
					},
					{
						turnIndex: 2,
						action: "dropped",
						reason: "budget-exceeded",
						messageCount: 1,
						hasToolResults: false,
						tokensBefore: 400,
						tokensAfter: 0,
						sourceTags: [],
					},
				],
				totalTurns: 3,
				keptCount: 1,
				stubbedCount: 1,
				droppedCount: 1,
				tokensBefore: 950,
				tokensAfter: 70,
			}),
		});

		const state = projectCockpitContext({ current: snapshot });
		const messages = state.sections.find(section => section.id === "messages");
		const stubbed = state.sections.find(section => section.id === "decision-1");
		const dropped = state.sections.find(section => section.id === "decision-2");

		expect(messages?.status).toBe("dropped");
		expect(stubbed?.status).toBe("stubbed");
		expect(stubbed?.summary).toContain("beyond-hot-window");
		expect(stubbed?.expandable).toBe(true);
		expect(dropped?.status).toBe("dropped");
		expect(dropped?.summary).toContain("budget-exceeded");
	});

	test("joins passive recall trace selected and dropped provenance by turn", () => {
		const snapshot = makeSnapshot();
		const recall = makeRecallTrace();

		const state = projectCockpitContext({ current: snapshot, recall });
		const section = state.sections.find(item => item.id === "passive-recall");

		expect(section?.status).toBe("included");
		expect(section?.summary).toContain("1 selected");
		expect(section?.summary).toContain("1 dropped");
		expect(section?.summary).toContain("9 tok injected");
		expect(section?.expandable).toBe(true);
		expect(state.warnings).toHaveLength(0);
	});

	test("makes missing snapshot and trace states explicit", () => {
		const state = projectCockpitContext({ current: null, recall: null });

		expect(state.sections.find(section => section.id === "snapshot")?.status).toBe("unavailable");
		expect(state.sections.find(section => section.id === "passive-recall")?.summary).toContain(
			"No passive recall trace",
		);
		expect(state.warnings.some(warning => warning.id === "missing-snapshot")).toBe(true);
	});

	test("warns when recall trace belongs to a different turn", () => {
		const snapshot = makeSnapshot();
		const recall = makeRecallTrace({ turnId: "turn-other" });

		const state = projectCockpitContext({ current: snapshot, recall });

		expect(state.warnings.some(warning => warning.id === "recall-turn-mismatch")).toBe(true);
	});
});

describe("CockpitProjectionStore", () => {
	test("updates a single tool timeline block across start, update, and end events", () => {
		const store = new CockpitProjectionStore();
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "README.md" },
			intent: "Reading README",
		} satisfies AgentSessionEvent;
		const update = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "README.md" },
			partialResult: { content: [{ type: "text", text: "partial" }] },
		} satisfies AgentSessionEvent;
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		} satisfies AgentSessionEvent;

		store.handleEvent(start);
		store.handleEvent(update);
		store.handleEvent(end);

		const state = store.getState();
		expect(state.timelineBlocks).toHaveLength(1);
		expect(state.timelineBlocks[0]?.kind).toBe("tool");
		expect(state.timelineBlocks[0]?.status).toBe("done");
		expect(state.timelineBlocks[0]?.summary).toContain("completed");
		expect(state.timelineBlocks[0]?.metadata.intent).toBe("Reading README");
	});

	test("updates a single message timeline block across streaming lifecycle events", () => {
		const store = new CockpitProjectionStore();
		const message = makeAssistant("streamed user-visible content");

		store.handleEvent({ type: "message_start", message });
		store.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed", partial: message },
		});
		store.handleEvent({ type: "message_end", message });

		const state = store.getState();
		expect(state.timelineBlocks).toHaveLength(1);
		expect(state.timelineBlocks[0]?.kind).toBe("message");
		expect(state.timelineBlocks[0]?.status).toBe("done");
		expect(state.timelineBlocks[0]?.metadata.role).toBe("assistant");
	});

	test("keeps the last known snapshot but clears explicitly missing recall", () => {
		const store = new CockpitProjectionStore();
		const snapshot = makeSnapshot();

		store.updateContext({ current: snapshot, recall: makeRecallTrace() });
		store.updateContext({ current: null, recall: null });

		const state = store.getState();
		expect(state.context.current?.turnId).toBe("turn-1");
		expect(state.context.recall).toBeNull();
		expect(state.context.sections.find(section => section.id === "passive-recall")?.status).toBe("unavailable");
	});

	test("retains previous context snapshot when a new turn arrives", () => {
		const store = new CockpitProjectionStore();
		const first = makeSnapshot();
		const second = captureEffectivePromptSnapshot({
			turnId: "turn-2",
			model: makeModel({ contextWindow: 128_000 }),
			systemPrompt: "You are a helpful coding assistant.",
			tools: [makeTool("read"), makeTool("edit")],
			finalMessages: [makeUser("Continue the cockpit projection")],
			transformMetadata: makeTransformMetadata(),
			assemblerPacket: null,
			assemblerBudget: { maxTokens: 40_000, maxLatencyMs: 2000, hydrationBudgetMax: 8000, messageBudgetMin: 16_000 },
		});

		store.updateContext({ current: first });
		store.updateContext({ current: second, recall: makeRecallTrace({ turnId: "turn-2" }) });

		const state = store.getState();
		expect(state.context.current?.turnId).toBe("turn-2");
		expect(state.context.previous?.turnId).toBe("turn-1");
		expect(state.recentSnapshots.map(snapshot => snapshot.turnId)).toEqual(["turn-2", "turn-1"]);
		expect(state.context.deltas.some(delta => delta.id === "headroom")).toBe(true);
	});

	test("retains a bounded recent snapshot timeline newest first", () => {
		const store = new CockpitProjectionStore();

		for (let index = 1; index <= 10; index++) {
			store.updateContext({ current: makeSnapshot({ turnId: `turn-${index}` }) });
		}

		const state = store.getState();
		expect(state.recentSnapshots).toHaveLength(8);
		expect(state.recentSnapshots[0]?.turnId).toBe("turn-10");
		expect(state.recentSnapshots.at(-1)?.turnId).toBe("turn-3");
	});

	test("replaces recent snapshot summaries for repeated updates to the same turn", () => {
		const store = new CockpitProjectionStore();
		const initial = makeSnapshot({ turnId: "turn-1", messages: [makeUser("short")] });
		const replacement = makeSnapshot({
			turnId: "turn-1",
			messages: [makeUser("a much longer prompt that changes the snapshot token estimate")],
		});

		store.updateContext({ current: initial });
		store.updateContext({ current: replacement });

		const state = store.getState();
		expect(state.recentSnapshots).toHaveLength(1);
		expect(state.recentSnapshots[0]?.turnId).toBe("turn-1");
		expect(state.recentSnapshots[0]?.messageTokens).toBe(replacement.messages.tokenEstimate);
	});
});
