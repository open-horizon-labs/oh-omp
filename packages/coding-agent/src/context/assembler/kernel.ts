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
import { createBudgetTracker, estimateTokensFromCharCount, hydrateCandidates, stubRetriever } from "./hydrator";
import { rankCandidates } from "./scoring";
import {
	type AssemblerConfig,
	type AssemblerTurnInput,
	type BudgetDerivationInput,
	DEFAULT_MAX_CANDIDATES,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCORING_WEIGHTS,
	type ScoringContext,
	type ScoringWeights,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Budget derivation
// ═══════════════════════════════════════════════════════════════════════════

/** Default latency budget (ms) for hydration. */
const DEFAULT_MAX_LATENCY_MS = 2000;

/** Safety margin applied to derived budget to absorb estimation error. */
const BUDGET_SAFETY_MARGIN = 0.9;

/**
 * Fallback budget when no model-derived budget or working memory budget exists.
 *
 * Reserved tokens are zero — reserves should only account for fields that are
 * actually populated. Once WM rebuild and STM distillation land, their
 * reserves become real.
 */
const DEFAULT_BUDGET: MemoryAssemblyBudget = {
	maxTokens: 40_000,
	maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
	reservedTokens: {
		objective: 0,
		codeContext: 0,
		executionState: 0,
	},
};

/**
 * Derive the assembler budget from model context window minus measured costs.
 *
 * Budget decomposition:
 *   available = contextWindow - systemPromptTokens - toolDefinitionTokens - currentTurnTokens
 *
 * A safety margin ({@link BUDGET_SAFETY_MARGIN}) is applied to the result to
 * absorb chars/4 estimation error. Over-estimating costs is safer than under-estimating.
 *
 * Reserved tokens are zero — they should only reserve space for fields that
 * are actually populated. Once working memory rebuild and STM distillation
 * are wired, their reserves will be set to real measured values.
 */
export function deriveBudget(input: BudgetDerivationInput): MemoryAssemblyBudget {
	const totalCosts = input.systemPromptTokens + input.toolDefinitionTokens + input.currentTurnTokens;
	const rawAvailable = input.contextWindow - totalCosts;
	const available = Math.max(0, Math.floor(rawAvailable * BUDGET_SAFETY_MARGIN));

	return {
		maxTokens: available,
		maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
		reservedTokens: {
			objective: 0,
			codeContext: 0,
			executionState: 0,
		},
	};
}

/**
 * Estimate the token cost of tool definitions as serialized for the LLM.
 *
 * Sums name + description + JSON-stringified parameter schema for each tool,
 * then applies the chars/4 heuristic. Conservative: real serialization adds
 * envelope overhead, so this slightly under-estimates.
 */
export function estimateToolDefinitionTokens(
	tools: Array<{ name: string; description?: string; parameters?: unknown }>,
): number {
	let chars = 0;
	for (const tool of tools) {
		chars += tool.name.length;
		chars += tool.description?.length ?? 0;
		if (tool.parameters) {
			chars += JSON.stringify(tool.parameters).length;
		}
	}
	return estimateTokensFromCharCount(chars);
}

/**
 * Estimate the token cost of agent messages for budget derivation.
 *
 * Extracts text content from messages and sums via chars/4 heuristic.
 * Non-text content (images, tool calls) is approximated by JSON stringification.
 * Messages without a content field are skipped gracefully.
 */
export function estimateMessageTokens(messages: unknown[]): number {
	let chars = 0;
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const content = (msg as Record<string, unknown>).content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "string") {
					chars += block.length;
				} else if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
					chars += block.text.length;
				} else {
					chars += JSON.stringify(block).length;
				}
			}
		} else if (content != null) {
			chars += JSON.stringify(content).length;
		}
	}
	return estimateTokensFromCharCount(chars);
}

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

	// Resolve budget: config-derived > working memory > fallback default
	// config.budget is set by sdk.ts with a model-derived budget.
	// contract.working?.budget may have a budget from a previous turn.
	// DEFAULT_BUDGET is the last-resort fallback.
	const budget: MemoryAssemblyBudget = config.budget ?? contract.working?.budget ?? DEFAULT_BUDGET;
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

	// Invalidation tags: the bridge already evicts stale locators in real-time
	// when mutations occur (#trackMutation → #invalidateByPaths). Building
	// invalidation tags from STM touchedPaths would self-invalidate every
	// locator (since a read/grep of path X adds X to both the locator's
	// invalidatedBy and the STM's touchedPaths). Pass an empty set here;
	// the bridge's eager invalidation is the authoritative mechanism.
	const invalidationTags = new Set<string>();

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
