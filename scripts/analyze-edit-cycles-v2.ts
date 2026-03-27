#!/usr/bin/env bun
/**
 * Analyze read-edit cycles v2.
 * - Extracts file paths from tool CALL arguments (assistant messages)
 * - Pairs tool calls with their results by toolCallId
 * - Detects edit failures
 * - Filters out carnage sessions (polluted by edit loop bugs)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = path.join(
	process.env.HOME ?? "",
	".oh-omp/agent/sessions",
);

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: Record<string, unknown>) => c.type === "text")
			.map((c: Record<string, unknown>) => c.text as string)
			.join("\n");
	}
	return "";
}

interface ToolCall {
	id: string;
	toolName: string;
	filePath: string;
	args: Record<string, unknown>;
}

interface ToolResultInfo {
	toolCallId: string;
	toolName: string;
	tokens: number;
	isError: boolean;
	text: string;
}

interface FileEvent {
	action: "read" | "edit" | "write";
	tokens: number;
	isError: boolean;
	seqIndex: number;
}

function extractPathFromArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	if (toolName === "read" || toolName === "edit" || toolName === "write") {
		return (a.path as string) || "";
	}
	return "";
}

function normalizePath(p: string): string {
	return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

async function analyzeSession(filePath: string) {
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter(Boolean);

	// Phase 1: Extract tool calls and their IDs from assistant messages
	const toolCalls: Map<string, ToolCall> = new Map(); // toolCallId -> ToolCall
	// Phase 2: Extract tool results and pair with calls
	const toolResults: ToolResultInfo[] = [];

	for (const line of lines) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type !== "message") continue;
		const msg = event.message as Record<string, unknown>;
		if (!msg) continue;

		if (msg.role === "assistant") {
			const contentArr = msg.content as Array<Record<string, unknown>>;
			if (!Array.isArray(contentArr)) continue;
			for (const c of contentArr) {
				if (c.type === "toolCall") {
					const toolName = (c.toolName as string) || "";
					const id = (c.toolCallId as string) || (c.id as string) || "";
					const args = c.arguments as Record<string, unknown> || {};
					const fp = extractPathFromArgs(toolName, args);
					if (id && fp) {
						toolCalls.set(id, { id, toolName, filePath: normalizePath(fp), args });
					}
				}
			}
		}

		if (msg.role === "toolResult") {
			const toolCallId = (msg.toolCallId as string) || (msg.id as string) || "";
			const toolName = (msg.toolName as string) || "";
			const text = extractText(msg.content);
			const tokens = estimateTokens(text);
			const isError = (msg.isError as boolean) || false;
			toolResults.push({ toolCallId, toolName, tokens, isError, text });
		}
	}

	// Phase 3: Build ordered file event sequences
	const fileEvents: Map<string, FileEvent[]> = new Map();
	let seqIndex = 0;

	for (const result of toolResults) {
		const call = toolCalls.get(result.toolCallId);
		if (!call) continue;
		if (!["read", "edit", "write"].includes(call.toolName)) continue;

		const fp = call.filePath;
		if (!fp) continue;

		if (!fileEvents.has(fp)) {
			fileEvents.set(fp, []);
		}
		fileEvents.get(fp)!.push({
			action: call.toolName as "read" | "edit" | "write",
			tokens: result.tokens,
			isError: result.isError,
			seqIndex: seqIndex++,
		});
	}

	// Phase 4: Analyze patterns
	let readsAfterEdit = 0;
	let readsAfterFailedEdit = 0;
	let readsBeforeEdit = 0;
	let standaloneReads = 0;
	let rereadTokens = 0;
	let rereadAfterFailTokens = 0;
	let totalReadTokens = 0;
	let totalEditAttempts = 0;
	let failedEdits = 0;

	const heavyFiles: Array<{
		file: string;
		reads: number;
		edits: number;
		failedEdits: number;
		writes: number;
		readTokens: number;
		sequence: string;
	}> = [];

	for (const [file, evts] of fileEvents.entries()) {
		const fileReadTokens = evts
			.filter((e) => e.action === "read")
			.reduce((s, e) => s + e.tokens, 0);
		totalReadTokens += fileReadTokens;

		totalEditAttempts += evts.filter((e) => e.action === "edit").length;
		const fileFailedEdits = evts.filter(
			(e) => e.action === "edit" && e.isError,
		).length;
		failedEdits += fileFailedEdits;

		for (let i = 0; i < evts.length; i++) {
			const evt = evts[i];
			const prev = i > 0 ? evts[i - 1] : null;
			const next = i < evts.length - 1 ? evts[i + 1] : null;

			if (evt.action === "read") {
				if (prev && (prev.action === "edit" || prev.action === "write")) {
					readsAfterEdit++;
					rereadTokens += evt.tokens;
					if (prev.isError) {
						readsAfterFailedEdit++;
						rereadAfterFailTokens += evt.tokens;
					}
				} else if (
					next &&
					(next.action === "edit" || next.action === "write")
				) {
					readsBeforeEdit++;
				} else {
					standaloneReads++;
				}
			}
		}

		if (evts.length >= 3) {
			heavyFiles.push({
				file: file.split("/").slice(-3).join("/"),
				reads: evts.filter((e) => e.action === "read").length,
				edits: evts.filter((e) => e.action === "edit").length,
				failedEdits: fileFailedEdits,
				writes: evts.filter((e) => e.action === "write").length,
				readTokens: fileReadTokens,
				sequence: evts
					.map((e) => {
						const letter = e.action[0].toUpperCase();
						return e.isError ? letter.toLowerCase() : letter;
					})
					.join(""),
			});
		}
	}

	return {
		totalFiles: fileEvents.size,
		readsAfterEdit,
		readsAfterFailedEdit,
		readsBeforeEdit,
		standaloneReads,
		rereadTokens,
		rereadAfterFailTokens,
		totalReadTokens,
		totalEditAttempts,
		failedEdits,
		heavyFiles: heavyFiles.sort((a, b) => b.readTokens - a.readTokens),
	};
}

async function main() {
	const entries = fs.readdirSync(SESSIONS_DIR);
	const projectDirs = entries.filter((e) => {
		if (!e.startsWith("-")) return false;
		if (e.includes("--T-pi-")) return false;
		// Filter out carnage sessions
		if (e.toLowerCase().includes("carnage")) return false;
		return fs.statSync(path.join(SESSIONS_DIR, e)).isDirectory();
	});

	console.log(`Scanning ${projectDirs.length} project dirs (carnage excluded)`);

	let totals = {
		sessions: 0,
		readsAfterEdit: 0,
		readsAfterFailedEdit: 0,
		readsBeforeEdit: 0,
		standaloneReads: 0,
		rereadTokens: 0,
		rereadAfterFailTokens: 0,
		totalReadTokens: 0,
		totalEditAttempts: 0,
		failedEdits: 0,
	};

	let allHeavyFiles: Array<{
		file: string;
		reads: number;
		edits: number;
		failedEdits: number;
		writes: number;
		readTokens: number;
		sequence: string;
		session: string;
		project: string;
	}> = [];

	for (const dir of projectDirs) {
		const dirPath = path.join(SESSIONS_DIR, dir);
		const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

		for (const file of files) {
			const fp = path.join(dirPath, file);
			const stat = fs.statSync(fp);
			if (stat.size < 1000) continue;

			try {
				const result = await analyzeSession(fp);
				totals.sessions++;
				totals.readsAfterEdit += result.readsAfterEdit;
				totals.readsAfterFailedEdit += result.readsAfterFailedEdit;
				totals.readsBeforeEdit += result.readsBeforeEdit;
				totals.standaloneReads += result.standaloneReads;
				totals.rereadTokens += result.rereadTokens;
				totals.rereadAfterFailTokens += result.rereadAfterFailTokens;
				totals.totalReadTokens += result.totalReadTokens;
				totals.totalEditAttempts += result.totalEditAttempts;
				totals.failedEdits += result.failedEdits;

				for (const hf of result.heavyFiles.slice(0, 3)) {
					allHeavyFiles.push({
						...hf,
						session: file.slice(0, 20),
						project: dir.slice(0, 40),
					});
				}
			} catch {
				continue;
			}
		}
	}

	const totalReads =
		totals.readsAfterEdit + totals.readsBeforeEdit + totals.standaloneReads;

	console.log(`\n=== READ-EDIT CYCLE ANALYSIS (${totals.sessions} sessions, carnage excluded) ===`);

	console.log(`\nEdit attempts: ${totals.totalEditAttempts}`);
	console.log(
		`  Failed: ${totals.failedEdits} (${totals.totalEditAttempts > 0 ? ((totals.failedEdits / totals.totalEditAttempts) * 100).toFixed(1) : 0}%)`,
	);
	console.log(
		`  Succeeded: ${totals.totalEditAttempts - totals.failedEdits}`,
	);

	console.log(`\nRead classification (${totalReads} total reads):`);
	if (totalReads > 0) {
		console.log(
			`  Re-reads AFTER edit/write:            ${totals.readsAfterEdit} (${((totals.readsAfterEdit / totalReads) * 100).toFixed(1)}%) [${Math.round(totals.rereadTokens / 1000)}K tokens]`,
		);
		console.log(
			`    ...of which after FAILED edit:      ${totals.readsAfterFailedEdit} (${((totals.readsAfterFailedEdit / totalReads) * 100).toFixed(1)}%) [${Math.round(totals.rereadAfterFailTokens / 1000)}K tokens]`,
		);
		console.log(
			`  Initial reads BEFORE edit/write:      ${totals.readsBeforeEdit} (${((totals.readsBeforeEdit / totalReads) * 100).toFixed(1)}%)`,
		);
		console.log(
			`  Standalone reads (no adjacent edit):  ${totals.standaloneReads} (${((totals.standaloneReads / totalReads) * 100).toFixed(1)}%)`,
		);
	}

	console.log(`\n=== TOKEN IMPACT ===`);
	console.log(
		`  Total read tokens: ${Math.round(totals.totalReadTokens / 1000)}K`,
	);
	console.log(
		`  Re-read tax (after edits): ${Math.round(totals.rereadTokens / 1000)}K (${totals.totalReadTokens > 0 ? ((totals.rereadTokens / totals.totalReadTokens) * 100).toFixed(1) : 0}% of reads)`,
	);
	console.log(
		`  Failed-edit re-read tax: ${Math.round(totals.rereadAfterFailTokens / 1000)}K (${totals.totalReadTokens > 0 ? ((totals.rereadAfterFailTokens / totals.totalReadTokens) * 100).toFixed(1) : 0}% of reads)`,
	);

	console.log(`\n=== TOP EDIT-HEAVY FILES ===`);
	console.log(`  (R=read, E=edit, W=write; lowercase=error)`);
	const topHeavy = allHeavyFiles
		.sort((a, b) => b.readTokens - a.readTokens)
		.slice(0, 25);
	for (const hf of topHeavy) {
		const seq =
			hf.sequence.length > 60
				? `${hf.sequence.slice(0, 60)}...`
				: hf.sequence;
		console.log(
			`  ${hf.file.padEnd(52)} ${String(hf.reads).padStart(3)}R ${String(hf.edits).padStart(3)}E(${hf.failedEdits}f) ${String(hf.writes).padStart(2)}W | ${String(hf.readTokens).padStart(6)} tok | ${seq}`,
		);
	}

	console.log(`\n=== HYPOTHETICAL SAVINGS ===`);
	console.log(`  If edits never failed: save ${Math.round(totals.rereadAfterFailTokens / 1000)}K tokens`);
	console.log(`  If anchors survived edits (no re-reads needed): save ${Math.round(totals.rereadTokens / 1000)}K tokens`);
	console.log(`  Combined (stable editing): save ${Math.round((totals.rereadTokens) / 1000)}K tokens`);
}

main().catch(console.error);
