import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, DeveloperMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_HOT_WINDOW_TURNS,
	formatStubText,
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
	test("empty messages → empty result with empty metadata", () => {
		const result = transformMessages([]);
		expect(result.messages).toEqual([]);
		expect(result.metadata.totalTurns).toBe(0);
		expect(result.metadata.decisions).toEqual([]);
		expect(result.metadata.keptCount).toBe(0);
		expect(result.metadata.stubbedCount).toBe(0);
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
		// Each message ~250 tokens (1000 chars / 4)
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~250 tokens
			makeUser("b".repeat(1000)), // ~250 tokens
			makeUser("c".repeat(1000)), // ~250 tokens
		];

		// Budget of 600 tokens with hotWindowTurns=1 → only last turn protected
		// Drops oldest until fits: drops 'a' (250), total 500 ≤ 600
		const { messages: result } = transformMessages(messages, { maxTokens: 600, hotWindowTurns: 1 });
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

	test("non-tool messages are never modified", () => {
		const user = makeUser("hello world");
		const dev = makeDeveloper("system context");
		const assistant = makeAssistant();

		const messages: AgentMessage[] = [user, dev, assistant];
		const { messages: result } = transformMessages(messages, { hotWindowTurns: 0 });

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
		expect(metadata.keptCount).toBe(4);
	});

	test("dropped turns report action=dropped, reason=budget-exceeded", () => {
		// Each user message ~250 tokens
		const messages: AgentMessage[] = [
			makeUser("a".repeat(1000)), // ~250 tokens
			makeUser("b".repeat(1000)), // ~250 tokens
			makeUser("c".repeat(1000)), // ~250 tokens
		];

		// Budget of 600, hot window = 1 → drop first turn
		const { metadata } = transformMessages(messages, { maxTokens: 600, hotWindowTurns: 1 });

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

		expect(metadata.keptCount + metadata.stubbedCount + metadata.droppedCount).toBe(metadata.totalTurns);
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
		expect(metadata.decisions[0].action).toBe("kept");
		expect(metadata.decisions[0].reason).toBe("no-tool-results");
		expect(metadata.decisions[1].action).toBe("kept");
		expect(metadata.decisions[1].reason).toBe("no-tool-results");
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

		// First surviving message must be user
		expect(result[0].role).toBe("user");

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

		expect(result[0].role).toBe("user");
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
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
		expect((result[0] as UserMessage).content).toBe("end");
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
		expect(result[0].role).toBe("user");
		expect((result[0] as UserMessage).content).toBe("recent-1");
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

		expect(result[0].role).toBe("user");
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

		// First surviving message must be user
		expect(result[0].role).toBe("user");
		expect((result[0] as UserMessage).content).toBe("end");
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

// ═══════════════════════════════════════════════════════════════════════════
// Source provenance tags
// ═══════════════════════════════════════════════════════════════════════════

describe("formatStubText", () => {
	test("returns default stub when no source tags", () => {
		expect(formatStubText()).toBe(TOOL_RESULT_STUB_TEXT);
		expect(formatStubText([])).toBe(TOOL_RESULT_STUB_TEXT);
	});

	test("includes single source tag", () => {
		const stub = formatStubText(["tool:grep"]);
		expect(stub).toContain("source: tool:grep");
		expect(stub).toContain("Content replaced");
	});

	test("includes multiple source tags", () => {
		const stub = formatStubText(["tool:read", "tool:grep"]);
		expect(stub).toContain("source: tool:read, tool:grep");
	});

	test("includes MCP source tag", () => {
		const stub = formatStubText(["mcp:rna"]);
		expect(stub).toContain("source: mcp:rna");
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
});
