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
import type { MemoryAssemblyBudget } from "../memory-contract";
import type { BudgetDerivationInput } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Token estimation & budget derivation
// ═══════════════════════════════════════════════════════════════════════════

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
const BUDGET_SAFETY_MARGIN = 0.9;

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

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Default number of recent turns kept verbatim before content replacement. */
export const DEFAULT_HOT_WINDOW_TURNS = 3;

/** Stub text injected into tool_result messages beyond the hot window. */
export const TOOL_RESULT_STUB_TEXT = "[Content available in assembled context]";

export interface MessageTransformOptions {
	/** Number of recent turns to keep verbatim (default: {@link DEFAULT_HOT_WINDOW_TURNS}). */
	hotWindowTurns?: number;

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
export type TurnDecisionAction = "kept" | "stubbed" | "dropped";

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
	 *   - `"budget-exceeded"`   — dropped to fit the token budget.
	 */
	reason: "hot-window" | "no-tool-results" | "beyond-hot-window" | "budget-exceeded";

	/** Number of messages in this turn. */
	messageCount: number;

	/** Whether this turn contains tool_result messages. */
	hasToolResults: boolean;

	/** Estimated tokens before any transformation. */
	tokensBefore: number;

	/** Estimated tokens after transformation (0 if dropped). */
	tokensAfter: number;
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
// Content replacement
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace tool_result content with a stub in a turn's messages.
 *
 * Returns a new array of messages with tool_result content replaced.
 * Assistant messages and other message types are passed through unchanged.
 */
function replaceToolResultContent(turn: Turn): Turn {
	if (!turn.hasToolResults) return turn;

	const replaced = turn.messages.map((msg): AgentMessage => {
		if (msg.role !== "toolResult") return msg;

		const stubContent: TextContent[] = [{ type: "text", text: TOOL_RESULT_STUB_TEXT }];
		return {
			...msg,
			content: stubContent,
			details: undefined,
		} as ToolResultMessage;
	});

	return { messages: replaced, hasToolResults: turn.hasToolResults };
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

	// 2. Apply content replacement beyond hot window
	const hotWindowStart = Math.max(0, totalTurns - hotWindowTurns);

	const transformedTurns = originalTurns.map((turn, idx) => {
		if (idx >= hotWindowStart) return turn; // hot window: keep verbatim
		return replaceToolResultContent(turn);
	});

	// Pre-compute transformed token costs (only differs from original for stubbed turns)
	const transformedTokens = transformedTurns.map(estimateTurnTokens);

	// 3. Apply budget bounding if configured
	const maxTokens = options.maxTokens;
	const hasBudget = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens >= 0;
	let dropCount = 0;
	if (hasBudget) {
		dropCount = computeBudgetDropCount(transformedTokens, maxTokens, hotWindowTurns);
	}

	// 4. Build per-turn decision records
	const decisions: TurnDecision[] = [];
	let keptCount = 0;
	let stubbedCount = 0;
	let droppedCount = 0;
	let totalTokensBefore = 0;
	let totalTokensAfter = 0;

	for (let i = 0; i < totalTurns; i++) {
		const tokensBefore = originalTokens[i];
		totalTokensBefore += tokensBefore;

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
			});
			totalTokensAfter += tokensBefore;
			keptCount++;
		} else if (originalTurns[i].hasToolResults) {
			// Beyond hot window with tool results: stubbed
			const tokensAfter = transformedTokens[i];
			decisions.push({
				turnIndex: i,
				action: "stubbed",
				reason: "beyond-hot-window",
				messageCount: originalTurns[i].messages.length,
				hasToolResults: true,
				tokensBefore,
				tokensAfter,
			});
			totalTokensAfter += tokensAfter;
			stubbedCount++;
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
			droppedCount,
			tokensBefore: totalTokensBefore,
			tokensAfter: totalTokensAfter,
		},
	};
}
