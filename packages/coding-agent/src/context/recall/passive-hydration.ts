/**
 * Passive hydration: auto-inject relevant past context each turn.
 *
 * Each turn, the hot window text (last N turns) is embedded and compared against
 * a cached embedding from the previous turn. If the conversation has shifted
 * meaningfully (cosine distance exceeds threshold), hybrid retrieval runs over
 * recalled rows and the fused candidates are MMR-reranked for diversity before
 * being injected into the context ahead of the hot window.
 *
 * When the conversation is stable (cache hit), the previous results are reused
 * without any embed or search calls.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { parseMCPToolName } from "../../mcp/tool-bridge";
import { buildRecallDebugEntries, type RecallDebugTrace } from "./debug-trace";
import { embed } from "./embed";
import { HybridRetriever } from "./hybrid-retriever";
import { cosineSimilarity } from "./mmr";
import { buildPassiveRecallQuery, type PassiveRecallQueryMetadata } from "./passive-query";
import type { RecallStore } from "./store";
import {
	DEFAULT_RECENT_WINDOW_MS,
	formatRecallAge,
	getRecallAgeMs,
	getRecallBand,
	normalizeRecentWindowMs,
	type RecallBand,
} from "./temporal";
import type { ToolResultStore } from "./tool-result-store";
import { DEFAULT_RECALL_MMR_LAMBDA, type RecallSearchResult } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Default number of recent turns to project as the passive recall query. */
const DEFAULT_HOT_WINDOW_TURNS = 5;

/** Cosine distance threshold for cache invalidation. Below this = cache hit. */
const DEFAULT_COSINE_THRESHOLD = 0.15;

/** Default number of results to inject after hybrid retrieval + MMR reranking. */
const DEFAULT_TOP_K = 10;

/** Maximum wall-clock time for the hydration pipeline (embed + search + MMR). */
const MAX_HYDRATION_MS = 2000;

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
	get lastEmbedding(): Float32Array | null {
		return this.#lastEmbedding;
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
export interface HydratedContextFormatOptions {
	currentSessionId?: string;
	currentProjectCwd?: string;
	now?: number;
	recentWindowMs?: number;
}

function countRecallBands(
	results: RecallSearchResult[],
	now: number,
	recentWindowMs: number,
): Record<RecallBand, number> {
	const counts: Record<RecallBand, number> = { live: 0, recent: 0, durable: 0 };
	for (const result of results) {
		const ageMs = getRecallAgeMs(result.timestamp, now);
		counts[getRecallBand(ageMs, recentWindowMs)]++;
	}
	return counts;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function formatXmlAttr(name: string, value: string | number): string {
	return `${name}="${escapeXml(String(value))}"`;
}

export function formatHydratedContext(
	results: RecallSearchResult[],
	options: HydratedContextFormatOptions = {},
): string | null {
	if (results.length === 0) return null;

	const now = options.now ?? Date.now();
	const recentWindowMs = normalizeRecentWindowMs(options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);
	const parts: string[] = [`<recalled-context ${formatXmlAttr("now", new Date(now).toISOString())}>`];

	for (const result of results) {
		const ageMs = getRecallAgeMs(result.timestamp, now);
		const attrs: string[] = [
			formatXmlAttr("turn", result.turn),
			formatXmlAttr("role", result.role),
			formatXmlAttr("band", getRecallBand(ageMs, recentWindowMs)),
			formatXmlAttr("age", formatRecallAge(ageMs)),
			formatXmlAttr("timestamp", new Date(result.timestamp).toISOString()),
		];
		if (result.tool_name) {
			attrs.push(formatXmlAttr("tool", result.tool_name));
			const mcpParts = parseMCPToolName(result.tool_name);
			if (mcpParts) {
				attrs.push(formatXmlAttr("source", `mcp:${mcpParts.serverName}`));
			} else {
				attrs.push(formatXmlAttr("source", `tool:${result.tool_name}`));
			}
		} else {
			attrs.push(formatXmlAttr("source", result.role));
		}
		if (options.currentSessionId) {
			attrs.push(formatXmlAttr("session", result.session_id === options.currentSessionId ? "current" : "other"));
		}
		if (options.currentProjectCwd) {
			attrs.push(formatXmlAttr("project", result.project_cwd === options.currentProjectCwd ? "current" : "other"));
		}
		parts.push(`<entry ${attrs.join(" ")}>`);
		parts.push(escapeXml(result.text));
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
	toolResultStore?: ToolResultStore;
	license: string;
	projectCwd: string;
	sessionId?: string;
	topK?: number;
	mmrLambda?: number;
	cosineThreshold?: number;
	hotWindowTurns?: number;
	recentWindowMs?: number;
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
	/** Structured observability payload for /recall debugging. */
	trace: RecallDebugTrace | null;
}

export class PassiveHydrator {
	#license: string;
	#sessionId: string;
	#projectCwd: string;
	#recentWindowMs: number;
	#cache: CosineCache;
	#topK: number;
	#hotWindowTurns: number;
	#retriever: HybridRetriever;
	constructor(options: PassiveHydratorOptions) {
		this.#license = options.license;
		this.#sessionId = options.sessionId ?? "unknown";
		this.#projectCwd = options.projectCwd;
		this.#recentWindowMs = normalizeRecentWindowMs(options.recentWindowMs);
		this.#topK = options.topK ?? DEFAULT_TOP_K;
		this.#cache = new CosineCache(options.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD);
		this.#hotWindowTurns = options.hotWindowTurns ?? DEFAULT_HOT_WINDOW_TURNS;
		this.#retriever = new HybridRetriever({
			store: options.store,
			toolResultStore: options.toolResultStore,
			sessionId: this.#sessionId,
			projectCwd: options.projectCwd,
			mmrLambda: options.mmrLambda ?? DEFAULT_RECALL_MMR_LAMBDA,
			recentWindowMs: this.#recentWindowMs,
		});
	}

	/**
	 * Run passive hydration for the current turn.
	 *
	 * 1. Project the hot window into a retrieval query
	 * 2. Embed the projected query
	 * 3. Check cosine cache
	 * 4. On miss: run shared hybrid retrieval + MMR rerank
	 * 5. Format results for injection
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
			return { text: null, results: [], cacheHit: false, durationMs, trace: null };
		}
	}

	get lastEmbedding(): Float32Array | null {
		return this.#cache.lastEmbedding;
	}

	get cacheHits(): number {
		return this.#cache.hits;
	}
	get cacheMisses(): number {
		return this.#cache.misses;
	}

	async #hydrateInner(messages: AgentMessage[], start: number): Promise<HydrationResult> {
		// 1. Project the hot window into a retrieval query. User/assistant text stays raw;
		// tool results are codec-compressed so raw tool output does not dominate embeddings.
		const query = buildPassiveRecallQuery(messages, { windowTurns: this.#hotWindowTurns });
		const hotWindowText = query.text;
		if (!hotWindowText) {
			return { text: null, results: [], cacheHit: false, durationMs: Date.now() - start, trace: null };
		}

		// 2. Embed the hot window
		const vectors = await this.#embedWithTimeout(hotWindowText, start);
		if (!vectors) {
			const durationMs = Date.now() - start;
			return {
				text: null,
				results: [],
				cacheHit: false,
				durationMs,
				trace: this.#buildTrace({
					hotWindowText,
					results: [],
					text: null,
					cacheHit: false,
					durationMs,
					embeddingGenerated: false,
					queryMetadata: query.metadata,
				}),
			};
		}
		const embedding = vectors[0];

		// 3. Check cosine cache
		const cacheResult = this.#cache.check(embedding);
		if (cacheResult.hit) {
			const text = formatHydratedContext(cacheResult.results, {
				currentSessionId: this.#sessionId,
				currentProjectCwd: this.#projectCwd,
				recentWindowMs: this.#recentWindowMs,
			});
			const durationMs = Date.now() - start;
			return {
				text,
				results: cacheResult.results,
				cacheHit: true,
				durationMs,
				trace: this.#buildTrace({
					hotWindowText,
					results: cacheResult.results,
					text,
					cacheHit: true,
					durationMs,
					embeddingGenerated: true,
					queryMetadata: query.metadata,
				}),
			};
		}

		// 4. Run shared hybrid retrieval
		const response = await this.#retriever.search({
			query: hotWindowText,
			queryVector: Array.from(embedding),
			limit: this.#topK,
			mode: "hybrid",
			project: "all",
		});
		const topResults = response.results;

		if (topResults.length === 0) {
			this.#cache.update(embedding, []);
			const durationMs = Date.now() - start;
			return {
				text: null,
				results: [],
				cacheHit: false,
				durationMs,
				trace: this.#buildTrace({
					hotWindowText,
					results: [],
					text: null,
					cacheHit: false,
					durationMs,
					embeddingGenerated: true,
					responseTrace: response.trace,
					queryMetadata: query.metadata,
				}),
			};
		}

		// 5. Update cache
		this.#cache.update(embedding, topResults);

		// 6. Format
		const formattedAt = Date.now();
		const text = formatHydratedContext(topResults, {
			currentSessionId: this.#sessionId,
			currentProjectCwd: this.#projectCwd,
			now: formattedAt,
			recentWindowMs: this.#recentWindowMs,
		});
		const durationMs = formattedAt - start;
		const bandCounts = countRecallBands(topResults, formattedAt, this.#recentWindowMs);

		logger.debug("PassiveHydrator: hydration complete", {
			returned: topResults.length,
			cacheHit: false,
			durationMs: Math.round(durationMs),
			semanticCandidates: response.trace.semanticCandidates,
			keywordCandidates: response.trace.keywordCandidates,
			resolvedKeywordCandidates: response.trace.resolvedKeywordCandidates,
			fusedCandidates: response.trace.fusedCandidates,
			bandCounts,
		});

		return {
			text,
			results: topResults,
			cacheHit: false,
			durationMs,
			trace: this.#buildTrace({
				hotWindowText,
				results: topResults,
				text,
				cacheHit: false,
				durationMs,
				embeddingGenerated: true,
				responseTrace: response.trace,
				queryMetadata: query.metadata,
				now: formattedAt,
			}),
		};
	}

	#buildTrace(options: {
		hotWindowText: string;
		queryMetadata: PassiveRecallQueryMetadata;
		results: RecallSearchResult[];
		text: string | null;
		cacheHit: boolean;
		durationMs: number;
		embeddingGenerated: boolean;
		responseTrace?: {
			mode: "semantic" | "hybrid";
			semanticCandidates: number;
			keywordCandidates: number;
			resolvedKeywordCandidates: number;
			fusedCandidates: number;
			candidates: Array<{
				rowKey: string;
				semanticRank: number | null;
				keywordRank: number | null;
				source: "semantic" | "keyword" | "fused" | "cache" | "unknown";
			}>;
		};
		now?: number;
	}): RecallDebugTrace {
		const now = options.now ?? Date.now();
		const provenance = new Map(options.responseTrace?.candidates.map(candidate => [candidate.rowKey, candidate]));
		return {
			turnId: null,
			capturedAt: new Date(now).toISOString(),
			attempted: true,
			injected: !!options.text,
			cacheHit: options.cacheHit,
			durationMs: options.durationMs,
			failure: null,
			query: {
				text: options.hotWindowText,
				charCount: options.hotWindowText.length,
				estimatedTokens: Math.ceil(options.hotWindowText.length / 4),
				hotWindowTurns: this.#hotWindowTurns,
				embeddingGenerated: options.embeddingGenerated,
				originalCharCount: options.queryMetadata.originalCharCount,
				effectiveCharCount: options.queryMetadata.effectiveCharCount,
				toolResultRawCharCount: options.queryMetadata.toolResultRawCharCount,
				toolResultEffectiveCharCount: options.queryMetadata.toolResultEffectiveCharCount,
				toolResults: options.queryMetadata.toolResults,
			},
			retrieval: {
				mode: options.responseTrace?.mode ?? "hybrid",
				projectScope: "all",
				roleFilter: null,
				recentWindowMs: this.#recentWindowMs,
				topK: this.#topK,
				semanticCandidates: options.responseTrace?.semanticCandidates ?? 0,
				keywordCandidates: options.responseTrace?.keywordCandidates ?? 0,
				resolvedKeywordCandidates: options.responseTrace?.resolvedKeywordCandidates ?? 0,
				fusedCandidates: options.responseTrace?.fusedCandidates ?? options.results.length,
			},
			selected: buildRecallDebugEntries(options.results, {
				now,
				sessionId: this.#sessionId,
				projectCwd: this.#projectCwd,
				recentWindowMs: this.#recentWindowMs,
				provenance,
				sourceFallback: options.cacheHit ? "cache" : "unknown",
			}),
			dropped: [],
			injectedText: options.text,
			injectedTokenEstimate: options.text ? Math.ceil(options.text.length / 4) : 0,
		};
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
