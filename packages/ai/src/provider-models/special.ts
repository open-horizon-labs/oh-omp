import type { ModelManagerOptions } from "../model-manager";
import { Effort } from "../model-thinking";
import type { Model } from "../types";
import { fetchCodexModels } from "../utils/discovery/codex";
import { fetchCursorUsableModels } from "../utils/discovery/cursor";
import { fetchOpenAICompatibleModels } from "../utils/discovery/openai-compatible";
import { buildAnthropicDiscoveryHeaders, toAnthropicDiscoveryBaseUrl } from "./openai-compat";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	accessToken?: string;
	accountId?: string;
	clientVersion?: string;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, clientVersion } = config;
	return {
		providerId: "openai-codex",
		...(accessToken
			? {
					fetchDynamicModels: async () => {
						const result = await fetchCodexModels({ accessToken, accountId, clientVersion });
						return result?.models ?? null;
					},
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		...(apiKey
			? {
					fetchDynamicModels: () => fetchCursorUsableModels({ apiKey, baseUrl, clientVersion }),
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// Amazon Bedrock
// ---------------------------------------------------------------------------

// Dynamic discovery requires AWS SDK auth (ListFoundationModels). Not yet implemented.

export interface AmazonBedrockModelManagerConfig {}

export function amazonBedrockModelManagerOptions(
	_config: AmazonBedrockModelManagerConfig = {},
): ModelManagerOptions<"bedrock-converse-stream"> {
	return { providerId: "amazon-bedrock" };
}

// ---------------------------------------------------------------------------
// MiniMax variants (subscription-based, no model listing endpoint)
// ---------------------------------------------------------------------------

export interface MinimaxModelManagerConfig {}

export function minimaxModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "minimax" };
}

export function minimaxCnModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "minimax-cn" };
}

export function minimaxCodeModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	return { providerId: "minimax-code" };
}

export function minimaxCodeCnModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	return { providerId: "minimax-code-cn" };
}

// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
const ZAI_CONTEXT_WINDOW = 262_144;
const ZAI_MAX_TOKENS = 131_072;

export interface ZaiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function normalizeZaiBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim();
	if (!value) {
		return ZAI_DEFAULT_BASE_URL;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function zaiModelManagerOptions(config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config.apiKey?.trim();
	const baseUrl = normalizeZaiBaseUrl(config.baseUrl);
	return {
		providerId: "zai",
		...(apiKey
			? {
					fetchDynamicModels: () =>
						fetchOpenAICompatibleModels({
							api: "anthropic-messages",
							provider: "zai",
							baseUrl: toAnthropicDiscoveryBaseUrl(baseUrl),
							headers: buildAnthropicDiscoveryHeaders(apiKey),
							mapModel: (entry, defaults) => mapZaiDiscoveredModel(entry.name, defaults, baseUrl),
						}),
				}
			: undefined),
	};
}

function mapZaiDiscoveredModel(
	providedName: unknown,
	defaults: Model<"anthropic-messages">,
	baseUrl: string,
): Model<"anthropic-messages"> {
	return {
		id: defaults.id,
		name: zaiDisplayName(defaults.id, providedName),
		api: "anthropic-messages",
		provider: "zai",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ZAI_CONTEXT_WINDOW,
		maxTokens: ZAI_MAX_TOKENS,
		thinking: {
			mode: "budget",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		},
	};
}

function zaiDisplayName(id: string, providedName: unknown): string {
	if (typeof providedName === "string") {
		const trimmed = providedName.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	if (id.length >= 4 && id.slice(0, 4).toLowerCase() === "glm-") {
		return `GLM-${id.slice(4)}`;
	}
	return id;
}

const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface DeepseekModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function normalizeDeepseekBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim();
	if (!value) return DEEPSEEK_DEFAULT_BASE_URL;
	return value.replace(/\/+$/, "");
}

/** Ported from the fork point (upstream 84355ace); pricing kept current. See #107 — shipped
 * as reasoning:true/thinking:effort per review, matching the known-working upstream config
 * rather than an unrun reasoning:false combination; not yet live-verified (no credential). */
const DEEPSEEK_COMPAT = {
	supportsReasoningEffort: true,
	reasoningEffortMap: { xhigh: "max" },
	supportsToolChoice: false,
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: true,
} as const satisfies Model<"openai-completions">["compat"];

const DEEPSEEK_THINKING = {
	mode: "effort",
	minLevel: Effort.Minimal,
	maxLevel: Effort.XHigh,
} as const satisfies Model<"openai-completions">["thinking"];

const DEEPSEEK_MODEL_TEMPLATE = {
	"deepseek-v4-flash": {
		name: "DeepSeek V4 Flash",
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
	},
	"deepseek-v4-pro": {
		name: "DeepSeek V4 Pro",
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
	},
} as const satisfies Record<
	string,
	{ name: string; contextWindow: number; maxTokens: number; cost: Model<"openai-completions">["cost"] }
>;

export function deepseekModelManagerOptions(
	config: DeepseekModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config.apiKey?.trim();
	// DeepSeek serves both model discovery and chat completions under /v1, unlike Z.AI's
	// split Anthropic-compat discovery vs. its own runtime dialect — one base suffices here.
	const baseUrl = `${normalizeDeepseekBaseUrl(config.baseUrl)}/v1`;
	return {
		providerId: "deepseek",
		...(apiKey
			? {
					fetchDynamicModels: () =>
						fetchOpenAICompatibleModels({
							api: "openai-completions",
							provider: "deepseek",
							baseUrl,
							apiKey,
							mapModel: (_entry, defaults) => mapDeepseekDiscoveredModel(defaults, baseUrl),
							// mapModel returning null falls back to raw defaults rather than skipping
							// (see fetchOpenAICompatibleModels); filterModel is the actual drop gate.
							filterModel: (_entry, model) => model.id in DEEPSEEK_MODEL_TEMPLATE,
						}),
				}
			: undefined),
	};
}

function mapDeepseekDiscoveredModel(
	defaults: Model<"openai-completions">,
	baseUrl: string,
): Model<"openai-completions"> | null {
	const template = DEEPSEEK_MODEL_TEMPLATE[defaults.id as keyof typeof DEEPSEEK_MODEL_TEMPLATE];
	// Ids DeepSeek's catalog returns beyond the two known models (e.g. legacy deepseek-chat)
	// have no verified pricing/thinking template; skip rather than guess.
	if (!template) return null;
	return {
		id: defaults.id,
		name: template.name,
		api: "openai-completions",
		provider: "deepseek",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: template.cost,
		contextWindow: template.contextWindow,
		maxTokens: template.maxTokens,
		compat: DEEPSEEK_COMPAT,
		thinking: DEEPSEEK_THINKING,
	};
}

export interface RunpodModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function normalizeRunpodBaseUrl(baseUrl: string | undefined): string | undefined {
	const value = baseUrl?.trim().replace(/\/+$/, "");
	return value ? value : undefined;
}

// Verified against the RunPod worker-vllm OpenAI route (see #112): thinking toggles via
// chat_template_kwargs and Qwen3.8 additionally accepts reasoning_effort there, but its
// chat template only allows low/medium/xhigh — fold minimal/high into the nearest level.
const RUNPOD_QWEN_COMPAT = {
	thinkingFormat: "qwen-chat-template",
	supportsReasoningEffort: false,
	reasoningEffortMap: { minimal: "low", high: "xhigh" },
} as const satisfies Model<"openai-completions">["compat"];

const RUNPOD_QWEN_THINKING = {
	mode: "effort",
	minLevel: Effort.Minimal,
	maxLevel: Effort.XHigh,
} as const satisfies Model<"openai-completions">["thinking"];

// Keys are lowercase; discovered ids are matched case-insensitively (vLLM serves
// "qwen/qwen3.8-27b" but hosts may report "Qwen/Qwen3.8-27B"). The served casing is
// preserved as the request id.
const RUNPOD_QWEN_TEMPLATE = {
	"qwen/qwen3.8-27b": {
		name: "Qwen3.8 27B",
		contextWindow: 131_072,
		maxTokens: 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
} as const satisfies Record<
	string,
	{ name: string; contextWindow: number; maxTokens: number; cost: Model<"openai-completions">["cost"] }
>;

// RunPod endpoints are deployment-specific: no default base URL exists, and the bundled
// catalog entry omits baseUrl on purpose. Discovery requires a locally configured
// endpoint, and only template-known models are surfaced — unknown served ids must not
// inherit guessed context/thinking/tool metadata.
export function runpodModelManagerOptions(
	config: RunpodModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config.apiKey?.trim();
	const baseUrl = normalizeRunpodBaseUrl(config.baseUrl);
	return {
		providerId: "runpod",
		...(apiKey && baseUrl
			? {
					fetchDynamicModels: () =>
						fetchOpenAICompatibleModels({
							api: "openai-completions",
							provider: "runpod",
							baseUrl,
							apiKey,
							// baseUrl is the full https://api.runpod.ai/v2/<endpoint>/openai/v1 route —
							// no further path segments are appended.
							mapModel: (_entry, defaults) => mapRunpodDiscoveredModel(defaults, baseUrl),
							// mapModel returning null falls back to raw defaults rather than skipping;
							// filterModel is the drop gate for non-template ids.
							filterModel: (_entry, model) => model.id.toLowerCase() in RUNPOD_QWEN_TEMPLATE,
						}),
				}
			: undefined),
	};
}

function mapRunpodDiscoveredModel(
	defaults: Model<"openai-completions">,
	baseUrl: string,
): Model<"openai-completions"> | null {
	const template = RUNPOD_QWEN_TEMPLATE[defaults.id.toLowerCase() as keyof typeof RUNPOD_QWEN_TEMPLATE];
	if (!template) return null;
	return {
		id: defaults.id,
		name: template.name,
		api: "openai-completions",
		provider: "runpod",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: template.cost,
		contextWindow: template.contextWindow,
		maxTokens: template.maxTokens,
		compat: RUNPOD_QWEN_COMPAT,
		thinking: RUNPOD_QWEN_THINKING,
	};
}
