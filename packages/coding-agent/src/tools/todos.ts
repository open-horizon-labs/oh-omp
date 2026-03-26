import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { TaskQuery, TaskSummary, TasksResult, TaskView } from "../tasks/types";
import { renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export interface TodosReadDetails {
	result: TasksResult;
}

// =============================================================================
// Schema
// =============================================================================

const todosSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Get a specific task by ID" })),
	status: Type.Optional(
		StringEnum(["open", "active", "done", "blocked", "ready", "abandoned"] as const, {
			description: "Filter by status",
		}),
	),
	agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
	label: Type.Optional(Type.String({ description: "Filter by label" })),
	session: Type.Optional(Type.String({ description: "Filter by session ID" })),
});

type TodosParams = Static<typeof todosSchema>;

// =============================================================================
// Helpers
// =============================================================================

const STATUS_ICONS: Record<string, string> = {
	open: "○",
	active: "→",
	done: "✓",
	abandoned: "✗",
	blocked: "⊘",
	ready: "◎",
};

function hasAnyParam(params: TodosParams): boolean {
	return (
		params.id !== undefined ||
		params.status !== undefined ||
		params.agent !== undefined ||
		params.label !== undefined ||
		params.session !== undefined
	);
}

function mergeSummaries(a: TaskSummary, b: TaskSummary): TaskSummary {
	return {
		total: a.total + b.total,
		open: a.open + b.open,
		active: a.active + b.active,
		done: a.done + b.done,
		ready: a.ready + b.ready,
		blocked: a.blocked + b.blocked,
	};
}

function deduplicateTasks(tasks: TaskView[]): TaskView[] {
	const seen = new Set<string>();
	const result: TaskView[] = [];
	for (const task of tasks) {
		if (!seen.has(task.id)) {
			seen.add(task.id);
			result.push(task);
		}
	}
	return result;
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodosReadTool implements AgentTool<typeof todosSchema, TodosReadDetails> {
	readonly name = "todos";
	readonly label = "Todos";
	readonly description: string;
	readonly parameters = todosSchema;
	readonly concurrency = "shared";
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = ""; // RNA experiment: tool descriptions compiled into system prompt, not sent per-turn;
	}

	async execute(
		_toolCallId: string,
		params: TodosParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodosReadDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodosReadDetails>> {
		const store = this.session.taskStore;
		if (!store) {
			return {
				content: [
					{ type: "text", text: "Error: Task store not available yet. Try again after session initialization." },
				],
				details: {
					result: { tasks: [], summary: { total: 0, open: 0, active: 0, done: 0, ready: 0, blocked: 0 } },
				},
			};
		}

		let tasksResult: TasksResult;

		if (hasAnyParam(params)) {
			const query: TaskQuery = {};
			if (params.id !== undefined) query.id = params.id;
			if (params.status !== undefined) query.status = params.status;
			if (params.agent !== undefined) query.agent = params.agent;
			if (params.label !== undefined) query.label = params.label;
			if (params.session !== undefined) query.session = params.session;
			tasksResult = await store.query(query);
		} else {
			// Default: open + active tasks
			const [openResult, activeResult] = await Promise.all([
				store.query({ status: "open" }),
				store.query({ status: "active" }),
			]);
			const tasks = deduplicateTasks([...openResult.tasks, ...activeResult.tasks]);
			const summary = mergeSummaries(openResult.summary, activeResult.summary);
			// Correct total after dedup
			summary.total = tasks.length;
			tasksResult = { tasks, summary };
		}

		const lines: string[] = [];
		for (const task of tasksResult.tasks) {
			const icon = STATUS_ICONS[task.status] ?? "?";
			const deps = task.blocked_by.length > 0 ? ` (blocked by: ${task.blocked_by.join(", ")})` : "";
			lines.push(`${icon} ${task.id}: ${task.content}${deps}`);
		}
		const s = tasksResult.summary;
		const summaryParts: string[] = [];
		if (s.open > 0) summaryParts.push(`${s.open} open`);
		if (s.active > 0) summaryParts.push(`${s.active} active`);
		if (s.done > 0) summaryParts.push(`${s.done} done`);
		if (s.ready > 0) summaryParts.push(`(${s.ready} ready)`);
		if (s.blocked > 0) summaryParts.push(`(${s.blocked} blocked)`);
		const summaryLine = summaryParts.length > 0 ? summaryParts.join(", ") : "No tasks";
		lines.push(summaryLine);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { result: tasksResult },
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface TodosReadRenderArgs {
	id?: string;
	status?: string;
	agent?: string;
	label?: string;
	session?: string;
}

function formatTaskLine(task: TaskView, uiTheme: Theme): string {
	const icon = STATUS_ICONS[task.status] ?? "?";
	const labelSuffix = task.labels.length > 0 ? ` ${chalk.dim(`[${task.labels.join(", ")}]`)}` : "";

	switch (task.status) {
		case "done":
			return uiTheme.fg("success", `  ${icon} ${task.id}: ${chalk.strikethrough(task.content)}${labelSuffix}`);
		case "active":
			return uiTheme.fg("accent", `  ${icon} ${task.id}: ${task.content}${labelSuffix}`);
		case "abandoned":
			return uiTheme.fg("dim", `  ${icon} ${task.id}: ${chalk.strikethrough(task.content)}${labelSuffix}`);
		default:
			return `  ${icon} ${task.id}: ${task.content}${labelSuffix}`;
	}
}

function describeQuery(args: TodosReadRenderArgs): string {
	const parts: string[] = [];
	if (args.id) parts.push(`id: ${args.id}`);
	if (args.status) parts.push(`status: ${args.status}`);
	if (args.agent) parts.push(`agent: ${args.agent}`);
	if (args.label) parts.push(`label: ${args.label}`);
	if (args.session) parts.push(`session: ${args.session}`);
	return parts.length > 0 ? parts.join(", ") : "all active tasks";
}

export const todosReadToolRenderer = {
	renderCall(args: TodosReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const query = describeQuery(args);
		const text = renderStatusLine({ icon: "pending", title: "Todos", meta: [query] }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodosReadDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodosReadRenderArgs,
	): Component {
		const tasks = result.details?.result.tasks ?? [];
		const summary = result.details?.result.summary;
		const taskCount = tasks.length;

		const header = renderStatusLine(
			{ icon: "success", title: "Todos", meta: [`${taskCount} task${taskCount !== 1 ? "s" : ""}`] },
			uiTheme,
		);

		if (taskCount === 0) {
			return new Text(`${header}\n${uiTheme.fg("dim", "  No tasks found")}`, 0, 0);
		}

		const { expanded } = options;
		const limit = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
		const lines: string[] = [header];

		const visible = tasks.slice(0, limit);
		for (const task of visible) {
			lines.push(formatTaskLine(task, uiTheme));
		}

		if (tasks.length > limit) {
			lines.push(uiTheme.fg("dim", `  ... and ${tasks.length - limit} more`));
		}

		if (summary) {
			const parts: string[] = [];
			if (summary.open > 0) parts.push(`${summary.open} open`);
			if (summary.active > 0) parts.push(chalk.yellow(`${summary.active} active`));
			if (summary.done > 0) parts.push(chalk.green(`${summary.done} done`));
			if (summary.ready > 0) parts.push(`${summary.ready} ready`);
			if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
			if (parts.length > 0) {
				lines.push(uiTheme.fg("dim", `  ${parts.join(", ")}`));
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
};

// =============================================================================
// Factory
// =============================================================================

export function createTodosReadTool(session: ToolSession) {
	return new TodosReadTool(session);
}
