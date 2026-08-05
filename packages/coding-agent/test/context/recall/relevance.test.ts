import { describe, expect, test } from "bun:test";
import { buildRelevanceScores } from "../../../src/context/recall/relevance";

describe("buildRelevanceScores", () => {
	test("scores matching candidate text by direct cosine", () => {
		const scores = buildRelevanceScores(
			[
				{ turnIdx: 2, text: "north" },
				{ turnIdx: 5, text: "east" },
			],
			[
				{ text: "north", vector: [1, 0] },
				{ text: "east", vector: [0, 1] },
			],
			[1, 0],
		);

		expect(scores.get(2)).toBe(1);
		expect(scores.get(5)).toBe(0);
	});

	test("omits candidates with no hashed row match", () => {
		const scores = buildRelevanceScores(
			[
				{ turnIdx: 1, text: "known" },
				{ turnIdx: 2, text: "missing" },
			],
			[{ text: "known", vector: [0, 1] }],
			[0, 1],
		);

		expect(scores.get(1)).toBe(1);
		expect(scores.has(2)).toBe(false);
	});

	test("keeps the first vector when duplicate row hashes appear", () => {
		const scores = buildRelevanceScores(
			[{ turnIdx: 7, text: "duplicate" }],
			[
				{ text: "duplicate", vector: [1, 0] },
				{ text: "duplicate", vector: [0, 1] },
			],
			[1, 0],
		);

		expect(scores.get(7)).toBe(1);
	});
});
