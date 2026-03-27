#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = path.join(
	process.env.HOME ?? "",
	".oh-omp/agent/sessions/-playground-ai-omnibus-oh-oh-my-pi",
);

const files = fs
	.readdirSync(SESSIONS_DIR)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => ({
		name: f,
		size: fs.statSync(path.join(SESSIONS_DIR, f)).size,
	}))
	.sort((a, b) => b.size - a.size);

const target = path.join(SESSIONS_DIR, files[0].name);
const content = fs.readFileSync(target, "utf-8");
const lines = content.split("\n").filter(Boolean);

let toolCallCount = 0;
let toolResultCount = 0;

for (const line of lines) {
	const e = JSON.parse(line) as Record<string, unknown>;
	if (e.type !== "message") continue;
	const msg = e.message as Record<string, unknown>;
	if (!msg) continue;

	if (msg.role === "assistant") {
		const contentArr = msg.content as Array<Record<string, unknown>>;
		if (!Array.isArray(contentArr)) continue;
		for (const c of contentArr) {
			if (c.type === "toolCall" && toolCallCount < 3) {
				toolCallCount++;
				console.log(`\n=== TOOL CALL #${toolCallCount} ===`);
				console.log("Keys:", Object.keys(c).join(", "));
				console.log("toolName:", c.toolName);
				console.log("toolCallId:", c.toolCallId);
				console.log("id:", c.id);
				const args = c.arguments;
				if (typeof args === "string") {
					console.log("args (string):", args.slice(0, 200));
				} else if (args && typeof args === "object") {
					console.log("args (object) keys:", Object.keys(args as Record<string, unknown>).join(", "));
					const a = args as Record<string, unknown>;
					if (a.path) console.log("args.path:", a.path);
					if (a._i) console.log("args._i:", a._i);
				}
			}
		}
	}

	if (msg.role === "toolResult" && toolResultCount < 3) {
		toolResultCount++;
		console.log(`\n=== TOOL RESULT #${toolResultCount} ===`);
		console.log("Top keys:", Object.keys(msg).join(", "));
		console.log("toolName:", msg.toolName);
		console.log("toolCallId:", msg.toolCallId);
		console.log("id:", msg.id);
		console.log("isError:", msg.isError);
	}

	if (toolCallCount >= 3 && toolResultCount >= 3) break;
}
