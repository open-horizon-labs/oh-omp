import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConceptGraphStore, type ConceptLinkKind } from "../src/concept-graph";

let store: ConceptGraphStore;
let dbPath: string;

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concept-graph-store-"));
	dbPath = path.join(dir, "concept-graph.db");
	store = ConceptGraphStore.open(dbPath);
});

afterEach(() => {
	store.close();
	fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe("ConceptGraphStore", () => {
	test("persists concepts, evidence, facts, links, and graph events", () => {
		const concept = store.upsertConcept({
			id: "concept-graph",
			kind: "feature",
			canonicalName: "Concept Graph",
			canonicalKey: "feature:concept-graph",
			aliases: ["knowledge graph", "conceptual fact store", "knowledge graph"],
			status: "active",
		});
		const evidence = store.upsertEvidence({
			id: "evidence-1",
			sourceType: "oh_session",
			sourceUri: ".oh/conceptual-fact-store.md",
			locator: ".oh/conceptual-fact-store.md#Dissent",
			summary: "The dissent accepted a concept graph seed slice.",
			extractedBy: "deterministic_parser",
		});
		const fact = store.upsertFact({
			id: "fact-1",
			kind: "decision",
			subjectConceptId: concept.id,
			claim: "The first implementation is the Concept Graph Seed Slice.",
			status: "active",
			authority: "current_session_artifact",
			confidence: "high",
			evidenceIds: [evidence.id],
		});
		const supportingFact = store.upsertFact({
			id: "fact-2",
			kind: "constraint",
			subjectConceptId: concept.id,
			claim: "Concept graph injection must remain tiny and inspectable.",
			status: "candidate",
			authority: "session_artifact",
			confidence: "medium",
			evidenceIds: [evidence.id],
		});
		const link = store.upsertLink({
			id: "link-1",
			fromFactId: supportingFact.id,
			toFactId: fact.id,
			kind: "supports",
			status: "candidate",
			confidence: "medium",
			rationale: "The bounded injection constraint supports the seed-slice decision.",
			evidenceIds: [evidence.id],
		});

		expect(store.getConcept(concept.id)?.aliases).toEqual(["conceptual fact store", "knowledge graph"]);
		expect(store.getFact(fact.id)?.normalizedClaim).toBe("the first implementation is the concept graph seed slice.");
		expect(store.getEvidence(evidence.id)?.locator).toBe(".oh/conceptual-fact-store.md#Dissent");
		expect(store.getLink(link.id)?.kind).toBe("supports");
		expect(store.listFactEvidence(fact.id)).toEqual([{ factId: "fact-1", evidenceId: "evidence-1", role: "source" }]);
		expect(store.listLinksForFact(fact.id).map(row => row.id)).toEqual(["link-1"]);
		expect(store.counts()).toMatchObject({ concepts: 1, facts: 2, links: 1, evidence: 1, events: 4 });
	});

	test("rejects facts and links without persisted evidence", () => {
		expect(() =>
			store.upsertFact({
				kind: "constraint",
				claim: "Every fact must cite evidence.",
				authority: "llm_inferred",
				confidence: "high",
				evidenceIds: [],
			}),
		).toThrow("fact evidenceIds must contain at least one id");

		const evidence = store.upsertEvidence({
			id: "evidence-1",
			sourceType: "adr",
			sourceUri: "docs/adr/0006-concept-graph-fact-store.md",
			locator: "docs/adr/0006-concept-graph-fact-store.md#Guardrails",
			summary: "Facts and links must cite evidence.",
			extractedBy: "system",
		});
		const fact = store.upsertFact({
			id: "fact-1",
			kind: "constraint",
			claim: "Every fact and link must cite evidence.",
			authority: "adr",
			confidence: "high",
			evidenceIds: [evidence.id],
		});

		expect(() =>
			store.upsertLink({
				fromFactId: fact.id,
				toFactId: fact.id,
				kind: "supports",
				confidence: "medium",
				rationale: "Self-supporting test link without evidence must fail.",
				evidenceIds: [],
			}),
		).toThrow("link evidenceIds must contain at least one id");
	});

	test("rejects generic related links", () => {
		const evidence = store.upsertEvidence({
			id: "evidence-1",
			sourceType: "adr",
			sourceUri: "docs/adr/0006-concept-graph-fact-store.md",
			locator: "docs/adr/0006-concept-graph-fact-store.md#Guardrails",
			summary: "The v1 schema excludes related_to links.",
			extractedBy: "system",
		});
		const factA = store.upsertFact({
			id: "fact-a",
			kind: "constraint",
			claim: "The v1 schema excludes generic related links.",
			authority: "adr",
			confidence: "high",
			evidenceIds: [evidence.id],
		});
		const factB = store.upsertFact({
			id: "fact-b",
			kind: "constraint",
			claim: "Every link must have a precise allowlisted type.",
			authority: "adr",
			confidence: "high",
			evidenceIds: [evidence.id],
		});
		const invalidKind = "related_to" as unknown as ConceptLinkKind;

		expect(() =>
			store.upsertLink({
				fromFactId: factA.id,
				toFactId: factB.id,
				kind: invalidKind,
				confidence: "low",
				rationale: "Vague relatedness should not be accepted.",
				evidenceIds: [evidence.id],
			}),
		).toThrow("Invalid link kind: related_to");
	});
});
