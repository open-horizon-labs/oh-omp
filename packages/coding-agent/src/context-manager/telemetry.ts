/**
 * Shadow-mode context telemetry.
 *
 * Captures context-assembly-relevant signals as structured NDJSON traces
 * for offline analysis. In shadow mode, this module is observe-only:
 * it never mutates prompts or injects content into the agent loop.
 *
 * Trace records are bounded, redacted for safe local storage, and
 * written non-blockingly so telemetry failures never stall the agent.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { ContextManagerMode } from "../config/settings-schema";
import type { AgentSessionEvent } from "../session/agent-session";

// ═══════════════════════════════════════════════════════════════════════════
// Trace schema
// ═══════════════════════════════════════════════════════════════════════════

/** Correlation metadata present on every trace record. */
export interface TraceEnvelope {
	/** Session-scoped identifier (stable across turns within one session). */
	trace_id: string;
	/** Monotonic turn counter within the session. */
	turn_id: number;
	/** Active context-manager mode at time of capture. */
	mode: ContextManagerMode;
	/** Unix epoch milliseconds. */
	ts: number;
}

/** Paths and symbol hints observed from tool executions. */
export interface TouchedPathRecord extends TraceEnvelope {
	event: "touched_path";
	data: {
		tool: string;
		paths: string[];
	};
}

/** Tool execution lifecycle record. */
export interface ToolExecRecord extends TraceEnvelope {
	event: "tool_exec";
	data: {
		tool: string;
		tool_call_id: string;
		phase: "start" | "end";
		is_error?: boolean;
	};
}

/** Turn boundary record with budget/usage estimates. */
export interface TurnRecord extends TraceEnvelope {
	event: "turn_boundary";
	data: {
		phase: "start" | "end";
		message_count?: number;
		tool_result_count?: number;
	};
}
/** Auto-retry lifecycle record (unresolved loops). */
export interface RetryRecord extends TraceEnvelope {
	event: "retry";
	data: {
		phase: "start" | "end";
		attempt: number;
		max_attempts?: number;
		delay_ms?: number;
		success?: boolean;
		error?: string;
	};
}

/** Context event observation (candidate selection signals). */
export interface ContextRecord extends TraceEnvelope {
	event: "context_snapshot";
	data: {
		message_count: number;
		role_counts: Record<string, number>;
	};
}

/** Agent lifecycle record. */
export interface AgentLifecycleRecord extends TraceEnvelope {
	event: "agent_lifecycle";
	data: {
		phase: "start" | "end";
		message_count?: number;
	};
}

/** Union of all trace record types. */
export type TelemetryRecord =
	| TouchedPathRecord
	| ToolExecRecord
	| TurnRecord
	| RetryRecord
	| ContextRecord
	| AgentLifecycleRecord;

// ═══════════════════════════════════════════════════════════════════════════
// Serialization helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum length for a single serialized path to prevent unbounded storage. */
const MAX_PATH_LENGTH = 256;

/** Maximum number of paths captured per tool execution. */
const MAX_PATHS_PER_EVENT = 50;

/** Truncate and bound a path for safe storage. */
function sanitizePath(p: string): string {
	if (p.length <= MAX_PATH_LENGTH) return p;
	return `${p.slice(0, MAX_PATH_LENGTH - 3)}...`;
}

/** Serialize a trace record to a single NDJSON line. */
export function serializeRecord(record: TelemetryRecord): string {
	return JSON.stringify(record);
}

// ═══════════════════════════════════════════════════════════════════════════
// NDJSON writer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append-only NDJSON trace writer.
 *
 * Uses a non-blocking write queue: each write is fire-and-forget.
 * Failures are logged but never propagated to the caller.
 */
export class TelemetryWriter {
	#stream: fs.WriteStream | undefined;
	#filePath: string;
	#closed = false;

	constructor(filePath: string) {
		this.#filePath = filePath;
	}

	/** Lazily open the write stream on first write. */
	#ensureStream(): fs.WriteStream {
		if (!this.#stream) {
			const dir = path.dirname(this.#filePath);
			fs.mkdirSync(dir, { recursive: true });
			this.#stream = fs.createWriteStream(this.#filePath, { flags: "a" });
			this.#stream.on("error", err => {
				logger.error("Telemetry write error", { path: this.#filePath, error: String(err) });
			});
		}
		return this.#stream;
	}

	/** Append a record. Non-blocking, never throws. */
	write(record: TelemetryRecord): void {
		if (this.#closed) return;
		try {
			const line = `${serializeRecord(record)}\n`;
			this.#ensureStream().write(line);
		} catch (err) {
			logger.error("Telemetry serialization error", { error: String(err) });
		}
	}

	/** Flush and close the stream. Returns a promise for graceful shutdown. */
	async close(): Promise<void> {
		this.#closed = true;
		if (!this.#stream) return;
		const stream = this.#stream;
		this.#stream = undefined;
		const { promise, resolve } = Promise.withResolvers<void>();
		stream.end(resolve);
		return promise;
	}

	get filePath(): string {
		return this.#filePath;
	}

	get closed(): boolean {
		return this.#closed;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Shadow telemetry observer
// ═══════════════════════════════════════════════════════════════════════════

/** Options for creating a ShadowTelemetry instance. */
export interface ShadowTelemetryOptions {
	/** Session-scoped trace ID for correlation. */
	traceId: string;
	/** Active context-manager mode. */
	mode: ContextManagerMode;
	/** Destination for NDJSON traces. If omitted, uses default trace directory. */
	writer?: TelemetryWriter;
}

/**
 * Generate the default trace file path for a session.
 * Traces live under `~/.omp/traces/` with date + trace_id scoping.
 */
export function getTraceFilePath(traceId: string, date = new Date()): string {
	const dateStr = date.toISOString().slice(0, 10);
	return path.join(getAgentDir(), "traces", `${dateStr}_${traceId}.ndjson`);
}

/**
 * Shadow-mode telemetry observer.
 *
 * Subscribes to AgentSessionEvents and writes structured trace records.
 * Observe-only: never mutates events, never injects into prompts.
 *
 * Usage:
 * ```ts
 * const telemetry = new ShadowTelemetry({ traceId: sessionId, mode: "shadow" });
 * const unsub = agentSession.subscribe(telemetry.observer);
 * // ... on shutdown:
 * unsub();
 * await telemetry.close();
 * ```
 */
export class ShadowTelemetry {
	#writer: TelemetryWriter;
	#traceId: string;
	#mode: ContextManagerMode;
	#turnId = 0;

	constructor(options: ShadowTelemetryOptions) {
		this.#traceId = options.traceId;
		this.#mode = options.mode;
		this.#writer = options.writer ?? new TelemetryWriter(getTraceFilePath(options.traceId));
	}

	/** Create the envelope for the current state. */
	#envelope(): TraceEnvelope {
		return {
			trace_id: this.#traceId,
			turn_id: this.#turnId,
			mode: this.#mode,
			ts: Date.now(),
		};
	}

	/** Emit a record via the writer. */
	#record(record: TelemetryRecord): void {
		this.#writer.write(record);
	}

	/**
	 * Event observer — pass this to `agentSession.subscribe()`.
	 *
	 * Arrow function to preserve `this` binding.
	 */
	observer = (event: AgentSessionEvent): void => {
		try {
			this.#handleEvent(event);
		} catch (err) {
			// Telemetry must never throw into the agent loop.
			logger.error("Shadow telemetry observer error", { error: String(err) });
		}
	};

	#handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			// ── Agent lifecycle ─────────────────────────────────────────────
			case "agent_start":
				this.#record({
					...this.#envelope(),
					event: "agent_lifecycle",
					data: { phase: "start" },
				});
				break;

			case "agent_end":
				this.#record({
					...this.#envelope(),
					event: "agent_lifecycle",
					data: {
						phase: "end",
						message_count: event.messages.length,
					},
				});
				break;

			// ── Turn lifecycle ──────────────────────────────────────────────
			case "turn_start":
				this.#turnId++;
				this.#record({
					...this.#envelope(),
					event: "turn_boundary",
					data: { phase: "start" },
				});
				break;

			case "turn_end":
				this.#record({
					...this.#envelope(),
					event: "turn_boundary",
					data: {
						phase: "end",
						tool_result_count: event.toolResults.length,
					},
				});
				break;

			// ── Tool execution ──────────────────────────────────────────────
			case "tool_execution_start":
				this.#record({
					...this.#envelope(),
					event: "tool_exec",
					data: {
						tool: event.toolName,
						tool_call_id: event.toolCallId,
						phase: "start",
					},
				});
				break;

			case "tool_execution_end": {
				this.#record({
					...this.#envelope(),
					event: "tool_exec",
					data: {
						tool: event.toolName,
						tool_call_id: event.toolCallId,
						phase: "end",
						is_error: event.isError ?? false,
					},
				});

				// Extract touched paths from tool args.
				const paths = extractPaths(event);
				if (paths.length > 0) {
					this.#record({
						...this.#envelope(),
						event: "touched_path",
						data: {
							tool: event.toolName,
							paths: paths.slice(0, MAX_PATHS_PER_EVENT).map(sanitizePath),
						},
					});
				}
				break;
			}

			// ── Retry loops ─────────────────────────────────────────────────
			case "auto_retry_start":
				this.#record({
					...this.#envelope(),
					event: "retry",
					data: {
						phase: "start",
						attempt: event.attempt,
						max_attempts: event.maxAttempts,
						delay_ms: event.delayMs,
						error: event.errorMessage,
					},
				});
				break;

			case "auto_retry_end":
				this.#record({
					...this.#envelope(),
					event: "retry",
					data: {
						phase: "end",
						attempt: event.attempt,
						success: event.success,
						error: event.finalError,
					},
				});
				break;

			// Remaining events: not assembly-relevant, skip.
			default:
				break;
		}
	}

	/** Flush and close. Call on session shutdown. */
	async close(): Promise<void> {
		return this.#writer.close();
	}

	/** Expose writer for testing. */
	get writer(): TelemetryWriter {
		return this.#writer;
	}

	get traceId(): string {
		return this.#traceId;
	}

	get mode(): ContextManagerMode {
		return this.#mode;
	}

	get turnId(): number {
		return this.#turnId;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Path extraction from tool events
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract file paths from a tool_execution_end event.
 * Examines known tool arg shapes (bash cwd, read/write/edit/grep/find path, etc.).
 */
function extractPaths(event: { toolName: string; result: unknown }): string[] {
	const paths: string[] = [];

	// The result is often an object with details or input metadata.
	// We inspect the result for common path fields.
	const result = event.result;
	if (result && typeof result === "object") {
		const obj = result as Record<string, unknown>;

		// Direct path field
		if (typeof obj.path === "string") {
			paths.push(obj.path);
		}

		// Array of paths (e.g., find results)
		if (Array.isArray(obj.paths)) {
			for (const p of obj.paths) {
				if (typeof p === "string") paths.push(p);
			}
		}

		// File paths from edit tool
		if (typeof obj.filePath === "string") {
			paths.push(obj.filePath);
		}
	}

	return paths;
}
