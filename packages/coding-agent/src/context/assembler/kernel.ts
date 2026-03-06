/**
 * Local assembler kernel V1.
 *
 * Reads MemoryContractV1 state, scores and ranks locator entries, hydrates
 * top candidates within budget, and produces a WorkingContextPacketV1.
 *
 * Module boundaries are adapter-friendly: a remote assembler can replace
 * the kernel by implementing the same `assemble()` signature.
 */

import {
	MEMORY_CONTRACT_VERSION,
	type MemoryAssemblyBudget,
	type MemoryAssemblyUsage,
	type MemoryContractV1,
	type WorkingContextPacketV1,
} from "../memory-contract";
import { createBudgetTracker, hydrateCandidates, stubRetriever } from "./hydrator";
import { rankCandidates } from "./scoring";
import {
	type AssemblerConfig,
	type AssemblerTurnInput,
	DEFAULT_MAX_CANDIDATES,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCORING_WEIGHTS,
	type ScoringContext,
	type ScoringWeights,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Default budget
// ═══════════════════════════════════════════════════════════════════════════

/** Default assembly budget when working memory has none. */
const DEFAULT_BUDGET: MemoryAssemblyBudget = {
	maxTokens: 4096,
	maxLatencyMs: 2000,
	reservedTokens: {
		objective: 256,
		codeContext: 2048,
		executionState: 512,
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Kernel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assemble a working-context packet from tiered memory state.
 *
 * 1. Merge locator entries from the contract's locator map.
 * 2. Build scoring context from the turn input and working memory.
 * 3. Score and rank all candidates.
 * 4. Filter by minimum score, cap at maxCandidates.
 * 5. Hydrate within token/latency budget, tracking drops.
 * 6. Return a fully-formed WorkingContextPacketV1.
 */
export async function assemble(
	contract: MemoryContractV1,
	turn: AssemblerTurnInput,
	config: AssemblerConfig = {},
): Promise<WorkingContextPacketV1> {
	const now = config.now ?? new Date().toISOString();
	const nowMs = new Date(now).getTime();

	// Resolve configuration
	const weights: ScoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...config.weights };
	const retriever = config.retriever ?? stubRetriever;
	const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
	const maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

	// Resolve budget from working memory or defaults
	const budget: MemoryAssemblyBudget = contract.working?.budget ?? DEFAULT_BUDGET;
	const availableTokens =
		budget.maxTokens -
		budget.reservedTokens.objective -
		budget.reservedTokens.codeContext -
		budget.reservedTokens.executionState;

	// Build scoring context from turn input
	const scoringCtx: ScoringContext = {
		activePaths: [...turn.activePaths, ...(contract.working?.activePaths ?? [])],
		activeSymbols: [...turn.activeSymbols, ...(contract.working?.activeSymbols ?? [])],
		unresolvedLoops: [...turn.unresolvedLoops, ...(contract.working?.unresolvedLoops ?? [])],
		now,
	};

	// Score and rank
	const ranked = rankCandidates(contract.locatorMap, scoringCtx, weights);

	// Cap at maxCandidates
	const capped = ranked.slice(0, maxCandidates);

	// Build invalidation tags from short-term memory touched paths
	const invalidationTags = new Set<string>();
	for (const stm of contract.shortTerm) {
		for (const path of stm.touchedPaths) {
			invalidationTags.add(path);
		}
	}

	// Hydrate within budget
	const tracker = createBudgetTracker(Math.max(0, availableTokens), budget.maxLatencyMs);
	const { fragments, drops } = await hydrateCandidates({
		candidates: capped,
		budget: tracker,
		retriever,
		nowMs,
		invalidationTags,
		minScore,
	});

	// Build usage
	const usage: MemoryAssemblyUsage = {
		consumedTokens: tracker.consumedTokens,
		consumedLatencyMs: tracker.consumedLatencyMs,
	};

	return {
		version: MEMORY_CONTRACT_VERSION,
		objective: turn.objective,
		generatedAt: now,
		budget,
		usage,
		fragments,
		dropped: drops,
	};
}
