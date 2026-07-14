import { type Encoding, Tokenizer } from "@huggingface/tokenizers";
import tokenizerJson from "./assets/qwen3-embedding-4b-tokenizer.json" with { type: "json" };
import tokenizerConfig from "./assets/qwen3-embedding-4b-tokenizer-config.json" with { type: "json" };
import { EMBEDDING_DIM } from "./types";

export type EmbeddingQueryTruncation = "head" | "tail";

export interface EmbeddingDocumentChunk {
	text: string;
	tokenCount: number;
}

export interface PreparedEmbeddingQuery {
	text: string;
	tokenCount: number;
	originalTokenCount: number;
	truncated: boolean;
}

/** Model semantics kept separate from the embedding transport and request scheduler. */
export interface EmbeddingModelProfile {
	id: string;
	model: string;
	dimension: number;
	maxSequenceTokens: number;
	documentChunkTokens: number;
	queryTokens: number;
	countTokens(text: string): number;
	chunkDocument(text: string, maxTokens?: number): EmbeddingDocumentChunk[];
	prepareQuery(text: string, truncation?: EmbeddingQueryTruncation): PreparedEmbeddingQuery;
}

export const QWEN3_EMBEDDING_TOKENIZER_REVISION = "5cf2132abc99cad020ac570b19d031efec650f2b";

/**
 * Qwen3-Embedding-4B profile for the model currently served by Memex.
 *
 * Documents and interactive queries deliberately use smaller budgets than the
 * model's full context. Background documents use 2,048-token semantic units so
 * the default 8,192-token request can carry four chunks, while latency-sensitive
 * queries retain a smaller 1,024-token window.
 */
class Qwen3Embedding4BProfile implements EmbeddingModelProfile {
	readonly id = "qwen3-embedding-4b";
	readonly model = "qwen3-embedding-4b";
	readonly dimension = EMBEDDING_DIM;
	readonly maxSequenceTokens = 32_768;
	readonly documentChunkTokens = 2_048;
	readonly queryTokens = 1_024;
	#tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

	countTokens(text: string): number {
		return this.#encode(text).ids.length;
	}

	chunkDocument(text: string, maxTokens?: number): EmbeddingDocumentChunk[] {
		const tokenBudget = normalizeDocumentTokenBudget(maxTokens, this.documentChunkTokens);
		const encoded = this.#encode(text);
		if (encoded.ids.length === 0) return [];
		if (encoded.ids.length <= tokenBudget) {
			return [{ text, tokenCount: encoded.ids.length }];
		}

		return this.#splitAtSemanticBoundaries(encoded.ids, tokenBudget);
	}

	prepareQuery(text: string, truncation: EmbeddingQueryTruncation = "tail"): PreparedEmbeddingQuery {
		const encoded = this.#encode(text);
		const originalTokenCount = encoded.ids.length;
		if (originalTokenCount <= this.queryTokens) {
			return { text, tokenCount: originalTokenCount, originalTokenCount, truncated: false };
		}

		let tokenIds: number[];
		if (truncation === "head") {
			const end = this.#findRoundTripEnd(encoded.ids, 0, this.queryTokens);
			tokenIds = encoded.ids.slice(0, end);
		} else {
			const start = this.#findRoundTripStart(encoded.ids, encoded.ids.length - this.queryTokens, encoded.ids.length);
			tokenIds = encoded.ids.slice(start);
		}
		let preparedText = this.#tokenizer.decode(tokenIds);
		let tokenCount = this.countTokens(preparedText);
		while (tokenCount > this.queryTokens && tokenIds.length > 1) {
			tokenIds = truncation === "head" ? tokenIds.slice(0, -1) : tokenIds.slice(1);
			preparedText = this.#tokenizer.decode(tokenIds);
			tokenCount = this.countTokens(preparedText);
		}
		return {
			text: preparedText,
			tokenCount,
			originalTokenCount,
			truncated: true,
		};
	}

	#encode(text: string): Encoding {
		// llama.cpp's /tokenize endpoint does not add Qwen special tokens for this
		// embeddings deployment, so the local budget must use the same behavior.
		return this.#tokenizer.encode(text, { add_special_tokens: false });
	}

	#splitAtSemanticBoundaries(tokenIds: number[], tokenBudget: number): EmbeddingDocumentChunk[] {
		const chunks: EmbeddingDocumentChunk[] = [];
		let tokenCursor = 0;

		while (tokenCursor < tokenIds.length) {
			const targetEnd = Math.min(tokenCursor + tokenBudget, tokenIds.length);
			let tokenEnd = this.#findRoundTripEnd(tokenIds, tokenCursor, targetEnd);
			let chunkText = this.#tokenizer.decode(tokenIds.slice(tokenCursor, tokenEnd));

			if (tokenEnd < tokenIds.length) {
				const semanticEnd = findSemanticBoundary(chunkText);
				if (semanticEnd > 0 && semanticEnd < chunkText.length) {
					const semanticText = chunkText.slice(0, semanticEnd);
					const semanticIds = this.#encode(semanticText).ids;
					if (
						semanticIds.length > 0 &&
						semanticIds.length <= tokenBudget &&
						idsEqual(semanticIds, tokenIds, tokenCursor)
					) {
						tokenEnd = tokenCursor + semanticIds.length;
						chunkText = semanticText;
					}
				}
			}

			const tokenCount = this.countTokens(chunkText);
			chunks.push({ text: chunkText, tokenCount });
			tokenCursor = tokenEnd;
		}

		return chunks;
	}

	#findRoundTripEnd(tokenIds: number[], start: number, targetEnd: number): number {
		for (let end = targetEnd; end > start; end--) {
			const candidateIds = tokenIds.slice(start, end);
			const decoded = this.#tokenizer.decode(candidateIds);
			if (idsEqual(this.#encode(decoded).ids, candidateIds, 0)) return end;
		}
		throw new Error("Qwen tokenizer could not find a round-trip-safe chunk boundary");
	}

	#findRoundTripStart(tokenIds: number[], targetStart: number, end: number): number {
		for (let start = targetStart; start < end; start++) {
			const candidateIds = tokenIds.slice(start, end);
			const decoded = this.#tokenizer.decode(candidateIds);
			if (idsEqual(this.#encode(decoded).ids, candidateIds, 0)) return start;
		}
		throw new Error("Qwen tokenizer could not find a round-trip-safe query boundary");
	}
}

function idsEqual(expected: number[], actual: number[], actualOffset: number): boolean {
	if (expected.length + actualOffset > actual.length) return false;
	for (let index = 0; index < expected.length; index++) {
		if (expected[index] !== actual[index + actualOffset]) return false;
	}
	return true;
}

function findSemanticBoundary(text: string): number {
	const minimumEnd = Math.floor(text.length * 0.6);
	const candidate = text.slice(minimumEnd);

	const paragraph = candidate.lastIndexOf("\n\n");
	if (paragraph >= 0) return minimumEnd + paragraph + 2;

	const newline = candidate.lastIndexOf("\n");
	if (newline >= 0) return minimumEnd + newline + 1;

	let sentenceEnd = -1;
	for (const match of candidate.matchAll(/[.!?。！？][\])}"']?\s+/gu)) {
		sentenceEnd = match.index + match[0].length;
	}
	if (sentenceEnd >= 0) return minimumEnd + sentenceEnd;

	const whitespace = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
	if (whitespace >= 0) return minimumEnd + whitespace + 1;

	return text.length;
}

export const qwen3EmbeddingProfile: EmbeddingModelProfile = new Qwen3Embedding4BProfile();

function normalizeDocumentTokenBudget(value: number | undefined, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return maximum;
	return Math.min(maximum, Math.max(1, Math.floor(value)));
}
