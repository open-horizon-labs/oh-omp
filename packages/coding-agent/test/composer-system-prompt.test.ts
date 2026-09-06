import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import * as composerModule from "../src/prompts/composer/compile";
import { buildInventory } from "../src/prompts/composer/inventory";
import { collectGuidanceLibrary } from "../src/prompts/composer/library";
import operatingContract from "../src/prompts/operating-contract.md" with { type: "text" };
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

function createModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic model");
	return model;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("dynamic composer system prompt", () => {
	let tempDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-composer-prompt-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempDir;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("collects only active guidance docs and gates self-improvement on OH MCP availability", () => {
		const guidance = collectGuidanceLibrary({
			activeToolNames: ["read", "search_tool_bm25", "mcp_oh_mcp_oh_create_metis_candidate", "read"],
			editMode: "hashline",
		});
		const guidanceWithoutOh = collectGuidanceLibrary({
			activeToolNames: ["read"],
			editMode: "hashline",
		});

		expect(guidance.toolDocs).toContain("### Tool: read");
		expect(guidance.toolDocs).toContain("### Tool: search_tool_bm25");
		expect(guidance.toolDocs).not.toContain("### Tool: grep");
		expect(guidance.editModeGuidance).toContain("### Edit Mode: hashline");
		expect(guidance.additionalGuidance).toContain("You are the harness's most consistent observer");
		expect(guidanceWithoutOh.additionalGuidance).not.toContain("mcp_oh_mcp_oh_create_metis_candidate");
	});

	it("renders exact tool names in the composer inventory", () => {
		const inventory = buildInventory({
			tools: [{ name: "web_search", label: "Web Search", description: "Search the web" }],
			editMode: "hashline",
			skills: [],
			environment: [{ label: "OS", value: "darwin arm64" }],
			cwd: "/tmp/project",
		});

		expect(inventory).toContain("**Web Search** (`web_search`) — Search the web");
	});

	it("compiles from session-scoped guidance and extracts the wrapped prompt", async () => {
		const completeSimpleMock = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				createAssistantMessage(
					`<compiled-system-prompt>\nCompiled prompt\n\n${operatingContract.trim()}\n\nDone\n</compiled-system-prompt>`,
				),
			);

		const result = await composerModule.compileSystemPrompt({
			model: createModel(),
			apiKey: "test-key",
			inventory: {
				tools: [
					{ name: "read", label: "Read", description: "Reads files" },
					{ name: "search_tool_bm25", label: "SearchToolBm25", description: "Discovers MCP tools" },
				],
				editMode: "hashline",
				skills: [],
				environment: [{ label: "OS", value: "darwin arm64" }],
				cwd: tempDir,
			},
			contextFiles: "## AGENTS.md\nFollow the local rules.",
			invariants: operatingContract,
			tokenBudget: 2048,
			noCache: true,
		});

		const request = completeSimpleMock.mock.calls[0]?.[1] as
			| { systemPrompt: string; messages: Array<{ content: string }> }
			| undefined;
		const userMessage = request?.messages[0]?.content ?? "";

		expect(userMessage).toContain("### Tool: read");
		expect(userMessage).toContain("### Tool: search_tool_bm25");
		expect(userMessage).not.toContain("### Tool: grep");
		expect(userMessage).toContain("## Guidance Library — Active Edit Mode");
		expect(userMessage).not.toContain("Current System Prompt Template");
		expect(request?.systemPrompt).not.toContain("Current System Prompt Template");
		expect(userMessage.split(operatingContract.trim())).toHaveLength(2);
		expect(result.systemPrompt).toBe(`Compiled prompt\n\n${operatingContract.trim()}\n\nDone`);
	});

	it("rejects compiled output without the required wrapper", () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			createAssistantMessage(`Compiled prompt\n\n${operatingContract.trim()}`),
		);

		return expect(
			composerModule.compileSystemPrompt({
				model: createModel(),
				apiKey: "test-key",
				inventory: {
					tools: [{ name: "read", label: "Read", description: "Reads files" }],
					editMode: "hashline",
					skills: [],
					environment: [{ label: "OS", value: "darwin arm64" }],
					cwd: tempDir,
				},
				contextFiles: "",
				invariants: operatingContract,
				tokenBudget: 2048,
				noCache: true,
			}),
		).rejects.toThrow("composer: compilation response missing <compiled-system-prompt> wrapper");
	});

	it("appends invariants when compiled output omits them", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			createAssistantMessage("<compiled-system-prompt>\nCompiled prompt only\n</compiled-system-prompt>"),
		);

		// The compiler model dropped the invariants. Rather than fail the session,
		// the composer recovers by appending them, so the non-negotiable invariants
		// are always present in the final system prompt.
		const result = await composerModule.compileSystemPrompt({
			model: createModel(),
			apiKey: "test-key",
			inventory: {
				tools: [{ name: "read", label: "Read", description: "Reads files" }],
				editMode: "hashline",
				skills: [],
				environment: [{ label: "OS", value: "darwin arm64" }],
				cwd: tempDir,
			},
			contextFiles: "",
			invariants: operatingContract,
			tokenBudget: 2048,
			noCache: true,
		});

		expect(result.systemPrompt).toBe(`Compiled prompt only\n\n${operatingContract}`);
	});

	it("uses the shared operating contract and still applies prompt overrides", async () => {
		const model = createModel();
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const compileSpy = vi.spyOn(composerModule, "compileSystemPrompt").mockResolvedValue({
			systemPrompt: "COMPILED PROMPT",
			modelId: `${model.provider}/${model.id}`,
			durationMs: 12,
			cacheHit: false,
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({ "composer.enabled": true }),
			model,
			systemPrompt: defaultPrompt => `${defaultPrompt}\n\nOVERRIDE`,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});

		try {
			expect(compileSpy).toHaveBeenCalledTimes(1);
			expect(compileSpy.mock.calls[0]?.[0].invariants.trim()).toBe(operatingContract.trim());
			expect(session.systemPrompt).toContain("COMPILED PROMPT");
			expect(session.systemPrompt).toContain("OVERRIDE");
		} finally {
			await session.dispose();
		}
	});
});
