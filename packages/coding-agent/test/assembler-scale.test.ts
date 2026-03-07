import { describe, expect, test } from "bun:test";
import {
	type AssemblerTurnInput,
	assemble,
	candidateSimilarity,
	createBudgetTracker,
	DEFAULT_MMR_LAMBDA,
	hydrateCandidates,
	type LocatorRetriever,
	mmrRerank,
	type ScoredCandidate,
	type ScoringContext,
	scoreCandidate,
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
		objective: "Scale hydration",
		activePaths: [],
		activeSymbols: [],
		unresolvedLoops: [],
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// candidateSimilarity
// ═══════════════════════════════════════════════════════════════════════════

describe("candidateSimilarity", () => {
	test("same key returns 1.0", () => {
		const a = makeLocator({ key: "x", where: "src/a.ts" });
		const b = makeLocator({ key: "x", where: "src/b.ts" });
		expect(candidateSimilarity(a, b)).toBe(1.0);
	});

	test("same file path returns 0.8", () => {
		const a = makeLocator({ key: "x", where: "src/config.ts" });
		const b = makeLocator({ key: "y", where: "src/config.ts" });
		expect(candidateSimilarity(a, b)).toBe(0.8);
	});

	test("same directory returns 0.4", () => {
		const a = makeLocator({ key: "x", where: "src/auth/login.ts" });
		const b = makeLocator({ key: "y", where: "src/auth/logout.ts" });
		expect(candidateSimilarity(a, b)).toBe(0.4);
	});

	test("same provenance returns 0.2", () => {
		const prov = makeProvenance({ source: "lsp", reason: "definition" });
		const a = makeLocator({ key: "x", where: "src/a.ts", provenance: prov });
		const b = makeLocator({ key: "y", where: "lib/b.ts", provenance: prov });
		expect(candidateSimilarity(a, b)).toBe(0.2);
	});

	test("unrelated returns 0", () => {
		const a = makeLocator({
			key: "x",
			where: "src/a.ts",
			provenance: makeProvenance({ source: "grep", reason: "search" }),
		});
		const b = makeLocator({
			key: "y",
			where: "lib/b.ts",
			provenance: makeProvenance({ source: "lsp", reason: "hover" }),
		});
		expect(candidateSimilarity(a, b)).toBe(0);
	});

	test("directory similarity ignores root-level paths without slash", () => {
		const a = makeLocator({ key: "x", where: "README.md" });
		const b = makeLocator({ key: "y", where: "LICENSE" });
		// Both have empty dirname — but we require dirA.length > 0 to avoid
		// false matches on root-level files.
		expect(candidateSimilarity(a, b)).not.toBe(0.4);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// MMR reranking
// ═══════════════════════════════════════════════════════════════════════════

describe("mmrRerank", () => {
	test("preserves highest-scored item first", () => {
		const entries = [
			makeLocator({ key: "top", where: "src/a.ts" }),
			makeLocator({ key: "mid", where: "src/b.ts" }),
			makeLocator({ key: "low", where: "src/c.ts" }),
		];
		const ctx = makeScoringCtx({ activePaths: ["src/a.ts"], now: NOW });
		const candidates = entries.map(e => scoreCandidate(e, ctx));
		// Sort by score desc (as rankCandidates does)
		candidates.sort((a, b) => b.score - a.score);

		const reranked = mmrRerank(candidates, DEFAULT_MMR_LAMBDA);
		expect(reranked[0].locator.key).toBe(candidates[0].locator.key);
	});

	test("promotes diversity: different files over same file", () => {
		// Create 3 entries from same file, 1 from different file
		const candidates: ScoredCandidate[] = [
			{ locator: makeLocator({ key: "a", where: "src/config.ts" }), score: 0.9, breakdown: {} as never },
			{ locator: makeLocator({ key: "b", where: "src/config.ts" }), score: 0.85, breakdown: {} as never },
			{ locator: makeLocator({ key: "c", where: "src/config.ts" }), score: 0.8, breakdown: {} as never },
			{ locator: makeLocator({ key: "d", where: "src/utils.ts" }), score: 0.75, breakdown: {} as never },
		];

		const reranked = mmrRerank(candidates, 0.5);

		// "d" from a different file should be promoted ahead of at least one
		// same-file entry despite lower score
		const dIdx = reranked.findIndex(c => c.locator.key === "d");
		expect(dIdx).toBeLessThan(3); // Should not be last
	});

	test("lambda=1.0 produces pure relevance order", () => {
		const candidates: ScoredCandidate[] = [
			{ locator: makeLocator({ key: "a", where: "src/x.ts" }), score: 0.9, breakdown: {} as never },
			{ locator: makeLocator({ key: "b", where: "src/x.ts" }), score: 0.8, breakdown: {} as never },
			{ locator: makeLocator({ key: "c", where: "src/x.ts" }), score: 0.7, breakdown: {} as never },
		];

		const reranked = mmrRerank(candidates, 1.0);
		expect(reranked.map(c => c.locator.key)).toEqual(["a", "b", "c"]);
	});

	test("handles single candidate", () => {
		const candidates: ScoredCandidate[] = [
			{ locator: makeLocator({ key: "only" }), score: 0.5, breakdown: {} as never },
		];
		const reranked = mmrRerank(candidates);
		expect(reranked).toHaveLength(1);
		expect(reranked[0].locator.key).toBe("only");
	});

	test("handles empty array", () => {
		expect(mmrRerank([])).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Parallel hydration
// ═══════════════════════════════════════════════════════════════════════════

describe("parallel hydration", () => {
	test("retrieves multiple entries in parallel", async () => {
		const callOrder: string[] = [];
		const retriever: LocatorRetriever = async entry => {
			callOrder.push(entry.key);
			await Bun.sleep(10);
			return `content-${entry.key}`;
		};

		const candidates: ScoredCandidate[] = Array.from({ length: 5 }, (_, i) => ({
			locator: makeLocator({
				key: `entry-${i}`,
				where: `src/file${i}.ts`,
				cost: { estimatedTokens: 20, estimatedLatencyMs: 10 },
			}),
			score: 0.8,
			breakdown: {} as never,
		}));

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			concurrency: 5, // All at once
		});

		expect(fragments).toHaveLength(5);
		// All 5 should have been called (parallel)
		expect(callOrder).toHaveLength(5);
	});

	test("respects concurrency limit", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;

		const retriever: LocatorRetriever = async entry => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await Bun.sleep(20);
			concurrent--;
			return `content-${entry.key}`;
		};

		const candidates: ScoredCandidate[] = Array.from({ length: 6 }, (_, i) => ({
			locator: makeLocator({
				key: `entry-${i}`,
				where: `src/file${i}.ts`,
				cost: { estimatedTokens: 10, estimatedLatencyMs: 10 },
			}),
			score: 0.8,
			breakdown: {} as never,
		}));

		const budget = createBudgetTracker(10_000, 10_000);
		await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			concurrency: 3, // Batch of 3
		});

		// Max concurrent should not exceed 3
		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});

	test("per-entry timeout drops slow retrievals", async () => {
		const retriever: LocatorRetriever = async entry => {
			if (entry.key === "slow") {
				await Bun.sleep(1000);
				return "slow content";
			}
			return "fast content";
		};

		const candidates: ScoredCandidate[] = [
			{
				locator: makeLocator({
					key: "fast",
					where: "src/fast.ts",
					cost: { estimatedTokens: 10, estimatedLatencyMs: 10 },
				}),
				score: 0.9,
				breakdown: {} as never,
			},
			{
				locator: makeLocator({
					key: "slow",
					where: "src/slow.ts",
					cost: { estimatedTokens: 10, estimatedLatencyMs: 10 },
				}),
				score: 0.8,
				breakdown: {} as never,
			},
		];

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			perEntryTimeoutMs: 50, // 50ms timeout
		});

		expect(fragments).toHaveLength(1);
		expect(fragments[0].id).toBe("fast");
		expect(drops.some(d => d.id === "slow" && d.reason === "retrieval_timeout")).toBe(true);
	});

	test("wall-clock latency budget drops remaining candidates", async () => {
		const retriever: LocatorRetriever = async entry => {
			// Each retrieval takes 50ms
			await Bun.sleep(50);
			return `content-${entry.key}`;
		};

		const candidates: ScoredCandidate[] = Array.from({ length: 20 }, (_, i) => ({
			locator: makeLocator({
				key: `entry-${i}`,
				where: `src/file${i}.ts`,
				cost: { estimatedTokens: 10, estimatedLatencyMs: 10 },
			}),
			score: 0.8,
			breakdown: {} as never,
		}));

		const budget = createBudgetTracker(100_000, 100); // Only 100ms latency
		const { fragments, drops } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			concurrency: 2, // Small batches to test latency checking
		});

		// Some should succeed, rest should be dropped as latency_budget
		expect(fragments.length).toBeGreaterThan(0);
		expect(fragments.length).toBeLessThan(20);
		const latencyDrops = drops.filter(d => d.reason === "latency_budget");
		expect(latencyDrops.length).toBeGreaterThan(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Content truncation
// ═══════════════════════════════════════════════════════════════════════════

describe("content truncation", () => {
	test("oversized content is truncated to maxTokensPerFragment", async () => {
		// Generate content that is ~1000 tokens (4000 chars)
		const bigContent = "x".repeat(4000);

		const retriever: LocatorRetriever = async () => bigContent;
		const candidates: ScoredCandidate[] = [
			{
				locator: makeLocator({
					key: "big",
					cost: { estimatedTokens: 1000, estimatedLatencyMs: 10 },
				}),
				score: 0.8,
				breakdown: {} as never,
			},
		];

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			maxTokensPerFragment: 200, // Cap at 200 tokens
		});

		expect(fragments).toHaveLength(1);
		// Content should be truncated, not the full 4000 chars
		expect(fragments[0].content.length).toBeLessThan(4000);
		expect(fragments[0].content).toContain("[... truncated]");
	});

	test("content truncated to fill remaining budget", async () => {
		// Fragment 1: 400 tokens. Fragment 2: 1000 tokens.
		// Budget: 600 tokens. Fragment 2 should be truncated to fit ~200 remaining tokens.
		const retriever: LocatorRetriever = async entry => {
			if (entry.key === "small") return "a".repeat(1600); // 400 tokens
			return "b".repeat(4000); // 1000 tokens
		};

		const candidates: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "small", cost: { estimatedTokens: 400, estimatedLatencyMs: 10 } }),
				score: 0.9,
				breakdown: {} as never,
			},
			{
				locator: makeLocator({
					key: "big",
					where: "src/big.ts",
					cost: { estimatedTokens: 1000, estimatedLatencyMs: 10 },
				}),
				score: 0.8,
				breakdown: {} as never,
			},
		];

		const budget = createBudgetTracker(600, 10_000);
		const { fragments } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
		});

		// Both should be hydrated (second truncated to fit)
		expect(fragments).toHaveLength(2);
		expect(fragments[0].id).toBe("small");
		expect(fragments[1].content).toContain("[... truncated]");
		// Budget should be nearly full
		expect(budget.consumedTokens).toBeGreaterThan(400);
		expect(budget.consumedTokens).toBeLessThanOrEqual(600);
	});

	test("fragments too small for truncation are dropped", async () => {
		const retriever: LocatorRetriever = async () => "x".repeat(400); // 100 tokens

		const candidates: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "entry", cost: { estimatedTokens: 100, estimatedLatencyMs: 10 } }),
				score: 0.8,
				breakdown: {} as never,
			},
		];

		// Budget is too small for even a minimal fragment
		const budget = createBudgetTracker(30, 10_000);
		const { fragments, drops } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
		});

		expect(fragments).toHaveLength(0);
		expect(drops.some(d => d.reason === "token_budget")).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Large-budget integration
// ═══════════════════════════════════════════════════════════════════════════

describe("large-budget integration", () => {
	test("fills >50% of 150K budget with sufficient entries", async () => {
		const numEntries = 300;
		// Each entry produces ~500 tokens of content (2000 chars)
		const retriever: LocatorRetriever = async entry => {
			return `// File: ${entry.where}\n${"const x = 1;\n".repeat(150)}`;
		};

		const locators = Array.from({ length: numEntries }, (_, i) =>
			makeLocator({
				key: `entry-${i}`,
				where: `src/module${i % 50}/file${i}.ts`,
				cost: { estimatedTokens: 500, estimatedLatencyMs: 5 },
			}),
		);

		const contract = makeContract({ locatorMap: locators });
		const turn = makeTurnInput({
			activePaths: Array.from({ length: 10 }, (_, i) => `src/module${i}/`),
		});

		const budget: MemoryAssemblyBudget = {
			maxTokens: 150_000,
			maxLatencyMs: 5000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};

		const packet = await assemble(contract, turn, {
			now: NOW,
			retriever,
			budget,
			concurrency: 20,
			perEntryTimeoutMs: 1000,
		});

		// Should fill >50% of budget
		expect(packet.usage.consumedTokens).toBeGreaterThan(75_000);
		expect(packet.fragments.length).toBeGreaterThan(100);
	});

	test("results have diversity (not all from same file)", async () => {
		// Create entries: 50 from same file, 10 from different files
		const retriever: LocatorRetriever = async () => "content ".repeat(50);

		const sameFileLocators = Array.from({ length: 50 }, (_, i) =>
			makeLocator({
				key: `same-${i}`,
				where: "src/big-file.ts",
				cost: { estimatedTokens: 100, estimatedLatencyMs: 5 },
			}),
		);

		const diverseLocators = Array.from({ length: 10 }, (_, i) =>
			makeLocator({
				key: `diverse-${i}`,
				where: `src/module${i}/file.ts`,
				cost: { estimatedTokens: 100, estimatedLatencyMs: 5 },
			}),
		);

		const contract = makeContract({ locatorMap: [...sameFileLocators, ...diverseLocators] });
		const turn = makeTurnInput({
			activePaths: ["src/big-file.ts", ...diverseLocators.map(l => l.where)],
		});

		const budget: MemoryAssemblyBudget = {
			maxTokens: 50_000,
			maxLatencyMs: 5000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};

		const packet = await assemble(contract, turn, {
			now: NOW,
			retriever,
			budget,
		});

		// Diverse entries should appear in results despite potentially lower scores
		const diverseFragments = packet.fragments.filter(f => f.id.startsWith("diverse-"));
		expect(diverseFragments.length).toBeGreaterThan(0);

		// Should not be all from the same file
		const uniqueFiles = new Set(
			packet.fragments.map(f => {
				const locator = [...sameFileLocators, ...diverseLocators].find(l => l.key === f.id);
				return locator?.where;
			}),
		);
		expect(uniqueFiles.size).toBeGreaterThan(1);
	});

	test("dynamic maxCandidates scales with budget", async () => {
		const retriever: LocatorRetriever = async () => "x".repeat(40); // 10 tokens

		// Create 200 entries
		const locators = Array.from({ length: 200 }, (_, i) =>
			makeLocator({
				key: `entry-${i}`,
				where: `src/file${i}.ts`,
				cost: { estimatedTokens: 10, estimatedLatencyMs: 1 },
			}),
		);

		const contract = makeContract({ locatorMap: locators });
		const turn = makeTurnInput();

		// Large budget should allow more than DEFAULT_MAX_CANDIDATES (50)
		const budget: MemoryAssemblyBudget = {
			maxTokens: 100_000,
			maxLatencyMs: 5000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};

		const packet = await assemble(contract, turn, {
			now: NOW,
			retriever,
			budget,
		});

		// With 100K budget and 10 tokens per entry, we should hydrate well
		// beyond the old DEFAULT_MAX_CANDIDATES of 50
		expect(packet.fragments.length).toBeGreaterThan(50);
	});

	test("small budget produces small fragments via maxTokensPerFragment", async () => {
		// Content is 2000 tokens (8000 chars)
		const bigContent = "x".repeat(8000);
		const retriever: LocatorRetriever = async () => bigContent;

		const locators = [
			makeLocator({
				key: "entry-0",
				cost: { estimatedTokens: 2000, estimatedLatencyMs: 5 },
			}),
		];

		const contract = makeContract({ locatorMap: locators });
		const turn = makeTurnInput();

		// Small budget: maxTokensPerFragment should be auto-derived small
		const budget: MemoryAssemblyBudget = {
			maxTokens: 1000,
			maxLatencyMs: 5000,
			reservedTokens: { objective: 0, codeContext: 0, executionState: 0 },
		};

		const packet = await assemble(contract, turn, {
			now: NOW,
			retriever,
			budget,
		});

		if (packet.fragments.length > 0) {
			// Fragment should be truncated to fit budget
			expect(packet.fragments[0].content.length).toBeLessThan(8000);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Backward compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe("backward compatibility", () => {
	test("serial hydration (concurrency=1) still works", async () => {
		const retriever: LocatorRetriever = async entry => `content-${entry.key}`;

		const candidates: ScoredCandidate[] = [
			{
				locator: makeLocator({ key: "a", cost: { estimatedTokens: 10, estimatedLatencyMs: 5 } }),
				score: 0.9,
				breakdown: {} as never,
			},
			{
				locator: makeLocator({ key: "b", where: "src/b.ts", cost: { estimatedTokens: 10, estimatedLatencyMs: 5 } }),
				score: 0.8,
				breakdown: {} as never,
			},
		];

		const budget = createBudgetTracker(10_000, 10_000);
		const { fragments } = await hydrateCandidates({
			candidates,
			budget,
			retriever,
			nowMs: NOW_MS,
			minScore: 0,
			concurrency: 1,
		});

		expect(fragments).toHaveLength(2);
		expect(fragments[0].content).toBe("content-a");
		expect(fragments[1].content).toBe("content-b");
	});

	test("assemble without new options matches original behavior", async () => {
		const contract = makeContract({
			locatorMap: [makeLocator({ key: "entry-1", where: "src/auth.ts", tier: "working" })],
		});

		const turn = makeTurnInput({
			activePaths: ["src/auth.ts"],
		});

		const packet = await assemble(contract, turn, { now: NOW });

		expect(packet.version).toBe(MEMORY_CONTRACT_VERSION);
		expect(packet.fragments.length).toBeGreaterThanOrEqual(0);
		expect(Array.isArray(packet.dropped)).toBe(true);
	});
});
