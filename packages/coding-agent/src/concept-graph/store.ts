import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	CONCEPT_KINDS,
	CONCEPT_STATUSES,
	CONFIDENCE_LEVELS,
	type Concept,
	type ConceptCreateInput,
	type ConceptEvidence,
	type ConceptEvidenceCreateInput,
	type ConceptFact,
	type ConceptFactCreateInput,
	type ConceptFactEvidence,
	type ConceptGraphCounts,
	type ConceptGraphEvent,
	type ConceptGraphEventCreateInput,
	type ConceptLink,
	type ConceptLinkCreateInput,
	type ConceptLinkStatus,
	type ConceptScope,
	EVIDENCE_EXTRACTORS,
	EVIDENCE_SOURCE_TYPES,
	FACT_AUTHORITIES,
	FACT_EVIDENCE_ROLES,
	FACT_KINDS,
	FACT_STATUSES,
	type FactEvidenceRole,
	type FactStatus,
	GRAPH_EVENT_ACTORS,
	GRAPH_EVENT_KINDS,
	LINK_KINDS,
	LINK_STATUSES,
	SENSITIVITY_LEVELS,
} from "./types";

type ConceptRow = {
	id: string;
	kind: Concept["kind"];
	canonical_name: string;
	canonical_key: string;
	aliases_json: string;
	description: string | null;
	scope_json: string;
	status: Concept["status"];
	merged_into_concept_id: string | null;
	created_at: number;
	updated_at: number;
};

type FactRow = {
	id: string;
	kind: ConceptFact["kind"];
	subject_concept_id: string | null;
	claim: string;
	normalized_claim: string;
	scope_json: string;
	status: ConceptFact["status"];
	authority: ConceptFact["authority"];
	confidence: ConceptFact["confidence"];
	sensitivity: ConceptFact["sensitivity"];
	owner_ref: string | null;
	valid_from: string | null;
	valid_until: string | null;
	superseded_by_fact_id: string | null;
	created_at: number;
	updated_at: number;
};

type LinkRow = {
	id: string;
	from_fact_id: string;
	to_fact_id: string;
	kind: ConceptLink["kind"];
	status: ConceptLink["status"];
	confidence: ConceptLink["confidence"];
	rationale: string;
	evidence_ids_json: string;
	created_at: number;
	updated_at: number;
};

type EvidenceRow = {
	id: string;
	source_type: ConceptEvidence["sourceType"];
	source_uri: string;
	locator: string;
	quote: string | null;
	summary: string;
	extracted_by: ConceptEvidence["extractedBy"];
	extracted_at: number;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

export class ConceptGraphStore {
	#db: Database;
	#insertConceptStmt: Statement;
	#insertEvidenceStmt: Statement;
	#insertFactStmt: Statement;
	#insertFactEvidenceStmt: Statement;
	#insertLinkStmt: Statement;
	#insertEventStmt: Statement;
	#getConceptStmt: Statement;
	#getFactStmt: Statement;
	#getEvidenceStmt: Statement;
	#getLinkStmt: Statement;
	#listFactEvidenceStmt: Statement;
	#listFactsStmt: Statement;
	#listLinksForFactStmt: Statement;
	#updateFactStatusStmt: Statement;
	#updateLinkStatusStmt: Statement;
	#countStmt: Statement;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		this.#initializeSchema();

		this.#insertConceptStmt = this.#db.prepare(`
INSERT INTO concept_graph_concepts (
	id, kind, canonical_name, canonical_key, aliases_json, description, scope_json, status,
	merged_into_concept_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	kind = excluded.kind,
	canonical_name = excluded.canonical_name,
	canonical_key = excluded.canonical_key,
	aliases_json = excluded.aliases_json,
	description = excluded.description,
	scope_json = excluded.scope_json,
	status = excluded.status,
	merged_into_concept_id = excluded.merged_into_concept_id,
	updated_at = excluded.updated_at
`);
		this.#insertEvidenceStmt = this.#db.prepare(`
INSERT INTO concept_graph_evidence (
	id, source_type, source_uri, locator, quote, summary, extracted_by, extracted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	source_type = excluded.source_type,
	source_uri = excluded.source_uri,
	locator = excluded.locator,
	quote = excluded.quote,
	summary = excluded.summary,
	extracted_by = excluded.extracted_by,
	extracted_at = excluded.extracted_at
`);
		this.#insertFactStmt = this.#db.prepare(`
INSERT INTO concept_graph_facts (
	id, kind, subject_concept_id, claim, normalized_claim, scope_json, status, authority, confidence,
	sensitivity, owner_ref, valid_from, valid_until, superseded_by_fact_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	kind = excluded.kind,
	subject_concept_id = excluded.subject_concept_id,
	claim = excluded.claim,
	normalized_claim = excluded.normalized_claim,
	scope_json = excluded.scope_json,
	status = excluded.status,
	authority = excluded.authority,
	confidence = excluded.confidence,
	sensitivity = excluded.sensitivity,
	owner_ref = excluded.owner_ref,
	valid_from = excluded.valid_from,
	valid_until = excluded.valid_until,
	superseded_by_fact_id = excluded.superseded_by_fact_id,
	updated_at = excluded.updated_at
`);
		this.#insertFactEvidenceStmt = this.#db.prepare(`
INSERT OR REPLACE INTO concept_graph_fact_evidence (fact_id, evidence_id, role)
VALUES (?, ?, ?)
`);
		this.#insertLinkStmt = this.#db.prepare(`
INSERT INTO concept_graph_links (
	id, from_fact_id, to_fact_id, kind, status, confidence, rationale, evidence_ids_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	from_fact_id = excluded.from_fact_id,
	to_fact_id = excluded.to_fact_id,
	kind = excluded.kind,
	status = excluded.status,
	confidence = excluded.confidence,
	rationale = excluded.rationale,
	evidence_ids_json = excluded.evidence_ids_json,
	updated_at = excluded.updated_at
`);
		this.#insertEventStmt = this.#db.prepare(`
INSERT INTO concept_graph_events (id, kind, target_id, actor, activity, rationale, evidence_ids_json, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
		this.#getConceptStmt = this.#db.prepare("SELECT * FROM concept_graph_concepts WHERE id = ?");
		this.#getFactStmt = this.#db.prepare("SELECT * FROM concept_graph_facts WHERE id = ?");
		this.#getEvidenceStmt = this.#db.prepare("SELECT * FROM concept_graph_evidence WHERE id = ?");
		this.#getLinkStmt = this.#db.prepare("SELECT * FROM concept_graph_links WHERE id = ?");
		this.#listFactEvidenceStmt = this.#db.prepare(
			"SELECT fact_id, evidence_id, role FROM concept_graph_fact_evidence WHERE fact_id = ? ORDER BY evidence_id",
		);
		this.#listFactsStmt = this.#db.prepare("SELECT * FROM concept_graph_facts ORDER BY updated_at DESC, id LIMIT ?");
		this.#listLinksForFactStmt = this.#db.prepare(
			"SELECT * FROM concept_graph_links WHERE from_fact_id = ? OR to_fact_id = ? ORDER BY updated_at DESC, id LIMIT ?",
		);
		this.#updateFactStatusStmt = this.#db.prepare(
			"UPDATE concept_graph_facts SET status = ?, superseded_by_fact_id = ?, updated_at = ? WHERE id = ?",
		);
		this.#updateLinkStatusStmt = this.#db.prepare(
			"UPDATE concept_graph_links SET status = ?, updated_at = ? WHERE id = ?",
		);
		this.#countStmt = this.#db.prepare(`
SELECT
	(SELECT COUNT(*) FROM concept_graph_concepts) AS concepts,
	(SELECT COUNT(*) FROM concept_graph_facts) AS facts,
	(SELECT COUNT(*) FROM concept_graph_links) AS links,
	(SELECT COUNT(*) FROM concept_graph_evidence) AS evidence,
	(SELECT COUNT(*) FROM concept_graph_events) AS events
`);

		logger.debug("ConceptGraphStore initialized", { path: dbPath });
	}

	static open(dbPath: string): ConceptGraphStore {
		return new ConceptGraphStore(dbPath);
	}

	close(): void {
		this.#db.close();
	}

	clear(): void {
		this.#db.exec(`
DELETE FROM concept_graph_events;
DELETE FROM concept_graph_links;
DELETE FROM concept_graph_fact_evidence;
DELETE FROM concept_graph_facts;
DELETE FROM concept_graph_evidence;
DELETE FROM concept_graph_concepts;
`);
	}

	upsertConcept(input: ConceptCreateInput, event?: Omit<ConceptGraphEventCreateInput, "targetId" | "kind">): Concept {
		const now = Date.now();
		const concept: Concept = {
			id: input.id ?? crypto.randomUUID(),
			kind: requireAllowed(input.kind, CONCEPT_KINDS, "concept kind"),
			canonicalName: requireNonEmpty(input.canonicalName, "canonicalName"),
			canonicalKey: requireNonEmpty(input.canonicalKey, "canonicalKey"),
			aliases: normalizeStringList(input.aliases ?? []),
			description: input.description ?? null,
			scope: normalizeScope(input.scope),
			status: requireAllowed(input.status ?? "candidate", CONCEPT_STATUSES, "concept status"),
			mergedIntoConceptId: input.mergedIntoConceptId ?? null,
			createdAt: now,
			updatedAt: now,
		};

		const transaction = this.#db.transaction(() => {
			this.#insertConceptStmt.run(
				concept.id,
				concept.kind,
				concept.canonicalName,
				concept.canonicalKey,
				JSON.stringify(concept.aliases),
				concept.description,
				JSON.stringify(concept.scope),
				concept.status,
				concept.mergedIntoConceptId,
				concept.createdAt,
				concept.updatedAt,
			);
			this.#recordEvent({
				kind: event?.activity === "merged" ? "concept_merged" : "concept_proposed",
				targetId: concept.id,
				actor: event?.actor ?? "system",
				activity: event?.activity ?? "upsert concept",
				rationale: event?.rationale ?? "Concept upserted",
				evidenceIds: event?.evidenceIds ?? [],
				createdAt: event?.createdAt,
			});
		});
		transaction();
		return concept;
	}

	upsertEvidence(input: ConceptEvidenceCreateInput): ConceptEvidence {
		const evidence: ConceptEvidence = {
			id: input.id ?? crypto.randomUUID(),
			sourceType: requireAllowed(input.sourceType, EVIDENCE_SOURCE_TYPES, "evidence sourceType"),
			sourceUri: requireNonEmpty(input.sourceUri, "sourceUri"),
			locator: requireNonEmpty(input.locator, "locator"),
			quote: input.quote ?? null,
			summary: requireNonEmpty(input.summary, "summary"),
			extractedBy: requireAllowed(input.extractedBy, EVIDENCE_EXTRACTORS, "evidence extractedBy"),
			extractedAt: input.extractedAt ?? Date.now(),
		};

		this.#insertEvidenceStmt.run(
			evidence.id,
			evidence.sourceType,
			evidence.sourceUri,
			evidence.locator,
			evidence.quote,
			evidence.summary,
			evidence.extractedBy,
			evidence.extractedAt,
		);
		return evidence;
	}

	upsertFact(
		input: ConceptFactCreateInput,
		event?: Omit<ConceptGraphEventCreateInput, "targetId" | "kind">,
	): ConceptFact {
		const evidenceIds = normalizeRequiredIds(input.evidenceIds, "fact evidenceIds");
		for (const evidenceId of evidenceIds) this.#requireEvidence(evidenceId);

		const now = Date.now();
		const fact: ConceptFact = {
			id: input.id ?? crypto.randomUUID(),
			kind: requireAllowed(input.kind, FACT_KINDS, "fact kind"),
			subjectConceptId: input.subjectConceptId ?? null,
			claim: requireNonEmpty(input.claim, "claim"),
			normalizedClaim: requireNonEmpty(input.normalizedClaim ?? normalizeClaim(input.claim), "normalizedClaim"),
			scope: normalizeScope(input.scope),
			status: requireAllowed(input.status ?? "candidate", FACT_STATUSES, "fact status"),
			authority: requireAllowed(input.authority, FACT_AUTHORITIES, "fact authority"),
			confidence: requireAllowed(input.confidence, CONFIDENCE_LEVELS, "fact confidence"),
			sensitivity: requireAllowed(input.sensitivity ?? "project", SENSITIVITY_LEVELS, "fact sensitivity"),
			ownerRef: input.ownerRef ?? null,
			validFrom: input.validFrom ?? null,
			validUntil: input.validUntil ?? null,
			supersededByFactId: input.supersededByFactId ?? null,
			createdAt: now,
			updatedAt: now,
		};
		const evidenceRole = requireAllowed(input.evidenceRole ?? "source", FACT_EVIDENCE_ROLES, "fact evidence role");

		const transaction = this.#db.transaction(() => {
			this.#insertFactStmt.run(
				fact.id,
				fact.kind,
				fact.subjectConceptId,
				fact.claim,
				fact.normalizedClaim,
				JSON.stringify(fact.scope),
				fact.status,
				fact.authority,
				fact.confidence,
				fact.sensitivity,
				fact.ownerRef,
				fact.validFrom,
				fact.validUntil,
				fact.supersededByFactId,
				fact.createdAt,
				fact.updatedAt,
			);
			for (const evidenceId of evidenceIds) this.#insertFactEvidenceStmt.run(fact.id, evidenceId, evidenceRole);
			this.#recordEvent({
				kind: fact.status === "active" ? "fact_promoted" : "fact_proposed",
				targetId: fact.id,
				actor: event?.actor ?? "system",
				activity: event?.activity ?? "upsert fact",
				rationale: event?.rationale ?? "Fact upserted",
				evidenceIds,
				createdAt: event?.createdAt,
			});
		});
		transaction();
		return fact;
	}

	upsertLink(
		input: ConceptLinkCreateInput,
		event?: Omit<ConceptGraphEventCreateInput, "targetId" | "kind">,
	): ConceptLink {
		const evidenceIds = normalizeRequiredIds(input.evidenceIds, "link evidenceIds");
		for (const evidenceId of evidenceIds) this.#requireEvidence(evidenceId);
		this.#requireFact(input.fromFactId);
		this.#requireFact(input.toFactId);

		const now = Date.now();
		const link: ConceptLink = {
			id: input.id ?? crypto.randomUUID(),
			fromFactId: requireNonEmpty(input.fromFactId, "fromFactId"),
			toFactId: requireNonEmpty(input.toFactId, "toFactId"),
			kind: requireAllowed(input.kind, LINK_KINDS, "link kind"),
			status: requireAllowed(input.status ?? "candidate", LINK_STATUSES, "link status"),
			confidence: requireAllowed(input.confidence, CONFIDENCE_LEVELS, "link confidence"),
			rationale: requireNonEmpty(input.rationale, "rationale"),
			evidenceIds,
			createdAt: now,
			updatedAt: now,
		};

		const transaction = this.#db.transaction(() => {
			this.#insertLinkStmt.run(
				link.id,
				link.fromFactId,
				link.toFactId,
				link.kind,
				link.status,
				link.confidence,
				link.rationale,
				JSON.stringify(link.evidenceIds),
				link.createdAt,
				link.updatedAt,
			);
			this.#recordEvent({
				kind: link.status === "active" ? "link_promoted" : "link_proposed",
				targetId: link.id,
				actor: event?.actor ?? "system",
				activity: event?.activity ?? "upsert link",
				rationale: event?.rationale ?? "Link upserted",
				evidenceIds,
				createdAt: event?.createdAt,
			});
		});
		transaction();
		return link;
	}

	updateFactStatus(
		factId: string,
		status: FactStatus,
		options: {
			supersededByFactId?: string | null;
			rationale: string;
			actor?: ConceptGraphEvent["actor"];
			evidenceIds?: string[];
		},
	): ConceptFact {
		const existing = this.getFact(factId);
		if (!existing) throw new Error(`Concept graph fact not found: ${factId}`);
		const normalizedStatus = requireAllowed(status, FACT_STATUSES, "fact status");
		if (options.supersededByFactId) this.#requireFact(options.supersededByFactId);
		const now = Date.now();
		const eventKind = factEventKindForStatus(normalizedStatus);
		const transaction = this.#db.transaction(() => {
			this.#updateFactStatusStmt.run(
				normalizedStatus,
				options.supersededByFactId ?? existing.supersededByFactId,
				now,
				factId,
			);
			this.#recordEvent({
				kind: eventKind,
				targetId: factId,
				actor: options.actor ?? "llm",
				activity: `mark fact ${normalizedStatus}`,
				rationale: options.rationale,
				evidenceIds: options.evidenceIds ?? [],
				createdAt: now,
			});
		});
		transaction();
		const updated = this.getFact(factId);
		if (!updated) throw new Error(`Concept graph fact disappeared after update: ${factId}`);
		return updated;
	}

	updateLinkStatus(
		linkId: string,
		status: ConceptLinkStatus,
		options: { rationale: string; actor?: ConceptGraphEvent["actor"]; evidenceIds?: string[] },
	): ConceptLink {
		const existing = this.getLink(linkId);
		if (!existing) throw new Error(`Concept graph link not found: ${linkId}`);
		const normalizedStatus = requireAllowed(status, LINK_STATUSES, "link status");
		const now = Date.now();
		const transaction = this.#db.transaction(() => {
			this.#updateLinkStatusStmt.run(normalizedStatus, now, linkId);
			this.#recordEvent({
				kind: normalizedStatus === "active" ? "link_promoted" : "link_retired",
				targetId: linkId,
				actor: options.actor ?? "llm",
				activity: `mark link ${normalizedStatus}`,
				rationale: options.rationale,
				evidenceIds: options.evidenceIds ?? [],
				createdAt: now,
			});
		});
		transaction();
		const updated = this.getLink(linkId);
		if (!updated) throw new Error(`Concept graph link disappeared after update: ${linkId}`);
		return updated;
	}

	recordEvent(input: ConceptGraphEventCreateInput): ConceptGraphEvent {
		return this.#recordEvent(input);
	}

	getConcept(id: string): Concept | null {
		const row = this.#getConceptStmt.get(id) as ConceptRow | undefined;
		return row ? conceptFromRow(row) : null;
	}

	getFact(id: string): ConceptFact | null {
		const row = this.#getFactStmt.get(id) as FactRow | undefined;
		return row ? factFromRow(row) : null;
	}

	getEvidence(id: string): ConceptEvidence | null {
		const row = this.#getEvidenceStmt.get(id) as EvidenceRow | undefined;
		return row ? evidenceFromRow(row) : null;
	}

	getLink(id: string): ConceptLink | null {
		const row = this.#getLinkStmt.get(id) as LinkRow | undefined;
		return row ? linkFromRow(row) : null;
	}

	listFacts(limit = 50): ConceptFact[] {
		const rows = this.#listFactsStmt.all(limit) as FactRow[];
		return rows.map(factFromRow);
	}

	listFactEvidence(factId: string): ConceptFactEvidence[] {
		const rows = this.#listFactEvidenceStmt.all(factId) as Array<{
			fact_id: string;
			evidence_id: string;
			role: FactEvidenceRole;
		}>;
		return rows.map(row => ({ factId: row.fact_id, evidenceId: row.evidence_id, role: row.role }));
	}

	listLinksForFact(factId: string, limit = 50): ConceptLink[] {
		const rows = this.#listLinksForFactStmt.all(factId, factId, limit) as LinkRow[];
		return rows.map(linkFromRow);
	}

	counts(): ConceptGraphCounts {
		return this.#countStmt.get() as ConceptGraphCounts;
	}

	#initializeSchema(): void {
		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS concept_graph_concepts (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	canonical_name TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	aliases_json TEXT NOT NULL DEFAULT '[]',
	description TEXT,
	scope_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL,
	merged_into_concept_id TEXT,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_graph_concepts_key ON concept_graph_concepts(canonical_key);
CREATE INDEX IF NOT EXISTS idx_concept_graph_concepts_status ON concept_graph_concepts(status);

CREATE TABLE IF NOT EXISTS concept_graph_evidence (
	id TEXT PRIMARY KEY,
	source_type TEXT NOT NULL,
	source_uri TEXT NOT NULL,
	locator TEXT NOT NULL,
	quote TEXT,
	summary TEXT NOT NULL,
	extracted_by TEXT NOT NULL,
	extracted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concept_graph_evidence_source ON concept_graph_evidence(source_type, source_uri);

CREATE TABLE IF NOT EXISTS concept_graph_facts (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	subject_concept_id TEXT,
	claim TEXT NOT NULL,
	normalized_claim TEXT NOT NULL,
	scope_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL,
	authority TEXT NOT NULL,
	confidence TEXT NOT NULL,
	sensitivity TEXT NOT NULL,
	owner_ref TEXT,
	valid_from TEXT,
	valid_until TEXT,
	superseded_by_fact_id TEXT,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	FOREIGN KEY(subject_concept_id) REFERENCES concept_graph_concepts(id),
	FOREIGN KEY(superseded_by_fact_id) REFERENCES concept_graph_facts(id)
);
CREATE INDEX IF NOT EXISTS idx_concept_graph_facts_subject ON concept_graph_facts(subject_concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_graph_facts_status ON concept_graph_facts(status);
CREATE INDEX IF NOT EXISTS idx_concept_graph_facts_authority ON concept_graph_facts(authority);
CREATE INDEX IF NOT EXISTS idx_concept_graph_facts_normalized ON concept_graph_facts(normalized_claim);

CREATE TABLE IF NOT EXISTS concept_graph_fact_evidence (
	fact_id TEXT NOT NULL,
	evidence_id TEXT NOT NULL,
	role TEXT NOT NULL,
	PRIMARY KEY (fact_id, evidence_id, role),
	FOREIGN KEY(fact_id) REFERENCES concept_graph_facts(id) ON DELETE CASCADE,
	FOREIGN KEY(evidence_id) REFERENCES concept_graph_evidence(id)
);
CREATE INDEX IF NOT EXISTS idx_concept_graph_fact_evidence_evidence ON concept_graph_fact_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS concept_graph_links (
	id TEXT PRIMARY KEY,
	from_fact_id TEXT NOT NULL,
	to_fact_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	status TEXT NOT NULL,
	confidence TEXT NOT NULL,
	rationale TEXT NOT NULL,
	evidence_ids_json TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	FOREIGN KEY(from_fact_id) REFERENCES concept_graph_facts(id),
	FOREIGN KEY(to_fact_id) REFERENCES concept_graph_facts(id)
);
CREATE INDEX IF NOT EXISTS idx_concept_graph_links_from ON concept_graph_links(from_fact_id);
CREATE INDEX IF NOT EXISTS idx_concept_graph_links_to ON concept_graph_links(to_fact_id);
CREATE INDEX IF NOT EXISTS idx_concept_graph_links_kind ON concept_graph_links(kind);
CREATE INDEX IF NOT EXISTS idx_concept_graph_links_status ON concept_graph_links(status);

CREATE TABLE IF NOT EXISTS concept_graph_events (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	target_id TEXT NOT NULL,
	actor TEXT NOT NULL,
	activity TEXT NOT NULL,
	rationale TEXT NOT NULL,
	evidence_ids_json TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
CREATE INDEX IF NOT EXISTS idx_concept_graph_events_target ON concept_graph_events(target_id);
CREATE INDEX IF NOT EXISTS idx_concept_graph_events_created ON concept_graph_events(created_at);
`);
	}

	#recordEvent(input: ConceptGraphEventCreateInput): ConceptGraphEvent {
		const event: ConceptGraphEvent = {
			id: input.id ?? crypto.randomUUID(),
			kind: requireAllowed(input.kind, GRAPH_EVENT_KINDS, "event kind"),
			targetId: requireNonEmpty(input.targetId, "targetId"),
			actor: requireAllowed(input.actor, GRAPH_EVENT_ACTORS, "event actor"),
			activity: requireNonEmpty(input.activity, "activity"),
			rationale: requireNonEmpty(input.rationale, "rationale"),
			evidenceIds: normalizeStringList(input.evidenceIds ?? []),
			createdAt: input.createdAt ?? Date.now(),
		};
		this.#insertEventStmt.run(
			event.id,
			event.kind,
			event.targetId,
			event.actor,
			event.activity,
			event.rationale,
			JSON.stringify(event.evidenceIds),
			event.createdAt,
		);
		return event;
	}

	#requireEvidence(id: string): void {
		if (!this.getEvidence(id)) throw new Error(`Concept graph evidence not found: ${id}`);
	}

	#requireFact(id: string): void {
		if (!this.getFact(id)) throw new Error(`Concept graph fact not found: ${id}`);
	}
}

function conceptFromRow(row: ConceptRow): Concept {
	return {
		id: row.id,
		kind: row.kind,
		canonicalName: row.canonical_name,
		canonicalKey: row.canonical_key,
		aliases: parseStringArray(row.aliases_json),
		description: row.description,
		scope: parseScope(row.scope_json),
		status: row.status,
		mergedIntoConceptId: row.merged_into_concept_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function factFromRow(row: FactRow): ConceptFact {
	return {
		id: row.id,
		kind: row.kind,
		subjectConceptId: row.subject_concept_id,
		claim: row.claim,
		normalizedClaim: row.normalized_claim,
		scope: parseScope(row.scope_json),
		status: row.status,
		authority: row.authority,
		confidence: row.confidence,
		sensitivity: row.sensitivity,
		ownerRef: row.owner_ref,
		validFrom: row.valid_from,
		validUntil: row.valid_until,
		supersededByFactId: row.superseded_by_fact_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function factEventKindForStatus(status: FactStatus): ConceptGraphEvent["kind"] {
	switch (status) {
		case "active":
			return "fact_promoted";
		case "disputed":
			return "fact_disputed";
		case "superseded":
			return "fact_superseded";
		case "retired":
			return "fact_retired";
		case "erased":
			return "fact_erased";
		default:
			return "fact_updated";
	}
}

function linkFromRow(row: LinkRow): ConceptLink {
	return {
		id: row.id,
		fromFactId: row.from_fact_id,
		toFactId: row.to_fact_id,
		kind: row.kind,
		status: row.status,
		confidence: row.confidence,
		rationale: row.rationale,
		evidenceIds: parseStringArray(row.evidence_ids_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function evidenceFromRow(row: EvidenceRow): ConceptEvidence {
	return {
		id: row.id,
		sourceType: row.source_type,
		sourceUri: row.source_uri,
		locator: row.locator,
		quote: row.quote,
		summary: row.summary,
		extractedBy: row.extracted_by,
		extractedAt: row.extracted_at,
	};
}

function normalizeClaim(claim: string): string {
	return claim.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeScope(scope: ConceptScope | undefined): ConceptScope {
	if (!scope) return {};
	const normalized: ConceptScope = {};
	if (scope.repo) normalized.repo = scope.repo;
	if (scope.package) normalized.package = scope.package;
	if (scope.session) normalized.session = scope.session;
	if (scope.path) normalized.path = scope.path;
	return normalized;
}

function normalizeStringList(values: string[]): string[] {
	return Array.from(new Set(values.map(value => value.trim()).filter(Boolean))).sort();
}

function normalizeRequiredIds(values: string[], label: string): string[] {
	const normalized = normalizeStringList(values);
	if (normalized.length === 0) throw new Error(`${label} must contain at least one id`);
	return normalized;
}

function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required`);
	return trimmed;
}

function requireAllowed<T extends string>(value: string, allowed: readonly T[], label: string): T {
	if (allowed.includes(value as T)) return value as T;
	throw new Error(`Invalid ${label}: ${value}`);
}

function parseStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

function parseScope(value: string): ConceptScope {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const scope: ConceptScope = {};
		if (typeof record.repo === "string") scope.repo = record.repo;
		if (typeof record.package === "string") scope.package = record.package;
		if (typeof record.session === "string") scope.session = record.session;
		if (typeof record.path === "string") scope.path = record.path;
		return scope;
	} catch {
		return {};
	}
}

export function openConceptGraphStore(dbPath: string): ConceptGraphStore {
	return ConceptGraphStore.open(dbPath);
}
