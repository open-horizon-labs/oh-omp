/**
 * Kernel-internal types for the local assembler.
 */

/**
 * Input for deriving the assembler budget from model context window.
 *
 * Budget decomposition:
 *   available = contextWindow - systemPromptTokens - toolDefinitionTokens - currentTurnTokens
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
	/** Estimated tokens consumed by current-turn messages. */
	currentTurnTokens: number;
}
