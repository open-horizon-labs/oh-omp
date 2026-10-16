import { describe, expect, test } from "bun:test";
import { ProjectionRuntime } from "../src/modes/rpc/projection-runtime";

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		projectionId: "board-1",
		revision: 1,
		view: {
			kind: "isolated-html",
			html: "<p>one</p>",
		},
		operations: [{ id: "keep", label: "Keep" }],
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

describe("ProjectionRuntime publish", () => {
	test("accepts a new projection and returns it from get", () => {
		const runtime = new ProjectionRuntime();
		const result = runtime.publish(snapshot());
		expect(result.status).toBe("accepted");
		if (result.status !== "accepted") return;
		expect(result.snapshot.projectionId).toBe("board-1");
		expect(result.snapshot.revision).toBe(1);
		expect(runtime.get("board-1")?.revision).toBe(1);
	});

	test("treats identical same-revision republish as accepted, not duplicate", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const again = runtime.publish(snapshot());
		expect(again.status).toBe("accepted");
		if (again.status !== "accepted") return;
		expect(again.snapshot.revision).toBe(1);
	});

	test("conflicts when the same revision carries different content", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const result = runtime.publish(snapshot({ view: { kind: "isolated-html", html: "<p>two</p>" } }));
		expect(result).toEqual({ status: "conflict", reason: "content-conflict" });
		expect(runtime.get("board-1")?.view.html).toBe("<p>one</p>");
	});

	test("conflicts on a stale lower revision and allows skipped higher revisions", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot({ revision: 2 })).status).toBe("accepted");
		expect(runtime.publish(snapshot({ revision: 1 }))).toEqual({
			status: "conflict",
			reason: "stale-revision",
		});
		const skipped = runtime.publish(snapshot({ revision: 4, view: { kind: "isolated-html", html: "<p>four</p>" } }));
		expect(skipped.status).toBe("accepted");
		expect(runtime.get("board-1")?.revision).toBe(4);
	});

	test("returns invalid for an unparsable snapshot", () => {
		const runtime = new ProjectionRuntime();
		const result = runtime.publish({ version: 2 });
		expect(result.status).toBe("invalid");
		if (result.status !== "invalid") return;
		expect(result.reason).toContain("Invalid projection");
		expect(runtime.get("board-1")).toBeUndefined();
	});
});

describe("ProjectionRuntime intervene", () => {
	test("accepts a revision-bound declared operation once", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const result = runtime.intervene(intervention());
		expect(result.status).toBe("accepted");
		if (result.status !== "accepted") return;
		expect(result.intervention.operationId).toBe("keep");
		expect(result.snapshot.revision).toBe(1);
	});

	test("returns duplicate for the same confirmed key and payload without replacing the snapshot", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const first = runtime.intervene(intervention());
		expect(first.status).toBe("accepted");
		if (first.status !== "accepted") return;
		expect(runtime.confirmIntervention(first.intervention).status).toBe("accepted");
		const again = runtime.intervene(intervention());
		expect(again.status).toBe("duplicate");
		if (again.status !== "duplicate") return;
		expect(again.intervention.idempotencyKey).toBe("op-1");
		expect(runtime.get("board-1")?.revision).toBe(1);
	});

	test("conflicts when the same key is reused with a different payload", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		expect(runtime.intervene(intervention()).status).toBe("accepted");
		expect(runtime.intervene(intervention({ input: { keep: true } }))).toEqual({
			status: "conflict",
			reason: "idempotency-conflict",
		});
	});

	test("does not treat absent input as null", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		expect(runtime.intervene(intervention()).status).toBe("accepted");
		expect(runtime.intervene(intervention({ input: null }))).toEqual({
			status: "conflict",
			reason: "idempotency-conflict",
		});
	});

	test("conflicts on unknown projection, revision mismatch, and undeclared operations", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.intervene(intervention())).toEqual({
			status: "conflict",
			reason: "unknown-projection",
		});

		expect(runtime.publish(snapshot()).status).toBe("accepted");
		expect(runtime.intervene(intervention({ observedRevision: 2 }))).toEqual({
			status: "conflict",
			reason: "revision-mismatch",
		});
		expect(runtime.intervene(intervention({ operationId: "forged" }))).toEqual({
			status: "conflict",
			reason: "undeclared-operation",
		});
	});

	test("treats an empty operations list as no declared operations", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot({ operations: [] })).status).toBe("accepted");
		expect(runtime.intervene(intervention())).toEqual({
			status: "conflict",
			reason: "undeclared-operation",
		});
	});

	test("keeps confirmed idempotency keys across a later publish", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const first = runtime.intervene(intervention());
		expect(first.status).toBe("accepted");
		if (first.status !== "accepted") return;
		expect(runtime.confirmIntervention(first.intervention).status).toBe("accepted");
		expect(
			runtime.publish(
				snapshot({
					revision: 2,
					view: { kind: "isolated-html", html: "<p>two</p>" },
				}),
			).status,
		).toBe("accepted");
		const again = runtime.intervene(intervention());
		expect(again.status).toBe("duplicate");
		if (again.status !== "duplicate") return;
		expect(again.snapshot.revision).toBe(1);
	});

	test("keeps a pending key unknown until explicitly confirmed or failed", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const first = runtime.intervene(intervention());
		expect(first.status).toBe("accepted");
		if (first.status !== "accepted") return;
		expect(runtime.intervene(intervention())).toEqual({
			status: "unknown",
			reason: "intervention-delivery-pending",
		});
		expect(runtime.failIntervention(first.intervention)).toEqual({
			status: "unknown",
			reason: "intervention-delivery-unknown",
		});
		expect(runtime.intervene(intervention())).toEqual({
			status: "unknown",
			reason: "intervention-delivery-unknown",
		});
		expect(runtime.confirmIntervention(first.intervention)).toEqual({
			status: "unknown",
			reason: "intervention-delivery-unknown",
		});
	});
	test("does not confirm or fail a mismatched intervention key", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const first = runtime.intervene(intervention());
		expect(first.status).toBe("accepted");
		if (first.status !== "accepted") return;
		const mismatched = { ...first.intervention, input: { changed: true } };
		expect(runtime.confirmIntervention(mismatched)).toEqual({
			status: "unknown",
			reason: "intervention-delivery-confirmation-mismatch",
		});
		expect(runtime.failIntervention(mismatched)).toEqual({
			status: "unknown",
			reason: "intervention-delivery-confirmation-mismatch",
		});
		expect(runtime.intervene(intervention())).toEqual({
			status: "unknown",
			reason: "intervention-delivery-pending",
		});
		expect(runtime.confirmIntervention(first.intervention).status).toBe("accepted");
	});

	test("returns invalid for an unparsable intervention", () => {
		const runtime = new ProjectionRuntime();
		expect(runtime.publish(snapshot()).status).toBe("accepted");
		const result = runtime.intervene({ version: 1 });
		expect(result.status).toBe("invalid");
		if (result.status !== "invalid") return;
		expect(result.reason).toContain("Invalid projection");
	});
});
