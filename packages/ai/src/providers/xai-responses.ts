// Ported from NousResearch/hermes-agent (MIT) via the original upstream release.

import type { Context, Model, StreamFunction } from "../types";
import {
	getOpenAIResponsesCacheSessionId,
	type OpenAIResponsesOptions,
	streamOpenAIResponses,
} from "./openai-responses";

const GROK_EFFORT_CAPABLE_PREFIXES = ["grok-3-mini", "grok-4.20-multi-agent", "grok-4.3", "grok-4.5"] as const;

function grokSupportsReasoningEffort(modelId: string): boolean {
	const name = modelId.trim().toLowerCase();
	if (!name) return false;
	const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
	return GROK_EFFORT_CAPABLE_PREFIXES.some(prefix => bare.startsWith(prefix));
}

/** Apply the request and replay constraints required by SuperGrok OAuth. */
export const streamXAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions = {},
) => {
	const cacheSessionId = getOpenAIResponsesCacheSessionId(options);
	const xaiHeaders: Record<string, string> = { ...options.headers };
	if (cacheSessionId) xaiHeaders["x-grok-conv-id"] = cacheSessionId;

	const xaiBody: Record<string, unknown> = { ...(options.extraBody ?? {}) };
	if (cacheSessionId) xaiBody.prompt_cache_key = cacheSessionId;

	return streamOpenAIResponses(model, context, {
		...options,
		headers: xaiHeaders,
		extraBody: xaiBody,
		includeEncryptedReasoning: false,
		filterReasoningHistory: true,
		omitReasoningEffort: options.omitReasoningEffort ?? !grokSupportsReasoningEffort(model.id),
		reasoning: options.reasoning === "minimal" ? "low" : options.reasoning,
	});
};
