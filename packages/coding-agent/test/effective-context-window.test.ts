import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveEffectivePromptContextWindow } from "@oh-my-pi/pi-coding-agent/context/effective-context-window";

function makeModel(overrides?: Partial<Model>): Model {
	return {
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		...overrides,
	};
}

describe("resolveEffectivePromptContextWindow", () => {
	test("uses active model context window clamped by assembler cap, not maxTokens", () => {
		const window = resolveEffectivePromptContextWindow({
			model: makeModel({ id: "gpt-5.5", contextWindow: 1_000_000, maxTokens: 128_000 }),
			contextWindowCap: 272_000,
		});

		expect(window).toBe(272_000);
	});

	test("preserves ordinary model context windows subject to assembler cap", () => {
		const window = resolveEffectivePromptContextWindow({
			model: makeModel({ api: "anthropic-messages", provider: "anthropic", contextWindow: 200_000, maxTokens: 64_000 }),
			contextWindowCap: 160_000,
		});

		expect(window).toBe(160_000);
	});

	test("does not treat assembler contextWindowCap as a floor", () => {
		const window = resolveEffectivePromptContextWindow({
			model: makeModel({ contextWindow: 96_000, maxTokens: 128_000 }),
			contextWindowCap: 200_000,
		});

		expect(window).toBe(96_000);
	});

	test("uses the active model window after switching away from a smaller model", () => {
		const previous = makeModel({ id: "gpt-5.3-codex", contextWindow: 128_000, maxTokens: 128_000 });
		const next = makeModel({ id: "gpt-5.5", contextWindow: 1_000_000, maxTokens: 128_000 });

		expect(resolveEffectivePromptContextWindow({ model: previous, contextWindowCap: 272_000 })).toBe(128_000);
		expect(resolveEffectivePromptContextWindow({ model: next, contextWindowCap: 272_000 })).toBe(272_000);
	});
});
