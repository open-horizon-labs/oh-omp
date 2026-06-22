import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ConceptGraphStore,
	formatResolvedConceptNeighbors,
	resolveConceptContext,
	resolveConceptNeighbors,
	searchConceptFacts,
} from "../src/concept-graph";
import { resolveConceptGraphInjection } from "../src/context/concept-graph-context";

let rootDir: string;
let store: ConceptGraphStore;

beforeEach(() => {
	rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "concept-graph-resolver-"));
	store = ConceptGraphStore.open(path.join(rootDir, "concept-graph.db"));
	const evidence = store.upsertEvidence({
		id: "evidence-1",
		sourceType: "adr",
		sourceUri: "docs/adr/0006-concept-graph-fact-store.md",
		locator: "docs/adr/0006-concept-graph-fact-store.md#Context Assembly Policy",
		summary: "Concept graph dogfood injection is bounded and inspectable.",
		extractedBy: "system",
	});
	store.upsertFact({
		id: "fact-dogfood",
		kind: "decision",
		claim: "Concept graph dogfood injection starts from day one.",
		status: "active",
		authority: "adr",
		confidence: "high",
		evidenceIds: [evidence.id],
	});
	store.upsertFact({
		id: "fact-inspection",
		kind: "constraint",
		claim: "Injected concept context must be tiny and inspectable.",
		status: "active",
		authority: "adr",
		confidence: "high",
		evidenceIds: [evidence.id],
	});
	store.upsertFact({
		id: "fact-candidate",
		kind: "assumption",
		claim: "Candidate graph uncertainty can be included only when relevant.",
		status: "candidate",
		authority: "llm_inferred",
		confidence: "medium",
		evidenceIds: [evidence.id],
	});
	store.upsertLink({
		id: "link-inspection-supports-dogfood",
		fromFactId: "fact-inspection",
		toFactId: "fact-dogfood",
		kind: "supports",
		status: "active",
		confidence: "high",
		rationale: "Inspectability bounds make day-one dogfood injection safe enough.",
		evidenceIds: [evidence.id],
	});
	store.upsertFact({
		id: "fact-disputed-policy",
		kind: "constraint",
		claim: "Concept graph dogfood injection should be delayed until shadow mode completes.",
		status: "disputed",
		authority: "system_policy",
		confidence: "high",
		evidenceIds: [evidence.id],
	});
	store.upsertLink({
		id: "link-retired-conflict",
		fromFactId: "fact-disputed-policy",
		toFactId: "fact-dogfood",
		kind: "contradicts",
		status: "retired",
		confidence: "high",
		rationale: "Historical shadow-mode conflict was retired after dogfood-first decision.",
		evidenceIds: [evidence.id],
	});

		// Generic-vocabulary filler: a realistic concept graph has many facts that
		// share domain-ubiquitous words (concept, context, graph, fact, memory,
		// session). Without this frequency signal a tiny corpus cannot exercise
		// IDF — "context" and "dogfood" would have identical document frequency.
		// These facts contain only generic terms, so the relevance floor excludes
		// them from every query result; they exist solely to make generic words
		// common, the way they are in a real graph.
		const fillerClaims = [
			"The concept graph stores each concept and context as a fact node in the system.",
			"Every concept graph fact links memory, context, and project session metadata.",
			"The system models concept context using graph facts and memory nodes.",
			"Concept graph tooling reads fact context from the project memory store.",
			"Agent context and concept facts share the same graph memory system.",
			"The concept graph fact store keeps context, memory, and session vocabulary.",
		];
		for (const [i, claim] of fillerClaims.entries()) {
			store.upsertFact({
				id: `filler-${i}`,
				kind: "definition",
				claim,
				status: "active",
				authority: "llm_inferred",
				confidence: "low",
				evidenceIds: [evidence.id],
			});
		}
});

afterEach(() => {
	store.close();
	fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("concept graph resolver", () => {
	test("search returns active facts by default and can include candidates", () => {
		expect(
			searchConceptFacts(store, { query: "candidate uncertainty", includeCandidates: false }).map(
				result => result.fact.id,
			),
		).toEqual([]);
		expect(
			searchConceptFacts(store, { query: "candidate uncertainty", includeCandidates: true }).map(
				result => result.fact.id,
			),
		).toEqual(["fact-candidate"]);
	});

	test("boosts exact phrase matches and reports matched phrases", () => {
		const results = searchConceptFacts(store, { query: "dogfood injection", includeCandidates: false });

		expect(results[0]?.fact.id).toBe("fact-dogfood");
		expect(results[0]?.reason).toContain('phrase "dogfood injection" matched');
	});

	test("does not match facts on generic graph vocabulary alone", () => {
		expect(searchConceptFacts(store, { query: "context", includeCandidates: false })).toEqual([]);
	});

	test("resolves a tiny linked context block with provenance handles", () => {
		const context = resolveConceptContext(store, {
			task: "Implement dogfood injection with inspectable concept context",
			maxFacts: 2,
			maxLinks: 2,
			includeCandidates: "none",
		});

		expect(context.facts.map(result => result.fact.id)).toContain("fact-dogfood");
		expect(context.facts.map(result => result.fact.id)).toContain("fact-inspection");
		expect(context.links.map(result => result.link.id)).toEqual(["link-inspection-supports-dogfood"]);
		expect(context.markdown).toContain("## Concept Graph Context");
		expect(context.markdown).toContain("[active][decision][adr]");
		expect(context.tokenEstimate).toBeGreaterThan(0);
	});

	test("orders active facts before disputed facts and omits retired conflicts", () => {
		const context = resolveConceptContext(store, {
			task: "dogfood injection concept graph",
			maxFacts: 3,
			maxLinks: 5,
			includeCandidates: "relevant-uncertainty",
		});

		expect(context.facts[0].fact.status).toBe("active");
		expect(context.conflicts.map(result => result.link.id)).not.toContain("link-retired-conflict");
		expect(context.markdown).not.toContain("Historical shadow-mode conflict");
	});

	test("resolves bounded incoming neighbors for a fact", () => {
		const neighbors = resolveConceptNeighbors(store, {
			factId: "fact-dogfood",
			depth: 1,
			limit: 5,
			direction: "incoming",
			includeCandidates: "none",
		});

		expect(neighbors?.root.id).toBe("fact-dogfood");
		expect(neighbors?.facts.map(fact => fact.id)).toEqual(["fact-inspection"]);
		expect(neighbors?.links.map(result => result.link.id)).toEqual(["link-inspection-supports-dogfood"]);
		expect(neighbors?.markdown).toContain("## Concept Graph Neighbors");
		expect(neighbors ? formatResolvedConceptNeighbors(neighbors) : "").toContain("Neighbor: fact-inspection");
	});

	test("respects neighbor direction filters", () => {
		const incoming = resolveConceptNeighbors(store, {
			factId: "fact-dogfood",
			direction: "incoming",
			includeCandidates: "none",
		});
		const outgoing = resolveConceptNeighbors(store, {
			factId: "fact-dogfood",
			direction: "outgoing",
			includeCandidates: "none",
		});

		expect(incoming?.links).toHaveLength(1);
		expect(outgoing?.links).toHaveLength(0);
	});

	test("formats bounded inspectable context for assembler injection", () => {
		const injection = resolveConceptGraphInjection(store, {
			task: "Implement dogfood injection with inspectable concept context",
			maxFacts: 2,
			maxLinks: 2,
			maxTokens: 1_200,
			includeCandidates: "none",
		});

		expect(injection).not.toBeNull();
		expect(injection?.text).toContain("<concept_graph_context>");
		expect(injection?.text).toContain("concept_graph: explain_fact");
		expect(injection?.factIds).toContain("fact-dogfood");
		expect(injection?.linkIds).toEqual(["link-inspection-supports-dogfood"]);
		expect(injection?.tokenEstimate).toBeLessThanOrEqual(1_200);
	});

	test("drops oversized concept graph injection instead of exceeding cap", () => {
		const injection = resolveConceptGraphInjection(store, {
			task: "Implement dogfood injection with inspectable concept context",
			maxFacts: 2,
			maxLinks: 2,
			maxTokens: 1,
			includeCandidates: "none",
		});

		expect(injection).toBeNull();
	});
});


describe("IDF relevance (no hardcoded stopwords)", () => {
	function seedFact(id: string, claim: string): void {
		store.upsertFact({
			id,
			kind: "definition",
			claim,
			status: "active",
			authority: "llm_inferred",
			confidence: "medium",
			evidenceIds: ["evidence-1"],
		});
	}

	// Adversarial: "pipeline" is common only by CORPUS frequency, not because it
	// is a known stopword. A hand-maintained word list would never contain it,
	// so this fails any "just expand GENERIC_TOKENS" patch.
	test("a token ubiquitous in the corpus cannot surface a fact on its own", () => {
		for (let i = 0; i < 6; i++) seedFact(`pipe-${i}`, `The data pipeline stage ${i} runs and then exits.`);
		seedFact("pipe-kafka", "The data pipeline stage uses kafka for streaming.");
		const results = searchConceptFacts(store, { query: "pipeline" });
		expect(results.every(r => !r.fact.id.startsWith("pipe-"))).toBe(true);
	});

	test("a distinctive rare token surfaces its fact and is named as the reason", () => {
		for (let i = 0; i < 6; i++) seedFact(`pipe-${i}`, `The data pipeline stage ${i} runs and then exits.`);
		seedFact("pipe-kafka", "The data pipeline stage uses kafka for streaming.");
		const results = searchConceptFacts(store, { query: "kafka streaming" });
		expect(results[0]?.fact.id).toBe("pipe-kafka");
		expect(results[0]?.reason).toContain("kafka");
	});
});