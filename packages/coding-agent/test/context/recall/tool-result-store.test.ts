import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolResultStore } from "../../../src/context/recall/tool-result-store";

let store: ToolResultStore;
let dbPath: string;

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-store-"));
	dbPath = path.join(dir, "test.db");
	store = ToolResultStore.open(dbPath);
});

afterEach(() => {
	store.close();
	// Clean up temp files
	const dir = path.dirname(dbPath);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("ToolResultStore", () => {
	test("insert and search finds exact match", () => {
		store.indexSync({
			content: "Error: ENOENT no such file or directory 'src/parser.ts'",
			toolName: "read",
			sessionId: "session-1",
			turnNumber: 5,
			paths: ["src/parser.ts"],
		});

		const results = store.search("ENOENT");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].toolName).toBe("read");
		expect(results[0].turnNumber).toBe(5);
		expect(results[0].paths).toContain("src/parser.ts");
	});

	test("porter stemming matches word variants", () => {
		store.indexSync({
			content: "The parser correctly handles nested expressions and parsing errors",
			toolName: "grep",
			sessionId: "session-1",
			turnNumber: 10,
			paths: ["src/parser.ts"],
		});

		// "parsing" should match "parser" and "parsing" via porter stemming
		const results = store.search("parsing");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].snippet).toBeTruthy();
	});

	test("trigram finds exact substrings", () => {
		store.indexSync({
			content: "Connection failed with error code E_TIMEOUT after 30000ms",
			toolName: "bash",
			sessionId: "session-1",
			turnNumber: 15,
			paths: [],
		});

		const results = store.search("E_TIMEOUT");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].snippet).toContain("E_TIMEOUT");
	});

	test("session filter scopes results", () => {
		store.indexSync({
			content: "Found error in session one",
			toolName: "grep",
			sessionId: "session-1",
			turnNumber: 1,
			paths: [],
		});
		store.indexSync({
			content: "Found error in session two",
			toolName: "grep",
			sessionId: "session-2",
			turnNumber: 1,
			paths: [],
		});

		const all = store.search("error");
		expect(all.length).toBe(2);

		const filtered = store.search("error", { sessionId: "session-1" });
		expect(filtered.length).toBe(1);
		expect(filtered[0].sessionId).toBe("session-1");
	});

	test("dedup between porter and trigram", () => {
		store.indexSync({
			content: "The function parseConfig reads configuration files",
			toolName: "read",
			sessionId: "session-1",
			turnNumber: 3,
			paths: ["src/config.ts"],
		});

		// "parseConfig" should match both porter (individual tokens) and trigram (substring)
		const results = store.search("parseConfig");
		// Should be exactly 1 result, not duplicated
		expect(results.length).toBe(1);
	});

	test("cleanup removes old entries", () => {
		store.indexSync({
			content: "Old result that should be cleaned up",
			toolName: "read",
			sessionId: "session-old",
			turnNumber: 1,
			paths: [],
		});

		// Cleanup with maxAge of 0ms — everything is "old"
		const deleted = store.cleanup(0);
		expect(deleted).toBe(1);

		const results = store.search("cleaned");
		expect(results.length).toBe(0);
	});

	test("empty query returns empty results", () => {
		store.indexSync({
			content: "Some content here",
			toolName: "read",
			sessionId: "session-1",
			turnNumber: 1,
			paths: [],
		});

		expect(store.search("")).toEqual([]);
		expect(store.search("   ")).toEqual([]);
	});

	test("snippet extraction returns context around match", () => {
		const longContent = `${"Line one of the file.\n".repeat(20)}CRITICAL_ERROR: stack overflow detected\n${"Line after error.\n".repeat(20)}`;

		store.indexSync({
			content: longContent,
			toolName: "read",
			sessionId: "session-1",
			turnNumber: 42,
			paths: ["src/main.ts"],
		});

		const results = store.search("CRITICAL_ERROR");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].snippet).toContain("CRITICAL_ERROR");
		// Snippet should be shorter than the full content
		expect(results[0].snippet.length).toBeLessThan(longContent.length);
	});

	test("multiple results sorted by relevance", () => {
		store.indexSync({
			content: "Minor mention of timeout in passing",
			toolName: "grep",
			sessionId: "session-1",
			turnNumber: 1,
			paths: [],
		});
		store.indexSync({
			content: "TIMEOUT TIMEOUT TIMEOUT: connection timeout error timeout exceeded",
			toolName: "bash",
			sessionId: "session-1",
			turnNumber: 2,
			paths: [],
		});

		const results = store.search("timeout");
		expect(results.length).toBe(2);
		// Higher relevance result (more occurrences) should come first
		expect(results[0].turnNumber).toBe(2);
	});

	test("limit controls max results", () => {
		for (let i = 0; i < 20; i++) {
			store.indexSync({
				content: `Result number ${i} with searchable content`,
				toolName: "read",
				sessionId: "session-1",
				turnNumber: i,
				paths: [],
			});
		}

		const results = store.search("searchable", { limit: 5 });
		expect(results.length).toBe(5);
	});

	test("empty content is not indexed", () => {
		store.indexSync({
			content: "",
			toolName: "read",
			sessionId: "session-1",
			turnNumber: 1,
			paths: [],
		});
		store.indexSync({
			content: "   ",
			toolName: "read",
			sessionId: "session-1",
			turnNumber: 2,
			paths: [],
		});

		const results = store.search("read");
		expect(results.length).toBe(0);
	});
});
