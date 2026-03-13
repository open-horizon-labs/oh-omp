/**
 * Types for the tool-result-to-memory bridge.
 *
 * The bridge observes tool execution events and produces MemoryLocatorEntry
 * records that the assembler kernel can score, rank, and hydrate.
 */

import type { MemoryFreshnessPolicy, MemoryLocatorTrustLevel } from "../memory-contract";

// ═══════════════════════════════════════════════════════════════════════════
// Tool result categories
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tool result categories determine freshness policy and locator generation strategy.
 *
 * | Category  | Tools                                                   | Freshness TTL        | Invalidated by          |
 * |-----------|---------------------------------------------------------|----------------------|-------------------------|
 * | lookup    | grep, find, ast_grep, lsp.hover, lsp.references, web_search | 120s           | Same-path edit          |
 * | read      | read, fetch                                              | 300s                | File edit to same path  |
 * | mutation  | edit, write, ast_edit, notebook                          | 0s (current turn)   | Immediate               |
 * | execution | bash, python, task                                       | 600s (success)/session (error) | Error resolution |
 * | control   | todo_write, ask, checkpoint, rewind                      | 0s                  | Never retained          |
 * | subagent  | task (completed)                                         | Session              | Never                   |
 */
export const TOOL_RESULT_CATEGORIES = ["lookup", "read", "mutation", "execution", "control", "subagent"] as const;
export type ToolResultCategory = (typeof TOOL_RESULT_CATEGORIES)[number];

// ═══════════════════════════════════════════════════════════════════════════
// Freshness policies
// ═══════════════════════════════════════════════════════════════════════════

/** Category-level default freshness policies. Overridden per-tool when needed. */
export const CATEGORY_FRESHNESS: Record<ToolResultCategory, MemoryFreshnessPolicy> = {
	lookup: { ttlMs: 120_000, invalidatedBy: [] },
	read: { ttlMs: 300_000, invalidatedBy: [] },
	mutation: { ttlMs: 0, invalidatedBy: [] },
	execution: { ttlMs: 600_000, invalidatedBy: [] },
	control: { ttlMs: 0, invalidatedBy: [] },
	subagent: { ttlMs: Number.MAX_SAFE_INTEGER, invalidatedBy: [] },
};

// ═══════════════════════════════════════════════════════════════════════════
// Result profile
// ═══════════════════════════════════════════════════════════════════════════

/** Profile describing a classified tool result for locator generation. */
export interface ResultProfile {
	/** Tool name as it appears in the event. */
	toolName: string;
	/** Classified category. */
	category: ToolResultCategory;
	/** Trust level for the generated locator. */
	trust: MemoryLocatorTrustLevel;
	/** Freshness policy for the generated locator. */
	freshness: MemoryFreshnessPolicy;
	/** File paths touched by this tool execution (for invalidation tracking). */
	touchedPaths: string[];
	/** Symbols referenced by this tool execution. */
	touchedSymbols: string[];
	/** Whether the result has an artifact backing (truncated output). */
	hasArtifact: boolean;
	/** Whether the tool execution was an error. */
	isError: boolean;
	/** MCP server name if this is an MCP tool (parsed from compound name). */
	mcpServerName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bridge configuration
// ═══════════════════════════════════════════════════════════════════════════

/** Configuration for the ToolResultBridge. */
export interface BridgeConfig {
	/** Override current timestamp (ISO 8601) for deterministic tests. */
	now?: string;
	/** Maximum number of locator entries to retain before eviction. */
	maxLocatorEntries?: number;
	/** Session ID for FTS5 indexing scope. */
	sessionId?: string;
	/** FTS5 tool result store for keyword search. */
	toolResultStore?: import("../recall/tool-result-store").ToolResultStore;
}

/** Default max locator entries. */
export const DEFAULT_MAX_LOCATOR_ENTRIES = 500;
