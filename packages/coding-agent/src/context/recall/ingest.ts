/**
 * Ingest pipeline: persists and embeds all messages (user, assistant, tool results)
 * into LanceDB via the recall store.
 *
 * Embedding is async and non-blocking. Failed embeddings log a warning but do not
 * crash the agent. An in-flight guard prevents unbounded background task spawning.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { embed } from "./embed";
import type { RecallStore } from "./store";
import type { RecallRow } from "./types";

/** Maximum concurrent embedding requests allowed in flight. */
const MAX_IN_FLIGHT = 4;

export interface IngestPipelineOptions {
	store: RecallStore;
	license: string;
	sessionId: string;
	projectCwd: string;
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
	#license: string;
	#sessionId: string;
	#projectCwd: string;
	#inFlight = 0;
	#dropped = 0;

	constructor(options: IngestPipelineOptions) {
		this.#store = options.store;
		this.#license = options.license;
		this.#sessionId = options.sessionId;
		this.#projectCwd = options.projectCwd;
	}

	/**
	 * Ingest a message: embed it async, then store in LanceDB.
	 * Non-blocking — fires and forgets the background task.
	 * Returns immediately.
	 */
	ingest(item: IngestItem): void {
		// Skip empty text
		if (!item.text || item.text.trim().length === 0) return;

		// In-flight guard: drop if too many concurrent embeds
		if (this.#inFlight >= MAX_IN_FLIGHT) {
			this.#dropped++;
			logger.debug("IngestPipeline: dropping item (in-flight limit)", {
				role: item.role,
				turn: item.turn,
				dropped: this.#dropped,
			});
			return;
		}

		this.#inFlight++;
		this.#embedAndStore(item).finally(() => {
			this.#inFlight--;
		});
	}

	/** Number of items dropped due to in-flight limit. */
	get dropped(): number {
		return this.#dropped;
	}

	/** Number of items currently being embedded. */
	get inFlight(): number {
		return this.#inFlight;
	}

	async #embedAndStore(item: IngestItem): Promise<void> {
		try {
			const vectors = await embed([item.text], this.#license);
			const vector = vectors[0];

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

			await this.#store.insert([row]);
			logger.debug("IngestPipeline: stored row", {
				role: item.role,
				turn: item.turn,
				textLen: item.text.length,
			});
		} catch (err) {
			// Failed embedding does not crash the agent
			logger.warn("IngestPipeline: embed/store failed", {
				role: item.role,
				turn: item.turn,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
