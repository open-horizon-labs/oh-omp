#!/usr/bin/env bun
/**
 * Inspect the actual JSONL message format for tool calls and results.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = path.join(
	process.env.HOME ?? "",
	".oh-omp/agent/sessions/-playground-ai-omnibus-oh-oh-my-pi",
);

const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
// Pick a meaty session
const sorted = files
	.map((f) => ({
		name: f,
		size: fs.statSync(path.join(SESSIONS_DIR, f)).size,
	}))
	.sort((a, b) => b.size - a.size);

const target = path.join(SESSIONS_DIR, sorted[0].name);
console.log(`Inspecting: ${sorted[0].name} (${(sorted[0].size / 1024).toFixed(0)}KB)`);

const content = fs.readFileSync(target, "utf-8");
const lines = content.split("\n").filter(Boolean);

let foundToolCall = false;
let foundToolResult = false;
let foundEdit = false;

for (const line of lines) {
	const e = JSON.parse(line) as Record<string, unknown>;
	if (e.type !== "message") continue;
	const msg = e.message as Record<string, unknown>;
	if (!msg) continue;

	if (msg.role === "assistant" && !foundToolCall) {
		const contentArr = msg.content as Array<Record<string, unknown>>;
		if (!Array.isArray(contentArr)) continue;
		for (const c of contentArr) {
			if (c.type === "toolCall" && (c.toolName === "read" || c.toolName === "edit")) {
				console.log(`\n=== ${(c.toolName as string).toUpperCase()} TOOL CALL ===`);
				console.log("Keys:", Object.keys(c));
				// Show args structure
				const args = c.arguments;
				console.log("Arguments type:", typeof args);
				if (typeof args === "string") {
					console.log("Arguments (string, first 300 chars):", args.slice(0, 300));
				} else if (typeof args === "object" && args !== null) {
					console.log("Arguments keys:", Object.keys(args as Record<string, unknown>));
					console.log("Arguments (first 500 chars):", JSON.stringify(args, null, 2).slice(0, 500));
				}
				if (c.toolName === "read") foundToolCall = true;
				if (c.toolName === "edit") foundEdit = true;
				if (foundToolCall && foundEdit) break;
			}
		}
	}

	if (msg.role === "toolResult" && !foundToolResult) {
		const toolName = msg.toolName as string;
		if (toolName === "read" || toolName === "edit") {
			console.log(`\n=== ${toolName.toUpperCase()} TOOL RESULT ===`);
			console.log("Top-level keys:", Object.keys(msg));
			console.log("toolName:", msg.toolName);

			// Check for file path in various locations
			const details = msg.details as Record<string, unknown> | undefined;
			if (details) {
				console.log("Details keys:", Object.keys(details));
				console.log("Details:", JSON.stringify(details, null, 2).slice(0, 500));
			}

			// Check content structure
			const c = msg.content;
			if (typeof c === "string") {
				console.log("Content type: string, length:", c.length);
				console.log("Content first 200 chars:", c.slice(0, 200));
			} else if (Array.isArray(c)) {
				console.log("Content type: array, length:", (c as unknown[]).length);
				const first = (c as Array<Record<string, unknown>>)[0];
				if (first) {
					console.log("First element keys:", Object.keys(first));
					if (first.type === "text") {
						console.log("First text (200 chars):", (first.text as string).slice(0, 200));
					}
				}
			}

			if (toolName === "read") foundToolResult = true;
		}
	}

	if (foundToolCall && foundToolResult && foundEdit) break;
}
