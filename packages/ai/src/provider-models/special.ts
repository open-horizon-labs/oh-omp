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
