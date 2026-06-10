/**
 * Message-level context transformation for the assembler.
 *
 * Segments flat AgentMessage arrays into turns, applies a hot-window policy
 * that preserves recent turns verbatim, replaces tool_result content beyond
 * the window with stubs, and bounds total message tokens within budget.
 *
 * Returns structured decision metadata alongside the transformed messages
 * so downstream observability can report what was kept, stubbed, or dropped
 * without reconstructing decisions from the final message array.
 *
 * Key invariants (ADR 0004):
 *   - Current-turn tool_result messages are always kept verbatim.
 *   - tool_use / tool_result pairing is never broken.
 *   - Shadow mode passes messages through untouched.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { parseMCPToolName } from "../../mcp/tool-bridge";
import type { MemoryAssemblyBudget } from "../memory-contract";
import { buildPeek, contentHash, extractText, isReadTool, VERBATIM_LINE_THRESHOLD } from "./codecs/shared";
import type { BudgetDerivationInput, CodecContext, ContentCodec, FileReadEntry } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Token estimation & budget derivation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract source provenance tags from messages in a turn.
 * For tool_result messages, derives the source from toolName.
 * MCP tools get "mcp:serverName", builtins get "tool:toolName".
 */
export function extractSourceTags(messages: AgentMessage[]): string[] {
	const tags = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const toolName = (msg as { toolName?: string }).toolName;
		if (!toolName) continue;
		const mcpParts = parseMCPToolName(toolName);
		if (mcpParts) {
			tags.add(`mcp:${mcpParts.serverName}`);
		} else {
			tags.add(`tool:${toolName}`);
		}
	}
	return [...tags];
}

function estimateTokensFromCharCount(chars: number): number {
	// Empirical: warm codec stubs ~2.5 chars/tok, prose ~3.0, code ~3.3.
	// Use 3.2 as a conservative estimate for mixed content.
	return Math.ceil(chars / 3.2);
}

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

const DEFAULT_MAX_LATENCY_MS = 2000;
const DEFAULT_SAFETY_MARGIN_PERCENT = 5;
const DEFAULT_MESSAGE_BUDGET_PERCENT = 50;
const DEFAULT_HYDRATION_BUDGET_PERCENT = 50;
const DEFAULT_TURN_BUFFER_PERCENT = 20;
/** Working-set defaults: evict after N untouched turns; cap on pinned verbatim tokens. */
const DEFAULT_WORKING_SET_EVICT_TURNS = 8;
const DEFAULT_WORKING_SET_TOKEN_CAP = 16_000;

export function deriveBudget(input: BudgetDerivationInput): MemoryAssemblyBudget {
	const safetyPercent = input.safetyMarginPercent ?? DEFAULT_SAFETY_MARGIN_PERCENT;
	const messagePercent = input.messageBudgetPercent ?? DEFAULT_MESSAGE_BUDGET_PERCENT;
	const turnBufferPercent = input.turnBufferPercent ?? DEFAULT_TURN_BUFFER_PERCENT;
	const hydrationPercent = input.hydrationBudgetPercent ?? DEFAULT_HYDRATION_BUDGET_PERCENT;
	const modelContextWindow = Math.max(input.contextWindow, input.modelContextWindow ?? input.contextWindow);
	const configuredTurnBuffer = Math.floor((input.contextWindow * turnBufferPercent) / 100);
	const spilloverHeadroom = Math.max(0, modelContextWindow - input.contextWindow);
	const turnBuffer = Math.max(0, configuredTurnBuffer - spilloverHeadroom);
	const totalCosts = input.systemPromptTokens + input.toolDefinitionTokens + input.currentTurnTokens;
	const safetyReserve = Math.floor((input.contextWindow * safetyPercent) / 100);
	const allocatable = Math.max(0, input.contextWindow - totalCosts - safetyReserve - turnBuffer);

	// Warn when fixed costs dominate and the allocatable budget is critically low.
	// Threshold: less than 10% of the context window is available for messages + hydration.
	if (input.contextWindow > 0 && allocatable < input.contextWindow * 0.1) {
		logger.warn("Budget critically low: fixed costs dominate context window", {
			contextWindow: input.contextWindow,
			modelContextWindow,
			totalCosts,
			safetyReserve,
			configuredTurnBuffer,
			spilloverHeadroom,
			turnBuffer,
			allocatable,
			usagePercent: Math.round((totalCosts / input.contextWindow) * 100),
		});
	}

	return {
		maxTokens: allocatable,
		maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
		hydrationBudgetMax: Math.floor((allocatable * hydrationPercent) / 100),
		messageBudgetMin: Math.floor((allocatable * messagePercent) / 100),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Default number of recent turns kept verbatim before content replacement. */
export const DEFAULT_HOT_WINDOW_TURNS = 3;

/** Compact fallback stub injected into tool_result messages beyond the hot window. */
export const TOOL_RESULT_STUB_TEXT = "[ref]";

export interface ToolResultStubPointer {
	text: string;
}

/** Format stub text as a compact actionable pointer. */
export function formatStubText(
	sourceTags?: string[],
	pointer?: ToolResultStubPointer | null,
	toolName?: string,
): string {
	if (pointer?.text) return pointer.text;
	if (toolName) return `[ref:${toolName}]`;
	if (!sourceTags || sourceTags.length === 0) return TOOL_RESULT_STUB_TEXT;

	const primary = sourceTags[0]?.replace(/^tool:/, "")?.replace(/^mcp:/, "mcp:");
	return primary ? `[ref:${primary}]` : TOOL_RESULT_STUB_TEXT;
}

export interface MessageTransformOptions {
	/** Number of recent turns to keep verbatim (default: {@link DEFAULT_HOT_WINDOW_TURNS}). */
	hotWindowTurns?: number;

	/** Resolve compact pointer text for a stubbed tool_result message. */
	resolveToolResultStub?: (message: ToolResultMessage) => ToolResultStubPointer | null;

	/**
	 * Ordered content codec registry. Codecs are tried in order; first match wins.
	 * When a codec matches and produces content, that replaces the tool result
	 * instead of a stub. If no codec matches or encode returns null, the default
	 * stub is used.
	 */
	codecs?: ContentCodec[];

	/**
	 * Maximum token budget for the output message array.
	 * When set, oldest turns are dropped (as complete groups) until
	 * the estimated token count fits. Omit to skip budget bounding.
	 */
	maxTokens?: number;

	/**
	 * Pre-computed semantic relevance scores for turns, keyed by turn index.
	 * Values are cosine similarity (0–1) between the turn's embedding and the
	 * hot-window embedding. Missing entries default to keep-verbatim.
	 */
	relevanceScores?: Map<number, number>;

	/**
	 * Working-set retention: keep the canonical (first-read) copy of actively
	 * re-read files verbatim beyond the hot window, so dedup back-references
	 * point at full content instead of a codec skeleton. Disabled unless
	 * `enabled` is explicitly true.
	 */
	workingSet?: WorkingSetOptions;
}

/** Options for working-set retention (see {@link MessageTransformOptions.workingSet}). */
export interface WorkingSetOptions {
	/** Master switch; the policy only runs when explicitly enabled. */
	enabled?: boolean;
	/** Evict a path after this many turns without an unchanged re-read (default {@link DEFAULT_WORKING_SET_EVICT_TURNS}). */
	evictAfterTurns?: number;
	/** Max total estimated tokens held verbatim by pinned turns (default {@link DEFAULT_WORKING_SET_TOKEN_CAP}). */
	tokenCap?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Decision metadata types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The final outcome for a turn during transformation.
 *
 * - `kept`    — Turn included in output with original content preserved.
 * - `stubbed` — Turn included but tool_result content replaced with stubs.
 * - `dropped` — Turn removed entirely to fit the token budget.
 */
export type TurnDecisionAction = "kept" | "stubbed" | "compressed" | "dropped";

/**
 * Structured metadata for a single turn's transformation outcome.
 *
 * Each record carries a stable identifier ({@link turnIndex}) and an explicit
 * reason so downstream consumers do not have to infer behavior from diffs.
 */
export interface TurnDecision {
	/** Index in the segmented turn array (stable for a given input). */
	turnIndex: number;

	/** Final outcome for this turn. */
	action: TurnDecisionAction;

	/**
	 * Explicit reason for the decision.
	 *
	 * Values:
	 *   - `"hot-window"`       — within the hot window, kept verbatim.
	 *   - `"no-tool-results"`   — beyond hot window but no tool results to stub.
	 *   - `"beyond-hot-window"` — tool results replaced with stubs.
	 *   - `"codec-compressed"`  — tool results replaced with codec warm representation.
	 *   - `"working-set"`       — beyond hot window but pinned: canonical copy of an actively re-read file, kept verbatim.
	 *   - `"budget-exceeded"`   — dropped to fit the token budget.
	 *   - `"conversation-compressed"` — non-tool turn compressed via head+tail based on semantic relevance.
	 *   - `"developer-dropped"` — developer message beyond hot window dropped (regenerated each turn).
	 */
	reason:
		| "hot-window"
		| "no-tool-results"
		| "beyond-hot-window"
		| "codec-compressed"
		| "working-set"
		| "budget-exceeded"
		| "conversation-compressed"
		| "developer-dropped";

	/** Number of messages in this turn. */
	messageCount: number;

	/** Whether this turn contains tool_result messages. */
	hasToolResults: boolean;

	/** Estimated tokens before any transformation. */
	tokensBefore: number;

	/** Estimated tokens after transformation (0 if dropped). */
	tokensAfter: number;

	/** Source provenance tags for tools in this turn (e.g. "tool:grep", "mcp:rna-server"). Empty for non-tool turns. */
	sourceTags: string[];
}

/**
 * Aggregate metadata from a transform pass.
 *
 * Provides per-turn decision records and summary token accounting
 * sufficient for downstream prompt observability.
 */
export interface TransformMetadata {
	/** Per-turn decision records, ordered by original turn index. */
	decisions: TurnDecision[];

	/** Total turns in the original segmented conversation. */
	totalTurns: number;

	/** Number of turns kept verbatim. */
	keptCount: number;

	/** Number of turns with tool results stubbed. */
	stubbedCount: number;

	/** Number of turns with tool results replaced by codec warm representations. */
	compressedCount: number;

	/** Number of turns dropped for budget. */
	droppedCount: number;

	/** Total estimated tokens before transformation. */
	tokensBefore: number;

	/** Total estimated tokens after transformation. */
	tokensAfter: number;

	/** Number of non-tool turns that received a relevance score. */
	scoredCount: number;

	/** Min/max similarity scores observed (undefined if no scoring). */
	similarityRange?: { min: number; max: number };
}

/**
 * Result of {@link transformMessages}: the transformed message array
 * paired with structured decision metadata.
 */
export interface TransformResult {
	/** Transformed message array. */
	messages: AgentMessage[];

	/** Structured decision metadata for every turn. */
	metadata: TransformMetadata;
}

// ═══════════════════════════════════════════════════════════════════════════
// Turn segmentation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A logical turn: a group of messages that belong together.
 *
 * Turn boundaries are defined by assistant messages and their tool results:
 *   - An assistant message with tool_use blocks + its corresponding tool_result
 *     messages form one turn.
 *   - A standalone assistant message (no tool calls) is its own turn.
 *   - User, developer, and custom messages each form their own turn.
 *
 * This grouping ensures tool_use/tool_result pairing is never broken — a turn
 * is either kept whole or dropped whole.
 */
export interface Turn {
	/** Messages in this turn, in their original order. */
	messages: AgentMessage[];

	/**
	 * Whether this turn contains tool_result messages.
	 * Used to decide whether content replacement applies.
	 */
	hasToolResults: boolean;
}

/**
 * Segment a flat message array into logical turns.
 *
 * Scans forward, grouping:
 *   1. Non-assistant messages → single-message turn each.
 *   2. Assistant message → collects all immediately-following tool_result
 *      messages into one turn.
 *
 * Consecutive tool_result messages without a preceding assistant message
 * (shouldn't happen in normal flow, but defensive) are grouped into one turn.
 */
export function segmentIntoTurns(messages: AgentMessage[]): Turn[] {
	const turns: Turn[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "assistant") {
			// Start a new turn with the assistant message
			const turnMessages: AgentMessage[] = [msg];
			i++;

			// Collect all following tool_result messages
			while (i < messages.length && messages[i].role === "toolResult") {
				turnMessages.push(messages[i]);
				i++;
			}

			turns.push({
				messages: turnMessages,
				hasToolResults: turnMessages.length > 1,
			});
		} else if (msg.role === "toolResult") {
			// Orphaned tool_result without preceding assistant — defensive grouping
			const turnMessages: AgentMessage[] = [msg];
			i++;

			while (i < messages.length && messages[i].role === "toolResult") {
				turnMessages.push(messages[i]);
				i++;
			}

			turns.push({
				messages: turnMessages,
				hasToolResults: true,
			});
		} else {
			// User, developer, custom messages — each is its own turn
			turns.push({
				messages: [msg],
				hasToolResults: false,
			});
			i++;
		}
	}

	return turns;
}

// ═══════════════════════════════════════════════════════════════════════════
// Content replacement (codec-aware)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Try to encode a tool result message using the codec registry.
 * Returns the encoded content if a codec matched and produced output, null otherwise.
 */
function tryCodecEncode(msg: ToolResultMessage, codecs: ContentCodec[], ctx: CodecContext): TextContent[] | null {
	for (const codec of codecs) {
		const matched = codec.matches(msg, ctx);
		if (matched) {
			const encoded = codec.encode(msg, ctx);
			if (encoded) return encoded;
		}
	}
	return null;
}

/**
 * Extract text content from a developer turn's messages.
 */
function extractDeveloperText(turn: Turn): string {
	return turn.messages
		.map(m => {
			const c = (m as { content?: unknown }).content;
			if (typeof c === "string") return c;
			if (Array.isArray(c)) {
				return c
					.filter((b: unknown) => b && typeof b === "object" && "text" in (b as Record<string, unknown>))
					.map((b: unknown) => (b as { text: string }).text)
					.join("\n");
			}
			return "";
		})
		.join("\n")
		.trim();
}

/**
 * Extract tool call info (path + full arguments) from the tool_use block
 * that matches a tool result. Walks the turn's assistant messages.
 */
export function extractToolCallInfo(
	turn: Turn,
	toolCallId: string | undefined,
): { path?: string; args: Record<string, unknown> } {
	const empty = { args: {} };
	if (!toolCallId) return empty;
	for (const msg of turn.messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "toolCall" && block.id === toolCallId) {
				const args = (block.arguments as Record<string, unknown> | undefined) ?? {};
				const path = typeof args.path === "string" ? args.path : undefined;
				return { path, args };
			}
		}
	}
	return empty;
}

/**
 * Result of content replacement for a single turn.
 * Tracks whether any message was compressed via a codec.
 */
interface ContentReplacementResult {
	turn: Turn;
	codecUsed: boolean;
}

/**
 * Update the read history after processing a tool result.
 * Only tracks file reads (proxy_read/read). Uses contentHash for fast content identity.
 */
export function updateReadHistory(
	history: Map<string, FileReadEntry>,
	msg: ToolResultMessage,
	turnIndex: number,
	toolCallPath?: string,
): void {
	if (!isReadTool(msg.toolName)) return;

	const filePath = toolCallPath;
	if (!filePath) return;

	const text = extractText(msg);
	if (!text) return;

	const hash = contentHash(text);
	const existing = history.get(filePath);
	// Only update history when content is new or changed.
	// When content is unchanged (dedup case), keep the original turn index
	// so back-references point to the first read, not a dedup'd intermediate.
	if (!existing || existing.contentHash !== hash) {
		history.set(filePath, { turnIndex, contentHash: hash });
	}
}

/**
 * Update read history from a turn's messages without modifying content.
 * Used for hot-window turns that are kept verbatim but whose reads
 * should be tracked for dedup detection in future transform passes.
 */
function updateReadHistoryForTurn(turn: Turn, history: Map<string, FileReadEntry>, turnIndex: number): void {
	for (const msg of turn.messages) {
		if (msg.role !== "toolResult") continue;
		const { path: toolCallPath } = extractToolCallInfo(turn, msg.toolCallId);
		updateReadHistory(history, msg, turnIndex, toolCallPath);
	}
}

/**
 * Compute working-set exemptions: turns whose tool results stay verbatim
 * beyond the hot window because the model has demonstrated active use of a
 * file (repeated unchanged re-reads).
 *
 * The pinned turn is the *canonical first read* of the current content
 * version — the same turn dedup back-references point to — so refs resolve
 * to full content instead of a codec skeleton, and the pinned turn never
 * changes representation while pinned (cache-stable).
 *
 * Pure function of the turn sequence: deterministic per request, replayable.
 * Granularity is whole turns (pairing invariant); a pinned turn keeps all of
 * its tool results verbatim.
 */
function computeWorkingSetExemptions(
	turns: Turn[],
	hotWindowStart: number,
	evictAfterTurns: number,
	tokenCap: number,
): Set<number> {
	interface VersionTrack {
		path: string;
		/** Read view identity: path + range args. Same view + different content = proof of change. */
		viewKey: string;
		/** Turn of the first read of this content version (the canonical copy). */
		canonicalTurn: number;
		/** Re-reads of this exact content version. */
		rereads: number;
		lastTouchTurn: number;
	}
	// Keyed by path + content hash: each content version tracks independently,
	// so interleaved reads of other ranges/versions (pagination) do not reset
	// pin candidacy. Mirrors dedup semantics (readHistory keys on content).
	const tracks = new Map<string, VersionTrack>();
	for (let idx = 0; idx < turns.length; idx++) {
		const turn = turns[idx];
		if (!turn.hasToolResults) continue;
		for (const msg of turn.messages) {
			if (msg.role !== "toolResult") continue;
			const { path, args: callArgs } = extractToolCallInfo(turn, msg.toolCallId);
			if (!path) continue;
			const text = extractText(msg);
			if (!text) continue;
			const args = callArgs as { offset?: unknown; limit?: unknown };
			const viewKey = `${path}\u0000${args.offset ?? ""}\u0000${args.limit ?? ""}`;
			const key = `${viewKey}\u0000${contentHash(text)}`;
			const track = tracks.get(key);
			if (track) {
				track.rereads++;
				track.lastTouchTurn = idx;
			} else {
				tracks.set(key, { path, viewKey, canonicalTurn: idx, rereads: 0, lastTouchTurn: idx });
			}
		}
	}
	const latestTurn = turns.length - 1;
	// Supersession: a version is provably stale when the *same view* (path +
	// range args) was re-read with different content after its last touch
	// (e.g. re-read after an edit). Different ranges of a file stay independent
	// (pagination); unproven staleness is handled by age-out instead.
	const latestViewTouch = new Map<string, number>();
	for (const track of tracks.values()) {
		const prev = latestViewTouch.get(track.viewKey) ?? -1;
		if (track.lastTouchTurn > prev) latestViewTouch.set(track.viewKey, track.lastTouchTurn);
	}
	const qualifying = [...tracks.values()]
		.filter(
			(t) =>
				t.rereads >= 2 &&
				latestTurn - t.lastTouchTurn <= evictAfterTurns &&
				t.canonicalTurn < hotWindowStart &&
				t.lastTouchTurn >= (latestViewTouch.get(t.viewKey) ?? 0),
		)
		.sort((a, b) => b.lastTouchTurn - a.lastTouchTurn);
	const exempt = new Set<number>();
	const pinnedPaths = new Set<string>();
	let pinnedTokens = 0;
	for (const track of qualifying) {
		// One version per path: most recently touched wins (stale versions age out).
		if (pinnedPaths.has(track.path)) continue;
		if (exempt.has(track.canonicalTurn)) {
			pinnedPaths.add(track.path);
			continue;
		}
		const tokens = estimateTurnTokens(turns[track.canonicalTurn]);
		if (pinnedTokens + tokens > tokenCap && exempt.size > 0) break;
		pinnedTokens += tokens;
		exempt.add(track.canonicalTurn);
		pinnedPaths.add(track.path);
	}
	return exempt;
}

/**
 * Replace tool_result content in a turn, trying codecs first.
 *
 * For each tool_result message:
 *   1. Try codecs in registry order. First match + successful encode wins.
 *   2. If no codec matches, fall back to the default stub.
 *
 * After processing, updates `readHistory` with any file reads found in this turn
 * (for dedup detection in subsequent turns).
 *
 * Returns the replacement turn and whether any codec was used.
 */
function replaceToolResultContent(
	turn: Turn,
	options: Pick<MessageTransformOptions, "resolveToolResultStub" | "codecs">,
	sourceTags: string[],
	turnIndex: number,
	readHistory: Map<string, FileReadEntry>,
): ContentReplacementResult {
	if (!turn.hasToolResults) return { turn, codecUsed: false };

	const codecs = options.codecs ?? [];
	let codecUsed = false;

	const replaced = turn.messages.map((msg): AgentMessage => {
		if (msg.role !== "toolResult") return msg;

		// Build codec context for this message
		const { path: toolCallPath, args: toolCallArgs } = extractToolCallInfo(turn, msg.toolCallId);
		const ctx: CodecContext = {
			sourceTags,
			toolName: msg.toolName,
			toolCallPath,
			toolCallArgs,
			turnIndex,
			readHistory,
		};

		// Try codecs first
		let result: ToolResultMessage | undefined;
		if (codecs.length > 0) {
			const encoded = tryCodecEncode(msg, codecs, ctx);
			if (encoded) {
				codecUsed = true;
				result = { ...msg, content: encoded, details: undefined } as ToolResultMessage;
			}
		}

		// Fall back to stub
		if (!result) {
			const pointer = options.resolveToolResultStub?.(msg) ?? null;
			const stubText = formatStubText(sourceTags, pointer, msg.toolName);
			const stubContent: TextContent[] = [{ type: "text", text: stubText }];
			result = { ...msg, content: stubContent, details: undefined } as ToolResultMessage;
		}

		// Update read history for dedup detection in subsequent turns.
		// Track all reads (even those that were dedup'd or stubbed) so future
		// turns can detect unchanged content.
		updateReadHistory(readHistory, msg, turnIndex, toolCallPath);

		return result;
	});

	return {
		turn: { messages: replaced, hasToolResults: turn.hasToolResults },
		codecUsed,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget bounding
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estimate token count for a turn's messages.
 */
function estimateTurnTokens(turn: Turn): number {
	return estimateMessageTokens(turn.messages);
}

/**
 * Drop oldest turns (preserving the hot window) until the total fits budget.
 *
 * Turns are removed from the front (oldest). The hot window at the end is
 * never dropped — if the hot window alone exceeds the budget, we keep it
 * anyway (the LLM needs recent context to function).
 *
 * Returns the number of turns dropped from the front.
 */
function computeBudgetDropCount(tokenCounts: number[], maxTokens: number, hotWindowSize: number): number {
	if (tokenCounts.length === 0) return 0;

	// The hot window is always preserved
	const hotWindowStart = Math.max(0, tokenCounts.length - hotWindowSize);

	// Sum total tokens from precomputed counts
	let totalTokens = 0;
	for (const count of tokenCounts) {
		totalTokens += count;
	}

	if (totalTokens <= maxTokens) return 0;

	// Drop oldest turns until we fit
	let dropUntil = 0;
	while (dropUntil < hotWindowStart && totalTokens > maxTokens) {
		totalTokens -= tokenCounts[dropUntil];
		dropUntil++;
	}

	return dropUntil;
}

// ═══════════════════════════════════════════════════════════════════════════
// Conversation compression (non-tool turns)
// ═══════════════════════════════════════════════════════════════════════════

/** Cosine similarity baseline. Turns with similarity above the effective threshold are kept verbatim. */
const BASE_RELEVANCE_THRESHOLD = 0.3;

/** How aggressively the threshold drops with age. 0.5 means the oldest turn's threshold is half the base. */
const RELEVANCE_DECAY_FACTOR = 0.5;

/** Estimated token count below which non-tool turns are kept verbatim regardless of relevance. */
const CONVERSATION_VERBATIM_TOKEN_THRESHOLD = 50;

/**
 * Determine whether a non-tool turn should be compressed based on semantic relevance.
 *
 * Uses an age-decayed threshold: older turns need LESS similarity to survive,
 * accounting for foundational context that may have seeded the current work stream.
 *
 * Returns `true` if the turn should be compressed.
 */
function shouldCompressConversationTurn(
	turnIndex: number,
	totalTurns: number,
	turnTokens: number,
	turn: Turn,
	relevanceScores: Map<number, number> | undefined,
): boolean {
	// Developer messages beyond hot window are handled separately (dropped).
	// This function only evaluates user/assistant conversation turns.
	const role = turn.messages[0]?.role;
	if (role === "developer") return false;

	// Short messages: always keep verbatim (cheap to keep, risky to classify)
	if (turnTokens <= CONVERSATION_VERBATIM_TOKEN_THRESHOLD) return false;

	// No relevance data: keep verbatim (safe default)
	if (!relevanceScores || relevanceScores.size === 0) return false;

	// Look up pre-computed similarity. Missing = no embedding = keep.
	const similarity = relevanceScores.get(turnIndex);
	if (similarity === undefined) return false;

	// Age-decayed threshold: older turns need less similarity to survive
	const normalizedAge = totalTurns > 1 ? (totalTurns - 1 - turnIndex) / (totalTurns - 1) : 0;
	const effectiveThreshold = BASE_RELEVANCE_THRESHOLD * (1 - RELEVANCE_DECAY_FACTOR * normalizedAge);

	return similarity <= effectiveThreshold;
}

/**
 * If buildPeek actually truncated the content, replace the generic
 * `[... N lines omitted]` marker with a tagged version that tells
 * the LLM the content is recoverable via the recall tool.
 */
function tagCompressedPeek(peek: string, originalLineCount: number): string {
	if (originalLineCount <= VERBATIM_LINE_THRESHOLD) return peek;
	return peek.replace(
		/\[\.\.\. (\d+) lines omitted\]/,
		"[... $1 lines compressed — use recall(query=<text from above>) to expand]",
	);
}

/**
 * Compress a non-tool turn's messages using head+tail peek.
 *
 * Replaces text content in each message with a truncated version.
 * The full content remains in LanceDB (stored by IngestPipeline) and
 * can be recovered via the recall tool's semantic search.
 * Returns a new Turn with compressed messages.
 */
function compressConversationTurn(turn: Turn): { turn: Turn; tokensAfter: number } {
	const compressedMessages = turn.messages.map((msg): AgentMessage => {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			const lines = content.split("\n");
			const peek = buildPeek(lines, lines.length);
			const tagged = tagCompressedPeek(peek, lines.length);
			return { ...msg, content: tagged } as AgentMessage;
		}
		if (Array.isArray(content)) {
			const newContent = content.map((block: unknown) => {
				if (
					block &&
					typeof block === "object" &&
					"type" in block &&
					(block as { type: string }).type === "text" &&
					"text" in block
				) {
					const text = (block as { text: string }).text;
					const lines = text.split("\n");
					const peek = buildPeek(lines, lines.length);
					const tagged = tagCompressedPeek(peek, lines.length);
					return { ...block, text: tagged };
				}
				return block;
			});
			return { ...msg, content: newContent } as AgentMessage;
		}
		return msg;
	});

	const compressedTurn: Turn = {
		...turn,
		messages: compressedMessages,
	};
	return { turn: compressedTurn, tokensAfter: estimateTurnTokens(compressedTurn) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main transform
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Transform a flat message array by:
 *   1. Segmenting into turns.
 *   2. Keeping the last `hotWindowTurns` verbatim.
 *   3. Replacing tool_result content in older turns with stubs.
 *   4. Bounding total tokens by dropping oldest turns.
 *
 * Returns a {@link TransformResult} containing both the transformed messages
 * and structured decision metadata for each turn.
 *
 * The assembled context (developer message) should be prepended by the
 * caller after this transform.
 *
 * @param messages - Full conversation message array.
 * @param options  - Transform configuration.
 * @returns Transformed messages and per-turn decision metadata.
 */
export function transformMessages(messages: AgentMessage[], options: MessageTransformOptions = {}): TransformResult {
	if (messages.length === 0) {
		return {
			messages: [],
			metadata: {
				decisions: [],
				totalTurns: 0,
				keptCount: 0,
				stubbedCount: 0,
				compressedCount: 0,
				droppedCount: 0,
				tokensBefore: 0,
				tokensAfter: 0,
				scoredCount: 0,
			},
		};
	}

	const hotWindowTurns = Math.max(0, Math.floor(options.hotWindowTurns ?? DEFAULT_HOT_WINDOW_TURNS));

	// 1. Segment into turns
	const originalTurns = segmentIntoTurns(messages);
	const totalTurns = originalTurns.length;

	// Developer message dedup, scanning newest → oldest.
	// Two categories:
	//   1. Regenerated per-turn (assembly summary, hydrated context): identified by
	//      structural prefix. Keep only the latest of each type.
	//   2. One-time injections (checkpoint reminders, synthetic prompts): identified
	//      by content hash. Keep unique content, drop exact duplicates.
	const REGENERATED_PREFIXES = ["[Assembly:", "<recalled-context"];
	const seenRegeneratedTypes = new Set<string>();
	const seenDeveloperHashes = new Set<number>();
	const developerTurnKeep = new Set<number>();
	for (let i = totalTurns - 1; i >= 0; i--) {
		if (originalTurns[i].hasToolResults) continue;
		if (originalTurns[i].messages[0]?.role !== "developer") continue;
		const text = extractDeveloperText(originalTurns[i]);
		// Check if this is a regenerated type (prefix match)
		const matchedPrefix = REGENERATED_PREFIXES.find(p => text.startsWith(p));
		if (matchedPrefix) {
			// Keep only the latest instance of each regenerated type
			if (seenRegeneratedTypes.has(matchedPrefix)) continue;
			seenRegeneratedTypes.add(matchedPrefix);
		} else {
			// One-time injection: keep if content is unique
			const hash = contentHash(text);
			if (seenDeveloperHashes.has(hash)) continue;
			seenDeveloperHashes.add(hash);
		}
		developerTurnKeep.add(i);
	}

	// Pre-compute original token costs per turn
	const originalTokens = originalTurns.map(estimateTurnTokens);

	// 2. Apply content replacement beyond hot window (codec-aware)
	//    Build read history incrementally for dedup detection across turns.
	const hotWindowStart = Math.max(0, totalTurns - hotWindowTurns);
	const readHistory = new Map<string, FileReadEntry>();

	const workingSetExemptions =
		options.workingSet?.enabled === true
			? computeWorkingSetExemptions(
					originalTurns,
					hotWindowStart,
					options.workingSet.evictAfterTurns ?? DEFAULT_WORKING_SET_EVICT_TURNS,
					options.workingSet.tokenCap ?? DEFAULT_WORKING_SET_TOKEN_CAP,
				)
			: undefined;

	const replacementResults: ContentReplacementResult[] = [];
	for (let idx = 0; idx < totalTurns; idx++) {
		const turn = originalTurns[idx];
		if (idx >= hotWindowStart || workingSetExemptions?.has(idx) === true) {
			// Hot window or working-set pin: keep verbatim, but still update
			// history so later re-reads dedup against the canonical copy.
			updateReadHistoryForTurn(turn, readHistory, idx);
			replacementResults.push({ turn, codecUsed: false });
		} else {
			const tags = extractSourceTags(turn.messages);
			replacementResults.push(replaceToolResultContent(turn, options, tags, idx, readHistory));
		}
	}

	const transformedTurns = replacementResults.map(r => r.turn);

	// Pre-compute transformed token costs (only differs from original for stubbed turns)
	const transformedTokens = transformedTurns.map(estimateTurnTokens);

	// 3. Apply budget bounding if configured
	const maxTokens = options.maxTokens;
	const hasBudget = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens >= 0;
	let dropCount = 0;
	if (hasBudget) {
		dropCount = computeBudgetDropCount(transformedTokens, maxTokens, hotWindowTurns);
	}

	// 3b. Ensure surviving messages start with a user turn (Claude API requirement).
	// When budget drops remove a user turn at the front, the next surviving turn
	// may be an assistant turn. Extend drops until a user turn is at the front.
	// First pass: bounded by hotWindowStart (preserve hot window when possible).
	// Fallback: if the hot window itself starts with a non-user turn, extend into
	// it — the API constraint is harder than the hot-window preservation guarantee.
	if (dropCount > 0) {
		while (dropCount < hotWindowStart && transformedTurns[dropCount].messages[0].role !== "user") {
			dropCount++;
		}
		// Fallback: hot-window boundary reached but first surviving turn is still non-user
		while (dropCount < transformedTurns.length && transformedTurns[dropCount].messages[0].role !== "user") {
			dropCount++;
		}
	}

	// 4. Build per-turn decision records
	const decisions: TurnDecision[] = [];
	let keptCount = 0;
	let stubbedCount = 0;
	let compressedCount = 0;
	let droppedCount = 0;
	let totalTokensBefore = 0;
	let totalTokensAfter = 0;
	let scoredCount = 0;
	let simMin = Infinity;
	let simMax = -Infinity;

	for (let i = 0; i < totalTurns; i++) {
		const tokensBefore = originalTokens[i];
		totalTokensBefore += tokensBefore;

		const sourceTags = extractSourceTags(originalTurns[i].messages);

		if (i < dropCount) {
			// Dropped for budget
			decisions.push({
				turnIndex: i,
				action: "dropped",
				reason: "budget-exceeded",
				messageCount: originalTurns[i].messages.length,
				hasToolResults: originalTurns[i].hasToolResults,
				tokensBefore,
				tokensAfter: 0,
				sourceTags,
			});
			droppedCount++;
		} else if (i >= hotWindowStart) {
			// Hot window: kept verbatim
			decisions.push({
				turnIndex: i,
				action: "kept",
				reason: "hot-window",
				messageCount: originalTurns[i].messages.length,
				hasToolResults: originalTurns[i].hasToolResults,
				tokensBefore,
				tokensAfter: tokensBefore,
				sourceTags,
			});
			totalTokensAfter += tokensBefore;
			keptCount++;
		} else if (originalTurns[i].hasToolResults) {
			// Beyond hot window with tool results: pinned (working set), compressed, or stubbed
			const tokensAfter = transformedTokens[i];
			if (workingSetExemptions?.has(i) === true) {
				decisions.push({
					turnIndex: i,
					action: "kept",
					reason: "working-set",
					messageCount: originalTurns[i].messages.length,
					hasToolResults: true,
					tokensBefore,
					tokensAfter,
					sourceTags,
				});
				totalTokensAfter += tokensAfter;
				keptCount++;
			} else {
				const wasCompressed = replacementResults[i].codecUsed;
				decisions.push({
					turnIndex: i,
					action: wasCompressed ? "compressed" : "stubbed",
					reason: wasCompressed ? "codec-compressed" : "beyond-hot-window",
					messageCount: originalTurns[i].messages.length,
					hasToolResults: true,
					tokensBefore,
					tokensAfter,
					sourceTags,
				});
				totalTokensAfter += tokensAfter;
				if (wasCompressed) compressedCount++;
				else stubbedCount++;
			}
		} else {
			// Beyond hot window, no tool results.
			const role = originalTurns[i].messages[0]?.role;

			if (role === "developer") {
				if (developerTurnKeep.has(i)) {
					// Unique developer content (one-time injection): keep it
					decisions.push({
						turnIndex: i,
						action: "kept",
						reason: "no-tool-results",
						messageCount: originalTurns[i].messages.length,
						hasToolResults: false,
						tokensBefore,
						tokensAfter: tokensBefore,
						sourceTags,
					});
					totalTokensAfter += tokensBefore;
					keptCount++;
				} else {
					// Duplicate developer content (newer copy exists): drop
					decisions.push({
						turnIndex: i,
						action: "dropped",
						reason: "developer-dropped",
						messageCount: originalTurns[i].messages.length,
						hasToolResults: false,
						tokensBefore,
						tokensAfter: 0,
						sourceTags,
					});
					droppedCount++;
				}
			} else {
				// User/assistant conversation turn: check semantic relevance for compression
				const compress = shouldCompressConversationTurn(
					i,
					totalTurns,
					tokensBefore,
					originalTurns[i],
					options.relevanceScores,
				);
				// Track relevance scoring stats
				const sim = options.relevanceScores?.get(i);
				if (sim !== undefined) {
					scoredCount++;
					if (sim < simMin) simMin = sim;
					if (sim > simMax) simMax = sim;
				}
				if (compress) {
					const result = compressConversationTurn(transformedTurns[i]);
					transformedTurns[i] = result.turn;
					transformedTokens[i] = result.tokensAfter;
					decisions.push({
						turnIndex: i,
						action: "compressed",
						reason: "conversation-compressed",
						messageCount: originalTurns[i].messages.length,
						hasToolResults: false,
						tokensBefore,
						tokensAfter: result.tokensAfter,
						sourceTags,
					});
					totalTokensAfter += result.tokensAfter;
					compressedCount++;
				} else {
					decisions.push({
						turnIndex: i,
						action: "kept",
						reason: "no-tool-results",
						messageCount: originalTurns[i].messages.length,
						hasToolResults: false,
						tokensBefore,
						tokensAfter: tokensBefore,
						sourceTags,
					});
					totalTokensAfter += tokensBefore;
					keptCount++;
				}
			}
		}
	}

	// 5. Flatten surviving turns to message array, excluding budget-dropped and developer-dropped turns
	const survivingTurns: Turn[] = [];
	for (let i = 0; i < transformedTurns.length; i++) {
		if (i < dropCount) continue; // budget-dropped
		const decision = decisions[i];
		if (decision && decision.reason === "developer-dropped") continue;
		survivingTurns.push(transformedTurns[i]);
	}
	const resultMessages = survivingTurns.flatMap(t => t.messages);

	return {
		messages: resultMessages,
		metadata: {
			decisions,
			totalTurns,
			keptCount,
			stubbedCount,
			compressedCount,
			droppedCount,
			tokensBefore: totalTokensBefore,
			tokensAfter: totalTokensAfter,
			scoredCount,
			similarityRange: scoredCount > 0 ? { min: simMin, max: simMax } : undefined,
		},
	};
}
