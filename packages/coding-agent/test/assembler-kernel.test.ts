import { describe, expect, test } from "bun:test";
import {
	type AssemblerTurnInput,
	assemble,
	createBudgetTracker,
	DEFAULT_BUDGET,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCORING_WEIGHTS,
	deriveBudget,
	estimateMessageTokens,
	estimateTokens,
	estimateTokensFromCharCount,
	estimateToolDefinitionTokens,
	hydrateCandidates,
	isFresh,
	type LocatorRetriever,
	rankCandidates,
	type ScoredCandidate,
	type ScoringContext,
	scoreCandidate,
	stubRetriever,
	TIER_BASE_SCORES,
	TRUST_BASE_SCORES,
} from "@oh-my-pi/pi-coding-agent/context/assembler";
import type {
	MemoryAssemblyBudget,
	MemoryContractV1,
	MemoryLocatorEntry,
	MemoryProvenance,
} from "@oh-my-pi/pi-coding-agent/context/memory-contract";
import { MEMORY_CONTRACT_VERSION } from "@oh-my-pi/pi-coding-agent/context/memory-contract";

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

const NOW = "2025-06-15T12:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

function makeProvenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
	return {
		source: "test",
		reason: "test-fixture",
		capturedAt: NOW,
		confidence: 0.9,
		...overrides,
	};
}

function makeLocator(overrides: Partial<MemoryLocatorEntry> & { key: string }): MemoryLocatorEntry {
	return {
		tier: "working",
		where: "src/main.ts",
		how: { method: "read" },
		cost: { estimatedTokens: 100, estimatedLatencyMs: 50 },
		freshness: { ttlMs: 3_600_000, invalidatedBy: [] },
		trust: "authoritative",
		provenance: makeProvenance(),
		...overrides,
	};
}

function makeScoringCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
	return {
		activePaths: [],
		activeSymbols: [],
		unresolvedLoops: [],
		now: NOW,
		...overrides,
	};
}

function makeContract(overrides: Partial<MemoryContractV1> = {}): MemoryContractV1 {
	return {
		version: MEMORY_CONTRACT_VERSION,
		locatorMap: [],
		longTerm: [],
		shortTerm: [],
		working: null,
		...overrides,
	};
}

function makeTurnInput(overrides: Partial<AssemblerTurnInput> = {}): AssemblerTurnInput {
	return {
		turnId: "turn-1",
		objective: "Fix the bug in auth module",
		activePaths: [],
		activeSymbols: [],
		unresolvedLoops: [],
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════════════════

describe("scoring", () => {
	test("file-path overlap: exact match scores 1.0", () => {
		const entry = makeLocator({ key: "main", where: "src/main.ts" });
		const ctx = makeScoringCtx({ activePaths: ["src/main.ts"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.fileOverlap).toBe(1.0);
	});

	test("file-path overlap: prefix match scores 0.5", () => {
		const entry = makeLocator({ key: "main", where: "src/main.ts" });
		const ctx = makeScoringCtx({ activePaths: ["src/"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.fileOverlap).toBe(0.5);
	});

	test("file-path overlap: no match scores 0", () => {
		const entry = makeLocator({ key: "main", where: "src/main.ts" });
		const ctx = makeScoringCtx({ activePaths: ["lib/other.ts"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.fileOverlap).toBe(0);
	});

	test("symbol overlap: exact match scores 1.0", () => {
		const entry = makeLocator({ key: "parseConfig" });
		const ctx = makeScoringCtx({ activeSymbols: ["parseConfig"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.symbolOverlap).toBe(1.0);
	});

	test("symbol overlap: substring containment scores 0.5", () => {
		const entry = makeLocator({ key: "parseConfigFromFile" });
		const ctx = makeScoringCtx({ activeSymbols: ["parseConfig"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.symbolOverlap).toBe(0.5);
	});

	test("symbol overlap: no match scores 0", () => {
		const entry = makeLocator({ key: "loadData" });
		const ctx = makeScoringCtx({ activeSymbols: ["parseConfig"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.symbolOverlap).toBe(0);
	});

	test("failure relevance: matching unresolved loop scores 1.0", () => {
		const entry = makeLocator({ key: "auth", where: "src/auth.ts" });
		const ctx = makeScoringCtx({ unresolvedLoops: ["src/auth.ts"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.failureRelevance).toBe(1.0);
	});

	test("failure relevance: no match scores 0", () => {
		const entry = makeLocator({ key: "auth", where: "src/auth.ts" });
		const ctx = makeScoringCtx({ unresolvedLoops: ["src/db.ts"] });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.failureRelevance).toBe(0);
	});

	test("recency: just captured scores 1.0", () => {
		const entry = makeLocator({ key: "recent", provenance: makeProvenance({ capturedAt: NOW }) });
		const ctx = makeScoringCtx({ now: NOW });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.recency).toBe(1.0);
	});

	test("recency: half-day old scores ~0.5", () => {
		const halfDayAgo = new Date(NOW_MS - 12 * 60 * 60 * 1000).toISOString();
		const entry = makeLocator({ key: "half-day", provenance: makeProvenance({ capturedAt: halfDayAgo }) });
		const ctx = makeScoringCtx({ now: NOW });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.recency).toBeCloseTo(0.5, 1);
	});

	test("recency: older than 24h scores 0", () => {
		const twoDaysAgo = new Date(NOW_MS - 2 * 24 * 60 * 60 * 1000).toISOString();
		const entry = makeLocator({ key: "old", provenance: makeProvenance({ capturedAt: twoDaysAgo }) });
		const ctx = makeScoringCtx({ now: NOW });
		const { breakdown } = scoreCandidate(entry, ctx);
		expect(breakdown.recency).toBe(0);
	});

	test("trust levels map to expected base scores", () => {
		for (const [trust, expected] of Object.entries(TRUST_BASE_SCORES)) {
			const entry = makeLocator({
				key: `trust-${trust}`,
				trust: trust as "authoritative" | "derived" | "heuristic",
			});
			const { breakdown } = scoreCandidate(entry, makeScoringCtx());
			expect(breakdown.trust).toBe(expected);
		}
	});

	test("tier levels map to expected base scores", () => {
		for (const [tier, expected] of Object.entries(TIER_BASE_SCORES)) {
			const entry = makeLocator({
				key: `tier-${tier}`,
				tier: tier as "working" | "short_term" | "long_term",
			});
			const { breakdown } = scoreCandidate(entry, makeScoringCtx());
			expect(breakdown.tier).toBe(expected);
		}
	});

	test("score is weighted sum of signals", () => {
		const entry = makeLocator({
			key: "parseConfig",
			where: "src/config.ts",
			tier: "working",
			trust: "authoritative",
			provenance: makeProvenance({ capturedAt: NOW }),
		});
		const ctx = makeScoringCtx({
			activePaths: ["src/config.ts"],
			activeSymbols: ["parseConfig"],
			unresolvedLoops: [],
			now: NOW,
		});
		const { score, breakdown } = scoreCandidate(entry, ctx);

		const expected =
			breakdown.fileOverlap * DEFAULT_SCORING_WEIGHTS.fileOverlap +
			breakdown.symbolOverlap * DEFAULT_SCORING_WEIGHTS.symbolOverlap +
			breakdown.failureRelevance * DEFAULT_SCORING_WEIGHTS.failureRelevance +
			breakdown.recency * DEFAULT_SCORING_WEIGHTS.recency +
			breakdown.trust * DEFAULT_SCORING_WEIGHTS.trust +
			breakdown.tier * DEFAULT_SCORING_WEIGHTS.tier;

		expect(score).toBeCloseTo(expected, 10);
	});

	test("custom weights override defaults", () => {
		const entry = makeLocator({ key: "x", tier: "working", trust: "authoritative" });
		const ctx = makeScoringCtx({ now: NOW });

		const defaultResult = scoreCandidate(entry, ctx);
		const customResult = scoreCandidate(entry, ctx, { ...DEFAULT_SCORING_WEIGHTS, tier: 1.0 });

		// Custom weight on tier=1.0 should produce a higher score (tier base score = 1.0)
		expect(customResult.score).toBeGreaterThan(defaultResult.score);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Ranking
// ═══════════════════════════════════════════════════════════════════════════

describe("ranking", () => {
	test("sorts candidates by score descending", () => {
		const entries = [
			makeLocator({ key: "low", tier: "long_term", trust: "heuristic" }),
			makeLocator({ key: "high", tier: "working", trust: "authoritative", where: "src/main.ts" }),
		];
		const ctx = makeScoringCtx({ activePaths: ["src/main.ts"], now: NOW });
		const ranked = rankCandidates(entries, ctx);

		expect(ranked[0].locator.key).toBe("high");
		expect(ranked[1].locator.key).toBe("low");
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
	});

	test("ties broken by key lexicographically", () => {
		// Two entries with identical signals
		const entries = [makeLocator({ key: "beta" }), makeLocator({ key: "alpha" })];
		const ctx = makeScoringCtx({ now: NOW });
		const ranked = rankCandidates(entries, ctx);

		expect(ranked[0].score).toBe(ranked[1].score);
		expect(ranked[0].locator.key).toBe("alpha");
		expect(ranked[1].locator.key).toBe("beta");
	});

	test("empty locator map returns empty array", () => {
		const ranked = rankCandidates([], makeScoringCtx());
		expect(ranked).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Freshness
// ═══════════════════════════════════════════════════════════════════════════

describe("freshness", () => {
	test("entry within TTL is fresh", () => {
		const entry = makeLocator({
			key: "fresh",
			freshness: { ttlMs: 3_600_000, invalidatedBy: [] },
			provenance: makeProvenance({ capturedAt: NOW }),
		});
		expect(isFresh(entry, NOW_MS)).toBe(true);
	});

	test("entry past TTL is stale", () => {
		const twoHoursAgo = new Date(NOW_MS - 2 * 3_600_000).toISOString();
		const entry = makeLocator({
			key: "stale",
			freshness: { ttlMs: 3_600_000, invalidatedBy: [] },
			provenance: makeProvenance({ capturedAt: twoHoursAgo }),
		});
		expect(isFresh(entry, NOW_MS)).toBe(false);
	});

	test("entry invalidated by tag is not fresh", () => {
		const entry = makeLocator({
			key: "invalidated",
			freshness: { ttlMs: 3_600_000, invalidatedBy: ["src/config.ts"] },
			provenance: makeProvenance({ capturedAt: NOW }),
		});
		const tags = new Set(["src/config.ts"]);
		expect(isFresh(entry, NOW_MS, tags)).toBe(false);
	});

	test("entry with invalid capturedAt is not fresh", () => {
		const entry = makeLocator({
			key: "bad-date",
			provenance: makeProvenance({ capturedAt: "not-a-date" }),
		});
		expect(isFresh(entry, NOW_MS)).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Budget drops
// ═══════════════════════════════════════════════════════════════════════════

describe("budget drops", () => {
	test("candidates exceeding token budget are dropped", async () => {
		// Retriever returns content that exceeds the budget
		const retriever: LocatorRetriever = async () => "x".repeat(2000); // 500 tokens
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "big", cost: { estimatedTokens: 500, estimatedLatencyMs: 10 } }),
				score: 0.8,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
		];

		const budget = createBudgetTracker(10, 10_000); // Only 10 tokens available — too small to truncate
		const { fragments, drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
		});

		expect(fragments).toHaveLength(0);
		expect(drops).toHaveLength(1);
		expect(drops[0].reason).toBe("token_budget");
	});

	test("candidates exceeding latency budget are dropped", async () => {
		// Retriever that takes longer than the latency budget
		const retriever: LocatorRetriever = async () => {
			await Bun.sleep(200);
			return "content";
		};
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "slow", cost: { estimatedTokens: 10, estimatedLatencyMs: 10 } }),
				score: 0.9,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
			{
				locator: makeLocator({
					key: "after-slow",
					where: "src/after.ts",
					cost: { estimatedTokens: 10, estimatedLatencyMs: 10 },
				}),
				score: 0.8,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
		];

		// Latency budget of 50ms — first batch takes 200ms, second batch is dropped
		const budget = createBudgetTracker(10_000, 50);
		const { drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			concurrency: 1, // Serial to control timing
		});

		// First entry may or may not succeed depending on timing,
		// but at least one should be dropped as latency_budget
		const latencyDrops = drops.filter(d => d.reason === "latency_budget");
		expect(latencyDrops.length).toBeGreaterThan(0);
	});

	test("budget is consumed incrementally across candidates", async () => {
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "first", cost: { estimatedTokens: 60, estimatedLatencyMs: 10 } }),
				score: 0.9,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
			{
				locator: makeLocator({ key: "second", cost: { estimatedTokens: 60, estimatedLatencyMs: 10 } }),
				score: 0.8,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
		];

		// Retriever returns short content to keep actual tokens low
		const retriever: LocatorRetriever = async () => "short";
		const budget = createBudgetTracker(200, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
		});

		// Both should fit (short = ~2 tokens each, budget = 200)
		expect(fragments).toHaveLength(2);
		expect(drops).toHaveLength(0);
		expect(budget.consumedTokens).toBeGreaterThan(0);
	});

	test("low-score candidates are dropped", async () => {
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "low-scorer" }),
				score: 0.01,
				breakdown: { fileOverlap: 0, symbolOverlap: 0, failureRelevance: 0, recency: 0, trust: 0, tier: 0 },
			},
		];

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever: stubRetriever,
			nowMs: NOW_MS,
			minScore: DEFAULT_MIN_SCORE,
		});

		expect(fragments).toHaveLength(0);
		expect(drops).toHaveLength(1);
		expect(drops[0].reason).toBe("low_score");
	});

	test("stale candidates are dropped during hydration", async () => {
		const twoHoursAgo = new Date(NOW_MS - 2 * 3_600_000).toISOString();
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({
					key: "stale-entry",
					freshness: { ttlMs: 3_600_000, invalidatedBy: [] },
					provenance: makeProvenance({ capturedAt: twoHoursAgo }),
				}),
				score: 0.8,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 0, trust: 1, tier: 1 },
			},
		];

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever: stubRetriever,
			nowMs: NOW_MS,
			minScore: 0,
		});

		expect(fragments).toHaveLength(0);
		expect(drops).toHaveLength(1);
		expect(drops[0].reason).toBe("stale");
	});

	test("invalidated candidates are dropped during hydration", async () => {
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({
					key: "invalidated-entry",
					freshness: { ttlMs: 3_600_000, invalidatedBy: ["src/config.ts"] },
				}),
				score: 0.8,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
		];

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever: stubRetriever,
			nowMs: NOW_MS,
			invalidationTags: new Set(["src/config.ts"]),
			minScore: 0,
		});

		expect(fragments).toHaveLength(0);
		expect(drops).toHaveLength(1);
		expect(drops[0].reason).toBe("invalidated");
	});

	test("retriever returning null drops candidate as invalidated", async () => {
		const entries: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "missing" }),
				score: 0.8,
				breakdown: { fileOverlap: 1, symbolOverlap: 0, failureRelevance: 0, recency: 1, trust: 1, tier: 1 },
			},
		];

		const retriever: LocatorRetriever = async () => null;
		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates: entries,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
		});

		expect(fragments).toHaveLength(0);
		expect(drops).toHaveLength(1);
		expect(drops[0].reason).toBe("invalidated");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Token estimation
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateTokens", () => {
	test("estimates tokens as ceil(length / 4)", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a")).toBe(1);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
		expect(estimateTokens("a".repeat(100))).toBe(25);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Stub retriever
// ═══════════════════════════════════════════════════════════════════════════

describe("stubRetriever", () => {
	test("returns synthetic content describing the entry", async () => {
		const entry = makeLocator({ key: "parseConfig", where: "src/config.ts", how: { method: "read" } });
		const content = await stubRetriever(entry);
		expect(content).toBe("[read] src/config.ts :: parseConfig");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end kernel assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemble", () => {
	test("produces valid WorkingContextPacketV1 shape", async () => {
		const contract = makeContract({
			locatorMap: [
				makeLocator({ key: "auth-handler", where: "src/auth.ts", tier: "working" }),
				makeLocator({ key: "db-pool", where: "src/db.ts", tier: "short_term" }),
			],
		});

		const turn = makeTurnInput({
			objective: "Fix auth bug",
			activePaths: ["src/auth.ts"],
			activeSymbols: ["auth-handler"],
		});

		const packet = await assemble(contract, turn, { now: NOW });

		// Shape validation
		expect(packet.version).toBe(MEMORY_CONTRACT_VERSION);
		expect(typeof packet.objective).toBe("string");
		expect(packet.objective).toBe("Fix auth bug");
		expect(typeof packet.generatedAt).toBe("string");
		expect(packet.budget).toBeDefined();
		expect(packet.budget.maxTokens).toBeGreaterThan(0);
		expect(packet.budget.reservedTokens).toBeDefined();
		expect(packet.usage).toBeDefined();
		expect(typeof packet.usage.consumedTokens).toBe("number");
		expect(typeof packet.usage.consumedLatencyMs).toBe("number");
		expect(Array.isArray(packet.fragments)).toBe(true);
		expect(Array.isArray(packet.dropped)).toBe(true);
	});

	test("fragments are ordered by score descending", async () => {
		const contract = makeContract({
			locatorMap: [
				makeLocator({ key: "low", where: "src/other.ts", tier: "long_term", trust: "heuristic" }),
				makeLocator({ key: "high", where: "src/auth.ts", tier: "working", trust: "authoritative" }),
			],
		});

		const turn = makeTurnInput({
			activePaths: ["src/auth.ts"],
			activeSymbols: ["high"],
		});

		const packet = await assemble(contract, turn, { now: NOW });

		expect(packet.fragments.length).toBeGreaterThan(0);
		for (let i = 1; i < packet.fragments.length; i++) {
			expect(packet.fragments[i - 1].score).toBeGreaterThanOrEqual(packet.fragments[i].score);
		}
	});

	test("respects custom retriever", async () => {
		const customContent = "custom hydrated content";
		const retriever: LocatorRetriever = async () => customContent;

		const contract = makeContract({
			locatorMap: [makeLocator({ key: "test-entry" })],
		});

		const packet = await assemble(contract, makeTurnInput(), { retriever, now: NOW });

		expect(packet.fragments).toHaveLength(1);
		expect(packet.fragments[0].content).toBe(customContent);
	});

	test("uses working memory budget when available", async () => {
		const customBudget: MemoryAssemblyBudget = {
			maxTokens: 8192,
			maxLatencyMs: 5000,
			reservedTokens: { objective: 512, codeContext: 4096, executionState: 1024 },
		};

		const contract = makeContract({
			locatorMap: [makeLocator({ key: "entry" })],
			working: {
				turnId: "prev-turn",
				subgoal: "test",
				hypotheses: [],
				nextActions: [],
				activePaths: [],
				activeSymbols: [],
				unresolvedLoops: [],
				locatorKeys: [],
				budget: customBudget,
				updatedAt: NOW,
			},
		});

		const packet = await assemble(contract, makeTurnInput(), { now: NOW });
		expect(packet.budget).toEqual(customBudget);
	});

	test("empty contract produces packet with no fragments", async () => {
		const contract = makeContract();
		const packet = await assemble(contract, makeTurnInput(), { now: NOW });

		expect(packet.version).toBe(MEMORY_CONTRACT_VERSION);
		expect(packet.fragments).toHaveLength(0);
		expect(packet.dropped).toHaveLength(0);
		expect(packet.usage.consumedTokens).toBe(0);
		expect(packet.usage.consumedLatencyMs).toBe(0);
	});

	test("merges turn input paths with working memory paths for scoring", async () => {
		const contract = makeContract({
			locatorMap: [
				makeLocator({ key: "from-turn", where: "src/turn.ts" }),
				makeLocator({ key: "from-wm", where: "src/working.ts" }),
				makeLocator({ key: "unrelated", where: "src/other.ts" }),
			],
			working: {
				turnId: "prev",
				subgoal: "test",
				hypotheses: [],
				nextActions: [],
				activePaths: ["src/working.ts"],
				activeSymbols: [],
				unresolvedLoops: [],
				locatorKeys: [],
				budget: {
					maxTokens: 10_000,
					maxLatencyMs: 10_000,
					reservedTokens: { objective: 100, codeContext: 100, executionState: 100 },
				},
				updatedAt: NOW,
			},
		});

		const turn = makeTurnInput({ activePaths: ["src/turn.ts"] });
		const packet = await assemble(contract, turn, { now: NOW });

		// Both turn and working-memory paths should boost their respective entries
		const turnFragment = packet.fragments.find(f => f.id === "from-turn");
		const wmFragment = packet.fragments.find(f => f.id === "from-wm");
		const unrelatedFragment = packet.fragments.find(f => f.id === "unrelated");

		expect(turnFragment).toBeDefined();
		expect(wmFragment).toBeDefined();
		// Turn and WM entries should score higher than unrelated
		if (turnFragment && unrelatedFragment) {
			expect(turnFragment.score).toBeGreaterThan(unrelatedFragment.score);
		}
		if (wmFragment && unrelatedFragment) {
			expect(wmFragment.score).toBeGreaterThan(unrelatedFragment.score);
		}
	});

	test("drops record correct reasons", async () => {
		const twoHoursAgo = new Date(NOW_MS - 2 * 3_600_000).toISOString();

		const contract = makeContract({
			locatorMap: [
				// This will be stale (TTL = 1h, captured 2h ago)
				makeLocator({
					key: "stale-one",
					freshness: { ttlMs: 3_600_000, invalidatedBy: [] },
					provenance: makeProvenance({ capturedAt: twoHoursAgo }),
				}),
				// This should succeed
				makeLocator({
					key: "fresh-one",
					freshness: { ttlMs: 3_600_000, invalidatedBy: [] },
					provenance: makeProvenance({ capturedAt: NOW }),
				}),
			],
		});

		const packet = await assemble(contract, makeTurnInput(), { now: NOW });

		const staleDrop = packet.dropped.find(d => d.id === "stale-one");
		expect(staleDrop).toBeDefined();
		expect(staleDrop!.reason).toBe("stale");

		const freshFragment = packet.fragments.find(f => f.id === "fresh-one");
		expect(freshFragment).toBeDefined();
	});

	test("respects minScore config", async () => {
		const contract = makeContract({
			locatorMap: [
				// Long-term, heuristic, no overlap — will have very low score
				makeLocator({ key: "weak", where: "src/unrelated.ts", tier: "long_term", trust: "heuristic" }),
			],
		});

		// With a high minScore, the weak entry should be dropped
		const packet = await assemble(contract, makeTurnInput(), { minScore: 0.9, now: NOW });

		expect(packet.fragments).toHaveLength(0);
		expect(packet.dropped).toHaveLength(1);
		expect(packet.dropped[0].reason).toBe("low_score");
	});

	test("respects maxCandidates config", async () => {
		const locators = Array.from({ length: 10 }, (_, i) =>
			makeLocator({ key: `entry-${i}`, cost: { estimatedTokens: 5, estimatedLatencyMs: 1 } }),
		);

		const contract = makeContract({ locatorMap: locators });
		const packet = await assemble(contract, makeTurnInput(), { maxCandidates: 3, now: NOW });

		// At most 3 candidates should be hydrated (rest not even attempted)
		expect(packet.fragments.length).toBeLessThanOrEqual(3);
	});

	test("fragment provenance matches locator provenance", async () => {
		const prov = makeProvenance({ source: "lsp", reason: "definition-lookup", confidence: 0.95 });
		const contract = makeContract({
			locatorMap: [makeLocator({ key: "tracked", provenance: prov })],
		});

		const packet = await assemble(contract, makeTurnInput(), { now: NOW });
		expect(packet.fragments).toHaveLength(1);
		expect(packet.fragments[0].provenance).toEqual(prov);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Budget derivation
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveBudget", () => {
	test("derives available tokens from context window minus costs", () => {
		const budget = deriveBudget({
			contextWindow: 200_000,
			systemPromptTokens: 10_000,
			toolDefinitionTokens: 15_000,
			currentTurnTokens: 5_000,
		});

		// available = (200000 - 10000 - 15000 - 5000) * 0.9 = 153_000
		expect(budget.maxTokens).toBe(153_000);
	});

	test("reserved tokens are all zero", () => {
		const budget = deriveBudget({
			contextWindow: 200_000,
			systemPromptTokens: 10_000,
			toolDefinitionTokens: 15_000,
			currentTurnTokens: 5_000,
		});

		expect(budget.reservedTokens.objective).toBe(0);
		expect(budget.reservedTokens.codeContext).toBe(0);
		expect(budget.reservedTokens.executionState).toBe(0);
	});

	test("floors at zero when costs exceed context window", () => {
		const budget = deriveBudget({
			contextWindow: 10_000,
			systemPromptTokens: 5_000,
			toolDefinitionTokens: 5_000,
			currentTurnTokens: 5_000,
		});

		expect(budget.maxTokens).toBe(0);
	});

	test("applies 10% safety margin", () => {
		const budget = deriveBudget({
			contextWindow: 100_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
		});

		// 100000 * 0.9 = 90000
		expect(budget.maxTokens).toBe(90_000);
	});

	test("small context window (8K) with typical costs", () => {
		const budget = deriveBudget({
			contextWindow: 8_192,
			systemPromptTokens: 3_000,
			toolDefinitionTokens: 4_000,
			currentTurnTokens: 500,
		});

		// (8192 - 3000 - 4000 - 500) * 0.9 = 622.8 -> floor = 622
		expect(budget.maxTokens).toBe(622);
	});

	test("sets maxLatencyMs to default (2000)", () => {
		const budget = deriveBudget({
			contextWindow: 200_000,
			systemPromptTokens: 0,
			toolDefinitionTokens: 0,
			currentTurnTokens: 0,
		});

		expect(budget.maxLatencyMs).toBe(2000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool definition token estimation
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateToolDefinitionTokens", () => {
	test("estimates from name + description + parameters", () => {
		const tools = [
			{
				name: "read",
				description: "Read a file from disk",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		];
		const tokens = estimateToolDefinitionTokens(tools);
		expect(tokens).toBeGreaterThan(0);

		// Manual: "read" (4) + "Read a file from disk" (20) + JSON.stringify(params)
		const paramsJson = JSON.stringify({ type: "object", properties: { path: { type: "string" } } });
		const expectedChars = 4 + 20 + paramsJson.length;
		expect(tokens).toBe(Math.ceil(expectedChars / 4));
	});

	test("handles tools without description", () => {
		const tools = [{ name: "noop" }];
		const tokens = estimateToolDefinitionTokens(tools);
		// Only name chars: "noop" = 4 chars -> 1 token
		expect(tokens).toBe(1);
	});

	test("sums across multiple tools", () => {
		const tools = [
			{ name: "read", description: "Read a file" },
			{ name: "write", description: "Write a file" },
		];
		const single1 = estimateToolDefinitionTokens([tools[0]]);
		const single2 = estimateToolDefinitionTokens([tools[1]]);
		const combined = estimateToolDefinitionTokens(tools);

		// Due to ceil rounding, combined may differ slightly from sum of individuals
		// but should be within 1 token
		expect(Math.abs(combined - (single1 + single2))).toBeLessThanOrEqual(1);
	});

	test("empty tools array returns 0", () => {
		expect(estimateToolDefinitionTokens([])).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Message token estimation
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateMessageTokens", () => {
	test("estimates string content", () => {
		const messages = [{ content: "Hello world" }]; // 11 chars -> 3 tokens
		expect(estimateMessageTokens(messages)).toBe(3);
	});

	test("estimates array content with text blocks", () => {
		const messages = [
			{
				content: [
					{ type: "text", text: "Hello" },
					{ type: "text", text: "World" },
				],
			},
		];
		// 5 + 5 = 10 chars -> 3 tokens (ceil(10/4))
		expect(estimateMessageTokens(messages)).toBe(3);
	});

	test("handles mixed content types", () => {
		const messages = [{ content: "simple string" }, { content: [{ type: "text", text: "in array" }] }];
		// 13 + 8 = 21 chars -> 6 tokens
		expect(estimateMessageTokens(messages)).toBe(6);
	});

	test("handles null/undefined content", () => {
		const messages = [{ content: null }, { content: undefined }];
		expect(estimateMessageTokens(messages)).toBe(0);
	});

	test("empty messages returns 0", () => {
		expect(estimateMessageTokens([])).toBe(0);
	});

	test("non-text blocks are JSON-stringified", () => {
		const block = { type: "image", data: "base64..." };
		const messages = [{ content: [block] }];
		const expectedChars = JSON.stringify(block).length;
		expect(estimateMessageTokens(messages)).toBe(Math.ceil(expectedChars / 4));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// estimateTokensFromCharCount
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateTokensFromCharCount", () => {
	test("consistent with estimateTokens", () => {
		const text = "Hello world, this is a test string.";
		expect(estimateTokensFromCharCount(text.length)).toBe(estimateTokens(text));
	});

	test("zero chars returns 0", () => {
		expect(estimateTokensFromCharCount(0)).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// assemble() budget priority
// ═══════════════════════════════════════════════════════════════════════════

describe("assemble budget priority", () => {
	test("config.budget overrides working memory budget", async () => {
		const configBudget: MemoryAssemblyBudget = {
			maxTokens: 50_000,
			maxLatencyMs: 3000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};
		const wmBudget: MemoryAssemblyBudget = {
			maxTokens: 8_000,
			maxLatencyMs: 2000,
			reservedTokens: { objective: 100, codeContext: 100, executionState: 100 },
		};

		const contract = makeContract({
			working: {
				turnId: "prev",
				subgoal: "test",
				hypotheses: [],
				nextActions: [],
				activePaths: [],
				activeSymbols: [],
				unresolvedLoops: [],
				locatorKeys: [],
				budget: wmBudget,
				updatedAt: NOW,
			},
		});

		const packet = await assemble(contract, makeTurnInput(), {
			now: NOW,
			budget: configBudget,
		});
		expect(packet.budget).toEqual(configBudget);
	});

	test("falls back to DEFAULT_BUDGET when no config or WM budget", async () => {
		const contract = makeContract(); // working: null
		const packet = await assemble(contract, makeTurnInput(), { now: NOW });

		// DEFAULT_BUDGET has zero reserves and maxTokens of 40_000
		expect(packet.budget.maxTokens).toBe(40_000);
		expect(packet.budget.reservedTokens.objective).toBe(0);
		expect(packet.budget.reservedTokens.codeContext).toBe(0);
		expect(packet.budget.reservedTokens.executionState).toBe(0);
	});

	test("derived budget is used for hydration token limit", async () => {
		// Retriever returns content that exceeds the tight budget
		const retriever: LocatorRetriever = async () => "x".repeat(2000); // 500 tokens
		const contract = makeContract({
			locatorMap: [makeLocator({ key: "big", cost: { estimatedTokens: 500, estimatedLatencyMs: 10 } })],
		});

		// Budget with only 10 tokens — too small to even truncate meaningfully
		const tightBudget: MemoryAssemblyBudget = {
			maxTokens: 10,
			maxLatencyMs: 10_000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};

		const packet = await assemble(contract, makeTurnInput(), {
			now: NOW,
			budget: tightBudget,
			retriever,
		});
		expect(packet.dropped).toHaveLength(1);
		expect(packet.dropped[0].reason).toBe("token_budget");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Working memory integration
// ═══════════════════════════════════════════════════════════════════════════

describe("working memory integration", () => {
	test("WM budget is used when no config.budget provided", async () => {
		const wmBudget: MemoryAssemblyBudget = {
			maxTokens: 12_000,
			maxLatencyMs: 1500,
			reservedTokens: { objective: 200, codeContext: 500, executionState: 100 },
		};

		const contract = makeContract({
			locatorMap: [makeLocator({ key: "entry" })],
			working: {
				turnId: "turn-1",
				subgoal: "test",
				hypotheses: [],
				nextActions: [],
				activePaths: [],
				activeSymbols: [],
				unresolvedLoops: [],
				locatorKeys: [],
				budget: wmBudget,
				updatedAt: NOW,
			},
		});

		// No config.budget — should fall back to WM budget
		const packet = await assemble(contract, makeTurnInput(), { now: NOW });
		expect(packet.budget).toEqual(wmBudget);
	});

	test("DEFAULT_BUDGET is exported and matches expected shape", () => {
		expect(DEFAULT_BUDGET.maxTokens).toBe(40_000);
		expect(DEFAULT_BUDGET.reservedTokens.objective).toBe(0);
		expect(DEFAULT_BUDGET.reservedTokens.codeContext).toBe(0);
		expect(DEFAULT_BUDGET.reservedTokens.executionState).toBe(0);
	});

	test("WM active paths boost scoring for matching locators", async () => {
		const contract = makeContract({
			locatorMap: [
				makeLocator({ key: "wm-match", where: "src/wm-tracked.ts" }),
				makeLocator({ key: "no-match", where: "src/unrelated.ts" }),
			],
			working: {
				turnId: "turn-1",
				subgoal: "test",
				hypotheses: [],
				nextActions: [],
				activePaths: ["src/wm-tracked.ts"],
				activeSymbols: [],
				unresolvedLoops: [],
				locatorKeys: [],
				budget: DEFAULT_BUDGET,
				updatedAt: NOW,
			},
		});

		// Turn input has no active paths — only WM contributes the path signal
		const turn = makeTurnInput({ activePaths: [] });
		const packet = await assemble(contract, turn, { now: NOW });

		const wmMatch = packet.fragments.find(f => f.id === "wm-match");
		const noMatch = packet.fragments.find(f => f.id === "no-match");
		expect(wmMatch).toBeDefined();
		expect(noMatch).toBeDefined();
		expect(wmMatch!.score).toBeGreaterThan(noMatch!.score);
	});
});
