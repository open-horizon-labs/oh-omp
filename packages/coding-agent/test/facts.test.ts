import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFactsArgv, runFactsCommand } from "../src/cli/facts-cli";
import { formatKnownFactsBlock } from "../src/facts/prompt-format";
import { resolveActiveFacts } from "../src/facts/resolver";
import { createFactAssertion } from "../src/facts/schema";
import { FactStore } from "../src/facts/storage";

let tempDir = "";

afterEach(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

async function makeDbPath(): Promise<string> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-facts-"));
	return path.join(tempDir, "facts.sqlite");
}

describe("fact assertions", () => {
	it("normalizes allowlisted manual facts and rejects secrets", () => {
		const fact = createFactAssertion({
			kind: "project_decision",
			subject: " project:oh-omp ",
			predicate: "Storage Choice",
			object: "SQLite",
			canonicalText: "Use SQLite for the manual Fact Store MVP.",
			scope: { kind: "project", projectCwd: "/repo" },
			nowMs: 1_700_000_000_000,
		});

		expect(fact.subject).toBe("project:oh-omp");
		expect(fact.predicate).toBe("storage_choice");
		expect(fact.sensitivity).toBe("normal");
		expect(fact.temporal.observedAt).toBe("2023-11-14T22:13:20.000Z");
		expect(() =>
			createFactAssertion({
				kind: "project_decision",
				subject: "project:oh-omp",
				predicate: "token",
				object: "secret",
				canonicalText: "Store a secret.",
				scope: { kind: "project" },
				sensitivity: "secret",
			}),
		).toThrow("Secret facts must not be stored");
	});

	it("stores, searches, retracts, and erases facts with explainable events", async () => {
		const dbPath = await makeDbPath();
		const store = FactStore.open(dbPath);
		try {
			const fact = store.add({
				kind: "environment_tooling",
				subject: "project:oh-omp",
				predicate: "runtime",
				object: "Bun",
				canonicalText: "oh-omp uses Bun for TypeScript tooling.",
				scope: { kind: "project", projectCwd: "/repo" },
				evidence: [{ locator: "file://package.json", quote: "bun run" }],
			});

			expect(store.list()).toHaveLength(1);
			expect(store.search({ query: "Bun" }).map(row => row.id)).toEqual([fact.id]);

			const retracted = store.retract(fact.id, "superseded");
			expect(retracted?.status).toBe("retracted");
			expect(store.list()).toHaveLength(0);
			expect(store.events(fact.id).map(event => event.action)).toEqual(["retract", "add"]);

			const erased = store.erase(fact.id, "privacy");
			expect(erased?.status).toBe("erased");
			expect(erased?.canonicalText).toBe("[erased]");
			expect(erased?.evidence).toEqual([]);
			expect(erased?.subject).toBe("[erased]");
			expect(erased?.predicate).toBe("erased");
		} finally {
			store.close();
		}
	});

	it("resolves active facts by source authority and omits unsafe prompt facts", () => {
		const assistantFact = createFactAssertion({
			id: "fact_assistant",
			kind: "project_decision",
			subject: "project:alpha",
			predicate: "launch_date",
			object: "April 5",
			canonicalText: "Project Alpha launches April 5.",
			scope: { kind: "project", projectCwd: "/alpha" },
			source: { kind: "assistant" },
			nowMs: 1_700_000_000_000,
		});
		const userFact = createFactAssertion({
			id: "fact_user",
			kind: "project_decision",
			subject: "project:alpha",
			predicate: "launch_date",
			object: "May 1",
			canonicalText: "Project Alpha launches May 1.",
			scope: { kind: "project", projectCwd: "/alpha" },
			source: { kind: "user" },
			nowMs: 1_700_000_001_000,
		});
		const personalFact = createFactAssertion({
			id: "fact_personal",
			kind: "user_preference",
			subject: "user",
			predicate: "response_style",
			object: "concise",
			canonicalText: "User prefers concise answers.",
			scope: { kind: "global" },
		});

		const resolved = resolveActiveFacts([assistantFact, userFact, personalFact]);
		expect(resolved.active.map(fact => fact.id)).toEqual(["fact_user"]);
		expect(resolved.omitted).toContainEqual({ id: "fact_personal", reason: "personal" });
		expect(resolved.omitted).toContainEqual({
			id: "fact_assistant",
			reason: "superseded_by_selected",
			detail: "fact_user",
		});

		const formatted = formatKnownFactsBlock([assistantFact, userFact, personalFact], { maxFacts: 1 });
		expect(formatted.text).toContain("<known-facts");
		expect(formatted.text).toContain("Project Alpha launches May 1.");
		expect(formatted.text).not.toContain("concise answers");
	});

	it("supports manual facts command flows without autonomous extraction", async () => {
		const dbPath = await makeDbPath();
		const added = await runFactsCommand(
			{
				action: "add",
				values: ["project_constraint", "project:oh-omp", "collection", "manual-only first slice"],
				flags: { db: dbPath, json: true, scope: "project" },
			},
			{ cwd: "/repo" },
		);
		const parsed = JSON.parse(added) as { id: string; canonicalText: string };
		expect(parsed.canonicalText).toContain("manual-only first slice");

		const search = await runFactsCommand(
			{ action: "search", values: ["manual-only"], flags: { db: dbPath, json: true } },
			{ cwd: "/repo" },
		);
		expect(JSON.parse(search)).toHaveLength(1);

		const retracted = await runFactsCommand(
			{ action: "retract", values: [parsed.id, "changed"], flags: { db: dbPath, json: true } },
			{ cwd: "/repo" },
		);
		expect(JSON.parse(retracted).status).toBe("retracted");

		const parsedFlagValue = parseFactsArgv([
			"add",
			"environment_tooling",
			"project:oh-omp",
			"required_flag",
			"--strict",
		]);
		expect(parsedFlagValue.values).toEqual(["environment_tooling", "project:oh-omp", "required_flag", "--strict"]);
	});
});
