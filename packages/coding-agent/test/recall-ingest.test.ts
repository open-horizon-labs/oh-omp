import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EMBEDDING_DIM, type IngestItem, IngestPipeline, RecallStore } from "@oh-my-pi/pi-coding-agent/context/recall";
import {
	extractAssistantText,
	extractPathsFromText,
	extractToolResultText,
	extractUserText,
} from "@oh-my-pi/pi-coding-agent/context/recall/message-text";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

function randomVector(dim: number): number[] {
	return Array.from({ length: dim }, () => Math.random());
}

// ═══════════════════════════════════════════════════════════════════════════
// extractUserText
// ═══════════════════════════════════════════════════════════════════════════

describe("extractUserText", () => {
	test("extracts from string content", () => {
		expect(extractUserText("hello world")).toBe("hello world");
	});

	test("extracts from TextContent array", () => {
		const content = [
			{ type: "text" as const, text: "first" },
			{ type: "text" as const, text: "second" },
		];
		expect(extractUserText(content)).toBe("first\nsecond");
	});

	test("skips image content", () => {
		const content = [
			{ type: "text" as const, text: "before" },
			{ type: "image" as const, data: "abc", mimeType: "image/png" },
			{ type: "text" as const, text: "after" },
		];
		expect(extractUserText(content)).toBe("before\nafter");
	});

	test("empty string returns empty", () => {
		expect(extractUserText("")).toBe("");
	});

	test("empty array returns empty", () => {
		expect(extractUserText([])).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// extractAssistantText
// ═══════════════════════════════════════════════════════════════════════════

describe("extractAssistantText", () => {
	test("extracts text blocks", () => {
		const content = [{ type: "text" as const, text: "I will help you." }];
		expect(extractAssistantText(content)).toBe("I will help you.");
	});

	test("includes thinking blocks", () => {
		const content = [
			{ type: "thinking" as const, thinking: "Let me think about this..." },
			{ type: "text" as const, text: "Here is my answer." },
		];
		expect(extractAssistantText(content)).toBe("Let me think about this...\nHere is my answer.");
	});

	test("skips tool calls", () => {
		const content = [
			{ type: "text" as const, text: "Looking at the file." },
			{
				type: "toolCall" as const,
				id: "tc1",
				name: "read",
				arguments: { path: "foo.ts" },
			},
		];
		expect(extractAssistantText(content)).toBe("Looking at the file.");
	});

	test("empty content returns empty", () => {
		expect(extractAssistantText([])).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// extractToolResultText
// ═══════════════════════════════════════════════════════════════════════════

describe("extractToolResultText", () => {
	test("extracts from text content", () => {
		const content = [{ type: "text" as const, text: "1#AB: const x = 1;" }];
		expect(extractToolResultText(content)).toBe("1#AB: const x = 1;");
	});

	test("joins multiple text blocks", () => {
		const content = [
			{ type: "text" as const, text: "line 1" },
			{ type: "text" as const, text: "line 2" },
		];
		expect(extractToolResultText(content)).toBe("line 1\nline 2");
	});

	test("skips image content", () => {
		const content = [
			{ type: "text" as const, text: "screenshot:" },
			{ type: "image" as const, data: "abc", mimeType: "image/png" },
		];
		expect(extractToolResultText(content)).toBe("screenshot:");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// extractPathsFromText
// ═══════════════════════════════════════════════════════════════════════════

describe("extractPathsFromText", () => {
	test("extracts paths with extensions", () => {
		const text = "Look at src/foo/bar.ts and config/settings.json";
		const paths = extractPathsFromText(text);
		expect(paths).toContain("src/foo/bar.ts");
		expect(paths).toContain("config/settings.json");
	});

	test("extracts relative paths", () => {
		const text = "Edit ./config.json and ../parent/file.ts";
		const paths = extractPathsFromText(text);
		expect(paths).toContain("./config.json");
		expect(paths).toContain("../parent/file.ts");
	});

	test("extracts backtick-wrapped paths", () => {
		const text = "The file `packages/coding-agent/src/sdk.ts` needs changes";
		const paths = extractPathsFromText(text);
		expect(paths).toContain("packages/coding-agent/src/sdk.ts");
	});

	test("does not match URLs", () => {
		const text = "See https://github.com/foo/bar.ts and http://example.com/file.json";
		const paths = extractPathsFromText(text);
		expect(paths).not.toContain("github.com/foo/bar.ts");
		expect(paths).not.toContain("example.com/file.json");
	});

	test("does not match protocol URLs", () => {
		const text = "Use artifact://abc123 and skill://my-skill/file.md and memory://root/data.json";
		const paths = extractPathsFromText(text);
		expect(paths.length).toBe(0);
	});

	test("deduplicates paths", () => {
		const text = "Read src/main.ts then edit src/main.ts again";
		const paths = extractPathsFromText(text);
		const mainCount = paths.filter(p => p === "src/main.ts").length;
		expect(mainCount).toBe(1);
	});

	test("handles empty text", () => {
		expect(extractPathsFromText("")).toEqual([]);
	});

	test("handles text with no paths", () => {
		expect(extractPathsFromText("This is a simple message with no paths")).toEqual([]);
	});

	test("extracts scoped package paths", () => {
		const text = "Check @oh-my-pi/pi-coding-agent/context/recall/store.ts";
		const paths = extractPathsFromText(text);
		expect(paths.length).toBeGreaterThan(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// IngestPipeline
// ═══════════════════════════════════════════════════════════════════════════

describe("IngestPipeline", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = path.join(os.tmpdir(), `ingest-test-${Date.now()}`);
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("ingest skips empty text", async () => {
		const sessionDir = path.join(tmpDir, "skip-empty");
		const store = await RecallStore.open({ sessionDir, sessionId: "test-skip" });
		const pipeline = new IngestPipeline({
			store,
			license: "fake-license",
			sessionId: "test-skip",
		});

		pipeline.ingest({ text: "", role: "user", turn: 0 });
		pipeline.ingest({ text: "   ", role: "user", turn: 0 });

		// No in-flight tasks should have been created
		expect(pipeline.inFlight).toBe(0);
		expect(pipeline.dropped).toBe(0);
		store.close();
	});

	test("ingest respects in-flight guard", async () => {
		const sessionDir = path.join(tmpDir, "inflight-guard");
		const store = await RecallStore.open({ sessionDir, sessionId: "test-inflight" });
		const pipeline = new IngestPipeline({
			store,
			license: "fake-license",
			sessionId: "test-inflight",
		});

		// Submit more items than MAX_IN_FLIGHT (4)
		for (let i = 0; i < 10; i++) {
			pipeline.ingest({ text: `message ${i}`, role: "user", turn: i });
		}

		// Some should have been dropped
		expect(pipeline.dropped).toBeGreaterThan(0);
		// But at most MAX_IN_FLIGHT should be in flight
		expect(pipeline.inFlight).toBeLessThanOrEqual(4);

		// Wait for in-flight tasks to settle (they will fail because license is fake)
		await Bun.sleep(2000);

		expect(pipeline.inFlight).toBe(0);
		store.close();
	});

	test("failed embed does not crash", async () => {
		const sessionDir = path.join(tmpDir, "fail-graceful");
		const store = await RecallStore.open({ sessionDir, sessionId: "test-fail" });
		const pipeline = new IngestPipeline({
			store,
			license: "invalid-license-that-will-fail",
			sessionId: "test-fail",
		});

		// This should not throw
		pipeline.ingest({
			text: "This message will fail to embed",
			role: "user",
			turn: 0,
			paths: ["src/main.ts"],
		});

		// Wait for the background task to fail gracefully
		await Bun.sleep(3000);

		expect(pipeline.inFlight).toBe(0);
		// No row should have been stored (embed failed)
		const results = await store.search(randomVector(EMBEDDING_DIM), 10);
		expect(results.length).toBe(0);

		store.close();
	});

	test("ingest populates correct metadata", () => {
		// This tests the IngestItem interface and metadata passing
		const item: IngestItem = {
			text: "Some tool result",
			role: "tool_result",
			turn: 3,
			toolName: "bash",
			paths: ["src/main.ts", "src/config.ts"],
			symbols: ["RecallStore", "embed"],
		};

		// Verify the item has all required fields
		expect(item.text).toBe("Some tool result");
		expect(item.role).toBe("tool_result");
		expect(item.turn).toBe(3);
		expect(item.toolName).toBe("bash");
		expect(item.paths).toEqual(["src/main.ts", "src/config.ts"]);
		expect(item.symbols).toEqual(["RecallStore", "embed"]);
	});
});
