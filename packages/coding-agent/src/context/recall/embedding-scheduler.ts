import { logger } from "@oh-my-pi/pi-utils";

export const DEFAULT_EMBEDDING_BATCH_TOKEN_BUDGET = 8_192;
const DEFAULT_MAX_CONCURRENT_BATCHES = 1;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const BACKLOG_WARNING_SEQUENCE_COUNT = 16;
const BACKLOG_WARNING_INTERVAL_MS = 30_000;

export interface EmbeddingQueueStatus {
	queuedSequences: number;
	inFlightSequences: number;
	pendingSequences: number;
	oldestPendingAgeMs: number;
	retryAttempts: number;
	failedSequences: number;
	lastError: string | null;
}

export interface EmbeddingSchedulerOptions {
	embed: (texts: string[]) => Promise<Float32Array[]>;
	batchTokenBudget?: number;
	maxConcurrentBatches?: number;
	maxAttempts?: number;
	retryBaseDelayMs?: number;
}

interface QueuedEmbedding {
	text: string;
	tokenCount: number;
	enqueuedAt: number;
	resolve: (value: Float32Array) => void;
	reject: (reason?: unknown) => void;
}

/** FIFO, token-budgeted request scheduler for background embedding work. */
export class EmbeddingScheduler {
	#embed: (texts: string[]) => Promise<Float32Array[]>;
	#batchTokenBudget: number;
	#maxConcurrentBatches: number;
	#maxAttempts: number;
	#retryBaseDelayMs: number;
	#queue: QueuedEmbedding[] = [];
	#activeBatches = 0;
	#inFlightSequences = 0;
	#activeEnqueuedAt: number[] = [];
	#idleWaiters = new Set<() => void>();
	#pumpScheduled = false;
	#retryAttempts = 0;
	#failedSequences = 0;
	#lastError: string | null = null;
	#lastBacklogWarningAt = 0;

	constructor(options: EmbeddingSchedulerOptions) {
		this.#embed = options.embed;
		this.#batchTokenBudget = normalizePositiveInteger(options.batchTokenBudget, DEFAULT_EMBEDDING_BATCH_TOKEN_BUDGET);
		this.#maxConcurrentBatches = normalizePositiveInteger(
			options.maxConcurrentBatches,
			DEFAULT_MAX_CONCURRENT_BATCHES,
		);
		this.#maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
		this.#retryBaseDelayMs = normalizeNonNegativeInteger(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
	}

	schedule(text: string, tokenCount: number): Promise<Float32Array> {
		if (tokenCount <= 0 || !Number.isFinite(tokenCount)) {
			return Promise.reject(new Error(`Embedding token count must be positive, got ${tokenCount}`));
		}

		const { promise, resolve, reject } = Promise.withResolvers<Float32Array>();
		this.#queue.push({ text, tokenCount, enqueuedAt: Date.now(), resolve, reject });
		this.#warnIfBacklogged();
		this.#schedulePump();
		return promise;
	}

	async drain(): Promise<void> {
		if (this.#isIdle()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#idleWaiters.add(resolve);
		await promise;
	}

	get status(): EmbeddingQueueStatus {
		const pendingSequences = this.#queue.length + this.#inFlightSequences;
		return {
			queuedSequences: this.#queue.length,
			inFlightSequences: this.#inFlightSequences,
			pendingSequences,
			oldestPendingAgeMs: this.#oldestPendingAgeMs(),
			retryAttempts: this.#retryAttempts,
			failedSequences: this.#failedSequences,
			lastError: this.#lastError,
		};
	}

	#schedulePump(): void {
		if (this.#pumpScheduled) return;
		this.#pumpScheduled = true;
		queueMicrotask(() => {
			this.#pumpScheduled = false;
			this.#pump();
		});
	}

	#pump(): void {
		while (this.#activeBatches < this.#maxConcurrentBatches && this.#queue.length > 0) {
			const batch = this.#takeBatch();
			const oldest = Math.min(...batch.map(item => item.enqueuedAt));
			this.#activeBatches++;
			this.#inFlightSequences += batch.length;
			this.#activeEnqueuedAt.push(oldest);
			void this.#runBatch(batch).finally(() => {
				this.#activeBatches--;
				this.#inFlightSequences -= batch.length;
				const oldestIndex = this.#activeEnqueuedAt.indexOf(oldest);
				if (oldestIndex >= 0) this.#activeEnqueuedAt.splice(oldestIndex, 1);
				this.#warnIfBacklogged();
				this.#pump();
				this.#resolveIdleWaiters();
			});
		}
		this.#resolveIdleWaiters();
	}

	#takeBatch(): QueuedEmbedding[] {
		const batch: QueuedEmbedding[] = [];
		let tokenCount = 0;

		while (this.#queue.length > 0) {
			const next = this.#queue[0];
			if (batch.length > 0 && tokenCount + next.tokenCount > this.#batchTokenBudget) break;
			batch.push(this.#queue.shift()!);
			tokenCount += next.tokenCount;
			if (tokenCount >= this.#batchTokenBudget) break;
		}

		return batch;
	}

	async #runBatch(batch: QueuedEmbedding[]): Promise<void> {
		for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
			try {
				const vectors = await this.#embed(batch.map(item => item.text));
				if (vectors.length !== batch.length) {
					throw new Error(`Embedding scheduler received ${vectors.length} vectors for ${batch.length} inputs`);
				}
				for (let index = 0; index < batch.length; index++) {
					batch[index].resolve(vectors[index]);
				}
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#lastError = message;
				if (attempt >= this.#maxAttempts) {
					this.#failedSequences += batch.length;
					for (const item of batch) item.reject(error);
					logger.warn("EmbeddingScheduler: batch failed after retries", {
						attempts: attempt,
						sequences: batch.length,
						tokens: batch.reduce((sum, item) => sum + item.tokenCount, 0),
						error: message,
					});
					return;
				}

				this.#retryAttempts++;
				const delayMs = this.#retryBaseDelayMs * 2 ** (attempt - 1);
				logger.warn("EmbeddingScheduler: retrying failed batch", {
					attempt,
					nextAttempt: attempt + 1,
					delayMs,
					sequences: batch.length,
					error: message,
				});
				await Bun.sleep(delayMs);
			}
		}
	}

	#warnIfBacklogged(): void {
		const status = this.status;
		if (status.pendingSequences < BACKLOG_WARNING_SEQUENCE_COUNT) return;
		const now = Date.now();
		if (now - this.#lastBacklogWarningAt < BACKLOG_WARNING_INTERVAL_MS) return;
		this.#lastBacklogWarningAt = now;
		logger.warn("EmbeddingScheduler: ingestion backlog active", {
			queuedSequences: status.queuedSequences,
			inFlightSequences: status.inFlightSequences,
			pendingSequences: status.pendingSequences,
			oldestPendingAgeMs: status.oldestPendingAgeMs,
			retryAttempts: status.retryAttempts,
			failedSequences: status.failedSequences,
			lastError: status.lastError,
		});
	}

	#oldestPendingAgeMs(): number {
		const candidates: number[] = [];
		if (this.#queue[0]) candidates.push(this.#queue[0].enqueuedAt);
		candidates.push(...this.#activeEnqueuedAt);
		if (candidates.length === 0) return 0;
		return Math.max(0, Date.now() - Math.min(...candidates));
	}

	#isIdle(): boolean {
		return this.#queue.length === 0 && this.#activeBatches === 0;
	}

	#resolveIdleWaiters(): void {
		if (!this.#isIdle()) return;
		for (const resolve of this.#idleWaiters) resolve();
		this.#idleWaiters.clear();
	}
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}
