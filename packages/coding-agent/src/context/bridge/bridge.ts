/**
 * Tool-result-to-memory bridge.
 *
 * Subscribes to AgentSessionEvent stream and populates MemoryContractV1
 * with locator entries generated from tool execution results.
 *
 * The bridge is observe-only: it populates the contract but does not
 * control whether the contract is used for prompt assembly (that is
 * determined by the context-manager mode).
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { LocatorRetriever } from "../assembler/types";
import type {
	MemoryContractV1,
	MemoryLocatorEntry,
	MemoryLocatorRetrievalMethod,
	MemoryProvenance,
	ShortTermMemoryRecord,
} from "../memory-contract";
import { MEMORY_CONTRACT_VERSION } from "../memory-contract";
import { classifyResult, TOOL_CATEGORY_MAP } from "./classify";
import { type ArtifactResolver, createCompositeRetriever } from "./retriever";
import { type BridgeConfig, DEFAULT_MAX_LOCATOR_ENTRIES, type ResultProfile } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Bridge
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ToolResultBridge observes tool execution events and generates
 * MemoryLocatorEntry records in a MemoryContractV1.
 *
 * Responsibilities:
 * - Classify each tool result into a category with freshness policy
 * - Generate locator entries for non-control results
 * - Track touched paths and symbols in ShortTermMemoryRecord
 * - Invalidate stale locator entries when file edits occur
 * - Provide a composite retriever for the assembler kernel
 */
export class ToolResultBridge {
	readonly #contract: MemoryContractV1;
	readonly #stm: ShortTermMemoryRecord;
	readonly #config: Required<BridgeConfig>;
	readonly #editedPaths = new Set<string>();

	constructor(config: BridgeConfig = {}) {
		const now = config.now ?? new Date().toISOString();

		this.#config = {
			now: now,
			maxLocatorEntries: config.maxLocatorEntries ?? DEFAULT_MAX_LOCATOR_ENTRIES,
		};

		this.#contract = {
			version: MEMORY_CONTRACT_VERSION,
			locatorMap: [],
			longTerm: [],
			shortTerm: [],
			working: null,
		};

		this.#stm = {
			id: "bridge-stm",
			objective: "",
			touchedPaths: [],
			touchedSymbols: [],
			unresolvedLoops: [],
			locatorKeys: [],
			updatedAt: now,
			provenance: {
				source: "bridge",
				reason: "tool-result-observation",
				capturedAt: now,
				confidence: 1.0,
			},
		};

		this.#contract.shortTerm.push(this.#stm);
	}

	/** The populated memory contract. */
	get contract(): MemoryContractV1 {
		return this.#contract;
	}

	/** Create a composite retriever backed by the given artifact resolver. */
	createRetriever(resolver: ArtifactResolver): LocatorRetriever {
		return createCompositeRetriever(resolver);
	}

	/**
	 * Handle a tool_execution_end event.
	 *
	 * This is the main entry point called by the event subscriber.
	 */
	handleToolResult(toolName: string, toolCallId: string, args: unknown, result: unknown, isError: boolean): void {
		const safeArgs = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;

		const profile = classifyResult(toolName, safeArgs, result, isError);

		// Control tools are never retained
		if (profile.category === "control") {
			return;
		}

		// Track mutations for invalidation
		if (profile.category === "mutation") {
			this.#trackMutation(profile);
		}

		// Generate locator entry
		const locator = this.#generateLocator(profile, toolCallId, safeArgs, result);
		if (locator) {
			this.#addLocator(locator);
		}

		// Accumulate STM state
		this.#accumulateSTM(profile);
	}

	// ═════════════════════════════════════════════════════════════════════
	// Locator generation
	// ═════════════════════════════════════════════════════════════════════

	#generateLocator(
		profile: ResultProfile,
		toolCallId: string,
		args: Record<string, unknown>,
		result: unknown,
	): MemoryLocatorEntry | null {
		const now = this.#config.now;
		const primaryPath = profile.touchedPaths[0] ?? "unknown";

		// Build a unique key for this locator
		const key = `${profile.toolName}:${toolCallId}`;

		// Determine where (primary context location)
		const where = primaryPath;

		// Determine retrieval method from the category map
		const entry = TOOL_CATEGORY_MAP[profile.toolName];
		const method: MemoryLocatorRetrievalMethod = entry?.retrievalMethod ?? "read";

		// Build retrieval params
		const params: Record<string, unknown> = {};
		if (profile.hasArtifact) {
			// Extract artifact ID from result string
			const artifactId = extractArtifactId(result);
			if (artifactId) {
				params.artifactId = artifactId;
			}
		}
		if (primaryPath !== "unknown") {
			params.filePath = primaryPath;
		}
		// Preserve original args for re-execution
		if (method === "grep" || method === "find") {
			const pattern = args.pattern ?? args.query;
			if (typeof pattern === "string") {
				params.pattern = pattern;
			}
		}

		// Build freshness with invalidation tags for path-based entries
		const freshness = { ...profile.freshness };
		if (profile.touchedPaths.length > 0 && profile.category !== "mutation") {
			freshness.invalidatedBy = [...profile.touchedPaths];
		}

		const provenance: MemoryProvenance = {
			source: `tool:${profile.toolName}`,
			reason: profile.isError ? "error-observation" : "result-observation",
			capturedAt: now,
			confidence: profile.isError ? 0.5 : 0.9,
		};

		// Estimate cost based on result size
		const resultStr = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
		const estimatedTokens = Math.ceil(resultStr.length / 4);

		return {
			key,
			tier: "short_term",
			where,
			how: { method, params: Object.keys(params).length > 0 ? params : undefined },
			cost: { estimatedTokens: Math.min(estimatedTokens, 4096), estimatedLatencyMs: 50 },
			freshness,
			trust: profile.trust,
			provenance,
		};
	}

	// ═════════════════════════════════════════════════════════════════════
	// Mutation tracking & invalidation
	// ═════════════════════════════════════════════════════════════════════

	#trackMutation(profile: ResultProfile): void {
		for (const p of profile.touchedPaths) {
			this.#editedPaths.add(p);
		}

		// Invalidate existing locators that reference edited paths
		this.#invalidateByPaths(profile.touchedPaths);
	}

	#invalidateByPaths(paths: string[]): void {
		if (paths.length === 0) return;

		const pathSet = new Set(paths);
		const locators = this.#contract.locatorMap;

		// Remove locators whose invalidatedBy tags match any edited path
		const remaining: MemoryLocatorEntry[] = [];
		let removed = 0;
		for (const locator of locators) {
			let invalidated = false;
			for (const tag of locator.freshness.invalidatedBy) {
				if (pathSet.has(tag)) {
					invalidated = true;
					break;
				}
			}
			if (invalidated) {
				removed++;
			} else {
				remaining.push(locator);
			}
		}

		if (removed > 0) {
			const remainingKeys = new Set(remaining.map(l => l.key));
			this.#contract.locatorMap = remaining;
			this.#stm.locatorKeys = this.#stm.locatorKeys.filter(k => remainingKeys.has(k));
			logger.debug("Bridge invalidated locators", { paths, removed });
		}
	}

	// ═════════════════════════════════════════════════════════════════════
	// STM accumulation
	// ═════════════════════════════════════════════════════════════════════

	#accumulateSTM(profile: ResultProfile): void {
		const now = this.#config.now;

		// Accumulate touched paths (deduplicated)
		for (const p of profile.touchedPaths) {
			if (!this.#stm.touchedPaths.includes(p)) {
				this.#stm.touchedPaths.push(p);
			}
		}

		// Accumulate touched symbols (deduplicated)
		for (const s of profile.touchedSymbols) {
			if (!this.#stm.touchedSymbols.includes(s)) {
				this.#stm.touchedSymbols.push(s);
			}
		}

		// Track errors as unresolved loops
		if (profile.isError) {
			const loopKey = `${profile.toolName}:${profile.touchedPaths[0] ?? "unknown"}`;
			if (!this.#stm.unresolvedLoops.includes(loopKey)) {
				this.#stm.unresolvedLoops.push(loopKey);
			}
		}

		this.#stm.updatedAt = now;
	}

	// ═════════════════════════════════════════════════════════════════════
	// Locator management
	// ═════════════════════════════════════════════════════════════════════

	#addLocator(locator: MemoryLocatorEntry): void {
		// Evict oldest entries if at capacity
		const max = this.#config.maxLocatorEntries;
		while (this.#contract.locatorMap.length >= max) {
			const evicted = this.#contract.locatorMap.shift();
			if (evicted) {
				const idx = this.#stm.locatorKeys.indexOf(evicted.key);
				if (idx !== -1) this.#stm.locatorKeys.splice(idx, 1);
			}
		}

		this.#contract.locatorMap.push(locator);
		this.#stm.locatorKeys.push(locator.key);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract artifact ID from a result string containing artifact:// URLs. */
function extractArtifactId(result: unknown): string | null {
	if (typeof result !== "string") return null;
	const match = result.match(/artifact:\/\/([^\s/]+)/);
	return match ? match[1] : null;
}
