/**
 * Kernel-internal types for the local assembler.
 *
 * These types are implementation details — they support scoring, hydration,
 * and budget tracking but are not part of the MemoryContractV1 surface.
 */

import type {
	MemoryContextFragment,
	MemoryFragmentDropReason,
	MemoryLocatorEntry,
	MemoryTierName,
} from "../memory-contract";

// ═══════════════════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════════════════

/** Weights used by the deterministic scoring policy. */
export interface ScoringWeights {
	/** Weight for file-path overlap with active context. */
	fileOverlap: number;
	/** Weight for symbol overlap with active context. */
	symbolOverlap: number;
	/** Weight for unresolved-loop relevance. */
	failureRelevance: number;
	/** Weight for temporal recency (0–1 normalized). */
	recency: number;
	/** Weight for trust level. */
	trust: number;
	/** Weight for memory tier priority. */
	tier: number;
}

/** Contextual signals from working memory used during scoring. */
export interface ScoringContext {
	activePaths: string[];
	activeSymbols: string[];
	unresolvedLoops: string[];
	/** Reference timestamp for recency calculation (ISO 8601). */
	now: string;
}

/** Intermediate result from scoring a single locator entry. */
export interface ScoredCandidate {
	locator: MemoryLocatorEntry;
	score: number;
	breakdown: ScoringBreakdown;
}

/** Per-signal score breakdown for debugging and testing. */
export interface ScoringBreakdown {
	fileOverlap: number;
	symbolOverlap: number;
	failureRelevance: number;
	recency: number;
	trust: number;
	tier: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hydration
// ═══════════════════════════════════════════════════════════════════════════

/** Result of hydrating a single locator entry. */
export interface HydrationResult {
	fragment: MemoryContextFragment;
	consumedTokens: number;
	consumedLatencyMs: number;
}

/** Reason a candidate was not hydrated. */
export interface HydrationDrop {
	id: string;
	reason: MemoryFragmentDropReason;
}

/** Retrieval function signature for pluggable hydration backends. */
export type LocatorRetriever = (entry: MemoryLocatorEntry) => Promise<string | null>;

// ═══════════════════════════════════════════════════════════════════════════
// Budget
// ═══════════════════════════════════════════════════════════════════════════

/** Mutable budget tracker consumed during hydration. */
export interface BudgetTracker {
	readonly maxTokens: number;
	readonly maxLatencyMs: number;
	consumedTokens: number;
	consumedLatencyMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Kernel configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Per-turn input to the assembler kernel. */
export interface AssemblerTurnInput {
	turnId: string;
	objective: string;
	activePaths: string[];
	activeSymbols: string[];
	unresolvedLoops: string[];
}

/** Configuration for a kernel assembly pass. */
export interface AssemblerConfig {
	/** Scoring weights (use defaults if omitted). */
	weights?: Partial<ScoringWeights>;
	/** Custom retriever for locator hydration (stub by default). */
	retriever?: LocatorRetriever;
	/** Minimum score threshold; candidates below are dropped as low_score. */
	minScore?: number;
	/** Maximum number of candidates to hydrate after scoring. */
	maxCandidates?: number;
	/** Override current timestamp (ISO 8601) for deterministic assembly. */
	now?: string;
}

/** Tier base-score values, ordered by priority. */
export const TIER_BASE_SCORES: Record<MemoryTierName, number> = {
	working: 1.0,
	short_term: 0.6,
	long_term: 0.3,
};

/** Trust-level base-score values. */
export const TRUST_BASE_SCORES: Record<string, number> = {
	authoritative: 1.0,
	derived: 0.6,
	heuristic: 0.3,
};

/** Default scoring weights. */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
	fileOverlap: 0.25,
	symbolOverlap: 0.2,
	failureRelevance: 0.2,
	recency: 0.15,
	trust: 0.1,
	tier: 0.1,
};

/** Default minimum score threshold. */
export const DEFAULT_MIN_SCORE = 0.05;

/** Default max candidates to hydrate. */
export const DEFAULT_MAX_CANDIDATES = 50;
