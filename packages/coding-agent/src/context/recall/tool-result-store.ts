import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { RecallRow } from "./types";

export interface SearchResult {
	snippet: string;
	content: string;
	role: RecallRow["role"];
	toolName: string | null;
	turnNumber: number;
	sessionId: string;
	projectCwd: string;
	paths: string[];
	rowKey: string;
	rank: number;
}

export interface IndexEntry {
	content: string;
	role: RecallRow["role"];
	toolName: string | null;
	sessionId: string;
	projectCwd: string;
	turnNumber: number;
	paths: string[];
	rowKey: string;
}

export interface ToolResultSearchOptions {
	limit?: number;
	sessionId?: string;
	projectCwd?: string;
	role?: RecallRow["role"];
}

interface ResultRow {
	id: number;
	content: string;
	role: RecallRow["role"];
	tool_name: string;
	paths: string;
	session_id: string;
	project_cwd: string;
	turn_number: number;
	row_key: string;
	created_at: number;
}

interface FtsMatchRow {
	rowid: number;
	rank: number;
	snippet: string;
}

/**
 * FTS5-backed keyword search over recalled rows.
 *
 * Dual-index design:
 *   - Porter stemming table for natural language queries
 *   - Trigram table for exact substring matches (error codes, hex, UUIDs)
 * FTS tables index the same content independently so porter and trigram queries
 * can be tuned separately while the metadata table remains the authoritative
 * source for row context.
 *
 * Follows the `HistoryStorage` pattern: WAL mode, prepared statements,
 * async insert via `setImmediate`.
 */
export class ToolResultStore {
	#db: Database;

	// Prepared statements
	#insertResultStmt!: Statement;
	#insertFtsStmt!: Statement;
	#insertTrigramStmt!: Statement;
	#searchFtsStmt!: Statement;
	#searchTrigramStmt!: Statement;
	#getResultStmt!: Statement;
	#cleanupStmt!: Statement;
	#cleanupFtsStmt!: Statement;
	#cleanupTrigramStmt!: Statement;

	constructor(dbPath: string) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });

		this.#db = new Database(dbPath);
		try {
			this.#initialize(dbPath);
		} catch (err) {
			this.#db.close();
			throw err;
		}
	}

	#initialize(dbPath: string): void {
		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS results (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	content TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'tool_result',
	tool_name TEXT NOT NULL DEFAULT '',
	paths TEXT NOT NULL DEFAULT '',
	session_id TEXT NOT NULL,
	project_cwd TEXT NOT NULL DEFAULT '',
	turn_number INTEGER NOT NULL DEFAULT 0,
	row_key TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE VIRTUAL TABLE IF NOT EXISTS results_fts USING fts5(
	content,
	tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS results_trigram USING fts5(
	content,
	tokenize='trigram'
);
`);
		this.#ensureColumn("results", "role", "TEXT NOT NULL DEFAULT 'tool_result'");
		this.#ensureColumn("results", "project_cwd", "TEXT NOT NULL DEFAULT ''");
		this.#ensureColumn("results", "row_key", "TEXT NOT NULL DEFAULT ''");
		this.#db.exec(`
CREATE INDEX IF NOT EXISTS idx_results_session ON results(session_id);
CREATE INDEX IF NOT EXISTS idx_results_project ON results(project_cwd);
CREATE INDEX IF NOT EXISTS idx_results_row_key ON results(row_key);
CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at);
`);

		this.#insertResultStmt = this.#db.prepare(
			"INSERT INTO results (content, role, tool_name, paths, session_id, project_cwd, turn_number, row_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#insertFtsStmt = this.#db.prepare("INSERT INTO results_fts(rowid, content) VALUES (?, ?)");
		this.#insertTrigramStmt = this.#db.prepare("INSERT INTO results_trigram(rowid, content) VALUES (?, ?)");

		this.#searchFtsStmt = this.#db.prepare(`
			SELECT rowid, rank, snippet(results_fts, 0, '>>>', '<<<', '...', 40) as snippet
			FROM results_fts
			WHERE results_fts MATCH ?
			ORDER BY rank
			LIMIT ?
		`);

		this.#searchTrigramStmt = this.#db.prepare(`
			SELECT rowid, rank, snippet(results_trigram, 0, '>>>', '<<<', '...', 40) as snippet
			FROM results_trigram
			WHERE results_trigram MATCH ?
			ORDER BY rank
			LIMIT ?
		`);

		this.#getResultStmt = this.#db.prepare(
			"SELECT id, content, role, tool_name, paths, session_id, project_cwd, turn_number, row_key, created_at FROM results WHERE id = ?",
		);

		this.#cleanupStmt = this.#db.prepare("DELETE FROM results WHERE created_at <= ?");
		this.#cleanupFtsStmt = this.#db.prepare("DELETE FROM results_fts WHERE rowid NOT IN (SELECT id FROM results)");
		this.#cleanupTrigramStmt = this.#db.prepare(
			"DELETE FROM results_trigram WHERE rowid NOT IN (SELECT id FROM results)",
		);

		logger.debug("ToolResultStore initialized", { path: dbPath });
	}

	static open(dbPath: string): ToolResultStore {
		return new ToolResultStore(dbPath);
	}

	/**
	 * Index a recalled row for keyword search.
	 * Async via setImmediate — non-blocking, logs on failure.
	 */
	index(entry: IndexEntry): void {
		setImmediate(() => {
			try {
				this.#indexSync(entry);
			} catch (err) {
				logger.debug("ToolResultStore index failed", {
					error: err instanceof Error ? err.message : String(err),
					role: entry.role,
					toolName: entry.toolName,
				});
			}
		});
	}

	/**
	 * Synchronous index for testing or background ingest.
	 */
	indexSync(entry: IndexEntry): void {
		this.#indexSync(entry);
	}

	#indexSync(entry: IndexEntry): void {
		const content = entry.content;
		if (!content.trim()) return;

		const paths = entry.paths.join(" ");
		const toolName = entry.toolName ?? "";

		const transaction = this.#db.transaction(() => {
			const result = this.#insertResultStmt.run(
				content,
				entry.role,
				toolName,
				paths,
				entry.sessionId,
				entry.projectCwd,
				entry.turnNumber,
				entry.rowKey,
			);
			const rowid = Number(result.lastInsertRowid);
			this.#insertFtsStmt.run(rowid, content);
			this.#insertTrigramStmt.run(rowid, content);
		});

		transaction();
	}

	/**
	 * Search both porter and trigram tables, merge, dedup, return top N.
	 */
	search(query: string, options?: ToolResultSearchOptions): SearchResult[] {
		const limit = options?.limit ?? 10;
		const trimmed = query.trim();
		if (!trimmed) return [];
		const searchLimit = limit * (options?.sessionId || options?.projectCwd || options?.role ? 4 : 2);

		// Query porter FTS with BM25 ranking
		const ftsQuery = this.#buildFtsQuery(trimmed);
		let porterResults: FtsMatchRow[] = [];
		if (ftsQuery) {
			try {
				porterResults = this.#searchFtsStmt.all(ftsQuery, searchLimit) as FtsMatchRow[];
			} catch {
				// FTS5 query syntax errors are expected for some inputs
			}
		}

		// Query trigram for exact substring matches
		const trigramQuery = this.#buildTrigramQuery(trimmed);
		let trigramResults: FtsMatchRow[] = [];
		if (trigramQuery) {
			try {
				trigramResults = this.#searchTrigramStmt.all(trigramQuery, searchLimit) as FtsMatchRow[];
			} catch {
				// Trigram query can fail on very short strings (<3 chars)
			}
		}

		// Merge and dedup by rowid
		const seen = new Map<number, { rank: number; snippet: string }>();

		for (const row of porterResults) {
			seen.set(row.rowid, { rank: row.rank, snippet: row.snippet });
		}

		for (const row of trigramResults) {
			const existing = seen.get(row.rowid);
			if (!existing || row.rank < existing.rank) {
				// Trigram match is stronger (lower rank = better in FTS5)
				seen.set(row.rowid, { rank: row.rank, snippet: row.snippet });
			}
		}

		// Resolve metadata and apply filters
		const results: SearchResult[] = [];
		for (const [rowid, match] of seen) {
			const meta = this.#getResultStmt.get(rowid) as ResultRow | undefined;
			if (!meta) continue;

			if (options?.sessionId && meta.session_id !== options.sessionId) continue;
			if (options?.projectCwd && meta.project_cwd !== options.projectCwd) continue;
			if (options?.role && meta.role !== options.role) continue;

			results.push({
				snippet: match.snippet,
				content: meta.content,
				role: meta.role,
				toolName: meta.tool_name || null,
				turnNumber: meta.turn_number,
				sessionId: meta.session_id,
				projectCwd: meta.project_cwd,
				paths: meta.paths ? meta.paths.split(" ").filter(Boolean) : [],
				rowKey: meta.row_key,
				rank: match.rank,
			});
		}

		// Sort by rank (lower = better in FTS5 BM25)
		results.sort((a, b) => a.rank - b.rank);

		return results.slice(0, limit);
	}

	/**
	 * Delete entries older than maxAgeMs milliseconds.
	 * Returns count of deleted rows.
	 */
	cleanup(maxAgeMs: number): number {
		const cutoff = Math.floor((Date.now() - maxAgeMs) / 1000); // unixepoch is seconds
		const result = this.#cleanupStmt.run(cutoff);
		if (result.changes > 0) {
			this.#cleanupFtsStmt.run();
			this.#cleanupTrigramStmt.run();
			logger.debug("ToolResultStore cleanup", { deleted: result.changes });
		}
		return result.changes;
	}

	close(): void {
		this.#db.close();
	}

	/**
	 * Build an FTS5 porter query from free-text input.
	 * Wraps each token in quotes with prefix matching.
	 */
	#buildFtsQuery(query: string): string | null {
		const tokens = query
			.trim()
			.split(/\s+/)
			.map(t => t.trim())
			.filter(Boolean);

		if (tokens.length === 0) return null;

		return tokens
			.map(token => {
				const escaped = token.replace(/"/g, '""');
				return `"${escaped}"*`;
			})
			.join(" ");
	}

	/**
	 * Build a trigram query — the raw input as a quoted phrase.
	 * Trigram requires at least 3 characters.
	 */
	#buildTrigramQuery(query: string): string | null {
		if (query.length < 3) return null;
		const escaped = query.replace(/"/g, '""');
		return `"${escaped}"`;
	}

	#ensureColumn(tableName: string, columnName: string, definition: string): void {
		try {
			this.#db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
		} catch {}
	}
}
