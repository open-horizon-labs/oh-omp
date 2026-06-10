#!/usr/bin/env bun
/**
 * Counterfactual simulator for the working-set retention policy
 * (harness-ergonomics Track A remediation, parameter sweep).
 *
 * For each candidate config, replays the corpus and asks: had the assembler
 * pinned actively-used files (kept the latest read verbatim past the hot
 * window), how many illusion-break re-fetches would have been avoided, and
 * what retention overhead would have been paid?
 *
 * Cost model (provider prompt caching):
 *   - avoided re-fetch  -> saves write-priced tokens (fresh result tokens)
 *   - retention         -> costs read-priced tokens per request for the
 *                          (full - codec) delta of each pinned, beyond-hot-window entry
 *   net = savings * WRITE_PRICE - overhead * READ_PRICE
 *
 * Fidelity notes (intentional approximations, see report caveats):
 *   - "earlier result compressed" is approximated by turn distance > hot window
 *     (the miner's exact replay showed 0 stubbed/dropped: beyond-hot-window
 *     read results are codec-compressed in practice).
 *   - Transcript is held fixed: avoided re-fetches do not shift later turns.
 *   - Codec'd sizes come from one production transform over the full session;
 *     turns still inside the final hot window use the session's mean codec ratio.
 *
 * Usage: bun scripts/simulate-working-set.ts [--since 2026-05-04] [--json out.json]
 */
import type { AgentMessage } from "@oh-my-pi/pi-ai";
import { dedupCodec } from "../packages/coding-agent/src/context/assembler/codecs/dedup-codec";
import { readCodec } from "../packages/coding-agent/src/context/assembler/codecs/read-codec";
import { warmCodec } from "../packages/coding-agent/src/context/assembler/codecs/warm-codec";
import {
	segmentIntoTurns,
	transformMessages,
} from "../packages/coding-agent/src/context/assembler/message-transform";
import {
	extractToolCalls,
	listSessionFiles,
	loadSession,
	SESSIONS_ROOT,
	type ToolCallRef,
} from "./mine-context-illusion";

const CODECS = [dedupCodec, readCodec, warmCodec];
const HOT_WINDOW_TURNS = 4;
const WRITE_PRICE = 1.0;
const READ_PRICE = 0.1;

interface Config {
	/** Evict after this many turns without a touch. */
	evictAfterTurns: number;
	/** Max total pinned tokens (LRU eviction beyond this). */
	tokenCap: number;
	/** What admits a path into the working set. */
	entry: "reread" | "reread+edit" | "reread2";
}

const SWEEP: Config[] = [];
for (const evictAfterTurns of [4, 6, 8, 12]) {
	for (const tokenCap of [16_000, 32_000]) {
		for (const entry of ["reread", "reread2"] as const) {
			SWEEP.push({ evictAfterTurns, tokenCap, entry });
		}
	}
}

interface ConfigResult {
	/** Cache-price-weighted savings (write + residual read components). */
	savedPricedTokens: number;
	config: Config;
	breaksTotal: number;
	breaksAvoided: number;
	savedTokens: number;
	overheadTokens: number;
	peakPinnedTokens: number;
	pinEntries: number;
	evictions: number;
}

interface SessionModel {
	calls: ToolCallRef[];
	/** message idx -> turn idx (full-session segmentation) */
	turnOfMessage: Int32Array;
	turnCount: number;
	/** per message idx of a toolResult: estimated full tokens */
	fullTokens: Map<number, number>;
	/** per message idx of a toolResult: estimated codec'd tokens */
	codecTokens: Map<number, number>;
	resultIdxByCallId: Map<string, number>;
	/** assistant message idx for each request, ascending */
	requestTurns: number[];
}

function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

async function buildSessionModel(path: string): Promise<SessionModel | null> {
	const session = await loadSession(path);
	if (!session) return null;
	const { messages } = session;
	const calls = extractToolCalls(messages);
	if (calls.length === 0) return null;

	const turns = segmentIntoTurns(messages);
	const turnOfMessage = new Int32Array(messages.length).fill(-1);
	{
		let idx = 0;
		for (let t = 0; t < turns.length; t++) {
			for (const _m of turns[t]!.messages) turnOfMessage[idx++] = t;
		}
	}

	const transform = transformMessages(messages, {
		hotWindowTurns: HOT_WINDOW_TURNS,
		codecs: CODECS,
	});

	const fullByTurn = new Map<number, number>();
	const codecByTurn = new Map<number, number>();
	let ratioSum = 0;
	let ratioCount = 0;
	for (const decision of transform.metadata.decisions) {
		fullByTurn.set(decision.turnIndex, decision.tokensBefore);
		codecByTurn.set(decision.turnIndex, decision.tokensAfter);
		if (decision.action === "compressed" && decision.tokensBefore > 0) {
			ratioSum += decision.tokensAfter / decision.tokensBefore;
			ratioCount++;
		}
	}
	const meanRatio = ratioCount > 0 ? ratioSum / ratioCount : 0.2;

	const fullTokens = new Map<number, number>();
	const codecTokens = new Map<number, number>();
	const resultIdxByCallId = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as AgentMessage & { toolCallId?: string; content?: unknown };
		if (m.role !== "toolResult" || !m.toolCallId) continue;
		resultIdxByCallId.set(m.toolCallId, i);
		const full = estimateTokens(m.content);
		fullTokens.set(i, full);
		const turnIdx = turnOfMessage[i]!;
		const turnFull = fullByTurn.get(turnIdx) ?? 0;
		const turnCodec = codecByTurn.get(turnIdx);
		// Scale the turn-level codec ratio down to this result; hot-window turns
		// (no compression observed) fall back to the session mean ratio.
		const ratio = turnCodec !== undefined && turnFull > 0 && turnCodec < turnFull ? turnCodec / turnFull : meanRatio;
		codecTokens.set(i, Math.ceil(full * ratio));
	}

	const requestTurns: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if ((messages[i] as AgentMessage).role === "assistant") requestTurns.push(i);
	}

	return { calls, turnOfMessage, turnCount: turns.length, fullTokens, codecTokens, resultIdxByCallId, requestTurns };
}

interface PinEntry {
	lastTouchTurn: number;
	resultIdx: number;
	tokens: number;
}

function simulate(model: SessionModel, config: Config, result: ConfigResult): void {
	const { calls, turnOfMessage, fullTokens, codecTokens, resultIdxByCallId } = model;

	// Pre-index calls by assistant message for chronological walk.
	const pinned = new Map<string, PinEntry>(); // path -> entry
	const lastReadResultByPath = new Map<string, number>(); // path -> result msg idx
	const lastFetchResultByTarget = new Map<string, number>();
	const mutatedSinceRead = new Set<string>();

	let callCursor = 0;
	let pinnedTokens = 0;

	const evict = (path: string): void => {
		const entry = pinned.get(path);
		if (!entry) return;
		pinnedTokens -= entry.tokens;
		pinned.delete(path);
		result.evictions++;
	};

	const touch = (path: string, resultIdx: number, turn: number): void => {
		const tokens = fullTokens.get(resultIdx) ?? 0;
		const existing = pinned.get(path);
		if (existing) pinnedTokens -= existing.tokens;
		pinned.set(path, { lastTouchTurn: turn, resultIdx, tokens });
		pinnedTokens += tokens;
		result.pinEntries++;
		// LRU eviction over token cap.
		while (pinnedTokens > config.tokenCap && pinned.size > 1) {
			let lruPath: string | null = null;
			let lruTurn = Number.POSITIVE_INFINITY;
			for (const [p, e] of pinned) {
				if (e.lastTouchTurn < lruTurn) {
					lruTurn = e.lastTouchTurn;
					lruPath = p;
				}
			}
			if (lruPath === null || lruPath === path) break;
			evict(lruPath);
		}
	};

	const rereadCount = new Map<string, number>();
	const totalRequests = model.requestTurns.length;
	for (let requestOrdinal = 0; requestOrdinal < totalRequests; requestOrdinal++) {
		const requestIdx = model.requestTurns[requestOrdinal]!;
		const requestTurn = turnOfMessage[requestIdx]!;

		// Age-based eviction.
		for (const [path, entry] of [...pinned]) {
			if (requestTurn - entry.lastTouchTurn > config.evictAfterTurns) evict(path);
		}

		// Retention overhead: pinned entries that baseline would have codec'd by now.
		for (const entry of pinned.values()) {
			const resultTurn = turnOfMessage[entry.resultIdx]!;
			if (requestTurn - resultTurn > HOT_WINDOW_TURNS) {
				const codec = codecTokens.get(entry.resultIdx) ?? 0;
				result.overheadTokens += entry.tokens - codec;
			}
		}
		if (pinnedTokens > result.peakPinnedTokens) result.peakPinnedTokens = pinnedTokens;

		// Process this assistant message's tool calls.
		while (callCursor < calls.length && calls[callCursor]!.assistantIdx <= requestIdx) {
			const call = calls[callCursor]!;
			callCursor++;
			if (call.assistantIdx < requestIdx) continue; // already handled (defensive)

			if (call.mutatedPath !== null) {
				mutatedSinceRead.add(call.mutatedPath);
				if (config.entry === "reread+edit") {
					const lastRead = lastReadResultByPath.get(call.mutatedPath);
					// Edit signals active use, but the pinned copy is now stale; the
					// next read refreshes it. Touch keeps it resident if already pinned.
					const existing = pinned.get(call.mutatedPath);
					if (existing !== undefined && lastRead !== undefined) {
						existing.lastTouchTurn = turnOfMessage[call.assistantIdx]!;
					}
				}
				continue;
			}

			if (call.target === null) continue;
			const callTurn = turnOfMessage[call.assistantIdx]!;
			const earlierResultIdx = lastFetchResultByTarget.get(call.target);
			const resultIdx = resultIdxByCallId.get(call.callId);

			if (call.fetchPath !== null) {
				// read call
				const wasMutated = mutatedSinceRead.has(call.fetchPath);
				if (earlierResultIdx !== undefined && !wasMutated) {
					const distance = callTurn - turnOfMessage[earlierResultIdx]!;
					if (distance > HOT_WINDOW_TURNS) {
						result.breaksTotal++;
						const pin = pinned.get(call.fetchPath);
						if (pin !== undefined) {
							result.breaksAvoided++;
							const full = resultIdx !== undefined ? (fullTokens.get(resultIdx) ?? 0) : 0;
							const remaining = totalRequests - requestOrdinal - 1;
							result.savedTokens += full;
							// Avoided duplicate saves: one write of the full result, plus its
							// full-size hot-window residence (read-priced) on following requests.
							// Long-term residue of a re-read of unchanged content is a dedup
							// back-ref (~16 tokens) — negligible, modeled as such.
							const DEDUP_REF_TOKENS = 16;
							result.savedPricedTokens +=
								full * WRITE_PRICE +
								full * READ_PRICE * Math.min(HOT_WINDOW_TURNS - 1, remaining) +
								DEDUP_REF_TOKENS * READ_PRICE * remaining;
							pin.lastTouchTurn = callTurn;
							// Avoided: do not refresh lastFetchResult/pin from a result that
							// would not exist. Skip the bookkeeping below.
							continue;
						}
					}
					// Unavoided re-read of unchanged file => working-set entry signal.
					const count = (rereadCount.get(call.fetchPath) ?? 0) + 1;
					rereadCount.set(call.fetchPath, count);
					if (resultIdx !== undefined && (config.entry !== "reread2" || count >= 2)) {
						touch(call.fetchPath, resultIdx, callTurn);
					}
				}
				if (wasMutated) mutatedSinceRead.delete(call.fetchPath);
				if (resultIdx !== undefined) {
					lastReadResultByPath.set(call.fetchPath, resultIdx);
					const pin = pinned.get(call.fetchPath);
					if (pin !== undefined) touch(call.fetchPath, resultIdx, callTurn);
				}
			} else if (earlierResultIdx !== undefined) {
				// non-read fetch (grep/find/bash): counted for breaks baseline only
				const distance = callTurn - turnOfMessage[earlierResultIdx]!;
				if (distance > HOT_WINDOW_TURNS && call.tool !== "bash") result.breaksTotal++;
			}

			if (resultIdx !== undefined) lastFetchResultByTarget.set(call.target, resultIdx);
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let since = Date.parse("2026-05-04");
	let jsonOut: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--since" && args[i + 1]) since = Date.parse(args[++i]!);
		if (args[i] === "--json" && args[i + 1]) jsonOut = args[++i];
	}

	const files = listSessionFiles(SESSIONS_ROOT, since);
	const results: ConfigResult[] = SWEEP.map((config) => ({
		config,
		breaksTotal: 0,
		breaksAvoided: 0,
		savedTokens: 0,
		savedPricedTokens: 0,
		overheadTokens: 0,
		peakPinnedTokens: 0,
		pinEntries: 0,
		evictions: 0,
	}));

	let sessions = 0;
	for (const file of files) {
		const model = await buildSessionModel(file);
		if (!model) continue;
		sessions++;
		for (const result of results) simulate(model, result.config, result);
	}

	const lines: string[] = [];
	lines.push(`# Working-set counterfactual sweep (${sessions} sessions)`);
	lines.push(``);
	lines.push(`Prices: write=${WRITE_PRICE}, cacheRead=${READ_PRICE}. Net = saved*write - overhead*read.`);
	lines.push(``);
	lines.push(`| evictK | cap | entry | breaks avoided | saved tok | saved priced | overhead tok | net (priced) | peak pin | evictions |`);
	lines.push(`|--------|-----|-------|----------------|-----------|--------------|--------------|--------------|----------|-----------|`);
	for (const r of results) {
		const pct = r.breaksTotal > 0 ? ((r.breaksAvoided / r.breaksTotal) * 100).toFixed(1) : "0.0";
		const net = Math.round(r.savedPricedTokens - r.overheadTokens * READ_PRICE);
		lines.push(
			`| ${r.config.evictAfterTurns} | ${r.config.tokenCap / 1000}K | ${r.config.entry} | ${r.breaksAvoided}/${r.breaksTotal} (${pct}%) | ${r.savedTokens} | ${Math.round(r.savedPricedTokens)} | ${r.overheadTokens} | ${net} | ${r.peakPinnedTokens} | ${r.evictions} |`,
		);
	}

	const report = lines.join("\n");
	process.stdout.write(`${report}\n`);
	if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ sessions, results }, null, 2));
}

if (import.meta.main) await main();
