import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args";
import {
	getProjectionRpcDisabledResponse,
	handleGetProjection,
	handlePublishProjection,
	handleSubmitProjectionIntervention,
	PROJECTION_INTERVENTION_CUSTOM_TYPE,
	type ProjectionContextSink,
	type ProjectionInterventionMessage,
} from "../src/modes/rpc/projection-rpc";
import { ProjectionRuntime } from "../src/modes/rpc/projection-runtime";

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		projectionId: "board-1",
		revision: 1,
		view: {
			kind: "isolated-html",
			html: "<p>secret</p>",
			css: "body{color:red}",
			js: "window.parent.postMessage('no','*')",
		},
		operations: [
			{ id: "keep", label: "Keep" },
			{ id: "drop", label: "Drop" },
		],
		...overrides,
	};
}

function intervention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		projectionId: "board-1",
		observedRevision: 1,
		operationId: "keep",
		idempotencyKey: "op-1",
		...overrides,
	};
}

function recordingSink() {
	const messages: ProjectionInterventionMessage[] = [];
	const options: Array<{ triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined> = [];
	const sink: ProjectionContextSink = {
		async sendCustomMessage(message, messageOptions) {
			messages.push(message);
			options.push(messageOptions);
		},
	};
	return { sink, messages, options };
}

describe("projection RPC gate", () => {
	test("is default-off at the real CLI parser boundary and correlates disabled commands", () => {
		const disabledArgs = parseArgs(["--mode", "rpc"]);
		expect(disabledArgs.experimentalProjections).toBeUndefined();
		expect(disabledArgs.unknownFlags.has("experimental-projections")).toBe(false);

		for (const type of ["publish_projection", "get_projection", "submit_projection_intervention"] as const) {
			const response = getProjectionRpcDisabledResponse(
				{ id: `request-${type}`, type },
				disabledArgs.experimentalProjections === true,
			);

			expect(response).toEqual({
				id: `request-${type}`,
				type: "response",
				command: type,
				success: false,
				error: "Projection RPC commands are disabled; pass --experimental-projections to enable them",
			});
		}

		const enabledArgs = parseArgs(["--mode", "rpc", "--experimental-projections"]);
		expect(enabledArgs.experimentalProjections).toBe(true);
		expect(
			getProjectionRpcDisabledResponse(
				{ id: "enabled", type: "get_projection" },
				enabledArgs.experimentalProjections === true,
			),
		).toBeUndefined();
	});
});

describe("handlePublishProjection", () => {
	test("emits metadata-only projection_published on accept and does not put view bytes on the event", () => {
		const runtime = new ProjectionRuntime();
		const result = handlePublishProjection(runtime, { snapshot: snapshot() });
		expect(result.data).toEqual({
			status: "accepted",
			projectionId: "board-1",
			revision: 1,
		});
		expect(result.event).toEqual({
			type: "projection_published",
			projectionId: "board-1",
			revision: 1,
			operationCount: 2,
		});
		expect(result.event).not.toHaveProperty("html");
		expect(result.event).not.toHaveProperty("css");
		expect(result.event).not.toHaveProperty("js");
		expect(result.event).not.toHaveProperty("view");
		expect(result.event).not.toHaveProperty("state");
		expect(result.event).not.toHaveProperty("snapshot");
	});

	test("does not emit an event for conflict or invalid publish", () => {
		const runtime = new ProjectionRuntime();
		handlePublishProjection(runtime, { snapshot: snapshot() });
		const conflict = handlePublishProjection(runtime, {
			snapshot: snapshot({ view: { kind: "isolated-html", html: "<p>other</p>" } }),
		});
		expect(conflict.data.status).toBe("conflict");
		expect(conflict.event).toBeUndefined();

		const invalid = handlePublishProjection(runtime, { snapshot: { version: 2 } });
		expect(invalid.data.status).toBe("invalid");
		expect(invalid.event).toBeUndefined();
	});
});

describe("handleGetProjection", () => {
	test("returns null when the projection has not been published", () => {
		const runtime = new ProjectionRuntime();
		const result = handleGetProjection(runtime, { projectionId: "missing" });
		expect(result).toEqual({ data: null });
	});

	test("rejects malformed projection IDs using the projection contract", () => {
		const runtime = new ProjectionRuntime();
		const malformedIds: unknown[] = [undefined, 42, "", "x".repeat(129), "\ud800"];

		for (const projectionId of malformedIds) {
			expect(() => handleGetProjection(runtime, { projectionId })).toThrow();
		}
	});

	test("returns a copied published snapshot", () => {
		const runtime = new ProjectionRuntime();
		handlePublishProjection(runtime, { snapshot: snapshot() });

		const result = handleGetProjection(runtime, { projectionId: "board-1" });
		const stored = runtime.get("board-1");
		if (result.data === null || stored === undefined) throw new Error("expected published snapshot");

		expect(result.data).toEqual(stored);
		expect(result.data).not.toBe(stored);

		result.data.view.html = "<p>mutated</p>";
		expect(stored.view.html).toBe("<p>secret</p>");
		expect(runtime.get("board-1")?.view.html).toBe("<p>secret</p>");
	});
});

describe("handleSubmitProjectionIntervention", () => {
	test("records then emits a compact custom message and ACKs accepted", async () => {
		const runtime = new ProjectionRuntime();
		handlePublishProjection(runtime, { snapshot: snapshot() });
		const { sink, messages, options } = recordingSink();
		const result = await handleSubmitProjectionIntervention(runtime, { intervention: intervention() }, sink);
		expect(result.data).toEqual({
			status: "accepted",
			projectionId: "board-1",
			revision: 1,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]?.customType).toBe(PROJECTION_INTERVENTION_CUSTOM_TYPE);
		expect(messages[0]?.attribution).toBe("user");
		expect(messages[0]?.display).toBe(false);
		expect(messages[0]?.content).toBe("projection_intervention board-1#1 keep");
		expect(messages[0]?.details).toEqual({
			projectionId: "board-1",
			observedRevision: 1,
			operationId: "keep",
			idempotencyKey: "op-1",
		});
		expect(JSON.stringify(messages[0])).not.toContain("<p>secret</p>");
		expect(options[0]).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
	});

	test("does not re-emit context on duplicate retry", async () => {
		const runtime = new ProjectionRuntime();
		handlePublishProjection(runtime, { snapshot: snapshot() });
		const { sink, messages } = recordingSink();
		expect(
			(await handleSubmitProjectionIntervention(runtime, { intervention: intervention() }, sink)).data.status,
		).toBe("accepted");
		const again = await handleSubmitProjectionIntervention(runtime, { intervention: intervention() }, sink);
		expect(again.data.status).toBe("duplicate");
		expect(messages).toHaveLength(1);
	});

	test("ACKs accepted when context emit throws after record", async () => {
		const runtime = new ProjectionRuntime();
		handlePublishProjection(runtime, { snapshot: snapshot() });
		const sink: ProjectionContextSink = {
			async sendCustomMessage() {
				throw new Error("context unavailable");
			},
		};
		const result = await handleSubmitProjectionIntervention(runtime, { intervention: intervention() }, sink);
		expect(result.data.status).toBe("accepted");
		const { sink: secondSink, messages } = recordingSink();
		const retry = await handleSubmitProjectionIntervention(runtime, { intervention: intervention() }, secondSink);
		expect(retry.data.status).toBe("duplicate");
		expect(messages).toHaveLength(0);
	});

	test("includes parser-normalized input in details without view bytes", async () => {
		const runtime = new ProjectionRuntime();
		handlePublishProjection(runtime, { snapshot: snapshot() });
		const { sink, messages } = recordingSink();
		await handleSubmitProjectionIntervention(
			runtime,
			{ intervention: intervention({ input: { region: "header" } }) },
			sink,
		);
		expect(messages[0]?.details.input).toEqual({ region: "header" });
		expect(JSON.stringify(messages[0]?.details)).not.toContain("secret");
	});
});
