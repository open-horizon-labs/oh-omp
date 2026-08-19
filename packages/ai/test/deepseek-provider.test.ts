import { afterEach, describe, expect, test, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { deepseekModelManagerOptions } from "../src/provider-models/special";
import { getEnvApiKey } from "../src/stream";

const originalDeepseekApiKey = Bun.env.DEEPSEEK_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	vi.restoreAllMocks();
	global.fetch = originalFetch;
	if (originalDeepseekApiKey === undefined) {
		delete Bun.env.DEEPSEEK_API_KEY;
	} else {
		Bun.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
	}
});

describe("deepseek provider registration", () => {
	test("is registered as a catalog descriptor with the correct env var and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepseek");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-v4-flash");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("DEEPSEEK_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.deepseek).toBe("deepseek-v4-flash");
	});

	test("getEnvApiKey resolves DEEPSEEK_API_KEY", () => {
		Bun.env.DEEPSEEK_API_KEY = "deepseek-test-key";
		expect(getEnvApiKey("deepseek")).toBe("deepseek-test-key");
	});

	test("bundled entries carry current pricing, no thinking config, and a functional v1 base URL", () => {
		const flash = getBundledModel("deepseek", "deepseek-v4-flash");
		expect(flash).toBeDefined();
		expect(flash?.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(flash?.reasoning).toBe(false);
		expect(flash?.thinking).toBeUndefined();
		expect(flash?.cost).toEqual({ input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 });

		const pro = getBundledModel("deepseek", "deepseek-v4-pro");
		expect(pro).toBeDefined();
		expect(pro?.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(pro?.reasoning).toBe(false);
		expect(pro?.thinking).toBeUndefined();
		expect(pro?.cost).toEqual({ input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 });
	});
});

describe("deepseekModelManagerOptions", () => {
	test("does not install fetchDynamicModels without an API key", () => {
		const options = deepseekModelManagerOptions({});
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	test("does not install fetchDynamicModels for an empty/whitespace API key", () => {
		const options = deepseekModelManagerOptions({ apiKey: "   " });
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	test("requests exactly <base>/v1/models with a Bearer key and never leaks the key", async () => {
		let requestedUrl: string | undefined;
		let requestedAuth: string | null | undefined;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			requestedUrl = typeof input === "string" ? input : input.toString();
			requestedAuth = new Headers(init?.headers).get("authorization");
			return new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-v4-flash", object: "model" },
						{ id: "deepseek-v4-pro", object: "model" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch);

		const models = await deepseekModelManagerOptions({ apiKey: "sk-deepseek-secret" }).fetchDynamicModels?.();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(requestedUrl).toBe("https://api.deepseek.com/v1/models");
		expect(requestedAuth).toBe("Bearer sk-deepseek-secret");
		expect(JSON.stringify(models)).not.toContain("sk-deepseek-secret");
		expect(models?.map(model => model.id).sort()).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
	});

	test("maps discovered ids onto the bundled template and drops unknown ids", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-v4-pro", object: "model" },
						{ id: "deepseek-chat", object: "model" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const models = await deepseekModelManagerOptions({ apiKey: "sk-deepseek-secret" }).fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		const pro = models?.[0];
		expect(pro?.id).toBe("deepseek-v4-pro");
		expect(pro?.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(pro?.cost).toEqual({ input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 });
		expect(pro?.reasoning).toBe(false);
	});

	test("respects a custom base URL for both discovery and the mapped model baseUrl", async () => {
		let requestedUrl: string | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			requestedUrl = typeof input === "string" ? input : input.toString();
			return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash", object: "model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch);

		const models = await deepseekModelManagerOptions({
			apiKey: "sk-deepseek-secret",
			baseUrl: "https://deepseek.internal.example/",
		}).fetchDynamicModels?.();

		expect(requestedUrl).toBe("https://deepseek.internal.example/v1/models");
		expect(models?.[0]?.baseUrl).toBe("https://deepseek.internal.example/v1");
	});

	test("falls back to bundled entries on a non-2xx response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

		const models = await deepseekModelManagerOptions({ apiKey: "sk-deepseek-secret" }).fetchDynamicModels?.();

		expect(models).toBeNull();
	});

	test("falls back to bundled entries on a malformed response body", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		const models = await deepseekModelManagerOptions({ apiKey: "sk-deepseek-secret" }).fetchDynamicModels?.();

		expect(models).toBeNull();
	});
});
