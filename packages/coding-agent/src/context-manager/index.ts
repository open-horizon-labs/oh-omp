/**
 * Context-manager runtime mode and activation guard.
 *
 * Enforces the single-active-context-manager invariant (ADR-0003):
 * exactly one context management strategy is active at runtime.
 *
 * Modes:
 *   - legacy:    Current behavior — memory injection, compaction, TTSR all active.
 *   - shadow:    Legacy is primary; assembler observes but never injects (no side effects).
 *   - assembler: Assembler-managed context (not yet implemented — fails closed).
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ContextManagerMode } from "../config/settings-schema";

export type { ContextManagerMode } from "../config/settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

export class ContextManagerConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextManagerConfigError";
	}
}

/**
 * Describes which legacy subsystems are enabled alongside the selected mode.
 * Used by validation to detect mixed-manager configurations.
 */
interface LegacySubsystemState {
	memoriesEnabled: boolean;
	compactionEnabled: boolean;
}

/**
 * Validate context-manager configuration at startup.
 *
 * Fail-closed semantics: if the configuration would activate multiple
 * context managers simultaneously, throw rather than run in mixed mode.
 *
 * @throws {ContextManagerConfigError} on invalid mode or mixed-manager config
 */
export function validateContextManagerConfig(settings: Settings): void {
	const mode = getContextManagerMode(settings);

	const subsystems: LegacySubsystemState = {
		memoriesEnabled: settings.get("memories.enabled"),
		compactionEnabled: settings.get("compaction.enabled"),
	};

	switch (mode) {
		case "legacy":
			// Legacy mode: all existing subsystems are allowed. No conflict possible.
			break;

		case "shadow":
			// Shadow mode: legacy is primary, assembler observes without injection.
			// No side effects from assembler — always safe.
			break;

		case "assembler":
			// Guard: assembler mode must not coexist with legacy subsystems.
			// When assembler is implemented, remove the not-implemented throw below
			// and this guard becomes the active validation.
			{
				const conflicts: string[] = [];
				if (subsystems.memoriesEnabled) conflicts.push("memories.enabled");
				if (subsystems.compactionEnabled) conflicts.push("compaction.enabled");
				if (conflicts.length > 0) {
					throw new ContextManagerConfigError(
						`Context manager mode 'assembler' conflicts with active legacy subsystems: ${conflicts.join(", ")}. ` +
							"Disable them or switch to 'shadow' mode.",
					);
				}
			}
			// Assembler is not yet implemented — fail closed.
			throw new ContextManagerConfigError(
				"Context manager mode 'assembler' is not yet implemented. Use 'legacy' or 'shadow'.",
			);

		default:
			throw new ContextManagerConfigError(
				`Unknown context manager mode: '${mode as string}'. Valid values: legacy, shadow, assembler.`,
			);
	}

	logger.debug("Context manager validated", { mode });
}

// ═══════════════════════════════════════════════════════════════════════════
// Accessors
// ═══════════════════════════════════════════════════════════════════════════

/** Read the current context-manager mode from settings. */
export function getContextManagerMode(settings: Settings): ContextManagerMode {
	return settings.get("contextManager.mode");
}

/** True when legacy context management is the active primary. */
export function isLegacyActive(settings: Settings): boolean {
	const mode = getContextManagerMode(settings);
	return mode === "legacy" || mode === "shadow";
}

/** True when the assembler should observe (shadow) or drive (assembler) context. */
export function isAssemblerActive(settings: Settings): boolean {
	return getContextManagerMode(settings) === "assembler";
}

/** True when the assembler should observe without injecting into prompts. */
export function isShadowMode(settings: Settings): boolean {
	return getContextManagerMode(settings) === "shadow";
}

// ═══════════════════════════════════════════════════════════════════════════
// Introspection
// ═══════════════════════════════════════════════════════════════════════════

export interface ContextManagerState {
	mode: ContextManagerMode;
	legacyActive: boolean;
	assemblerActive: boolean;
	shadowObserving: boolean;
}

/** Snapshot of current context-manager state for introspection / diagnostics. */
export function getContextManagerState(settings: Settings): ContextManagerState {
	const mode = getContextManagerMode(settings);
	return {
		mode,
		legacyActive: mode === "legacy" || mode === "shadow",
		assemblerActive: mode === "assembler",
		shadowObserving: mode === "shadow",
	};
}

export * from "./telemetry";
