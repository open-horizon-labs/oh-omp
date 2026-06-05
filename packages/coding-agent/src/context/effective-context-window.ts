import type { Model } from "@oh-my-pi/pi-ai";

export interface EffectiveContextWindowInput {
	model: Model | undefined;
	contextWindowCap: number;
}

/**
 * Resolve the prompt budget used by runtime context assembly.
 *
 * `Model.contextWindow` is the model/provider prompt window. `Model.maxTokens` is
 * output budget and must not be used as a prompt/input cap. The assembler cap is
 * an OMP safety ceiling layered on top of the active model's current window, so
 * model switches must recompute this value from the active model each time.
 */
export function resolveEffectivePromptContextWindow(input: EffectiveContextWindowInput): number {
	const modelWindow = input.model?.contextWindow ?? 0;
	if (modelWindow <= 0) return 0;

	return input.contextWindowCap > 0 ? Math.min(modelWindow, input.contextWindowCap) : modelWindow;
}
