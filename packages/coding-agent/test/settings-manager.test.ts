import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getSymbolPresetOverride, setSymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(async () => {
		// Reset global singleton so each test gets a fresh instance
		_resetSettingsForTest();
		await setSymbolPreset("unicode");

		// Use snowflake to isolate parallel test runs (SQLite files can't be shared)
		testDir = path.join(os.tmpdir(), "test-settings-tmp", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");

		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const writeProjectSettings = async (settings: Record<string, unknown>) => {
		const projectSettingsPath = path.join(projectDir, ".claude", "settings.json");
		await fs.promises.mkdir(path.dirname(projectSettingsPath), { recursive: true });
		await Bun.write(projectSettingsPath, JSON.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(async () => {
		_resetSettingsForTest();
		await setSymbolPreset("unicode");
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("compaction model overrides", () => {
		it("deep-merges global and project rules in declaration order and defaults to an empty map", async () => {
			await writeSettings({
				compaction: {
					thresholdPercent: 70,
					modelOverrides: {
						"openai-codex/*": { thresholdTokens: 200_000 },
					},
				},
			});
			await writeProjectSettings({
				compaction: {
					modelOverrides: {
						"openai-codex/gpt-5.6-terra": { thresholdTokens: 225_000 },
					},
				},
			});

			const layered = await Settings.init({ cwd: projectDir, agentDir });
			expect(layered.getGroup("compaction").modelOverrides).toEqual({
				"openai-codex/*": { thresholdTokens: 200_000 },
				"openai-codex/gpt-5.6-terra": { thresholdTokens: 225_000 },
			});
			expect(Settings.isolated().getGroup("compaction").modelOverrides).toEqual({});
		});
	});

	describe("profiles", () => {
		it("applies profile defaults before explicit overrides", () => {
			const settings = Settings.isolated({
				profile: "enterprise",
				"mcp.enableProjectConfig": true,
			});

			expect(settings.get("profile")).toBe("enterprise");
			expect(settings.get("mcp.discoveryMode")).toBe(true);
			expect(settings.get("mcp.enableProjectConfig")).toBe(true);
			expect(settings.get("skills.enableClaudeProject")).toBe(false);
		});

		it("lets project settings override profile defaults", async () => {
			await writeSettings({ profile: "enterprise" });
			await writeProjectSettings({
				mcp: { enableProjectConfig: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("profile")).toBe("enterprise");
			expect(settings.get("mcp.discoveryMode")).toBe(true);
			expect(settings.get("mcp.enableProjectConfig")).toBe(true);
		});

		it("fires setting hooks when the active profile changes", async () => {
			const settings = await Settings.init({ inMemory: true, cwd: projectDir });

			settings.set("profile", "minimal");

			expect(getSymbolPresetOverride()).toBe("ascii");
		});

		it("persists only the selected profile, not its expanded defaults", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.set("profile", "enterprise");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.profile).toBe("enterprise");
			expect(savedSettings.mcp).toBeUndefined();
			expect(savedSettings.skills).toBeUndefined();
			expect(savedSettings.commands).toBeUndefined();
		});

		it("falls back to developer defaults for an unknown profile name", async () => {
			await writeSettings({ profile: "bogus" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("profile")).toBe("developer");
			expect(settings.get("mcp.enableProjectConfig")).toBe(true);
			expect(settings.get("mcp.discoveryMode")).toBe(false);
		});
	});
});
