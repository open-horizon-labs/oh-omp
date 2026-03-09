import * as path from "node:path";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { logger } from "@oh-my-pi/pi-utils";
import type { RecallRow, RecallSearchResult } from "./types";
import { EMBEDDING_DIM } from "./types";

/** LanceDB accepts plain objects with string keys. */
type LanceData = Record<string, unknown>[];

export interface RecallStoreOptions {
	/** Global agent directory (~/.oh-omp/agent). DB lives at {agentDir}/recall.lance. */
	agentDir: string;
	sessionId: string;
}

const TABLE_NAME = "recall";

export class RecallStore {
	#db: Connection;
	#table: Table;

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
		}

		logger.debug("RecallStore initialized", { path: dbPath });
		return new RecallStore(db, table);
	}

	async insert(rows: RecallRow[]): Promise<void> {
		if (rows.length === 0) return;
		await this.#table.add(rows as unknown as LanceData);
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

	close(): void {
		this.#table.close();
		this.#db.close();
		logger.debug("RecallStore closed");
	}
}
