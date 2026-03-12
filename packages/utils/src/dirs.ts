/**
 * Centralized path helpers for omp config directories.
 *
 * Uses PI_CONFIG_DIR (default ".oh-omp") for the config root and
 * PI_CODING_AGENT_DIR to override the agent directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "oh-omp") */
export const APP_NAME: string = "oh-omp";

/** Config directory name (e.g. ".oh-omp") */
export const CONFIG_DIR_NAME: string = ".oh-omp";

/** Workspace version from the upstream package lineage (e.g. "13.9.2") */
export const WORKSPACE_VERSION: string = version;
const configuredReleaseVersion = process.env.PI_RELEASE_VERSION?.trim();
export const RELEASE_VERSION: string | undefined = configuredReleaseVersion
	? configuredReleaseVersion.replace(/^v/, "")
	: undefined;

/** Distributed app version (e.g. "0.1.0" for published oh-omp binaries) */
export const VERSION: string = RELEASE_VERSION || WORKSPACE_VERSION;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

// =============================================================================
// Root directories
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

/** Get the config directory name relative to home (e.g. ".omp" or PI_CONFIG_DIR override). */
export function getConfigDirName(): string {
	return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Get the config agent directory name relative to home (e.g. ".omp/agent" or PI_CONFIG_DIR + "/agent"). */
export function getConfigAgentDirName(): string {
	return `${getConfigDirName()}/agent`;
}

/** Get the config root directory (~/.omp). */
export function getConfigRootDir(): string {
	return path.join(os.homedir(), getConfigDirName());
}

let agentDir = process.env.PI_CODING_AGENT_DIR || path.join(getConfigRootDir(), "agent");

/** Set the coding agent directory. */
export function setAgentDir(dir: string): void {
	agentDir = dir;
	agentCache.clear();
	process.env.PI_CODING_AGENT_DIR = dir;
}

/** Get the agent config directory (~/.oh-omp/agent). */
export function getAgentDir(): string {
	return agentDir;
}

/** Get the project-local config directory (.oh-omp). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Caching utilities
// =============================================================================

const rootCache = new Map<string, any>();

function getRootSubdir(subdir: string): string {
	if (rootCache.has(subdir)) {
		return rootCache.get(subdir);
	}
	const result = path.join(getConfigRootDir(), subdir);
	rootCache.set(subdir, result);
	return result;
}

const agentCache = new Map<string, any>();

function getAgentSubdir(userAgentDir: string | undefined, subdir: string): string {
	if (!userAgentDir || userAgentDir === agentDir) {
		if (agentCache.has(subdir)) {
			return agentCache.get(subdir);
		} else {
			const result = path.join(agentDir, subdir);
			agentCache.set(subdir, result);
			return result;
		}
	} else {
		return path.join(userAgentDir, subdir);
	}
}

// =============================================================================
// Config-root subdirectories (~/.oh-omp/*)
// =============================================================================

/** Get the reports directory (~/.oh-omp/reports). */
export function getReportsDir(): string {
	return getRootSubdir("reports");
}

/** Get the logs directory (~/.oh-omp/logs). */
export function getLogsDir(): string {
	return getRootSubdir("logs");
}

/** Get the path to a dated log file (~/.oh-omp/logs/oh-omp.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/** Get the plugins directory (~/.oh-omp/plugins). */
export function getPluginsDir(): string {
	return getRootSubdir("plugins");
}

/** Where npm installs packages (~/.oh-omp/plugins/node_modules). */
export function getPluginsNodeModules(): string {
	return getRootSubdir("plugins/node_modules");
}

/** Plugin manifest (~/.oh-omp/plugins/package.json). */
export function getPluginsPackageJson(): string {
	return getRootSubdir("plugins/package.json");
}

/** Plugin lock file (~/.oh-omp/plugins/omp-plugins.lock.json). */
export function getPluginsLockfile(): string {
	return getRootSubdir("plugins/omp-plugins.lock.json");
}

/** Get the remote mount directory (~/.oh-omp/remote). */
export function getRemoteDir(): string {
	return getRootSubdir("remote");
}

/** Get the SSH control socket directory (~/.oh-omp/ssh-control). */
export function getSshControlDir(): string {
	return getRootSubdir("ssh-control");
}

/** Get the remote host info directory (~/.oh-omp/remote-host). */
export function getRemoteHostDir(): string {
	return getRootSubdir("remote-host");
}

/** Get the managed Python venv directory (~/.oh-omp/python-env). */
export function getPythonEnvDir(): string {
	return getRootSubdir("python-env");
}

/** Get the puppeteer sandbox directory (~/.oh-omp/puppeteer). */
export function getPuppeteerDir(): string {
	return getRootSubdir("puppeteer");
}

/** Get the worktree base directory (~/.oh-omp/wt). */
export function getWorktreeBaseDir(): string {
	return getRootSubdir("wt");
}

/** Get the path to a worktree directory (~/.oh-omp/wt/<project>/<id>). */
export function getWorktreeDir(encodedProject: string, id: string): string {
	return path.join(getWorktreeBaseDir(), encodedProject, id);
}

/** Get the GPU cache path (~/.oh-omp/gpu_cache.json). */
export function getGpuCachePath(): string {
	return getRootSubdir("gpu_cache.json");
}

/** Get the natives directory (~/.oh-omp/natives). */
export function getNativesDir(): string {
	return getRootSubdir("natives");
}

/** Get the stats database path (~/.oh-omp/stats.db). */
export function getStatsDbPath(): string {
	return getRootSubdir("stats.db");
}

// =============================================================================
// Agent subdirectories (~/.oh-omp/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return getAgentSubdir(agentDir, "agent.db");
}

/** Get the sessions directory (~/.oh-omp/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "sessions");
}

/** Get the content-addressed blob store directory (~/.oh-omp/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "blobs");
}

/** Get the custom themes directory (~/.oh-omp/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.oh-omp/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.oh-omp/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.oh-omp/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.oh-omp/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "modules");
}

/** Get the test auth database path (~/.oh-omp/agent/testauth.db). */
export function getTestAuthPath(agentDir?: string): string {
	return getAgentSubdir(agentDir, "testauth.db");
}

/** Get the crash log path (~/.oh-omp/agent/omp-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	return getAgentSubdir(agentDir, "omp-crash.log");
}

/** Get the debug log path (~/.oh-omp/agent/oh-omp-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	return getAgentSubdir(agentDir, `${APP_NAME}-debug.log`);
}

// =============================================================================
// Project subdirectories (.omp/*)
// =============================================================================

/** Get the project-level Python modules directory (.omp/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.omp/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.omp/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}
