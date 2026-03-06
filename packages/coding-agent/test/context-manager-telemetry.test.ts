import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentLifecycleRecord,
	type CompactionRecord,
	type ContextManagerMode,
	type RetryRecord,
	ShadowTelemetry,
	serializeRecord,
	type TelemetryRecord,
	TelemetryWriter,
	type ToolExecRecord,
	type TouchedPathRecord,
	type TurnRecord,
} from "@oh-my-pi/pi-coding-agent/context-manager";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function envelope(overrides?: Partial<TelemetryRecord>): TelemetryRecord {
	return {
		trace_id: "test-trace-id",
		turn_id: 1,
		mode: "shadow" as ContextManagerMode,
		ts: 1700000000000,
		event: "tool_exec",
		data: { tool: "bash", tool_call_id: "tc-1", phase: "start" },
		...overrides,
	} as TelemetryRecord;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telemetry-test-"));
});

afterEach(async () => {
	await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Serialization schema tests
// ═══════════════════════════════════════════════════════════════════════════

describe("telemetry serialization", () => {
	it("serializes a record to valid JSON", () => {
		const record = envelope();
		const json = serializeRecord(record);
		const parsed = JSON.parse(json);
		expect(parsed.trace_id).toBe("test-trace-id");
		expect(parsed.turn_id).toBe(1);
		expect(parsed.mode).toBe("shadow");
		expect(parsed.ts).toBe(1700000000000);
		expect(parsed.event).toBe("tool_exec");
		expect(parsed.data.tool).toBe("bash");
	});

	it("serializes all record types without error", () => {
		const records: TelemetryRecord[] = [
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "touched_path",
				data: { tool: "read", paths: ["/a/b.ts"] },
			} satisfies TouchedPathRecord,
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "tool_exec",
				data: { tool: "bash", tool_call_id: "c1", phase: "start" },
			} satisfies ToolExecRecord,
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "turn_boundary",
				data: { phase: "start" },
			} satisfies TurnRecord,
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "compaction",
				data: { phase: "start", reason: "threshold", action: "context-full" },
			} satisfies CompactionRecord,
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "retry",
				data: { phase: "start", attempt: 1, max_attempts: 3, delay_ms: 1000 },
			} satisfies RetryRecord,
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "context_snapshot",
				data: { message_count: 5, role_counts: { user: 2, assistant: 3 } },
			},
			{
				trace_id: "t",
				turn_id: 0,
				mode: "shadow",
				ts: 0,
				event: "agent_lifecycle",
				data: { phase: "start" },
			} satisfies AgentLifecycleRecord,
		];

		for (const record of records) {
			const line = serializeRecord(record);
			expect(() => JSON.parse(line)).not.toThrow();
			const parsed = JSON.parse(line);
			expect(parsed.trace_id).toBe("t");
			expect(parsed.event).toBe(record.event);
		}
	});

	it("produces single-line output (no embedded newlines)", () => {
		const record = envelope();
		const json = serializeRecord(record);
		expect(json).not.toContain("\n");
	});

	it("envelope fields are always present", () => {
		const record = envelope();
		const parsed = JSON.parse(serializeRecord(record));
		expect(parsed).toHaveProperty("trace_id");
		expect(parsed).toHaveProperty("turn_id");
		expect(parsed).toHaveProperty("mode");
		expect(parsed).toHaveProperty("ts");
		expect(parsed).toHaveProperty("event");
		expect(parsed).toHaveProperty("data");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// TelemetryWriter tests
// ═══════════════════════════════════════════════════════════════════════════

describe("TelemetryWriter", () => {
	it("creates the file and directory on first write", async () => {
		const filePath = path.join(tmpDir, "sub", "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		writer.write(envelope());
		await writer.close();

		expect(fs.existsSync(filePath)).toBe(true);
	});

	it("appends NDJSON lines", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);

		writer.write(envelope({ ts: 1 } as Partial<TelemetryRecord>));
		writer.write(envelope({ ts: 2 } as Partial<TelemetryRecord>));
		writer.write(envelope({ ts: 3 } as Partial<TelemetryRecord>));
		await writer.close();

		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(3);

		const records = lines.map(l => JSON.parse(l));
		expect(records[0].ts).toBe(1);
		expect(records[1].ts).toBe(2);
		expect(records[2].ts).toBe(3);
	});

	it("ignores writes after close", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);

		writer.write(envelope({ ts: 1 } as Partial<TelemetryRecord>));
		await writer.close();

		// This should be silently ignored
		writer.write(envelope({ ts: 2 } as Partial<TelemetryRecord>));

		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
	});

	it("close is idempotent", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		writer.write(envelope());

		await writer.close();
		await writer.close(); // Should not throw
		expect(writer.closed).toBe(true);
	});

	it("exposes filePath and closed state", () => {
		const filePath = path.join(tmpDir, "test.ndjson");
		const writer = new TelemetryWriter(filePath);
		expect(writer.filePath).toBe(filePath);
		expect(writer.closed).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// ShadowTelemetry observer tests
// ═══════════════════════════════════════════════════════════════════════════

describe("ShadowTelemetry", () => {
	it("records tool_execution_start and tool_execution_end events", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		telemetry.observer({ type: "turn_start" });
		telemetry.observer({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "read",
			args: { path: "/foo/bar.ts" },
		});
		telemetry.observer({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "read",
			result: { path: "/foo/bar.ts" },
			isError: false,
		});

		await telemetry.close();

		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3); // turn_start + tool_exec start + tool_exec end + touched_path

		const records = lines.map(l => JSON.parse(l));
		const toolRecords = records.filter((r: TelemetryRecord) => r.event === "tool_exec");
		expect(toolRecords).toHaveLength(2);
		expect(toolRecords[0].data.phase).toBe("start");
		expect(toolRecords[1].data.phase).toBe("end");
	});

	it("captures touched paths from tool_execution_end", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		telemetry.observer({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "read",
			result: { path: "/src/main.ts" },
		});

		await telemetry.close();

		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		const records = lines.map(l => JSON.parse(l));
		const pathRecords = records.filter((r: TelemetryRecord) => r.event === "touched_path");
		expect(pathRecords).toHaveLength(1);
		expect(pathRecords[0].data.paths).toContain("/src/main.ts");
	});

	it("increments turn_id on turn_start", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		expect(telemetry.turnId).toBe(0);

		telemetry.observer({ type: "turn_start" });
		expect(telemetry.turnId).toBe(1);

		telemetry.observer({ type: "turn_start" });
		expect(telemetry.turnId).toBe(2);

		await telemetry.close();
	});

	it("records compaction events", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		telemetry.observer({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		});
		telemetry.observer({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
		});

		await telemetry.close();

		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		const records = lines.map(l => JSON.parse(l));
		const compactionRecords = records.filter((r: TelemetryRecord) => r.event === "compaction");
		expect(compactionRecords).toHaveLength(2);
		expect(compactionRecords[0].data.phase).toBe("start");
		expect(compactionRecords[0].data.reason).toBe("threshold");
		expect(compactionRecords[1].data.phase).toBe("end");
	});

	it("records retry events (unresolved loops)", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		telemetry.observer({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "rate limit",
		});
		telemetry.observer({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});

		await telemetry.close();

		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		const records = lines.map(l => JSON.parse(l));
		const retryRecords = records.filter((r: TelemetryRecord) => r.event === "retry");
		expect(retryRecords).toHaveLength(2);
		expect(retryRecords[0].data.attempt).toBe(1);
		expect(retryRecords[0].data.max_attempts).toBe(3);
		expect(retryRecords[1].data.success).toBe(true);
	});

	it("records agent lifecycle events", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		telemetry.observer({ type: "agent_start" });
		telemetry.observer({ type: "agent_end", messages: [{}, {}, {}] as any[] });

		await telemetry.close();

		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		const records = lines.map(l => JSON.parse(l));
		const agentRecords = records.filter((r: TelemetryRecord) => r.event === "agent_lifecycle");
		expect(agentRecords).toHaveLength(2);
		expect(agentRecords[0].data.phase).toBe("start");
		expect(agentRecords[1].data.phase).toBe("end");
		expect(agentRecords[1].data.message_count).toBe(3);
	});

	it("includes correct mode in trace envelope", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		telemetry.observer({ type: "agent_start" });
		await telemetry.close();

		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		const record = JSON.parse(lines[0]);
		expect(record.mode).toBe("shadow");
		expect(record.trace_id).toBe("test-id");
	});

	it("ignores irrelevant events without error", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		// These events should be silently ignored
		telemetry.observer({ type: "message_start", message: {} } as any);
		telemetry.observer({ type: "message_end", message: {} } as any);
		telemetry.observer({ type: "message_update", message: {}, assistantMessageEvent: {} } as any);

		await telemetry.close();

		// File should not exist or be empty (no records written)
		const exists = fs.existsSync(filePath);
		if (exists) {
			const content = fs.readFileSync(filePath, "utf-8").trim();
			expect(content).toBe("");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-blocking failure behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("non-blocking failure behavior", () => {
	it("observer never throws even when writer is closed", () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		// Close the writer prematurely
		void writer.close();

		// Observer should not throw
		expect(() => {
			telemetry.observer({ type: "agent_start" });
			telemetry.observer({
				type: "tool_execution_start",
				toolCallId: "tc-1",
				toolName: "bash",
				args: {},
			});
		}).not.toThrow();
	});

	it("observer catches internal errors without propagating", () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		const telemetry = new ShadowTelemetry({ traceId: "test-id", mode: "shadow", writer });

		// Sabotage the writer to cause serialization failure
		const originalWrite = writer.write.bind(writer);
		writer.write = () => {
			throw new Error("Simulated write failure");
		};

		// Observer must not throw — telemetry failures are non-blocking
		expect(() => {
			telemetry.observer({ type: "agent_start" });
		}).not.toThrow();

		// Restore
		writer.write = originalWrite;
	});

	it("writer handles write to invalid path gracefully", async () => {
		// Use a path that can't be written to
		const writer = new TelemetryWriter("/dev/null/impossible/path/trace.ndjson");

		// write() should not throw — errors are logged
		expect(() => {
			writer.write(envelope());
		}).not.toThrow();

		await writer.close();
	});

	it("writer write after close is silently ignored", async () => {
		const filePath = path.join(tmpDir, "trace.ndjson");
		const writer = new TelemetryWriter(filePath);
		await writer.close();

		// Should not throw
		expect(() => writer.write(envelope())).not.toThrow();
	});
});
