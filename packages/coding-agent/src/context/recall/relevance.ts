import { contentHash } from "../assembler/codecs/shared";
import { cosineSimilarity } from "./mmr";

export interface RelevanceCandidate {
	turnIdx: number;
	text: string;
}

export function buildRelevanceScores(
	candidates: RelevanceCandidate[],
	rows: Array<{ text: string; vector: number[] }>,
	hotEmbedding: ArrayLike<number>,
): Map<number, number> {
	const vectorsByHash = new Map<number, number[]>();
	for (const row of rows) {
		const hash = contentHash(row.text);
		if (!vectorsByHash.has(hash)) {
			vectorsByHash.set(hash, row.vector);
		}
	}

	const embedding = Array.from(hotEmbedding);
	const scores = new Map<number, number>();
	for (const candidate of candidates) {
		const vector = vectorsByHash.get(contentHash(candidate.text));
		if (!vector) continue;
		scores.set(candidate.turnIdx, cosineSimilarity(vector, embedding));
	}
	return scores;
}
