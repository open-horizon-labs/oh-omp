/**
 * Deterministic scoring and ranking policy for candidate memory fragments.
 *
 * Scores are computed as a weighted sum of normalized signals:
 *   file-path overlap, symbol overlap, failure relevance, recency, trust, tier.
 *
 * All signals produce values in [0, 1]. The final score is the dot product
 * of signals and weights, so it also falls in [0, 1].
 */

import type { MemoryLocatorEntry } from "../memory-contract";
import {
	DEFAULT_MMR_LAMBDA,
	DEFAULT_SCORING_WEIGHTS,
	type ScoredCandidate,
	type ScoringBreakdown,
	type ScoringContext,
	type ScoringWeights,
	TIER_BASE_SCORES,
	TRUST_BASE_SCORES,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Signal computation
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum age (ms) used to normalize recency. Entries older than this get 0. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Compute file-path overlap signal.
 *
 * Returns 1 if the locator's `where` path matches any active path,
 * 0.5 for directory-prefix overlap, 0 otherwise.
 */
function fileOverlapSignal(entry: MemoryLocatorEntry, activePaths: string[]): number {
	const where = entry.where;
	for (const p of activePaths) {
		if (where === p) return 1.0;
	}
	for (const p of activePaths) {
		if (where.startsWith(p) || p.startsWith(where)) return 0.5;
	}
	return 0;
}

/**
 * Compute symbol overlap signal.
 *
 * Returns 1 if the locator key matches any active symbol exactly,
 * 0.5 for substring containment, 0 otherwise.
 */
function symbolOverlapSignal(entry: MemoryLocatorEntry, activeSymbols: string[]): number {
	const key = entry.key;
	for (const s of activeSymbols) {
		if (key === s) return 1.0;
	}
	for (const s of activeSymbols) {
		if (key.includes(s) || s.includes(key)) return 0.5;
	}
	return 0;
}

/**
 * Compute failure-relevance signal.
 *
 * Returns 1 if the locator's `where` or `key` matches any unresolved loop,
 * 0 otherwise.
 */
function failureRelevanceSignal(entry: MemoryLocatorEntry, unresolvedLoops: string[]): number {
	for (const loop of unresolvedLoops) {
		if (
			entry.where.includes(loop) ||
			entry.key.includes(loop) ||
			loop.includes(entry.where) ||
			loop.includes(entry.key)
		) {
			return 1.0;
		}
	}
	return 0;
}

/**
 * Compute recency signal.
 *
 * Linearly decays from 1 (just captured) to 0 (captured >= MAX_AGE_MS ago).
 */
function recencySignal(entry: MemoryLocatorEntry, nowMs: number): number {
	const capturedMs = new Date(entry.provenance.capturedAt).getTime();
	if (Number.isNaN(capturedMs)) return 0;
	const ageMs = nowMs - capturedMs;
	if (ageMs <= 0) return 1.0;
	if (ageMs >= MAX_AGE_MS) return 0;
	return 1.0 - ageMs / MAX_AGE_MS;
}

/** Compute trust signal from locator trust level. */
function trustSignal(entry: MemoryLocatorEntry): number {
	return TRUST_BASE_SCORES[entry.trust] ?? 0;
}

/** Compute tier signal from locator tier. */
function tierSignal(entry: MemoryLocatorEntry): number {
	return TIER_BASE_SCORES[entry.tier] ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score a single locator entry against the current turn context.
 *
 * Returns a `ScoredCandidate` with total score in [0, 1] and per-signal breakdown.
 */
export function scoreCandidate(
	entry: MemoryLocatorEntry,
	ctx: ScoringContext,
	weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ScoredCandidate {
	const nowMs = new Date(ctx.now).getTime();

	const breakdown: ScoringBreakdown = {
		fileOverlap: fileOverlapSignal(entry, ctx.activePaths),
		symbolOverlap: symbolOverlapSignal(entry, ctx.activeSymbols),
		failureRelevance: failureRelevanceSignal(entry, ctx.unresolvedLoops),
		recency: recencySignal(entry, nowMs),
		trust: trustSignal(entry),
		tier: tierSignal(entry),
	};

	const score =
		breakdown.fileOverlap * weights.fileOverlap +
		breakdown.symbolOverlap * weights.symbolOverlap +
		breakdown.failureRelevance * weights.failureRelevance +
		breakdown.recency * weights.recency +
		breakdown.trust * weights.trust +
		breakdown.tier * weights.tier;

	return { locator: entry, score, breakdown };
}

/**
 * Score and rank all locator entries, returning candidates sorted by score descending.
 *
 * Deterministic: ties are broken by key (lexicographic ascending).
 */
export function rankCandidates(
	entries: MemoryLocatorEntry[],
	ctx: ScoringContext,
	weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ScoredCandidate[] {
	const scored = entries.map(e => scoreCandidate(e, ctx, weights));
	scored.sort((a, b) => {
		const diff = b.score - a.score;
		if (diff !== 0) return diff;
		return a.locator.key.localeCompare(b.locator.key);
	});
	return scored;
}

// ═══════════════════════════════════════════════════════════════════════════
// Diversity: Maximal Marginal Relevance (MMR)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute similarity between two locator entries based on path and provenance.
 *
 * Returns a value in [0, 1]:
 *   - 1.0: same locator key (duplicate)
 *   - 0.8: same file path
 *   - 0.4: same directory
 *   - 0.2: same provenance source and reason (same tool invocation type)
 *   - 0.0: unrelated
 */
export function candidateSimilarity(a: MemoryLocatorEntry, b: MemoryLocatorEntry): number {
	if (a.key === b.key) return 1.0;
	if (a.where === b.where) return 0.8;

	const dirA = a.where.substring(0, a.where.lastIndexOf("/"));
	const dirB = b.where.substring(0, b.where.lastIndexOf("/"));
	if (dirA.length > 0 && dirA === dirB) return 0.4;

	if (a.provenance.source === b.provenance.source && a.provenance.reason === b.provenance.reason) return 0.2;

	return 0;
}

/**
 * Maximal Marginal Relevance (MMR) re-ranking for diversity.
 *
 * Greedily selects candidates to balance relevance (score) against
 * redundancy (similarity to already-selected items).
 *
 * MMR score for candidate i:
 *   mmr(i) = lambda * score(i) - (1 - lambda) * max_sim(i, selected)
 *
 * @param candidates - Candidates pre-sorted by score descending.
 * @param lambda     - Trade-off: 1.0 = pure relevance, 0.0 = pure diversity.
 *                    Default: {@link DEFAULT_MMR_LAMBDA}.
 * @returns Re-ranked candidates with diversity applied.
 */
export function mmrRerank(candidates: ScoredCandidate[], lambda: number = DEFAULT_MMR_LAMBDA): ScoredCandidate[] {
	if (candidates.length <= 1) return candidates;

	const selected: ScoredCandidate[] = [];
	const remaining = new Set<number>();
	for (let i = 0; i < candidates.length; i++) remaining.add(i);

	// First pick is always the highest-scoring candidate
	selected.push(candidates[0]);
	remaining.delete(0);

	while (remaining.size > 0) {
		let bestIdx = -1;
		let bestMmrScore = -Infinity;

		for (const idx of remaining) {
			const candidate = candidates[idx];
			const relevance = candidate.score;

			// Max similarity to any already-selected candidate
			let maxSim = 0;
			for (const sel of selected) {
				const sim = candidateSimilarity(candidate.locator, sel.locator);
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
