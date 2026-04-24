import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import {
	createFactAssertion,
	FACT_STATUSES,
	type FactAssertion,
	type FactEvidence,
	type FactScope,
	type FactSource,
	type FactStatus,
	type FactTemporal,
	type NewFactAssertionInput,
} from "./schema";

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";
const FACTS_DB_FILENAME = "facts.sqlite";

interface FactRow {
	id: string;
	kind: FactAssertion["kind"];
	subject: string;
	predicate: string;
	object_json: string;
	canonical_text: string;
	scope_json: string;
	temporal_json: string;
	status: FactStatus;
	confidence: number;
	source_json: string;
	evidence_json: string;
	supersedes_json: string;
	tags_json: string;
	sensitivity: FactAssertion["sensitivity"];
	created_at: number;
	updated_at: number;
}

export interface FactListOptions {
	includeHistory?: boolean;
	status?: FactStatus;
	limit?: number;
	subject?: string;
	predicate?: string;
}

export interface FactSearchOptions extends FactListOptions {
	query: string;
}

export interface FactEvent {
	id: number;
	factId: string;
	action: string;
	reason?: string;
	createdAt: number;
}

interface FactEventRow {
	id: number;
	fact_id: string;
	action: string;
	reason: string | null;
	created_at: number;
}

export function getFactsDbPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, FACTS_DB_FILENAME);
}

export class FactStore {
	#db: Database;
	#insertStmt: Statement;
	#getStmt: Statement;
	#listStmt: Statement;
	#listActiveStmt: Statement;
	#searchStmt: Statement;
	#searchActiveStmt: Statement;
	#updateStatusStmt: Statement;
	#eraseStmt: Statement;
	#insertEventStmt: Statement;
	#eventsStmt: Statement;

	constructor(dbPath: string = getFactsDbPath()) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });

		this.#db = new Database(dbPath);
		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS fact_assertions (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	subject TEXT NOT NULL,
	predicate TEXT NOT NULL,
	object_json TEXT NOT NULL,
	canonical_text TEXT NOT NULL,
	scope_json TEXT NOT NULL,
	temporal_json TEXT NOT NULL,
	status TEXT NOT NULL,
	confidence REAL NOT NULL,
	source_json TEXT NOT NULL,
	evidence_json TEXT NOT NULL,
	supersedes_json TEXT NOT NULL DEFAULT '[]',
	tags_json TEXT NOT NULL DEFAULT '[]',
	sensitivity TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
CREATE INDEX IF NOT EXISTS idx_fact_assertions_status ON fact_assertions(status);
CREATE INDEX IF NOT EXISTS idx_fact_assertions_kind ON fact_assertions(kind);
CREATE INDEX IF NOT EXISTS idx_fact_assertions_subject ON fact_assertions(subject);
CREATE INDEX IF NOT EXISTS idx_fact_assertions_predicate ON fact_assertions(predicate);
CREATE INDEX IF NOT EXISTS idx_fact_assertions_updated ON fact_assertions(updated_at DESC);

CREATE TABLE IF NOT EXISTS fact_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	fact_id TEXT NOT NULL,
	action TEXT NOT NULL,
	reason TEXT,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
CREATE INDEX IF NOT EXISTS idx_fact_events_fact ON fact_events(fact_id, created_at DESC);
`);
		this.#insertStmt = this.#db.prepare(`
INSERT INTO fact_assertions (
	id, kind, subject, predicate, object_json, canonical_text, scope_json, temporal_json,
	status, confidence, source_json, evidence_json, supersedes_json, tags_json, sensitivity,
	created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
		this.#getStmt = this.#db.prepare("SELECT * FROM fact_assertions WHERE id = ?");
		this.#listStmt = this.#db.prepare(
			"SELECT * FROM fact_assertions ORDER BY updated_at DESC, created_at DESC LIMIT ?",
		);
		this.#listActiveStmt = this.#db.prepare(
			"SELECT * FROM fact_assertions WHERE status = 'active' ORDER BY updated_at DESC, created_at DESC LIMIT ?",
		);
		this.#searchStmt = this.#db.prepare(`
SELECT * FROM fact_assertions
WHERE subject LIKE ? ESCAPE '\\'
	OR predicate LIKE ? ESCAPE '\\'
	OR canonical_text LIKE ? ESCAPE '\\'
ORDER BY updated_at DESC, created_at DESC
LIMIT ?
`);
		this.#searchActiveStmt = this.#db.prepare(`
SELECT * FROM fact_assertions
WHERE status = 'active'
	AND (subject LIKE ? ESCAPE '\\'
		OR predicate LIKE ? ESCAPE '\\'
		OR canonical_text LIKE ? ESCAPE '\\')
ORDER BY updated_at DESC, created_at DESC
LIMIT ?
`);
		this.#updateStatusStmt = this.#db.prepare("UPDATE fact_assertions SET status = ?, updated_at = ? WHERE id = ?");
		this.#eraseStmt = this.#db.prepare(`
UPDATE fact_assertions
SET subject = '[erased]', predicate = 'erased', object_json = 'null', canonical_text = '[erased]',
	evidence_json = '[]', supersedes_json = '[]', tags_json = '[]', status = 'erased', sensitivity = 'sensitive', updated_at = ?
WHERE id = ?
`);
		this.#insertEventStmt = this.#db.prepare(
			"INSERT INTO fact_events (fact_id, action, reason, created_at) VALUES (?, ?, ?, ?)",
		);
		this.#eventsStmt = this.#db.prepare(
			"SELECT * FROM fact_events WHERE fact_id = ? ORDER BY created_at DESC, id DESC",
		);
	}

	static open(dbPath?: string): FactStore {
		return new FactStore(dbPath);
	}

	close(): void {
		this.#db.close();
	}

	add(input: NewFactAssertionInput): FactAssertion {
		const assertion = createFactAssertion(input);
		this.insert(assertion);
		return assertion;
	}

	insert(assertion: FactAssertion): void {
		const transaction = this.#db.transaction(() => {
			this.#insertStmt.run(
				assertion.id,
				assertion.kind,
				assertion.subject,
				assertion.predicate,
				JSON.stringify(assertion.object),
				assertion.canonicalText,
				JSON.stringify(assertion.scope),
				JSON.stringify(assertion.temporal),
				assertion.status,
				assertion.confidence,
				JSON.stringify(assertion.source),
				JSON.stringify(assertion.evidence),
				JSON.stringify(assertion.supersedes),
				JSON.stringify(assertion.tags),
				assertion.sensitivity,
				Math.floor(assertion.createdAt / 1000),
				Math.floor(assertion.updatedAt / 1000),
			);
			this.#recordEvent(assertion.id, "add", undefined, assertion.createdAt);
		});
		transaction();
	}

	get(id: string): FactAssertion | null {
		const row = this.#getStmt.get(id) as FactRow | undefined;
		return row ? rowToFact(row) : null;
	}

	list(options: FactListOptions = {}): FactAssertion[] {
		const limit = normalizeLimit(options.limit);
		let rows: FactRow[];
		if (options.status) {
			if (!FACT_STATUSES.includes(options.status)) return [];
			rows = this.#db
				.prepare("SELECT * FROM fact_assertions WHERE status = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?")
				.all(options.status, limit) as FactRow[];
		} else if (options.includeHistory) {
			rows = this.#listStmt.all(limit) as FactRow[];
		} else {
			rows = this.#listActiveStmt.all(limit) as FactRow[];
		}
		return rows.map(rowToFact).filter(fact => matchesListOptions(fact, options));
	}

	search(options: FactSearchOptions): FactAssertion[] {
		const query = options.query.trim();
		if (!query) return [];
		const limit = normalizeLimit(options.limit);
		const pattern = `%${escapeLike(query)}%`;
		const rows = (
			options.includeHistory
				? this.#searchStmt.all(pattern, pattern, pattern, limit)
				: this.#searchActiveStmt.all(pattern, pattern, pattern, limit)
		) as FactRow[];
		return rows.map(rowToFact).filter(fact => matchesListOptions(fact, options));
	}

	retract(id: string, reason?: string, nowMs: number = Date.now()): FactAssertion | null {
		const existing = this.get(id);
		if (!existing || existing.status === "erased") return existing;
		const nowSec = Math.floor(nowMs / 1000);
		const transaction = this.#db.transaction(() => {
			this.#updateStatusStmt.run("retracted", nowSec, id);
			this.#recordEvent(id, "retract", reason, nowMs);
		});
		transaction();
		return this.get(id);
	}

	erase(id: string, reason?: string, nowMs: number = Date.now()): FactAssertion | null {
		const existing = this.get(id);
		if (!existing) return null;
		const nowSec = Math.floor(nowMs / 1000);
		const transaction = this.#db.transaction(() => {
			this.#eraseStmt.run(nowSec, id);
			this.#recordEvent(id, "erase", reason, nowMs);
		});
		transaction();
		return this.get(id);
	}

	events(factId: string): FactEvent[] {
		const rows = this.#eventsStmt.all(factId) as FactEventRow[];
		return rows.map(row => ({
			id: row.id,
			factId: row.fact_id,
			action: row.action,
			reason: row.reason ?? undefined,
			createdAt: row.created_at * 1000,
		}));
	}

	#recordEvent(factId: string, action: string, reason: string | undefined, nowMs: number): void {
		this.#insertEventStmt.run(factId, action, reason ?? null, Math.floor(nowMs / 1000));
	}
}

function rowToFact(row: FactRow): FactAssertion {
	return {
		id: row.id,
		kind: row.kind,
		subject: row.subject,
		predicate: row.predicate,
		object: parseJson(row.object_json, null),
		canonicalText: row.canonical_text,
		scope: parseJson(row.scope_json, { kind: "global" }) as FactScope,
		temporal: parseJson(row.temporal_json, {
			observedAt: new Date(row.created_at * 1000).toISOString(),
		}) as FactTemporal,
		status: row.status,
		confidence: row.confidence,
		source: parseJson(row.source_json, { kind: "manual" }) as FactSource,
		evidence: parseJson(row.evidence_json, []) as FactEvidence[],
		supersedes: parseJson(row.supersedes_json, []) as string[],
		tags: parseJson(row.tags_json, []) as string[],
		sensitivity: row.sensitivity,
		createdAt: row.created_at * 1000,
		updatedAt: row.updated_at * 1000,
	};
}

function parseJson(value: string, fallback: unknown): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		logger.warn("FactStore JSON parse failed", { error: error instanceof Error ? error.message : String(error) });
		return fallback;
	}
}

function normalizeLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit ?? 50)) return 50;
	return Math.min(Math.max(Math.floor(limit ?? 50), 0), 500);
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function matchesListOptions(fact: FactAssertion, options: FactListOptions): boolean {
	if (options.subject && fact.subject !== options.subject) return false;
	if (options.predicate && fact.predicate !== options.predicate) return false;
	return true;
}
