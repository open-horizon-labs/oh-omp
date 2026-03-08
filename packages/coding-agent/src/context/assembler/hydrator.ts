/**
 * Locator-map hydration with token/latency budgeting and freshness checks.
 *
 * Processes scored candidates in rank order, resolving each to content via
 * a pluggable retriever. Supports parallel retrieval with concurrency control,
 * per-entry timeouts, and content truncation for budget-aware filling.
 *
 * Tracks budget consumption and drops candidates that exceed limits,
 * are stale, time out, or fail retrieval.
 */

import type { MemoryContextFragment, MemoryFragmentDropReason, MemoryLocatorEntry } from "../memory-contract";
import {
	type BudgetTracker,
	DEFAULT_CONCURRENCY,
	DEFAULT_PER_ENTRY_TIMEOUT_MS,
	type HydrationDrop,
	type HydrationResult,
	type LocatorRetriever,
	MIN_FRAGMENT_TOKENS,
	type ScoredCandidate,
} from "./types";

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

/** Estimate token count from a pre-computed character count (avoids string allocation). */
export function estimateTokensFromCharCount(charCount: number): number {
	return Math.ceil(charCount / 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget
// ═══════════════════════════════════════════════════════════════════════════

/** Create a new budget tracker from limits. */
export function createBudgetTracker(maxTokens: number, maxLatencyMs: number): BudgetTracker {
	return { maxTokens, maxLatencyMs, consumedTokens: 0, consumedLatencyMs: 0 };
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
	/** Max parallel retrievals per batch. Default: {@link DEFAULT_CONCURRENCY}. */
	concurrency?: number;
	/** Per-entry retrieval timeout (ms). Default: {@link DEFAULT_PER_ENTRY_TIMEOUT_MS}. */
	perEntryTimeoutMs?: number;
	/** Max tokens per fragment; oversized content is truncated. */
	maxTokensPerFragment?: number;
}

export interface HydrateCandidatesResult {
	fragments: MemoryContextFragment[];
	drops: HydrationDrop[];
	results: HydrationResult[];
}

/**
 * Truncate content to fit within a token cap.
 *
 * Accounts for the truncation marker length to ensure the result
 * does not exceed `maxTokens` when re-estimated via chars/4.
 */
const TRUNCATION_MARKER = "\n[... truncated]";
const TRUNCATION_MARKER_CHARS = TRUNCATION_MARKER.length;

function truncateContent(content: string, maxTokens: number): string {
	const totalMaxChars = maxTokens * 4;
	if (content.length <= totalMaxChars) return content;

	// Reserve space for the marker so the final result fits within maxTokens
	const maxContentChars = totalMaxChars - TRUNCATION_MARKER_CHARS;
	if (maxContentChars <= 0) return TRUNCATION_MARKER.trimStart();

	// Find a line boundary near the cut point to avoid mid-line truncation
	let cutAt = content.lastIndexOf("\n", maxContentChars);
	if (cutAt < maxContentChars * 0.5) cutAt = maxContentChars; // no good line boundary, hard cut

	return content.slice(0, cutAt) + TRUNCATION_MARKER;
}

/**
 * Retrieve a single entry with timeout protection.
 *
 * Returns null on timeout, allowing the caller to record a retrieval_timeout drop.
 */
async function retrieveWithTimeout(
	retriever: LocatorRetriever,
	entry: MemoryLocatorEntry,
	timeoutMs: number,
): Promise<{ content: string | null; timedOut: boolean }> {
	const { promise, resolve } = Promise.withResolvers<{ content: string | null; timedOut: boolean }>();

	const timer = setTimeout(() => resolve({ content: null, timedOut: true }), timeoutMs);

	retriever(entry).then(
		content => {
			clearTimeout(timer);
			resolve({ content, timedOut: false });
		},
		() => {
			clearTimeout(timer);
			resolve({ content: null, timedOut: false });
		},
	);

	return promise;
}

/**
 * Pre-filter candidates by score and freshness (cheap, no I/O).
 *
 * Separates candidates into those eligible for retrieval and those
 * that should be dropped immediately.
 */
function preFilter(
	candidates: ScoredCandidate[],
	minScore: number,
	nowMs: number,
	invalidationTags: ReadonlySet<string>,
): { eligible: ScoredCandidate[]; drops: HydrationDrop[] } {
	const eligible: ScoredCandidate[] = [];
	const drops: HydrationDrop[] = [];

	for (const candidate of candidates) {
		const { locator, score } = candidate;

		if (score < minScore) {
			drops.push({ id: locator.key, reason: "low_score" });
			continue;
		}

		if (!isFresh(locator, nowMs, invalidationTags)) {
			const capturedMs = new Date(locator.provenance.capturedAt).getTime();
			const isExpired = Number.isNaN(capturedMs) || nowMs - capturedMs > locator.freshness.ttlMs;
			drops.push({ id: locator.key, reason: isExpired ? "stale" : "invalidated" });
			continue;
		}

		eligible.push(candidate);
	}

	return { eligible, drops };
}

/**
 * Hydrate scored candidates with parallel retrieval, respecting budget and freshness.
 *
 * Processing flow:
 *   1. Pre-filter all candidates by score and freshness (no I/O).
 *   2. Process eligible candidates in batches of `concurrency`.
 *   3. Within each batch, retrieve content in parallel with per-entry timeout.
 *   4. Process retrieved content in rank order: truncate if oversized, check budget.
 *   5. Stop when wall-clock latency exceeds budget or all candidates processed.
 *
 * Content truncation: when a fragment exceeds `maxTokensPerFragment`, it is
 * truncated to fit. When remaining budget is tight, fragments are truncated to
 * fill the remaining space (greedy filling).
 */
export async function hydrateCandidates(opts: HydrateCandidatesOptions): Promise<HydrateCandidatesResult> {
	const {
		candidates,
		budget,
		retriever,
		nowMs,
		invalidationTags = new Set(),
		minScore,
		concurrency = DEFAULT_CONCURRENCY,
		perEntryTimeoutMs = DEFAULT_PER_ENTRY_TIMEOUT_MS,
		maxTokensPerFragment,
	} = opts;

	const startTime = Date.now();
	const fragments: MemoryContextFragment[] = [];
	const drops: HydrationDrop[] = [];
	const results: HydrationResult[] = [];

	// Step 1: Pre-filter (cheap, no I/O)
	const { eligible, drops: preDrops } = preFilter(candidates, minScore, nowMs, invalidationTags);
	drops.push(...preDrops);

	// Step 2: Process eligible candidates in batches
	for (let batchStart = 0; batchStart < eligible.length; batchStart += concurrency) {
		// Wall-clock latency check
		const elapsed = Date.now() - startTime;
		if (elapsed >= budget.maxLatencyMs) {
			for (let i = batchStart; i < eligible.length; i++) {
				drops.push({ id: eligible[i].locator.key, reason: "latency_budget" });
			}
			break;
		}

		// Check if token budget is completely exhausted
		if (budget.consumedTokens >= budget.maxTokens) {
			for (let i = batchStart; i < eligible.length; i++) {
				drops.push({ id: eligible[i].locator.key, reason: "token_budget" });
			}
			break;
		}

		const batch = eligible.slice(batchStart, batchStart + concurrency);

		// Retrieve all entries in the batch in parallel
		const retrievalResults = await Promise.all(
			batch.map(candidate => retrieveWithTimeout(retriever, candidate.locator, perEntryTimeoutMs)),
		);

		// Process results in rank order (batch preserves order from eligible)
		for (let j = 0; j < batch.length; j++) {
			const candidate = batch[j];
			const { content: rawContent, timedOut } = retrievalResults[j];

			if (timedOut) {
				drops.push({ id: candidate.locator.key, reason: "retrieval_timeout" });
				continue;
			}

			if (rawContent === null) {
				drops.push({ id: candidate.locator.key, reason: "invalidated" });
				continue;
			}

			let content = rawContent;
			let actualTokens = estimateTokens(content);

			// Truncate if exceeds per-fragment cap
			if (maxTokensPerFragment !== undefined && actualTokens > maxTokensPerFragment) {
				content = truncateContent(content, maxTokensPerFragment);
				actualTokens = estimateTokens(content);
			}

			// Check remaining token budget
			const remainingTokens = budget.maxTokens - budget.consumedTokens;
			if (actualTokens > remainingTokens) {
				// Try truncating to fit remaining budget
				if (remainingTokens >= MIN_FRAGMENT_TOKENS) {
					content = truncateContent(content, remainingTokens);
					actualTokens = estimateTokens(content);
				} else {
					drops.push({ id: candidate.locator.key, reason: "token_budget" as MemoryFragmentDropReason });
					continue;
				}
			}

			// Commit to budget
			budget.consumedTokens += actualTokens;

			const fragment: MemoryContextFragment = {
				id: candidate.locator.key,
				tier: candidate.locator.tier,
				content,
				locatorKey: candidate.locator.key,
				score: candidate.score,
				provenance: candidate.locator.provenance,
			};

			fragments.push(fragment);
			results.push({ fragment, consumedTokens: actualTokens, consumedLatencyMs: 0 });
		}
	}

	// Record wall-clock latency
	budget.consumedLatencyMs = Date.now() - startTime;

	return { fragments, drops, results };
}
