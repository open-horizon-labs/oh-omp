import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { formatModelString } from "./model-resolver";

export type CompactionStrategy = "context-full" | "handoff" | "off";

export interface ResolvedCompactionSettings {
	enabled: boolean;
	strategy: CompactionStrategy;
	thresholdPercent: number;
	thresholdTokens: number;
	handoffSaveToDisk: boolean;
	remoteEnabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	autoContinue: boolean;
	remoteEndpoint: string | undefined;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
}

export type CompactionModelOverride = Partial<ResolvedCompactionSettings>;

/** The typed settings group; map values remain untrusted configuration input until resolved. */
export interface CompactionSettings extends ResolvedCompactionSettings {
	modelOverrides: Record<string, unknown>;
}

const scalarKeys = [
	"enabled",
	"strategy",
	"thresholdPercent",
	"thresholdTokens",
	"handoffSaveToDisk",
	"remoteEnabled",
	"reserveTokens",
	"keepRecentTokens",
	"autoContinue",
	"remoteEndpoint",
	"idleEnabled",
	"idleThresholdTokens",
	"idleTimeoutSeconds",
] as const satisfies readonly (keyof ResolvedCompactionSettings)[];

function isValidScalar<K extends keyof ResolvedCompactionSettings>(
	key: K,
	value: unknown,
): value is ResolvedCompactionSettings[K] {
	switch (key) {
		case "enabled":
		case "handoffSaveToDisk":
		case "remoteEnabled":
		case "autoContinue":
		case "idleEnabled":
			return typeof value === "boolean";
		case "strategy":
			return value === "context-full" || value === "handoff" || value === "off";
		case "thresholdPercent":
		case "thresholdTokens":
		case "reserveTokens":
		case "keepRecentTokens":
		case "idleThresholdTokens":
		case "idleTimeoutSeconds":
			return typeof value === "number" && Number.isFinite(value);
		case "remoteEndpoint":
			return value === undefined || typeof value === "string";
	}
}

function parseModelOverride(value: unknown): CompactionModelOverride | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some(key => !scalarKeys.includes(key as (typeof scalarKeys)[number]))) return undefined;

	const override: Record<string, unknown> = {};
	for (const key of scalarKeys) {
		const candidate = value[key];
		if (candidate === undefined) continue;
		if (!isValidScalar(key, candidate)) return undefined;
		override[key] = candidate;
	}
	return override as CompactionModelOverride;
}

function withoutModelOverrides(settings: CompactionSettings): ResolvedCompactionSettings {
	const { modelOverrides: _modelOverrides, ...scalars } = settings;
	return { ...scalars };
}

function findModelCompactionOverride(overrides: unknown, modelName: string): CompactionModelOverride | undefined {
	if (!isRecord(overrides)) return undefined;
	const normalizedModelName = modelName.toLowerCase();
	const entries = Object.entries(overrides);

	for (const [key, value] of entries) {
		if (key.toLowerCase() !== normalizedModelName) continue;
		const override = parseModelOverride(value);
		if (override) return override;
	}

	for (const [pattern, value] of entries) {
		if (pattern.toLowerCase() === normalizedModelName) continue;
		const override = parseModelOverride(value);
		if (!override) continue;
		try {
			if (new Bun.Glob(pattern.toLowerCase()).match(normalizedModelName)) return override;
		} catch {
			// An invalid glob is an invalid rule; subsequent rules and globals still apply.
		}
	}
}

/**
 * Materialize the active conversation model's compaction policy.
 * The returned object contains scalar settings only and never aliases configuration input.
 */
export function resolveCompactionSettingsForModel(
	settings: CompactionSettings,
	model: Model | undefined,
): ResolvedCompactionSettings {
	const base = withoutModelOverrides(settings);
	if (!model) return base;

	const override = findModelCompactionOverride(settings.modelOverrides, formatModelString(model));
	return override ? { ...base, ...override } : base;
}

/** Returns invalid configuration entries for the settings layer to diagnose once per rebuild. */
export function getInvalidCompactionModelOverrideEntries(overrides: unknown): string[] {
	if (!isRecord(overrides)) return ["compaction.modelOverrides must be a map"];
	const invalid: string[] = [];
	for (const [key, value] of Object.entries(overrides)) {
		if (!parseModelOverride(value)) {
			invalid.push(`compaction.modelOverrides.${key}`);
			continue;
		}
		try {
			new Bun.Glob(key.toLowerCase());
		} catch {
			invalid.push(`compaction.modelOverrides.${key}`);
		}
	}
	return invalid;
}
