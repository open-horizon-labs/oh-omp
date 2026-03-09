import { describe, expect, test } from "bun:test";
import type { AssistantMessage, DeveloperMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	CosineCache,
	EMBEDDING_DIM,
	extractHotWindowText,
	formatHydratedContext,
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

function toolResultMsg(text: string, toolCallId = "tc-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: nextTimestamp(),
	};
}

function developerMsg(text: string): DeveloperMessage {
	return {
		role: "developer",
		content: text,
		timestamp: nextTimestamp(),
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

// ═══════════════════════════════════════════════════════════════════════════
// extractHotWindowText
// ═══════════════════════════════════════════════════════════════════════════

describe("extractHotWindowText", () => {
	test("returns null for empty messages", () => {
		expect(extractHotWindowText([])).toBeNull();
	});

	test("extracts text from a single user message", () => {
		const messages = [userMsg("hello world")];
		const result = extractHotWindowText(messages, 3);
		expect(result).toBe("hello world");
	});

	test("extracts user + assistant text", () => {
		const messages = [userMsg("fix the bug"), assistantMsg("I will look at the code")];
		const result = extractHotWindowText(messages, 3);
		expect(result).toContain("fix the bug");
		expect(result).toContain("I will look at the code");
	});

	test("includes tool result text", () => {
		const messages = [userMsg("read the file"), assistantMsg("reading file"), toolResultMsg("file contents here")];
		const result = extractHotWindowText(messages, 3);
		expect(result).toContain("file contents here");
	});

	test("respects window turn limit", () => {
		const messages = [
			userMsg("old message 1"),
			assistantMsg("old response 1"),
			userMsg("old message 2"),
			assistantMsg("old response 2"),
			userMsg("recent message"),
			assistantMsg("recent response"),
		];
		// Only 1 turn window — should only include the last user message and its response
		const result = extractHotWindowText(messages, 1);
		expect(result).toContain("recent message");
		expect(result).toContain("recent response");
		expect(result).not.toContain("old message 1");
	});

	test("skips developer messages", () => {
		const messages = [developerMsg("system instruction"), userMsg("actual query")];
		const result = extractHotWindowText(messages, 3);
		expect(result).toBe("actual query");
		expect(result).not.toContain("system instruction");
	});

	test("truncates long tool results to 2000 chars", () => {
		const longText = "x".repeat(5000);
		const messages = [userMsg("q"), assistantMsg("a"), toolResultMsg(longText)];
		const result = extractHotWindowText(messages, 3);
		// Should contain truncated tool result (2000 chars) not the full 5000
		expect(result!.length).toBeLessThan(5000);
	});

	test("returns null when all messages are developer role", () => {
		const messages = [developerMsg("instruction 1"), developerMsg("instruction 2")];
		expect(extractHotWindowText(messages)).toBeNull();
	});

	test("handles user message with TextContent array", () => {
		const msg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "from text block" }],
			timestamp: nextTimestamp(),
		};
		const result = extractHotWindowText([msg], 3);
		expect(result).toBe("from text block");
	});

	test("handles assistant message with thinking block", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning about the problem" },
				{ type: "text", text: "here is my answer" },
			],
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
		const result = extractHotWindowText([userMsg("q"), msg], 3);
		expect(result).toContain("reasoning about the problem");
		expect(result).toContain("here is my answer");
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

		expect(formatted).toContain("<recalled-context>");
		expect(formatted).toContain("</recalled-context>");
		expect(formatted).toContain('turn="5"');
		expect(formatted).toContain('role="user"');
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
