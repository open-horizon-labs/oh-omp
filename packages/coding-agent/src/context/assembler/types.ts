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
