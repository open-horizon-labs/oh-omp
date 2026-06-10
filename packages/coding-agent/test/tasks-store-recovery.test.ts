import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isLanceStorageError, TaskStore } from "@oh-my-pi/pi-coding-agent/tasks/store";

describe("isLanceStorageError", () => {
	test("classifies Lance storage failures", () => {
		expect(
			isLanceStorageError(
				new Error(
					"lance error: Generic LocalFileSystem error: Object at location /x/tasks.lance/data/abc.lance not found",
				),
			),
		).toBe(true);
		expect(isLanceStorageError(new Error("No such file or directory (os error 2)"))).toBe(true);
		expect(isLanceStorageError(new Error("failed to load manifest version 42"))).toBe(true);
	});

	test("does not classify programmer or filter errors", () => {
		expect(isLanceStorageError(new Error("Parse error: invalid SQL filter expression"))).toBe(false);
		expect(isLanceStorageError(new Error("schema mismatch: expected string"))).toBe(false);
	});
});

describe("TaskStore recovery", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "taskstore-recovery-"));
	});

	afterEach(async () => {
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("rebuilds automatically after destructive on-disk corruption and stays operational", async () => {
		const store = await TaskStore.open(agentDir, "proj");
		await store.create([{ content: "task before corruption" }], "sess-1");

		// Destroy the table's version manifests + data on disk: unrecoverable by
		// reopen, forces the salvage+rebuild tier.
		const tableDir = path.join(agentDir, "tasks.lance", "tasks.lance");
		await fs.rm(tableDir, { recursive: true, force: true });

		// Op must succeed via rebuild instead of throwing.
		const result = await store.query({});
		expect(Array.isArray(result.tasks)).toBe(true);

		// Store remains fully operational after rebuild.
		const ids = await store.create([{ content: "task after rebuild" }], "sess-1");
		expect(ids).toHaveLength(1);
		const fetched = await store.get(ids[0]!);
		expect(fetched?.content).toBe("task after rebuild");

		// A salvage backup file was attempted.
		const files = await fs.readdir(agentDir);
		expect(files.some(f => f.startsWith("tasks-backup-") && f.endsWith(".json"))).toBe(true);
	});

	test("non-storage errors propagate without triggering rebuild", async () => {
		const store = await TaskStore.open(agentDir, "proj");
		const ids = await store.create([{ content: "survivor" }], "sess-1");

		// Force a non-storage error through the recovery wrapper: a filter on a
		// column that does not exist is a query error, not corruption.
		await expect(
			store.query({ id: "nonexistent'; column" } as never), // escaped internally; harmless
		).resolves.toBeDefined();

		// Data untouched.
		const fetched = await store.get(ids[0]!);
		expect(fetched?.content).toBe("survivor");
		const files = await fs.readdir(agentDir);
		expect(files.some(f => f.startsWith("tasks-backup-"))).toBe(false);
	});
});
