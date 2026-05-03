import { formatRecallAge, getRecallAgeMs, getRecallBand, type RecallBand } from "./temporal";
import { buildRecallRowKey, type RecallRow, type RecallSearchResult } from "./types";

export type RecallDebugSource = "semantic" | "keyword" | "fused" | "cache" | "unknown";

export interface RecallDebugCandidateTrace {
	rowKey: string;
	semanticRank: number | null;
	keywordRank: number | null;
	source: RecallDebugSource;
}

export interface RecallDebugEntry {
	rank: number;
	rowKey: string;
	role: RecallRow["role"];
	turn: number;
	toolName: string | null;
	timestamp: number;
	ageMs: number;
	age: string;
	band: RecallBand;
	sessionId: string;
	projectCwd: string;
	sameSession: boolean;
	sameProject: boolean;
	source: RecallDebugSource;
	semanticRank: number | null;
	keywordRank: number | null;
	textPreview: string;
}

export interface RecallDebugTrace {
	turnId: string | null;
	capturedAt: string;
	attempted: boolean;
	injected: boolean;
	cacheHit: boolean;
	durationMs: number;
	failure: string | null;
	query: {
		text: string;
		charCount: number;
		estimatedTokens: number;
		hotWindowTurns: number;
		embeddingGenerated: boolean;
		originalCharCount: number;
		effectiveCharCount: number;
		toolResultRawCharCount: number;
		toolResultEffectiveCharCount: number;
		toolResults: {
			encoded: number;
			stubbed: number;
			counts: Record<string, number>;
		};
	};
	retrieval: {
		mode: "semantic" | "hybrid";
		projectScope: "current" | "all";
		roleFilter: RecallRow["role"] | null;
		recentWindowMs: number;
		topK: number;
		semanticCandidates: number;
		keywordCandidates: number;
		resolvedKeywordCandidates: number;
		fusedCandidates: number;
	};
	selected: RecallDebugEntry[];
	dropped: RecallDebugEntry[];
	injectedText: string | null;
	injectedTokenEstimate: number;
}

export function buildRecallDebugEntries(
	results: RecallSearchResult[],
	options: {
		now: number;
		sessionId: string;
		projectCwd: string;
		recentWindowMs: number;
		provenance?: Map<string, RecallDebugCandidateTrace>;
		sourceFallback?: RecallDebugSource;
	},
): RecallDebugEntry[] {
	return results.map((result, index) => {
		const rowKey = buildRecallRowKey(result);
		const provenance = options.provenance?.get(rowKey);
		const ageMs = getRecallAgeMs(result.timestamp, options.now);
		return {
			rank: index + 1,
			rowKey,
			role: result.role,
			turn: result.turn,
			toolName: result.tool_name,
			timestamp: result.timestamp,
			ageMs,
			age: formatRecallAge(ageMs),
			band: getRecallBand(ageMs, options.recentWindowMs),
			sessionId: result.session_id,
			projectCwd: result.project_cwd,
			sameSession: result.session_id === options.sessionId,
			sameProject: result.project_cwd === options.projectCwd,
			source: provenance?.source ?? options.sourceFallback ?? "unknown",
			semanticRank: provenance?.semanticRank ?? null,
			keywordRank: provenance?.keywordRank ?? null,
			textPreview: compactRecallPreview(result.text),
		};
	});
}

function compactRecallPreview(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
