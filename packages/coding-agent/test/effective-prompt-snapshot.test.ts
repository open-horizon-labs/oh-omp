import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { TransformMetadata } from "@oh-my-pi/pi-coding-agent/context/assembler";
import {
	type CaptureSnapshotInput,
	captureEffectivePromptSnapshot,
	fingerprintText,
} from "@oh-my-pi/pi-coding-agent/context/effective-prompt-snapshot";
import {
	MEMORY_CONTRACT_VERSION,
	type WorkingContextPacketV1,
} from "@oh-my-pi/pi-coding-agent/context/memory-contract";

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

function makeTool(name: string, description?: string, parameters?: Record<string, unknown>): AgentTool {
	return {
		name,
		description: description ?? `Tool ${name}`,
		parameters: parameters ?? { type: "object", properties: { input: { type: "string" } } },
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
		tools: [makeTool("read"), makeTool("write")],
		finalMessages: [makeUser("Hello"), makeAssistant("Hi there!")],
		transformMetadata: null,
		assemblerPacket: null,
		assemblerBudget: null,
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests: fingerprintText
// ═══════════════════════════════════════════════════════════════════════════

describe("fingerprintText", () => {
	test("produces a non-empty string", () => {
		const fp = fingerprintText("test input");
		expect(fp.length).toBeGreaterThan(0);
	});

	test("is deterministic", () => {
		const input = "You are a helpful assistant with coding tools.";
		expect(fingerprintText(input)).toBe(fingerprintText(input));
	});

	test("differs for different inputs", () => {
		const a = fingerprintText("prompt version 1");
		const b = fingerprintText("prompt version 2");
		expect(a).not.toBe(b);
	});

	test("handles empty string", () => {
		const fp = fingerprintText("");
		expect(fp.length).toBeGreaterThan(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: captureEffectivePromptSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe("captureEffectivePromptSnapshot", () => {
	test("captures basic snapshot with correct structure", () => {
		const input = makeInput();
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.turnId).toBe("turn-1234567890");
		expect(snapshot.capturedAt).toBeTruthy();
		expect(new Date(snapshot.capturedAt).getTime()).not.toBeNaN();
	});

	test("captures model information", () => {
		const input = makeInput({ model: makeModel({ provider: "openai", id: "gpt-4o", contextWindow: 128_000 }) });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.model.provider).toBe("openai");
		expect(snapshot.model.id).toBe("gpt-4o");
		expect(snapshot.model.contextWindow).toBe(128_000);
	});

	test("handles undefined model gracefully", () => {
		const input = makeInput({ model: undefined });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.model.provider).toBe("unknown");
		expect(snapshot.model.id).toBe("unknown");
		expect(snapshot.model.contextWindow).toBe(0);
		expect(snapshot.budget).toBeNull();
	});

	test("captures system prompt fingerprint and token estimate", () => {
		const systemPrompt = "You are a helpful coding assistant.";
		const input = makeInput({ systemPrompt });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.systemPrompt.fingerprint).toBe(fingerprintText(systemPrompt));
		expect(snapshot.systemPrompt.tokenEstimate).toBe(Math.ceil(systemPrompt.length / 4));
	});

	test("system prompt fingerprint changes when prompt changes", () => {
		const snap1 = captureEffectivePromptSnapshot(makeInput({ systemPrompt: "prompt v1" }));
		const snap2 = captureEffectivePromptSnapshot(makeInput({ systemPrompt: "prompt v2" }));

		expect(snap1.systemPrompt.fingerprint).not.toBe(snap2.systemPrompt.fingerprint);
	});

	test("captures tool names and token estimates", () => {
		const tools = [
			makeTool("read", "Read a file", { type: "object", properties: { path: { type: "string" } } }),
			makeTool("write", "Write a file"),
			makeTool("grep", "Search for patterns"),
		];
		const input = makeInput({ tools });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.tools.names).toEqual(["read", "write", "grep"]);
		expect(snapshot.tools.totalDefinitionTokenEstimate).toBeGreaterThan(0);
	});

	test("captures final messages and token estimate", () => {
		const messages: AgentMessage[] = [
			makeUser("Hello, can you help me?"),
			makeAssistant("Of course! What do you need help with?"),
			makeUser("Fix this bug."),
		];
		const input = makeInput({ finalMessages: messages });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.messages.final).toBe(messages);
		expect(snapshot.messages.final.length).toBe(3);
		expect(snapshot.messages.tokenEstimate).toBeGreaterThan(0);
	});

	test("captures transform metadata when provided", () => {
		const metadata = makeTransformMetadata({
			totalTurns: 5,
			keptCount: 3,
			stubbedCount: 1,
			droppedCount: 1,
		});
		const input = makeInput({ transformMetadata: metadata });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.messages.transformMetadata).toBe(metadata);
		expect(snapshot.messages.transformMetadata!.totalTurns).toBe(5);
		expect(snapshot.messages.transformMetadata!.keptCount).toBe(3);
		expect(snapshot.messages.transformMetadata!.stubbedCount).toBe(1);
		expect(snapshot.messages.transformMetadata!.droppedCount).toBe(1);
	});

	test("transform metadata is null when not provided", () => {
		const input = makeInput({ transformMetadata: null });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.messages.transformMetadata).toBeNull();
	});

	test("captures assembler context when packet provided", () => {
		const packet = makePacket();
		const input = makeInput({ assemblerPacket: packet });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.assemblerContext).not.toBeNull();
		expect(snapshot.assemblerContext!.packet).toBe(packet);
		expect(snapshot.assemblerContext!.packet.fragments.length).toBe(1);
	});

	test("assembler context is null when no packet", () => {
		const input = makeInput({ assemblerPacket: null });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.assemblerContext).toBeNull();
	});

	test("captures budget breakdown with correct accounting", () => {
		const model = makeModel({ contextWindow: 200_000 });
		const systemPrompt = "A".repeat(400); // ~100 tokens
		const tools = [makeTool("tool1")];
		const messages: AgentMessage[] = [makeUser("Hello")];
		const packet = makePacket({ usage: { consumedTokens: 500, consumedLatencyMs: 50 } });

		const input = makeInput({
			model,
			systemPrompt,
			tools,
			finalMessages: messages,
			assemblerPacket: packet,
		});
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.budget).not.toBeNull();
		expect(snapshot.budget!.contextWindow).toBe(200_000);
		expect(snapshot.budget!.systemPromptTokens).toBe(Math.ceil(systemPrompt.length / 4));
		expect(snapshot.budget!.assembledContextTokens).toBe(500);
		expect(snapshot.budget!.messageTokens).toBeGreaterThan(0);

		// Headroom = contextWindow - sysPrompt - tools - messages - assembled
		const expectedHeadroom =
			200_000 -
			snapshot.budget!.systemPromptTokens -
			snapshot.budget!.toolDefinitionTokens -
			snapshot.budget!.messageTokens -
			500;
		expect(snapshot.budget!.headroom).toBe(expectedHeadroom);
	});

	test("headroom is never negative", () => {
		const model = makeModel({ contextWindow: 10 }); // Tiny context window
		const systemPrompt = "A".repeat(1000); // Way more than 10 tokens

		const input = makeInput({ model, systemPrompt });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.budget!.headroom).toBeGreaterThanOrEqual(0);
	});

	test("budget is null when model is undefined", () => {
		const input = makeInput({ model: undefined });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.budget).toBeNull();
	});

	test("snapshot from assembler mode includes all fields", () => {
		const metadata = makeTransformMetadata({
			totalTurns: 10,
			keptCount: 3,
			stubbedCount: 5,
			droppedCount: 2,
			tokensBefore: 50_000,
			tokensAfter: 20_000,
		});
		const packet = makePacket({
			usage: { consumedTokens: 3000, consumedLatencyMs: 200 },
			fragments: [
				{
					id: "f1",
					tier: "short_term",
					content: "code snippet",
					score: 0.9,
					provenance: {
						source: "bridge:read",
						reason: "tool_result",
						capturedAt: "2025-01-01T00:00:00.000Z",
						confidence: 1.0,
					},
				},
				{
					id: "f2",
					tier: "long_term",
					content: "context info",
					score: 0.7,
					provenance: {
						source: "bridge:grep",
						reason: "tool_result",
						capturedAt: "2025-01-01T00:00:00.000Z",
						confidence: 0.8,
					},
				},
			],
			dropped: [{ id: "f3", reason: "token_budget" }],
		});
		const budget = {
			maxTokens: 150_000,
			maxLatencyMs: 2000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};

		const input = makeInput({
			transformMetadata: metadata,
			assemblerPacket: packet,
			assemblerBudget: budget,
		});
		const snapshot = captureEffectivePromptSnapshot(input);

		// Verify all sections are populated
		expect(snapshot.systemPrompt.fingerprint.length).toBeGreaterThan(0);
		expect(snapshot.tools.names.length).toBeGreaterThan(0);
		expect(snapshot.messages.final.length).toBeGreaterThan(0);
		expect(snapshot.messages.transformMetadata).not.toBeNull();
		expect(snapshot.assemblerContext).not.toBeNull();
		expect(snapshot.budget).not.toBeNull();

		// Verify transform metadata is the actual structured data
		expect(snapshot.messages.transformMetadata!.droppedCount).toBe(2);
		expect(snapshot.messages.transformMetadata!.stubbedCount).toBe(5);

		// Verify assembler packet is faithfully recorded
		expect(snapshot.assemblerContext!.packet.fragments.length).toBe(2);
		expect(snapshot.assemblerContext!.packet.dropped.length).toBe(1);
		expect(snapshot.assemblerContext!.packet.usage.consumedTokens).toBe(3000);
	});

	test("snapshot from non-assembler mode has null assembler fields", () => {
		const input = makeInput({
			transformMetadata: null,
			assemblerPacket: null,
			assemblerBudget: null,
		});
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.messages.transformMetadata).toBeNull();
		expect(snapshot.assemblerContext).toBeNull();
		// Budget should still be present (derived from model)
		expect(snapshot.budget).not.toBeNull();
	});

	test("capturedAt is a valid ISO 8601 timestamp", () => {
		const snapshot = captureEffectivePromptSnapshot(makeInput());
		const parsed = new Date(snapshot.capturedAt);
		expect(parsed.toISOString()).toBe(snapshot.capturedAt);
	});

	test("empty tools list produces zero token estimate", () => {
		const input = makeInput({ tools: [] });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.tools.names).toEqual([]);
		expect(snapshot.tools.totalDefinitionTokenEstimate).toBe(0);
	});

	test("empty messages list produces zero token estimate", () => {
		const input = makeInput({ finalMessages: [] });
		const snapshot = captureEffectivePromptSnapshot(input);

		expect(snapshot.messages.final).toEqual([]);
		expect(snapshot.messages.tokenEstimate).toBe(0);
	});

	test("snapshot accurately reflects message bounding changes", () => {
		// Simulate a scenario where bounding dropped messages
		const fullMessages: AgentMessage[] = Array.from({ length: 20 }, (_, i) => makeUser(`Message ${i}`));
		const boundedMessages = fullMessages.slice(15); // Only last 5 kept

		const metadata = makeTransformMetadata({
			totalTurns: 20,
			keptCount: 5,
			droppedCount: 15,
			tokensBefore: 10_000,
			tokensAfter: 2_500,
		});

		const snap = captureEffectivePromptSnapshot(
			makeInput({
				finalMessages: boundedMessages,
				transformMetadata: metadata,
			}),
		);

		expect(snap.messages.final.length).toBe(5);
		expect(snap.messages.transformMetadata!.droppedCount).toBe(15);
		expect(snap.messages.transformMetadata!.keptCount).toBe(5);
		expect(snap.messages.transformMetadata!.tokensBefore).toBe(10_000);
		expect(snap.messages.transformMetadata!.tokensAfter).toBe(2_500);
	});
});
