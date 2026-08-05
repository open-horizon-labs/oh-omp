import * as path from "node:path";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { logger } from "@oh-my-pi/pi-utils";
import {
	buildRecallRowKey,
	EMBEDDING_DIM,
	type RecallLookupKey,
	type RecallRow,
	type RecallSearchResult,
} from "./types";

/** LanceDB accepts plain objects with string keys. */
type LanceData = Record<string, unknown>[];

export interface RecallStoreOptions {
	/** Global agent directory (~/.oh-omp/agent). DB lives at {agentDir}/recall.lance. */
	agentDir: string;
	sessionId: string;
}

const TABLE_NAME = "recall";
const OPTIMIZE_EVERY = 50;
/** Keep versions younger than 2 min so a concurrent session can still read them. */
const VERSION_TTL_MS = 2 * 60_000;

export class RecallStore {
	#db: Connection;
	#table: Table;
	#insertsSinceOptimize = 0;

	constructor(db: Connection, table: Table) {
		this.#db = db;
		this.#table = table;
	}

	static async open(options: RecallStoreOptions): Promise<RecallStore> {
		const dbPath = path.join(options.agentDir, "recall.lance");
		const db = await connect(dbPath);
		const names = await db.tableNames();
		let table: Table;

		if (names.includes(TABLE_NAME)) {
			table = await db.openTable(TABLE_NAME);
			// Fire-and-forget compaction — merges tiny fragments and prunes old
			// version manifests that accumulate with every append.
			RecallStore.#optimize(table);
		} else {
			// Seed row uses non-null strings for nullable fields so LanceDB
			// can infer the schema. The seed is deleted immediately after creation.
			const seedRow = {
				vector: new Array<number>(EMBEDDING_DIM).fill(0),
				text: "",
				role: "user" as const,
				turn: 0,
				tool_name: "__seed__",
				paths: "__seed__",
				symbols: "__seed__",
				project_cwd: "__seed__",
				timestamp: 0,
				session_id: options.sessionId,
			};
			table = await db.createTable(TABLE_NAME, [seedRow]);
			await table.delete("timestamp = 0 AND tool_name = '__seed__'");
			// Build scalar indices once at table creation — not on every open,
			// otherwise concurrent sessions hit CommitConflict on the shared lance dir.
			await table.createIndex("turn").catch(() => {});
			await table.createIndex("session_id").catch(() => {});
		}

		logger.debug("RecallStore initialized", { path: dbPath });
		return new RecallStore(db, table);
	}

	async insert(rows: RecallRow[]): Promise<void> {
		if (rows.length === 0) return;
		await this.#table.add(rows as unknown as LanceData);
		this.#insertsSinceOptimize += rows.length;
		if (this.#insertsSinceOptimize >= OPTIMIZE_EVERY) {
			this.#insertsSinceOptimize = 0;
			RecallStore.#optimize(this.#table);
		}
		logger.debug("RecallStore inserted rows", { count: rows.length });
	}

	async search(vector: number[], limit: number, filter?: string): Promise<RecallSearchResult[]> {
		let query = this.#table.vectorSearch(vector).limit(limit);
		if (filter) {
			query = query.where(filter);
		}
		const results = await query.toArray();
		return results as RecallSearchResult[];
	}

	async filterByTurn(turn: number, sessionId: string): Promise<RecallRow[]> {
		const filter = `turn = ${turn} AND session_id = '${sessionId.replace(/'/g, "''")}'`;
		const query = this.#table.query().where(filter).limit(20).toArray();
		const timeout = Bun.sleep(5000).then(() => [] as RecallRow[]);
		return Promise.race([query as Promise<RecallRow[]>, timeout]);
	}

	/**
	 * Highest ingested turn number for a session, or null when the session has
	 * no rows (or the scan timed out). Used to seed the ingest turn counter on
	 * resume so post-restart rows never reuse turn numbers already occupied by
	 * earlier rows of the same session.
	 */
	async maxTurn(sessionId: string): Promise<number | null> {
		const filter = `session_id = '${sessionId.replace(/'/g, "''")}'`;
		const scan = this.#table
			.query()
			.where(filter)
			.select(["turn"])
			.toArray()
			.then(rows => {
				let max: number | null = null;
				for (const row of rows as { turn: number }[]) {
					const turn = Number(row.turn);
					if (Number.isFinite(turn) && (max === null || turn > max)) max = turn;
				}
				return max;
			});
		const timeout = Bun.sleep(5000).then(() => null);
		return Promise.race([scan, timeout]);
	}

	async getByLookupKeys(keys: RecallLookupKey[]): Promise<Map<string, RecallRow>> {
		if (keys.length === 0) return new Map();

		const turnsBySession = new Map<string, Set<number>>();
		for (const key of keys) {
			let turns = turnsBySession.get(key.session_id);
			if (!turns) {
				turns = new Set<number>();
				turnsBySession.set(key.session_id, turns);
			}
			turns.add(key.turn);
		}

		const clauses = Array.from(turnsBySession.entries()).map(([sessionId, turns]) => {
			const escapedId = sessionId.replace(/'/g, "''");
			const turnList = Array.from(turns).join(", ");
			return `(session_id = '${escapedId}' AND turn IN (${turnList}))`;
		});
		const filter = clauses.join(" OR ");
		const timeout = Bun.sleep(5000).then(() => [] as RecallRow[]);
		const results = (await Promise.race([
			this.#table
				.query()
				.where(filter)
				.limit(Math.max(keys.length * 10, 30))
				.toArray(),
			timeout,
		])) as RecallRow[];

		const wanted = new Set(
			keys.map(key => `${key.session_id}:${key.turn}:${key.role}:${key.tool_name ?? ""}:${key.text_hash}`),
		);
		const matched = new Map<string, RecallRow>();
		for (const row of results) {
			const rowKey = buildRecallRowKey(row);
			if (wanted.has(rowKey) && !matched.has(rowKey)) {
				matched.set(rowKey, row);
			}
		}
		return matched;
	}

	async getSessionConversationVectors(sessionId: string): Promise<Array<{ text: string; vector: number[] }>> {
		const escapedId = sessionId.replace(/'/g, "''");
		const filter = `session_id = '${escapedId}' AND role IN ('user', 'assistant')`;
		const timeout = Bun.sleep(5000).then(() => [] as Array<{ text: string; vector: number[] }>);
		const rows = (await Promise.race([
			this.#table.query().where(filter).select(["text", "vector"]).toArray(),
			timeout,
		])) as Array<{ text?: unknown; vector?: unknown }>;

		const vectors: Array<{ text: string; vector: number[] }> = [];
		for (const row of rows) {
			if (typeof row.text !== "string") continue;
			if (!row.text) continue;
			if (!row.vector || typeof row.vector !== "object" || !(Symbol.iterator in row.vector)) continue;
			const vector = Array.from(row.vector as Iterable<unknown>);
			if (vector.length === 0) continue;
			if (!vector.every(value => typeof value === "number" && Number.isFinite(value))) continue;
			vectors.push({ text: row.text, vector: vector as number[] });
		}
		return vectors;
	}

	async getEmbeddingsByTurns(turns: number[], sessionId: string): Promise<Map<number, Float32Array>> {
		if (turns.length === 0) return new Map();
		const escapedId = sessionId.replace(/'/g, "''");
		const turnList = turns.join(", ");
		const filter = `turn IN (${turnList}) AND session_id = '${escapedId}'`;
		const timeout = Bun.sleep(5000).then(() => [] as RecallRow[]);
		const results = (await Promise.race([
			this.#table
				.query()
				.where(filter)
				.limit(turns.length * 3)
				.toArray(),
			timeout,
		])) as RecallRow[];
		const map = new Map<number, Float32Array>();
		for (const row of results) {
			if (!map.has(row.turn) && row.vector) {
				map.set(row.turn, new Float32Array(row.vector));
			}
		}
		return map;
	}

	static #optimize(table: Table): void {
		const cutoff = new Date(Date.now() - VERSION_TTL_MS);
		table.optimize({ cleanupOlderThan: cutoff }).then(
			stats => {
				if (stats.compaction.filesAdded > 0 || stats.prune.bytesRemoved > 0) {
					logger.debug("RecallStore optimized", {
						fragmentsRemoved: stats.compaction.fragmentsRemoved,
						filesAdded: stats.compaction.filesAdded,
						bytesRemoved: stats.prune.bytesRemoved,
					});
				}
			},
			err => logger.debug("RecallStore optimize failed (non-fatal)", { err }),
		);
	}

	close(): void {
		this.#table.close();
		this.#db.close();
		logger.debug("RecallStore closed");
	}
}
