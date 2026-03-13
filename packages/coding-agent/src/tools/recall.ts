import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import { embed } from "../context/recall/embed";
import { mmrRerank } from "../context/recall/mmr";
import type { RecallStore } from "../context/recall/store";
import type { SearchResult as KeywordSearchResult, ToolResultStore } from "../context/recall/tool-result-store";
import type { MmrCandidate, RecallSearchResult } from "../context/recall/types";
import { parseMCPToolName } from "../mcp/tool-bridge";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

import { shortenPath } from "./render-utils";

const recallSchema = Type.Object({
	query: Type.String({
		description: "What you're trying to recall -- describe the content, file, decision, or event",
	}),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5, max: 20)" })),
	role: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool_result")], {
			description: "Optional: filter by message type",
		}),
	),
	project: Type.Optional(
		Type.Union([Type.Literal("current"), Type.Literal("all")], {
			description: "Search scope: 'current' (this project only) or 'all' (cross-project, default)",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("semantic"), Type.Literal("keyword")], {
			description:
				"Search mode: 'semantic' (default, vector search) or 'keyword' (exact text match over tool results)",
		}),
	),
});

type RecallParams = Static<typeof recallSchema>;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Overfetch factor — retrieve more candidates than needed so MMR has room to diversify. */
const OVERFETCH_FACTOR = 3;

export class RecallTool implements AgentTool<typeof recallSchema> {
	readonly name = "recall";
	readonly label = "Recall";
	readonly description: string;
	readonly parameters = recallSchema;

	#store: RecallStore;
	#toolResultStore?: ToolResultStore;
	#license: string;
	#cwd: string;
	#sessionId: string;

	constructor(store: RecallStore, license: string, cwd: string, sessionId: string, toolResultStore?: ToolResultStore) {
		this.description = renderPromptTemplate(recallDescription);
		this.#store = store;
		this.#toolResultStore = toolResultStore;
		this.#license = license;
		this.#cwd = cwd;
		this.#sessionId = sessionId;
	}

	static createIf(session: ToolSession): RecallTool | null {
		if (!session.recallStore || !session.memexLicense) return null;
		const sessionId = session.getSessionId?.() ?? "unknown";
		return new RecallTool(session.recallStore, session.memexLicense, session.cwd, sessionId, session.toolResultStore);
	}

	async execute(_toolCallId: string, params: RecallParams, _signal?: AbortSignal): Promise<AgentToolResult> {
		if (params.mode === "keyword") {
			return this.#keywordSearch(params);
		}
		const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
		const overfetchLimit = limit * OVERFETCH_FACTOR;
		// Build LanceDB SQL filter clauses
		const clauses: string[] = [];
		if (params.role) clauses.push(`role = '${params.role}'`);
		if (params.project === "current") {
			// Escape single quotes in CWD to prevent SQL injection in LanceDB filter
			const escapedCwd = this.#cwd.replace(/'/g, "''");
			clauses.push(`project_cwd = '${escapedCwd}'`);
		}
		const filter = clauses.length > 0 ? clauses.join(" AND ") : undefined;

		// Step 1: Embed the query
		let queryVector: number[];
		try {
			const vectors = await embed([params.query], this.#license);
			queryVector = Array.from(vectors[0]);
		} catch (err) {
			logger.warn("Recall: embedding failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				content: [{ type: "text", text: "Failed to embed query. Recall is temporarily unavailable." }],
			};
		}

		// Step 2: Search LanceDB (overfetch for MMR diversity)
		let results: RecallSearchResult[];
		try {
			results = await this.#store.search(queryVector, overfetchLimit, filter);
		} catch (err) {
			logger.warn("Recall: search failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				content: [{ type: "text", text: "Failed to search session history. Recall is temporarily unavailable." }],
			};
		}

		if (results.length === 0) {
			return {
				content: [{ type: "text", text: "No matching results found in session history." }],
			};
		}

		// Step 3: Build MMR candidates — convert distance (lower = closer) to score (higher = better)
		const candidates: MmrCandidate<RecallSearchResult>[] = results.map(r => ({
			vector: r.vector,
			score: 1 / (1 + r._distance),
			data: r,
		}));

		// Step 4: MMR rerank for diversity
		const reranked = mmrRerank(candidates);

		// Step 5: Take top `limit` results
		const topResults = reranked.slice(0, limit);

		// Step 6: Format results
		const formatted = topResults.map(r => formatResult(r.data, this.#sessionId)).join("\n\n---\n\n");

		logger.debug("Recall: returned results", {
			query: params.query.slice(0, 80),
			total: results.length,
			returned: topResults.length,
		});

		return {
			content: [{ type: "text", text: formatted }],
		};
	}

	#keywordSearch(params: RecallParams): AgentToolResult {
		if (!this.#toolResultStore) {
			return {
				content: [{ type: "text", text: "Keyword search not available. ToolResultStore not initialized." }],
			};
		}

		const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
		const sessionId = params.project === "current" ? this.#sessionId : undefined;

		const results = this.#toolResultStore.search(params.query, { limit, sessionId });

		if (results.length === 0) {
			return {
				content: [{ type: "text", text: "No matching tool results found." }],
			};
		}

		const formatted = results.map(r => formatKeywordResult(r, this.#sessionId)).join("\n\n---\n\n");

		logger.debug("Recall keyword: returned results", {
			query: params.query.slice(0, 80),
			returned: results.length,
		});

		return {
			content: [{ type: "text", text: formatted }],
		};
	}
}

function formatResult(r: RecallSearchResult, currentSessionId: string): string {
	// Header: Turn N [role: tool_name] source: <tag> session: <age> project: /path paths: x, y
	let header = `Turn ${r.turn} [${r.role}`;
	if (r.tool_name) header += `: ${r.tool_name}`;
	header += "]";

	// Source tag
	if (r.tool_name) {
		const mcpParts = parseMCPToolName(r.tool_name);
		if (mcpParts) {
			header += ` source: mcp:${mcpParts.serverName}`;
		} else {
			header += ` source: tool:${r.tool_name}`;
		}
	} else {
		header += ` source: ${r.role}`;
	}

	// Session age
	header += ` session: ${r.session_id === currentSessionId ? "current" : "other"}`;

	if (r.project_cwd) {
		header += ` project: ${shortenPath(r.project_cwd)}`;
	}

	if (r.paths) {
		try {
			const pathsList = JSON.parse(r.paths) as string[];
			if (pathsList.length > 0) {
				header += ` paths: ${pathsList.join(", ")}`;
			}
		} catch {
			// Malformed paths JSON -- skip
		}
	}

	return `${header}\n${r.text}`;
}

function formatKeywordResult(r: KeywordSearchResult, currentSessionId: string): string {
	const isCurrentSession = r.sessionId === currentSessionId;
	const sessionTag = isCurrentSession ? "current" : `session:${r.sessionId.slice(0, 8)}`;
	let header = `Turn ${r.turnNumber} [tool:${r.toolName}] ${sessionTag}`;
	if (r.paths.length > 0) {
		header += ` paths: ${r.paths.slice(0, 5).join(", ")}`;
	}
	return `${header}\n${r.snippet}`;
}
