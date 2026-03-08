/**
 * Versioned context assembly contract for coding-agent memory tiers.
 *
 * The contract is intentionally locator-first: it prefers addressable retrieval
 * recipes over storing large payloads in prompt context.
 */

/** Increment when MemoryContractV1 changes in a breaking way. */
export const MEMORY_CONTRACT_VERSION = 1 as const;

/** Tier taxonomy used by assembly and telemetry components. */
export const MEMORY_TIER_NAMES = ["long_term", "short_term", "working"] as const;
export type MemoryTierName = (typeof MEMORY_TIER_NAMES)[number];

const memoryTierNameSet = new Set<string>(MEMORY_TIER_NAMES);

/** Trust levels for locator entries and promoted facts. */
export const MEMORY_LOCATOR_TRUST_LEVELS = ["authoritative", "derived", "heuristic"] as const;
export type MemoryLocatorTrustLevel = (typeof MEMORY_LOCATOR_TRUST_LEVELS)[number];

const memoryLocatorTrustLevelSet = new Set<string>(MEMORY_LOCATOR_TRUST_LEVELS);

/**
 * Canonical retrieval methods used by locator map entries.
 * Additional methods are allowed via namespaced strings (e.g. custom.extension.fetch).
 */
export const MEMORY_LOCATOR_RETRIEVAL_METHODS = [
	"read",
	"grep",
	"find",
	"lsp.definition",
	"lsp.references",
	"lsp.hover",
	"rpc.get_state",
	"rpc.get_session_stats",
	"rpc.get_messages",
	"rpc.get_branch_messages",
	"rpc.get_last_assistant_text",
	"rpc.get_introspection",
	"session.getAsyncJobSnapshot",
	"memory.read",
] as const;

export type MemoryLocatorCanonicalRetrievalMethod = (typeof MEMORY_LOCATOR_RETRIEVAL_METHODS)[number];
export type MemoryLocatorCustomRetrievalMethod = `${string}.${string}`;
export type MemoryLocatorRetrievalMethod = MemoryLocatorCanonicalRetrievalMethod | MemoryLocatorCustomRetrievalMethod;

const memoryLocatorRetrievalMethodSet = new Set<string>(MEMORY_LOCATOR_RETRIEVAL_METHODS);

/**
 * Reasons for dropping candidate fragments during budgeted assembly.
 */
export const MEMORY_FRAGMENT_DROP_REASONS = [
	"token_budget",
	"latency_budget",
	"stale",
	"invalidated",
	"low_score",
	"retrieval_timeout",
] as const;

export type MemoryFragmentDropReason = (typeof MEMORY_FRAGMENT_DROP_REASONS)[number];

/**
 * Source attribution for memory records and assembled fragments.
 */
export interface MemoryProvenance {
	source: string;
	reason: string;
	capturedAt: string;
	confidence: number;
}

/**
 * Estimated retrieval cost used for budget-aware hydration.
 */
export interface MemoryRetrievalCostEstimate {
	estimatedTokens: number;
	estimatedLatencyMs: number;
}

/**
 * Freshness/invalidation policy for locator entries.
 */
export interface MemoryFreshnessPolicy {
	ttlMs: number;
	invalidatedBy: string[];
}

/**
 * Retrieval recipe used by locator entries.
 */
export interface MemoryLocatorRecipe {
	method: MemoryLocatorRetrievalMethod;
	params?: Record<string, unknown>;
}

/**
 * Addressable retrieval unit used by all memory tiers.
 */
export interface MemoryLocatorEntry {
	key: string;
	tier: MemoryTierName;
	where: string;
	how: MemoryLocatorRecipe;
	cost: MemoryRetrievalCostEstimate;
	freshness: MemoryFreshnessPolicy;
	trust: MemoryLocatorTrustLevel;
	provenance: MemoryProvenance;
}

/**
 * Stable, durable records promoted across sessions.
 */
export interface LongTermMemoryRecord {
	id: string;
	summary: string;
	locatorKeys: string[];
	tags?: string[];
	provenance: MemoryProvenance;
}

/**
 * Active-session continuity records; high churn, short half-life.
 */
export interface ShortTermMemoryRecord {
	id: string;
	objective: string;
	touchedPaths: string[];
	touchedSymbols: string[];
	unresolvedLoops: string[];
	locatorKeys: string[];
	updatedAt: string;
	provenance: MemoryProvenance;
}

/**
 * Turn-local budget contract.
 */
export interface MemoryAssemblyBudget {
	maxTokens: number;
	maxLatencyMs: number;
	reservedTokens: {
		objective: number;
		codeContext: number;
		executionState: number;
	};
}

/**
 * Actual budget usage for an assembled packet.
 */
export interface MemoryAssemblyUsage {
	consumedTokens: number;
	consumedLatencyMs: number;
}

/**
 * Turn-local active memory state rebuilt each turn.
 */
export interface WorkingMemoryState {
	turnId: string;
	subgoal: string;
	hypotheses: string[];
	nextActions: string[];
	activePaths: string[];
	activeSymbols: string[];
	unresolvedLoops: string[];
	locatorKeys: string[];
	budget: MemoryAssemblyBudget;
	updatedAt: string;
}

/**
 * Ranked fragment candidate selected for prompt injection.
 */
export interface MemoryContextFragment {
	id: string;
	tier: MemoryTierName;
	content: string;
	locatorKey?: string;
	score: number;
	provenance: MemoryProvenance;
}

/**
 * Structured output from a single turn's context assembly pass.
 */
export interface WorkingContextPacketV1 {
	version: typeof MEMORY_CONTRACT_VERSION;
	objective: string;
	generatedAt: string;
	budget: MemoryAssemblyBudget;
	usage: MemoryAssemblyUsage;
	fragments: MemoryContextFragment[];
	dropped: Array<{ id: string; reason: MemoryFragmentDropReason }>;
}

/**
 * Full tiered memory state contract.
 */
export interface MemoryContractV1 {
	version: typeof MEMORY_CONTRACT_VERSION;
	locatorMap: MemoryLocatorEntry[];
	longTerm: LongTermMemoryRecord[];
	shortTerm: ShortTermMemoryRecord[];
	working: WorkingMemoryState | null;
}

export function isMemoryTierName(value: unknown): value is MemoryTierName {
	return typeof value === "string" && memoryTierNameSet.has(value);
}

export function isMemoryLocatorTrustLevel(value: unknown): value is MemoryLocatorTrustLevel {
	return typeof value === "string" && memoryLocatorTrustLevelSet.has(value);
}

export function isMemoryLocatorCanonicalRetrievalMethod(
	value: unknown,
): value is MemoryLocatorCanonicalRetrievalMethod {
	return typeof value === "string" && memoryLocatorRetrievalMethodSet.has(value);
}

export function isMemoryLocatorRetrievalMethod(value: unknown): value is MemoryLocatorRetrievalMethod {
	if (typeof value !== "string") return false;
	if (memoryLocatorRetrievalMethodSet.has(value)) return true;
	const separatorIndex = value.indexOf(".");
	return separatorIndex > 0 && separatorIndex < value.length - 1;
}
