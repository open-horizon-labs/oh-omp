import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ContextManagerConfigError,
	getContextManagerMode,
	getContextManagerState,
	isAssemblerActive,
	isLegacyActive,
	isShadowMode,
	validateContextManagerConfig,
} from "@oh-my-pi/pi-coding-agent/context-manager";

describe("context-manager", () => {
	// ─────────────────────────────────────────────────────────────────────────
	// Mode defaults
	// ─────────────────────────────────────────────────────────────────────────

	describe("defaults", () => {
		it("defaults to legacy mode", () => {
			const settings = Settings.isolated();
			expect(getContextManagerMode(settings)).toBe("legacy");
		});

		it("validates without error on default config", () => {
			const settings = Settings.isolated();
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Valid mode configurations
	// ─────────────────────────────────────────────────────────────────────────

	describe("valid configurations", () => {
		it("accepts legacy mode with all subsystems enabled", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "legacy",
				"memories.enabled": true,
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});

		it("accepts legacy mode with subsystems disabled", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "legacy",
				"memories.enabled": false,
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});

		it("accepts shadow mode with all subsystems enabled", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "shadow",
				"memories.enabled": true,
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});

		it("accepts shadow mode with subsystems disabled", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "shadow",
				"memories.enabled": false,
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Fail-closed: assembler mode rejects conflicting legacy subsystems
	// ─────────────────────────────────────────────────────────────────────────

	describe("fail-closed behavior", () => {
		it("accepts assembler mode with default settings (memories disabled by default)", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "assembler",
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});

		it("rejects assembler mode with memories enabled", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "assembler",
				"memories.enabled": true,
			});
			expect(() => validateContextManagerConfig(settings)).toThrow(/memories\.enabled/);
		});


		it("accepts assembler mode when legacy subsystems are disabled", () => {
			const settings = Settings.isolated({
				"contextManager.mode": "assembler",
				"memories.enabled": false,
			});
			expect(() => validateContextManagerConfig(settings)).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Accessor helpers
	// ─────────────────────────────────────────────────────────────────────────

	describe("accessors", () => {
		it("isLegacyActive returns true for legacy mode", () => {
			const settings = Settings.isolated({ "contextManager.mode": "legacy" });
			expect(isLegacyActive(settings)).toBe(true);
		});

		it("isLegacyActive returns true for shadow mode (legacy is primary)", () => {
			const settings = Settings.isolated({ "contextManager.mode": "shadow" });
			expect(isLegacyActive(settings)).toBe(true);
		});

		it("isLegacyActive returns false for assembler mode", () => {
			const settings = Settings.isolated({ "contextManager.mode": "assembler" });
			expect(isLegacyActive(settings)).toBe(false);
		});

		it("isAssemblerActive returns true only for assembler mode", () => {
			expect(isAssemblerActive(Settings.isolated({ "contextManager.mode": "legacy" }))).toBe(false);
			expect(isAssemblerActive(Settings.isolated({ "contextManager.mode": "shadow" }))).toBe(false);
			expect(isAssemblerActive(Settings.isolated({ "contextManager.mode": "assembler" }))).toBe(true);
		});

		it("isShadowMode returns true only for shadow mode", () => {
			expect(isShadowMode(Settings.isolated({ "contextManager.mode": "legacy" }))).toBe(false);
			expect(isShadowMode(Settings.isolated({ "contextManager.mode": "shadow" }))).toBe(true);
			expect(isShadowMode(Settings.isolated({ "contextManager.mode": "assembler" }))).toBe(false);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Introspection state
	// ─────────────────────────────────────────────────────────────────────────

	describe("introspection state", () => {
		it("returns correct state for legacy mode", () => {
			const state = getContextManagerState(Settings.isolated({ "contextManager.mode": "legacy" }));
			expect(state).toEqual({
				mode: "legacy",
				legacyActive: true,
				assemblerActive: false,
				shadowObserving: false,
			});
		});

		it("returns correct state for shadow mode", () => {
			const state = getContextManagerState(Settings.isolated({ "contextManager.mode": "shadow" }));
			expect(state).toEqual({
				mode: "shadow",
				legacyActive: true,
				assemblerActive: false,
				shadowObserving: true,
			});
		});

		it("returns correct state for assembler mode", () => {
			const state = getContextManagerState(Settings.isolated({ "contextManager.mode": "assembler" }));
			expect(state).toEqual({
				mode: "assembler",
				legacyActive: false,
				assemblerActive: true,
				shadowObserving: false,
			});
		});
	});
});
