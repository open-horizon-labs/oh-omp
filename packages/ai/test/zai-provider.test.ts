import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { zaiModelManagerOptions } from "../src/provider-models/special";
import { getEnvApiKey } from "../src/stream";

const originalZaiApiKey = Bun.env.ZAI_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalZaiApiKey === undefined) {
		delete Bun.env.ZAI_API_KEY;
	} else {
		Bun.env.ZAI_API_KEY = originalZaiApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("zai provider support", () => {
	test("resolves ZAI_API_KEY from environment", () => {
		Bun.env.ZAI_API_KEY = "zai-test-key";
		expect(getEnvApiKey("zai")).toBe("zai-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "zai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("glm-5.1");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("ZAI_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.zai).toBe("glm-5.1");
	});

	test("keeps bundled glm-5.1 and adds Coding Plan fallbacks", () => {
		const glm51 = getBundledModel("zai", "glm-5.1");
		expect(glm51?.contextWindow).toBe(200000);
		expect(glm51?.maxTokens).toBe(131072);

		for (const id of ["glm-5.2", "glm-5.3"] as const) {
			const model = getBundledModel("zai", id);
			expect(model).toBeDefined();
			expect(model?.api).toBe("anthropic-messages");
			expect(model?.baseUrl).toBe("https://api.z.ai/api/anthropic");
			expect(model?.input).toEqual(["text"]);
			expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model?.contextWindow).toBe(262144);
			expect(model?.maxTokens).toBe(131072);
			expect(model?.thinking).toEqual({
				mode: "budget",
				minLevel: Effort.Minimal,
				maxLevel: Effort.XHigh,
			});
		}
	});

	test("does not fetch models without an API key", () => {
		expect(zaiModelManagerOptions().fetchDynamicModels).toBeUndefined();
		expect(zaiModelManagerOptions({ apiKey: "   " }).fetchDynamicModels).toBeUndefined();
	});

	test("maps authenticated Coding Plan models through the Anthropic template", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "glm-5.2", name: "GLM-5.2" }, { id: "glm-5.3" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = zaiModelManagerOptions({ apiKey: "zai-test-key" });
		expect(options.providerId).toBe("zai");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.z.ai/api/anthropic/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({
					Accept: "application/json",
					"x-api-key": "zai-test-key",
					"anthropic-version": "2023-06-01",
				}),
			}),
		);

		const glm52 = models?.find(model => model.id === "glm-5.2");
		expect(glm52).toMatchObject({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 131072,
			thinking: {
				mode: "budget",
				minLevel: Effort.Minimal,
				maxLevel: Effort.XHigh,
			},
		});

		const glm53 = models?.find(model => model.id === "glm-5.3");
		expect(glm53?.name).toBe("GLM-5.3");
		expect(glm53?.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(glm53?.contextWindow).toBe(262144);
	});

	test("maps discovered models back to a custom Anthropic runtime base URL", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "glm-5.2" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const models = await zaiModelManagerOptions({
			apiKey: "zai-test-key",
			baseUrl: "https://proxy.example/anthropic/",
		}).fetchDynamicModels?.();

		expect(global.fetch).toHaveBeenCalledWith(
			"https://proxy.example/anthropic/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		expect(models?.[0]?.baseUrl).toBe("https://proxy.example/anthropic");
	});

	test("deduplicates repeated IDs from the existing discovery helper", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "glm-5.2" }, { id: "glm-5.2" }, { id: "glm-5.3" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const models = await zaiModelManagerOptions({ apiKey: "zai-test-key" }).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["glm-5.2", "glm-5.3"]);
	});

	test("returns null when authenticated discovery fails", async () => {
		global.fetch = vi.fn(
			async () => new Response("upstream unavailable", { status: 503 }),
		) as unknown as typeof fetch;

		const models = await zaiModelManagerOptions({ apiKey: "zai-test-key" }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});
});
