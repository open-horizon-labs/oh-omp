/** Embedding vector dimension for Qwen3-Embedding-4B. */
export const EMBEDDING_DIM = 2560;

/** Default MMR lambda — balances relevance vs diversity (higher = more relevance). */
export const DEFAULT_RECALL_MMR_LAMBDA = 0.7;

/**
 * Row stored in LanceDB.
 *
 * `paths` and `symbols` are JSON-encoded `string[]` values because LanceDB
 * doesn't natively support nested/variable-length string arrays well.
 * Encode with `JSON.stringify(arr)`, decode with `JSON.parse(val)`.
 */
export interface RecallRow {
	vector: number[];
	text: string;
	role: "user" | "assistant" | "tool_result";
	turn: number;
	tool_name: string | null;
	/** JSON-encoded string[] of file paths referenced in this chunk. */
	paths: string | null;
	/** JSON-encoded string[] of symbols referenced in this chunk. */
	symbols: string | null;
	timestamp: number;
	/** Absolute CWD of the project that produced this row. */
	project_cwd: string;
	session_id: string;
}

/** Search result from LanceDB — extends RecallRow with distance (lower = closer). */
export interface RecallSearchResult extends RecallRow {
	_distance: number;
}

/** Input item for MMR reranking. */
export interface MmrCandidate<T> {
	vector: number[];
	score: number;
	data: T;
}
