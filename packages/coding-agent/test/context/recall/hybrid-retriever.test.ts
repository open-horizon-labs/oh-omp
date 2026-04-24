import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HybridRetriever } from "../../../src/context/recall/hybrid-retriever";
import { RecallStore } from "../../../src/context/recall/store";
import { ToolResultStore } from "../../../src/context/recall/tool-result-store";
import { buildRecallRowKey, EMBEDDING_DIM, type RecallRow } from "../../../src/context/recall/types";

let tmpDir: string;
let testCounter = 0;

beforeAll(async () => {
	tmpDir = path.join(os.tmpdir(), `hybrid-retriever-test-${Date.now()}`);
	await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeVector(weight: number): number[] {
	const vector = new Array<number>(EMBEDDING_DIM).fill(0);
	vector[0] = weight;
	return vector;
}

function makeRow(overrides: Partial<RecallRow> & { text: string; turn: number }): RecallRow {
	const { text, turn, ...rest } = overrides;
	return {
		vector: makeVector(0.5),
		text,
		role: rest.role ?? "tool_result",
		turn,
		tool_name: rest.tool_name ?? "read",
		paths: rest.paths ?? null,
		symbols: rest.symbols ?? null,
		timestamp: rest.timestamp ?? Date.now(),
		project_cwd: rest.project_cwd ?? "/tmp/current-project",
		session_id: rest.session_id ?? "test-session",
		...rest,
	};
}

async function createStores(
	rows: RecallRow[],
): Promise<{ recallStore: RecallStore; toolResultStore: ToolResultStore }> {
	testCounter++;
	const dir = path.join(tmpDir, `case-${testCounter}`);
	await fs.mkdir(dir, { recursive: true });
	const recallStore = await RecallStore.open({ agentDir: dir, sessionId: `session-${testCounter}` });
	await recallStore.insert(rows);
	const toolResultStore = ToolResultStore.open(path.join(dir, "tool-results.db"));
	for (const row of rows) {
		toolResultStore.indexSync({
			content: row.text,
			role: row.role,
			toolName: row.tool_name,
			sessionId: row.session_id,
			projectCwd: row.project_cwd,
			turnNumber: row.turn,
			paths: row.paths ? (JSON.parse(row.paths) as string[]) : [],
			rowKey: buildRecallRowKey(row),
		});
	}
	return { recallStore, toolResultStore };
}

describe("HybridRetriever", () => {
	test("promotes a lexical-only exact match into the fused result set", async () => {
		const rows = [
			makeRow({ text: "general auth migration planning", turn: 1, vector: makeVector(0.99) }),
			makeRow({ text: "general auth follow-up", turn: 2, vector: makeVector(0.98) }),
			makeRow({ text: "general auth cleanup", turn: 3, vector: makeVector(0.97) }),
			makeRow({
				text: "Error: ENOENT while reading src/parser.ts",
				turn: 4,
				vector: makeVector(0.7),
				paths: JSON.stringify(["src/parser.ts"]),
			}),
		];
		const { recallStore, toolResultStore } = await createStores(rows);
		const retriever = new HybridRetriever({
			store: recallStore,
			toolResultStore,
			sessionId: "test-session",
			projectCwd: "/tmp/current-project",
		});

		const response = await retriever.search({
			query: "ENOENT src/parser.ts",
			queryVector: makeVector(1),
			limit: 1,
			mode: "hybrid",
			project: "current",
		});

		expect(response.results).toHaveLength(1);
		expect(response.trace.keywordCandidates).toBeGreaterThan(0);
		expect(response.trace.resolvedKeywordCandidates).toBeGreaterThan(0);

		toolResultStore.close();
		recallStore.close();
	});

	test("respects role and current-project filters across semantic and lexical candidates", async () => {
		const rows = [
			makeRow({
				text: "timeout mentioned by current project user",
				turn: 1,
				role: "user",
				tool_name: null,
				vector: makeVector(1),
				project_cwd: "/tmp/current-project",
			}),
			makeRow({
				text: "timeout mentioned by assistant in other project",
				turn: 2,
				role: "assistant",
				tool_name: null,
				vector: makeVector(0.99),
				project_cwd: "/tmp/other-project",
			}),
		];
		const { recallStore, toolResultStore } = await createStores(rows);
		const retriever = new HybridRetriever({
			store: recallStore,
			toolResultStore,
			sessionId: "test-session",
			projectCwd: "/tmp/current-project",
		});

		const response = await retriever.search({
			query: "timeout",
			queryVector: makeVector(1),
			limit: 5,
			mode: "hybrid",
			project: "current",
			role: "user",
			filter: "role = 'user' AND project_cwd = '/tmp/current-project'",
		});

		expect(response.results).toHaveLength(1);
		expect(response.results[0].role).toBe("user");
		expect(response.results[0].project_cwd).toBe("/tmp/current-project");

		toolResultStore.close();
		recallStore.close();
	});
	test("applies current-project scoping to semantic search without requiring a manual Lance filter", async () => {
		const rows = [
			makeRow({
				text: "timeout in current project logs",
				turn: 1,
				vector: makeVector(0.95),
				project_cwd: "/tmp/current-project",
			}),
			makeRow({
				text: "timeout in other project logs",
				turn: 2,
				vector: makeVector(1),
				project_cwd: "/tmp/other-project",
			}),
		];
		const { recallStore, toolResultStore } = await createStores(rows);
		const retriever = new HybridRetriever({
			store: recallStore,
			toolResultStore,
			sessionId: "test-session",
			projectCwd: "/tmp/current-project",
		});

		const response = await retriever.search({
			query: "timeout logs",
			queryVector: makeVector(1),
			limit: 5,
			mode: "hybrid",
			project: "current",
		});

		expect(response.results).toHaveLength(1);
		expect(response.results[0].project_cwd).toBe("/tmp/current-project");
		expect(response.results[0].text).toContain("current project");

		toolResultStore.close();
		recallStore.close();
	});

	test("prefers fresher rows when relevance signals are otherwise equivalent", async () => {
		const now = Date.now();
		const rows = [
			makeRow({
				text: "deployment status snapshot",
				turn: 1,
				vector: makeVector(1),
				timestamp: now - 10 * 24 * 60 * 60 * 1000,
			}),
			makeRow({
				text: "deployment status snapshot",
				turn: 2,
				vector: makeVector(1),
				timestamp: now - 5 * 60 * 1000,
			}),
		];
		const { recallStore, toolResultStore } = await createStores(rows);
		const retriever = new HybridRetriever({
			store: recallStore,
			toolResultStore,
			sessionId: "test-session",
			projectCwd: "/tmp/current-project",
		});

		const response = await retriever.search({
			query: "deployment status snapshot",
			queryVector: makeVector(1),
			limit: 2,
			mode: "hybrid",
			project: "current",
		});

		expect(response.results).toHaveLength(2);
		expect(response.results[0].turn).toBe(2);
		expect(response.results[1].turn).toBe(1);

		toolResultStore.close();
		recallStore.close();
	});
});
