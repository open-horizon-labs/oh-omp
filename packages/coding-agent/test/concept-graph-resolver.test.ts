import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedConceptFact } from "../src/concept-graph";
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
	// share domain-ubiquitous words (context, fact, memory, session). Without
	// this frequency signal a tiny corpus cannot exercise IDF — "context" and
	// "dogfood" would have identical document frequency. Keep "concept graph"
	// comparatively rarer so legitimate phrase matches still contain an
	// informative term, while generic context-only queries remain excluded.
	const fillerClaims = [
		"The context store records each fact node in the system memory layer.",
		"Every fact links memory, context, and project session metadata.",
		"The system models context using durable facts and memory nodes.",
		"Agent tooling reads fact context from the project memory store.",
		"Agent context and session facts share the same memory system.",
		"The fact store keeps context, memory, and session vocabulary.",
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
describe("scorer precision for global graph bleed", () => {
	function seedScoringFact(id: string, claim: string, authority: "adr" | "llm_inferred" = "llm_inferred"): void {
		store.upsertFact({
			id,
			kind: "definition",
			claim,
			status: "active",
			authority,
			confidence: authority === "adr" ? "high" : "medium",
			evidenceIds: ["evidence-1"],
		});
	}

	function seedPrecisionFixtures(): void {
		seedScoringFact(
			"offender-turn-alias",
			"Byzantine delegated-authority turn alias scoping: aliases exist only within the last turn",
		);
		seedScoringFact(
			"offender-rollups",
			"Matrice commitment slice reports cross-project rollups; the last slice covers all projects",
		);
		seedScoringFact(
			"offender-proceed",
			"Unrelated approval workflow can continue and proceed after the external handoff.",
		);
		seedScoringFact(
			"legit-concept-cap",
			"Concept graph injection is capped at 6 facts and routed through the single assembler",
			"adr",
		);
		seedScoringFact(
			"legit-concept-scoring",
			"The concept graph resolver uses deterministic phrase-aware scoring",
			"adr",
		);
	}

	function expectNoOffenders(results: ResolvedConceptFact[]): void {
		const ids = results.map(result => result.fact.id);
		expect(ids).not.toContain("offender-turn-alias");
		expect(ids).not.toContain("offender-rollups");
		expect(ids).not.toContain("offender-proceed");
	}

	test("ignores unrelated stage/subtask wording instead of importing cross-project facts", () => {
		seedPrecisionFixtures();

		const results = searchConceptFacts(store, { query: "stage C in a subtask, review with superego" });

		expectNoOffenders(results);
	});

	test("ignores conversational prose that overlaps only weak resolver terms", () => {
		seedPrecisionFixtures();

		const results = searchConceptFacts(store, {
			query: "models often respond with walls of text, I would like to explore more efficient modes of communication",
		});

		expectNoOffenders(results);
	});

	test("does not qualify offenders through phrase-only overlap of non-informative tokens", () => {
		seedPrecisionFixtures();
		const results = searchConceptFacts(store, { query: "what happened last turn" });

		// Defends against the loophole where phrase-only overlap of non-informative
		// tokens ("last turn") bypasses stopword and corpus-IDF gates.
		expectNoOffenders(results);
		expect(results.map(result => result.reason).join("\n")).not.toContain('phrase "last turn" matched');
	});

	test("does not qualify stopword plus informative bigram overlap", () => {
		seedPrecisionFixtures();
		const results = searchConceptFacts(store, { query: "lets see how it looks and proceed to stage B" });

		// Defends the stopword+informative bigram class by mechanism: any phrase
		// containing a stopword is ineligible, so this does not rely on a phrase
		// blocklist and still passes if such a blocklist is deleted.
		expectNoOffenders(results);
		expect(results.map(result => result.reason).join("\n")).not.toContain('phrase "and proceed" matched');
	});

	test("keeps concept graph phrase matches while excluding unrelated offender facts", () => {
		seedPrecisionFixtures();

		const results = searchConceptFacts(store, {
			query: "constrain the concept graph context injection to relevant facts",
		});
		const ids = results.map(result => result.fact.id);

		expect(ids).toContain("legit-concept-cap");
		expect(ids).toContain("legit-concept-scoring");
		expectNoOffenders(results);
		expect(results.find(result => result.fact.id === "legit-concept-cap")?.reason).toContain(
			'phrase "concept graph" matched',
		);
		expect(results.find(result => result.fact.id === "legit-concept-cap")?.reason).not.toContain(
			'phrase "the concept graph" matched',
		);
	});

	// Adversarial by construction: "cross" and "projects" are weak but are not
	// stopwords. They are made corpus-common so a stopword-list-only patch would
	// still return offender-rollups here, while IDF precision excludes it.
	test("corpus-common non-stopword overlaps cannot select a cross-project offender", () => {
		seedPrecisionFixtures();
		for (let i = 0; i < 8; i++) {
			seedScoringFact(`weak-cross-project-${i}`, `Cross team projects publish the last summary marker ${i}.`);
		}

		const results = searchConceptFacts(store, { query: "cross projects last" });

		expectNoOffenders(results);
	});

	test("one genuinely rare term is excluded without a phrase or second informative term", () => {
		seedScoringFact("single-rare-tokenizer", "Tokenizer boundary rules normalize subword separators.");

		const results = searchConceptFacts(store, { query: "tokenizer" });

		expect(results.map(result => result.fact.id)).not.toContain("single-rare-tokenizer");
	});
});

describe("stopword and IDF-threshold relevance", () => {
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
