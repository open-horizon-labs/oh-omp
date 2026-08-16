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
import type { DeveloperMessage, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { parseMCPToolName } from "../../mcp/tool-bridge";
import { getLlmMessageRole } from "../../session/messages";
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
/** Fallback cap used only when no proportional budget can be derived. */
const DEFAULT_WORKING_SET_TOKEN_CAP = 16_000;
/**
 * Default share of the assembled message budget available for working-set pins.
 *
 * The cap scales with the budget rather than being fixed, because a fixed ceiling
 * under-serves large context windows: against a 260K budget the previous 16K
 * ceiling admitted a median of one pinned turn, which is smaller than the working
 * set of any cross-file change.
 */
export const DEFAULT_WORKING_SET_TOKEN_CAP_FRACTION = 0.25;

/**
 * Resolve the verbatim working-set budget for a transform.
 *
 * An explicit positive `tokenCap` always wins so deployments can pin an absolute
 * ceiling. Otherwise the cap is a share of `maxTokens`, keeping retention
 * proportional to the window the model actually has. Falls back to
 * {@link DEFAULT_WORKING_SET_TOKEN_CAP} when no usable budget is available.
 */
export function resolveWorkingSetTokenCap(
	options: WorkingSetOptions | undefined,
	maxTokens: number | undefined,
): number {
	const explicit = options?.tokenCap;
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
		return Math.floor(explicit);
	}

	const fraction = options?.tokenCapFraction ?? DEFAULT_WORKING_SET_TOKEN_CAP_FRACTION;
	const usableFraction = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
	if (usableFraction > 0 && typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
		return Math.floor(maxTokens * usableFraction);
	}

	return DEFAULT_WORKING_SET_TOKEN_CAP;
}

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
	 * Values are cosine similarity in [-1, 1]. Used ordinally: lower scores
	 * are less relevant and compress first under budget pressure.
	 */
	relevanceScores?: Map<number, number>;

	/** Stable turn keys previously conversation-compressed; those turns stay compressed. */
	stickyCompressedKeys?: ReadonlySet<number>;

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
	/**
	 * Absolute cap on estimated tokens held verbatim by pinned turns.
	 *
	 * A positive value always wins. Leave unset (or `0`) to derive the cap from
	 * {@link WorkingSetOptions.tokenCapFraction} instead.
	 */
	tokenCap?: number;
	/**
	 * Share of the assembled message budget available for pinned turns when no
	 * absolute {@link WorkingSetOptions.tokenCap} is given
	 * (default {@link DEFAULT_WORKING_SET_TOKEN_CAP_FRACTION}).
	 */
	tokenCapFraction?: number;
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
	 *   - `"recovery-excluded"` — omitted by the terminal user-led recovery fallback.
	 *   - `"recovery-anchor-truncated"` — user anchor text bounded by terminal recovery.
	 *   - `"overflow-summarized"` — older post-user execution replaced by an overflow checkpoint.
	 *   - `"overflow-pre-anchor"` — history before the latest user anchor omitted by overflow assembly.
	 *   - `"hot-window-oversize-compressed"` — an oversized hot tool result codec-compressed in place.
	 */
	reason:
		| "hot-window"
		| "no-tool-results"
		| "beyond-hot-window"
		| "codec-compressed"
		| "working-set"
		| "budget-exceeded"
		| "conversation-compressed"
		| "developer-dropped"
		| "recovery-excluded"
		| "recovery-anchor-truncated"
		| "overflow-summarized"
		| "overflow-pre-anchor"
		| "hot-window-oversize-compressed";

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

	/** Stable keys for turns conversation-compressed in this pass. */
	conversationCompressedKeys: number[];

	/** Budget-elision tombstone emitted for front-dropped turns. */
	elided?: { turnCount: number; tokens: number };

	/** Emergency recovery applied after the normal bounded transform produced no valid user-led context. */
	recovery?: TransformRecoveryMetadata;

	/** Historical overflow summarization applied before terminal recovery. */
	overflowSummary?: TransformOverflowSummaryMetadata;
}

export interface TransformOverflowSummaryMetadata {
	trigger: "latest-user-boundary";
	outcome: "generated" | "reused" | "failed";
	generation: number;
	model?: string;
	sourceTurnCount: number;
	newlySummarizedTurnCount: number;
	tailTurnCount: number;
	outputMessageCount: number;
	outputTokens: number;
	summaryTokens: number;
	inputTokens: number;
	durationMs: number;
	attempts: number;
	lowWatermarkTokens: number;
	hotWindowCompressedCount: number;
	failureReason?:
		| "no-summarizable-history"
		| "protected-hot-window-exceeds-budget"
		| "no-authenticated-model"
		| "model-context-too-small"
		| "generation-failed"
		| "empty-summary"
		| "summary-exceeds-budget"
		| "retry-deferred-no-progress";
}

/** Metadata describing a bounded retry after normal context selection failed. */
export interface TransformRecoveryMetadata {
	trigger: "empty-selection";
	outcome: "recovered" | "unrecoverable";
	attempts: number;
	originalTurnCount: number;
	selectedOriginalTurnIndexes: number[];
	outputMessageCount: number;
	outputTokens: number;
	anchorTruncated: boolean;
	controlPrompt: "standard" | "truncated" | "omitted";
	unrecoverableAnchorReason?:
		| "non-text-anchor-exceeds-budget"
		| "text-anchor-exceeds-recoverable-budget"
		| "zero-token-budget";
	initial: {
		outputMessageCount: number;
		keptCount: number;
		stubbedCount: number;
		compressedCount: number;
		droppedCount: number;
		tokensAfter: number;
	};
}

/** Token reservations for optional developer guidance appended after recovery. */
export interface TransformRecoveryOptions {
	standardControlPromptTokens?: number;
	truncatedControlPromptTokens?: number;
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

function startsWithCanonicalLlmUser(messages: AgentMessage[]): boolean {
	for (const message of messages) {
		const role = getLlmMessageRole(message);
		if (role === undefined || role === "developer") continue;
		return role === "user";
	}
	return false;
}

function findLatestLiteralUserTurn(turns: Turn[]): number {
	for (let index = turns.length - 1; index >= 0; index--) {
		if (turns[index].messages[0]?.role === "user") return index;
	}
	return -1;
}

/**
 * Validate a bounded result at the AgentMessage-to-LLM boundary.
 *
 * Canonically user-role synthetic messages may satisfy provider ordering, but
 * they cannot replace the latest literal user intent boundary.
 *
 * Requires a result produced by passing exactly sourceMessages to
 * transformMessages: decisions are a dense parallel array over those messages'
 * segmented turns.
 */
export function isValidBoundedTransform(sourceMessages: AgentMessage[], result: TransformResult): boolean {
	if (!startsWithCanonicalLlmUser(result.messages)) return false;

	const latestUserTurn = findLatestLiteralUserTurn(segmentIntoTurns(sourceMessages));
	if (latestUserTurn < 0) return true;

	const decision = result.metadata.decisions[latestUserTurn];
	return decision !== undefined && decision.action !== "dropped";
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
/** Tools whose calls mutate a file at `args.path`/`args.notebook_path`. */
const MUTATING_TOOL_NAMES = new Set(["edit", "write", "ast_edit", "notebook", "apply_patch"]);

/**
 * Collect paths mutated in-session: path → turn index of the last observed
 * mutating tool call. Pure transcript signal (external changes invisible);
 * used by codecs to flag provably stale read stubs.
 */
function collectMutatedPaths(turns: Turn[]): Map<string, number> {
	const mutated = new Map<string, number>();
	for (let idx = 0; idx < turns.length; idx++) {
		for (const msg of turns[idx].messages) {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (typeof block !== "object" || block === null) continue;
				const b = block as { type?: string; name?: string; arguments?: unknown };
				if (b.type !== "toolCall" || !b.name || !MUTATING_TOOL_NAMES.has(b.name)) continue;
				const args = (b.arguments ?? {}) as { path?: unknown; notebook_path?: unknown };
				const path =
					typeof args.path === "string"
						? args.path
						: typeof args.notebook_path === "string"
							? args.notebook_path
							: undefined;
				if (path !== undefined) mutated.set(path, idx);
			}
		}
	}
	return mutated;
}

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
			t =>
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
	mutatedPaths: ReadonlyMap<string, number>,
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
			mutatedPaths,
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
function computeBudgetDropCount(
	tokenCounts: number[],
	maxTokens: number,
	hotWindowSize: number,
	targetTokens = maxTokens,
): number {
	if (tokenCounts.length === 0) return 0;

	const hotWindowStart = Math.max(0, tokenCounts.length - hotWindowSize);

	let totalTokens = 0;
	for (const count of tokenCounts) {
		totalTokens += count;
	}

	if (totalTokens <= maxTokens) return 0;

	let dropUntil = 0;
	while (dropUntil < hotWindowStart && totalTokens > targetTokens) {
		totalTokens -= tokenCounts[dropUntil];
		dropUntil++;
	}

	return dropUntil;
}

// ═══════════════════════════════════════════════════════════════════════════
// Conversation compression (non-tool turns)
// ═══════════════════════════════════════════════════════════════════════════

/** Estimated token count below which non-tool turns are kept verbatim regardless of relevance. */
const CONVERSATION_VERBATIM_TOKEN_THRESHOLD = 50;

/** Budget drops and ranked compression aim below the hard cap to avoid per-turn cache churn. */
const BUDGET_DROP_WATERMARK = 0.9;

function extractTurnTextParts(turn: Turn): string[] {
	const parts: string[] = [];
	for (const msg of turn.messages) {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block === "string") {
				parts.push(block);
			} else if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
	}
	return parts;
}

export function computeTurnKey(turn: Turn): number {
	return contentHash(extractTurnTextParts(turn).join("\n"));
}

function isConversationCompressionEligible(
	turnIndex: number,
	turnTokens: number,
	turn: Turn,
	hotWindowStart: number,
	workingSetExemptions: ReadonlySet<number>,
	latestLiteralUserTurn: number,
): boolean {
	if (turnIndex >= hotWindowStart) return false;
	if (turnIndex === latestLiteralUserTurn) return false;
	if (workingSetExemptions.has(turnIndex)) return false;
	if (turn.hasToolResults) return false;
	if (turnTokens <= CONVERSATION_VERBATIM_TOKEN_THRESHOLD) return false;
	const role = turn.messages[0]?.role;
	return role === "user" || role === "assistant";
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

function firstTextLine(turn: Turn): string | null {
	const text = extractTurnTextParts(turn).join("\n").trim();
	if (!text) return null;
	const firstLine = text.split("\n")[0]?.trim();
	if (!firstLine) return null;
	return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

function collectDroppedToolCallPaths(turns: readonly Turn[]): Array<{ path: string; count: number }> {
	const counts = new Map<string, number>();
	for (const turn of turns) {
		for (const msg of turn.messages) {
			const content = (msg as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const candidate = block as { type?: string; name?: string; arguments?: unknown };
				if (candidate.type !== "toolCall" || !candidate.name || !MUTATING_TOOL_NAMES.has(candidate.name)) continue;
				const args = (candidate.arguments ?? {}) as { path?: unknown; notebook_path?: unknown };
				const path =
					typeof args.path === "string"
						? args.path
						: typeof args.notebook_path === "string"
							? args.notebook_path
							: null;
				if (!path) continue;
				counts.set(path, (counts.get(path) ?? 0) + 1);
			}
		}
	}
	return [...counts.entries()]
		.map(([path, count]) => ({ path, count }))
		.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
		.slice(0, 10);
}

function visibleDroppedUserLines(turns: readonly Turn[]): string[] {
	const lines: string[] = [];
	for (let i = 0; i < turns.length; i++) {
		if (turns[i].messages[0]?.role !== "user") continue;
		const line = firstTextLine(turns[i]);
		if (line) lines.push(`${i + 1}. ${line}`);
	}

	if (lines.length <= 12) return lines;
	return [...lines.slice(0, 4), `… and ${lines.length - 12} more`, ...lines.slice(-8)];
}

function buildElidedTombstone(droppedTurns: readonly Turn[], droppedTokens: number): DeveloperMessage {
	const firstTimestamp = (droppedTurns[0]?.messages[0] as { timestamp?: unknown } | undefined)?.timestamp;
	const lines: string[] = [`[Elided: turns 1-${droppedTurns.length}, ~${Math.round(droppedTokens / 1000)}K tokens]`];
	lines.push(...visibleDroppedUserLines(droppedTurns));

	const touched = collectDroppedToolCallPaths(droppedTurns);
	if (touched.length > 0) {
		lines.push(`Files touched: ${touched.map(entry => `${entry.path} (${entry.count})`).join(", ")}`);
	}
	lines.push("Recover with: recall(query=...) or recall(turn=N)");

	while (lines.length > 2) {
		const message: DeveloperMessage = {
			role: "developer",
			content: lines.join("\n"),
			timestamp: typeof firstTimestamp === "number" ? firstTimestamp : 0,
		};
		if (estimateMessageTokens([message]) <= 800) return message;
		const removableStart = 1;
		const removableEnd = lines.length - (touched.length > 0 ? 3 : 2);
		if (removableEnd <= removableStart) break;
		lines.splice(Math.floor((removableStart + removableEnd) / 2), 1);
	}

	return {
		role: "developer",
		content: lines.join("\n"),
		timestamp: typeof firstTimestamp === "number" ? firstTimestamp : 0,
	};
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
				conversationCompressedKeys: [],
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
	const REGENERATED_PREFIXES = ["[Assembly:", "<recalled-context", "[Elided:"];
	const seenRegeneratedTypes = new Set<string>();
	const seenDeveloperHashes = new Set<number>();
	const developerTurnKeep = new Set<number>();
	for (let i = totalTurns - 1; i >= 0; i--) {
		if (originalTurns[i].hasToolResults) continue;
		if (originalTurns[i].messages[0]?.role !== "developer") continue;
		const text = extractDeveloperText(originalTurns[i]);
		// Check if this is a regenerated type (prefix match)
		const matchedPrefix = REGENERATED_PREFIXES.find(p => text.startsWith(p));
		if (matchedPrefix === "[Elided:") continue;
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
	const latestLiteralUserTurn = findLatestLiteralUserTurn(originalTurns);

	// 2. Apply content replacement beyond hot window (codec-aware)
	//    Build read history incrementally for dedup detection across turns.
	const hotWindowStart = Math.max(0, totalTurns - hotWindowTurns);
	const readHistory = new Map<string, FileReadEntry>();

	const mutatedPaths = collectMutatedPaths(originalTurns);

	const workingSetExemptions =
		options.workingSet?.enabled === true
			? computeWorkingSetExemptions(
					originalTurns,
					hotWindowStart,
					options.workingSet.evictAfterTurns ?? DEFAULT_WORKING_SET_EVICT_TURNS,
					resolveWorkingSetTokenCap(options.workingSet, options.maxTokens),
				)
			: undefined;
	const workingSetPinnedTurns = workingSetExemptions ?? new Set<number>();

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
			replacementResults.push(replaceToolResultContent(turn, options, tags, idx, readHistory, mutatedPaths));
		}
	}

	const transformedTurns = replacementResults.map(r => r.turn);
	const conversationCompressedTurns = new Set<number>();
	const conversationCompressedTurnKeys = new Set<number>();
	const transformedTokens = transformedTurns.map(estimateTurnTokens);

	const eligibleConversationTurns = new Set<number>();
	for (let i = 0; i < hotWindowStart; i++) {
		if (
			isConversationCompressionEligible(
				i,
				originalTokens[i],
				originalTurns[i],
				hotWindowStart,
				workingSetPinnedTurns,
				latestLiteralUserTurn,
			)
		) {
			eligibleConversationTurns.add(i);
		}
	}

	const compressEligibleConversationTurn = (turnIndex: number): boolean => {
		const result = compressConversationTurn(transformedTurns[turnIndex]);
		if (result.tokensAfter >= transformedTokens[turnIndex]) return false;

		transformedTurns[turnIndex] = result.turn;
		transformedTokens[turnIndex] = result.tokensAfter;
		conversationCompressedTurns.add(turnIndex);
		conversationCompressedTurnKeys.add(computeTurnKey(originalTurns[turnIndex]));
		return true;
	};

	for (const turnIndex of eligibleConversationTurns) {
		const key = computeTurnKey(originalTurns[turnIndex]);
		if (options.stickyCompressedKeys?.has(key) === true) {
			compressEligibleConversationTurn(turnIndex);
		}
	}

	// 3. Apply budget-driven ranked compression and front-drop bounding if configured.
	const maxTokens = options.maxTokens;
	const hasBudget = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens >= 0;
	const budgetTarget = hasBudget ? Math.floor(maxTokens * BUDGET_DROP_WATERMARK) : undefined;
	if (hasBudget) {
		let currentTokens = transformedTokens.reduce((sum, tokens) => sum + tokens, 0);
		if (currentTokens > maxTokens && budgetTarget !== undefined) {
			const candidates = [...eligibleConversationTurns]
				.filter(turnIndex => !conversationCompressedTurns.has(turnIndex))
				.sort((a, b) => {
					const scoreA = options.relevanceScores?.get(a);
					const scoreB = options.relevanceScores?.get(b);
					if (scoreA !== undefined && scoreB !== undefined && scoreA !== scoreB) return scoreA - scoreB;
					if (scoreA !== undefined && scoreB === undefined) return -1;
					if (scoreA === undefined && scoreB !== undefined) return 1;
					return a - b;
				});

			for (const turnIndex of candidates) {
				if (currentTokens <= budgetTarget) break;
				const before = transformedTokens[turnIndex];
				if (compressEligibleConversationTurn(turnIndex)) {
					currentTokens -= before - transformedTokens[turnIndex];
				}
			}
		}
	}

	let dropCount = 0;
	if (hasBudget) {
		dropCount = computeBudgetDropCount(transformedTokens, maxTokens, hotWindowTurns, budgetTarget);
	}

	// 3b. Ensure surviving messages start with a user turn (Claude API requirement).
	// The walk stops at the first user-role turn, which may be the latest literal
	// user anchor itself. If drops swallow the anchor, the result is deliberately
	// INVALID (isValidBoundedTransform fails) so the overflow-summary/recovery
	// ladder engages — the anchor is protected by routing, not by clamping drops,
	// which would silently ship an over-budget window and starve the recovery path.
	// The tombstone is inserted after this validation. startsWithCanonicalLlmUser
	// skips developer messages so the synthesized tombstone does not reset the constraint.
	if (dropCount > 0) {
		while (dropCount < transformedTurns.length && transformedTurns[dropCount].messages[0].role !== "user") {
			dropCount++;
		}
	}

	if (hasBudget && dropCount > 0) {
		let projectedTokens = transformedTokens.slice(dropCount).reduce((sum, tokens) => sum + tokens, 0);
		projectedTokens += estimateMessageTokens([
			buildElidedTombstone(
				originalTurns.slice(0, dropCount),
				originalTokens.slice(0, dropCount).reduce((sum, tokens) => sum + tokens, 0),
			),
		]);
		while (projectedTokens > maxTokens && dropCount < hotWindowStart) {
			dropCount++;
			while (dropCount < hotWindowStart && transformedTurns[dropCount].messages[0].role !== "user") {
				dropCount++;
			}
			projectedTokens = transformedTokens.slice(dropCount).reduce((sum, tokens) => sum + tokens, 0);
			projectedTokens += estimateMessageTokens([
				buildElidedTombstone(
					originalTurns.slice(0, dropCount),
					originalTokens.slice(0, dropCount).reduce((sum, tokens) => sum + tokens, 0),
				),
			]);
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
				// User/assistant conversation compression was applied before budget selection.
				// Track relevance scoring stats
				const sim = options.relevanceScores?.get(i);
				if (sim !== undefined) {
					scoredCount++;
					if (sim < simMin) simMin = sim;
					if (sim > simMax) simMax = sim;
				}
				if (conversationCompressedTurns.has(i)) {
					decisions.push({
						turnIndex: i,
						action: "compressed",
						reason: "conversation-compressed",
						messageCount: originalTurns[i].messages.length,
						hasToolResults: false,
						tokensBefore,
						tokensAfter: transformedTokens[i],
						sourceTags,
					});
					totalTokensAfter += transformedTokens[i];
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
	let resultMessages = survivingTurns.flatMap(t => t.messages);
	let elided: TransformMetadata["elided"];
	if (dropCount > 0) {
		const droppedTokens = originalTokens.slice(0, dropCount).reduce((sum, tokens) => sum + tokens, 0);
		const tombstone = buildElidedTombstone(originalTurns.slice(0, dropCount), droppedTokens);
		resultMessages = [tombstone, ...resultMessages];
		totalTokensAfter += estimateMessageTokens([tombstone]);
		elided = { turnCount: dropCount, tokens: droppedTokens };
	}

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
			conversationCompressedKeys: [...conversationCompressedTurnKeys],
			elided,
		},
	};
}

type RecoveryControlPrompt = TransformRecoveryMetadata["controlPrompt"];

function recoveryInitialSummary(metadata: TransformMetadata, outputMessageCount: number) {
	return {
		outputMessageCount,
		keptCount: metadata.keptCount,
		stubbedCount: metadata.stubbedCount,
		compressedCount: metadata.compressedCount,
		droppedCount: metadata.droppedCount,
		tokensAfter: metadata.tokensAfter,
	};
}

function normalizeReservedTokens(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function userAnchorText(message: UserMessage): { text: string; hasNonText: boolean } {
	if (typeof message.content === "string") {
		return { text: message.content, hasNonText: false };
	}

	const text: string[] = [];
	let hasNonText = false;
	for (const block of message.content) {
		if (block.type === "text") {
			text.push(block.text);
		} else {
			hasNonText = true;
		}
	}
	return { text: text.join(""), hasNonText };
}

function boundUserAnchor(message: UserMessage, maxTokens: number): UserMessage | null {
	const tokenBudget = Math.max(0, Math.floor(maxTokens));
	const charBudget = Math.floor(tokenBudget * 3.2);
	if (charBudget <= 0) return null;

	const { text, hasNonText } = userAnchorText(message);
	if (hasNonText || text.length === 0) return null;

	const headLength = Math.ceil(charBudget / 2);
	const tailLength = charBudget - headLength;
	const content: TextContent[] = [{ type: "text", text: text.slice(0, headLength) }];
	if (tailLength > 0) {
		content.push({ type: "text", text: text.slice(-tailLength) });
	}

	return {
		...message,
		content,
		providerPayload: undefined,
	};
}

function buildRecoveredMetadata(
	turns: Turn[],
	initial: TransformResult,
	retry: TransformResult,
	selectedOriginalTurnIndexes: number[],
	attempts: number,
	anchorTruncated: boolean,
	controlPrompt: RecoveryControlPrompt,
): TransformMetadata {
	const selectedDecisions = new Map<number, TurnDecision>();
	for (const decision of retry.metadata.decisions) {
		const originalTurnIndex = selectedOriginalTurnIndexes[decision.turnIndex];
		if (originalTurnIndex === undefined) continue;
		const originalTurn = turns[originalTurnIndex];
		selectedDecisions.set(originalTurnIndex, {
			...decision,
			turnIndex: originalTurnIndex,
			messageCount: originalTurn.messages.length,
			tokensBefore: estimateTurnTokens(originalTurn),
			...(anchorTruncated && originalTurnIndex === selectedOriginalTurnIndexes[0]
				? { action: "compressed" as const, reason: "recovery-anchor-truncated" as const }
				: {}),
		});
	}

	const decisions = turns.map((turn, turnIndex): TurnDecision => {
		const selected = selectedDecisions.get(turnIndex);
		if (selected) return selected;
		return {
			turnIndex,
			action: "dropped",
			reason: "recovery-excluded",
			messageCount: turn.messages.length,
			hasToolResults: turn.hasToolResults,
			tokensBefore: estimateTurnTokens(turn),
			tokensAfter: 0,
			sourceTags: extractSourceTags(turn.messages),
		};
	});
	const outputOriginalTurnIndexes = decisions
		.filter(decision => decision.action !== "dropped")
		.map(decision => decision.turnIndex);

	return {
		decisions,
		totalTurns: turns.length,
		keptCount: decisions.filter(decision => decision.action === "kept").length,
		stubbedCount: decisions.filter(decision => decision.action === "stubbed").length,
		compressedCount: decisions.filter(decision => decision.action === "compressed").length,
		droppedCount: decisions.filter(decision => decision.action === "dropped").length,
		tokensBefore: initial.metadata.tokensBefore,
		tokensAfter: retry.metadata.tokensAfter,
		scoredCount: 0,
		conversationCompressedKeys: retry.metadata.conversationCompressedKeys,
		recovery: {
			trigger: "empty-selection",
			outcome: "recovered",
			attempts,
			originalTurnCount: initial.metadata.totalTurns,
			selectedOriginalTurnIndexes: outputOriginalTurnIndexes,
			outputMessageCount: retry.messages.length,
			outputTokens: retry.metadata.tokensAfter,
			anchorTruncated,
			controlPrompt,
			initial: recoveryInitialSummary(initial.metadata, initial.messages.length),
		},
	};
}

function buildUnrecoverableResult(
	initial: TransformResult,
	attempts: number,
	reason: NonNullable<TransformRecoveryMetadata["unrecoverableAnchorReason"]>,
): TransformResult {
	return {
		messages: [],
		metadata: {
			...initial.metadata,
			keptCount: 0,
			stubbedCount: 0,
			compressedCount: 0,
			droppedCount: initial.metadata.totalTurns,
			tokensAfter: 0,
			recovery: {
				trigger: "empty-selection",
				outcome: "unrecoverable",
				attempts,
				originalTurnCount: initial.metadata.totalTurns,
				selectedOriginalTurnIndexes: [],
				outputMessageCount: 0,
				outputTokens: 0,
				anchorTruncated: false,
				controlPrompt: "omitted",
				unrecoverableAnchorReason: reason,
				initial: recoveryInitialSummary(initial.metadata, initial.messages.length),
			},
		},
	};
}

/**
 * Run the normal transform first, then retry with a bounded user-led suffix if
 * the result has no valid user start. Recovery is the terminal fallback after
 * ordinary compression and eviction. Retries are synchronous and reuse the
 * caller's already-resolved context state; no hydration or storage I/O occurs.
 */
export function transformMessagesWithRecovery(
	messages: AgentMessage[],
	options: MessageTransformOptions = {},
	recovery: TransformRecoveryOptions = {},
): TransformResult {
	const initial = transformMessages(messages, options);
	const configuredMaxTokens = options.maxTokens;
	if (configuredMaxTokens === undefined || !Number.isFinite(configuredMaxTokens) || configuredMaxTokens < 0) {
		if (isValidBoundedTransform(messages, initial)) return initial;
		return initial;
	}
	if (isValidBoundedTransform(messages, initial) && initial.metadata.tokensAfter <= configuredMaxTokens)
		return initial;
	const maxTokens = Math.floor(configuredMaxTokens);

	const turns = segmentIntoTurns(messages);
	const latestUserTurn = findLatestLiteralUserTurn(turns);
	if (latestUserTurn < 0) return initial;

	if (maxTokens === 0) return buildUnrecoverableResult(initial, 0, "zero-token-budget");

	const userMessage = turns[latestUserTurn].messages[0] as UserMessage;
	const originalAnchorTokens = estimateTurnTokens(turns[latestUserTurn]);
	const configuredHotWindow = Math.max(0, Math.floor(options.hotWindowTurns ?? DEFAULT_HOT_WINDOW_TURNS));
	const firstSuffixTurn = Math.max(latestUserTurn + 1, turns.length - configuredHotWindow);
	const standardControlPromptTokens = normalizeReservedTokens(recovery.standardControlPromptTokens);
	const truncatedControlPromptTokens = normalizeReservedTokens(recovery.truncatedControlPromptTokens);
	let attempts = 0;

	const runSuffixRetries = (
		anchorTurn: Turn,
		messageBudget: number,
		controlPrompt: RecoveryControlPrompt,
		anchorTruncated: boolean,
	): TransformResult | null => {
		if (messageBudget <= 0 || estimateTurnTokens(anchorTurn) > messageBudget) return null;
		const retryOptions: MessageTransformOptions = {
			...options,
			maxTokens: messageBudget,
			hotWindowTurns: Math.max(1, configuredHotWindow),
			relevanceScores: undefined,
			stickyCompressedKeys: undefined,
		};

		for (let suffixStart = firstSuffixTurn; suffixStart <= turns.length; suffixStart++) {
			const selectedOriginalTurnIndexes = [
				latestUserTurn,
				...turns.slice(suffixStart).map((_, index) => suffixStart + index),
			];
			const candidateTurns = [anchorTurn, ...turns.slice(suffixStart)];
			const candidateMessages = candidateTurns.flatMap(turn => turn.messages);
			const retry = transformMessages(candidateMessages, retryOptions);
			attempts++;
			if (!isValidBoundedTransform(candidateMessages, retry)) continue;
			if (retry.metadata.tokensAfter > messageBudget) continue;

			return {
				messages: retry.messages,
				metadata: buildRecoveredMetadata(
					turns,
					initial,
					retry,
					selectedOriginalTurnIndexes,
					attempts,
					anchorTruncated,
					controlPrompt,
				),
			};
		}
		return null;
	};

	// First recovery attempt preserves the full user anchor and reserves the
	// standard control nudge. If that reserve is the only thing preventing a
	// valid anchor, user context wins and the nudge is omitted.
	if (standardControlPromptTokens !== undefined) {
		const result = runSuffixRetries(
			turns[latestUserTurn],
			maxTokens - standardControlPromptTokens,
			"standard",
			false,
		);
		if (result) return result;
	}

	const withoutControlPrompt = runSuffixRetries(turns[latestUserTurn], maxTokens, "omitted", false);
	if (withoutControlPrompt) return withoutControlPrompt;

	// Only a genuinely oversized user anchor reaches truncation. Non-text blocks
	// are never sliced or rewritten; if the full mixed-media anchor cannot fit,
	// surface an explicit unrecoverable outcome instead.
	const { hasNonText } = userAnchorText(userMessage);
	if (hasNonText && originalAnchorTokens > maxTokens) {
		return buildUnrecoverableResult(initial, attempts, "non-text-anchor-exceeds-budget");
	}

	if (truncatedControlPromptTokens !== undefined) {
		const truncatedBudget = maxTokens - truncatedControlPromptTokens;
		const boundedUser = boundUserAnchor(userMessage, truncatedBudget);
		if (boundedUser) {
			const result = runSuffixRetries(
				{ messages: [boundedUser], hasToolResults: false },
				truncatedBudget,
				"truncated",
				true,
			);
			if (result) return result;
		}
	}

	return buildUnrecoverableResult(initial, attempts, "text-anchor-exceeds-recoverable-budget");
}
