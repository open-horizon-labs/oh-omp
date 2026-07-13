import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolResultStore } from "../../../src/context/recall/tool-result-store";
import { buildRecallRowKey, type RecallRow } from "../../../src/context/recall/types";

let store: ToolResultStore;
let dbPath: string;

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-store-"));
	dbPath = path.join(dir, "test.db");
	store = ToolResultStore.open(dbPath);
});

afterEach(() => {
	store.close();
	const dir = path.dirname(dbPath);
	fs.rmSync(dir, { recursive: true, force: true });
});

function makeEntry(overrides: {
	content: string;
	role?: RecallRow["role"];
	toolName?: string | null;
	sessionId?: string;
	projectCwd?: string;
	turnNumber?: number;
	paths?: string[];
	rowKey?: string;
}) {
	const role = overrides.role ?? "tool_result";
	const toolName = overrides.toolName ?? (role === "tool_result" ? "read" : null);
	const sessionId = overrides.sessionId ?? "session-1";
	const projectCwd = overrides.projectCwd ?? "/tmp/test-project";
	const turnNumber = overrides.turnNumber ?? 1;
	return {
		content: overrides.content,
		role,
		toolName,
		sessionId,
		projectCwd,
		turnNumber,
		paths: overrides.paths ?? [],
		rowKey:
			overrides.rowKey ??
			buildRecallRowKey({
				text: overrides.content,
				role,
				turn: turnNumber,
				tool_name: toolName,
				session_id: sessionId,
			}),
	};
}

describe("ToolResultStore", () => {
	test("migrates the legacy schema before creating indexes", () => {
		store.close();
		const dir = path.dirname(dbPath);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });

		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
CREATE TABLE results (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	content TEXT NOT NULL,
	tool_name TEXT NOT NULL,
	paths TEXT NOT NULL DEFAULT '',
	session_id TEXT NOT NULL,
	turn_number INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_results_session ON results(session_id);
CREATE INDEX idx_results_created ON results(created_at);
CREATE VIRTUAL TABLE results_fts USING fts5(content, tokenize='porter unicode61');
CREATE VIRTUAL TABLE results_trigram USING fts5(content, tokenize='trigram');
`);
		legacyDb.close();

		store = ToolResultStore.open(dbPath);
		store.indexSync(
			makeEntry({
				content: "LEGACY_SCHEMA_MIGRATION_PROBE",
				role: "tool_result",
				toolName: "bash",
				projectCwd: "/tmp/upgraded-project",
				turnNumber: 9,
			}),
		);

		const results = store.search("LEGACY_SCHEMA_MIGRATION_PROBE", {
			role: "tool_result",
			projectCwd: "/tmp/upgraded-project",
		});
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			role: "tool_result",
			toolName: "bash",
			projectCwd: "/tmp/upgraded-project",
			turnNumber: 9,
		});
	});

	test("insert and search finds exact match", () => {
		store.indexSync(
			makeEntry({
				content: "Error: ENOENT no such file or directory 'src/parser.ts'",
				toolName: "read",
				turnNumber: 5,
				paths: ["src/parser.ts"],
			}),
		);

		const results = store.search("ENOENT");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].toolName).toBe("read");
		expect(results[0].turnNumber).toBe(5);
		expect(results[0].paths).toContain("src/parser.ts");
		expect(results[0].role).toBe("tool_result");
	});

	test("porter stemming matches word variants", () => {
		store.indexSync(
			makeEntry({
				content: "The parser correctly handles nested expressions and parsing errors",
				toolName: "grep",
				turnNumber: 10,
				paths: ["src/parser.ts"],
			}),
		);

		const results = store.search("parsing");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].snippet).toBeTruthy();
	});

	test("trigram finds exact substrings", () => {
		store.indexSync(
			makeEntry({
				content: "Connection failed with error code E_TIMEOUT after 30000ms",
				toolName: "bash",
				turnNumber: 15,
			}),
		);

		const results = store.search("E_TIMEOUT");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].snippet).toContain("E_TIMEOUT");
	});

	test("session filter scopes results", () => {
		store.indexSync(
			makeEntry({
				content: "Found error in session one",
				toolName: "grep",
				sessionId: "session-1",
			}),
		);
		store.indexSync(
			makeEntry({
				content: "Found error in session two",
				toolName: "grep",
				sessionId: "session-2",
			}),
		);

		const all = store.search("error");
		expect(all.length).toBe(2);

		const filtered = store.search("error", { sessionId: "session-1" });
		expect(filtered.length).toBe(1);
		expect(filtered[0].sessionId).toBe("session-1");
	});

	test("role and project filters scope results", () => {
		store.indexSync(
			makeEntry({
				content: "user mentioned timeout in current project",
				role: "user",
				toolName: null,
				projectCwd: "/tmp/current-project",
			}),
		);
		store.indexSync(
			makeEntry({
				content: "assistant mentioned timeout elsewhere",
				role: "assistant",
				toolName: null,
				projectCwd: "/tmp/other-project",
			}),
		);

		const filtered = store.search("timeout", {
			role: "user",
			projectCwd: "/tmp/current-project",
		});
		expect(filtered.length).toBe(1);
		expect(filtered[0].role).toBe("user");
		expect(filtered[0].projectCwd).toBe("/tmp/current-project");
	});

	test("dedup between porter and trigram", () => {
		store.indexSync(
			makeEntry({
				content: "The function parseConfig reads configuration files",
				toolName: "read",
				turnNumber: 3,
				paths: ["src/config.ts"],
			}),
		);

		const results = store.search("parseConfig");
		expect(results.length).toBe(1);
	});

	test("cleanup removes old entries", () => {
		store.indexSync(
			makeEntry({
				content: "Old result that should be cleaned up",
				toolName: "read",
				sessionId: "session-old",
			}),
		);

		const deleted = store.cleanup(0);
		expect(deleted).toBe(1);

		const results = store.search("cleaned");
		expect(results.length).toBe(0);
	});

	test("empty query returns empty results", () => {
		store.indexSync(makeEntry({ content: "Some content here", toolName: "read" }));

		expect(store.search("")).toEqual([]);
		expect(store.search("   ")).toEqual([]);
	});

	test("snippet extraction returns context around match", () => {
		const longContent = `${"Line one of the file.\n".repeat(20)}CRITICAL_ERROR: stack overflow detected\n${"Line after error.\n".repeat(20)}`;

		store.indexSync(
			makeEntry({
				content: longContent,
				toolName: "read",
				turnNumber: 42,
				paths: ["src/main.ts"],
			}),
		);

		const results = store.search("CRITICAL_ERROR");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].snippet).toContain("CRITICAL_ERROR");
		expect(results[0].snippet.length).toBeLessThan(longContent.length);
	});

	test("multiple results sorted by relevance", () => {
		store.indexSync(
			makeEntry({
				content: "Minor mention of timeout in passing",
				toolName: "grep",
				turnNumber: 1,
			}),
		);
		store.indexSync(
			makeEntry({
				content: "TIMEOUT TIMEOUT TIMEOUT: connection timeout error timeout exceeded",
				toolName: "bash",
				turnNumber: 2,
			}),
		);

		const results = store.search("timeout");
		expect(results.length).toBe(2);
		expect(results[0].turnNumber).toBe(2);
	});

	test("limit controls max results", () => {
		for (let i = 0; i < 20; i++) {
			store.indexSync(
				makeEntry({
					content: `Result number ${i} with searchable content`,
					toolName: "read",
					turnNumber: i,
				}),
			);
		}

		const results = store.search("searchable", { limit: 5 });
		expect(results.length).toBe(5);
	});

	test("empty content is not indexed", () => {
		store.indexSync(makeEntry({ content: "", toolName: "read" }));
		store.indexSync(makeEntry({ content: "   ", toolName: "read", turnNumber: 2 }));

		const results = store.search("read");
		expect(results.length).toBe(0);
	});
});
