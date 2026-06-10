import * as path from "node:path";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { logger } from "@oh-my-pi/pi-utils";
import { generateTaskId } from "./id";
import type { Task, TaskCreateInput, TaskQuery, TaskStatus, TaskSummary, TasksResult, TaskView } from "./types";

/** LanceDB accepts plain objects with string keys. */
type LanceData = Record<string, unknown>[];

const TABLE_NAME = "tasks";

/**
 * Compaction cutoff. LanceDB versions every write; pruning recent versions
 * while another agent process holds a table handle is the dominant cause of
 * `Object at location ... not found` task-store failures. A wide cutoff
 * keeps compaction (version manifests do accumulate) while making the
 * cross-process prune race practically impossible.
 */
const COMPACTION_CUTOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Storage-corruption error classifier. Only these trigger the recovery
 * ladder (reopen → salvage+rebuild); anything else (bad filter, programmer
 * error) propagates untouched — rebuild on arbitrary errors would be data
 * loss for no reason.
 */
export function isLanceStorageError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		/object at location .* not found/i.test(message) ||
		/no such file or directory/i.test(message) ||
		/manifest/i.test(message) ||
		/dataset .*(not found|corrupt)/i.test(message) ||
		/invalid .*version/i.test(message)
	);
}

/** Open the tasks table, creating it (via seed row) when missing. */
async function ensureTable(db: Connection): Promise<Table> {
	const names = await db.tableNames();
	if (names.includes(TABLE_NAME)) return db.openTable(TABLE_NAME);
	const seedRow: Task = {
		id: "__seed__",
		content: "",
		details: "",
		status: "open",
		agent: "",
		session: "",
		labels: "[]",
		depends_on: "[]",
		notes: "",
		project: "__seed__",
		created_at: 0,
		updated_at: 0,
	};
	const table = await db.createTable(TABLE_NAME, [seedRow] as unknown as LanceData);
	await table.delete("id = '__seed__'");
	return table;
}

/** Re-materialize a salvaged row as a plain Task (drops Arrow proxies/extras). */
function toPlainTask(row: Task): Task {
	return {
		id: String(row.id),
		content: String(row.content ?? ""),
		details: String(row.details ?? ""),
		status: row.status,
		agent: String(row.agent ?? ""),
		session: String(row.session ?? ""),
		labels: String(row.labels ?? "[]"),
		depends_on: String(row.depends_on ?? "[]"),
		notes: String(row.notes ?? ""),
		project: String(row.project ?? ""),
		created_at: Number(row.created_at ?? 0),
		updated_at: Number(row.updated_at ?? 0),
	};
}

export class TaskStore {
	#db: Connection;
	#table: Table;
	#project: string;
	#agentDir: string;

	constructor(db: Connection, table: Table, project: string, agentDir: string) {
		this.#db = db;
		this.#table = table;
		this.#project = project;
		this.#agentDir = agentDir;
	}

	/**
	 * Run a store operation with tiered recovery for storage corruption:
	 * 1. reopen the table (stale-handle race after cross-process compaction —
	 *    the common case; data is intact, only our handle is dead) and retry;
	 * 2. salvage readable rows → JSON backup → drop → recreate → re-insert,
	 *    then retry once more.
	 * Non-storage errors propagate unchanged.
	 */
	async #withRecovery<T>(opName: string, op: () => Promise<T>): Promise<T> {
		try {
			return await op();
		} catch (err) {
			if (!isLanceStorageError(err)) throw err;
			logger.warn("TaskStore storage error — reopening table", { op: opName, error: String(err) });
			try {
				this.#table = await this.#db.openTable(TABLE_NAME);
				return await op();
			} catch (err2) {
				if (!isLanceStorageError(err2)) throw err2;
				logger.error("TaskStore reopen failed — salvaging and rebuilding", {
					op: opName,
					error: String(err2),
				});
				await this.#salvageRebuild();
				return await op();
			}
		}
	}

	/**
	 * Last-resort rebuild: salvage whatever rows are still readable, back them
	 * up to a timestamped JSON sidecar, recreate the table, re-insert salvage.
	 * Worst-case loss = rows unreadable at corruption time; the backup attempt
	 * is on disk either way.
	 */
	async #salvageRebuild(): Promise<void> {
		let salvaged: Task[] = [];
		try {
			const table = await this.#db.openTable(TABLE_NAME);
			salvaged = ((await table.query().toArray()) as Task[]).map(toPlainTask);
		} catch (err) {
			logger.error("TaskStore salvage scan failed — rebuilding empty", { error: String(err) });
		}
		const backupPath = path.join(this.#agentDir, `tasks-backup-${Date.now()}.json`);
		try {
			await Bun.write(backupPath, JSON.stringify(salvaged, null, 2));
			logger.warn("TaskStore wrote salvage backup", { path: backupPath, rows: salvaged.length });
		} catch (err) {
			logger.error("TaskStore backup write failed", { path: backupPath, error: String(err) });
		}
		try {
			await this.#db.dropTable(TABLE_NAME);
		} catch {
			// Table may be unreadable/already gone — recreate regardless.
		}
		this.#table = await ensureTable(this.#db);
		if (salvaged.length > 0) {
			await this.#table.add(salvaged as unknown as LanceData);
		}
		logger.warn("TaskStore rebuilt", { restoredRows: salvaged.length });
	}

	static async open(agentDir: string, project: string): Promise<TaskStore> {
		const dbPath = path.join(agentDir, "tasks.lance");
		const db = await connect(dbPath);
		const names = await db.tableNames();
		let table: Table;

		if (names.includes(TABLE_NAME)) {
			table = await db.openTable(TABLE_NAME);
			// Fire-and-forget compaction — prunes accumulated version manifests.
			// Wide cutoff: see COMPACTION_CUTOFF_MS.
			const cutoff = new Date(Date.now() - COMPACTION_CUTOFF_MS);
			table.optimize({ cleanupOlderThan: cutoff }).catch(() => {});
		} else {
			table = await ensureTable(db);
		}

		logger.debug("TaskStore initialized", { path: dbPath });
		return new TaskStore(db, table, project, agentDir);
	}

	async create(inputs: TaskCreateInput[], session: string): Promise<string[]> {
		const now = Date.now();
		const ids: string[] = [];
		const rows: Task[] = [];

		for (const input of inputs) {
			const id = generateTaskId();
			ids.push(id);

			// Resolve "^" shorthand — depends on previous task in this batch
			const resolvedDeps = (input.depends_on ?? [])
				.map(dep => {
					if (dep === "^") {
						const prevId = ids[ids.length - 2];
						return prevId ?? "";
					}
					return dep;
				})
				.filter(Boolean);

			rows.push({
				id,
				content: input.content,
				details: input.details ?? "",
				status: "open",
				agent: "",
				session,
				labels: JSON.stringify(input.labels ?? []),
				depends_on: JSON.stringify(resolvedDeps),
				notes: "",
				project: this.#project,
				created_at: now,
				updated_at: now,
			});
		}

		await this.#withRecovery("create", () => this.#table.add(rows as unknown as LanceData));
		logger.debug("TaskStore created tasks", { count: rows.length, ids });
		return ids;
	}

	async get(id: string): Promise<Task | undefined> {
		const results = await this.#withRecovery("get", () =>
			this.#table
				.query()
				.where(`id = '${this.#escape(id)}'`)
				.limit(1)
				.toArray(),
		);
		return results[0] as Task | undefined;
	}

	async update(
		id: string,
		fields: Partial<
			Pick<Task, "content" | "details" | "status" | "agent" | "session" | "labels" | "depends_on" | "notes">
		>,
	): Promise<boolean> {
		const existing = await this.get(id);
		if (!existing) return false;

		const updated: Task = {
			...existing,
			...fields,
			updated_at: Date.now(),
		};

		// LanceDB doesn't have native update — delete + re-insert. Wrapped as one
		// recovery op: a retry re-deletes (no-op) and re-adds, never losing the row.
		await this.#withRecovery("update", async () => {
			await this.#table.delete(`id = '${this.#escape(id)}'`);
			await this.#table.add([updated] as unknown as LanceData);
		});
		return true;
	}

	async remove(id: string): Promise<boolean> {
		const existing = await this.get(id);
		if (!existing) return false;
		await this.#withRecovery("remove", () => this.#table.delete(`id = '${this.#escape(id)}'`));
		return true;
	}

	async query(params: TaskQuery = {}): Promise<TasksResult> {
		const filters: string[] = [`project = '${this.#escape(this.#project)}'`];

		if (params.id) {
			filters.push(`id = '${this.#escape(params.id)}'`);
		}
		if (params.agent) {
			filters.push(`agent = '${this.#escape(params.agent)}'`);
		}
		if (params.session) {
			filters.push(`session = '${this.#escape(params.session)}'`);
		}
		if (params.status && params.status !== "ready" && params.status !== "blocked") {
			filters.push(`status = '${this.#escape(params.status)}'`);
		}

		const allRows = (await this.#withRecovery("query", () =>
			this.#table.query().where(filters.join(" AND ")).toArray(),
		)) as Task[];

		// Build a lookup for dependency resolution
		const statusById = new Map<string, TaskStatus>();
		for (const row of allRows) {
			statusById.set(row.id, row.status);
		}

		// If we need ready/blocked resolution, we need all project tasks for dep lookup
		let allProjectTasks = allRows;
		if (params.status === "ready" || params.status === "blocked" || !params.status) {
			if (filters.length > 1) {
				// We filtered by more than just project — need full project set for dep resolution
				const fullSet = (await this.#withRecovery("query", () =>
					this.#table
						.query()
						.where(`project = '${this.#escape(this.#project)}'`)
						.toArray(),
				)) as Task[];
				for (const row of fullSet) {
					statusById.set(row.id, row.status);
				}
				allProjectTasks = fullSet;
			}
		}

		// Convert to views with dependency resolution
		const views: TaskView[] = [];
		for (const row of allRows) {
			const deps = this.#parseJsonArray(row.depends_on);
			const blockedBy = deps.filter(depId => {
				const depStatus = statusById.get(depId);
				return depStatus !== undefined && depStatus !== "done";
			});

			const view = this.#toView(row, deps, blockedBy);

			// Filter by derived status
			if (params.status === "ready") {
				if (row.status !== "open" || blockedBy.length > 0) continue;
			} else if (params.status === "blocked") {
				if (row.status !== "open" || blockedBy.length === 0) continue;
			}

			// Filter by label (post-query — stored as JSON string)
			if (params.label) {
				const labels = this.#parseJsonArray(row.labels);
				if (!labels.includes(params.label)) continue;
			}

			views.push(view);
		}

		// Compute summary from all project tasks (not just filtered)
		const summary = this.#computeSummary(allProjectTasks, statusById);

		return { tasks: views, summary };
	}

	close(): void {
		this.#table.close();
		this.#db.close();
		logger.debug("TaskStore closed");
	}

	#toView(row: Task, deps: string[], blockedBy: string[]): TaskView {
		return {
			id: row.id,
			content: row.content,
			details: row.details || undefined,
			status: row.status,
			agent: row.agent || undefined,
			session: row.session || undefined,
			labels: this.#parseJsonArray(row.labels),
			depends_on: deps,
			blocked_by: blockedBy,
			notes: row.notes || undefined,
			created_at: new Date(row.created_at).toISOString(),
			updated_at: new Date(row.updated_at).toISOString(),
		};
	}

	#computeSummary(tasks: Task[], statusById: Map<string, TaskStatus>): TaskSummary {
		let open = 0;
		let active = 0;
		let done = 0;
		let ready = 0;
		let blocked = 0;

		for (const t of tasks) {
			switch (t.status) {
				case "open": {
					open++;
					const deps = this.#parseJsonArray(t.depends_on);
					const isBlocked = deps.some(depId => {
						const s = statusById.get(depId);
						return s !== undefined && s !== "done";
					});
					if (isBlocked) blocked++;
					else ready++;
					break;
				}
				case "active":
					active++;
					break;
				case "done":
					done++;
					break;
				// abandoned not counted in summary
			}
		}

		return { total: tasks.length, open, active, done, ready, blocked };
	}

	#parseJsonArray(value: string): string[] {
		if (!value || value === "[]") return [];
		try {
			return JSON.parse(value);
		} catch {
			return [];
		}
	}

	#escape(value: string): string {
		return value.replace(/'/g, "''");
	}
}
