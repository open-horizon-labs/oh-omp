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

describe("runpodModelManagerOptions discovery", () => {
	test("never installs dynamic discovery, even with a key and endpoint URL configured", () => {
		// A cold RunPod worker takes minutes to answer GET <baseUrl>/models, and refresh(\"online\")
		// (e.g. --list-models) awaits that path. The bundled entry is the source of truth;
		// no refresh may wake the worker (#114).
		expect(runpodModelManagerOptions().fetchDynamicModels).toBeUndefined();
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
