import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecallStore } from "@oh-my-pi/pi-coding-agent/context/recall/store";
import { EMBEDDING_DIM, type RecallRow } from "@oh-my-pi/pi-coding-agent/context/recall/types";

function makeRow(turn: number, sessionId: string): RecallRow {
	return {
		vector: new Array<number>(EMBEDDING_DIM).fill(0),
		text: `row at turn ${turn}`,
		role: "user",
		turn,
		tool_name: null,
		paths: null,
		symbols: null,
		project_cwd: "/proj",
		timestamp: Date.now(),
		session_id: sessionId,
	};
}

describe("RecallStore.maxTurn", () => {
	let agentDir: string;
	let store: RecallStore;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "recallstore-"));
		store = await RecallStore.open({ agentDir, sessionId: "sess-a" });
	});

	afterEach(async () => {
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("returns null for a session with no rows", async () => {
		expect(await store.maxTurn("sess-a")).toBeNull();
	});

	test("returns the highest turn for the session, scoped by session id", async () => {
		await store.insert([makeRow(0, "sess-a"), makeRow(7, "sess-a"), makeRow(3, "sess-a")]);
		await store.insert([makeRow(42, "sess-other")]);

		expect(await store.maxTurn("sess-a")).toBe(7);
		expect(await store.maxTurn("sess-other")).toBe(42);
		expect(await store.maxTurn("sess-unknown")).toBeNull();
	});

	test("seeding from maxTurn prevents post-resume turn collisions", async () => {
		// Simulate a pre-restart session that ingested turns 0..5.
		await store.insert([makeRow(0, "sess-a"), makeRow(5, "sess-a")]);

		// The resumed process seeds its counter the way sdk wiring does.
		const seeded = ((await store.maxTurn("sess-a")) ?? -1) + 1;
		expect(seeded).toBe(6);

		// New rows ingested at the seeded counter never collide with old ones.
		await store.insert([makeRow(seeded, "sess-a")]);
		const atSeed = await store.filterByTurn(seeded, "sess-a");
		expect(atSeed).toHaveLength(1);
		expect(atSeed[0]?.text).toBe("row at turn 6");
	});
});
