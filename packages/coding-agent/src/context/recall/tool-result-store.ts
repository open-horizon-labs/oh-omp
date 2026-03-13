import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export interface SearchResult {
	snippet: string;
	toolName: string;
	turnNumber: number;
	sessionId: string;
	paths: string[];
	rank: number;
}

export interface IndexEntry {
	content: string;
	toolName: string;
	sessionId: string;
	turnNumber: number;
	paths: string[];
}

interface ResultRow {
	id: number;
	tool_name: string;
	paths: string;
	session_id: string;
	turn_number: number;
	created_at: number;
}

interface FtsMatchRow {
	rowid: number;
	rank: number;
	snippet: string;
}

/**
 * FTS5-backed keyword search over tool results.
 *
 * Dual-index design:
 *   - Porter stemming table for natural language queries
 *   - Trigram table for exact substring matches (error codes, hex, UUIDs)
 *
 * Both tables are contentless (`content=''`) — the full text is stored once
 * in the `results` metadata table. FTS tables store only indexed tokens with
 * matching rowids.
 *
 * Follows the `HistoryStorage` pattern: WAL mode, prepared statements,
 * async insert via `setImmediate`.
 */
export class ToolResultStore {
	#db: Database;

	// Prepared statements
	#insertResultStmt: Statement;
	#insertFtsStmt: Statement;
	#insertTrigramStmt: Statement;
	#searchFtsStmt: Statement;
	#searchTrigramStmt: Statement;
	#getResultStmt: Statement;
	#cleanupStmt: Statement;
	#cleanupFtsStmt: Statement;
	#cleanupTrigramStmt: Statement;

	constructor(dbPath: string) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });

		this.#db = new Database(dbPath);

		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS results (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	content TEXT NOT NULL,
	tool_name TEXT NOT NULL,
	paths TEXT NOT NULL DEFAULT '',
	session_id TEXT NOT NULL,
	turn_number INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_results_session ON results(session_id);
CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS results_fts USING fts5(
	content,
	tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS results_trigram USING fts5(
	content,
	tokenize='trigram'
);
`);

		this.#insertResultStmt = this.#db.prepare(
			"INSERT INTO results (content, tool_name, paths, session_id, turn_number) VALUES (?, ?, ?, ?, ?)",
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
			"SELECT id, tool_name, paths, session_id, turn_number, created_at FROM results WHERE id = ?",
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
	 * Index a tool result for keyword search.
	 * Async via setImmediate — non-blocking, logs on failure.
	 */
	index(entry: IndexEntry): void {
		setImmediate(() => {
			try {
				this.#indexSync(entry);
			} catch (err) {
				logger.debug("ToolResultStore index failed", {
					error: err instanceof Error ? err.message : String(err),
					toolName: entry.toolName,
				});
			}
		});
	}

	/**
	 * Synchronous index for testing.
	 */
	indexSync(entry: IndexEntry): void {
		this.#indexSync(entry);
	}

	#indexSync(entry: IndexEntry): void {
		const content = entry.content;
		if (!content.trim()) return;

		const paths = entry.paths.join(" ");

		const transaction = this.#db.transaction(() => {
			const result = this.#insertResultStmt.run(content, entry.toolName, paths, entry.sessionId, entry.turnNumber);
			const rowid = Number(result.lastInsertRowid);
			this.#insertFtsStmt.run(rowid, content);
			this.#insertTrigramStmt.run(rowid, content);
		});

		transaction();
	}

	/**
	 * Search both porter and trigram tables, merge, dedup, return top N.
	 */
	search(query: string, options?: { limit?: number; sessionId?: string }): SearchResult[] {
		const limit = options?.limit ?? 10;
		const trimmed = query.trim();
		if (!trimmed) return [];

		// Query porter FTS with BM25 ranking
		const ftsQuery = this.#buildFtsQuery(trimmed);
		let porterResults: FtsMatchRow[] = [];
		if (ftsQuery) {
			try {
				porterResults = this.#searchFtsStmt.all(ftsQuery, limit * 2) as FtsMatchRow[];
			} catch {
				// FTS5 query syntax errors are expected for some inputs
			}
		}

		// Query trigram for exact substring matches
		const trigramQuery = this.#buildTrigramQuery(trimmed);
		let trigramResults: FtsMatchRow[] = [];
		if (trigramQuery) {
			try {
				trigramResults = this.#searchTrigramStmt.all(trigramQuery, limit * 2) as FtsMatchRow[];
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

		// Resolve metadata and filter by session
		const results: SearchResult[] = [];
		for (const [rowid, match] of seen) {
			const meta = this.#getResultStmt.get(rowid) as ResultRow | undefined;
			if (!meta) continue;

			if (options?.sessionId && meta.session_id !== options.sessionId) continue;

			results.push({
				snippet: match.snippet,
				toolName: meta.tool_name,
				turnNumber: meta.turn_number,
				sessionId: meta.session_id,
				paths: meta.paths ? meta.paths.split(" ").filter(Boolean) : [],
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
}
