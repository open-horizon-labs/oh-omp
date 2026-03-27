#!/usr/bin/env bun
/**
 * Analyze read-edit cycles v3.
 * Correct field names: call.id/call.name, result.toolCallId/result.toolName
 * Filters out carnage sessions.
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

function normalizePath(p: string): string {
	return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

async function analyzeSession(filePath: string) {
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter(Boolean);

	// Phase 1: Index tool calls by ID
	const toolCallPaths: Map<string, { name: string; filePath: string }> = new Map();

	for (const line of lines) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type !== "message") continue;
		const msg = event.message as Record<string, unknown>;
		if (!msg || msg.role !== "assistant") continue;

		const contentArr = msg.content as Array<Record<string, unknown>>;
		if (!Array.isArray(contentArr)) continue;

		for (const c of contentArr) {
			if (c.type !== "toolCall") continue;
			const name = (c.name as string) || "";
			const id = (c.id as string) || "";
			if (!id) continue;

			// Extract path from arguments
			const args = c.arguments as Record<string, unknown> | undefined;
			if (!args) continue;
			const fp = (args.path as string) || "";

			if (fp && ["read", "edit", "write"].includes(name)) {
				toolCallPaths.set(id, { name, filePath: normalizePath(fp) });
			}
		}
	}

	// Phase 2: Walk tool results in order, pair with calls
	const fileEvents: Map<string, Array<{
		action: "read" | "edit" | "write";
		tokens: number;
		isError: boolean;
	}>> = new Map();

	for (const line of lines) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type !== "message") continue;
		const msg = event.message as Record<string, unknown>;
		if (!msg || msg.role !== "toolResult") continue;

		const toolCallId = (msg.toolCallId as string) || "";
		const call = toolCallPaths.get(toolCallId);
		if (!call) continue;

		const text = extractText(msg.content);
		const tokens = estimateTokens(text);
		const isError = (msg.isError as boolean) || false;

		if (!fileEvents.has(call.filePath)) {
			fileEvents.set(call.filePath, []);
		}
		fileEvents.get(call.filePath)!.push({
			action: call.name as "read" | "edit" | "write",
			tokens,
			isError,
		});
	}

	// Phase 3: Analyze patterns
	let readsAfterEdit = 0;
	let readsAfterSuccessfulEdit = 0;
	let readsAfterFailedEdit = 0;
	let readsBeforeEdit = 0;
	let standaloneReads = 0;
	let rereadTokens = 0;
	let rereadAfterFailTokens = 0;
	let rereadAfterSuccessTokens = 0;
	let totalReadTokens = 0;
	let totalEditAttempts = 0;
	let failedEdits = 0;
	let totalWriteAttempts = 0;

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
		totalWriteAttempts += evts.filter((e) => e.action === "write").length;
		failedEdits += evts.filter(
			(e) => e.action === "edit" && e.isError,
		).length;

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
					} else {
						readsAfterSuccessfulEdit++;
						rereadAfterSuccessTokens += evt.tokens;
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
				failedEdits: evts.filter(
					(e) => e.action === "edit" && e.isError,
				).length,
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
		readsAfterSuccessfulEdit,
		readsAfterFailedEdit,
		readsBeforeEdit,
		standaloneReads,
		rereadTokens,
		rereadAfterFailTokens,
		rereadAfterSuccessTokens,
		totalReadTokens,
		totalEditAttempts,
		failedEdits,
		totalWriteAttempts,
		heavyFiles: heavyFiles.sort((a, b) => b.readTokens - a.readTokens),
	};
}

async function main() {
	const entries = fs.readdirSync(SESSIONS_DIR);
	const projectDirs = entries.filter((e) => {
		if (!e.startsWith("-")) return false;
		if (e.includes("--T-pi-")) return false;
		if (e.toLowerCase().includes("carnage")) return false;
		return fs.statSync(path.join(SESSIONS_DIR, e)).isDirectory();
	});

	console.log(`Scanning ${projectDirs.length} project dirs (carnage excluded)`);

	const t = {
		sessions: 0,
		readsAfterEdit: 0,
		readsAfterSuccessfulEdit: 0,
		readsAfterFailedEdit: 0,
		readsBeforeEdit: 0,
		standaloneReads: 0,
		rereadTokens: 0,
		rereadAfterFailTokens: 0,
		rereadAfterSuccessTokens: 0,
		totalReadTokens: 0,
		totalEditAttempts: 0,
		failedEdits: 0,
		totalWriteAttempts: 0,
	};

	let allHeavyFiles: Array<{
		file: string;
		reads: number;
		edits: number;
		failedEdits: number;
		writes: number;
		readTokens: number;
		sequence: string;
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
				t.sessions++;
				t.readsAfterEdit += result.readsAfterEdit;
				t.readsAfterSuccessfulEdit += result.readsAfterSuccessfulEdit;
				t.readsAfterFailedEdit += result.readsAfterFailedEdit;
				t.readsBeforeEdit += result.readsBeforeEdit;
				t.standaloneReads += result.standaloneReads;
				t.rereadTokens += result.rereadTokens;
				t.rereadAfterFailTokens += result.rereadAfterFailTokens;
				t.rereadAfterSuccessTokens += result.rereadAfterSuccessTokens;
				t.totalReadTokens += result.totalReadTokens;
				t.totalEditAttempts += result.totalEditAttempts;
				t.failedEdits += result.failedEdits;
				t.totalWriteAttempts += result.totalWriteAttempts;

				for (const hf of result.heavyFiles.slice(0, 3)) {
					allHeavyFiles.push({ ...hf, project: dir.slice(0, 50) });
				}
			} catch {
				continue;
			}
		}
	}

	const totalReads =
		t.readsAfterEdit + t.readsBeforeEdit + t.standaloneReads;

	console.log(`\n=== READ-EDIT CYCLE ANALYSIS (${t.sessions} sessions, carnage excluded) ===`);

	console.log(`\nEditing activity:`);
	console.log(`  Edit attempts: ${t.totalEditAttempts}`);
	console.log(
		`    Failed: ${t.failedEdits} (${t.totalEditAttempts > 0 ? ((t.failedEdits / t.totalEditAttempts) * 100).toFixed(1) : 0}%)`,
	);
	console.log(
		`    Succeeded: ${t.totalEditAttempts - t.failedEdits}`,
	);
	console.log(`  Write attempts: ${t.totalWriteAttempts}`);

	console.log(`\nRead classification (${totalReads} total reads):`);
	if (totalReads > 0) {
		console.log(
			`  Re-reads AFTER edit/write:            ${t.readsAfterEdit} (${((t.readsAfterEdit / totalReads) * 100).toFixed(1)}%)`,
		);
		console.log(
			`    ...after SUCCESSFUL edit:           ${t.readsAfterSuccessfulEdit} [${Math.round(t.rereadAfterSuccessTokens / 1000)}K tokens] ← hashline anchor refresh`,
		);
		console.log(
			`    ...after FAILED edit:               ${t.readsAfterFailedEdit} [${Math.round(t.rereadAfterFailTokens / 1000)}K tokens] ← retry loop`,
		);
		console.log(
			`  Initial reads BEFORE edit/write:      ${t.readsBeforeEdit} (${((t.readsBeforeEdit / totalReads) * 100).toFixed(1)}%)`,
		);
		console.log(
			`  Standalone reads (understanding):     ${t.standaloneReads} (${((t.standaloneReads / totalReads) * 100).toFixed(1)}%)`,
		);
	}

	console.log(`\n=== THE HASHLINE TAX ===`);
	console.log(`  Total read tokens: ${Math.round(t.totalReadTokens / 1000)}K`);
	console.log(`  Re-read tokens (all): ${Math.round(t.rereadTokens / 1000)}K (${t.totalReadTokens > 0 ? ((t.rereadTokens / t.totalReadTokens) * 100).toFixed(1) : 0}% of reads)`);
	console.log(`  Re-read after success (anchor refresh): ${Math.round(t.rereadAfterSuccessTokens / 1000)}K`);
	console.log(`  Re-read after failure (retry loops): ${Math.round(t.rereadAfterFailTokens / 1000)}K`);
	console.log(`  Total hashline tax: ${Math.round(t.rereadTokens / 1000)}K tokens`);

	console.log(`\n=== TOP EDIT-HEAVY FILES ===`);
	console.log(`  (R=read, E=edit, W=write; lowercase=error)`);
	const topHeavy = allHeavyFiles
		.sort((a, b) => b.readTokens - a.readTokens)
		.slice(0, 20);
	for (const hf of topHeavy) {
		const seq =
			hf.sequence.length > 55
				? `${hf.sequence.slice(0, 55)}...`
				: hf.sequence;
		console.log(
			`  ${hf.file.padEnd(52)} ${String(hf.reads).padStart(2)}R ${String(hf.edits).padStart(2)}E(${hf.failedEdits}f) ${String(hf.writes).padStart(2)}W | ${String(hf.readTokens).padStart(6)} tok | ${seq}`,
		);
	}
}

main().catch(console.error);
