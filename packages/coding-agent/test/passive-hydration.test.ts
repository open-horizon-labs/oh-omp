import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	buildPassiveRecallQuery,
	CosineCache,
	EMBEDDING_DIM,
	formatHydratedContext,
	qwen3EmbeddingProfile,
	type RecallSearchResult,
} from "@oh-my-pi/pi-coding-agent/context/recall";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

let ts = 1000;

function nextTimestamp(): number {
	ts += 1000;
	return ts;
}

function userMsg(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: nextTimestamp(),
	};
}

function assistantMsg(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 10,
			cacheWrite: 0,
			cacheRead: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: nextTimestamp(),
	};
}

function toolResultMsg(text: string, toolCallId = "tc-1", toolName = "read"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: nextTimestamp(),
	};
}

function assistantToolCallMsg(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown> = {},
): AssistantMessage {
	return {
		...assistantMsg("running tool"),
		content: [
			{ type: "text", text: "running tool" },
			{ type: "toolCall", id: toolCallId, name: toolName, arguments: args },
		],
		stopReason: "toolUse",
	};
}

function randomVector(dim: number): number[] {
	return Array.from({ length: dim }, () => Math.random());
}

function makeSearchResult(overrides: Partial<RecallSearchResult> = {}): RecallSearchResult {
	return {
		vector: randomVector(EMBEDDING_DIM),
		text: "recalled content",
		role: "user",
		turn: 1,
		tool_name: null,
		paths: null,
		symbols: null,
		timestamp: Date.now(),
		session_id: "test-session",
		project_cwd: "/tmp/test-project",
		_distance: 0.5,
		...overrides,
	};
}

describe("buildPassiveRecallQuery", () => {
	test("preserves user and assistant text", () => {
		const messages = [userMsg("fix passive recall"), assistantMsg("I will inspect hydration")];
		const result = buildPassiveRecallQuery(messages, { windowTurns: 3 });

		expect(result.text).toContain("fix passive recall");
		expect(result.text).toContain("I will inspect hydration");
		expect(result.metadata.originalCharCount).toBe(result.metadata.effectiveCharCount);
		expect(result.metadata.toolResults.encoded).toBe(0);
	});

	test("bounds the projected hot window with exact Qwen tokens", () => {
		const messages = [userMsg("old context ".repeat(2_000)), assistantMsg("RECENT_PASSIVE_DECISION")];
		const result = buildPassiveRecallQuery(messages, { windowTurns: 3 });

		expect(result.metadata.queryTruncated).toBe(true);
		expect(result.metadata.projectedTokenCount).toBeGreaterThan(qwen3EmbeddingProfile.queryTokens);
		expect(result.metadata.effectiveTokenCount).toBeLessThanOrEqual(qwen3EmbeddingProfile.queryTokens);
		expect(result.metadata.effectiveCharCount).toBeLessThan(result.metadata.originalCharCount);
		expect(result.text).toContain("RECENT_PASSIVE_DECISION");
	});

	test("projects read tool results through read codec instead of raw output", () => {
		const readOutput = [
			"1#AA:import { thing } from './thing';",
			"2#BB:",
			"3#CC:function usefulSymbol() {",
			"4#DD:\treturn 'ok';",
			"5#EE:}",
			...Array.from({ length: 60 }, (_, index) => `${index + 6}#ZZ:\tvalue${index};`),
			"[Showing lines 1-65 of 65. Use offset=66 to continue]",
		].join("\n");
		const messages = [
			userMsg("remember this file"),
			assistantToolCallMsg("tc-read", "read", { path: "src/useful.ts" }),
			toolResultMsg(readOutput, "tc-read", "read"),
		];

		const result = buildPassiveRecallQuery(messages, { windowTurns: 3 });

		expect(result.text).toContain("remember this file");
		expect(result.text).toContain("[warm:read:src/useful.ts");
		expect(result.text).toContain("usefulSymbol");
		expect(result.metadata.toolResults.counts.read).toBe(1);
		expect(result.metadata.toolResultEffectiveCharCount).toBeLessThan(result.metadata.toolResultRawCharCount);
	});

	test("projects generic tool results through warm codec and drops omitted raw middle", () => {
		const output = [
			"line 1",
			"line 2",
			"line 3",
			"MIDDLE_RAW_OUTPUT_SHOULD_NOT_SURVIVE",
			"line 5",
			"line 6",
			"line 7",
			"line 8",
		].join("\n");
		const messages = [
			userMsg("run the check"),
			assistantToolCallMsg("tc-bash", "bash", { command: "bun check:ts" }),
			toolResultMsg(output, "tc-bash", "bash"),
		];

		const result = buildPassiveRecallQuery(messages, { windowTurns: 3 });

		expect(result.text).toContain('[warm:bash | command="bun check:ts" | 8 lines]');
		expect(result.text).toContain("[... 3 lines omitted]");
		expect(result.text).not.toContain("MIDDLE_RAW_OUTPUT_SHOULD_NOT_SURVIVE");
		expect(result.metadata.toolResults.counts.warm).toBe(1);
	});

	test("deduplicates repeated unchanged reads in the projected query", () => {
		const readOutput = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta";
		const messages = [
			userMsg("first read"),
			assistantToolCallMsg("tc-read-1", "read", { path: "src/repeated.ts" }),
			toolResultMsg(readOutput, "tc-read-1", "read"),
			userMsg("read it again"),
			assistantToolCallMsg("tc-read-2", "read", { path: "src/repeated.ts" }),
			toolResultMsg(readOutput, "tc-read-2", "read"),
		];

		const result = buildPassiveRecallQuery(messages, { windowTurns: 5 });

		expect(result.text).toContain("[unchanged since T1:read:src/repeated.ts]");
		expect(result.metadata.toolResults.counts.dedup).toBe(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// CosineCache
// ═══════════════════════════════════════════════════════════════════════════

describe("CosineCache", () => {
	test("first check is always a miss", () => {
		const cache = new CosineCache(0.15);
		const embedding = new Float32Array([1, 0, 0, 0]);
		const result = cache.check(embedding);
		expect(result.hit).toBe(false);
		expect(cache.misses).toBe(1);
		expect(cache.hits).toBe(0);
	});

	test("identical embedding is a cache hit", () => {
		const cache = new CosineCache(0.15);
		const embedding = new Float32Array([1, 0, 0, 0]);
		const mockResults = [makeSearchResult({ text: "cached" })];

		cache.update(embedding, mockResults);
		const result = cache.check(embedding);

		expect(result.hit).toBe(true);
		if (result.hit) {
			expect(result.results).toEqual(mockResults);
		}
		expect(cache.hits).toBe(1);
	});

	test("very different embedding is a cache miss", () => {
		const cache = new CosineCache(0.15);
		const embedding1 = new Float32Array([1, 0, 0, 0]);
		const embedding2 = new Float32Array([0, 0, 0, 1]); // orthogonal

		cache.update(embedding1, [makeSearchResult()]);
		const result = cache.check(embedding2);

		expect(result.hit).toBe(false);
		expect(cache.misses).toBe(1);
	});

	test("slightly different embedding is a cache hit", () => {
		const cache = new CosineCache(0.15);
		const embedding1 = new Float32Array([1, 0, 0, 0]);
		// Very slightly different — cosine distance < 0.15
		const embedding2 = new Float32Array([0.99, 0.01, 0, 0]);

		cache.update(embedding1, [makeSearchResult()]);
		const result = cache.check(embedding2);

		expect(result.hit).toBe(true);
	});

	test("update replaces cached results", () => {
		const cache = new CosineCache(0.15);
		const embedding = new Float32Array([1, 0, 0, 0]);
		const results1 = [makeSearchResult({ text: "first" })];
		const results2 = [makeSearchResult({ text: "second" })];

		cache.update(embedding, results1);
		cache.update(embedding, results2);

		const result = cache.check(embedding);
		expect(result.hit).toBe(true);
		if (result.hit) {
			expect(result.results[0].text).toBe("second");
		}
	});

	test("tracks hit and miss counts", () => {
		const cache = new CosineCache(0.15);
		const emb = new Float32Array([1, 0, 0, 0]);

		cache.check(emb); // miss (no cached)
		cache.update(emb, []);
		cache.check(emb); // hit
		cache.check(emb); // hit
		cache.check(new Float32Array([0, 1, 0, 0])); // miss (different)

		expect(cache.hits).toBe(2);
		expect(cache.misses).toBe(2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// formatHydratedContext
// ═══════════════════════════════════════════════════════════════════════════

describe("formatHydratedContext", () => {
	test("returns null for empty results", () => {
		expect(formatHydratedContext([])).toBeNull();
	});

	test("formats single user result", () => {
		const results = [makeSearchResult({ text: "user question", role: "user", turn: 5 })];
		const formatted = formatHydratedContext(results)!;

		expect(formatted).toContain("<recalled-context now=");
		expect(formatted).toContain("</recalled-context>");
		expect(formatted).toContain('turn="5"');
		expect(formatted).toContain('role="user"');
		expect(formatted).toContain('band="live"');
		expect(formatted).toContain('age="');
		expect(formatted).toContain('timestamp="');
		expect(formatted).toContain("user question");
		expect(formatted).not.toContain("tool=");
	});

	test("formats tool result with tool name", () => {
		const results = [
			makeSearchResult({
				text: "file contents",
				role: "tool_result",
				turn: 3,
				tool_name: "read",
			}),
		];
		const formatted = formatHydratedContext(results)!;

		expect(formatted).toContain('tool="read"');
		expect(formatted).toContain('role="tool_result"');
		expect(formatted).toContain("file contents");
	});

	test("formats multiple results in order", () => {
		const results = [
			makeSearchResult({ text: "first", turn: 1, role: "user" }),
			makeSearchResult({ text: "second", turn: 5, role: "assistant" }),
			makeSearchResult({ text: "third", turn: 10, role: "tool_result", tool_name: "bash" }),
		];
		const formatted = formatHydratedContext(results)!;

		const firstIdx = formatted.indexOf("first");
		const secondIdx = formatted.indexOf("second");
		const thirdIdx = formatted.indexOf("third");

		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});

	test("wraps each result in entry tags", () => {
		const results = [
			makeSearchResult({ text: "content1", turn: 1 }),
			makeSearchResult({ text: "content2", turn: 2 }),
		];
		const formatted = formatHydratedContext(results)!;

		const entryCount = (formatted.match(/<entry /g) ?? []).length;
		const closeCount = (formatted.match(/<\/entry>/g) ?? []).length;
		expect(entryCount).toBe(2);
		expect(closeCount).toBe(2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Source provenance and session age
// ═══════════════════════════════════════════════════════════════════════════

describe("formatHydratedContext — source provenance", () => {
	test("adds source=tool:name for regular tool results", () => {
		const results = [makeSearchResult({ text: "grep output", role: "tool_result", tool_name: "grep", turn: 5 })];
		const formatted = formatHydratedContext(results)!;
		expect(formatted).toContain('source="tool:grep"');
	});

	test("adds source=mcp:serverName for MCP tool results", () => {
		const results = [
			makeSearchResult({
				text: "RNA results",
				role: "tool_result",
				tool_name: "mcp_rna_search_symbols",
				turn: 7,
			}),
		];
		const formatted = formatHydratedContext(results)!;
		expect(formatted).toContain('source="mcp:rna"');
	});

	test("adds source=role for non-tool results", () => {
		const results = [makeSearchResult({ text: "user said hello", role: "user", tool_name: null, turn: 1 })];
		const formatted = formatHydratedContext(results)!;
		expect(formatted).toContain('source="user"');
	});

	test("adds session=current when sessionId matches", () => {
		const results = [makeSearchResult({ text: "recent", session_id: "session-42", turn: 1 })];
		const formatted = formatHydratedContext(results, { currentSessionId: "session-42" })!;
		expect(formatted).toContain('session="current"');
	});

	test("adds session=other when sessionId differs", () => {
		const results = [makeSearchResult({ text: "old data", session_id: "session-old", turn: 1 })];
		const formatted = formatHydratedContext(results, { currentSessionId: "session-new" })!;
		expect(formatted).toContain('session="other"');
	});

	test("adds project hints and durable bands from explicit time/context options", () => {
		const now = Date.parse("2026-04-18T00:00:00.000Z");
		const timestamp = now - 10 * 24 * 60 * 60 * 1000;
		const results = [
			makeSearchResult({
				text: "older workflow guidance",
				timestamp,
				project_cwd: "/tmp/other-project",
			}),
		];
		const formatted = formatHydratedContext(results, {
			currentSessionId: "test-session",
			currentProjectCwd: "/tmp/current-project",
			now,
			recentWindowMs: 7 * 24 * 60 * 60 * 1000,
		})!;

		expect(formatted).toContain('band="durable"');
		expect(formatted).toContain('age="10d"');
		expect(formatted).toContain(`timestamp="${new Date(timestamp).toISOString()}"`);
		expect(formatted).toContain('session="current"');
		expect(formatted).toContain('project="other"');
	});

	test("escapes XML-sensitive text and attributes", () => {
		const results = [
			makeSearchResult({
				text: 'x < y & "quoted"',
				role: "tool_result",
				tool_name: "read<&>",
				turn: 9,
			}),
		];
		const formatted = formatHydratedContext(results)!;

		expect(formatted).toContain('tool="read&lt;&amp;&gt;"');
		expect(formatted).toContain('source="tool:read&lt;&amp;&gt;"');
		expect(formatted).toContain("x &lt; y &amp; &quot;quoted&quot;");
	});

	test("omits session attribute when no currentSessionId provided", () => {
		const results = [makeSearchResult({ text: "data", turn: 1 })];
		const formatted = formatHydratedContext(results)!;
		expect(formatted).not.toContain("session=");
	});

	test("all attributes present together", () => {
		const results = [
			makeSearchResult({
				text: "search results",
				role: "tool_result",
				tool_name: "mcp_memex_query",
				session_id: "sess-1",
				project_cwd: "/tmp/test-project",
				turn: 3,
			}),
		];
		const formatted = formatHydratedContext(results, {
			currentSessionId: "sess-1",
			currentProjectCwd: "/tmp/test-project",
		})!;

		expect(formatted).toContain('turn="3"');
		expect(formatted).toContain('role="tool_result"');
		expect(formatted).toContain('tool="mcp_memex_query"');
		expect(formatted).toContain('source="mcp:memex"');
		expect(formatted).toContain('session="current"');
		expect(formatted).toContain('project="current"');
	});
});
