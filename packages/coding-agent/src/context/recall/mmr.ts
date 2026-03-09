import type { MmrCandidate } from "./types";
import { DEFAULT_RECALL_MMR_LAMBDA } from "./types";

/**
 * Cosine similarity between two vectors. Returns 0 for zero-magnitude vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
	}
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i];
		const bi = b[i];
		dot += ai * bi;
		magA += ai * ai;
		magB += bi * bi;
	}
	const denom = Math.sqrt(magA) * Math.sqrt(magB);
	if (denom === 0) return 0;
	return dot / denom;
}

/**
 * Maximal Marginal Relevance re-ranking for diversity.
 *
 * Greedily selects candidates that balance relevance (score) against
 * redundancy (max cosine similarity to already-selected items).
 */
export function mmrRerank<T>(
	candidates: MmrCandidate<T>[],
	lambda: number = DEFAULT_RECALL_MMR_LAMBDA,
): MmrCandidate<T>[] {
	if (candidates.length === 0) return [];
	if (candidates.length === 1) return [candidates[0]];

	const selected: MmrCandidate<T>[] = [];
	const remaining = new Set<number>();
	for (let i = 0; i < candidates.length; i++) remaining.add(i);

	// First pick: highest-scoring candidate
	let bestInitial = 0;
	for (let i = 1; i < candidates.length; i++) {
		if (candidates[i].score > candidates[bestInitial].score) bestInitial = i;
	}
	selected.push(candidates[bestInitial]);
	remaining.delete(bestInitial);

	while (remaining.size > 0) {
		let bestIdx = -1;
		let bestMmrScore = -Infinity;

		for (const idx of remaining) {
			const candidate = candidates[idx];
			const relevance = candidate.score;

			// Max similarity to any already-selected candidate
			let maxSim = 0;
			for (const sel of selected) {
				const sim = cosineSimilarity(candidate.vector, sel.vector);
				if (sim > maxSim) maxSim = sim;
			}

			const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
			if (mmrScore > bestMmrScore) {
				bestMmrScore = mmrScore;
				bestIdx = idx;
			}
		}

		if (bestIdx === -1) break;
		selected.push(candidates[bestIdx]);
		remaining.delete(bestIdx);
	}

	return selected;
}
