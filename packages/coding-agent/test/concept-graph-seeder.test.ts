import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConceptGraphStore } from "../src/concept-graph";
import {
	type ConceptGraphSeedExtractor,
	parseOhSessionSections,
	seedConceptGraphFromOhArtifacts,
} from "../src/concept-graph/seeder";

let rootDir: string;
let store: ConceptGraphStore;

beforeEach(() => {
	rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "concept-graph-seeder-"));
	store = ConceptGraphStore.open(path.join(rootDir, "concept-graph.db"));
});

afterEach(() => {
	store.close();
	fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("concept graph seeder", () => {
	test("parses nested markdown sections with provenance locators", () => {
		const sections = parseOhSessionSections(
			[
				"# Title",
				"ignored intro",
				"## Dissent",
				"Decision content",
				"### Accepted Defaults",
				"Default content",
			].join("\n"),
			".oh/example.md",
		);

		expect(sections.map(section => section.headingPath)).toEqual([
			["Title"],
			["Title", "Dissent"],
			["Title", "Dissent", "Accepted Defaults"],
		]);
		expect(sections[1].locator).toBe(".oh/example.md#title/dissent");
		expect(sections[2].promotable).toBe(false);
	});

	test("seeds candidates from .oh markdown through an extractor patch", async () => {
		const ohDir = path.join(rootDir, ".oh");
		fs.mkdirSync(ohDir, { recursive: true });
		fs.writeFileSync(
			path.join(ohDir, "conceptual-fact-store.md"),
			[
				"## Dissent",
				"The concept graph seed slice should inject tiny inspectable context from day one.",
				"It supersedes the older shadow-mode hedge.",
			].join("\n"),
		);
		const extractor: ConceptGraphSeedExtractor = {
			async extract(section) {
				expect(section.locator).toBe(".oh/conceptual-fact-store.md#dissent");
				return {
					concepts: [
						{
							localId: "concept-graph",
							kind: "feature",
							canonicalName: "Concept Graph",
							canonicalKey: "feature:concept-graph",
							status: "active",
						},
					],
					facts: [
						{
							localId: "dogfood",
							kind: "decision",
							subjectConceptLocalId: "concept-graph",
							claim: "Dogfood injection starts from day one.",
							confidence: "high",
						},
						{
							localId: "inspectable",
							kind: "constraint",
							subjectConceptLocalId: "concept-graph",
							claim: "Injected concept context must be tiny and inspectable.",
							confidence: "high",
						},
					],
					links: [
						{
							localId: "inspectable-supports-dogfood",
							fromFactLocalId: "inspectable",
							toFactLocalId: "dogfood",
							kind: "supports",
							confidence: "medium",
							rationale: "Inspection bounds make day-one dogfood safe enough.",
						},
					],
					ignored: [],
				};
			},
		};

		const report = await seedConceptGraphFromOhArtifacts(store, extractor, { projectRoot: rootDir });

		expect(report).toMatchObject({
			filesScanned: 1,
			sectionsParsed: 1,
			sectionsExtracted: 1,
			conceptsProposed: 1,
			factsProposed: 2,
			linksProposed: 1,
			errors: [],
		});
		expect(store.counts()).toMatchObject({ concepts: 1, facts: 2, links: 1, evidence: 1, events: 4 });
		expect(store.listFacts().map(fact => fact.status)).toEqual(["active", "active"]);
	});
});
