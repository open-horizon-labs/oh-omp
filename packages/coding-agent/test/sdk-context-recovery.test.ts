import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import contextRecoveryPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/context-recovery.md" with { type: "text" };
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "context-recovery-test",
	name: "Context Recovery Test",
	baseUrl: "https://example.invalid",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 100,
	contextWindow: 4_000,
	reasoning: false,
};

function makeUser(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() };
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

describe("SDK context recovery request path", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
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
				"assembler.contextWindowCap": model.contextWindow,
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

			const ordinary = await session.convertMessagesToLlm([makeUser("short request")]);
			expect(ordinary.some(message => message.content === contextRecoveryPrompt)).toBe(false);
			expect(session.getLastPromptSnapshot()?.messages.transformMetadata?.recovery).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
});
