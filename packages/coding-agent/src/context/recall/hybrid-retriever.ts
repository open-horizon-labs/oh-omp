import * as path from "node:path";
import type { RecallDebugCandidateTrace, RecallDebugSource } from "./debug-trace";
import { mmrRerank } from "./mmr";
import type { RecallStore } from "./store";
import { DEFAULT_LIVE_WINDOW_MS, getRecallAgeMs, normalizeRecentWindowMs } from "./temporal";
import type { ToolResultStore } from "./tool-result-store";
import {
	buildRecallLookupKey,
	buildRecallRowKey,
	type MmrCandidate,
	type RecallLookupKey,
	type RecallRow,
	type RecallSearchResult,
} from "./types";

const DEFAULT_RRF_K = 60;
const DEFAULT_SEMANTIC_OVERFETCH_FACTOR = 3;
const DEFAULT_KEYWORD_OVERFETCH_FACTOR = 3;
const SEMANTIC_DISTANCE_WEIGHT = 0.01;
const SAME_SESSION_BOOST = 0.003;
const SAME_PROJECT_BOOST = 0.002;
const EXACT_PATH_BOOST = 0.004;
const EXACT_SYMBOL_BOOST = 0.004;
const LIVE_FRESHNESS_BOOST = 0.002;
const RECENT_FRESHNESS_BOOST = 0.001;

export type HybridSearchMode = "semantic" | "hybrid";

export interface HybridRetrieverOptions {
	store: RecallStore;
	toolResultStore?: ToolResultStore;
	sessionId: string;
	projectCwd: string;
	mmrLambda?: number;
	rrfK?: number;
	semanticOverfetchFactor?: number;
	keywordOverfetchFactor?: number;
	recentWindowMs?: number;
}

export interface HybridSearchRequest {
	query: string;
	queryVector: number[];
	limit: number;
	filter?: string;
	role?: RecallRow["role"];
	project?: "current" | "all";
	mode?: HybridSearchMode;
	mmrLambda?: number;
}

export interface HybridSearchTrace {
	mode: HybridSearchMode;
	semanticCandidates: number;
	keywordCandidates: number;
	resolvedKeywordCandidates: number;
	fusedCandidates: number;
	candidates: RecallDebugCandidateTrace[];
}

export interface HybridSearchResponse {
	results: RecallSearchResult[];
	trace: HybridSearchTrace;
}

export class HybridRetriever {
	#store: RecallStore;
	#toolResultStore?: ToolResultStore;
	#sessionId: string;
	#projectCwd: string;
	#mmrLambda: number;
	#rrfK: number;
	#semanticOverfetchFactor: number;
	#keywordOverfetchFactor: number;
	#recentWindowMs: number;

	constructor(options: HybridRetrieverOptions) {
		this.#store = options.store;
		this.#toolResultStore = options.toolResultStore;
		this.#sessionId = options.sessionId;
		this.#projectCwd = options.projectCwd;
		this.#mmrLambda = options.mmrLambda ?? 0.7;
		this.#rrfK = options.rrfK ?? DEFAULT_RRF_K;
		this.#semanticOverfetchFactor = options.semanticOverfetchFactor ?? DEFAULT_SEMANTIC_OVERFETCH_FACTOR;
		this.#keywordOverfetchFactor = options.keywordOverfetchFactor ?? DEFAULT_KEYWORD_OVERFETCH_FACTOR;
		this.#recentWindowMs = normalizeRecentWindowMs(options.recentWindowMs);
	}

	async search(request: HybridSearchRequest): Promise<HybridSearchResponse> {
		const mode = request.mode ?? "hybrid";
		const effectiveFilter = this.#buildEffectiveFilter(request);
		const semanticLimit = Math.max(request.limit * this.#semanticOverfetchFactor, request.limit);
		const semanticResults = await this.#store.search(request.queryVector, semanticLimit, effectiveFilter);
		if (semanticResults.length === 0) {
			return {
				results: [],
				trace: {
					mode,
					semanticCandidates: 0,
					keywordCandidates: 0,
					resolvedKeywordCandidates: 0,
					fusedCandidates: 0,
					candidates: [],
				},
			};
		}

		if (mode === "semantic" || !this.#toolResultStore) {
			const reranked = this.#rerankSemantic(semanticResults, request.limit, request.mmrLambda);
			return {
				results: reranked,
				trace: {
					mode,
					semanticCandidates: semanticResults.length,
					keywordCandidates: 0,
					resolvedKeywordCandidates: 0,
					fusedCandidates: semanticResults.length,
					candidates: this.#buildSemanticCandidateTrace(semanticResults),
				},
			};
		}

		const keywordResults = this.#toolResultStore.search(request.query, {
			limit: Math.max(request.limit * this.#keywordOverfetchFactor, request.limit),
			projectCwd: request.project === "current" ? this.#projectCwd : undefined,
			role: request.role,
		});
		if (keywordResults.length === 0) {
			const reranked = this.#rerankSemantic(semanticResults, request.limit, request.mmrLambda);
			return {
				results: reranked,
				trace: {
					mode,
					semanticCandidates: semanticResults.length,
					keywordCandidates: 0,
					resolvedKeywordCandidates: 0,
					fusedCandidates: semanticResults.length,
					candidates: this.#buildSemanticCandidateTrace(semanticResults),
				},
			};
		}

		const semanticRankByKey = new Map<string, number>();
		const semanticByKey = new Map<string, RecallSearchResult>();
		for (const [index, result] of semanticResults.entries()) {
			const rowKey = buildRecallRowKey(result);
			semanticRankByKey.set(rowKey, index + 1);
			semanticByKey.set(rowKey, result);
		}

		const keywordRankByKey = new Map<string, number>();
		const unresolvedKeywordLookups: RecallLookupKey[] = [];
		for (const [index, result] of keywordResults.entries()) {
			const keywordRowKey =
				result.rowKey ||
				buildRecallRowKey({
					session_id: result.sessionId,
					turn: result.turnNumber,
					role: result.role,
					tool_name: result.toolName,
					text: result.content,
				});
			keywordRankByKey.set(keywordRowKey, index + 1);
			if (!semanticByKey.has(keywordRowKey)) {
				unresolvedKeywordLookups.push(
					buildRecallLookupKey({
						session_id: result.sessionId,
						turn: result.turnNumber,
						role: result.role,
						tool_name: result.toolName,
						text: result.content,
					}),
				);
			}
		}

		const resolvedKeywordRows = await this.#store.getByLookupKeys(unresolvedKeywordLookups);
		const fused = new Map<string, RecallSearchResult>(semanticByKey);
		for (const [rowKey, row] of resolvedKeywordRows) {
			fused.set(rowKey, {
				...row,
				_distance: Number.POSITIVE_INFINITY,
			});
		}

		const fusedResults = Array.from(fused.values());
		const candidateTrace = this.#buildHybridCandidateTrace(fusedResults, semanticRankByKey, keywordRankByKey);
		const reranked = mmrRerank(
			fusedResults.map(result => {
				const rowKey = buildRecallRowKey(result);
				const score = this.#scoreResult({
					result,
					query: request.query,
					semanticRank: semanticRankByKey.get(rowKey),
					keywordRank: keywordRankByKey.get(rowKey),
				});
				const candidate: MmrCandidate<RecallSearchResult> = {
					vector: result.vector,
					score,
					data: result,
				};
				return candidate;
			}),
			request.mmrLambda ?? this.#mmrLambda,
		)
			.slice(0, request.limit)
			.map(candidate => candidate.data);

		return {
			results: reranked,
			trace: {
				mode,
				semanticCandidates: semanticResults.length,
				keywordCandidates: keywordResults.length,
				resolvedKeywordCandidates: resolvedKeywordRows.size,
				fusedCandidates: fusedResults.length,
				candidates: candidateTrace,
			},
		};
	}

	#rerankSemantic(results: RecallSearchResult[], limit: number, mmrLambda?: number): RecallSearchResult[] {
		return mmrRerank(
			results.map(result => ({
				vector: result.vector,
				score: 1 / (1 + result._distance),
				data: result,
			})),
			mmrLambda ?? this.#mmrLambda,
		)
			.slice(0, limit)
			.map(candidate => candidate.data);
	}

	#buildSemanticCandidateTrace(results: RecallSearchResult[]): RecallDebugCandidateTrace[] {
		return results.map((result, index) => ({
			rowKey: buildRecallRowKey(result),
			semanticRank: index + 1,
			keywordRank: null,
			source: "semantic",
		}));
	}

	#buildHybridCandidateTrace(
		results: RecallSearchResult[],
		semanticRankByKey: Map<string, number>,
		keywordRankByKey: Map<string, number>,
	): RecallDebugCandidateTrace[] {
		return results.map(result => {
			const rowKey = buildRecallRowKey(result);
			const semanticRank = semanticRankByKey.get(rowKey) ?? null;
			const keywordRank = keywordRankByKey.get(rowKey) ?? null;
			let source: RecallDebugSource = "unknown";
			if (semanticRank && keywordRank) {
				source = "fused";
			} else if (semanticRank) {
				source = "semantic";
			} else if (keywordRank) {
				source = "keyword";
			}
			return { rowKey, semanticRank, keywordRank, source };
		});
	}

	#scoreResult(options: {
		result: RecallSearchResult;
		query: string;
		semanticRank?: number;
		keywordRank?: number;
	}): number {
		const { result, query, semanticRank, keywordRank } = options;
		let score = 0;
		if (semanticRank !== undefined) {
			score += this.#rrf(semanticRank);
			score += (1 / (1 + result._distance)) * SEMANTIC_DISTANCE_WEIGHT;
		}
		if (keywordRank !== undefined) {
			score += this.#rrf(keywordRank);
		}
		if (result.session_id === this.#sessionId) {
			score += SAME_SESSION_BOOST;
		}
		if (result.project_cwd === this.#projectCwd) {
			score += SAME_PROJECT_BOOST;
		}
		if (this.#queryMentionsPath(query, result.paths)) {
			score += EXACT_PATH_BOOST;
		}
		if (this.#queryMentionsSymbol(query, result.symbols)) {
			score += EXACT_SYMBOL_BOOST;
		}
		score += this.#absoluteFreshnessBoost(result.timestamp);
		return score;
	}

	#absoluteFreshnessBoost(timestamp: number): number {
		const ageMs = getRecallAgeMs(timestamp);
		if (ageMs <= DEFAULT_LIVE_WINDOW_MS) return LIVE_FRESHNESS_BOOST;
		if (ageMs <= this.#recentWindowMs) return RECENT_FRESHNESS_BOOST;
		return 0;
	}

	#buildEffectiveFilter(request: HybridSearchRequest): string | undefined {
		const clauses: string[] = [];
		if (request.project === "current") {
			clauses.push(`project_cwd = '${this.#escapeSqlLiteral(this.#projectCwd)}'`);
		}
		if (request.role) {
			clauses.push(`role = '${this.#escapeSqlLiteral(request.role)}'`);
		}
		if (request.filter?.trim()) {
			clauses.push(`(${request.filter.trim()})`);
		}
		return clauses.length > 0 ? clauses.join(" AND ") : undefined;
	}

	#escapeSqlLiteral(value: string): string {
		return value.replace(/'/g, "''");
	}

	#rrf(rank: number): number {
		return 1 / (this.#rrfK + rank);
	}

	#queryMentionsPath(query: string, rawPaths: string | null): boolean {
		if (!rawPaths) return false;
		const normalizedQuery = query.toLowerCase();
		const paths = this.#parseJsonArray(rawPaths);
		return paths.some(value => {
			const lower = value.toLowerCase();
			return normalizedQuery.includes(lower) || normalizedQuery.includes(path.basename(lower));
		});
	}

	#queryMentionsSymbol(query: string, rawSymbols: string | null): boolean {
		if (!rawSymbols) return false;
		const normalizedQuery = query.toLowerCase();
		return this.#parseJsonArray(rawSymbols).some(symbol => normalizedQuery.includes(symbol.toLowerCase()));
	}

	#parseJsonArray(value: string): string[] {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((item): item is string => typeof item === "string");
		} catch {
			return [];
		}
	}
}
