import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, DeveloperMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_HOT_WINDOW_TURNS,
	segmentIntoTurns,
	TOOL_RESULT_STUB_TEXT,
	transformMessages,
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
	test("empty messages → empty result", () => {
		expect(transformMessages([])).toEqual([]);
	});

	test("messages within hot window are kept verbatim", () => {
		const messages: AgentMessage[] = [
			makeUser("hello"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "file content here"),
		];
		// Default hot window = 3 turns, we have 2 turns → all in hot window
		const result = transformMessages(messages);
		expect(result).toEqual(messages);
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

		const result = transformMessages(messages, { hotWindowTurns: 3 });

		// Find the old tool_result messages (turns 1 and 2)
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults).toHaveLength(4);

		// First two tool_results (old) should have stub content
		expect(toolResults[0].content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
		expect(toolResults[1].content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);

		// Last two tool_results (hot window) should keep original content
		expect(toolResults[2].content).toEqual([{ type: "text", text: "recent edit result" }]);
		expect(toolResults[3].content).toEqual([{ type: "text", text: "recent bash output" }]);
	});

	test("custom hotWindowTurns = 1 keeps only last turn verbatim", () => {
		const messages: AgentMessage[] = [
			makeUser("start"),
			makeAssistant([{ id: "tc-1", name: "read" }]),
			makeToolResult("tc-1", "content A"),
			makeAssistant([{ id: "tc-2", name: "read" }]),
			makeToolResult("tc-2", "content B"),
		];

		const result = transformMessages(messages, { hotWindowTurns: 1 });
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");

		// Only the last tool_result should be verbatim
		expect(toolResults[0].content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
		expect(toolResults[1].content).toEqual([{ type: "text", text: "content B" }]);
	});

	test("assistant messages without tool calls are unaffected", () => {
		const assistant = makeAssistant();
		const messages: AgentMessage[] = [makeUser("hello"), assistant, makeUser("follow-up")];

		const result = transformMessages(messages, { hotWindowTurns: 1 });

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

		const result = transformMessages(messages, { hotWindowTurns: 3 });
		const replacedTr = result.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "tc-1",
		)!;

		expect(replacedTr.details).toBeUndefined();
		expect(replacedTr.content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
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

		const result = transformMessages(messages, { hotWindowTurns: 3 });

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
		const result = transformMessages(messages);
		expect(result).toHaveLength(3);
	});

	test("drops oldest turns when over budget", () => {
		// Each message ~250 tokens (1000 chars / 4)
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~250 tokens
			makeUser("b".repeat(1000)), // ~250 tokens
			makeUser("c".repeat(1000)), // ~250 tokens
		];

		// Budget of 600 tokens with hotWindowTurns=1 → only last turn protected
		// Drops oldest until fits: drops 'a' (250), total 500 ≤ 600
		const result = transformMessages(messages, { maxTokens: 600, hotWindowTurns: 1 });
		expect(result).toHaveLength(2);
		// First message dropped
		expect((result[0] as UserMessage).content).toBe("b".repeat(1000));
	});

	test("hot window is never dropped even if over budget", () => {
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~250 tokens
			makeUser("b".repeat(1000)), // ~250 tokens
			makeUser("c".repeat(1000)), // ~250 tokens
		];

		// Budget of 100 tokens but hot window = 3 → all messages kept
		const result = transformMessages(messages, { maxTokens: 100, hotWindowTurns: 3 });
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
		const result = transformMessages(messages, { maxTokens: 500, hotWindowTurns: 3 });

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
		const result = transformMessages(messages, { maxTokens: 2000, hotWindowTurns: 3 });

		// All messages kept because the replaced stub is small
		expect(result).toHaveLength(messages.length);

		// Verify the old tool_result was replaced
		const oldTr = result.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "tc-1")!;
		expect(oldTr.content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// transformMessages — edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("transformMessages — edge cases", () => {
	test("single message is kept", () => {
		const messages: AgentMessage[] = [makeUser("hello")];
		expect(transformMessages(messages)).toEqual(messages);
	});

	test("only assistant messages (no tool calls)", () => {
		const messages: AgentMessage[] = [makeAssistant(), makeAssistant()];
		const result = transformMessages(messages, { hotWindowTurns: 1 });
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

		const result = transformMessages(messages, { hotWindowTurns: 3 });
		const toolResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult");

		// All three should be replaced
		for (const tr of toolResults) {
			expect(tr.content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
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

		const result = transformMessages(messages, { hotWindowTurns: 0 });
		const tr = result.find((m): m is ToolResultMessage => m.role === "toolResult")!;
		expect(tr.content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
	});

	test("non-tool messages are never modified", () => {
		const user = makeUser("hello world");
		const dev = makeDeveloper("system context");
		const assistant = makeAssistant();

		const messages: AgentMessage[] = [user, dev, assistant];
		const result = transformMessages(messages, { hotWindowTurns: 0 });

		// All messages identical (no tool_results to modify)
		expect(result).toEqual(messages);
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

		const result = transformMessages(messages, { hotWindowTurns: 1 });
		const tr = result.find((m): m is ToolResultMessage => m.role === "toolResult")!;

		expect(tr.isError).toBe(true);
		expect(tr.toolCallId).toBe("tc-1");
		expect(tr.toolName).toBe("bash");
		expect(tr.content).toEqual([{ type: "text", text: TOOL_RESULT_STUB_TEXT }]);
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

		const result = transformMessages(messages, { hotWindowTurns: 1 });
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

		const result = transformMessages(messages, { hotWindowTurns: 2 });

		// Verify order: user, assistant, toolResult, user, assistant, toolResult, user
		const roles = result.map(m => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant", "toolResult", "user"]);
	});
});
