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
import type { MemoryAssemblyBudget, MemoryLocatorEntry } from "../memory-contract";
import type { BudgetDerivationInput, CodecContext, ContentCodec, FileReadEntry } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Token estimation & budget derivation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract source provenance tags from messages in a turn.
 * For tool_result messages, derives the source from toolName.
 * MCP tools get "mcp:serverName", builtins get "tool:toolName".
 */
function extractSourceTags(messages: AgentMessage[]): string[] {
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
	return Math.ceil(chars / 4);
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
export function deriveBudget(input: BudgetDerivationInput): MemoryAssemblyBudget {
	const safetyPercent = input.safetyMarginPercent ?? DEFAULT_SAFETY_MARGIN_PERCENT;
	const messagePercent = input.messageBudgetPercent ?? DEFAULT_MESSAGE_BUDGET_PERCENT;
	const turnBufferPercent = input.turnBufferPercent ?? DEFAULT_TURN_BUFFER_PERCENT;
	const hydrationPercent = input.hydrationBudgetPercent ?? DEFAULT_HYDRATION_BUDGET_PERCENT;
	const turnBuffer = Math.floor((input.contextWindow * turnBufferPercent) / 100);
	const totalCosts = input.systemPromptTokens + input.toolDefinitionTokens + input.currentTurnTokens;
	const safetyReserve = Math.floor((input.contextWindow * safetyPercent) / 100);
	const allocatable = Math.max(0, input.contextWindow - totalCosts - safetyReserve - turnBuffer);

	// Warn when fixed costs dominate and the allocatable budget is critically low.
	// Threshold: less than 10% of the context window is available for messages + hydration.
	if (input.contextWindow > 0 && allocatable < input.contextWindow * 0.1) {
		logger.warn("Budget critically low: fixed costs dominate context window", {
			contextWindow: input.contextWindow,
			totalCosts,
			safetyReserve,
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
	 * Resolve locator metadata for a tool result message.
	 * Used to provide codec context (file path, params, etc).
	 */
	resolveLocator?: (message: ToolResultMessage) => MemoryLocatorEntry | undefined;

	/**
	 * Maximum token budget for the output message array.
	 * When set, oldest turns are dropped (as complete groups) until
	 * the estimated token count fits. Omit to skip budget bounding.
	 */
	maxTokens?: number;
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
	 *   - `"budget-exceeded"`   — dropped to fit the token budget.
	 */
	reason: "hot-window" | "no-tool-results" | "beyond-hot-window" | "codec-compressed" | "budget-exceeded";

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
		if (codec.matches(msg, ctx)) {
			const encoded = codec.encode(msg, ctx);
			if (encoded) return encoded;
		}
	}
	return null;
}

/**
 * Result of content replacement for a single turn.
 * Tracks whether any message was compressed via a codec.
 */
interface ContentReplacementResult {
	turn: Turn;
	codecUsed: boolean;
}

/** Read tool names for history tracking. */
const READ_TOOL_NAMES_SET = new Set(["proxy_read", "read"]);

/**
 * Update the read history after processing a tool result.
 * Only tracks file reads (proxy_read/read). Uses Bun.hash for fast content identity.
 */
function updateReadHistory(
	history: Map<string, FileReadEntry>,
	msg: ToolResultMessage,
	locator: MemoryLocatorEntry | undefined,
	turnIndex: number,
): void {
	const toolName = msg.toolName;
	if (!toolName) return;
	const baseName = toolName.replace(/^proxy_/, "");
	if (!READ_TOOL_NAMES_SET.has(baseName) && !READ_TOOL_NAMES_SET.has(toolName)) return;

	const filePath = locator?.where;
	if (!filePath) return;

	// Extract text content for hashing
	const content = msg.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block === "string") text += block;
			else if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block)
				text += block.text;
		}
	}
	if (!text) return;

	history.set(filePath, { turnIndex, contentHash: Bun.hash(text) as number });
}

/**
 * Update read history from a turn's messages without modifying content.
 * Used for hot-window turns that are kept verbatim but whose reads
 * should be tracked for dedup detection in future transform passes.
 */
function updateReadHistoryForTurn(
	turn: Turn,
	history: Map<string, FileReadEntry>,
	turnIndex: number,
	resolveLocator?: (msg: ToolResultMessage) => MemoryLocatorEntry | undefined,
): void {
	for (const msg of turn.messages) {
		if (msg.role !== "toolResult") continue;
		const locator = resolveLocator?.(msg);
		updateReadHistory(history, msg, locator, turnIndex);
	}
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
	options: Pick<MessageTransformOptions, "resolveToolResultStub" | "codecs" | "resolveLocator">,
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
		const locator = options.resolveLocator?.(msg);
		const ctx: CodecContext = {
			sourceTags,
			locator,
			toolName: msg.toolName,
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
		updateReadHistory(readHistory, msg, locator, turnIndex);

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
			},
		};
	}

	const hotWindowTurns = Math.max(0, Math.floor(options.hotWindowTurns ?? DEFAULT_HOT_WINDOW_TURNS));

	// 1. Segment into turns
	const originalTurns = segmentIntoTurns(messages);
	const totalTurns = originalTurns.length;

	// Pre-compute original token costs per turn
	const originalTokens = originalTurns.map(estimateTurnTokens);

	// 2. Apply content replacement beyond hot window (codec-aware)
	//    Build read history incrementally for dedup detection across turns.
	const hotWindowStart = Math.max(0, totalTurns - hotWindowTurns);
	const readHistory = new Map<string, FileReadEntry>();

	const replacementResults: ContentReplacementResult[] = [];
	for (let idx = 0; idx < totalTurns; idx++) {
		const turn = originalTurns[idx];
		if (idx >= hotWindowStart) {
			// Hot window: keep verbatim, but still update history for future passes.
			updateReadHistoryForTurn(turn, readHistory, idx, options.resolveLocator);
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
			// Beyond hot window with tool results: compressed or stubbed
			const tokensAfter = transformedTokens[i];
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
		} else {
			// Beyond hot window, no tool results: kept as-is
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

	// 5. Flatten surviving turns to message array
	const survivingTurns = dropCount > 0 ? transformedTurns.slice(dropCount) : transformedTurns;
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
		},
	};
}
