import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import contextRecoveryPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/context-recovery.md" with { type: "text" };
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "context-recovery-test",
	id: "context-recovery-test",
	name: "Context Recovery Test",
	baseUrl: "https://example.invalid",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 100,
	contextWindow: 16_000,
	reasoning: false,
};

const ASSEMBLED_CONTEXT_WINDOW = 4_000;

function makeUser(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function makeSummaryResponse(text: string, responseModel: Model = model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: responseModel.api,
		provider: responseModel.provider,
		model: responseModel.id,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeSummaryError(responseModel: Model): AssistantMessage {
	return {
		...makeSummaryResponse("", responseModel),
		stopReason: "error",
		errorMessage: "temporary summary model failure",
	};
}

function makeToolTurn(index: number): [AssistantMessage, ToolResultMessage] {
	const toolCallId = `tc-sdk-recovery-${index}`;
	return [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "x".repeat(2_000) },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `file-${index}.ts` } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: `result-${index}` }],
			isError: false,
			timestamp: Date.now(),
		},
	];
}

function makeOversizedToolTurn(index: number): [AssistantMessage, ToolResultMessage] {
	const toolCallId = `tc-sdk-oversized-${index}`;
	return [
		{
			...makeToolTurn(index)[0],
			content: [
				{ type: "text", text: "Inspecting an oversized tool response." },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `giant-${index}.ts` } },
			],
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [
				{
					type: "text",
					text: Array.from({ length: 2_000 }, (_, line) => `giant-line-${line} ${"x".repeat(80)}`).join("\n"),
				},
			],
			isError: false,
			timestamp: Date.now(),
		},
	];
}

describe("SDK context recovery request path", () => {
	const tempDirs: string[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		for (const tempDir of tempDirs.splice(0)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("accounts and serializes the recovery nudge only after fallback activates", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-omp-context-recovery-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({
				"contextManager.mode": "assembler",
				"assembler.hotWindowTurns": 2,
				"assembler.safetyMarginPercent": 0,
				"assembler.turnBufferPercent": 0,
				"assembler.messageBudgetPercent": 100,
				"assembler.hydrationBudgetPercent": 0,
				"assembler.contextWindowCap": ASSEMBLED_CONTEXT_WINDOW,
				"providers.embeddings": "disabled",
			}),
			model,
			systemPrompt: "s",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});

		try {
			const messages: AgentMessage[] = [makeUser("reground and continue the original task")];
			for (let index = 0; index < 8; index++) messages.push(...makeToolTurn(index));

			const recovered = await session.convertMessagesToLlm(messages);
			const snapshot = session.getLastPromptSnapshot();
			expect(snapshot?.messages.transformMetadata?.recovery).toMatchObject({
				outcome: "recovered",
				controlPrompt: "standard",
			});
			expect(
				snapshot?.messages.final.some(
					message => message.role === "developer" && message.content === contextRecoveryPrompt,
				),
			).toBe(true);
			expect(snapshot?.messages.tokenEstimate).toBeLessThanOrEqual(snapshot?.budget?.allocatableTokens ?? 0);
			expect(recovered.filter(message => message.content === contextRecoveryPrompt)).toHaveLength(1);

			const providerMessages = convertAnthropicMessages(recovered, model, false);
			const serializedNudge = providerMessages.find(message =>
				JSON.stringify(message.content).includes(contextRecoveryPrompt.trim()),
			);
			expect(serializedNudge?.role).toBe("user");

			const repeated = await session.convertMessagesToLlm(messages);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.overflowSummary).toMatchObject({
				outcome: "failed",
				failureReason: "retry-deferred-no-progress",
			});
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.recovery?.controlPrompt).toBe("omitted");
			expect(repeated.some(message => message.content === contextRecoveryPrompt)).toBe(false);

			const withProgress = [...messages, ...makeToolTurn(8), ...makeToolTurn(9)];
			await session.convertMessagesToLlm(withProgress);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.overflowSummary).toMatchObject({
				outcome: "failed",
				failureReason: "no-authenticated-model",
			});
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.recovery?.controlPrompt).toBe("omitted");

			const ordinary = await session.convertMessagesToLlm([makeUser("short request")]);
			expect(ordinary.some(message => message.content === contextRecoveryPrompt)).toBe(false);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.recovery).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("summarizes assistant history once, reuses it through headroom, and refreshes it at high water", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-omp-context-overflow-summary-"));
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"contextManager.mode": "assembler",
			"assembler.hotWindowTurns": 2,
			"assembler.safetyMarginPercent": 0,
			"assembler.turnBufferPercent": 0,
			"assembler.messageBudgetPercent": 100,
			"assembler.hydrationBudgetPercent": 0,
			"assembler.contextWindowCap": ASSEMBLED_CONTEXT_WINDOW,
			"providers.embeddings": "disabled",
		});
		expect(settings.get("assembler.overflowSummaryModel")).toBe("pi/slow");

		const complete = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(makeSummaryResponse("Initial overflow state: edits are pending verification."))
			.mockResolvedValueOnce(makeSummaryResponse("Updated overflow state: verification is still pending."));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: SessionManager.inMemory(tempDir),
			settings,
			model,
			systemPrompt: "s",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});

		try {
			const messages: AgentMessage[] = [makeUser("finish the implementation and verify it")];
			for (let index = 0; index < 8; index++) messages.push(...makeToolTurn(index));

			const generated = await session.convertMessagesToLlm(messages);
			const generatedSnapshot = session.getLastPromptSnapshot();
			expect(generatedSnapshot?.messages.transformMetadata?.overflowSummary).toMatchObject({
				outcome: "generated",
				generation: 1,
				model: `${model.provider}/${model.id}`,
			});
			expect(generatedSnapshot?.messages.transformMetadata?.recovery).toBeUndefined();
			expect(generatedSnapshot?.messages.final[0]?.role).toBe("user");
			expect(generatedSnapshot?.messages.final[1]).toMatchObject({ role: "developer", attribution: "agent" });
			expect(generatedSnapshot?.messages.final[2]?.role).toBe("assistant");
			expect(complete).toHaveBeenCalledTimes(1);
			expect(complete.mock.calls[0]?.[0]).toBe(model);

			const providerMessages = convertAnthropicMessages(generated, model, false);
			expect(providerMessages[0]?.role).toBe("user");
			expect(JSON.stringify(providerMessages)).toContain("Initial overflow state");
			expect(JSON.stringify(providerMessages)).toContain("tc-sdk-recovery-6");
			expect(JSON.stringify(providerMessages)).toContain("tc-sdk-recovery-7");
			expect(generatedSnapshot?.messages.transformMetadata?.overflowSummary?.tailTurnCount).toBe(2);

			const withOneMoreTurn = [...messages, ...makeToolTurn(8)];
			await session.convertMessagesToLlm(withOneMoreTurn);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.overflowSummary?.outcome).toBe("reused");
			expect(complete).toHaveBeenCalledTimes(1);

			const atNextHighWater = [...withOneMoreTurn];
			for (let index = 9; index < 17; index++) atNextHighWater.push(...makeToolTurn(index));
			await session.convertMessagesToLlm(atNextHighWater);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.overflowSummary).toMatchObject({
				outcome: "generated",
				generation: 2,
			});
			expect(complete).toHaveBeenCalledTimes(2);
			expect(JSON.stringify(complete.mock.calls[1]?.[1])).toContain("Initial overflow state");
		} finally {
			await session.dispose();
		}
	});

	test("codec-compresses an oversized hot tool result without shrinking the configured hot window", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-omp-context-oversized-hot-window-"));
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const complete = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(makeSummaryResponse("Oversized output was inspected; implementation remains in progress."));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({
				"contextManager.mode": "assembler",
				"assembler.hotWindowTurns": 2,
				"assembler.safetyMarginPercent": 0,
				"assembler.turnBufferPercent": 0,
				"assembler.messageBudgetPercent": 100,
				"assembler.hydrationBudgetPercent": 0,
				"assembler.contextWindowCap": ASSEMBLED_CONTEXT_WINDOW,
				"providers.embeddings": "disabled",
			}),
			model,
			systemPrompt: "s",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});

		try {
			const messages: AgentMessage[] = [makeUser("continue after inspecting the large response")];
			for (let index = 0; index < 6; index++) messages.push(...makeToolTurn(index));
			messages.push(...makeOversizedToolTurn(6));

			const assembled = await session.convertMessagesToLlm(messages);
			const snapshot = session.getLastPromptSnapshot();
			expect(snapshot?.messages.transformMetadata?.overflowSummary).toMatchObject({
				outcome: "generated",
				tailTurnCount: 2,
				hotWindowCompressedCount: 1,
			});
			expect(snapshot?.messages.transformMetadata?.decisions).toContainEqual(
				expect.objectContaining({ action: "compressed", reason: "hot-window-oversize-compressed" }),
			);
			const serialized = JSON.stringify(assembled);
			expect(serialized).toContain("tc-sdk-recovery-5");
			expect(serialized).toContain("tc-sdk-oversized-6");
			expect(serialized).toContain("warm:read:giant-6.ts");
			expect(serialized).not.toContain("giant-line-1999");
			expect(complete).toHaveBeenCalledTimes(1);
			expect(() => convertAnthropicMessages(assembled, model, false)).not.toThrow();
		} finally {
			await session.dispose();
		}
	});

	test("uses the configured strong summary model and retries once with the active model", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-omp-context-summary-routing-"));
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		const activeRoutingModel = ai.getBundledModel("openai", "gpt-4o");
		if (!activeRoutingModel) throw new Error("Expected bundled active retry model");
		authStorage.setRuntimeApiKey(activeRoutingModel.provider, "test-key");
		const configuredSummaryModel = ai.getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!configuredSummaryModel) throw new Error("Expected bundled strong summary model");
		authStorage.setRuntimeApiKey(configuredSummaryModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh("offline");
		const settings = Settings.isolated({
			"contextManager.mode": "assembler",
			"assembler.hotWindowTurns": 2,
			"assembler.safetyMarginPercent": 0,
			"assembler.turnBufferPercent": 0,
			"assembler.messageBudgetPercent": 100,
			"assembler.hydrationBudgetPercent": 0,
			"assembler.contextWindowCap": ASSEMBLED_CONTEXT_WINDOW,
			"providers.embeddings": "disabled",
		});
		settings.setModelRole("slow", `${configuredSummaryModel.provider}/${configuredSummaryModel.id}`);
		const complete = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(makeSummaryError(configuredSummaryModel))
			.mockResolvedValueOnce(makeSummaryResponse("Active model retry produced the checkpoint.", activeRoutingModel));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(tempDir),
			settings,
			model: activeRoutingModel,
			systemPrompt: "s",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});

		try {
			const messages: AgentMessage[] = [makeUser("finish the implementation")];
			for (let index = 0; index < 8; index++) messages.push(...makeToolTurn(index));

			await session.convertMessagesToLlm(messages);
			expect(complete.mock.calls.map(call => `${call[0].provider}/${call[0].id}`)).toEqual([
				`${configuredSummaryModel.provider}/${configuredSummaryModel.id}`,
				`${activeRoutingModel.provider}/${activeRoutingModel.id}`,
			]);
			expect(complete).toHaveBeenCalledTimes(2);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.overflowSummary).toMatchObject({
				outcome: "generated",
				attempts: 2,
				model: `${activeRoutingModel.provider}/${activeRoutingModel.id}`,
			});
		} finally {
			await session.dispose();
		}
	});
});
