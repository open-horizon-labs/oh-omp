/**
 * Collects the guidance library — active tool docs, active edit-mode docs,
 * and additional operating guidance that the compiler uses as reference
 * material when composing the system prompt.
 *
 * Prompts are embedded at build time via Bun text imports. Do not read them
 * from the filesystem at runtime; packaged/runtime paths are not stable.
 */

import selfImprovementImperative from "../system/self-improvement.md" with { type: "text" };
import askDescription from "../tools/ask.md" with { type: "text" };
import astEditDescription from "../tools/ast-edit.md" with { type: "text" };
import astGrepDescription from "../tools/ast-grep.md" with { type: "text" };
import awaitDescription from "../tools/await.md" with { type: "text" };
import bashDescription from "../tools/bash.md" with { type: "text" };
import browserDescription from "../tools/browser.md" with { type: "text" };
import calculatorDescription from "../tools/calculator.md" with { type: "text" };
import cancelJobDescription from "../tools/cancel-job.md" with { type: "text" };
import checkpointDescription from "../tools/checkpoint.md" with { type: "text" };
import exitPlanModeDescription from "../tools/exit-plan-mode.md" with { type: "text" };
import fetchDescription from "../tools/fetch.md" with { type: "text" };
import findDescription from "../tools/find.md" with { type: "text" };
import geminiImageDescription from "../tools/gemini-image.md" with { type: "text" };
import grepDescription from "../tools/grep.md" with { type: "text" };
import hashlineDescription from "../tools/hashline.md" with { type: "text" };
import inspectImageDescription from "../tools/inspect-image.md" with { type: "text" };
import lspDescription from "../tools/lsp.md" with { type: "text" };
import patchDescription from "../tools/patch.md" with { type: "text" };
import pythonDescription from "../tools/python.md" with { type: "text" };
import readDescription from "../tools/read.md" with { type: "text" };
import recallDescription from "../tools/recall.md" with { type: "text" };
import renderMermaidDescription from "../tools/render-mermaid.md" with { type: "text" };
import replaceDescription from "../tools/replace.md" with { type: "text" };
import resolveDescription from "../tools/resolve.md" with { type: "text" };
import rewindDescription from "../tools/rewind.md" with { type: "text" };
import searchToolBm25Description from "../tools/search-tool-bm25.md" with { type: "text" };
import sshDescription from "../tools/ssh.md" with { type: "text" };
import taskDescription from "../tools/task.md" with { type: "text" };
import todoDescription from "../tools/todo.md" with { type: "text" };
import todoWriteDescription from "../tools/todo-write.md" with { type: "text" };
import todosDescription from "../tools/todos.md" with { type: "text" };
import webSearchDescription from "../tools/web-search.md" with { type: "text" };
import writeDescription from "../tools/write.md" with { type: "text" };
import runtimeSurfacesGuidance from "./runtime-surfaces.md" with { type: "text" };

export interface GuidanceLibrary {
	/** Concatenated documentation for tools active in this session. */
	toolDocs: string;
	/** Documentation for the active edit mode only. */
	editModeGuidance: string;
	/** Additional session-wide guidance for the compiler to preserve. */
	additionalGuidance: string;
}

export interface CollectGuidanceLibraryOptions {
	activeToolNames: string[];
	editMode: string;
}

const TOOL_DOCS = new Map<string, string>([
	["ask", askDescription],
	["ast_edit", astEditDescription],
	["ast_grep", astGrepDescription],
	["await", awaitDescription],
	["bash", bashDescription],
	["browser", browserDescription],
	["calc", calculatorDescription],
	["cancel_job", cancelJobDescription],
	["checkpoint", checkpointDescription],
	["exit_plan_mode", exitPlanModeDescription],
	["generate_image", geminiImageDescription],
	["fetch", fetchDescription],
	["find", findDescription],
	["grep", grepDescription],
	["inspect_image", inspectImageDescription],
	["lsp", lspDescription],
	["python", pythonDescription],
	["read", readDescription],
	["recall", recallDescription],
	["render_mermaid", renderMermaidDescription],
	["resolve", resolveDescription],
	["rewind", rewindDescription],
	["search_tool_bm25", searchToolBm25Description],
	["ssh", sshDescription],
	["task", taskDescription],
	["todo", todoDescription],
	["todos", todosDescription],
	["todo_write", todoWriteDescription],
	["web_search", webSearchDescription],
	["write", writeDescription],
]);

const EDIT_MODE_DOCS = new Map<string, string>([
	["hashline", hashlineDescription],
	["patch", patchDescription],
	["replace", replaceDescription],
]);

export function collectGuidanceLibrary(options: CollectGuidanceLibraryOptions): GuidanceLibrary {
	const toolDocs = [...new Set(options.activeToolNames)]
		.flatMap(name => {
			const content = TOOL_DOCS.get(name);
			if (!content) return [];
			return [`### Tool: ${name}\n\n${content.trim()}`];
		})
		.join("\n\n---\n\n");

	const editModeContent = EDIT_MODE_DOCS.get(options.editMode)?.trim() ?? "";

	const includeSelfImprovement = options.activeToolNames.some(
		name =>
			name === "mcp_oh_mcp_oh_create_metis_candidate" ||
			name === "mcp_oh_mcp_oh_create_guardrail_candidate" ||
			name === "mcp_oh_mcp_oh_log_decision",
	);

	return {
		toolDocs,
		editModeGuidance: editModeContent ? `### Edit Mode: ${options.editMode}\n\n${editModeContent}` : "",
		additionalGuidance: [
			runtimeSurfacesGuidance.trim(),
			...(includeSelfImprovement ? [selfImprovementImperative.trim()] : []),
		].join("\n\n"),
	};
}
