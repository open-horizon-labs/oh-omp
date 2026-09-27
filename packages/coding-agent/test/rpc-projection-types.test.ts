import { describe, expect, test } from "bun:test";
import { parseProjectionIntervention, parseProjectionSnapshot } from "../src/modes/rpc/projection-types";

const KIB = 1024;

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		projectionId: "projection-main",
		revision: 7,
		view: {
			kind: "isolated-html",
			html: "<main><button id=save>Save</button></main>",
		},
		operations: [{ id: "save", label: "Save changes" }],
		...overrides,
	};
}

function intervention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		projectionId: "projection-main",
		observedRevision: 7,
		operationId: "save",
		idempotencyKey: "request-001",
		...overrides,
	};
}

function expectRejected(parse: () => unknown): void {
	expect(parse).toThrow();
}

describe("projection snapshot parsing", () => {
	test("accepts a rich isolated view and distinct JSON state shapes", () => {
		const value = snapshot({
			view: {
				kind: "isolated-html",
				html: "<!doctype html><main><button data-action=save>Save &amp; continue</button></main>",
				css: "main { color: #123456; } @media (min-width: 40rem) { main { display: grid; } }",
				js: "document.querySelector('[data-action=save]')?.addEventListener('click', () => console.log('save'));",
			},
			state: {
				filters: { query: "café", tags: ["urgent", "customer-visible"] },
				selected: null,
				counts: [0, 3, 9],
				tool: { name: "render-preview", enabled: true },
			},
			operations: [
				{ id: "save", label: "Save changes" },
				{ id: "discard", label: "Discard draft" },
			],
		});

		const parsed = parseProjectionSnapshot(value);
		expect(parsed).toEqual({
			version: 1,
			projectionId: "projection-main",
			revision: 7,
			view: {
				kind: "isolated-html",
				html: "<!doctype html><main><button data-action=save>Save &amp; continue</button></main>",
				css: "main { color: #123456; } @media (min-width: 40rem) { main { display: grid; } }",
				js: "document.querySelector('[data-action=save]')?.addEventListener('click', () => console.log('save'));",
			},
			state: {
				filters: { query: "café", tags: ["urgent", "customer-visible"] },
				selected: null,
				counts: [0, 3, 9],
				tool: { name: "render-preview", enabled: true },
			},
			operations: [
				{ id: "save", label: "Save changes" },
				{ id: "discard", label: "Discard draft" },
			],
		});
	});

	test("allows empty html, empty operations, and an explicitly null state", () => {
		const parsed = parseProjectionSnapshot(
			snapshot({ view: { kind: "isolated-html", html: "" }, operations: [], state: null }),
		);
		expect(parsed.view.html).toBe("");
		expect(parsed.operations).toEqual([]);
		expect(parsed.state).toBeNull();
	});

	test("preserves absent optional fields as absent", () => {
		const parsed = parseProjectionSnapshot(snapshot());
		expect(Object.hasOwn(parsed.view, "css")).toBe(false);
		expect(Object.hasOwn(parsed.view, "js")).toBe(false);
		expect(Object.hasOwn(parsed, "state")).toBe(false);
	});

	test("clones state and protects it from caller mutation", () => {
		const sourceState = {
			profile: { displayName: "Ada", roles: ["reviewer"] },
			metadata: { nested: [{ value: 1 }] },
		};
		const parsed = parseProjectionSnapshot(snapshot({ state: sourceState }));

		(sourceState.profile.roles as string[]).push("owner");
		(sourceState.metadata.nested[0] as { value: number }).value = 99;

		expect(parsed.state).toEqual({
			profile: { displayName: "Ada", roles: ["reviewer"] },
			metadata: { nested: [{ value: 1 }] },
		});
	});

	test("accepts arbitrary state keys without treating data as protocol fields", () => {
		const state = JSON.parse(
			'{"tool":{"name":"display-only"},"password":"user-provided-data","__proto__":{"literal":true},"constructor":{"prototype":"literal"}}',
		) as Record<string, unknown>;
		const parsed = parseProjectionSnapshot(snapshot({ state }));

		expect(JSON.stringify(parsed.state)).toBe(JSON.stringify(state));
		expect(Object.getPrototypeOf(parsed.state as object)).toBe(Object.prototype);
		expect(Object.hasOwn(parsed.state as object, "__proto__")).toBe(true);
	});

	test("rejects unknown fields on each protocol record", () => {
		expectRejected(() => parseProjectionSnapshot(snapshot({ unexpected: true })));
		expectRejected(() =>
			parseProjectionSnapshot(snapshot({ view: { kind: "isolated-html", html: "", tool: "invoke" } })),
		);
		expectRejected(() =>
			parseProjectionSnapshot(snapshot({ operations: [{ id: "save", label: "Save", tool: "invoke" }] })),
		);
		expectRejected(() => parseProjectionIntervention(intervention({ unexpected: "invoke" })));
	});

	test("rejects duplicate operation IDs and more than sixteen operations", () => {
		expectRejected(() =>
			parseProjectionSnapshot(
				snapshot({
					operations: [
						{ id: "same", label: "One" },
						{ id: "same", label: "Two" },
					],
				}),
			),
		);
		expectRejected(() =>
			parseProjectionSnapshot(
				snapshot({
					operations: Array.from({ length: 17 }, (_, index) => ({
						id: `op-${index}`,
						label: `Operation ${index}`,
					})),
				}),
			),
		);
	});

	test("counts UTF-8 bytes for opaque identifiers", () => {
		const thirtyTwoEmoji = "😀".repeat(32);
		const parsed = parseProjectionSnapshot(snapshot({ projectionId: thirtyTwoEmoji }));
		expect(parsed.projectionId).toBe(thirtyTwoEmoji);
		expectRejected(() => parseProjectionSnapshot(snapshot({ projectionId: "😀".repeat(33) })));
		expectRejected(() =>
			parseProjectionSnapshot(snapshot({ operations: [{ id: "😀".repeat(17), label: "Too long" }] })),
		);
	});

	test("rejects empty identifiers, invalid revisions, and invalid versions", () => {
		for (const value of [""]) {
			expectRejected(() => parseProjectionSnapshot(snapshot({ projectionId: value })));
		}
		for (const revision of [0, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "7"]) {
			expectRejected(() => parseProjectionSnapshot(snapshot({ revision })));
			expectRejected(() => parseProjectionIntervention(intervention({ observedRevision: revision })));
		}
		expectRejected(() => parseProjectionSnapshot(snapshot({ version: 2 })));
		expectRejected(() => parseProjectionIntervention(intervention({ version: 0 })));
	});

	test("enforces view, operation, and snapshot byte limits", () => {
		expectRejected(() =>
			parseProjectionSnapshot(snapshot({ view: { kind: "isolated-html", html: "x".repeat(96 * KIB + 1) } })),
		);
		expectRejected(() =>
			parseProjectionSnapshot(
				snapshot({ view: { kind: "isolated-html", html: "", css: "x".repeat(48 * KIB + 1) } }),
			),
		);
		expectRejected(() =>
			parseProjectionSnapshot(snapshot({ view: { kind: "isolated-html", html: "", js: "x".repeat(96 * KIB + 1) } })),
		);
		expectRejected(() => parseProjectionSnapshot(snapshot({ state: "x".repeat(32 * KIB) })));
		expectRejected(() =>
			parseProjectionSnapshot(
				snapshot({
					view: {
						kind: "isolated-html",
						html: "h".repeat(96 * KIB),
						css: "c".repeat(48 * KIB),
						js: "j".repeat(96 * KIB),
					},
					state: "s".repeat(16 * KIB),
				}),
			),
		);
	});
});

describe("projection intervention parsing", () => {
	test("accepts JSON input including null and clones it", () => {
		const input = { form: { title: "Draft", labels: ["one", "two"] }, selected: null };
		const parsed = parseProjectionIntervention(intervention({ input }));

		(input.form.labels as string[]).push("caller-mutated");
		expect(parsed).toEqual({
			version: 1,
			projectionId: "projection-main",
			observedRevision: 7,
			operationId: "save",
			input: { form: { title: "Draft", labels: ["one", "two"] }, selected: null },
			idempotencyKey: "request-001",
		});
		expect(parseProjectionIntervention(intervention({ input: null })).input).toBeNull();
	});

	test("enforces intervention identifiers and input size", () => {
		expectRejected(() => parseProjectionIntervention(intervention({ operationId: "" })));
		expectRejected(() => parseProjectionIntervention(intervention({ idempotencyKey: "" })));
		expectRejected(() => parseProjectionIntervention(intervention({ input: "x".repeat(16 * KIB) })));
	});
});

describe("projection JSON safety", () => {
	test("rejects non-JSON values and nonfinite numbers", () => {
		for (const value of [
			new Date(),
			new Map(),
			new Set(),
			() => "not data",
			Symbol("not data"),
			1n,
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expectRejected(() => parseProjectionSnapshot(snapshot({ state: { value } })));
			expectRejected(() => parseProjectionIntervention(intervention({ input: { value } })));
		}
	});

	test("rejects cycles and nesting beyond the depth bound", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expectRejected(() => parseProjectionSnapshot(snapshot({ state: cyclic })));

		const root: Record<string, unknown> = {};
		let cursor = root;
		for (let index = 0; index < 33; index++) {
			const child: Record<string, unknown> = {};
			cursor.child = child;
			cursor = child;
		}
		expectRejected(() => parseProjectionSnapshot(snapshot({ state: root })));
	});

	test("rejects custom prototypes and never invokes untrusted getters", () => {
		let getterCalled = false;
		const stateWithGetter: Record<string, unknown> = {};
		Object.defineProperty(stateWithGetter, "secret", {
			enumerable: true,
			get() {
				getterCalled = true;
				return "must not be read";
			},
		});
		expectRejected(() => parseProjectionSnapshot(snapshot({ state: stateWithGetter })));
		expect(getterCalled).toBe(false);

		const operationsWithGetter = [{ id: "save", label: "Save" }];
		Object.defineProperty(operationsWithGetter, 0, {
			enumerable: true,
			get() {
				getterCalled = true;
				return { id: "save", label: "Save" };
			},
		});
		expectRejected(() => parseProjectionSnapshot(snapshot({ operations: operationsWithGetter })));
		expect(getterCalled).toBe(false);

		const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
		Object.assign(customPrototype, {
			version: 1,
			projectionId: "p",
			revision: 1,
			view: { kind: "isolated-html", html: "" },
			operations: [],
		});
		expectRejected(() => parseProjectionSnapshot(customPrototype));
	});
});

test("rejects a trailing unpaired high surrogate", () => {
	expect(() =>
		parseProjectionSnapshot({
			version: 1,
			projectionId: "\ud800",
			revision: 1,
			view: { kind: "isolated-html", html: "" },
			operations: [],
		}),
	).toThrow();
});
