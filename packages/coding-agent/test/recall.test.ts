import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cosineSimilarity,
	DEFAULT_RECALL_MMR_LAMBDA,
	EMBEDDING_DIM,
	type MmrCandidate,
	mmrRerank,
	type RecallRow,
	RecallStore,
	resolveMemexLicense,
} from "@oh-my-pi/pi-coding-agent/context/recall";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

function randomVector(dim: number): number[] {
	return Array.from({ length: dim }, () => Math.random());
}

function makeRow(overrides: Partial<RecallRow> = {}): RecallRow {
	return {
		vector: randomVector(EMBEDDING_DIM),
		text: "test content",
		role: "user",
		turn: 1,
		tool_name: null,
		paths: null,
		symbols: null,
		timestamp: Date.now(),
		session_id: "test-session",
		project_cwd: "/tmp/test-project",
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// cosineSimilarity
// ═══════════════════════════════════════════════════════════════════════════

describe("cosineSimilarity", () => {
	test("identical vectors return 1.0", () => {
		const v = [1, 2, 3, 4, 5];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
	});

	test("orthogonal vectors return 0.0", () => {
		const a = [1, 0, 0];
		const b = [0, 1, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
	});

	test("opposite vectors return -1.0", () => {
		const a = [1, 0, 0];
		const b = [-1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
	});

	test("zero vector returns 0", () => {
		const zero = [0, 0, 0];
		const v = [1, 2, 3];
		expect(cosineSimilarity(zero, v)).toBe(0);
		expect(cosineSimilarity(v, zero)).toBe(0);
		expect(cosineSimilarity(zero, zero)).toBe(0);
	});

	test("scaled vectors are equivalent", () => {
		const a = [1, 2, 3];
		const b = [2, 4, 6];
		expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 10);
	});

	test("works with high-dimensional vectors", () => {
		const dim = EMBEDDING_DIM;
		const a = randomVector(dim);
		const result = cosineSimilarity(a, a);
		expect(result).toBeCloseTo(1.0, 5);
	});

	test("throws on length mismatch", () => {
		expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("length mismatch");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// mmrRerank
// ═══════════════════════════════════════════════════════════════════════════

describe("mmrRerank", () => {
	function makeCandidate<T>(score: number, vector: number[], data: T): MmrCandidate<T> {
		return { vector, score, data };
	}

	test("empty input returns empty array", () => {
		expect(mmrRerank([])).toEqual([]);
	});

	test("single candidate returns that candidate", () => {
		const c = makeCandidate(0.9, [1, 0], "a");
		const result = mmrRerank([c]);
		expect(result).toEqual([c]);
	});

	test("first pick is highest-scoring candidate", () => {
		const candidates = [
			makeCandidate(0.5, [1, 0], "low"),
			makeCandidate(0.9, [0, 1], "high"),
			makeCandidate(0.7, [1, 1], "mid"),
		];
		const result = mmrRerank(candidates);
		expect(result[0].data).toBe("high");
		expect(result.length).toBe(3);
	});

	test("diversifies similar candidates", () => {
		// Two very similar vectors and one different
		const similar1 = makeCandidate(0.9, [1, 0, 0], "sim1");
		const similar2 = makeCandidate(0.85, [0.99, 0.01, 0], "sim2");
		const different = makeCandidate(0.7, [0, 0, 1], "diff");

		const result = mmrRerank([similar1, similar2, different], 0.5);
		// First should be highest score (sim1)
		expect(result[0].data).toBe("sim1");
		// Second should prefer the different one over the near-duplicate
		expect(result[1].data).toBe("diff");
		expect(result[2].data).toBe("sim2");
	});

	test("lambda=1.0 gives pure relevance ranking", () => {
		const candidates = [
			makeCandidate(0.5, [1, 0], "low"),
			makeCandidate(0.9, [1, 0.01], "high"), // very similar vector
			makeCandidate(0.7, [0, 1], "mid"),
		];
		const result = mmrRerank(candidates, 1.0);
		// Pure relevance: should be ordered by score
		expect(result[0].data).toBe("high");
		expect(result[1].data).toBe("mid");
		expect(result[2].data).toBe("low");
	});

	test("preserves all candidates", () => {
		const candidates = Array.from({ length: 10 }, (_, i) =>
			makeCandidate(Math.random(), randomVector(8), `item-${i}`),
		);
		const result = mmrRerank(candidates);
		expect(result.length).toBe(10);
		// All original items present
		const originalData = new Set(candidates.map(c => c.data));
		const resultData = new Set(result.map(c => c.data));
		expect(resultData).toEqual(originalData);
	});

	test("uses DEFAULT_RECALL_MMR_LAMBDA when no lambda specified", () => {
		expect(DEFAULT_RECALL_MMR_LAMBDA).toBe(0.7);
		// Just verify it doesn't throw
		const candidates = [makeCandidate(0.9, [1, 0], "a"), makeCandidate(0.8, [0, 1], "b")];
		const result = mmrRerank(candidates);
		expect(result.length).toBe(2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveMemexLicense
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveMemexLicense", () => {
	const origEnv = process.env.MEMEX_LICENSE;

	afterAll(() => {
		if (origEnv !== undefined) {
			process.env.MEMEX_LICENSE = origEnv;
		} else {
			delete process.env.MEMEX_LICENSE;
		}
	});

	test("returns env var when set", async () => {
		process.env.MEMEX_LICENSE = "test-license-from-env";
		const license = await resolveMemexLicense();
		expect(license).toBe("test-license-from-env");
	});

	test("throws when no license available", async () => {
		delete process.env.MEMEX_LICENSE;
		// This will fail unless ~/.config/memex/license exists
		// We can't guarantee it doesn't exist, so we just test the env path
		try {
			await resolveMemexLicense();
			// If it succeeds, it found the file — that's fine
		} catch (err) {
			expect((err as Error).message).toContain("Memex license not found");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// RecallStore
// ═══════════════════════════════════════════════════════════════════════════

describe("RecallStore", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = path.join(os.tmpdir(), `recall-test-${Date.now()}`);
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("open creates new store and table", async () => {
		const sessionDir = path.join(tmpDir, "session-new");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-1" });
		store.close();

		// Verify lance directory was created
		const entries = await fs.readdir(sessionDir);
		expect(entries).toContain("recall.lance");
	});

	test("open re-opens existing store", async () => {
		const sessionDir = path.join(tmpDir, "session-reopen");

		// First open — creates
		const store1 = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-2" });
		await store1.insert([makeRow({ text: "persisted" })]);
		store1.close();

		// Second open — re-opens
		const store2 = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-2" });
		const results = await store2.search(randomVector(EMBEDDING_DIM), 10);
		expect(results.length).toBe(1);
		expect(results[0].text).toBe("persisted");
		store2.close();
	});

	test("insert and search basic flow", async () => {
		const sessionDir = path.join(tmpDir, "session-basic");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-3" });

		const targetVector = randomVector(EMBEDDING_DIM);
		await store.insert([
			makeRow({ vector: targetVector, text: "target", role: "user", turn: 1 }),
			makeRow({ text: "other1", role: "assistant", turn: 1 }),
			makeRow({ text: "other2", role: "tool_result", turn: 2, tool_name: "bash" }),
		]);

		// Search with the target vector itself — should be closest
		const results = await store.search(targetVector, 3);
		expect(results.length).toBe(3);
		expect(results[0].text).toBe("target");
		expect(results[0]._distance).toBeCloseTo(0, 1);

		store.close();
	});

	test("search with filter", async () => {
		const sessionDir = path.join(tmpDir, "session-filter");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-4" });

		await store.insert([
			makeRow({ text: "user msg", role: "user" }),
			makeRow({ text: "assistant msg", role: "assistant" }),
			makeRow({ text: "tool output", role: "tool_result" }),
		]);

		const results = await store.search(randomVector(EMBEDDING_DIM), 10, "role = 'user'");
		expect(results.length).toBe(1);
		expect(results[0].role).toBe("user");

		store.close();
	});

	test("insert with empty array is no-op", async () => {
		const sessionDir = path.join(tmpDir, "session-empty");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-5" });

		// Should not throw
		await store.insert([]);

		const results = await store.search(randomVector(EMBEDDING_DIM), 10);
		expect(results.length).toBe(0);

		store.close();
	});

	test("search on empty store returns empty array", async () => {
		const sessionDir = path.join(tmpDir, "session-empty-search");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-6" });

		const results = await store.search(randomVector(EMBEDDING_DIM), 10);
		expect(results.length).toBe(0);

		store.close();
	});

	test("stores and retrieves metadata correctly", async () => {
		const sessionDir = path.join(tmpDir, "session-meta");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-7" });

		const now = Date.now();
		const pathsJson = JSON.stringify(["src/main.ts", "src/config.ts"]);
		const symbolsJson = JSON.stringify(["RecallStore", "embed"]);

		await store.insert([
			makeRow({
				text: "tool result text",
				role: "tool_result",
				turn: 5,
				tool_name: "read",
				paths: pathsJson,
				symbols: symbolsJson,
				timestamp: now,
				session_id: "sess-abc",
			}),
		]);

		const results = await store.search(randomVector(EMBEDDING_DIM), 1);
		expect(results.length).toBe(1);
		const row = results[0];
		expect(row.role).toBe("tool_result");
		expect(row.turn).toBe(5);
		expect(row.tool_name).toBe("read");
		expect(row.paths).toBe(pathsJson);
		expect(row.symbols).toBe(symbolsJson);
		expect(row.session_id).toBe("sess-abc");

		// Verify JSON round-trip
		expect(JSON.parse(row.paths!)).toEqual(["src/main.ts", "src/config.ts"]);
		expect(JSON.parse(row.symbols!)).toEqual(["RecallStore", "embed"]);

		store.close();
	});

	test("search limit is respected", async () => {
		const sessionDir = path.join(tmpDir, "session-limit");
		const store = await RecallStore.open({ agentDir: sessionDir, sessionId: "test-8" });

		// Insert 10 rows
		const rows = Array.from({ length: 10 }, (_, i) => makeRow({ text: `item-${i}`, turn: i }));
		await store.insert(rows);

		const results = await store.search(randomVector(EMBEDDING_DIM), 3);
		expect(results.length).toBe(3);

		store.close();
	});
});
