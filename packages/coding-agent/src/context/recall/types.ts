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

/** Current-session recall content that must not be returned to the active prompt. */
export interface RecallContentExclusion {
	sessionId: string;
	contentKeys: ReadonlySet<string>;
}

/** Deterministic lookup key shared between semantic rows and lexical index rows. */
export interface RecallLookupKey {
	session_id: string;
	turn: number;
	role: RecallRow["role"];
	tool_name: string | null;
	text_hash: string;
}

/** Input item for MMR reranking. */
export interface MmrCandidate<T> {
	vector: number[];
	score: number;
	data: T;
}

export function hashRecallText(text: string): string {
	return Bun.hash(text).toString(16);
}

/** Content identity used to suppress duplicates independently of ingest turn numbering. */
export function buildRecallContentKey(input: Pick<RecallRow, "role" | "tool_name" | "text">): string {
	return `${input.role}:${input.tool_name ?? ""}:${hashRecallText(input.text)}`;
}

export function isRecallContentExcluded(
	input: Pick<RecallRow, "session_id" | "role" | "tool_name" | "text">,
	exclusion: RecallContentExclusion | undefined,
): boolean {
	return (
		exclusion !== undefined &&
		input.session_id === exclusion.sessionId &&
		exclusion.contentKeys.has(buildRecallContentKey(input))
	);
}

export function buildRecallLookupKey(
	input: Pick<RecallRow, "session_id" | "turn" | "role" | "tool_name" | "text">,
): RecallLookupKey {
	return {
		session_id: input.session_id,
		turn: input.turn,
		role: input.role,
		tool_name: input.tool_name,
		text_hash: hashRecallText(input.text),
	};
}

export function buildRecallRowKey(
	input: Pick<RecallRow, "session_id" | "turn" | "role" | "tool_name" | "text">,
): string {
	const key = buildRecallLookupKey(input);
	return `${key.session_id}:${key.turn}:${key.role}:${key.tool_name ?? ""}:${key.text_hash}`;
}
