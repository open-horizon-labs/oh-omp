import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();

function createProjectLayout(prefix: string): { rootDir: string; projectDir: string; agentDir: string; toolsDir: string } {
	const rootDir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	const projectDir = path.join(rootDir, "project");
	const agentDir = path.join(rootDir, "agent");
	const toolsDir = path.join(projectDir, ".omp", "tools");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(toolsDir, { recursive: true });
	return { rootDir, projectDir, agentDir, toolsDir };
}

async function createIsolatedSession(projectDir: string, agentDir: string) {
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected gpt-4o-mini model");
	return await createAgentSession({
		cwd: projectDir,
		agentDir,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
}

function createToolContext(toolNames: string[]): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		toolNames,
	} as AgentToolContext;
}

const uiContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	theme: undefined as never,
	getAllThemes: async () => [],
	getTheme: async () => undefined,
	setTheme: async () => ({ success: true }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

describe("createAgentSession discoveredCustomToolsResult", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		setAgentDir(originalAgentDir);
		for (const rootDir of tempRoots.splice(0)) {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("returns loaded metadata for project-discovered custom tools", async () => {
		const { rootDir, projectDir, agentDir, toolsDir } = createProjectLayout("pi-sdk-custom-tool");
		tempRoots.push(rootDir);
		setAgentDir(agentDir);

		const toolPath = path.join(toolsDir, "project-echo.ts");
		fs.writeFileSync(
			toolPath,
			[
				"export default function (pi) {",
				"\tconst { Type } = pi.typebox;",
				"\treturn {",
				"\t\tname: \"project_echo\",",
				"\t\tlabel: \"Project Echo\",",
				"\t\tdescription: \"Echoes the provided text.\",",
				"\t\tparameters: Type.Object({ text: Type.String() }),",
				"\t\tasync execute(_toolCallId, params) {",
				"\t\t\treturn { content: [{ type: \"text\", text: params.text }] };",
				"\t\t},",
				"\t};",
				"}",
			].join("\n"),
		);

		const result = await createIsolatedSession(projectDir, agentDir);
		try {
			expect(result.discoveredCustomToolsResult).toBeDefined();
			expect(result.discoveredCustomToolsResult?.errors).toEqual([]);
			expect(result.discoveredCustomToolsResult?.tools).toHaveLength(1);
			expect(result.discoveredCustomToolsResult?.tools[0]?.tool.name).toBe("project_echo");
			expect(result.discoveredCustomToolsResult?.tools[0]?.resolvedPath).toBe(toolPath);
			expect(result.session.getAllToolNames()).toContain("project_echo");
		} finally {
			await result.session.dispose();
		}
	});

	it("propagates session UI context updates to discovered custom tools", async () => {
		const { rootDir, projectDir, agentDir, toolsDir } = createProjectLayout("pi-sdk-custom-tool-ui");
		tempRoots.push(rootDir);
		setAgentDir(agentDir);

		const toolPath = path.join(toolsDir, "project-ui-state.ts");
		fs.writeFileSync(
			toolPath,
			[
				"export default function (pi) {",
				"\tconst { Type } = pi.typebox;",
				"\treturn {",
				"\t\tname: \"project_ui_state\",",
				"\t\tlabel: \"Project UI State\",",
				"\t\tdescription: \"Reports the current UI availability.\",",
				"\t\tparameters: Type.Object({}),",
				"\t\tasync execute() {",
				"\t\t\treturn { content: [{ type: \"text\", text: `hasUI:${String(pi.hasUI)}` }] };",
				"\t\t},",
				"\t};",
				"}",
			].join("\n"),
		);

		const result = await createIsolatedSession(projectDir, agentDir);
		try {
			const discoveredTool = result.discoveredCustomToolsResult?.tools[0]?.tool;
			expect(discoveredTool?.name).toBe("project_ui_state");
			result.setToolUIContext(uiContext, true);
			const executionResult = await discoveredTool?.execute(
				"tool-1",
				{},
				undefined,
				createToolContext(["project_ui_state"]),
			);
			expect(executionResult?.content).toEqual([{ type: "text", text: "hasUI:true" }]);
			expect(result.discoveredCustomToolsResult?.tools[0]?.resolvedPath).toBe(toolPath);
		} finally {
			await result.session.dispose();
		}
	});

	it("surfaces loader errors for invalid discovered custom tools", async () => {
		const { rootDir, projectDir, agentDir, toolsDir } = createProjectLayout("pi-sdk-custom-tool-error");
		tempRoots.push(rootDir);
		setAgentDir(agentDir);

		const brokenToolPath = path.join(toolsDir, "broken-tool.ts");
		fs.writeFileSync(brokenToolPath, "export default 123;\n");

		const result = await createIsolatedSession(projectDir, agentDir);
		try {
			expect(result.discoveredCustomToolsResult).toBeDefined();
			expect(result.discoveredCustomToolsResult?.tools).toEqual([]);
			expect(result.discoveredCustomToolsResult?.errors).toHaveLength(1);
			expect(result.discoveredCustomToolsResult?.errors[0]?.path).toBe(brokenToolPath);
			expect(result.discoveredCustomToolsResult?.errors[0]?.error).toContain("Tool must export a default function");
			expect(result.session.getAllToolNames()).not.toContain("broken_tool");
		} finally {
			await result.session.dispose();
		}
	});
});
