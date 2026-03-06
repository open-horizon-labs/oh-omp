/**
 * Locator-map hydration with token/latency budgeting and freshness checks.
 *
 * Processes scored candidates in rank order, resolving each to content via
 * a pluggable retriever. Tracks budget consumption and drops candidates
 * that exceed limits, are stale, or fail retrieval.
 */

import type { MemoryContextFragment, MemoryLocatorEntry } from "../memory-contract";
import type { BudgetTracker, HydrationDrop, HydrationResult, LocatorRetriever, ScoredCandidate } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Freshness
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check whether a locator entry is fresh.
 *
 * A locator is stale if:
 *   - Its TTL has expired relative to `nowMs`.
 *   - Any of its `invalidatedBy` tags appear in `invalidationTags`.
 */
export function isFresh(
	entry: MemoryLocatorEntry,
	nowMs: number,
	invalidationTags: ReadonlySet<string> = new Set(),
): boolean {
	const capturedMs = new Date(entry.provenance.capturedAt).getTime();
	if (Number.isNaN(capturedMs)) return false;
	if (nowMs - capturedMs > entry.freshness.ttlMs) return false;
	for (const tag of entry.freshness.invalidatedBy) {
		if (invalidationTags.has(tag)) return false;
	}
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Token estimation
// ═══════════════════════════════════════════════════════════════════════════

/** Estimate token count using the project-standard chars/4 heuristic. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget
// ═══════════════════════════════════════════════════════════════════════════

/** Create a new budget tracker from limits. */
export function createBudgetTracker(maxTokens: number, maxLatencyMs: number): BudgetTracker {
	return { maxTokens, maxLatencyMs, consumedTokens: 0, consumedLatencyMs: 0 };
}

/** Check whether adding a cost would exceed the budget. */
function wouldExceedBudget(tracker: BudgetTracker, tokens: number, latencyMs: number): boolean {
	return (
		tracker.consumedTokens + tokens > tracker.maxTokens ||
		tracker.consumedLatencyMs + latencyMs > tracker.maxLatencyMs
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Stub retriever
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default stub retriever for V1.
 *
 * Returns a synthetic content string describing the locator entry.
 * Real retrievers will be swapped in when remote/tool-based hydration is wired.
 */
export const stubRetriever: LocatorRetriever = async (entry: MemoryLocatorEntry): Promise<string> => {
	return `[${entry.how.method}] ${entry.where} :: ${entry.key}`;
};

// ═══════════════════════════════════════════════════════════════════════════
// Hydration
// ═══════════════════════════════════════════════════════════════════════════

export interface HydrateCandidatesOptions {
	/** Scored candidates in rank order. */
	candidates: ScoredCandidate[];
	/** Budget tracker (mutated during hydration). */
	budget: BudgetTracker;
	/** Retriever function. */
	retriever: LocatorRetriever;
	/** Current timestamp (ms). */
	nowMs: number;
	/** Active invalidation tags. */
	invalidationTags?: ReadonlySet<string>;
	/** Minimum score threshold. */
	minScore: number;
}

export interface HydrateCandidatesResult {
	fragments: MemoryContextFragment[];
	drops: HydrationDrop[];
	results: HydrationResult[];
}

/**
 * Hydrate scored candidates in rank order, respecting budget and freshness.
 *
 * Processing stops early when both token and latency budgets are exhausted.
 * Candidates that fail freshness, budget, score, or retrieval are recorded as drops.
 */
export async function hydrateCandidates(opts: HydrateCandidatesOptions): Promise<HydrateCandidatesResult> {
	const { candidates, budget, retriever, nowMs, invalidationTags = new Set(), minScore } = opts;

	const fragments: MemoryContextFragment[] = [];
	const drops: HydrationDrop[] = [];
	const results: HydrationResult[] = [];

	for (const candidate of candidates) {
		const { locator, score } = candidate;

		// Low-score filter
		if (score < minScore) {
			drops.push({ id: locator.key, reason: "low_score" });
			continue;
		}

		// Freshness check
		if (!isFresh(locator, nowMs, invalidationTags)) {
			const capturedMs = new Date(locator.provenance.capturedAt).getTime();
			const isExpired = Number.isNaN(capturedMs) || nowMs - capturedMs > locator.freshness.ttlMs;
			drops.push({ id: locator.key, reason: isExpired ? "stale" : "invalidated" });
			continue;
		}

		// Pre-check budget against estimated cost
		if (wouldExceedBudget(budget, locator.cost.estimatedTokens, locator.cost.estimatedLatencyMs)) {
			// Determine which budget dimension is exceeded
			const reason: "token_budget" | "latency_budget" =
				budget.consumedTokens + locator.cost.estimatedTokens > budget.maxTokens ? "token_budget" : "latency_budget";
			drops.push({ id: locator.key, reason });
			continue;
		}

		// Hydrate via retriever
		const content = await retriever(locator);
		if (content === null) {
			drops.push({ id: locator.key, reason: "invalidated" });
			continue;
		}

		const actualTokens = estimateTokens(content);
		const actualLatencyMs = locator.cost.estimatedLatencyMs; // V1: use estimate as actual

		// Post-hydration budget check (actual content may differ from estimate)
		if (wouldExceedBudget(budget, actualTokens, actualLatencyMs)) {
			const reason: "token_budget" | "latency_budget" =
				budget.consumedTokens + actualTokens > budget.maxTokens ? "token_budget" : "latency_budget";
			drops.push({ id: locator.key, reason });
			continue;
		}

		// Commit to budget
		budget.consumedTokens += actualTokens;
		budget.consumedLatencyMs += actualLatencyMs;

		const fragment: MemoryContextFragment = {
			id: locator.key,
			tier: locator.tier,
			content,
			locatorKey: locator.key,
			score,
			provenance: locator.provenance,
		};

		fragments.push(fragment);
		results.push({ fragment, consumedTokens: actualTokens, consumedLatencyMs: actualLatencyMs });
	}

	return { fragments, drops, results };
}
