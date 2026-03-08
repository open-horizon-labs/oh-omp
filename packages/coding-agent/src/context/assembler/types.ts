/**
 * Kernel-internal types for the local assembler.
 *
 * These types are implementation details — they support scoring, hydration,
 * and budget tracking but are not part of the MemoryContractV1 surface.
 */

import type {
	MemoryAssemblyBudget,
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
	/**
	 * Pre-derived budget from model context window.
	 * When provided, overrides both DEFAULT_BUDGET and working memory budget.
	 * Use `deriveBudget()` from the kernel to compute this.
	 */
	budget?: MemoryAssemblyBudget;
	/**
	 * MMR lambda for diversity-aware reranking (0–1).
	 * 1.0 = pure relevance (no diversity), 0.0 = pure diversity.
	 * Default: {@link DEFAULT_MMR_LAMBDA}.
	 */
	mmrLambda?: number;
	/** Max parallel retrieval requests during hydration. Default: {@link DEFAULT_CONCURRENCY}. */
	concurrency?: number;
	/** Timeout (ms) for individual retrieval calls. Default: {@link DEFAULT_PER_ENTRY_TIMEOUT_MS}. */
	perEntryTimeoutMs?: number;
	/**
	 * Max tokens per fragment. Oversized content is truncated to fit.
	 * When omitted, auto-scaled from budget (20% of available, capped at 50K).
	 */
	maxTokensPerFragment?: number;
}

/**
 * Input for deriving the assembler budget from model context window.
 *
 * Budget decomposition:
 *   available = contextWindow - systemPromptTokens - toolDefinitionTokens - currentTurnTokens
 *
 * Fixed costs (measured per turn via chars/4 heuristic):
 *   - System prompt          (~5-15K tokens)
 *   - Tool definitions       (~10-20K tokens)
 *
 * Variable costs (measured per turn):
 *   - Current-turn messages   (variable)
 *
 * Available for assembler:
 *   - Previous-turn management
 *   - Hydrated fragments
 *   - Working memory
 */
export interface BudgetDerivationInput {
	/** Model's total context window in tokens. */
	contextWindow: number;
	/** Estimated tokens consumed by the system prompt. */
	systemPromptTokens: number;
	/** Estimated tokens consumed by tool definitions (JSON schema). */
	toolDefinitionTokens: number;
	/** Estimated tokens consumed by current-turn messages. */
	currentTurnTokens: number;
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

/** Default MMR lambda: 0.7 balances relevance and diversity. */
export const DEFAULT_MMR_LAMBDA = 0.7;

/** Default parallel retrieval concurrency. */
export const DEFAULT_CONCURRENCY = 10;

/** Default per-entry retrieval timeout (ms). */
export const DEFAULT_PER_ENTRY_TIMEOUT_MS = 500;

/** Minimum useful fragment size in tokens — fragments below this are not worth truncating to. */
export const MIN_FRAGMENT_TOKENS = 50;
