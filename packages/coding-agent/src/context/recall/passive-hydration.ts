/**
 * Passive hydration: auto-inject semantically relevant past context each turn.
 *
 * Each turn, the hot window text (last N turns) is embedded and compared against
 * a cached embedding from the previous turn. If the conversation has shifted
 * meaningfully (cosine distance exceeds threshold), LanceDB is searched for
 * semantically similar past content, which is then MMR-reranked for diversity
 * and injected into the context before the hot window.
 *
 * When the conversation is stable (cache hit), the previous results are reused
 * without any embed or search calls.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { embed } from "./embed";
import { extractAssistantText, extractToolResultText, extractUserText } from "./message-text";
import { cosineSimilarity, mmrRerank } from "./mmr";
import type { RecallStore } from "./store";
import type { MmrCandidate, RecallSearchResult } from "./types";
import { DEFAULT_RECALL_MMR_LAMBDA } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Default number of recent turns to concatenate as the hot window query. */
const DEFAULT_HOT_WINDOW_TURNS = 5;

/** Cosine distance threshold for cache invalidation. Below this = cache hit. */
const DEFAULT_COSINE_THRESHOLD = 0.15;

/** Default number of results to inject after MMR reranking. */
const DEFAULT_TOP_K = 10;

/** Oversample factor for LanceDB search before MMR reranking. */
const SEARCH_OVERSAMPLE = 3;

/** Maximum wall-clock time for the hydration pipeline (embed + search + MMR). */
const MAX_HYDRATION_MS = 2000;

// ═══════════════════════════════════════════════════════════════════════════
// Hot window text extraction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract concatenated text from the last N turns of conversation.
 *
 * Skips system prompt / developer messages — only user, assistant, and
 * tool_result turns contribute to the semantic query.
 *
 * Returns null if no extractable text is found.
 */
export function extractHotWindowText(
	messages: AgentMessage[],
	windowTurns: number = DEFAULT_HOT_WINDOW_TURNS,
): string | null {
	// Walk backwards collecting turns. A "turn" boundary is a user message.
	const parts: string[] = [];
	let turnsCollected = 0;

	for (let i = messages.length - 1; i >= 0 && turnsCollected < windowTurns; i--) {
		const msg = messages[i];
		if (!("role" in msg) || typeof msg.role !== "string") continue;

		if (msg.role === "user") {
			parts.unshift(extractUserText(msg.content));
			turnsCollected++;
		} else if (msg.role === "assistant") {
			parts.unshift(extractAssistantText(msg.content));
		} else if (msg.role === "toolResult") {
			// Include tool result text for semantic context, but truncate to avoid
			// embedding excessively large outputs (grep results, file reads, etc.)
			const text = extractToolResultText(msg.content);
			if (text.length > 2000) {
				parts.unshift(text.slice(0, 2000));
			} else {
				parts.unshift(text);
			}
		}
		// Skip developer, system messages — they don't carry conversation semantics
	}

	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cosine cache
// ═══════════════════════════════════════════════════════════════════════════

export class CosineCache {
	#lastEmbedding: Float32Array | null = null;
	#cachedResults: RecallSearchResult[] = [];
	#threshold: number;
	#hits = 0;
	#misses = 0;

	constructor(threshold: number = DEFAULT_COSINE_THRESHOLD) {
		this.#threshold = threshold;
	}

	/**
	 * Check whether the new embedding is close enough to the cached one.
	 * Returns `{ hit: true, results }` on cache hit, `{ hit: false }` on miss.
	 */
	check(embedding: Float32Array): { hit: true; results: RecallSearchResult[] } | { hit: false } {
		if (!this.#lastEmbedding) {
			this.#misses++;
			return { hit: false };
		}

		const sim = cosineSimilarity(Array.from(this.#lastEmbedding), Array.from(embedding));
		const distance = 1 - sim;

		if (distance < this.#threshold) {
			this.#hits++;
			logger.debug("CosineCache hit", { distance, threshold: this.#threshold, hits: this.#hits });
			return { hit: true, results: this.#cachedResults };
		}

		this.#misses++;
		logger.debug("CosineCache miss", { distance, threshold: this.#threshold, misses: this.#misses });
		return { hit: false };
	}

	/** Update the cache with a new embedding and its associated results. */
	update(embedding: Float32Array, results: RecallSearchResult[]): void {
		this.#lastEmbedding = embedding;
		this.#cachedResults = results;
	}

	get hits(): number {
		return this.#hits;
	}
	get misses(): number {
		return this.#misses;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Hydrated context formatting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format hydrated recall results for injection as a developer message.
 *
 * Returns null when there are no results to inject.
 */
export function formatHydratedContext(results: RecallSearchResult[]): string | null {
	if (results.length === 0) return null;

	const parts: string[] = ["<recalled-context>"];

	for (const result of results) {
		const attrs: string[] = [`turn="${result.turn}"`, `role="${result.role}"`];
		if (result.tool_name) {
			attrs.push(`tool="${result.tool_name}"`);
		}
		parts.push(`<entry ${attrs.join(" ")}>`);
		parts.push(result.text);
		parts.push("</entry>");
	}

	parts.push("</recalled-context>");
	return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Passive hydrator
// ═══════════════════════════════════════════════════════════════════════════

export interface PassiveHydratorOptions {
	store: RecallStore;
	license: string;
	topK?: number;
	mmrLambda?: number;
	cosineThreshold?: number;
	hotWindowTurns?: number;
}

export interface HydrationResult {
	/** Formatted text to inject as a developer message, or null if nothing to inject. */
	text: string | null;
	/** The raw search results (for observability / prompt snapshots). */
	results: RecallSearchResult[];
	/** Whether the cosine cache was hit (no embed/search performed). */
	cacheHit: boolean;
	/** Wall-clock time of the hydration pipeline in ms. */
	durationMs: number;
}

export class PassiveHydrator {
	#store: RecallStore;
	#license: string;
	#cache: CosineCache;
	#topK: number;
	#mmrLambda: number;
	#hotWindowTurns: number;

	constructor(options: PassiveHydratorOptions) {
		this.#store = options.store;
		this.#license = options.license;
		this.#topK = options.topK ?? DEFAULT_TOP_K;
		this.#mmrLambda = options.mmrLambda ?? DEFAULT_RECALL_MMR_LAMBDA;
		this.#cache = new CosineCache(options.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD);
		this.#hotWindowTurns = options.hotWindowTurns ?? DEFAULT_HOT_WINDOW_TURNS;
	}

	/**
	 * Run passive hydration for the current turn.
	 *
	 * 1. Extract hot window text from conversation messages
	 * 2. Embed the hot window
	 * 3. Check cosine cache
	 * 4. On miss: search LanceDB + MMR rerank
	 * 5. Format results for injection
	 *
	 * The entire pipeline is time-bounded by MAX_HYDRATION_MS.
	 * Failures are logged and return empty results (non-fatal).
	 */
	async hydrate(messages: AgentMessage[]): Promise<HydrationResult> {
		const start = Date.now();

		try {
			return await this.#hydrateInner(messages, start);
		} catch (err) {
			const durationMs = Date.now() - start;
			logger.warn("PassiveHydrator: hydration failed", {
				error: err instanceof Error ? err.message : String(err),
				durationMs: Math.round(durationMs),
			});
			return { text: null, results: [], cacheHit: false, durationMs };
		}
	}

	get cacheHits(): number {
		return this.#cache.hits;
	}
	get cacheMisses(): number {
		return this.#cache.misses;
	}

	async #hydrateInner(messages: AgentMessage[], start: number): Promise<HydrationResult> {
		// 1. Extract hot window text
		const hotWindowText = extractHotWindowText(messages, this.#hotWindowTurns);
		if (!hotWindowText) {
			return { text: null, results: [], cacheHit: false, durationMs: Date.now() - start };
		}

		// 2. Embed the hot window
		const vectors = await this.#embedWithTimeout(hotWindowText, start);
		if (!vectors) {
			return { text: null, results: [], cacheHit: false, durationMs: Date.now() - start };
		}
		const embedding = vectors[0];

		// 3. Check cosine cache
		const cacheResult = this.#cache.check(embedding);
		if (cacheResult.hit) {
			const text = formatHydratedContext(cacheResult.results);
			return {
				text,
				results: cacheResult.results,
				cacheHit: true,
				durationMs: Date.now() - start,
			};
		}

		// 4. Search LanceDB
		const searchLimit = this.#topK * SEARCH_OVERSAMPLE;
		const searchResults = await this.#store.search(Array.from(embedding), searchLimit);

		if (searchResults.length === 0) {
			this.#cache.update(embedding, []);
			return { text: null, results: [], cacheHit: false, durationMs: Date.now() - start };
		}

		// 5. MMR rerank for diversity
		const candidates: MmrCandidate<RecallSearchResult>[] = searchResults.map(r => ({
			vector: r.vector,
			// LanceDB _distance is L2 distance; convert to a similarity score.
			// Lower distance = more similar = higher score.
			score: 1 / (1 + r._distance),
			data: r,
		}));
		const reranked = mmrRerank(candidates, this.#mmrLambda);
		const topResults = reranked.slice(0, this.#topK).map(c => c.data);

		// 6. Update cache
		this.#cache.update(embedding, topResults);

		// 7. Format
		const text = formatHydratedContext(topResults);
		const durationMs = Date.now() - start;

		logger.debug("PassiveHydrator: hydration complete", {
			searched: searchResults.length,
			selected: topResults.length,
			cacheHit: false,
			durationMs: Math.round(durationMs),
		});

		return { text, results: topResults, cacheHit: false, durationMs };
	}

	async #embedWithTimeout(text: string, start: number): Promise<Float32Array[] | null> {
		const elapsed = Date.now() - start;
		const remaining = MAX_HYDRATION_MS - elapsed;
		if (remaining <= 0) {
			logger.debug("PassiveHydrator: skipping embed (timeout budget exhausted)");
			return null;
		}

		const embedPromise = embed([text], this.#license);
		const timeoutPromise = Bun.sleep(remaining).then(() => null as Float32Array[] | null);
		const result = await Promise.race([embedPromise, timeoutPromise]);

		if (!result) {
			logger.debug("PassiveHydrator: embed timed out", { remainingMs: Math.round(remaining) });
		}
		return result;
	}
}
