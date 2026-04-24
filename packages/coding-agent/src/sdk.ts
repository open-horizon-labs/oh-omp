import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	INTENT_FIELD,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";

import { prewarmOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { SearchDb } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	$env,
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	getSearchDbDir,
	logger,
	postmortem,
} from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { AsyncJobManager } from "./async";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability } from "./capability/rule";
import { ModelRegistry } from "./config/model-registry";
import { formatModelString, parseModelPattern, parseModelString, resolveModelRoleValue } from "./config/model-resolver";
import {
	loadPromptTemplates as loadPromptTemplatesInternal,
	type PromptTemplate,
	renderPromptTemplate,
} from "./config/prompt-templates";
import { type AssemblerSettings, Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers } from "./cursor";
import "./discovery";
import * as path from "node:path";
import { resolveConfigValue } from "./config/resolve-config-value";
import {
	deriveBudget,
	estimateMessageTokens,
	estimateToolDefinitionTokens,
	segmentIntoTurns,
	type TransformMetadata,
	transformMessages,
} from "./context/assembler";
import { dedupCodec, readCodec, warmCodec } from "./context/assembler/codecs";
import { formatAssemblySummary } from "./context/assembly-summary";
import { ToolResultBridge } from "./context/bridge";
import { captureEffectivePromptSnapshot, type EffectivePromptSnapshot } from "./context/effective-prompt-snapshot";
import { extractPaths } from "./context/extract-paths";
import {
	buildRecallDebugEntries,
	daysToRecallWindowMs,
	extractAssistantText,
	extractPathsFromText,
	extractUserText,
	formatHydratedContext,
	formatRecallAge,
	getRecallAgeMs,
	getRecallBand,
	IngestPipeline,
	PassiveHydrator,
	type RecallDebugTrace,
	type RecallSearchResult,
	RecallStore,
	resolveMemexLicense,
	selectHydrationResultIndexToDrop,
} from "./context/recall";
import { ToolResultStore } from "./context/recall/tool-result-store";
import { initializeWithSettings } from "./discovery";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverAndLoadCustomTools } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import { CustomToolAdapter } from "./extensibility/custom-tools/wrapper";
import {
	discoverAndLoadExtensions,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import {
	AgentProtocolHandler,
	ArtifactProtocolHandler,
	InternalUrlRouter,
	JobsProtocolHandler,
	LocalProtocolHandler,
	McpProtocolHandler,
	MemoryProtocolHandler,
	PiProtocolHandler,
	RuleProtocolHandler,
	SkillProtocolHandler,
} from "./internal-urls";
import { disposeAllKernelSessions } from "./ipy/executor";
import { discoverAndLoadMCPTools, type MCPManager, type MCPToolsLoadResult } from "./mcp";
import {
	collectDiscoverableMCPTools,
	formatDiscoverableMCPToolServerSummary,
	selectDiscoverableMCPToolNamesByServer,
	summarizeDiscoverableMCPTools,
} from "./mcp/discoverable-tool-metadata";
import { getMemoryRoot } from "./memories";
import { compileSystemPrompt } from "./prompts/composer/compile";
import composerInvariants from "./prompts/composer/invariants.md" with { type: "text" };
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import { collectEnvSecrets, loadSecrets, obfuscateMessages, SecretObfuscator } from "./secrets";
import { AgentSession } from "./session/agent-session";
import { AuthStorage } from "./session/auth-storage";
import { convertToLlm } from "./session/messages";
import { SessionManager } from "./session/session-manager";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { TaskStore } from "./tasks/store";
import { parseThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	FindTool,
	GrepTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isSearchProviderPreference,
	loadSshTool,
	PythonTool,
	ReadTool,
	ResolveTool,
	renderSearchToolBm25Description,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	type Tool,
	type ToolSession,
	WriteTool,
	warmupLspServers,
} from "./tools";
import { ToolContextStore } from "./tools/context";
import { getGeminiImageTools } from "./tools/gemini-image";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { PendingActionStore } from "./tools/pending-action";
import { EventBus } from "./utils/event-bus";

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Global config directory. Default: ~/.oh-omp/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;
	/** Shared native search DB for grep/glob/fuzzyFind-backed workflows. */
	searchDb?: SearchDb;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	/** System prompt. String replaces default, function receives default and returns final. */
	systemPrompt?: string | ((defaultPrompt: string) => string);
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery).
	 * @internal Used by CLI when extensions are loaded early to parse custom flags.
	 */
	preloadedExtensions?: LoadExtensionsResult;

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip Python kernel availability check and prelude warmup */
	skipPythonPreflight?: boolean;

	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the submit_result tool by default */
	requireSubmitResultTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent task ID prefix for nested artifact naming (e.g., "6-Extensions") */
	parentTaskPrefix?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers that were warmed up at startup */
	lspServers?: Array<{ name: string; status: "ready" | "error"; fileTypes: string[]; error?: string }>;
	/** Shared event bus for interactive session observer wiring. */
	eventBus?: EventBus;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { EffectivePromptSnapshot } from "./context/effective-prompt-snapshot";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	FindTool,
	GrepTool,
	HIDDEN_TOOLS,
	loadSshTool,
	PythonTool,
	ReadTool,
	ResolveTool,
	type ToolSession,
	WriteTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// Discovery Functions

/**
 * Create an AuthStorage instance with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .claude).
 */
export async function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): Promise<AuthStorage> {
	const dbPath = getAgentDbPath(agentDir);
	logger.debug("discoverAuthStorage", { agentDir, dbPath });

	const storage = await AuthStorage.create(dbPath, { configValueResolver: resolveConfigValue });
	await storage.reload();
	return storage;
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getDefaultAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	appendPrompt?: string;
	repeatToolDescriptions?: boolean;
	secretsEnabled?: boolean;
}

/**
 * Build the default system prompt.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<string> {
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		repeatToolDescriptions: options.repeatToolDescriptions,
		secretsEnabled: options.secretsEnabled,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		searchDb: ctx.searchDb,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let pythonCleanupRegistered = false;

function registerPythonCleanup(): void {
	if (pythonCleanupRegistered) return;
	pythonCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
function finalizeRecallDebugTrace(
	trace: RecallDebugTrace,
	options: {
		turnId: string;
		selected: RecallSearchResult[];
		dropped: RecallSearchResult[];
		injectedText: string | null;
		injectedTokenEstimate: number;
		sessionId: string;
		projectCwd: string;
		recentWindowMs: number;
	},
): RecallDebugTrace {
	const now = Date.now();
	const provenance = new Map(
		trace.selected.map(entry => [
			entry.rowKey,
			{
				rowKey: entry.rowKey,
				semanticRank: entry.semanticRank,
				keywordRank: entry.keywordRank,
				source: entry.source,
			},
		]),
	);
	return {
		...trace,
		turnId: options.turnId,
		capturedAt: new Date(now).toISOString(),
		injected: !!options.injectedText,
		selected: buildRecallDebugEntries(options.selected, {
			now,
			sessionId: options.sessionId,
			projectCwd: options.projectCwd,
			recentWindowMs: options.recentWindowMs,
			provenance,
		}),
		dropped: buildRecallDebugEntries(options.dropped, {
			now,
			sessionId: options.sessionId,
			projectCwd: options.projectCwd,
			recentWindowMs: options.recentWindowMs,
			provenance,
		}),
		injectedText: options.injectedText,
		injectedTokenEstimate: options.injectedTokenEstimate,
	};
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: 'You are helpful.',
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerPythonCleanup();

	// Use provided or create AuthStorage and ModelRegistry
	const { authStorage, modelRegistry } = await logger.timeAsync("discoverModels", async () => {
		const authStorage = options.authStorage ?? (await discoverAuthStorage(agentDir));
		const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
		return { authStorage, modelRegistry };
	});

	const settings = await logger.timeAsync(
		"settings",
		async () => options.settings ?? (await Settings.init({ cwd, agentDir })),
	);
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? discoverSkills(cwd, agentDir, { ...skillsSettings, disabledExtensions: disabledExtensionIds })
			: undefined;

	// Initialize provider preferences from settings
	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (imageProvider === "auto" || imageProvider === "gemini" || imageProvider === "openrouter") {
		setPreferredImageProvider(imageProvider);
	}

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const sessionId = sessionManager.getSessionId();
	const modelApiKeyAvailability = new Map<string, boolean>();
	const getModelAvailabilityKey = (candidate: Model): string =>
		`${candidate.provider}\u0000${candidate.baseUrl ?? ""}`;
	const hasModelApiKey = async (candidate: Model): Promise<boolean> => {
		const availabilityKey = getModelAvailabilityKey(candidate);
		const cached = modelApiKeyAvailability.get(availabilityKey);
		if (cached !== undefined) {
			return cached;
		}

		const hasKey = !!(await modelRegistry.getApiKey(candidate, providerSessionId));
		modelApiKeyAvailability.set(availabilityKey, hasKey);
		return hasKey;
	};

	// Check if session has existing data to restore
	const existingSession = logger.time("loadSession", () => sessionManager.buildSessionContext());
	const existingBranch = sessionManager.getBranch();
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
	const modelMatchPreferences = {
		usageOrder: settings.getStorage()?.getModelUsageOrder(),
	};
	const defaultRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), modelRegistry.getAvailable(), {
		settings,
		matchPreferences: modelMatchPreferences,
	});
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	// If session has data, try to restore model from it.
	// Skip restore when an explicit model was requested.
	const defaultModelStr = existingSession.models.default;
	if (!hasExplicitModel && !model && hasExistingSession && defaultModelStr) {
		const parsedModel = parseModelString(defaultModelStr);
		if (parsedModel) {
			const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
			if (restoredModel && (await hasModelApiKey(restoredModel))) {
				model = restoredModel;
			}
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${defaultModelStr}`;
		}
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		if (await hasModelApiKey(defaultRoleSpec.model)) {
			model = defaultRoleSpec.model;
		}
	}

	const _taskDepth = options.taskDepth ?? 0;

	let thinkingLevel = options.thinkingLevel;

	// If session has data and includes a thinking entry, restore it
	if (thinkingLevel === undefined && hasExistingSession && hasThinkingEntry) {
		thinkingLevel = parseThinkingLevel(existingSession.thinkingLevel);
	}

	if (thinkingLevel === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
		thinkingLevel = defaultRoleSpec.thinkingLevel;
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settings.get("defaultThinkingLevel");
	}
	if (model) {
		thinkingLevel = resolveThinkingLevelForModel(model, thinkingLevel);
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await logger.timeAsync("discoverSkills", async () =>
			discoveredSkillsPromise ? await discoveredSkillsPromise : { skills: [], warnings: [] },
		);
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Discover rules
	const { ttsrManager, rulesResult, registeredTtsrRuleNames } = await logger.timeAsync(
		"discoverTtsrRules",
		async () => {
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
			const registeredTtsrRuleNames = new Set<string>();
			for (const rule of rulesResult.items) {
				if (rule.condition && rule.condition.length > 0) {
					if (ttsrManager.addRule(rule)) {
						registeredTtsrRuleNames.add(rule.name);
					}
				}
			}
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return { ttsrManager, rulesResult, registeredTtsrRuleNames };
		},
	);

	// Filter rules for the rulebook (non-TTSR, non-alwaysApply, with descriptions)
	const rulebookRules = logger.time("filterRulebookRules", () =>
		rulesResult.items.filter((rule: Rule) => {
			if (registeredTtsrRuleNames.has(rule.name)) return false;
			if (rule.alwaysApply) return false;
			if (!rule.description) return false;
			return true;
		}),
	);

	// collect alwaysApply rules — full content injected into system prompt
	const alwaysApplyRules = rulesResult.items.filter((rule: Rule) => {
		if (registeredTtsrRuleNames.has(rule.name)) return false;
		return rule.alwaysApply === true;
	});

	const contextFiles = await logger.timeAsync(
		"discoverContextFiles",
		async () => options.contextFiles ?? (await discoverContextFiles(cwd, agentDir)),
	);

	let agent: Agent;
	let session: AgentSession;

	const enableLsp = options.enableLsp ?? true;
	const asyncEnabled = settings.get("async.enabled");
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;
	const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}

		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return preview;
	};
	const asyncJobManager = asyncEnabled
		? new AsyncJobManager({
				maxRunningJobs: asyncMaxJobs,
				onJobComplete: async (jobId, result, job) => {
					if (!session) return;
					const formattedResult = await formatAsyncResultForFollowUp(result);
					const message = renderPromptTemplate(asyncResultTemplate, { jobId, result: formattedResult });
					const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
					await session.sendCustomMessage(
						{
							customType: "async-result",
							content: message,
							display: true,
							attribution: "agent",
							details: {
								jobId,
								type: job?.type,
								label: job?.label,
								durationMs,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			})
		: undefined;

	const searchDb = options.searchDb ?? new SearchDb(getSearchDbDir(agentDir));
	const pendingActionStore = new PendingActionStore();
	// Initialize recall store early so the recall tool can be created during tool setup.
	// Both the recall tool and ingest pipeline share the same store instance.
	let recallStore: RecallStore | undefined;
	let memexLicense: string | undefined;
	try {
		memexLicense = await resolveMemexLicense();
		recallStore = await RecallStore.open({
			agentDir,
			sessionId: sessionManager.getSessionId(),
		});
		postmortem.register("recall-store-close", () => recallStore!.close());
		logger.debug("RecallStore initialized for recall tool + ingest pipeline");
	} catch (err) {
		// No memex license or LanceDB init failure — recall is optional.
		logger.debug("Recall infrastructure not available", {
			error: err instanceof Error ? err.message : String(err),
		});
		recallStore = undefined;
		memexLicense = undefined;
	}

	// Initialize task store for persistent LLM-native task tracking.
	let taskStore: TaskStore | undefined;
	try {
		taskStore = await TaskStore.open(agentDir, cwd);
		postmortem.register("task-store-close", () => taskStore!.close());
		logger.debug("TaskStore initialized");
	} catch (err) {
		logger.debug("TaskStore not available", {
			error: err instanceof Error ? err.message : String(err),
		});
		taskStore = undefined;
	}

	// Initialize FTS5 tool result store for keyword search.
	let toolResultStore: ToolResultStore | undefined;
	try {
		toolResultStore = ToolResultStore.open(path.join(agentDir, "tool-results.db"));
		toolResultStore.cleanup(30 * 24 * 60 * 60 * 1000); // 30 days
		postmortem.register("tool-result-store-close", () => toolResultStore!.close());
		logger.debug("ToolResultStore initialized");
	} catch (err) {
		logger.debug("ToolResultStore not available", {
			error: err instanceof Error ? err.message : String(err),
		});
		toolResultStore = undefined;
	}

	const toolSession: ToolSession = {
		cwd,
		hasUI: options.hasUI ?? false,
		enableLsp,
		get hasEditTool() {
			return !options.toolNames || options.toolNames.includes("edit");
		},
		skipPythonPreflight: options.skipPythonPreflight,
		contextFiles,
		skills,
		eventBus,
		outputSchema: options.outputSchema,
		requireSubmitResultTool: options.requireSubmitResultTool,
		taskDepth: options.taskDepth ?? 0,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
		getSessionSpawns: () => options.spawns ?? "*",
		getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
		getActiveModelString: () => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			// Fall back to initial model during tool creation (before agent exists)
			if (model) return formatModelString(model);
			return undefined;
		},
		getPlanModeState: () => session.getPlanModeState(),
		getCompactContext: () => session.formatCompactContext(),
		getBaseSystemPrompt: () => session.baseSystemPrompt,
		getTodoPhases: () => session.getTodoPhases(),
		setTodoPhases: phases => session.setTodoPhases(phases),
		isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
		getDiscoverableMCPTools: () => session.getDiscoverableMCPTools(),
		getDiscoverableMCPSearchIndex: () => session.getDiscoverableMCPSearchIndex(),
		getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
		activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
		getCheckpointState: () => session.getCheckpointState(),
		setCheckpointState: state => session.setCheckpointState(state ?? undefined),
		allocateOutputArtifact: async toolType => {
			try {
				return await sessionManager.allocateArtifactPath(toolType);
			} catch {
				return {};
			}
		},
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager,
		pendingActionStore,
		recallStore,
		taskStore,
		toolResultStore,
		memexLicense,
		searchDb,
	};

	// Initialize internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, local://)
	const internalRouter = new InternalUrlRouter();
	const getArtifactsDir = () => sessionManager.getArtifactsDir();
	internalRouter.register(new AgentProtocolHandler({ getArtifactsDir }));
	internalRouter.register(new ArtifactProtocolHandler({ getArtifactsDir }));
	internalRouter.register(
		new MemoryProtocolHandler({
			getMemoryRoot: () => getMemoryRoot(agentDir, settings.getCwd()),
		}),
	);
	internalRouter.register(
		new LocalProtocolHandler({
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId(),
		}),
	);
	internalRouter.register(
		new SkillProtocolHandler({
			getSkills: () => skills,
		}),
	);
	internalRouter.register(
		new RuleProtocolHandler({
			getRules: () => [...rulebookRules, ...alwaysApplyRules],
		}),
	);
	internalRouter.register(new PiProtocolHandler());
	internalRouter.register(new JobsProtocolHandler({ getAsyncJobManager: () => asyncJobManager }));
	internalRouter.register(new McpProtocolHandler({ getMcpManager: () => mcpManager }));
	toolSession.internalRouter = internalRouter;
	toolSession.getArtifactsDir = getArtifactsDir;
	toolSession.agentOutputManager = new AgentOutputManager(
		getArtifactsDir,
		options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
	);

	// Create built-in tools (already wrapped with meta notice formatting)
	const builtinTools = await logger.timeAsync("createAllTools", () => createTools(toolSession, options.toolNames));

	// Discover MCP tools from .mcp.json files
	let mcpManager: MCPManager | undefined;
	const enableMCP = options.enableMCP ?? true;
	const customTools: CustomTool[] = [];
	if (enableMCP) {
		const mcpResult = await logger.timeAsync("discoverAndLoadMCPTools", () =>
			discoverAndLoadMCPTools(cwd, {
				onConnecting: serverNames => {
					if (options.hasUI && serverNames.length > 0) {
						process.stderr.write(`${chalk.gray(`Connecting to MCP servers: ${serverNames.join(", ")}…`)}\n`);
					}
				},
				enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
				// Always filter Exa - we have native integration
				filterExa: true,
				// Filter browser MCP servers when builtin browser tool is active
				filterBrowser: settings.get("browser.enabled") ?? false,
				cacheStorage: settings.getStorage(),
				authStorage,
			}),
		);
		mcpManager = mcpResult.manager;
		toolSession.mcpManager = mcpManager;

		if (settings.get("mcp.notifications")) {
			mcpManager.setNotificationsEnabled(true);
		}
		// If we extracted Exa API keys from MCP configs and EXA_API_KEY isn't set, use the first one
		if (mcpResult.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
			Bun.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
		}

		// Log MCP errors
		for (const { path, error } of mcpResult.errors) {
			logger.error("MCP tool load failed", { path, error });
		}

		if (mcpResult.tools.length > 0) {
			// MCP tools are LoadedCustomTool, extract the tool property
			customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
		}
	}

	// Add Gemini image tools if GEMINI_API_KEY (or GOOGLE_API_KEY) is available
	const geminiImageTools = await logger.timeAsync("getGeminiImageTools", getGeminiImageTools);
	if (geminiImageTools.length > 0) {
		customTools.push(...(geminiImageTools as unknown as CustomTool[]));
	}

	// Add web search tools
	customTools.push(...getSearchTools());

	// Discover and load custom tools from .omp/tools/, .claude/tools/, etc.
	const builtInToolNames = builtinTools.map(t => t.name);
	const discoveredCustomTools = await logger.timeAsync(
		"discoverAndLoadCustomTools",
		discoverAndLoadCustomTools,
		[],
		cwd,
		builtInToolNames,
		pendingActionStore,
	);
	for (const { path, error } of discoveredCustomTools.errors) {
		logger.error("Custom tool load failed", { path, error });
	}
	if (discoveredCustomTools.tools.length > 0) {
		customTools.push(...discoveredCustomTools.tools.map(loaded => loaded.tool));
	}

	const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
	inlineExtensions.push(createAutoresearchExtension);
	if (customTools.length > 0) {
		inlineExtensions.push(createCustomToolsExtension(customTools));
	}

	// Load extensions (discovers from standard locations + configured paths)
	let extensionsResult: LoadExtensionsResult;
	if (options.disableExtensionDiscovery) {
		const configuredPaths = options.additionalExtensionPaths ?? [];
		extensionsResult = await logger.timeAsync("loadExtensions", loadExtensions, configuredPaths, cwd, eventBus);
		for (const { path, error } of extensionsResult.errors) {
			logger.error("Failed to load extension", { path, error });
		}
	} else if (options.preloadedExtensions) {
		extensionsResult = options.preloadedExtensions;
	} else {
		// Merge CLI extension paths with settings extension paths
		const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
		const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
		extensionsResult = await logger.timeAsync(
			"discoverAndLoadExtensions",
			discoverAndLoadExtensions,
			configuredPaths,
			cwd,
			eventBus,
			disabledExtensionIds,
		);
		for (const { path, error } of extensionsResult.errors) {
			logger.error("Failed to load extension", { path, error });
		}
	}

	// Load inline extensions from factories
	if (inlineExtensions.length > 0) {
		for (let i = 0; i < inlineExtensions.length; i++) {
			const factory = inlineExtensions[i];
			const loaded = await loadExtensionFromFactory(
				factory,
				cwd,
				eventBus,
				extensionsResult.runtime,
				`<inline-${i}>`,
			);
			extensionsResult.extensions.push(loaded);
		}
	}

	// Process provider registrations queued during extension loading.
	// This must happen before the runner is created so that models registered by
	// extensions are available for model selection on session resume / fallback.
	const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeExtensionSources);
	for (const sourceId of new Set(activeExtensionSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
		for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
			modelRegistry.registerProvider(name, config, sourceId);
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
	}

	// Resolve deferred --model pattern now that extension models are registered.
	if (!model && options.modelPattern) {
		const availableModels = modelRegistry.getAll();
		const matchPreferences = {
			usageOrder: settings.getStorage()?.getModelUsageOrder(),
		};
		const { model: resolved } = parseModelPattern(options.modelPattern, availableModels, matchPreferences);
		if (resolved) {
			model = resolved;
			modelFallbackMessage = undefined;
		} else {
			modelFallbackMessage = `Model "${options.modelPattern}" not found`;
		}
	}

	// Fall back to first available model with a valid API key.
	// Skip fallback if the user explicitly requested a model via --model that wasn't found.
	if (!model && !options.modelPattern) {
		const allModels = modelRegistry.getAll();
		for (const candidate of allModels) {
			if (await hasModelApiKey(candidate)) {
				model = candidate;
				break;
			}
		}
		if (model) {
			if (modelFallbackMessage) {
				modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
		} else {
			modelFallbackMessage =
				"No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
		}
	}

	// Discover custom commands (TypeScript slash commands)
	const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
		? { commands: [], errors: [] }
		: await logger.timeAsync("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
	if (!options.disableExtensionDiscovery) {
		for (const { path, error } of customCommandsResult.errors) {
			logger.error("Failed to load custom command", { path, error });
		}
	}

	let extensionRunner: ExtensionRunner | undefined;
	if (extensionsResult.extensions.length > 0) {
		extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
		);
	}

	const getSessionContext = () => ({
		sessionManager,
		modelRegistry,
		model: agent.state.model,
		isIdle: () => !session.isStreaming,
		hasQueuedMessages: () => session.queuedMessageCount > 0,
		abort: () => {
			session.abort();
		},
		settings,
	});
	const toolContextStore = new ToolContextStore(getSessionContext);

	const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];
	let wrappedExtensionTools: Tool[];

	if (extensionRunner) {
		// With extension runner: convert CustomTools to ToolDefinitions and wrap all together
		const allCustomTools = [
			...registeredTools,
			...(options.customTools?.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>" };
			}) ?? []),
		];
		wrappedExtensionTools = wrapRegisteredTools(allCustomTools, extensionRunner);
	} else {
		// Without extension runner: wrap CustomTools directly with CustomToolAdapter
		// ToolDefinition items require ExtensionContext and cannot be used without a runner
		const customToolContext = (): CustomToolContext => ({
			sessionManager,
			modelRegistry,
			model: agent?.state.model,
			searchDb,
			isIdle: () => !session?.isStreaming,
			hasQueuedMessages: () => (session?.queuedMessageCount ?? 0) > 0,
			abort: () => session?.abort(),
			settings,
		});
		wrappedExtensionTools = (options.customTools ?? [])
			.filter(isCustomTool)
			.map(tool => CustomToolAdapter.wrap(tool, customToolContext));
	}

	// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
	const toolRegistry = new Map<string, Tool>();
	for (const tool of builtinTools) {
		toolRegistry.set(tool.name, tool);
	}
	for (const tool of wrappedExtensionTools) {
		toolRegistry.set(tool.name, tool);
	}
	if (extensionRunner) {
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}
	}
	if (model?.provider === "cursor") {
		toolRegistry.delete("edit");
	}

	const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
	if (!hasDeferrableTools) {
		toolRegistry.delete("resolve");
	} else if (!toolRegistry.has("resolve")) {
		const resolveTool = await logger.timeAsync("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
		if (resolveTool) {
			toolRegistry.set(resolveTool.name, wrapToolWithMetaNotice(resolveTool));
		}
	}

	let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
	const cursorExecHandlers = new CursorExecHandlers({
		cwd,
		tools: toolRegistry,
		getToolContext: () => toolContextStore.getContext(),
		emitEvent: event => cursorEventEmitter?.(event),
	});

	const repeatToolDescriptions = settings.get("repeatToolDescriptions");
	const eagerTasks = settings.get("task.eager");
	const intentField = settings.get("tools.intentTracing") || $env.PI_INTENT_TRACING === "1" ? INTENT_FIELD : undefined;
	let obfuscator: SecretObfuscator | undefined;
	const rebuildSystemPrompt = async (toolNames: string[], tools: Map<string, AgentTool>): Promise<string> => {
		toolContextStore.setToolNames(toolNames);
		const discoverableMCPTools = mcpDiscoveryEnabled ? collectDiscoverableMCPTools(tools.values()) : [];
		const discoverableMCPSummary = summarizeDiscoverableMCPTools(discoverableMCPTools);
		const hasDiscoverableMCPTools =
			mcpDiscoveryEnabled && toolNames.includes("search_tool_bm25") && discoverableMCPTools.length > 0;
		const promptTools = buildSystemPromptToolMetadata(tools, {
			search_tool_bm25: { description: renderSearchToolBm25Description(discoverableMCPTools) },
		});

		const defaultPrompt = await buildSystemPromptInternal({
			cwd,
			skills,
			contextFiles,
			tools: promptTools,
			toolNames,
			rules: rulebookRules,
			alwaysApplyRules,
			skillsSettings: settings.getGroup("skills"),
			repeatToolDescriptions,
			intentField,
			mcpDiscoveryMode: hasDiscoverableMCPTools,
			mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
			eagerTasks,
			secretsEnabled: obfuscator?.hasSecrets() ?? false,
		});

		const applySystemPromptOverride = async (basePrompt: string): Promise<string> => {
			if (options.systemPrompt === undefined) {
				return basePrompt;
			}
			if (typeof options.systemPrompt === "string") {
				return await buildSystemPromptInternal({
					cwd,
					skills,
					contextFiles,
					tools: promptTools,
					toolNames,
					rules: rulebookRules,
					alwaysApplyRules,
					skillsSettings: settings.getGroup("skills"),
					customPrompt: options.systemPrompt,
					repeatToolDescriptions,
					intentField,
					mcpDiscoveryMode: hasDiscoverableMCPTools,
					mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
					eagerTasks,
					secretsEnabled: obfuscator?.hasSecrets() ?? false,
				});
			}
			return options.systemPrompt(basePrompt);
		};

		// If composer is enabled, compile the system prompt with an LLM
		if (settings.get("composer.enabled")) {
			try {
				const toolInfo = toolNames.map(name => ({
					name,
					label: promptTools.get(name)?.label ?? name,
					description: promptTools.get(name)?.description ?? "",
				}));
				const activeComposerModel = agent?.state.model ?? model;
				if (!activeComposerModel) {
					throw new Error("composer: no active session model available");
				}
				if (options.hasUI && !agent) {
					process.stderr.write(
						`${chalk.gray(`Building session prompt with ${activeComposerModel.provider}/${activeComposerModel.id}…`)}\n`,
					);
				}

				const composerApiKey = await modelRegistry.getApiKey(activeComposerModel, providerSessionId);
				if (!composerApiKey) {
					throw new Error(
						`composer: no session auth available for ${activeComposerModel.provider}/${activeComposerModel.id}`,
					);
				}

				const result = await compileSystemPrompt({
					model: activeComposerModel,
					apiKey: composerApiKey,
					inventory: {
						tools: toolInfo,
						editMode: String(settings.get("edit.mode") ?? "hashline"),
						skills: skills.map(s => ({ name: s.name, description: (s as any).frontmatter?.description ?? "" })),
						environment: [
							{ label: "OS", value: `${process.platform} ${process.arch}` },
							{ label: "CWD", value: cwd },
						],
						intentField,
						cwd,
					},
					contextFiles: contextFiles.map(f => `## ${f.path}\n${f.content}`).join("\n\n"),
					invariants: composerInvariants,
					tokenBudget: Number(settings.get("composer.tokenBudget") ?? 24000),
				});

				logger.debug("composer: using compiled system prompt", {
					model: result.modelId,
					durationMs: result.durationMs,
					cacheHit: result.cacheHit,
					length: result.systemPrompt.length,
				});

				return await applySystemPromptOverride(result.systemPrompt);
			} catch (err) {
				logger.warn("composer: falling back to static template", {
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}

		return await applySystemPromptOverride(defaultPrompt);
	};

	const toolNamesFromRegistry = Array.from(toolRegistry.keys());
	const requestedToolNames = options.toolNames?.map(name => name.toLowerCase()) ?? toolNamesFromRegistry;
	const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
	const includeExitPlanMode = requestedToolNames.includes("exit_plan_mode");
	const mcpDiscoveryEnabled = settings.get("mcp.discoveryMode") ?? false;
	const defaultInactiveToolNames = new Set(
		registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
	);
	const requestedActiveToolNames = includeExitPlanMode
		? normalizedRequested
		: normalizedRequested.filter(name => name !== "exit_plan_mode");
	const initialRequestedActiveToolNames = options.toolNames
		? requestedActiveToolNames
		: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
	const explicitlyRequestedMCPToolNames = options.toolNames
		? requestedActiveToolNames.filter(name => name.startsWith("mcp_"))
		: [];
	const discoveryDefaultServers = new Set(
		(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
	);
	const discoveryDefaultServerToolNames = mcpDiscoveryEnabled
		? selectDiscoverableMCPToolNamesByServer(
				collectDiscoverableMCPTools(toolRegistry.values()),
				discoveryDefaultServers,
			)
		: [];
	let initialSelectedMCPToolNames: string[] = [];
	let defaultSelectedMCPToolNames: string[] = [];
	let initialToolNames = [...initialRequestedActiveToolNames];
	if (mcpDiscoveryEnabled) {
		const restoredSelectedMCPToolNames = existingSession.selectedMCPToolNames.filter(name => toolRegistry.has(name));
		defaultSelectedMCPToolNames = [
			...new Set([...discoveryDefaultServerToolNames, ...explicitlyRequestedMCPToolNames]),
		];
		initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
			? restoredSelectedMCPToolNames
			: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
		initialToolNames = [
			...new Set([
				...initialRequestedActiveToolNames.filter(name => !name.startsWith("mcp_")),
				...initialSelectedMCPToolNames,
			]),
		];
	}

	// Custom tools and extension-registered tools are always included regardless of toolNames filter
	const alwaysInclude: string[] = [
		...(options.customTools?.map(t => (isCustomTool(t) ? t.name : t.name)) ?? []),
		...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
	];
	for (const name of alwaysInclude) {
		if (mcpDiscoveryEnabled && name.startsWith("mcp_")) {
			continue;
		}
		if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
			initialToolNames.push(name);
		}
	}

	if (settings.get("secrets.enabled")) {
		const fileEntries = await logger.timeAsync("loadSecrets", loadSecrets, cwd, agentDir);
		const envEntries = collectEnvSecrets();
		const allEntries = [...envEntries, ...fileEntries];
		if (allEntries.length > 0) {
			obfuscator = new SecretObfuscator(allEntries);
		}
	}

	// Build the system prompt after secret loading so redaction guidance matches the active obfuscator.
	const systemPrompt = await logger.timeAsync(
		"buildSystemPrompt",
		rebuildSystemPrompt,
		initialToolNames,
		toolRegistry,
	);

	const promptTemplates =
		options.promptTemplates ??
		(await logger.timeAsync("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir));
	toolSession.promptTemplates = promptTemplates;

	const slashCommands =
		options.slashCommands ?? (await logger.timeAsync("discoverSlashCommands", discoverSlashCommands, cwd));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settings.get("images.blockImages")) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map(msg => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some(c => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map(c => (c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c))
							.filter((c, i, arr) => {
								// Dedupe consecutive "Image reading is disabled." texts
								if (!(c.type === "text" && c.text === "Image reading is disabled." && i > 0)) return true;
								const prev = arr[i - 1];
								return !(prev.type === "text" && prev.text === "Image reading is disabled.");
							});
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	// Final convertToLlm: chain block-images filter with secret obfuscation
	const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlmWithBlockImages(messages);
		if (!obfuscator?.hasSecrets()) return converted;
		return obfuscateMessages(obfuscator, converted);
	};
	const onPayload = extensionRunner
		? async (payload: unknown, _model?: Model) => {
				return await extensionRunner.emitBeforeProviderRequest(payload);
			}
		: undefined;

	const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
		toolContextStore.setUIContext(uiContext, hasUI);
	};

	const initialTools = initialToolNames
		.map(name => toolRegistry.get(name))
		.filter((tool): tool is AgentTool => tool !== undefined);

	const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "auto";
	const preferOpenAICodexWebsockets =
		openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
	const serviceTierSetting = settings.get("serviceTier");

	// Pre-create bridge so it's available to transformContext.
	// Event subscription is wired after session creation below.
	const assemblerBridge = new ToolResultBridge();

	// Initialize recall ingest pipeline and passive hydrator.
	// Reuses the RecallStore + license initialized earlier (before tool creation).
	let ingestPipeline: IngestPipeline | undefined;
	let passiveHydrator: PassiveHydrator | undefined;
	if (recallStore && memexLicense) {
		ingestPipeline = new IngestPipeline({
			store: recallStore,
			toolResultStore,
			license: memexLicense,
			sessionId: sessionManager.getSessionId(),
			projectCwd: cwd,
		});
		passiveHydrator = new PassiveHydrator({
			store: recallStore,
			toolResultStore,
			license: memexLicense,
			projectCwd: cwd,
			sessionId,
			recentWindowMs: daysToRecallWindowMs(settings.get("assembler.recentWindowDays")),
		});
		logger.debug("Recall pipeline initialized (ingest + passive hydration)");
	}

	// Build per-turn context transformer.
	// In assembler mode, passively hydrated context is injected as a developer message.
	// Extensions transform is always composed when available.
	// All modes capture an effective-prompt snapshot for canonical observability.
	let lastPromptSnapshot: EffectivePromptSnapshot | null = null;
	let lastRecallTrace: RecallDebugTrace | null = null;
	const recallTraceHistory: RecallDebugTrace[] = [];
	const transformContext = (() => {
		const extensionTransform = extensionRunner
			? (messages: AgentMessage[]) => extensionRunner.emitContext(messages)
			: undefined;

		// Read assembler settings once at closure creation. Settings are static
		// for the session lifetime — no need to re-read per turn.
		const assemblerSettings = settings.getGroup("assembler") as AssemblerSettings;
		const hotWindowTurns = assemblerSettings.hotWindowTurns;
		const contextWindowCap = assemblerSettings.contextWindowCap;
		const recentWindowMs = daysToRecallWindowMs(assemblerSettings.recentWindowDays);

		const resolveToolResultStub = (message: { toolName?: string; toolCallId?: string }) =>
			assemblerBridge.getToolResultStubPointer(message.toolName, message.toolCallId);

		const codecs = [dedupCodec, readCodec, warmCodec]; // Order matters: dedup → read → warm (catch-all)

		const assemblerTransform = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
			// Derive budget from current model context window and measured costs.
			// agent.state is read each turn to reflect model/tool changes mid-session.
			const currentModel = agent?.state.model;
			const currentSystemPrompt = agent?.state.systemPrompt ?? "";
			const currentTools = agent?.state.tools ?? [];
			const modelWindow = currentModel?.contextWindow ?? 0;
			const assembledContextWindow = contextWindowCap > 0 ? Math.min(modelWindow, contextWindowCap) : modelWindow;

			// Step 1: Apply message transform (hot window + content replacement).
			// This strips tool_result content from older turns before budget derivation
			// so the budget reflects actual post-transform message costs.
			const firstPass = transformMessages(messages, {
				hotWindowTurns,
				resolveToolResultStub,
				codecs,
			});
			const transformedMessages = firstPass.messages;

			const budget = currentModel
				? deriveBudget({
						contextWindow: assembledContextWindow,
						modelContextWindow: modelWindow,
						systemPromptTokens: Math.ceil(currentSystemPrompt.length / 4),
						toolDefinitionTokens: estimateToolDefinitionTokens(currentTools),
						currentTurnTokens: 0,
						safetyMarginPercent: assemblerSettings.safetyMarginPercent,
						messageBudgetPercent: assemblerSettings.messageBudgetPercent,
						hydrationBudgetPercent: assemblerSettings.hydrationBudgetPercent,
						turnBufferPercent: assemblerSettings.turnBufferPercent,
					})
				: undefined;

			// Step 2: Run passive hydration (embed hot window -> cache check -> search -> MMR).
			const hydration = passiveHydrator
				? await passiveHydrator.hydrate(messages)
				: { text: null, results: [], cacheHit: false, durationMs: 0, trace: null };

			logger.debug("assembler:passive-hydration", {
				resultCount: hydration.results.length,
				cacheHit: hydration.cacheHit,
				durationMs: Math.round(hydration.durationMs),
			});

			// Step 3: Enforce hydration cap at entry level.
			// When hydrated tokens exceed budget.hydrationBudgetMax, drop lower-priority
			// temporal bands (durable → recent → live) until the formatted XML fits.
			// Never truncate the XML blob.
			let cappedResults = hydration.results;
			let hydratedText = hydration.text;
			let hydratedTokens = hydratedText ? estimateMessageTokens([{ role: "developer", content: hydratedText }]) : 0;
			let droppedEntries: RecallSearchResult[] = [];

			if (budget && hydratedTokens > budget.hydrationBudgetMax && cappedResults.length > 0) {
				// Drop lower-priority temporal bands first (durable → recent → live),
				// using real token counts via formatHydratedContext + estimateMessageTokens
				// each iteration to account for XML wrapper overhead accurately.
				const remaining = [...cappedResults];
				const droppedDuringCap: RecallSearchResult[] = [];
				while (remaining.length > 0) {
					const candidateText = formatHydratedContext(remaining, {
						currentSessionId: sessionId,
						currentProjectCwd: cwd,
						recentWindowMs,
					});
					const candidateTokens = candidateText
						? estimateMessageTokens([{ role: "developer", content: candidateText }])
						: 0;
					if (candidateTokens <= budget.hydrationBudgetMax) break;
					const dropIndex = selectHydrationResultIndexToDrop(remaining, { recentWindowMs });
					droppedDuringCap.push(remaining[dropIndex]);
					remaining.splice(dropIndex, 1);
				}

				if (remaining.length < cappedResults.length) {
					const droppedAt = Date.now();
					logger.debug("assembler:hydration-cap-enforced", {
						originalEntries: cappedResults.length,
						survivingEntries: remaining.length,
						hydrationBudgetMax: budget.hydrationBudgetMax,
						droppedEntries: droppedDuringCap.map(entry => {
							const ageMs = getRecallAgeMs(entry.timestamp, droppedAt);
							return {
								turn: entry.turn,
								band: getRecallBand(ageMs, recentWindowMs),
								age: formatRecallAge(ageMs),
								session: entry.session_id === sessionId ? "current" : "other",
								project: entry.project_cwd === cwd ? "current" : "other",
							};
						}),
					});
					droppedEntries = droppedDuringCap;
					cappedResults = remaining;
					hydratedText =
						remaining.length > 0
							? formatHydratedContext(remaining, {
									currentSessionId: sessionId,
									currentProjectCwd: cwd,
									recentWindowMs,
								})
							: null;
					hydratedTokens = hydratedText
						? estimateMessageTokens([{ role: "developer", content: hydratedText }])
						: 0;
				}
			}

			// Step 3b: Compute semantic relevance scores for conversation compression.
			// Uses the hot window embedding from hydration to search LanceDB for similar
			// past content. Builds per-segmented-turn relevance scores so the transform
			// can compress non-tool turns that are no longer semantically relevant.
			let relevanceScores: Map<number, number> | undefined;
			if (passiveHydrator && recallStore) {
				const hotEmbedding = passiveHydrator.lastEmbedding;
				logger.debug("assembler:relevance-gate", {
					hasHydrator: !!passiveHydrator,
					hasStore: !!recallStore,
					hasEmbedding: !!hotEmbedding,
					embeddingLength: hotEmbedding?.length ?? 0,
				});
				if (hotEmbedding) {
					try {
						const turns = segmentIntoTurns(messages);
						const hotStart = Math.max(0, turns.length - hotWindowTurns);

						// Identify candidate segmented turns (non-tool, non-hot-window)
						const candidates: Array<{ turnIdx: number; text: string }> = [];
						for (let i = 0; i < hotStart; i++) {
							if (turns[i].hasToolResults) continue;
							// Extract text using the same functions as IngestPipeline
							// so that text matching against LanceDB results works.
							const msg = turns[i].messages[0];
							if (!msg) continue;
							const content = (msg as { content?: unknown }).content;
							let turnText: string;
							if (msg.role === "user" || msg.role === "developer") {
								turnText = extractUserText(content as Parameters<typeof extractUserText>[0]);
							} else if (msg.role === "assistant") {
								turnText = extractAssistantText(content as Parameters<typeof extractAssistantText>[0]);
							} else {
								continue;
							}
							if (turnText) candidates.push({ turnIdx: i, text: turnText });
						}

						if (candidates.length > 0) {
							// Search LanceDB with hot window embedding for this session
							const sessionFilter = `session_id = '${sessionId.replace(/'/g, "''")}'`;
							const searchResults = await recallStore.search(
								Array.from(hotEmbedding),
								Math.min(candidates.length * 3, 500),
								sessionFilter,
							);

							if (searchResults.length > 0) {
								// Build text → similarity lookup from search results.
								// LanceDB _distance is L2 distance; convert to similarity
								// score (lower distance = higher similarity).
								const textSimilarity = new Map<string, number>();
								for (const result of searchResults) {
									if (!textSimilarity.has(result.text)) {
										const sim = 1 / (1 + result._distance);
										textSimilarity.set(result.text, sim);
									}
								}

								// Match candidate turns to search results by text content
								relevanceScores = new Map();
								for (const candidate of candidates) {
									const sim = textSimilarity.get(candidate.text);
									if (sim !== undefined) {
										relevanceScores.set(candidate.turnIdx, sim);
									}
									// Missing = no embedding found = defaults to keep (handled in transformMessages)
								}

								logger.debug("assembler:relevance-scores", {
									candidates: candidates.length,
									searchResults: searchResults.length,
									scored: relevanceScores.size,
								});
							}
						}
					} catch (err) {
						logger.debug("assembler:relevance-scoring-failed", { error: String(err) });
					}
				}
			} else {
				logger.debug("assembler:relevance-gate-skip", {
					hasHydrator: !!passiveHydrator,
					hasStore: !!recallStore,
				});
			}

			// Step 4: Compute elastic message budget.
			// Messages get: allocatable - actual hydration, floored at messageBudgetMin.
			// This means messages expand into unused hydration capacity.
			let maxMessageTokens: number | undefined;
			if (budget) {
				const effectiveBudget = Math.max(budget.messageBudgetMin, budget.maxTokens - hydratedTokens);
				maxMessageTokens = effectiveBudget;
			}

			let boundedMessages: AgentMessage[];
			let finalTransformMetadata: TransformMetadata;
			if (maxMessageTokens !== undefined) {
				const boundedPass = transformMessages(messages, {
					maxTokens: maxMessageTokens,
					hotWindowTurns,
					resolveToolResultStub,
					codecs,
					relevanceScores,
				});
				boundedMessages = boundedPass.messages;
				finalTransformMetadata = boundedPass.metadata;
			} else {
				boundedMessages = transformedMessages;
				finalTransformMetadata = firstPass.metadata;
			}

			// Step 5: Budget debug logging — per-category allocation and actual usage.
			if (budget) {
				logger.debug("assembler:budget-derivation", {
					contextWindow: assembledContextWindow,
					allocatable: budget.maxTokens,
					hydrationBudgetMax: budget.hydrationBudgetMax,
					messageBudgetMin: budget.messageBudgetMin,
					actualHydratedTokens: hydratedTokens,
					effectiveMessageBudget: maxMessageTokens,
					messageTokensAfterTransform: finalTransformMetadata.tokensAfter,
					hydratedEntries: cappedResults.length,
				});
			}

			// Step 6: Inject hydrated context as developer message.
			const finalMessages = hydratedText
				? [
						{
							role: "developer" as const,
							content: hydratedText,
							attribution: "agent" as const,
							timestamp: Date.now(),
						} satisfies AgentMessage,
						...boundedMessages,
					]
				: boundedMessages;

			// Step 7: Capture effective-prompt snapshot.
			const turnId = `turn-${Date.now()}`;
			lastPromptSnapshot = captureEffectivePromptSnapshot({
				turnId,
				model: currentModel,
				systemPrompt: currentSystemPrompt,
				tools: currentTools,
				finalMessages,
				transformMetadata: finalTransformMetadata,
				assemblerPacket: null,
				assemblerBudget: budget ?? null,
			});

			if (hydration.trace) {
				const finalizedTrace = finalizeRecallDebugTrace(hydration.trace, {
					turnId,
					selected: cappedResults,
					dropped: droppedEntries,
					injectedText: hydratedText,
					injectedTokenEstimate: hydratedTokens,
					sessionId,
					projectCwd: cwd,
					recentWindowMs,
				});
				lastRecallTrace = finalizedTrace;
				recallTraceHistory.push(finalizedTrace);
				if (recallTraceHistory.length > 20) {
					recallTraceHistory.shift();
				}
			}

			// Step 8: Inject assembly summary as developer message.
			const summary = formatAssemblySummary(lastPromptSnapshot);
			if (summary) {
				return [
					{
						role: "developer" as const,
						content: summary,
						attribution: "agent" as const,
						timestamp: Date.now(),
					} satisfies AgentMessage,
					...finalMessages,
				];
			}

			return finalMessages;
		};

		// Compose: extensions first, then assembler.
		const innerTransform = extensionTransform
			? async (msgs: AgentMessage[]) => assemblerTransform(await extensionTransform(msgs))
			: assemblerTransform;

		return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
			return innerTransform(messages);
		};
	})();
	const initialServiceTier = hasServiceTierEntry
		? existingSession.serviceTier
		: serviceTierSetting === "none"
			? undefined
			: serviceTierSetting;

	agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: toReasoningEffort(thinkingLevel),
			tools: initialTools,
		},
		convertToLlm: convertToLlmFinal,
		onPayload,
		sessionId: providerSessionId,
		transformContext,
		steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
		followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
		interruptMode: settings.get("interruptMode") ?? "immediate",
		thinkingBudgets: settings.getGroup("thinkingBudgets"),
		temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
		topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
		topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
		minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
		presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
		repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
		serviceTier: initialServiceTier,
		kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
		preferWebsockets: preferOpenAICodexWebsockets,
		getToolContext: tc => toolContextStore.getContext(tc),
		getApiKey: async provider => {
			// Use the provider-facing session id for sticky credential selection so cache keys
			// and provider auth affinity stay aligned across fresh benchmark sessions.
			const key = await modelRegistry.getApiKeyForProvider(provider, providerSessionId);
			if (!key) {
				throw new Error(`No API key found for provider "${provider}"`);
			}
			return key;
		},
		cursorExecHandlers,
		transformToolCallArguments: (args, _toolName) => {
			let result = args;
			const maxTimeout = settings.get("tools.maxTimeout");
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = obfuscator.deobfuscateObject(result);
			}
			return result;
		},
		intentTracing: !!intentField,
		getToolChoice: () => {
			if (pendingActionStore.hasPending) {
				return { type: "function", name: "resolve" };
			}
			return session?.consumeNextToolChoiceOverride();
		},
	});
	cursorEventEmitter = event => agent.emitExternalEvent(event);

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.replaceMessages(existingSession.messages);
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(`${model.provider}/${model.id}`);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	session = new AgentSession({
		agent,
		thinkingLevel,
		sessionManager,
		settings,
		scopedModels: options.scopedModels,
		promptTemplates,
		slashCommands,
		extensionRunner,
		customCommands: customCommandsResult.commands,
		skills,
		skillWarnings,
		skillsSettings: settings.getGroup("skills"),
		modelRegistry,
		toolRegistry,
		transformContext,
		onPayload,
		convertToLlm: convertToLlmFinal,
		rebuildSystemPrompt,
		mcpDiscoveryEnabled,
		initialSelectedMCPToolNames,
		defaultSelectedMCPToolNames,
		persistInitialMCPToolSelection: !hasExistingSession,
		defaultSelectedMCPServerNames: [...discoveryDefaultServers],
		ttsrManager,
		obfuscator,
		asyncJobManager,
		pendingActionStore,
		assemblerBridge,
		getLastPromptSnapshotFn: () => lastPromptSnapshot,
		getLastRecallTraceFn: () => lastRecallTrace,
		getRecallTraceHistoryFn: () => recallTraceHistory,
		searchDb,
	});

	if (model?.api === "openai-codex-responses") {
		try {
			await logger.timeAsync("prewarmCodexWebsocket", prewarmOpenAICodexResponses, model, {
				apiKey: await modelRegistry.getApiKey(model, providerSessionId),
				sessionId: providerSessionId,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
		} catch (error) {
			logger.debug("Codex websocket prewarm failed", {
				error: error instanceof Error ? error.message : String(error),
				provider: model.provider,
				model: model.id,
			});
		}
	}

	// Warm up LSP servers (connects to detected servers)
	let lspServers: CreateAgentSessionResult["lspServers"];
	if (enableLsp && settings.get("lsp.diagnosticsOnWrite")) {
		try {
			const result = await logger.timeAsync("warmupLspServers", warmupLspServers, cwd, {
				onConnecting: serverNames => {
					if (options.hasUI && serverNames.length > 0) {
						process.stderr.write(chalk.gray(`Starting LSP servers: ${serverNames.join(", ")}…\n`));
					}
				},
			});
			lspServers = result.servers;
		} catch (error) {
			logger.warn("LSP server warmup failed", { cwd, error: String(error) });
		}
	}

	// Legacy memory startup removed. Assembler is the sole context mode.

	// Wire tool-result bridge + ingest pipeline.
	{
		const pendingArgs = new Map<string, unknown>();
		let ingestTurn = 0;
		session.subscribe(event => {
			if (event.type === "tool_execution_start") {
				pendingArgs.set(event.toolCallId, event.args);
			} else if (event.type === "tool_execution_end") {
				const args = pendingArgs.get(event.toolCallId) ?? {};
				pendingArgs.delete(event.toolCallId);
				const profile = assemblerBridge.handleToolResult(
					event.toolName,
					event.toolCallId,
					args,
					event.result,
					event.isError ?? false,
				);

				// Ingest tool result into LanceDB
				if (ingestPipeline) {
					const resultText =
						typeof event.result === "string" ? event.result : (JSON.stringify(event.result) ?? "");
					const safeArgs = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
					ingestPipeline.ingest({
						text: resultText,
						role: "tool_result",
						turn: ingestTurn,
						toolName: event.toolName,
						paths: extractPaths(event.toolName, safeArgs),
						symbols: profile?.touchedSymbols,
					});
				}
			}

			// Ingest conversation messages into the aligned recall stores.
			if (event.type === "message_end") {
				const msg = event.message;
				if (msg.role === "user") {
					const text = extractUserText(msg.content);
					if (ingestPipeline) {
						ingestPipeline.ingest({
							text,
							role: "user",
							turn: ingestTurn,
							paths: extractPathsFromText(text),
						});
					}
				} else if (msg.role === "assistant") {
					const text = extractAssistantText(msg.content);
					if (ingestPipeline) {
						ingestPipeline.ingest({
							text,
							role: "assistant",
							turn: ingestTurn,
							paths: extractPathsFromText(text),
						});
					}
				}
			}

			if (event.type === "turn_end") {
				ingestTurn++;
			}
		});
		logger.debug("Tool-result bridge wired");
	}

	// Wire MCP manager callbacks to session for reactive tool updates
	if (mcpManager) {
		mcpManager.setOnToolsChanged(tools => {
			void session.refreshMCPTools(tools);
		});
		// Wire prompt refresh → rebuild MCP prompt slash commands
		mcpManager.setOnPromptsChanged(serverName => {
			const promptCommands = buildMCPPromptCommands(mcpManager);
			session.setMCPPromptCommands(promptCommands);
			logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
		});
		const notificationDebounceTimers = new Map<string, Timer>();
		const clearDebounceTimers = () => {
			for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
			notificationDebounceTimers.clear();
		};
		postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
		mcpManager.setOnResourcesChanged((serverName, uri) => {
			logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
			if (!settings.get("mcp.notifications")) return;
			const debounceMs = settings.get("mcp.notificationDebounceMs");
			const key = `${serverName}:${uri}`;
			const existing = notificationDebounceTimers.get(key);
			if (existing) clearTimeout(existing);
			notificationDebounceTimers.set(
				key,
				setTimeout(() => {
					notificationDebounceTimers.delete(key);
					// Re-check: user may have disabled notifications during the debounce window
					if (!settings.get("mcp.notifications")) return;
					void session.followUp(
						`[MCP notification] Server "${serverName}" reports resource \`${uri}\` was updated. Use read(path="mcp://${uri}") to inspect if relevant.`,
					);
				}, debounceMs),
			);
		});
	}

	return {
		session,
		extensionsResult,
		setToolUIContext,
		mcpManager,
		modelFallbackMessage,
		lspServers,
		eventBus,
	};
}
