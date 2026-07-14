import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { embed } from "../context/recall/embed";
import { HybridRetriever, type HybridSearchMode } from "../context/recall/hybrid-retriever";
import { qwen3EmbeddingProfile } from "../context/recall/model-profile";
import type { RecallStore } from "../context/recall/store";
import type { SearchResult as KeywordSearchResult, ToolResultStore } from "../context/recall/tool-result-store";
import type { RecallSearchResult } from "../context/recall/types";
import { parseMCPToolName } from "../mcp/tool-bridge";
import type { ToolSession } from ".";

import { shortenPath } from "./render-utils";

const recallSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"What you're trying to recall -- describe the content, file, decision, or event. Not needed when using turn expansion.",
		}),
	),
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
		Type.Union([Type.Literal("hybrid"), Type.Literal("semantic"), Type.Literal("keyword")], {
			description:
				"Search mode: 'hybrid' (default, semantic + exact text), 'semantic' (vector search only), or 'keyword' (exact text match over recalled rows)",
		}),
	),
	turn: Type.Optional(
		Type.Number({
			description:
				"Expand a specific turn by number. Returns the full original content of all messages at that turn. Use this to retrieve the uncompressed content behind a [warm:...] or [ref:...] stub.",
		}),
	),
});

type RecallParams = Static<typeof recallSchema>;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

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
	#retriever: HybridRetriever;

	constructor(store: RecallStore, license: string, cwd: string, sessionId: string, toolResultStore?: ToolResultStore) {
		this.description = ""; // RNA experiment: tool descriptions compiled into system prompt, not sent per-turn;
		this.#store = store;
		this.#toolResultStore = toolResultStore;
		this.#license = license;
		this.#cwd = cwd;
		this.#sessionId = sessionId;
		this.#retriever = new HybridRetriever({
			store,
			toolResultStore,
			sessionId,
			projectCwd: cwd,
		});
	}

	static createIf(session: ToolSession): RecallTool | null {
		if (!session.recallStore || !session.memexLicense) return null;
		const sessionId = session.getSessionId?.() ?? "unknown";
		return new RecallTool(session.recallStore, session.memexLicense, session.cwd, sessionId, session.toolResultStore);
	}

	async execute(_toolCallId: string, params: RecallParams, _signal?: AbortSignal): Promise<AgentToolResult> {
		if (params.turn !== undefined) {
			return this.#expandTurn(params);
		}
		if (!params.query) {
			return {
				content: [
					{
						type: "text",
						text: "A query is required for semantic, hybrid, and keyword search. Use turn parameter for turn expansion.",
					},
				],
			};
		}
		if (params.mode === "keyword") {
			return this.#keywordSearch(params as RecallParams & { query: string });
		}
		const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
		const filter = buildRecallFilter({ cwd: this.#cwd, project: params.project, role: params.role });

		let queryVector: number[];
		try {
			const preparedQuery = qwen3EmbeddingProfile.prepareQuery(params.query, "head");
			if (preparedQuery.truncated) {
				logger.warn("Recall: semantic query bounded to Qwen token budget", {
					originalTokens: preparedQuery.originalTokenCount,
					effectiveTokens: preparedQuery.tokenCount,
				});
			}
			const vectors = await embed([preparedQuery.text], this.#license);
			queryVector = Array.from(vectors[0]);
		} catch (err) {
			logger.warn("Recall: embedding failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				content: [{ type: "text", text: "Failed to embed query. Recall is temporarily unavailable." }],
			};
		}

		const mode: HybridSearchMode = params.mode === "semantic" ? "semantic" : "hybrid";
		let results: RecallSearchResult[];
		let trace:
			| {
					mode: HybridSearchMode;
					semanticCandidates: number;
					keywordCandidates: number;
					resolvedKeywordCandidates: number;
					fusedCandidates: number;
			  }
			| undefined;
		try {
			const response = await this.#retriever.search({
				query: params.query,
				queryVector,
				limit,
				filter,
				role: params.role,
				project: params.project,
				mode,
			});
			results = response.results;
			trace = response.trace;
		} catch (err) {
			logger.warn("Recall: search failed", {
				error: err instanceof Error ? err.message : String(err),
				mode,
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

		const formatted = results.map(result => formatResult(result, this.#sessionId)).join("\n\n---\n\n");

		logger.debug("Recall: returned results", {
			query: params.query.slice(0, 80),
			mode,
			returned: results.length,
			semanticCandidates: trace?.semanticCandidates ?? 0,
			keywordCandidates: trace?.keywordCandidates ?? 0,
			resolvedKeywordCandidates: trace?.resolvedKeywordCandidates ?? 0,
			fusedCandidates: trace?.fusedCandidates ?? 0,
		});

		return {
			content: [{ type: "text", text: formatted }],
		};
	}

	async #expandTurn(params: RecallParams): Promise<AgentToolResult> {
		const turn = params.turn!;
		try {
			const rows = await this.#store.filterByTurn(turn, this.#sessionId);
			if (rows.length === 0) {
				return {
					content: [{ type: "text", text: `No messages found at turn ${turn} in this session.` }],
				};
			}
			const formatted = rows
				.map(r => {
					let header = `Turn ${r.turn} [${r.role}`;
					if (r.tool_name) header += `: ${r.tool_name}`;
					header += "]";
					if (r.paths) {
						try {
							const pathsList = JSON.parse(r.paths) as string[];
							if (pathsList.length > 0) header += ` paths: ${pathsList.join(", ")}`;
						} catch {}
					}
					return `${header}\n${r.text}`;
				})
				.join("\n\n---\n\n");
			logger.debug("Recall: expanded turn", { turn, results: rows.length });
			return {
				content: [{ type: "text", text: formatted }],
			};
		} catch (err) {
			logger.warn("Recall: turn expansion failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				content: [{ type: "text", text: "Failed to expand turn. Recall is temporarily unavailable." }],
			};
		}
	}

	#keywordSearch(params: RecallParams & { query: string }): AgentToolResult {
		if (!this.#toolResultStore) {
			return {
				content: [{ type: "text", text: "Keyword search not available. ToolResultStore not initialized." }],
			};
		}

		const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
		const results = this.#toolResultStore.search(params.query, {
			limit,
			projectCwd: params.project === "current" ? this.#cwd : undefined,
			role: params.role,
		});

		if (results.length === 0) {
			return {
				content: [{ type: "text", text: "No matching exact-text results found." }],
			};
		}

		const formatted = results.map(result => formatKeywordResult(result, this.#sessionId)).join("\n\n---\n\n");

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
	let header = `Turn ${r.turn} [${r.role}`;
	if (r.tool_name) header += `: ${r.tool_name}`;
	header += "]";

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
	let header = `Turn ${r.turnNumber} [`;
	if (r.role === "tool_result") {
		header += `tool:${r.toolName ?? "unknown"}`;
	} else {
		header += r.role;
	}
	header += `] ${sessionTag}`;
	if (r.projectCwd) {
		header += ` project: ${shortenPath(r.projectCwd)}`;
	}
	if (r.paths.length > 0) {
		header += ` paths: ${r.paths.slice(0, 5).join(", ")}`;
	}
	return `${header}\n${r.snippet}`;
}

function buildRecallFilter(options: {
	cwd: string;
	project?: "current" | "all";
	role?: "user" | "assistant" | "tool_result";
}): string | undefined {
	const clauses: string[] = [];
	if (options.role) clauses.push(`role = '${options.role}'`);
	if (options.project === "current") {
		const escapedCwd = options.cwd.replace(/'/g, "''");
		clauses.push(`project_cwd = '${escapedCwd}'`);
	}
	return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}
