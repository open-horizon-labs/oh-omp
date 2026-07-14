/**
 * Ingest pipeline: persists semantic recall rows in LanceDB and lexical recall
 * rows in SQLite. Tool-result semantic ingestion can be disabled independently
 * while retaining exact keyword recall.
 *
 * Embedding is async and non-blocking. Oversized messages are tokenized with the
 * active model profile, scheduled as token-budgeted batches, and pooled back to
 * one vector per original message. Queue pressure defers work; it never sheds it.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { embed } from "./embed";
import {
	DEFAULT_EMBEDDING_BATCH_TOKEN_BUDGET,
	type EmbeddingQueueStatus,
	EmbeddingScheduler,
} from "./embedding-scheduler";
import { type EmbeddingDocumentChunk, type EmbeddingModelProfile, qwen3EmbeddingProfile } from "./model-profile";
import type { RecallStore } from "./store";
import type { ToolResultStore } from "./tool-result-store";
import { buildRecallRowKey, type RecallRow } from "./types";

export interface IngestPipelineOptions {
	store: RecallStore;
	toolResultStore?: ToolResultStore;
	license: string;
	sessionId: string;
	projectCwd: string;
	embedToolResults?: boolean;
	modelProfile?: EmbeddingModelProfile;
	batchTokenBudget?: number;
	maxConcurrentBatches?: number;
	maxAttempts?: number;
	retryBaseDelayMs?: number;
}

export interface IngestItem {
	text: string;
	role: RecallRow["role"];
	turn: number;
	toolName?: string;
	paths?: string[];
	symbols?: string[];
}

export class IngestPipeline {
	#store: RecallStore;
	#toolResultStore?: ToolResultStore;
	#sessionId: string;
	#projectCwd: string;
	#embedToolResults: boolean;
	#modelProfile: EmbeddingModelProfile;
	#documentChunkTokens: number;
	#scheduler: EmbeddingScheduler;
	#pendingTasks = new Set<Promise<void>>();
	#storeTail: Promise<void> = Promise.resolve();
	#failedItems = 0;

	constructor(options: IngestPipelineOptions) {
		this.#store = options.store;
		this.#toolResultStore = options.toolResultStore;
		this.#sessionId = options.sessionId;
		this.#projectCwd = options.projectCwd;
		this.#embedToolResults = options.embedToolResults ?? false;
		this.#modelProfile = options.modelProfile ?? qwen3EmbeddingProfile;
		const batchTokenBudget = normalizeBatchTokenBudget(options.batchTokenBudget);
		this.#documentChunkTokens = Math.min(this.#modelProfile.documentChunkTokens, batchTokenBudget);
		this.#scheduler = new EmbeddingScheduler({
			embed: texts => embed(texts, options.license),
			batchTokenBudget,
			maxConcurrentBatches: options.maxConcurrentBatches,
			maxAttempts: options.maxAttempts,
			retryBaseDelayMs: options.retryBaseDelayMs,
		});
	}

	/** Queue a message for semantic and/or exact recall without blocking the caller. */
	ingest(item: IngestItem): void {
		if (!item.text || item.text.trim().length === 0) return;

		if (item.role === "tool_result") {
			this.#track(Promise.resolve().then(() => this.#indexToolResult(item)));
			if (!this.#embedToolResults) {
				logger.debug("IngestPipeline: tool result semantic embedding disabled", {
					sessionId: this.#sessionId,
					toolName: item.toolName ?? null,
					turn: item.turn,
				});
				return;
			}
		}

		const chunks = this.#modelProfile.chunkDocument(item.text, this.#documentChunkTokens);
		if (chunks.length === 0) return;
		this.#track(this.#embedAndStore(item, chunks));
	}

	/** Wait until all queued embeddings, stores, and exact-index writes settle. */
	async drain(): Promise<void> {
		while (this.#pendingTasks.size > 0) {
			await Promise.allSettled(Array.from(this.#pendingTasks));
		}
		await this.#scheduler.drain();
	}

	/** Compatibility metric: queue pressure no longer drops ingestion items. */
	get dropped(): number {
		return 0;
	}

	get inFlight(): number {
		return this.#scheduler.status.inFlightSequences;
	}

	get queued(): number {
		return this.#scheduler.status.queuedSequences;
	}

	get pendingItems(): number {
		return this.#pendingTasks.size;
	}

	get failedItems(): number {
		return this.#failedItems;
	}

	get queueStatus(): EmbeddingQueueStatus {
		return this.#scheduler.status;
	}

	#track(task: Promise<void>): void {
		this.#pendingTasks.add(task);
		void task.then(
			() => this.#pendingTasks.delete(task),
			() => this.#pendingTasks.delete(task),
		);
	}

	#indexToolResult(item: IngestItem): void {
		if (!this.#toolResultStore) {
			if (!this.#embedToolResults) {
				logger.warn("IngestPipeline: tool result FTS unavailable while semantic embedding is disabled", {
					role: item.role,
					sessionId: this.#sessionId,
					toolName: item.toolName ?? null,
					turn: item.turn,
				});
			}
			return;
		}

		try {
			this.#toolResultStore.indexSync({
				content: item.text,
				role: item.role,
				toolName: item.toolName ?? null,
				sessionId: this.#sessionId,
				projectCwd: this.#projectCwd,
				turnNumber: item.turn,
				paths: item.paths ?? [],
				rowKey: buildRecallRowKey({
					text: item.text,
					role: item.role,
					turn: item.turn,
					tool_name: item.toolName ?? null,
					session_id: this.#sessionId,
				}),
			});
		} catch (error) {
			logger.warn("IngestPipeline: tool result FTS indexing failed", {
				error: error instanceof Error ? error.message : String(error),
				role: item.role,
				sessionId: this.#sessionId,
				toolName: item.toolName ?? null,
				turn: item.turn,
			});
		}
	}

	async #embedAndStore(item: IngestItem, chunks: EmbeddingDocumentChunk[]): Promise<void> {
		try {
			const vectors = await Promise.all(chunks.map(chunk => this.#scheduler.schedule(chunk.text, chunk.tokenCount)));
			const vector = poolChunkEmbeddings(vectors, chunks);
			const row: RecallRow = {
				vector: Array.from(vector),
				text: item.text,
				role: item.role,
				turn: item.turn,
				tool_name: item.toolName ?? null,
				paths: item.paths && item.paths.length > 0 ? JSON.stringify(item.paths) : null,
				symbols: item.symbols && item.symbols.length > 0 ? JSON.stringify(item.symbols) : null,
				project_cwd: this.#projectCwd,
				timestamp: Date.now(),
				session_id: this.#sessionId,
			};

			await this.#serializeStore(() => this.#storeRow(row, item));
			logger.debug("IngestPipeline: stored row", {
				role: item.role,
				turn: item.turn,
				textLen: item.text.length,
				chunks: chunks.length,
				tokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
			});
		} catch (error) {
			this.#failedItems++;
			logger.warn("IngestPipeline: embed/store failed", {
				role: item.role,
				turn: item.turn,
				failedItems: this.#failedItems,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#serializeStore(write: () => Promise<void>): Promise<void> {
		const pending = this.#storeTail.then(write);
		this.#storeTail = pending.catch(() => {});
		return pending;
	}

	async #storeRow(row: RecallRow, item: IngestItem): Promise<void> {
		await this.#store.insert([row]);
		if (this.#toolResultStore && item.role !== "tool_result") {
			this.#toolResultStore.indexSync({
				content: item.text,
				role: item.role,
				toolName: item.toolName ?? null,
				sessionId: this.#sessionId,
				projectCwd: this.#projectCwd,
				turnNumber: item.turn,
				paths: item.paths ?? [],
				rowKey: buildRecallRowKey(row),
			});
		}
	}
}

function poolChunkEmbeddings(vectors: Float32Array[], chunks: EmbeddingDocumentChunk[]): Float32Array {
	if (vectors.length === 1) return vectors[0];
	const dimension = vectors[0]?.length ?? 0;
	const pooled = new Float32Array(dimension);
	for (let chunkIndex = 0; chunkIndex < vectors.length; chunkIndex++) {
		const vector = vectors[chunkIndex];
		const weight = chunks[chunkIndex].tokenCount;
		for (let dimensionIndex = 0; dimensionIndex < dimension; dimensionIndex++) {
			pooled[dimensionIndex] += vector[dimensionIndex] * weight;
		}
	}

	let squaredNorm = 0;
	for (const value of pooled) squaredNorm += value * value;
	const norm = Math.sqrt(squaredNorm);
	if (norm > 0) {
		for (let index = 0; index < pooled.length; index++) pooled[index] /= norm;
	}
	return pooled;
}

function normalizeBatchTokenBudget(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_EMBEDDING_BATCH_TOKEN_BUDGET;
	return Math.max(1, Math.floor(value));
}
