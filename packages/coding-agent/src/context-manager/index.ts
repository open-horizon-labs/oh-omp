/**
 * Context-manager runtime mode and activation guard.
 *
 * Enforces the single-active-context-manager invariant (ADR-0003):
 * exactly one context management strategy is active at runtime.
 * Only assembler mode is supported.
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
 * Validate context-manager configuration at startup.
 *
 * Fail-closed semantics: only assembler mode is accepted.
 *
 * @throws {ContextManagerConfigError} on invalid or unsupported mode
 */
export function validateContextManagerConfig(settings: Settings): void {
	const mode = getContextManagerMode(settings);
	if (mode !== "assembler") {
		throw new ContextManagerConfigError(
			`Context manager mode '${mode as string}' is no longer supported. Use 'assembler' mode.`,
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

/** True when the assembler is driving context. */
export function isAssemblerActive(settings: Settings): boolean {
	return getContextManagerMode(settings) === "assembler";
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
		legacyActive: false,
		assemblerActive: mode === "assembler",
		shadowObserving: false,
	};
}
