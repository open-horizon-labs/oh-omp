/**
 * Message-level context transformation for the assembler.
 *
 * Segments flat AgentMessage arrays into turns, applies a hot-window policy
 * that preserves recent turns verbatim, replaces tool_result content beyond
 * the window with stubs, and bounds total message tokens within budget.
 *
 * Key invariants (ADR 0004):
 *   - Current-turn tool_result messages are always kept verbatim.
 *   - tool_use / tool_result pairing is never broken.
 *   - Shadow mode passes messages through untouched.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { estimateMessageTokens } from "./kernel";

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
 * Returns the surviving turns.
 */
function boundByBudget(turns: Turn[], maxTokens: number, hotWindowSize: number): Turn[] {
	if (turns.length === 0) return turns;

	// The hot window is always preserved
	const hotWindowStart = Math.max(0, turns.length - hotWindowSize);

	// Estimate total tokens
	let totalTokens = 0;
	for (const turn of turns) {
		totalTokens += estimateTurnTokens(turn);
	}

	if (totalTokens <= maxTokens) return turns;

	// Drop oldest turns until we fit
	let dropUntil = 0;
	while (dropUntil < hotWindowStart && totalTokens > maxTokens) {
		totalTokens -= estimateTurnTokens(turns[dropUntil]);
		dropUntil++;
	}

	return dropUntil > 0 ? turns.slice(dropUntil) : turns;
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
 * The assembled context (developer message) should be prepended by the
 * caller after this transform.
 *
 * @param messages - Full conversation message array.
 * @param options  - Transform configuration.
 * @returns Transformed message array.
 */
export function transformMessages(messages: AgentMessage[], options: MessageTransformOptions = {}): AgentMessage[] {
	if (messages.length === 0) return [];

	const hotWindowTurns = options.hotWindowTurns ?? DEFAULT_HOT_WINDOW_TURNS;

	// 1. Segment into turns
	let turns = segmentIntoTurns(messages);

	// 2. Apply content replacement beyond hot window
	const hotWindowStart = Math.max(0, turns.length - hotWindowTurns);

	turns = turns.map((turn, idx) => {
		if (idx >= hotWindowStart) return turn; // hot window: keep verbatim
		return replaceToolResultContent(turn);
	});

	// 3. Apply budget bounding if configured
	if (options.maxTokens !== undefined) {
		turns = boundByBudget(turns, options.maxTokens, hotWindowTurns);
	}

	// 4. Flatten back to message array
	return turns.flatMap(t => t.messages);
}
