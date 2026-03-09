import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getContextManagerMode,
	getContextManagerState,
	isAssemblerActive,
	validateContextManagerConfig,
} from "@oh-my-pi/pi-coding-agent/context-manager";

describe("context-manager", () => {
	// ─────────────────────────────────────────────────────────────────────────
	// Mode defaults
	// ─────────────────────────────────────────────────────────────────────────

	describe("defaults", () => {
		it("defaults to assembler mode", () => {
			const settings = Settings.isolated();
			expect(getContextManagerMode(settings)).toBe("assembler");
		});

		it("validates without error on default config", () => {
			const settings = Settings.isolated();
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Only assembler mode is accepted
	// ─────────────────────────────────────────────────────────────────────────

	describe("assembler-only validation", () => {
		it("accepts assembler mode", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "assembler",
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});

		it("rejects legacy mode", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "legacy",
			});
			expect(() => validateContextManagerConfig(settings)).toThrow(/no longer supported/);
		});

		it("rejects shadow mode", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "shadow",
			});
			expect(() => validateContextManagerConfig(settings)).toThrow(/no longer supported/);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Accessor helpers
	// ─────────────────────────────────────────────────────────────────────────

	describe("accessors", () => {
		it("isAssemblerActive returns true for assembler mode", () => {
			const settings = Settings.isolated({ "contextManager.mode": "assembler" });
			expect(isAssemblerActive(settings)).toBe(true);
		});

		it("isAssemblerActive returns false for non-assembler mode", () => {
			const settings = Settings.isolated({ "contextManager.mode": "legacy" });
			expect(isAssemblerActive(settings)).toBe(false);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Introspection state
	// ─────────────────────────────────────────────────────────────────────────

	describe("introspection state", () => {
		it("returns correct state for assembler mode", () => {
			const state = getContextManagerState(Settings.isolated({ "contextManager.mode": "assembler" }));
			expect(state).toEqual({
				mode: "assembler",
				legacyActive: false,
				assemblerActive: true,
				shadowObserving: false,
			});
		});

		it("returns legacyActive=false even for legacy mode setting", () => {
			const state = getContextManagerState(Settings.isolated({ "contextManager.mode": "legacy" }));
			expect(state).toEqual({
				mode: "legacy",
				legacyActive: false,
				assemblerActive: false,
				shadowObserving: false,
			});
		});
	});
});
