import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { TaskStore } from "../tasks/store";
import type { Task } from "../tasks/types";
import { renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import type { TodoItem, TodoPhase, TodoStatus } from "./todo-write";

// =============================================================================
// Types
// =============================================================================

export interface TodoWriteDetails {
	op: string;
	ids?: string[];
	success: boolean;
	error?: string;
}

// =============================================================================
// Schema
// =============================================================================

const OpEnum = StringEnum(["plan", "claim", "done", "drop", "assign", "edit", "remove"] as const, {
	description: "Operation to perform",
});

const TaskInput = Type.Object({
	content: Type.String({ description: "Task description" }),
	details: Type.Optional(Type.String({ description: "Implementation details" })),
	labels: Type.Optional(Type.Array(Type.String(), { description: "Task labels" })),
	depends_on: Type.Optional(
		Type.Array(Type.String(), { description: 'Task IDs this depends on. Use "^" for previous task in list.' }),
	),
});

const todoSchema = Type.Object({
	op: OpEnum,
	tasks: Type.Optional(Type.Array(TaskInput, { description: "Tasks to create (plan only)" })),
	id: Type.Optional(Type.String({ description: "Task ID (required for all ops except plan)" })),
	notes: Type.Optional(Type.String({ description: "Completion notes (done, edit)" })),
	agent: Type.Optional(Type.String({ description: "Agent name (assign)" })),
	abandon: Type.Optional(Type.Boolean({ description: "If true, abandon instead of releasing (drop)" })),
	content: Type.Optional(Type.String({ description: "Updated content (edit)" })),
	details: Type.Optional(Type.String({ description: "Updated details (edit)" })),
	labels: Type.Optional(Type.Array(Type.String(), { description: "Updated labels (edit)" })),
	depends_on: Type.Optional(Type.Array(Type.String(), { description: "Updated dependencies (edit)" })),
});

type TodoParams = Static<typeof todoSchema>;

// =============================================================================
// Helpers
// =============================================================================

function ok(op: string, text: string, ids?: string[]): AgentToolResult<TodoWriteDetails> {
	return {
		content: [{ type: "text", text }],
		details: { op, ids, success: true },
	};
}

function err(op: string, message: string): AgentToolResult<TodoWriteDetails> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { op, success: false, error: message },
	};
}

// =============================================================================
// Tool
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoWriteDetails> {
	readonly name = "todo";
	readonly label = "Todo";
	readonly description: string;
	readonly parameters = todoSchema;

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = ""; // RNA experiment: tool descriptions compiled into system prompt, not sent per-turn;
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteDetails>> {
		const store = this.#session.taskStore;
		if (!store) return err(params.op, "task store not initialized");

		let result: AgentToolResult<TodoWriteDetails>;
		switch (params.op) {
			case "plan":
				result = await this.#plan(params, store);
				break;
			case "claim":
				result = await this.#claim(params, store);
				break;
			case "done":
				result = await this.#done(params, store);
				break;
			case "drop":
				result = await this.#drop(params, store);
				break;
			case "assign":
				result = await this.#assign(params, store);
				break;
			case "edit":
				result = await this.#edit(params, store);
				break;
			case "remove":
				result = await this.#remove(params, store);
				break;
			default:
				return err(params.op, `unknown operation: ${params.op}`);
		}

		// Sync task state to TUI sidebar after any successful mutation.
		if (result.details?.success) {
			await this.#syncTui(store);
		}

		return result;
	}

	/** Bridge: convert TaskStore state to TodoPhase[] for TUI sidebar. */
	async #syncTui(store: TaskStore): Promise<void> {
		try {
			const { tasks } = await store.query();
			const STATUS_MAP: Record<string, TodoStatus> = {
				open: "pending",
				active: "in_progress",
				done: "completed",
				abandoned: "abandoned",
			};
			const items: TodoItem[] = tasks.map(t => ({
				id: t.id,
				content: t.content,
				status: STATUS_MAP[t.status] ?? "pending",
				notes: t.notes,
				details: t.details,
			}));
			const phase: TodoPhase = { id: "phase-1", name: "Tasks", tasks: items };
			this.#session.setTodoPhases?.([phase]);
		} catch {
			// Non-fatal — TUI sync failure should not break the tool.
		}
	}

	async #plan(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.tasks || params.tasks.length === 0) {
			return err("plan", "no tasks provided");
		}
		const sessionId = this.#session.getSessionId?.() ?? "";
		const ids = await store.create(params.tasks, sessionId);
		return ok("plan", `Created ${ids.length} tasks: ${ids.join(", ")}`, ids);
	}

	async #claim(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.id) return err("claim", "id is required");

		const task = await store.get(params.id);
		if (!task) return err("claim", `task ${params.id} not found`);

		if (task.status === "active") {
			return err("claim", `already claimed by ${task.agent || "unknown"}`);
		}
		if (task.status !== "open" && task.status !== "done") {
			return err("claim", `task is ${task.status}, expected open or done`);
		}

		const sessionId = this.#session.getSessionId?.() ?? "";
		await store.update(params.id, {
			status: "active",
			agent: params.agent || "",
			session: sessionId,
		});
		return ok("claim", `Claimed ${params.id}`, [params.id]);
	}

	async #done(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.id) return err("done", "id is required");

		const task = await store.get(params.id);
		if (!task) return err("done", `task ${params.id} not found`);

		if (task.status !== "active") {
			return err("done", "task is not active");
		}

		const notes = params.notes ?? task.notes;
		await store.update(params.id, { status: "done", notes });
		return ok("done", `Completed ${params.id}`, [params.id]);
	}

	async #drop(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.id) return err("drop", "id is required");

		const task = await store.get(params.id);
		if (!task) return err("drop", `task ${params.id} not found`);

		if (task.status !== "active") {
			return err("drop", "task is not active");
		}

		if (params.abandon) {
			await store.update(params.id, { status: "abandoned" });
			return ok("drop", `Abandoned ${params.id}`, [params.id]);
		}
		await store.update(params.id, { status: "open", agent: "", session: "" });
		return ok("drop", `Released ${params.id}`, [params.id]);
	}

	async #assign(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.id) return err("assign", "id is required");
		if (!params.agent) return err("assign", "agent is required");

		const task = await store.get(params.id);
		if (!task) return err("assign", `task ${params.id} not found`);

		await store.update(params.id, { agent: params.agent });
		return ok("assign", `Assigned ${params.id} to ${params.agent}`, [params.id]);
	}

	async #edit(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.id) return err("edit", "id is required");

		const task = await store.get(params.id);
		if (!task) return err("edit", `task ${params.id} not found`);

		const fields: Partial<Pick<Task, "content" | "details" | "labels" | "depends_on" | "notes">> = {};

		if (params.content !== undefined) fields.content = params.content;
		if (params.details !== undefined) fields.details = params.details;
		if (params.notes !== undefined) fields.notes = params.notes;
		if (params.labels !== undefined) fields.labels = JSON.stringify(params.labels);
		if (params.depends_on !== undefined) fields.depends_on = JSON.stringify(params.depends_on);

		await store.update(params.id, fields);
		return ok("edit", `Updated ${params.id}`, [params.id]);
	}

	async #remove(params: TodoParams, store: TaskStore): Promise<AgentToolResult<TodoWriteDetails>> {
		if (!params.id) return err("remove", "id is required");

		const task = await store.get(params.id);
		if (!task) return err("remove", `task ${params.id} not found`);

		await store.remove(params.id);
		return ok("remove", `Removed ${params.id}`, [params.id]);
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface TodoRenderArgs {
	op?: string;
	id?: string;
	agent?: string;
	abandon?: boolean;
	tasks?: Array<{ content: string }>;
}

export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		let label: string;
		switch (args.op) {
			case "plan":
				label = `Planning ${args.tasks?.length ?? 0} tasks`;
				break;
			case "claim":
				label = `Claiming ${args.id ?? "task"}`;
				break;
			case "done":
				label = `Completing ${args.id ?? "task"}`;
				break;
			case "drop":
				label = args.abandon ? `Abandoning ${args.id ?? "task"}` : `Dropping ${args.id ?? "task"}`;
				break;
			case "assign":
				label = `Assigning ${args.id ?? "task"} to ${args.agent ?? "agent"}`;
				break;
			case "edit":
				label = `Editing ${args.id ?? "task"}`;
				break;
			case "remove":
				label = `Removing ${args.id ?? "task"}`;
				break;
			default:
				label = args.op ?? "update";
		}
		const text = renderStatusLine({ icon: "pending", title: "Todo", meta: [label] }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoRenderArgs,
	): Component {
		const details = result.details;
		if (!details) {
			const fallback = result.content?.find(c => c.type === "text")?.text ?? "Done";
			return new Text(fallback, 0, 0);
		}

		if (!details.success) {
			const header = renderStatusLine({ icon: "error", title: "Todo", meta: [details.op] }, uiTheme);
			return new Text(`${header}\n${chalk.red(details.error ?? "Unknown error")}`, 0, 0);
		}

		const idList = details.ids?.join(", ") ?? "";
		let meta: string;
		switch (details.op) {
			case "plan":
				meta = `Created ${details.ids?.length ?? 0} tasks`;
				break;
			case "remove":
				meta = `Removed ${idList}`;
				break;
			default:
				meta = `${details.op} ${idList}`;
		}

		const header = renderStatusLine({ icon: "success", title: "Todo", meta: [meta] }, uiTheme);
		return new Text(header, 0, 0);
	},

	mergeCallAndResult: true,
};

// =============================================================================
// Factory
// =============================================================================

export function createTodoTool(session: ToolSession) {
	return new TodoTool(session);
}
