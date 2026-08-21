import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { runpodModelManagerOptions } from "../src/provider-models/special";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";

const originalRunpodApiKey = Bun.env.RUNPOD_API_KEY;
const originalFetch = global.fetch;

beforeEach(() => {
	delete Bun.env.RUNPOD_API_KEY;
});

afterEach(() => {
	if (originalRunpodApiKey === undefined) {
		delete Bun.env.RUNPOD_API_KEY;
	} else {
		Bun.env.RUNPOD_API_KEY = originalRunpodApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function mockModelsResponse(models: unknown): typeof fetch {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return new Response(JSON.stringify(models), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}
	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

function bundledRunpodQwen(): Model<"openai-completions"> {
	return getBundledModel("runpod", "qwen/qwen3.8-27b") as unknown as Model<"openai-completions">;
}

describe("runpod bundled catalog entry", () => {
	test("descriptor is registered", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "runpod");
		expect(descriptor).toBeDefined();
	});

	test("bundled Qwen3.8 template carries verified limits and compat with no committed endpoint", () => {
		const model = bundledRunpodQwen();
		expect(model.name).toBe("Qwen3.8 27B");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(131_072);
		expect(model.maxTokens).toBe(32_768);
		// Deployment-specific: no endpoint URL belongs in the public catalog.
		expect(model.baseUrl).toBeUndefined();
		expect(model.compat).toEqual({
			thinkingFormat: "qwen-chat-template",
			supportsReasoningEffort: false,
			reasoningEffortMap: { minimal: "low", high: "xhigh" },
		});
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.XHigh });
	});
});

describe("runpodModelManagerOptions discovery gating", () => {
	test("installs no discovery without both a key and an endpoint URL", () => {
		expect(runpodModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
		expect(runpodModelManagerOptions({ apiKey: "sk-runpod" }).fetchDynamicModels).toBeUndefined();
		expect(
			runpodModelManagerOptions({ baseUrl: "https://api.runpod.ai/v2/ep/openai/v1" }).fetchDynamicModels,
		).toBeUndefined();
	});

	test("discovery requests the configured endpoint's models route with bearer auth", async () => {
		const capture: { url?: string; auth?: string | null } = {};
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			capture.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers);
			capture.auth = headers.get("authorization");
			return new Response(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);
		const models = await runpodModelManagerOptions({
			apiKey: "sk-runpod-secret",
			baseUrl: "https://api.runpod.ai/v2/ep/openai/v1/",
		}).fetchDynamicModels?.();
		// The configured URL is the full /openai/v1 route; only /models is appended and
		// the trailing slash must not produce a double slash.
		expect(capture.url).toBe("https://api.runpod.ai/v2/ep/openai/v1/models");
		expect(capture.auth).toBe("Bearer sk-runpod-secret");
		expect(capture.url?.includes("sk-runpod-secret")).toBe(false);
		expect(models).toHaveLength(1);
		expect(models?.[0].id).toBe("qwen/qwen3.8-27b");
		expect(models?.[0].baseUrl).toBe("https://api.runpod.ai/v2/ep/openai/v1");
	});

	test("maps case-insensitive served aliases onto the template and drops unknown ids", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			mockModelsResponse({ data: [{ id: "Qwen/Qwen3.8-27B" }, { id: "meta-llama/Llama-4-405B" }] }),
		);
		const models = await runpodModelManagerOptions({
			apiKey: "sk-runpod-secret",
			baseUrl: "https://api.runpod.ai/v2/ep/openai/v1",
		}).fetchDynamicModels?.();
		expect(models).toHaveLength(1);
		// Served casing is preserved as the request id; metadata comes from the template.
		expect(models?.[0].id).toBe("Qwen/Qwen3.8-27B");
		expect(models?.[0].contextWindow).toBe(131_072);
		expect(models?.[0].compat?.thinkingFormat).toBe("qwen-chat-template");
	});
});

describe("runpod Qwen effort transport", () => {
	function payloadFor(reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<Record<string, unknown>> {
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		streamOpenAICompletions(
			{ ...bundledRunpodQwen(), baseUrl: "https://api.runpod.ai/v2/test/openai/v1" },
			baseContext(),
			{
				apiKey: "test-key",
				...(reasoning ? { reasoning } : {}),
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload as Record<string, unknown>),
			},
		);
		return promise;
	}

	test("thinking off toggles enable_thinking false with no effort field", async () => {
		const payload = await payloadFor();
		const kwargs = payload.chat_template_kwargs as Record<string, unknown>;
		expect(kwargs).toEqual({ enable_thinking: false });
		expect(payload.reasoning_effort).toBeUndefined();
	});

	test("medium and xhigh pass effort inside chat_template_kwargs, never top-level", async () => {
		const medium = await payloadFor("medium");
		expect(medium.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "medium" });
		expect(medium.reasoning_effort).toBeUndefined();

		const xhigh = await payloadFor("xhigh");
		expect(xhigh.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "xhigh" });
		expect(xhigh.reasoning_effort).toBeUndefined();
	});

	test("minimal and high fold onto the template-supported low/xhigh levels", async () => {
		const minimal = await payloadFor("minimal");
		expect(minimal.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "low" });

		const high = await payloadFor("high");
		expect(high.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "xhigh" });
	});
});
