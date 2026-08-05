import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, DeveloperMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	computeTurnKey,
	DEFAULT_HOT_WINDOW_TURNS,
	dedupCodec,
	deriveBudget,
	formatStubText,
	isValidBoundedTransform,
	readCodec,
	segmentIntoTurns,
	TOOL_RESULT_STUB_TEXT,
	type TransformResult,
	transformMessages,
	transformMessagesWithRecovery,
	warmCodec,
} from "@oh-my-pi/pi-coding-agent/context/assembler";

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

function makeDeveloper(text: string): DeveloperMessage {
	return {
		role: "developer",
		content: text,
		timestamp: nextTimestamp(),
	};
}

function makeAssistant(toolCalls?: Array<{ id: string; name: string }>): AssistantMessage {
	const content: AssistantMessage["content"] = [{ type: "text", text: "thinking..." }];
	if (toolCalls) {
		for (const tc of toolCalls) {
			content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: {},
			});
		}
	}
	return {
		role: "assistant",
		content,
		api: "messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 100,
			output: 50,
			cacheWrite: 0,
			cacheRead: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCalls ? "toolUse" : "stop",
		timestamp: nextTimestamp(),
	};
}

function makeAssistantText(text: string, toolCalls?: Array<{ id: string; name: string }>): AssistantMessage {
	const message = makeAssistant(toolCalls);
	message.content[0] = { type: "text", text };
	return message;
}

function makeToolResult(toolCallId: string, text: string, toolName = "read"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: nextTimestamp(),
	};
}

/** Build a large tool result to control token estimates. */
function makeLargeToolResult(toolCallId: string, charCount: number, toolName = "read"): ToolResultMessage {
	const text = "x".repeat(charCount);
	return makeToolResult(toolCallId, text, toolName);
}

// ═══════════════════════════════════════════════════════════════════════════
// segmentIntoTurns
// ═══════════════════════════════════════════════════════════════════════════
function withoutElidedTombstone(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(msg => {
		const content = (msg as { content?: unknown }).content;
		return !(msg.role === "developer" && typeof content === "string" && content.startsWith("[Elided:"));
	});
}

describe("segmentIntoTurns", () => {
	test("empty messages → empty turns", () => {
		expect(segmentIntoTurns([])).toEqual([]);
	});

	test("single user message → one turn", () => {
		const messages: AgentMessage[] = [makeUser("hello")];
		const turns = segmentIntoTurns(messages);
		expect(turns).toHaveLength(1);
		expect(turns[0].messages).toHaveLength(1);
		expect(turns[0].hasToolResults).toBe(false);
	});

	test("user + assistant (no tools) → two turns", () => {
		const messages: AgentMessage[] = [makeUser("hello"), makeAssistant()];
		const turns = segmentIntoTurns(messages);
		expect(turns).toHaveLength(2);
		expect(turns[0].messages[0].role).toBe("user");
		expect(turns[1].messages[0].role).toBe("assistant");
		expect(turns[1].hasToolResults).toBe(false);
	});

	test("assistant + tool_results → single turn", () => {
		const assistant = makeAssistant([
			{ id: "tc-1", name: "read" },
			{ id: "tc-2", name: "grep" },
		]);
		const tr1 = makeToolResult("tc-1", "file content");
		const tr2 = makeToolResult("tc-2", "grep results");

		const messages: AgentMessage[] = [assistant, tr1, tr2];
		const turns = segmentIntoTurns(messages);
		expect(turns).toHaveLength(1);
		expect(turns[0].messages).toHaveLength(3);
		expect(turns[0].hasToolResults).toBe(true);
	});

	test("full conversation → correct segmentation", () => {
		const messages: AgentMessage[] = [
			makeUser("hello"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "file content"),
			makeAssistant([{ id: "tc-2", name: "edit" }]),
			makeToolResult("tc-2", "edit result"),
			makeAssistant(),
			makeUser("thanks"),
		];
		const turns = segmentIntoTurns(messages);
		expect(turns).toHaveLength(5);
		// Turn 0: user
		expect(turns[0].messages[0].role).toBe("user");
		expect(turns[0].hasToolResults).toBe(false);
		// Turn 1: assistant + tool_result
		expect(turns[1].messages[0].role).toBe("assistant");
		expect(turns[1].messages[1].role).toBe("toolResult");
		expect(turns[1].hasToolResults).toBe(true);
		// Turn 2: assistant + tool_result
		expect(turns[2].messages[0].role).toBe("assistant");
		expect(turns[2].messages[1].role).toBe("toolResult");
		expect(turns[2].hasToolResults).toBe(true);
		// Turn 3: assistant (no tools)
		expect(turns[3].messages[0].role).toBe("assistant");
		expect(turns[3].hasToolResults).toBe(false);
		// Turn 4: user
		expect(turns[4].messages[0].role).toBe("user");
		expect(turns[4].hasToolResults).toBe(false);
	});

	test("developer messages form their own turns", () => {
		const messages: AgentMessage[] = [makeDeveloper("system context"), makeUser("hello")];
		const turns = segmentIntoTurns(messages);
		expect(turns).toHaveLength(2);
		expect(turns[0].messages[0].role).toBe("developer");
	});

	test("orphaned tool_results grouped together defensively", () => {
		// Shouldn't happen in practice, but the function handles it
		const messages: AgentMessage[] = [
			makeToolResult("tc-1", "result 1"),
			makeToolResult("tc-2", "result 2"),
			makeUser("after"),
		];
		const turns = segmentIntoTurns(messages);
		expect(turns).toHaveLength(2);
		expect(turns[0].messages).toHaveLength(2);
		expect(turns[0].hasToolResults).toBe(true);
		expect(turns[1].messages[0].role).toBe("user");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — hot window
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — hot window", () => {
	test("empty messages → empty result with empty metadata", () => {
		const result = transformMessages([]);
		expect(result.messages).toEqual([]);
		expect(result.metadata.totalTurns).toBe(0);
		expect(result.metadata.decisions).toEqual([]);
		expect(result.metadata.keptCount).toBe(0);
		expect(result.metadata.stubbedCount).toBe(0);
		expect(result.metadata.compressedCount).toBe(0);
		expect(result.metadata.droppedCount).toBe(0);
		expect(result.metadata.tokensBefore).toBe(0);
		expect(result.metadata.tokensAfter).toBe(0);
	});

	test("messages within hot window are kept verbatim", () => {
		const messages: AgentMessage[] = [
			makeUser("hello"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "file content here"),
		];
		// Default hot window = 3 turns, we have 2 turns → all in hot window
		const result = transformMessages(messages);
		expect(result.messages).toEqual(messages);
	});

	test("tool_result content replaced beyond hot window", () => {
		// Build 5 turns: user + 4x (assistant + tool_result)
		const messages: AgentMessage[] = [
			makeUser("start"),
			// Turn 1 (old)
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "old content that should be replaced"),
			// Turn 2 (old)
			makeAssistant([{ id: "tc-2", name: "grep" }]),
			makeToolResult("tc-2", "another old result"),
			// Turn 3 (hot window)
			makeAssistant([{ id: "tc-3", name: "edit" }]),
			makeToolResult("tc-3", "recent edit result"),
			// Turn 4 (hot window)
			makeAssistant([{ id: "tc-4", name: "bash" }]),
			makeToolResult("tc-4", "recent bash output"),
			// Turn 5 (hot window)
			makeUser("continue"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 3 });

		// Find the old tool_result messages (turns 1 and 2)
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults).toHaveLength(4);

		// First two tool_results (old) should have stub content
		expect(toolResults[0].content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);
		expect(toolResults[1].content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);

		// Last two tool_results (hot window) should keep original content
		expect(toolResults[2].content).toEqual([{ type: "text", text: "recent edit result" }]);
		expect(toolResults[3].content).toEqual([{ type: "text", text: "recent bash output" }]);
	});

	test("resolver injects compact pointer for stubbed tool results", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "content A"),
			makeUser("a"),
			makeUser("b"),
			makeUser("c"),
		];

		const { messages: result } = transformMessages(messages, {
			hotWindowTurns: 3,
			resolveToolResultStub: message => ({ text: `[ref:${message.toolName}:src/file.ts]` }),
		});

		const toolResult = result.find((m): m is ToolResultMessage => m.role === "toolResult")!;
		expect(toolResult.content).toEqual([{ type: "text", text: "[ref:read:src/file.ts]" }]);
	});

	test("custom hotWindowTurns = 1 keeps only last turn verbatim", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "content A"),
			makeAssistant([{ id: "tc-2", name: "read" }]),
			makeToolResult("tc-2", "content B"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 1 });
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");

		// Only the last tool_result should be verbatim
		expect(toolResults[0].content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);
		expect(toolResults[1].content).toEqual([{ type: "text", text: "content B" }]);
	});

	test("assistant messages without tool calls are unaffected", () => {
		const assistant = makeAssistant();
		const messages: AgentMessage[] = [makeUser("hello"), assistant, makeUser("follow-up")];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 1 });

		// All messages kept as-is since no tool_results to replace
		expect(result).toEqual(messages);
	});

	test("tool_result details are cleared beyond hot window", () => {
		const tr: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "file content" }],
			details: { path: "/some/file", lineCount: 100 },
			isError: false,
			timestamp: nextTimestamp(),
		};

		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			tr,
			// 3 more turns to push the first one out of hot window
			makeUser("a"),
			makeUser("b"),
			makeUser("c"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 3 });
		const replacedTr = result.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "tc-1",
		)!;

		expect(replacedTr.details).toBeUndefined();
		expect(replacedTr.content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);
	});

	test("tool_use/tool_result pairing preserved after transform", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([
				{ id: "tc-1", name: "read" },
				{ id: "tc-2", name: "grep" },
			]),
			makeToolResult("tc-1", "content 1"),
			makeToolResult("tc-2", "content 2"),
			// Push out of hot window
			makeUser("a"),
			makeUser("b"),
			makeUser("c"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 3 });

		// Find the assistant message and its tool_results
		const assistantIdx = result.findIndex(m => m.role === "assistant");
		const assistant = result[assistantIdx] as AssistantMessage;
		const toolCallIds = assistant.content.filter(c => c.type === "toolCall").map(c => c.id);

		// Both tool_results should still be present
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");
		const toolResultIds = toolResults.map(tr => tr.toolCallId);
		for (const id of toolCallIds) {
			expect(toolResultIds).toContain(id);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — budget bounding
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — budget bounding", () => {
	test("no maxTokens → no dropping", () => {
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)),
			makeUser("b".repeat(1000)),
			makeUser("c".repeat(1000)),
		];
		const { messages: result } = transformMessages(messages);
		expect(result).toHaveLength(3);
	});

	test("drops oldest turns when over budget", () => {
		// Each message ~313 tokens (1000 chars / 3.2)
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~313 tokens
			makeUser("b".repeat(1000)), // ~313 tokens
			makeUser("c".repeat(1000)), // ~313 tokens
		];

		// Budget of 700 tokens with hotWindowTurns=1 → only last turn protected
		// Drops oldest until fits: drops 'a' (313), total 626 ≤ 700
		const { messages: result } = transformMessages(messages, { maxTokens: 700, hotWindowTurns: 1 });
		expect(result).toHaveLength(3);
		expect(result[0].role).toBe("developer");
		expect((result[0] as DeveloperMessage).content).toStartWith("[Elided: turns 1-1,");
		// First message dropped; tombstone records the seam.
		expect((result[1] as UserMessage).content).toBe("b".repeat(1000));
	});

	test("hot window is never dropped even if over budget", () => {
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~313 tokens
			makeUser("b".repeat(1000)), // ~313 tokens
			makeUser("c".repeat(1000)), // ~313 tokens
		];

		// Budget of 100 tokens but hot window = 3 → all messages kept
		const { messages: result } = transformMessages(messages, { maxTokens: 100, hotWindowTurns: 3 });
		expect(result).toHaveLength(3);
	});

	test("drops complete turns (assistant + tool_results together)", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeLargeToolResult("tc-1", 4000), // ~1000 tokens
			makeAssistant([{ id: "tc-2", name: "read" }]),
			makeLargeToolResult("tc-2", 400), // ~100 tokens
			makeUser("end"),
		];

		// Budget that fits last 3 turns but not first 3
		const { messages: result } = transformMessages(messages, { maxTokens: 500, hotWindowTurns: 3 });

		// First 3 turns (user, assistant+tr, assistant+tr) get evaluated
		// The hot window (last 3 turns) is preserved
		// Old turns are dropped
		expect(result.length).toBeLessThanOrEqual(messages.length);
		// The "end" user message should always be present
		const lastMsg = result[result.length - 1] as UserMessage;
		expect(lastMsg.content).toBe("end");
	});

	test("budget bounding respects content replacement savings", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeLargeToolResult("tc-1", 40000), // ~10000 tokens before replacement
			// 3 hot window turns to push turn-1 out of window
			makeUser("a"),
			makeAssistant([{ id: "tc-2", name: "read" }]),
			makeToolResult("tc-2", "small"),
			makeUser("end"),
		];

		// 5 turns total: user, assistant+tr, user, assistant+tr, user
		// Hot window (last 3): user(a), assistant+tr(tc-2), user(end)
		// Beyond window: user(start), assistant+tr(tc-1) → tc-1 content replaced
		// After replacement, large tool_result is stubbed (~15 tokens).
		// Budget of 2000 should now fit everything.
		const { messages: result } = transformMessages(messages, { maxTokens: 2000, hotWindowTurns: 3 });

		// All messages kept because the replaced stub is small
		expect(result).toHaveLength(messages.length);

		// Verify the old tool_result was replaced
		const oldTr = result.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "tc-1")!;
		expect(oldTr.content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — edge cases", () => {
	test("single message is kept", () => {
		const messages: AgentMessage[] = [makeUser("hello")];
		expect(transformMessages(messages).messages).toEqual(messages);
	});

	test("only assistant messages (no tool calls)", () => {
		const messages: AgentMessage[] = [makeAssistant(), makeAssistant()];
		const { messages: result } = transformMessages(messages, { hotWindowTurns: 1 });
		expect(result).toHaveLength(2);
		// No tool_results to replace, all kept
	});

	test("multiple tool_results per assistant message", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([
				{ id: "tc-1", name: "read" },
				{ id: "tc-2", name: "grep" },
				{ id: "tc-3", name: "find" },
			]),
			makeToolResult("tc-1", "read result"),
			makeToolResult("tc-2", "grep result"),
			makeToolResult("tc-3", "find result"),
			// Push first turn out of hot window
			makeUser("a"),
			makeUser("b"),
			makeUser("c"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 3 });
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");

		// All three should be replaced
		for (const tr of toolResults) {
			expect(tr.content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);
		}
	});

	test("default hot window is DEFAULT_HOT_WINDOW_TURNS", () => {
		expect(DEFAULT_HOT_WINDOW_TURNS).toBe(3);
	});

	test("hotWindowTurns = 0 replaces all tool_results", () => {
		const messages: AgentMessage[] = [
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "content"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 0 });
		const tr = result.find((m): m is ToolResultMessage => m.role === "toolResult")!;
		expect(tr.content).toEqual([{ type: "text", text: formatStubText(["tool:read"]) }]);
	});

	test("developer messages with unique content are kept; duplicates are dropped", () => {
		const user = makeUser("hello world");
		const devA = makeDeveloper("system context");
		const assistant = makeAssistant();
		const devB = makeDeveloper("system context"); // same content as devA
		const devC = makeDeveloper("unique handoff prompt"); // unique content
		const user2 = makeUser("world");

		const messages: AgentMessage[] = [user, devA, assistant, devB, devC, user2];
		const { messages: result } = transformMessages(messages, { hotWindowTurns: 0 });

		// devA dropped (duplicate of devB which is newer); devB and devC kept (unique content)
		expect(result).toEqual([user, assistant, devB, devC, user2]);
	});

	test("tool_result isError flag preserved after replacement", () => {
		const errorResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "Error: command not found" }],
			isError: true,
			timestamp: nextTimestamp(),
		};

		const messages: AgentMessage[] = [
			makeAssistant([{ id: "tc-1", name: "bash" }]),
			errorResult,
			// Push out of hot window
			makeUser("a"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 1 });
		const tr = result.find((m): m is ToolResultMessage => m.role === "toolResult")!;

		expect(tr.isError).toBe(true);
		expect(tr.toolCallId).toBe("tc-1");
		expect(tr.toolName).toBe("bash");
		expect(tr.content).toEqual([{ type: "text", text: formatStubText(["tool:bash"]) }]);
	});

	test("timestamp preserved on replaced tool_result", () => {
		const originalTs = nextTimestamp();
		const tr: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "data" }],
			isError: false,
			timestamp: originalTs,
		};

		const messages: AgentMessage[] = [makeAssistant([{ id: "tc-1", name: "read" }]), tr, makeUser("a")];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 1 });
		const replaced = result.find((m): m is ToolResultMessage => m.role === "toolResult")!;
		expect(replaced.timestamp).toBe(originalTs);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — message ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — message ordering", () => {
	test("message order is preserved after transform", () => {
		const messages: AgentMessage[] = [
			makeUser("1"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "result 1"),
			makeUser("2"),
			makeAssistant([{ id: "tc-2", name: "read" }]),
			makeToolResult("tc-2", "result 2"),
			makeUser("3"),
		];

		const { messages: result } = transformMessages(messages, { hotWindowTurns: 2 });

		// Verify order: user, assistant, toolResult, user, assistant, toolResult, user
		const roles = result.map(m => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant", "toolResult", "user"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — decision metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — decision metadata", () => {
	test("all hot-window turns are reported as kept with reason hot-window", () => {
		const messages: AgentMessage[] = [
			makeUser("hello"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "file content"),
		];
		// 2 turns, default hot window = 3 → all in hot window
		const { metadata } = transformMessages(messages);

		expect(metadata.totalTurns).toBe(2);
		expect(metadata.keptCount).toBe(2);
		expect(metadata.stubbedCount).toBe(0);
		expect(metadata.compressedCount).toBe(0);
		expect(metadata.droppedCount).toBe(0);

		for (const decision of metadata.decisions) {
			expect(decision.action).toBe("kept");
			expect(decision.reason).toBe("hot-window");
			expect(decision.tokensBefore).toBeGreaterThan(0);
			expect(decision.tokensAfter).toBe(decision.tokensBefore);
		}
	});

	test("stubbed turns report action=stubbed, reason=beyond-hot-window", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "a".repeat(2000)), // large content
			// Hot window (3 turns)
			makeUser("a"),
			makeUser("b"),
			makeUser("c"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 3 });

		expect(metadata.totalTurns).toBe(5);
		// Turn 0: user beyond hot window, no tool results → kept/no-tool-results
		expect(metadata.decisions[0].action).toBe("kept");
		expect(metadata.decisions[0].reason).toBe("no-tool-results");

		// Turn 1: assistant+tool_result beyond hot window → stubbed
		expect(metadata.decisions[1].action).toBe("stubbed");
		expect(metadata.decisions[1].reason).toBe("beyond-hot-window");
		expect(metadata.decisions[1].hasToolResults).toBe(true);
		expect(metadata.decisions[1].tokensAfter).toBeLessThan(metadata.decisions[1].tokensBefore);

		// Turns 2-4: hot window
		for (let i = 2; i < 5; i++) {
			expect(metadata.decisions[i].action).toBe("kept");
			expect(metadata.decisions[i].reason).toBe("hot-window");
		}

		expect(metadata.stubbedCount).toBe(1);
		expect(metadata.compressedCount).toBe(0);
		expect(metadata.keptCount).toBe(4);
	});

	test("dropped turns report action=dropped, reason=budget-exceeded", () => {
		// Each user message ~313 tokens
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~313 tokens
			makeUser("b".repeat(1000)), // ~313 tokens
			makeUser("c".repeat(1000)), // ~313 tokens
		];

		// Budget of 700, hot window = 1 → drop first turn
		const { metadata } = transformMessages(messages, { maxTokens: 700, hotWindowTurns: 1 });

		expect(metadata.totalTurns).toBe(3);
		expect(metadata.droppedCount).toBe(1);

		// First turn dropped
		expect(metadata.decisions[0].action).toBe("dropped");
		expect(metadata.decisions[0].reason).toBe("budget-exceeded");
		expect(metadata.decisions[0].tokensAfter).toBe(0);
		expect(metadata.decisions[0].tokensBefore).toBeGreaterThan(0);

		// Second turn: beyond hot window, no tool results → kept
		expect(metadata.decisions[1].action).toBe("kept");
		expect(metadata.decisions[1].reason).toBe("no-tool-results");

		// Third turn: hot window
		expect(metadata.decisions[2].action).toBe("kept");
		expect(metadata.decisions[2].reason).toBe("hot-window");
	});

	test("token estimates before/after are consistent", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeLargeToolResult("tc-1", 8000), // ~2000 tokens before stub
			makeUser("a"),
			makeUser("b"),
			makeUser("end"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 3 });

		// tokensBefore should be sum of all individual tokensBefore
		const sumBefore = metadata.decisions.reduce((sum, d) => sum + d.tokensBefore, 0);
		expect(metadata.tokensBefore).toBe(sumBefore);

		// tokensAfter should be sum of all individual tokensAfter
		const sumAfter = metadata.decisions.reduce((sum, d) => sum + d.tokensAfter, 0);
		expect(metadata.tokensAfter).toBe(sumAfter);

		// After stubbing, total tokens should be less than before
		expect(metadata.tokensAfter).toBeLessThan(metadata.tokensBefore);
	});

	test("stable turnIndex corresponds to original segmentation order", () => {
		const messages: AgentMessage[] = [
			makeUser("first"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "data"),
			makeUser("second"),
			makeUser("third"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 2 });

		// Verify indices are sequential and match turn count
		expect(metadata.decisions).toHaveLength(metadata.totalTurns);
		for (let i = 0; i < metadata.decisions.length; i++) {
			expect(metadata.decisions[i].turnIndex).toBe(i);
		}
	});

	test("messageCount reflects original turn size", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([
				{ id: "tc-1", name: "read" },
				{ id: "tc-2", name: "grep" },
			]),
			makeToolResult("tc-1", "r1"),
			makeToolResult("tc-2", "r2"),
			makeUser("end"),
		];

		const { metadata } = transformMessages(messages);

		// Turn 0: single user message
		expect(metadata.decisions[0].messageCount).toBe(1);
		// Turn 1: assistant + 2 tool_results = 3 messages
		expect(metadata.decisions[1].messageCount).toBe(3);
		// Turn 2: single user message
		expect(metadata.decisions[2].messageCount).toBe(1);
	});

	test("counts are consistent: kept + stubbed + dropped = totalTurns", () => {
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeLargeToolResult("tc-1", 4000),
			makeUser("b".repeat(1000)),
			makeUser("c"),
		];

		const { metadata } = transformMessages(messages, { maxTokens: 400, hotWindowTurns: 1 });

		expect(metadata.keptCount + metadata.stubbedCount + metadata.compressedCount + metadata.droppedCount).toBe(
			metadata.totalTurns,
		);
	});

	test("no-tool-results reason for non-tool turns beyond hot window", () => {
		const messages: AgentMessage[] = [
			makeUser("old message"),
			makeDeveloper("dev context"),
			makeAssistant(),
			// Hot window
			makeUser("recent"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 1 });

		// Turns 0-2 are beyond hot window; none have tool results
		// Turn 0: user beyond hot window — kept
		expect(metadata.decisions[0].action).toBe("kept");
		expect(metadata.decisions[0].reason).toBe("no-tool-results");
		// Turn 1: developer beyond hot window — kept (it's the latest developer message)
		expect(metadata.decisions[1].action).toBe("kept");
		expect(metadata.decisions[1].reason).toBe("no-tool-results");
		// Turn 2: standalone assistant beyond hot window — kept
		expect(metadata.decisions[2].action).toBe("kept");
		expect(metadata.decisions[2].reason).toBe("no-tool-results");

		// Turn 3: hot window
		expect(metadata.decisions[3].action).toBe("kept");
		expect(metadata.decisions[3].reason).toBe("hot-window");
	});

	test("combined stub + budget: turn stubbed then dropped reports dropped", () => {
		// Build scenario where a turn would be stubbed but then dropped for budget
		const messages: AgentMessage[] = [
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeLargeToolResult("tc-1", 4000), // big content, will be stubbed
			makeUser("a".repeat(1000)),
			makeUser("b".repeat(1000)),
			makeUser("recent"),
		];

		// Hot window = 1, tight budget that forces dropping
		const { metadata } = transformMessages(messages, { maxTokens: 300, hotWindowTurns: 1 });

		// The tool turn (index 0) should be dropped (it would be stubbed first,
		// but budget bounding drops it entirely — final state is dropped)
		const toolTurn = metadata.decisions[0];
		expect(toolTurn.action).toBe("dropped");
		expect(toolTurn.reason).toBe("budget-exceeded");
		expect(toolTurn.tokensAfter).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — front-drop API ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — front-drop API ordering", () => {
	test("no drops needed → no change, first message is user", () => {
		const messages: AgentMessage[] = [
			makeUser("hello"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "content"),
			makeUser("end"),
		];
		// Budget is generous, no drops
		const { messages: result } = transformMessages(messages, { maxTokens: 100000, hotWindowTurns: 2 });
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
	});

	test("budget drop leaves assistant at front → extends drop to next user turn", () => {
		// Turn 0: user (small)      <- budget will drop this
		// Turn 1: assistant + tool   <- would survive, starts with assistant → must also be dropped
		// Turn 2: user (small)       <- should become the new first message
		// Turn 3: user (hot window)
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~250 tokens (Turn 0)
			makeAssistant([{ id: "tc-1", name: "read" }]), // Turn 1
			makeToolResult("tc-1", "b".repeat(1000)), // Turn 1 continued
			makeUser("c".repeat(100)), // ~25 tokens (Turn 2)
			makeUser("d".repeat(100)), // ~25 tokens (Turn 3, hot window)
		];

		// Budget: enough for turns 2+3 (~50 tokens) but not turn 0+1 (~500 tokens)
		// Budget drop removes turn 0 (user), but that leaves turn 1 (assistant) at front.
		// Fix must extend drop to also remove turn 1, making turn 2 (user) the front.
		const { messages: result, metadata } = transformMessages(messages, { maxTokens: 100, hotWindowTurns: 1 });

		const visible = withoutElidedTombstone(result);
		// First surviving message must be user
		expect(visible[0]?.role).toBe("user");

		// Both turn 0 and turn 1 should be dropped
		expect(metadata.decisions[0].action).toBe("dropped");
		expect(metadata.decisions[1].action).toBe("dropped");
		expect(metadata.droppedCount).toBeGreaterThanOrEqual(2);
	});

	test("multiple consecutive non-user turns after drop → all dropped until user", () => {
		// Turn 0: user (large)      <- budget drops this
		// Turn 1: assistant + tool   <- non-user, also dropped
		// Turn 2: assistant (no tool) <- non-user, also dropped
		// Turn 3: user               <- becomes first message
		// Turn 4: user (hot window)
		const messages: AgentMessage[] = [
			makeUser("a".repeat(2000)), // ~500 tokens (Turn 0)
			makeAssistant([{ id: "tc-1", name: "read" }]), // Turn 1
			makeToolResult("tc-1", "b".repeat(2000)), // Turn 1
			makeAssistant(), // Turn 2 (no tools)
			makeUser("small"), // Turn 3
			makeUser("end"), // Turn 4 (hot window)
		];

		const { messages: result, metadata } = transformMessages(messages, { maxTokens: 100, hotWindowTurns: 1 });

		const visible = withoutElidedTombstone(result);
		expect(visible[0]?.role).toBe("user");
		expect(metadata.decisions[0].action).toBe("dropped");
		expect(metadata.decisions[1].action).toBe("dropped");
		expect(metadata.decisions[2].action).toBe("dropped");
	});

	test("all turns dropped except hot window → hot window preserved", () => {
		// Turn 0: user (large)      <- dropped
		// Turn 1: assistant + tool   <- dropped
		// Turn 2: user (hot window)  <- kept
		const messages: AgentMessage[] = [
			makeUser("a".repeat(4000)), // ~1000 tokens (Turn 0)
			makeAssistant([{ id: "tc-1", name: "read" }]), // Turn 1
			makeLargeToolResult("tc-1", 4000), // Turn 1
			makeUser("end"), // Turn 2 (hot window)
		];

		const { messages: result, metadata } = transformMessages(messages, { maxTokens: 50, hotWindowTurns: 1 });

		// Hot window user message must survive
		const visible = withoutElidedTombstone(result);
		expect(visible).toHaveLength(1);
		expect(visible[0]?.role).toBe("user");
		expect((visible[0] as UserMessage).content).toBe("end");
		expect(result[0].role).toBe("developer");
		expect(metadata.droppedCount).toBe(2);
	});

	test("hot window starts with user → no issue", () => {
		// All pre-hot-window turns dropped for budget, hot window starts with user
		const messages: AgentMessage[] = [
			makeUser("a".repeat(4000)), // Turn 0: dropped
			makeUser("recent-1"), // Turn 1 (hot window)
			makeAssistant([{ id: "tc-1", name: "read" }]), // Turn 2 (hot window)
			makeToolResult("tc-1", "content"), // Turn 2 (hot window)
			makeUser("recent-2"), // Turn 3 (hot window)
		];

		const { messages: result } = transformMessages(messages, { maxTokens: 50, hotWindowTurns: 3 });

		// Hot window starts with user → OK
		const visible = withoutElidedTombstone(result);
		expect(visible[0]?.role).toBe("user");
		expect((visible[0] as UserMessage).content).toBe("recent-1");
	});

	test("developer turn at front after drop → also dropped", () => {
		// Turn 0: user (large)      <- budget drops this
		// Turn 1: developer          <- non-user, also dropped
		// Turn 2: user               <- becomes first message
		// Turn 3: user (hot window)
		const messages: AgentMessage[] = [
			makeUser("a".repeat(2000)), // ~500 tokens (Turn 0)
			makeDeveloper("context"), // Turn 1
			makeUser("small"), // Turn 2
			makeUser("end"), // Turn 3 (hot window)
		];

		const { messages: result } = transformMessages(messages, { maxTokens: 50, hotWindowTurns: 1 });

		const visible = withoutElidedTombstone(result);
		expect(visible[0]?.role).toBe("user");
	});

	test("hot window starts with assistant after budget drop → extends into hot window", () => {
		// Turn 0: user (large)      <- budget drops this
		// Turn 1: assistant + tool   <- hot window, non-user → must also be dropped
		// Turn 2: user               <- hot window, becomes first message
		// hotWindowTurns = 2, so hotWindowStart = 1
		// Budget drops turn 0. dropCount = 1 = hotWindowStart.
		// transformedTurns[1] is assistant → pre-hotWindowStart loop doesn't run.
		// Fallback loop must extend past hotWindowStart to find user at turn 2.
		const messages: AgentMessage[] = [
			makeUser("a".repeat(2000)), // ~500 tokens (Turn 0)
			makeAssistant([{ id: "tc-1", name: "read" }]), // Turn 1 (hot window)
			makeToolResult("tc-1", "b".repeat(100)), // Turn 1 continued (hot window)
			makeUser("end"), // Turn 2 (hot window)
		];

		const { messages: result, metadata } = transformMessages(messages, { maxTokens: 50, hotWindowTurns: 2 });

		const visible = withoutElidedTombstone(result);
		// First surviving message must be user
		expect(visible[0]?.role).toBe("user");
		expect((visible[0] as UserMessage).content).toBe("end");
		// Turn 0 and turn 1 both dropped
		expect(metadata.decisions[0].action).toBe("dropped");
		expect(metadata.decisions[1].action).toBe("dropped");
		expect(metadata.droppedCount).toBe(2);
	});

	test("no budget → ordering fix not applied", () => {
		// Without budget bounding, dropCount stays 0 and no ordering fix is needed
		const messages: AgentMessage[] = [makeUser("hello"), makeAssistant(), makeUser("end")];

		const { messages: result } = transformMessages(messages);
		expect(result).toHaveLength(3);
		expect(result[0].role).toBe("user");
	});
});

describe("transformMessages — pre-budget conversation compression", () => {
	test("conversation compression reduces token pressure before budget eviction", () => {
		const longAssistantText = Array.from({ length: 40 }, (_, index) => `line ${index}: ${"x".repeat(30)}`).join("\n");
		const messages: AgentMessage[] = [
			makeUser("preserve the original task"),
			makeAssistantText(longAssistantText),
			makeUser("recent follow-up"),
		];

		const result = transformMessages(messages, {
			maxTokens: 120,
			hotWindowTurns: 1,
			relevanceScores: new Map([[1, 0]]),
		});

		expect(result.messages[0]).toBe(messages[0]);
		expect(result.metadata.decisions[0].action).toBe("kept");
		expect(result.metadata.decisions[1].action).toBe("compressed");
		expect(result.metadata.decisions[1].reason).toBe("conversation-compressed");
		expect(result.metadata.droppedCount).toBe(0);
		expect(result.metadata.tokensAfter).toBeLessThanOrEqual(120);
	});

	test("a compression candidate is kept when the codec does not reduce tokens", () => {
		const assistant = makeAssistantText("x".repeat(400));
		const messages: AgentMessage[] = [makeUser("task"), assistant, makeUser("recent")];

		const result = transformMessages(messages, {
			maxTokens: 1_000,
			hotWindowTurns: 1,
			relevanceScores: new Map([[1, 0]]),
		});

		expect(result.messages[1]).toBe(assistant);
		expect(result.metadata.decisions[1].action).toBe("kept");
		expect(result.metadata.compressedCount).toBe(0);
	});

	test("sticky turn keys keep conversation turns compressed without budget pressure", () => {
		const oldAssistant = makeAssistantText(
			Array.from({ length: 60 }, (_, index) => `sticky ${index} ${"x".repeat(40)}`).join("\n"),
		);
		const messages: AgentMessage[] = [makeUser("task"), oldAssistant, makeUser("recent")];
		const stickyKey = computeTurnKey(segmentIntoTurns(messages)[1]);

		const result = transformMessages(messages, {
			hotWindowTurns: 1,
			stickyCompressedKeys: new Set([stickyKey]),
			relevanceScores: new Map([[1, 1]]),
		});

		expect(result.metadata.decisions[1].action).toBe("compressed");
		expect(result.metadata.decisions[1].reason).toBe("conversation-compressed");
		expect(result.metadata.conversationCompressedKeys).toEqual([stickyKey]);
	});

	test("budget pressure compresses scored turns by ascending cosine before unscored turns", () => {
		const makeLong = (label: string) =>
			Array.from({ length: 70 }, (_, index) => `${label} ${index} ${"x".repeat(35)}`).join("\n");
		const messages: AgentMessage[] = [
			makeUser(makeLong("high")),
			makeAssistantText(makeLong("lowest")),
			makeUser(makeLong("unscored")),
			makeAssistantText(makeLong("middle")),
			makeUser("recent anchor"),
		];
		const turns = segmentIntoTurns(messages);
		const result = transformMessages(messages, {
			maxTokens: 900,
			hotWindowTurns: 1,
			relevanceScores: new Map([
				[0, 0.8],
				[1, -0.6],
				[3, 0.2],
			]),
		});

		const compressedKeys = result.metadata.conversationCompressedKeys;
		expect(compressedKeys.slice(0, 2)).toEqual([computeTurnKey(turns[1]), computeTurnKey(turns[3])]);
		const unscoredIndex = compressedKeys.indexOf(computeTurnKey(turns[2]));
		if (unscoredIndex !== -1) expect(unscoredIndex).toBeGreaterThan(1);
	});

	test("tight budgets emit deterministic elision tombstones at the drop seam", () => {
		const messages: AgentMessage[] = [
			makeUser(`first task ${"a".repeat(800)}`),
			makeAssistantText(`old answer ${"b".repeat(800)}`, [{ id: "tc-edit", name: "edit" }]),
			makeToolResult("tc-edit", "edited", "edit"),
			makeUser(`middle request ${"c".repeat(800)}`),
			makeAssistantText(`middle answer ${"d".repeat(800)}`),
			makeUser("latest literal anchor"),
		];
		(messages[1] as AssistantMessage).content.push({
			type: "toolCall",
			id: "tc-path",
			name: "edit",
			arguments: { path: "src/a.ts" },
		});

		const first = transformMessages(messages, { maxTokens: 120, hotWindowTurns: 1 });
		const second = transformMessages(messages, { maxTokens: 120, hotWindowTurns: 1 });

		expect(first.messages[0].role).toBe("developer");
		expect((first.messages[0] as DeveloperMessage).content).toStartWith("[Elided:");
		expect((first.messages[0] as DeveloperMessage).content).toContain("Files touched: src/a.ts (1)");
		expect(first.messages).toEqual(second.messages);
		expect(first.metadata.elided?.turnCount).toBeGreaterThan(0);
		expect(withoutElidedTombstone(first.messages).at(-1)).toBe(messages.at(-1));
	});
});

describe("transformMessagesWithRecovery", () => {
	test("does not accept a canonical custom start after dropping the latest literal user", () => {
		const user = makeUser("include customer.deleted");
		const custom: AgentMessage = {
			role: "custom",
			customType: "async-result",
			content: "Background work completed",
			display: true,
			attribution: "agent",
			timestamp: nextTimestamp(),
		};
		const sourceMessages: AgentMessage[] = [user, custom];
		const ordinary = transformMessages(sourceMessages, { maxTokens: 1_000, hotWindowTurns: 1 });
		const unsafe = {
			messages: [custom],
			metadata: {
				...ordinary.metadata,
				decisions: ordinary.metadata.decisions.map(decision =>
					decision.turnIndex === 0
						? {
								...decision,
								action: "dropped" as const,
								reason: "budget-exceeded" as const,
								tokensAfter: 0,
							}
						: decision,
				),
				droppedCount: 1,
			},
		} satisfies TransformResult;

		expect(isValidBoundedTransform(sourceMessages, unsafe)).toBe(false);
	});

	test("uses ordinary conversation compression before considering recovery", () => {
		const longAssistantText = Array.from({ length: 40 }, (_, index) => `line ${index}: ${"x".repeat(30)}`).join("\n");
		const messages: AgentMessage[] = [
			makeUser("preserve the original task"),
			makeAssistantText(longAssistantText),
			makeUser("recent follow-up"),
		];

		const result = transformMessagesWithRecovery(
			messages,
			{
				maxTokens: 120,
				hotWindowTurns: 1,
				relevanceScores: new Map([[1, 0]]),
			},
			{ standardControlPromptTokens: 20 },
		);

		expect(result.metadata.decisions[1]).toMatchObject({
			action: "compressed",
			reason: "conversation-compressed",
		});
		expect(result.metadata.recovery).toBeUndefined();
	});

	test("recovers a user-led suffix when normal front-drop exhausts the conversation", () => {
		const user = makeUser("reground and continue the original task");
		const messages: AgentMessage[] = [user];
		for (let index = 0; index < 8; index++) {
			const toolCallId = `tc-recovery-${index}`;
			messages.push(
				makeAssistantText("x".repeat(80), [{ id: toolCallId, name: "read" }]),
				makeToolResult(toolCallId, `result-${index}`),
			);
		}

		const options = { maxTokens: 180, hotWindowTurns: 2 };
		expect(transformMessages(messages, options).messages[0]?.role).toBe("user");

		const result = transformMessagesWithRecovery(messages, options, { standardControlPromptTokens: 20 });

		expect(result.messages[0]).toBe(user);
		expect(result.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
		]);
		expect(result.metadata.tokensAfter + 20).toBeLessThanOrEqual(180);
		expect(result.metadata.totalTurns).toBe(9);
		expect(result.metadata.decisions.map(decision => decision.turnIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(result.metadata.recovery?.outcome).toBe("recovered");
		expect(result.metadata.recovery?.selectedOriginalTurnIndexes).toEqual([0, 7, 8]);
		expect(result.metadata.recovery?.outputTokens).toBe(result.metadata.tokensAfter);
		expect(result.metadata.recovery?.controlPrompt).toBe("standard");
		expect(result.metadata.recovery?.initial.tokensAfter).toBeGreaterThan(0);
	});

	test("shrinks a hot suffix until the complete recovery output fits", () => {
		const user = makeUser("continue the task");
		const messages: AgentMessage[] = [
			user,
			makeAssistantText("small suffix turn"),
			makeAssistantText("x".repeat(200)),
		];

		const result = transformMessagesWithRecovery(messages, { maxTokens: 30, hotWindowTurns: 2 });

		expect(result.messages).toEqual([user]);
		expect(result.metadata.tokensAfter).toBeLessThanOrEqual(30);
		expect(result.metadata.recovery?.attempts).toBe(3);
		expect(result.metadata.recovery?.selectedOriginalTurnIndexes).toEqual([0]);
	});

	test("bounds an oversized text anchor and reserves a truncation nudge", () => {
		const user = makeUser(`task:${"x".repeat(1_000)}`);
		const messages: AgentMessage[] = [user, makeAssistantText("y".repeat(200))];

		const result = transformMessagesWithRecovery(
			messages,
			{ maxTokens: 100, hotWindowTurns: 1 },
			{ standardControlPromptTokens: 20, truncatedControlPromptTokens: 30 },
		);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("user");
		expect(result.metadata.tokensAfter + 30).toBeLessThanOrEqual(100);
		expect(result.metadata.decisions[0]).toMatchObject({
			turnIndex: 0,
			action: "compressed",
			reason: "recovery-anchor-truncated",
		});
		expect(result.metadata.recovery?.anchorTruncated).toBe(true);
		expect(result.metadata.recovery?.controlPrompt).toBe("truncated");

		const recovered = result.messages[0];
		if (recovered?.role !== "user" || !Array.isArray(recovered.content)) {
			throw new Error("Expected a bounded user message with head and tail fragments");
		}
		expect(recovered.content).toHaveLength(2);
		expect(recovered.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("task:") });
		expect(recovered.content[1]).toMatchObject({ type: "text", text: expect.stringMatching(/^x+$/) });
	});

	test("does not silently truncate a text anchor when no guidance budget was reserved", () => {
		const user = makeUser(`task:${"x".repeat(1_000)}`);
		const messages: AgentMessage[] = [user, makeAssistantText("y".repeat(200))];

		const result = transformMessagesWithRecovery(messages, { maxTokens: 10, hotWindowTurns: 1 });

		expect(result.messages).toEqual([]);
		expect(result.metadata.recovery).toMatchObject({
			outcome: "unrecoverable",
			anchorTruncated: false,
			controlPrompt: "omitted",
			unrecoverableAnchorReason: "text-anchor-exceeds-recoverable-budget",
		});
	});

	test("preserves the full user anchor before spending budget on the optional nudge", () => {
		const user = makeUser("keep this full user request intact");
		const messages: AgentMessage[] = [user, makeAssistantText("y".repeat(400))];

		const result = transformMessagesWithRecovery(
			messages,
			{ maxTokens: 12, hotWindowTurns: 1 },
			{ standardControlPromptTokens: 8, truncatedControlPromptTokens: 8 },
		);

		expect(result.messages).toEqual([user]);
		expect(result.metadata.recovery?.anchorTruncated).toBe(false);
		expect(result.metadata.recovery?.controlPrompt).toBe("omitted");
		expect(result.metadata.tokensAfter).toBeLessThanOrEqual(12);
	});

	test("preserves non-text anchor blocks when the complete user message fits", () => {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			timestamp: Date.now(),
		};
		const messages: AgentMessage[] = [user, makeAssistantText("y".repeat(400))];

		const result = transformMessagesWithRecovery(messages, { maxTokens: 40, hotWindowTurns: 1 });

		expect(result.messages).toEqual([user]);
		expect(result.metadata.recovery?.outcome).toBe("recovered");
		expect(result.metadata.recovery?.anchorTruncated).toBe(false);
	});

	test("reports an oversized non-text anchor as explicitly unrecoverable", () => {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "image", data: "x".repeat(1_000), mimeType: "image/png" }],
			timestamp: Date.now(),
		};
		const messages: AgentMessage[] = [user, makeAssistantText("y".repeat(200))];

		const result = transformMessagesWithRecovery(messages, { maxTokens: 10, hotWindowTurns: 1 });

		expect(result.messages).toEqual([]);
		expect(result.metadata.recovery).toMatchObject({
			outcome: "unrecoverable",
			unrecoverableAnchorReason: "non-text-anchor-exceeds-budget",
			outputMessageCount: 0,
			outputTokens: 0,
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Source provenance tags
// ═══════════════════════════════════════════════════════════════════════════

describe("formatStubText", () => {
	test("returns default stub when no source tags", () => {
		expect(formatStubText()).toBe(TOOL_RESULT_STUB_TEXT);
		expect(formatStubText([])).toBe(TOOL_RESULT_STUB_TEXT);
	});

	test("uses compact ref for single source tag", () => {
		const stub = formatStubText(["tool:grep"]);
		expect(stub).toBe("[ref:grep]");
	});

	test("uses primary source tag when multiple exist", () => {
		const stub = formatStubText(["tool:read", "tool:grep"]);
		expect(stub).toBe("[ref:read]");
	});

	test("keeps mcp source tag compact", () => {
		const stub = formatStubText(["mcp:rna"]);
		expect(stub).toBe("[ref:mcp:rna]");
	});
});

describe("TurnDecision sourceTags", () => {
	test("tool_result turns get source tags from toolName", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "content"),
			makeUser("end"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 1 });
		// Turn 0: user, Turn 1: assistant+tool_result, Turn 2: user
		const toolTurn = metadata.decisions.find(d => d.hasToolResults)!;
		expect(toolTurn.sourceTags).toEqual(["tool:read"]);
	});

	test("non-tool turns have empty sourceTags", () => {
		const messages: AgentMessage[] = [makeUser("hello"), makeAssistant(), makeUser("end")];

		const { metadata } = transformMessages(messages);
		for (const decision of metadata.decisions) {
			expect(decision.sourceTags).toEqual([]);
		}
	});

	test("MCP tool results get mcp: source tag", () => {
		const mcpResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc-mcp-1",
			toolName: "mcp_rna_search_symbols",
			content: [{ type: "text", text: "symbols found" }],
			isError: false,
			timestamp: nextTimestamp(),
		};

		const messages: AgentMessage[] = [
			makeAssistant([{ id: "tc-mcp-1", name: "mcp_rna_search_symbols" }]),
			mcpResult,
			makeUser("next"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 1 });
		const toolTurn = metadata.decisions.find(d => d.hasToolResults)!;
		expect(toolTurn.sourceTags).toEqual(["mcp:rna"]);
	});

	test("sourceTags survive stubbing", () => {
		const messages: AgentMessage[] = [
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "original content"),
			makeUser("a"),
			makeUser("b"),
			makeUser("c"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 3 });
		const stubbedTurn = metadata.decisions.find(d => d.action === "stubbed")!;
		// Source tags must persist even though content was stubbed
		expect(stubbedTurn.sourceTags).toEqual(["tool:read"]);
	});

	test("sourceTags survive budget-dropping", () => {
		const messages: AgentMessage[] = [
			makeAssistant([{ id: "tc-1", name: "bash" }]),
			makeLargeToolResult("tc-1", 40000, "bash"),
			makeUser("end"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 1, maxTokens: 100 });
		const droppedTurn = metadata.decisions.find(d => d.action === "dropped");
		if (droppedTurn) {
			// Source tags must persist even when dropped for budget
			expect(droppedTurn.sourceTags).toEqual(["tool:bash"]);
		}
	});

	test("multiple tools in one turn are deduplicated", () => {
		const messages: AgentMessage[] = [
			makeAssistant([
				{ id: "tc-1", name: "read" },
				{ id: "tc-2", name: "read" },
			]),
			makeToolResult("tc-1", "file A"),
			makeToolResult("tc-2", "file B"),
			makeUser("end"),
		];

		const { metadata } = transformMessages(messages, { hotWindowTurns: 1 });
		const toolTurn = metadata.decisions.find(d => d.hasToolResults)!;
		// Two read tool results → deduplicated to single tag
		expect(toolTurn.sourceTags).toEqual(["tool:read"]);
	});
	test("recalled-context developer messages are deduplicated even when the tag has attributes", () => {
		const olderRecall = makeDeveloper(
			'<recalled-context now="2026-04-18T12:00:00.000Z"><entry>older</entry></recalled-context>',
		);
		const newerRecall = makeDeveloper(
			'<recalled-context now="2026-04-18T12:05:00.000Z"><entry>newer</entry></recalled-context>',
		);
		const messages: AgentMessage[] = [makeUser("start"), olderRecall, makeAssistant(), newerRecall, makeUser("end")];
		const { messages: result } = transformMessages(messages, { hotWindowTurns: 0 });

		expect(result).toEqual([messages[0], messages[2], newerRecall, messages[4]]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// deriveBudget
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveBudget", () => {
	const BASE_INPUT = {
		contextWindow: 200_000,
		systemPromptTokens: 15_000,
		toolDefinitionTokens: 5_000,
		currentTurnTokens: 0,
		safetyMarginPercent: 5,
		messageBudgetPercent: 50,
		hydrationBudgetPercent: 50,
		turnBufferPercent: 0,
	};

	test("allocatable equals contextWindow minus fixed costs and safety reserve", () => {
		const budget = deriveBudget(BASE_INPUT);
		// safety = 200_000 * 0.05 = 10_000
		// allocatable = 200_000 - 15_000 - 5_000 - 0 - 10_000 = 170_000
		expect(budget.maxTokens).toBe(170_000);
	});

	test("message and hydration budgets split allocatable by configured percentages", () => {
		const budget = deriveBudget(BASE_INPUT);
		// 50/50 split of 170_000
		expect(budget.messageBudgetMin).toBe(85_000);
		expect(budget.hydrationBudgetMax).toBe(85_000);
	});

	test("currentTurnTokens reduces allocatable when non-zero", () => {
		const budget = deriveBudget({ ...BASE_INPUT, currentTurnTokens: 30_000 });
		// allocatable = 200_000 - 15_000 - 5_000 - 30_000 - 10_000 = 140_000
		expect(budget.maxTokens).toBe(140_000);
	});

	test("allocatable floors at zero when costs exceed context window", () => {
		const budget = deriveBudget({
			...BASE_INPUT,
			contextWindow: 20_000,
			systemPromptTokens: 15_000,
			toolDefinitionTokens: 10_000,
		});
		expect(budget.maxTokens).toBe(0);
		expect(budget.messageBudgetMin).toBe(0);
		expect(budget.hydrationBudgetMax).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Working-set retention
// ════════════════════════════════════════════════════════════════════════

describe("working-set retention", () => {
	let wsCall = 0;

	function makeReadTurn(path: string, content: string, extraArgs?: Record<string, unknown>): AgentMessage[] {
		wsCall++;
		const id = `ws-${wsCall}`;
		const assistant = makeAssistant([{ id, name: "read" }]);
		for (const block of assistant.content) {
			if (typeof block === "object" && block.type === "toolCall") {
				block.arguments = { path, ...extraArgs };
			}
		}
		return [assistant, makeToolResult(id, content)];
	}

	function fillerTurns(count: number): AgentMessage[] {
		const out: AgentMessage[] = [];
		for (let i = 0; i < count; i++) {
			out.push(makeUser(`filler ${wsCall}-${i}`), makeAssistant());
		}
		return out;
	}

	function resultTextById(messages: AgentMessage[], idSuffix: number): string {
		const msg = messages.find(m => m.role === "toolResult" && m.toolCallId === `ws-${idSuffix}`);
		if (!msg || msg.role !== "toolResult" || !Array.isArray(msg.content)) return "";
		return msg.content.map(c => (typeof c === "object" && c.type === "text" ? c.text : "")).join("");
	}

	test("third unchanged read pins the canonical first-read turn beyond the hot window", () => {
		wsCall = 0;
		const first = wsCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...fillerTurns(2),
		];
		const result = transformMessages(messages, { workingSet: { enabled: true } });
		// Canonical first read (turn 1) is beyond the hot window yet kept verbatim.
		expect(resultTextById(result.messages, first)).toContain("CONTENT_A unique payload");
		// The re-reads are still deduped/stubbed as usual.
		expect(resultTextById(result.messages, first + 1)).not.toContain("CONTENT_A unique payload");
		const decision = result.metadata.decisions.find(d => d.turnIndex === 1);
		expect(decision?.action).toBe("kept");
		expect(decision?.reason).toBe("working-set");
	});

	test("pin evicts after evictAfterTurns without a re-read", () => {
		wsCall = 0;
		const first = wsCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...fillerTurns(3),
		];
		const result = transformMessages(messages, {
			workingSet: { enabled: true, evictAfterTurns: 2 },
		});
		expect(resultTextById(result.messages, first)).not.toContain("CONTENT_A unique payload");
		const decision = result.metadata.decisions.find(d => d.turnIndex === 1);
		expect(decision?.reason).not.toBe("working-set");
	});

	test("disabled unless explicitly enabled", () => {
		wsCall = 0;
		const first = wsCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...fillerTurns(2),
		];
		const result = transformMessages(messages, {});
		expect(resultTextById(result.messages, first)).not.toContain("CONTENT_A unique payload");
	});

	test("a single re-read does not pin", () => {
		wsCall = 0;
		const first = wsCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...fillerTurns(3),
		];
		const result = transformMessages(messages, { workingSet: { enabled: true } });
		expect(resultTextById(result.messages, first)).not.toContain("CONTENT_A unique payload");
	});

	test("same-view re-read with changed content supersedes the stale pin", () => {
		wsCall = 0;
		const first = wsCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "OLD content payload"),
			...makeReadTurn("/a.ts", "OLD content payload"),
			...makeReadTurn("/a.ts", "OLD content payload"),
			// File edited; same view now returns different content.
			...makeReadTurn("/a.ts", "NEW content payload"),
			...fillerTurns(2),
		];
		const result = transformMessages(messages, { workingSet: { enabled: true } });
		// The provably stale OLD version must not stay pinned.
		expect(resultTextById(result.messages, first)).not.toContain("OLD content payload");
		const pins = result.metadata.decisions.filter(d => d.reason === "working-set");
		expect(pins).toHaveLength(0);
	});

	test("interleaved reads of other ranges do not reset pin candidacy", () => {
		wsCall = 0;
		const first = wsCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "RANGE_ONE payload", { offset: 1, limit: 100 }),
			...makeReadTurn("/a.ts", "RANGE_ONE payload", { offset: 1, limit: 100 }),
			...makeReadTurn("/a.ts", "RANGE_ONE payload", { offset: 1, limit: 100 }),
			// Later read of a different range must not supersede range one's pin.
			...makeReadTurn("/a.ts", "RANGE_TWO payload", { offset: 200, limit: 100 }),
			...fillerTurns(2),
		];
		const result = transformMessages(messages, { workingSet: { enabled: true } });
		// RANGE_ONE read three times → its canonical turn (1) pins; the later
		// different-range read is pagination, not proof of change.
		expect(resultTextById(result.messages, first)).toContain("RANGE_ONE payload");
		const decision = result.metadata.decisions.find(d => d.turnIndex === 1);
		expect(decision?.reason).toBe("working-set");
	});

	test("content change resets the pin candidate", () => {
		wsCall = 0;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_A unique payload"),
			...makeReadTurn("/a.ts", "CONTENT_B changed payload"),
			...fillerTurns(2),
		];
		const result = transformMessages(messages, { workingSet: { enabled: true } });
		const decisions = result.metadata.decisions.filter(d => d.reason === "working-set");
		expect(decisions).toHaveLength(0);
	});

	test("token cap pins most recently touched paths first", () => {
		wsCall = 0;
		const firstA = wsCall + 1;
		const bigA = `A${"a".repeat(600)}`;
		const bigB = `B${"b".repeat(600)}`;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeReadTurn("/a.ts", bigA),
			...makeReadTurn("/a.ts", bigA),
			...makeReadTurn("/a.ts", bigA),
			...makeReadTurn("/b.ts", bigB),
			...makeReadTurn("/b.ts", bigB),
			makeUser("q"),
			...makeReadTurn("/b.ts", bigB),
			...fillerTurns(2),
		];
		const result = transformMessages(messages, {
			workingSet: { enabled: true, tokenCap: 200 },
		});
		const pinnedTurns = result.metadata.decisions.filter(d => d.reason === "working-set");
		expect(pinnedTurns).toHaveLength(1);
		// /b.ts touched later → wins the cap; /a.ts canonical stays compressed.
		expect(resultTextById(result.messages, firstA)).not.toContain(bigA);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Stub recovery recipes
// ════════════════════════════════════════════════════════════════════════

describe("stub recovery recipes", () => {
	const PROD_CODECS = [dedupCodec, readCodec, warmCodec];
	let rrCall = 0;

	function makeToolTurn(name: string, args: Record<string, unknown>, resultText: string): AgentMessage[] {
		rrCall++;
		const id = `rr-${rrCall}`;
		const assistant = makeAssistant([{ id, name }]);
		for (const block of assistant.content) {
			if (typeof block === "object" && block.type === "toolCall") {
				block.arguments = args;
			}
		}
		return [assistant, makeToolResult(id, resultText, name)];
	}

	function resultText(messages: AgentMessage[], idSuffix: number): string {
		const msg = messages.find(m => m.role === "toolResult" && m.toolCallId === `rr-${idSuffix}`);
		if (!msg || msg.role !== "toolResult" || !Array.isArray(msg.content)) return "";
		return msg.content.map(c => (typeof c === "object" && c.type === "text" ? c.text : "")).join("");
	}

	const EIGHT_LINES = Array.from({ length: 8 }, (_, i) => `read content line ${i}`).join("\n");

	test("read stub carries a recall recipe when the file is unchanged in session", () => {
		rrCall = 0;
		const first = rrCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeToolTurn("read", { path: "/proj/alpha.ts" }, EIGHT_LINES),
			makeUser("next"),
			makeAssistant(),
			makeUser("more"),
			makeAssistant(),
			makeUser("again"),
			makeAssistant(),
		];
		const result = transformMessages(messages, { codecs: PROD_CODECS });
		const stub = resultText(result.messages, first);
		expect(stub).toContain('recall("/proj/alpha.ts") expands');
		expect(stub).toContain("unchanged in session");
	});

	test("read stub flags staleness when the file was edited later in session", () => {
		rrCall = 0;
		const first = rrCall + 1;
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeToolTurn("read", { path: "/proj/alpha.ts" }, EIGHT_LINES),
			...makeToolTurn("edit", { path: "/proj/alpha.ts" }, "Updated /proj/alpha.ts"),
			makeUser("more"),
			makeAssistant(),
			makeUser("again"),
			makeAssistant(),
		];
		const result = transformMessages(messages, { codecs: PROD_CODECS });
		const stub = resultText(result.messages, first);
		expect(stub).toContain("edited since this read");
		expect(stub).toContain("re-read for current state");
		expect(stub).not.toContain('recall("');
	});

	test("warm stub carries a generic recall recipe for non-file tools", () => {
		rrCall = 0;
		const first = rrCall + 1;
		const grepOutput = Array.from({ length: 9 }, (_, i) => `match ${i}: some line`).join("\n");
		const messages: AgentMessage[] = [
			makeUser("start"),
			...makeToolTurn("grep", { pattern: "needle" }, grepOutput),
			makeUser("next"),
			makeAssistant(),
			makeUser("more"),
			makeAssistant(),
			makeUser("again"),
			makeAssistant(),
		];
		const result = transformMessages(messages, { codecs: PROD_CODECS });
		const stub = resultText(result.messages, first);
		expect(stub).toContain("warm:grep");
		expect(stub).toContain("recall expands");
	});
});
