/**
 * Tool result classification: maps tool names to categories and freshness policies.
 *
 * The classification drives locator generation strategy, freshness TTLs,
 * and invalidation rules in the bridge.
 */

import type { MemoryFreshnessPolicy, MemoryLocatorRetrievalMethod, MemoryLocatorTrustLevel } from "../memory-contract";
import { CATEGORY_FRESHNESS, type ResultProfile, type ToolResultCategory } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Tool category map
// ═══════════════════════════════════════════════════════════════════════════

interface ToolCategoryEntry {
	category: ToolResultCategory;
	trust: MemoryLocatorTrustLevel;
	/** Retrieval method for the generated locator. */
	retrievalMethod: MemoryLocatorRetrievalMethod;
	/** Override default category freshness. */
	freshness?: MemoryFreshnessPolicy;
}

/**
 * Static classification map covering all BUILTIN_TOOLS and HIDDEN_TOOLS.
 *
 * Key is the tool name as it appears in `tool_execution_end` events.
 */
export const TOOL_CATEGORY_MAP: Record<string, ToolCategoryEntry> = {
	// ── Lookup tools ─────────────────────────────────────────────────────
	grep: { category: "lookup", trust: "authoritative", retrievalMethod: "grep" },
	find: { category: "lookup", trust: "authoritative", retrievalMethod: "find" },
	ast_grep: { category: "lookup", trust: "authoritative", retrievalMethod: "grep" },
	lsp: { category: "lookup", trust: "authoritative", retrievalMethod: "lsp.references" },
	web_search: { category: "lookup", trust: "heuristic", retrievalMethod: "read" },

	// ── Read tools ───────────────────────────────────────────────────────
	read: { category: "read", trust: "authoritative", retrievalMethod: "read" },
	fetch: { category: "read", trust: "derived", retrievalMethod: "read" },

	// ── Mutation tools ───────────────────────────────────────────────────
	edit: { category: "mutation", trust: "authoritative", retrievalMethod: "read" },
	write: { category: "mutation", trust: "authoritative", retrievalMethod: "read" },
	ast_edit: { category: "mutation", trust: "authoritative", retrievalMethod: "read" },
	notebook: { category: "mutation", trust: "authoritative", retrievalMethod: "read" },

	// ── Execution tools ──────────────────────────────────────────────────
	bash: { category: "execution", trust: "derived", retrievalMethod: "read" },
	python: { category: "execution", trust: "derived", retrievalMethod: "read" },
	ssh: { category: "execution", trust: "derived", retrievalMethod: "read" },
	calc: { category: "execution", trust: "authoritative", retrievalMethod: "read" },
	render_mermaid: { category: "execution", trust: "derived", retrievalMethod: "read" },
	browser: { category: "execution", trust: "heuristic", retrievalMethod: "read" },

	// ── Control tools ────────────────────────────────────────────────────
	todo_write: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	ask: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	checkpoint: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	rewind: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	cancel_job: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	await: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	exit_plan_mode: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	resolve: { category: "control", trust: "authoritative", retrievalMethod: "read" },

	// ── Subagent tools ───────────────────────────────────────────────────
	task: { category: "subagent", trust: "derived", retrievalMethod: "read" },

	// ── Hidden tools ─────────────────────────────────────────────────────
	submit_result: { category: "control", trust: "authoritative", retrievalMethod: "read" },
	report_finding: { category: "control", trust: "authoritative", retrievalMethod: "read" },
};

// ═══════════════════════════════════════════════════════════════════════════
// Path extraction helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract file paths from tool args. */
function extractPathsFromArgs(toolName: string, args: Record<string, unknown>): string[] {
	const paths: string[] = [];

	// Common arg names that contain paths
	const pathKeys = ["path", "file", "filePath", "file_path", "target"];
	for (const key of pathKeys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) {
			paths.push(value);
		}
	}

	// Tool-specific path extraction
	switch (toolName) {
		case "edit":
		case "write":
		case "read":
		case "ast_edit":
			// `path` already covered above
			break;

		case "grep":
		case "find":
		case "ast_grep": {
			// These tools may have `path` or `directory` args
			const dir = args.directory ?? args.dir;
			if (typeof dir === "string" && dir.length > 0) {
				paths.push(dir);
			}
			break;
		}

		case "notebook": {
			const nbPath = args.notebook_path ?? args.notebookPath;
			if (typeof nbPath === "string" && nbPath.length > 0) {
				paths.push(nbPath);
			}
			break;
		}

		case "lsp": {
			const file = args.file;
			if (typeof file === "string" && file.length > 0 && !paths.includes(file)) {
				paths.push(file);
			}
			break;
		}
	}

	return paths;
}

/** Extract symbol names from tool args (primarily LSP tools). */
function extractSymbolsFromArgs(toolName: string, args: Record<string, unknown>): string[] {
	const symbols: string[] = [];

	if (toolName === "lsp") {
		const query = args.query;
		if (typeof query === "string" && query.length > 0) {
			symbols.push(query);
		}
		const newName = args.new_name;
		if (typeof newName === "string" && newName.length > 0) {
			symbols.push(newName);
		}
	}

	return symbols;
}

/** Detect if a result string contains artifact reference. */
function hasArtifactReference(result: unknown): boolean {
	if (typeof result !== "string") return false;
	return result.includes("artifact://");
}

// ═══════════════════════════════════════════════════════════════════════════
// Classification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify a tool execution result into a ResultProfile.
 *
 * Uses the static TOOL_CATEGORY_MAP for known tools. Unknown tools
 * default to the `execution` category with `heuristic` trust.
 */
export function classifyResult(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	isError: boolean,
): ResultProfile {
	const entry = TOOL_CATEGORY_MAP[toolName];

	const category: ToolResultCategory = entry?.category ?? "execution";
	const trust: MemoryLocatorTrustLevel = entry?.trust ?? "heuristic";

	// Build freshness policy
	let freshness: MemoryFreshnessPolicy;
	if (entry?.freshness) {
		freshness = { ...entry.freshness };
	} else {
		freshness = { ...CATEGORY_FRESHNESS[category] };
	}

	// Error execution results get session-length TTL (never expire within session)
	if (isError && category === "execution") {
		freshness = { ttlMs: Number.MAX_SAFE_INTEGER, invalidatedBy: [] };
	}

	// Extract paths and symbols
	const safeArgs = args != null && typeof args === "object" ? args : {};
	const touchedPaths = extractPathsFromArgs(toolName, safeArgs);
	const touchedSymbols = extractSymbolsFromArgs(toolName, safeArgs);

	// For mutation tools, add touched paths as invalidation targets on lookup/read entries
	// This is applied during locator generation in the bridge, not here.

	return {
		toolName,
		category,
		trust,
		freshness,
		touchedPaths,
		touchedSymbols,
		hasArtifact: hasArtifactReference(result),
		isError,
	};
}
