/**
 * Kernel-internal types for the local assembler.
 */

/**
 * Input for deriving the assembler budget from model context window.
 *
 * Budget decomposition:
 *   available = contextWindow - systemPromptTokens - toolDefinitionTokens - currentTurnTokens - safetyReserve
 *
 * Fixed costs (measured per turn via chars/4 heuristic):
 *   - System prompt          (~5-15K tokens)
 *   - Tool definitions       (~10-20K tokens)
 *
 * Variable costs (measured per turn):
 *   - Current-turn messages   (variable)
 *
 * Available for assembler:
 *   - Previous-turn management
 *   - Hydrated fragments
 *   - Working memory
 */
export interface BudgetDerivationInput {
	/** Model's total context window in tokens. */
	contextWindow: number;
	/** Estimated tokens consumed by the system prompt. */
	systemPromptTokens: number;
	/** Estimated tokens consumed by tool definitions (JSON schema). */
	toolDefinitionTokens: number;
	/**
	 * Reserved token overhead for current-turn content not managed by the message
	 * transform (e.g., injected fragments). The message array — including the current
	 * turn — is bounded separately by transformMessages. Pass 0 unless reserving
	 * space for content injected outside the message array.
	 *
	 * For dynamic per-turn content, use turnBufferPercent instead (reserves a
	 * percentage of context window for current turn).
	 */
	currentTurnTokens: number;
	turnBufferPercent?: number;
	safetyMarginPercent?: number;
	/** Guaranteed minimum percentage of allocatable budget for messages (0-100, default: 50). */
	messageBudgetPercent?: number;
	/** Hard cap on hydration as percentage of allocatable budget (0-100, default: 50). */
	hydrationBudgetPercent?: number;
}

/** Entry in the per-file read history, tracking content identity across turns. */
export interface FileReadEntry {
	/** Turn index where this file was first read (or last changed). */
	turnIndex: number;
	/** Hash of the tool result content for identity comparison. */
	contentHash: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Content codecs for signal-only context compression
// ═══════════════════════════════════════════════════════════════════════════

import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { MemoryLocatorEntry } from "../memory-contract";

/**
 * Metadata passed to content codecs during the encoding phase.
 *
 * Carries provenance tags (what tool produced this result) and the
 * optional locator entry (where the original content is stored).
 */
export interface CodecContext {
	/** Source provenance tags for this turn (e.g. "tool:read", "mcp:rna-server"). */
	sourceTags: string[];
	/** Locator metadata for the tool result, if available. */
	locator?: MemoryLocatorEntry;
	/** Tool name from the original tool result message. */
	toolName?: string;
	/** Index of this turn in the conversation (0-based). */
	turnIndex: number;
	/**
	 * History of file reads processed so far in this transform pass.
	 * Keyed by file path → { turnIndex where first seen, content hash }.
	 * Built incrementally by the transform loop; codecs read but do not mutate.
	 */
	readHistory?: ReadonlyMap<string, FileReadEntry>;
}

/**
 * A content codec that produces a warm representation of a tool result.
 *
 * Codecs are deterministic, structural transformers — no model in the loop.
 * Each codec declares what content types it handles (via `matches`) and
 * produces a compact representation that preserves all actionable information
 * for the model (via `encode`).
 *
 * Codecs are tried in registry order. First match wins. If no codec matches
 * or encode returns null, the default stub fallback is used.
 */
export interface ContentCodec {
	/** Human-readable name for observability/debugging. */
	name: string;

	/** Does this codec handle this content? */
	matches(message: ToolResultMessage, ctx: CodecContext): boolean;

	/**
	 * Produce a warm representation of the tool result content.
	 * Returns null to fall back to the next codec or default stub.
	 */
	encode(message: ToolResultMessage, ctx: CodecContext): TextContent[] | null;
}
