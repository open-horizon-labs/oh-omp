#!/usr/bin/env bun
/**
 * Read-only replay miner for context-illusion integrity (harness-ergonomics Track A).
 *
 * Replays the production assembler transform (same codecs, same hot window) over
 * recorded session JSONL files and measures:
 *
 *   Proxy 1 — redundant re-fetch: a fetch-class tool call (read/grep/find/bash)
 *             repeating an earlier target, classified by what the transform had
 *             done to the earlier result at the moment of the re-fetch
 *             (kept / stubbed / codec-compressed / dropped).
 *   Proxy 2 — recovery split: recall(turn=N) / recall(query) usage vs. fresh re-fetch.
 *   Proxy 3 — recall efficacy: recall immediately followed by a re-fetch of a
 *             previously-seen target (silent retrieval failure).
 *
 * Privacy: outputs aggregates only. Targets are never printed verbatim; sample
 * listings use sha256 prefixes. Nothing payload-bearing is written.
 *
 * Usage: bun scripts/mine-context-illusion.ts [--since 2026-05-04] [--json out.json]
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@oh-my-pi/pi-ai";
import { dedupCodec } from "../packages/coding-agent/src/context/assembler/codecs/dedup-codec";
import { readCodec } from "../packages/coding-agent/src/context/assembler/codecs/read-codec";
import { warmCodec } from "../packages/coding-agent/src/context/assembler/codecs/warm-codec";
import {
	segmentIntoTurns,
	transformMessages,
} from "../packages/coding-agent/src/context/assembler/message-transform";

export const SESSIONS_ROOT = join(homedir(), ".oh-omp", "agent", "sessions");
/** Mirror production: sdk.ts builds [dedup, read, warm] in this order. */
const CODECS = [dedupCodec, readCodec, warmCodec];
/** Mirror production default: settings-schema assembler.hotWindowTurns = 4. */
const HOT_WINDOW_TURNS = 4;
export const FETCH_TOOLS = new Set(["read", "grep", "find", "bash"]);
export const MUTATING_TOOLS = new Set(["edit", "write", "ast_edit", "notebook", "apply_patch"]);
/** Cap replay invocations per session to bound runtime on pathological sessions. */
const MAX_REPLAYS_PER_SESSION = 2000;
/** Set via --working-set: replay classification under the retention policy. */
const WORKING_SET_REPLAY = { enabled: false };

interface CliArgs {
	since: number;
	jsonOut?: string;
}

function parseArgs(): CliArgs {
	// Mutated via --working-set: replay history under the retention policy.

	const args = process.argv.slice(2);
	let since = Date.parse("2026-05-04");

	let jsonOut: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--since" && args[i + 1]) since = Date.parse(args[++i]!);
		if (args[i] === "--json" && args[i + 1]) jsonOut = args[++i];
		if (args[i] === "--working-set") WORKING_SET_REPLAY.enabled = true;
	}
	return { since, jsonOut };
}

export interface ToolCallRef {
	/** Index of the assistant message containing the call. */
	assistantIdx: number;
	callId: string;
	tool: string;
	target: string | null;
	/** Set for read calls: the file path, used for mutation-justified re-read detection. */
	fetchPath: string | null;
	/** Set for mutating calls (edit/write/ast_edit/notebook): the touched path. */
	mutatedPath: string | null;
	model: string;
}

interface SessionStats {
	files: number;
	parseFailures: number;
	compactionResets: number;
	fetchCalls: number;
	uniqueTargets: number;
	replaysCapped: number;
}

type EarlierStatus =
	| "visible" // kept verbatim (hot window / no compression applied)
	| "stubbed"
	| "codec-compressed"
	| "dropped"
	| "unknown";

interface Aggregates {
	refetchByStatus: Record<EarlierStatus, number>;
	refetchByTool: Record<string, Record<EarlierStatus, number>>;
	refetchByModel: Record<string, Record<EarlierStatus, number>>;
	recallCalls: number;
	recallTurnExpansions: number;
	recallQueries: number;
	recallThenRefetch: number;
	postCompactionRefetches: number;
	wastedTokensEstimate: number;
	mutationJustifiedRereads: number;
	readOnlyIllusionBreaks: number;
	sampleHashes: { status: EarlierStatus; tool: string; hash: string }[];
}

function emptyStatusRecord(): Record<EarlierStatus, number> {
	return { visible: 0, stubbed: 0, "codec-compressed": 0, dropped: 0, unknown: 0 };
}

function sha8(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function parseArguments(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return {};
}

/** Normalize a fetch-class call to a stable re-fetch target key, or null if not comparable. */
function normalizeTarget(tool: string, args: Record<string, unknown>): string | null {
	switch (tool) {
		case "read": {
			if (typeof args.path !== "string") return null;
			// Different offsets are pagination, not redundancy.
			return `read:${args.path}:${args.offset ?? 0}`;
		}
		case "grep": {
			if (typeof args.pattern !== "string") return null;
			return `grep:${args.pattern}|${args.path ?? ""}|${args.glob ?? ""}`;
		}
		case "find": {
			if (typeof args.pattern !== "string") return null;
			return `find:${args.pattern}`;
		}
		case "bash": {
			if (typeof args.command !== "string") return null;
			return `bash:${args.command.trim()}`;
		}
		default:
			return null;
	}
}

export function listSessionFiles(root: string, since: number): string[] {
	const out: string[] = [];
	let projects: string[] = [];
	try {
		projects = readdirSync(root);
	} catch {
		return out;
	}
	for (const project of projects) {
		const dir = join(root, project);
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const path = join(dir, entry);
			try {
				if (statSync(path).mtimeMs >= since) out.push(path);
			} catch {
				// unreadable file: skip
			}
		}
	}
	return out;
}

export interface LoadedSession {
	messages: AgentMessage[];
	/** Message indices at which a compaction record appeared (history before is not what the model saw). */
	compactionBoundaries: number[];
}

export async function loadSession(path: string): Promise<LoadedSession | null> {
	const text = await Bun.file(path).text();
	const messages: AgentMessage[] = [];
	const compactionBoundaries: number[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record: { type?: string; message?: AgentMessage };
		try {
			record = JSON.parse(line) as { type?: string; message?: AgentMessage };
		} catch {
			continue;
		}
		if (record.type === "message" && record.message) {
			messages.push(record.message);
		} else if (record.type && /compact/i.test(record.type)) {
			compactionBoundaries.push(messages.length);
		}
	}
	if (messages.length === 0) return null;
	return { messages, compactionBoundaries };
}

export function extractToolCalls(messages: AgentMessage[]): ToolCallRef[] {
	const calls: ToolCallRef[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i] as AgentMessage & { model?: string };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (b.type !== "toolCall" || !b.id || !b.name) continue;
			const args = parseArguments(b.arguments);
			const mutating = MUTATING_TOOLS.has(b.name);
			const pathArg =
				typeof args.path === "string"
					? args.path
					: typeof args.notebook_path === "string"
						? args.notebook_path
						: null;
			calls.push({
				assistantIdx: i,
				callId: b.id,
				tool: b.name,
				target: normalizeTarget(b.name, args),
				fetchPath: b.name === "read" && typeof args.path === "string" ? args.path : null,
				mutatedPath: mutating ? pathArg : null,
				model: message.model ?? "unknown",
			});
		}
	}
	return calls;
}

/** Map a message index to its turn index within a segmented prefix. */
function turnIndexOfMessage(turns: { messages: AgentMessage[] }[], messageIdx: number): number {
	let count = 0;
	for (let t = 0; t < turns.length; t++) {
		count += turns[t]!.messages.length;
		if (messageIdx < count) return t;
	}
	return -1;
}

interface ReplayCache {
	assistantIdx: number;
	decisions: { reason: string }[];
	turns: { messages: AgentMessage[] }[];
}

function classifyEarlierStatus(
	messages: AgentMessage[],
	assistantIdx: number,
	earlierResultIdx: number,
	cache: { value: ReplayCache | null },
): EarlierStatus {
	if (earlierResultIdx >= assistantIdx) return "unknown";
	// Memoize per assistant turn: all re-fetch calls issued from the same
	// assistant message share one transform replay.
	if (!cache.value || cache.value.assistantIdx !== assistantIdx) {
		const prefix = messages.slice(0, assistantIdx);
		const result = transformMessages(prefix, {
			hotWindowTurns: HOT_WINDOW_TURNS,
			codecs: CODECS,
			workingSet: WORKING_SET_REPLAY.enabled ? { enabled: true } : undefined,
		});
		cache.value = {
			assistantIdx,
			decisions: result.metadata.decisions,
			turns: segmentIntoTurns(prefix),
		};
	}
	const turnIdx = turnIndexOfMessage(cache.value.turns, earlierResultIdx);
	if (turnIdx < 0) return "unknown";
	const decision = cache.value.decisions[turnIdx];
	if (!decision) return "unknown";
	switch (decision.reason) {
		case "hot-window":
		case "no-tool-results":
		case "working-set":
			return "visible";
		case "beyond-hot-window":
			return "stubbed";
		case "codec-compressed":
			return "codec-compressed";
		case "budget-exceeded":
		case "developer-dropped":
			return "dropped";
		case "conversation-compressed":
			return "stubbed";
		default:
			return "unknown";
	}
}

async function main(): Promise<void> {
	const { since, jsonOut } = parseArgs();
	const files = listSessionFiles(SESSIONS_ROOT, since);

	const stats: SessionStats = {
		files: 0,
		parseFailures: 0,
		compactionResets: 0,
		fetchCalls: 0,
		uniqueTargets: 0,
		replaysCapped: 0,
	};
	const agg: Aggregates = {
		refetchByStatus: emptyStatusRecord(),
		refetchByTool: {},
		refetchByModel: {},
		recallCalls: 0,
		recallTurnExpansions: 0,
		recallQueries: 0,
		recallThenRefetch: 0,
		postCompactionRefetches: 0,
		wastedTokensEstimate: 0,
		mutationJustifiedRereads: 0,
		readOnlyIllusionBreaks: 0,
		sampleHashes: [],
	};

	for (const file of files) {
		const session = await loadSession(file);
		if (!session) {
			stats.parseFailures++;
			continue;
		}
		stats.files++;
		const { messages, compactionBoundaries } = session;
		const calls = extractToolCalls(messages);
		const resultIdxByCallId = new Map<string, number>();
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i] as AgentMessage & { toolCallId?: string };
			if (m.role === "toolResult" && m.toolCallId) resultIdxByCallId.set(m.toolCallId, i);
		}

		// target -> most recent earlier fetch's result message index
		let lastFetchResultByTarget = new Map<string, number>();
		// First fetch of a target since its last mutation: the canonical copy that
		// dedup back-refs (and the working-set pin) point to.
		let firstFetchResultByTarget = new Map<string, number>();
		const lastMutationIdxByPath = new Map<string, number>();
		let nextCompaction = 0;
		let replays = 0;
		const replayCache: { value: ReplayCache | null } = { value: null };
		const seenTargets = new Set<string>();
		let recallPending: number | null = null; // assistantIdx of a recent recall call

		for (const call of calls) {
			// Reset re-fetch state across compaction boundaries: prior results are
			// genuinely gone; re-fetching them is proxy 5 (post-compaction), not proxy 1.
			while (
				nextCompaction < compactionBoundaries.length &&
				compactionBoundaries[nextCompaction]! <= call.assistantIdx
			) {
				if (lastFetchResultByTarget.size > 0) stats.compactionResets++;
				lastFetchResultByTarget = new Map();
				firstFetchResultByTarget = new Map();
				nextCompaction++;
			}

			if (call.mutatedPath !== null) {
				lastMutationIdxByPath.set(call.mutatedPath, call.assistantIdx);
				continue;
			}

			if (call.tool === "recall") {
				agg.recallCalls++;
				const args = parseArguments(
					(messages[call.assistantIdx] as AgentMessage & { content: unknown[] }).content
						.filter(
							(b): b is { type: string; id: string; arguments: unknown } =>
								typeof b === "object" && b !== null && (b as { id?: string }).id === call.callId,
						)
						.map((b) => b.arguments)[0],
				);
				if (args.turn !== undefined) agg.recallTurnExpansions++;
				else agg.recallQueries++;
				recallPending = call.assistantIdx;
				continue;
			}

			if (!FETCH_TOOLS.has(call.tool) || call.target === null) continue;
			stats.fetchCalls++;
			seenTargets.add(call.target);

			const earlierResultIdx = lastFetchResultByTarget.get(call.target);
			const mutationIdx = call.fetchPath !== null ? lastMutationIdxByPath.get(call.fetchPath) : undefined;
			if (
				earlierResultIdx !== undefined &&
				mutationIdx !== undefined &&
				mutationIdx > earlierResultIdx &&
				mutationIdx <= call.assistantIdx
			) {
				// File changed between fetches: re-read is correct behavior, not an illusion break.
				agg.mutationJustifiedRereads++;
				const justifiedResultIdx = resultIdxByCallId.get(call.callId);
				if (justifiedResultIdx !== undefined) {
					lastFetchResultByTarget.set(call.target, justifiedResultIdx);
					firstFetchResultByTarget.set(call.target, justifiedResultIdx);
				}
				continue;
			}
			if (earlierResultIdx !== undefined && earlierResultIdx < call.assistantIdx) {
				let status: EarlierStatus = "unknown";
				if (replays < MAX_REPLAYS_PER_SESSION) {
					if (!replayCache.value || replayCache.value.assistantIdx !== call.assistantIdx) replays++;
					status = classifyEarlierStatus(messages, call.assistantIdx, earlierResultIdx, replayCache);
					// Content may live verbatim at the canonical first-read turn even when
					// the latest copy is collapsed (dedup back-refs point at the canonical
					// copy; the working-set policy pins it).
					const canonicalIdx = firstFetchResultByTarget.get(call.target);
					if (
						status !== "visible" &&
						canonicalIdx !== undefined &&
						canonicalIdx !== earlierResultIdx &&
						classifyEarlierStatus(messages, call.assistantIdx, canonicalIdx, replayCache) === "visible"
					) {
						status = "visible";
					}
				} else {
					stats.replaysCapped++;
				}
				agg.refetchByStatus[status]++;
				(agg.refetchByTool[call.tool] ??= emptyStatusRecord())[status]++;
				(agg.refetchByModel[call.model] ??= emptyStatusRecord())[status]++;
				if (status === "stubbed" || status === "codec-compressed" || status === "dropped") {
					const newResultIdx = resultIdxByCallId.get(call.callId);
					if (newResultIdx !== undefined) {
						const content = (messages[newResultIdx] as AgentMessage & { content?: unknown }).content;
						const chars = JSON.stringify(content ?? "").length;
						agg.wastedTokensEstimate += Math.ceil(chars / 4);
					}
					if (call.tool !== "bash") agg.readOnlyIllusionBreaks++;
				}
				if (status !== "visible" && agg.sampleHashes.length < 40) {
					agg.sampleHashes.push({ status, tool: call.tool, hash: sha8(call.target) });
				}
				if (recallPending !== null && call.assistantIdx - recallPending <= 2) {
					agg.recallThenRefetch++;
				}
				if (
					compactionBoundaries.length > 0 &&
					nextCompaction > 0 &&
					call.assistantIdx - (compactionBoundaries[nextCompaction - 1] ?? 0) < 10
				) {
					agg.postCompactionRefetches++;
				}
			}

			const resultIdx = resultIdxByCallId.get(call.callId);
			if (resultIdx !== undefined) {
				lastFetchResultByTarget.set(call.target, resultIdx);
				if (!firstFetchResultByTarget.has(call.target)) firstFetchResultByTarget.set(call.target, resultIdx);
			}
			if (recallPending !== null && call.assistantIdx - recallPending > 2) recallPending = null;
		}
		stats.uniqueTargets += seenTargets.size;
	}

	const totalRefetches = Object.values(agg.refetchByStatus).reduce((a, b) => a + b, 0);
	const illusionBreaks =
		agg.refetchByStatus.stubbed + agg.refetchByStatus["codec-compressed"] + agg.refetchByStatus.dropped;

	const lines: string[] = [];
	lines.push(`# Context-illusion mining report`);
	lines.push(``);
	lines.push(`Corpus: ${stats.files} sessions since ${new Date(parseArgs().since).toISOString().slice(0, 10)}`);
	lines.push(
		`Fetch calls: ${stats.fetchCalls} | unique targets: ${stats.uniqueTargets} | re-fetches: ${totalRefetches} (${((totalRefetches / Math.max(stats.fetchCalls, 1)) * 100).toFixed(1)}% of fetches)`,
	);
	lines.push(`Compaction resets: ${stats.compactionResets} | replays capped: ${stats.replaysCapped}`);
	lines.push(``);
	lines.push(`## Proxy 1 — re-fetch by earlier-result state (replayed transform)`);
	for (const [status, count] of Object.entries(agg.refetchByStatus)) {
		const pct = totalRefetches > 0 ? ((count / totalRefetches) * 100).toFixed(1) : "0.0";
		lines.push(`- ${status}: ${count} (${pct}%)`);
	}
	lines.push(``);
	lines.push(
		`**Illusion-relevant re-fetches** (earlier result stubbed/codec'd/dropped): ${illusionBreaks} = ${((illusionBreaks / Math.max(stats.fetchCalls, 1)) * 100).toFixed(2)}% of all fetch calls`,
	);
	lines.push(``);
	lines.push(`## Proxy 2 — recovery split`);
	lines.push(
		`- recall calls: ${agg.recallCalls} (turn expansions: ${agg.recallTurnExpansions}, queries: ${agg.recallQueries})`,
	);
	lines.push(`- fresh re-fetches of compressed content: ${illusionBreaks}`);
	lines.push(``);
	lines.push(`## Proxy 3 — recall efficacy`);
	lines.push(`- recall followed by re-fetch of a previously-seen target (≤2 turns): ${agg.recallThenRefetch}`);
	lines.push(``);
	lines.push(`## Per-tool re-fetch (status: visible/stubbed/codec/dropped/unknown)`);
	for (const [tool, rec] of Object.entries(agg.refetchByTool)) {
		lines.push(
			`- ${tool}: ${rec.visible}/${rec.stubbed}/${rec["codec-compressed"]}/${rec.dropped}/${rec.unknown}`,
		);
	}
	lines.push(``);
	lines.push(`## Per-model re-fetch (status: visible/stubbed/codec/dropped/unknown)`);
	for (const [model, rec] of Object.entries(agg.refetchByModel)) {
		lines.push(
			`- ${model}: ${rec.visible}/${rec.stubbed}/${rec["codec-compressed"]}/${rec.dropped}/${rec.unknown}`,
		);
	}
	lines.push(``);
	lines.push(`## Post-compaction re-fetches (proxy 5, coarse): ${agg.postCompactionRefetches}`);
	lines.push(``);
	lines.push(
		`## Cost: read-only illusion breaks (read/grep/find): ${agg.readOnlyIllusionBreaks} | wasted tokens (est, all illusion re-fetches): ~${agg.wastedTokensEstimate} | mutation-justified re-reads excluded: ${agg.mutationJustifiedRereads}`,
	);

	const report = lines.join("\n");
	process.stdout.write(`${report}\n`);
	if (jsonOut) {
		await Bun.write(jsonOut, JSON.stringify({ stats, agg }, null, 2));
	}
}

if (import.meta.main) await main();
