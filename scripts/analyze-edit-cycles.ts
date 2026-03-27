#!/usr/bin/env bun
/**
 * Analyze the read-edit-read cycle pattern.
 * Hypothesis: hashline editing forces re-reads because anchors invalidate.
 *
 * Uses details.meta.source.value for file path extraction from tool results.
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

interface FileEvent {
	action: "read" | "edit" | "write";
	tokens: number;
	seqIndex: number;
}

function extractFilePath(msg: Record<string, unknown>): string {
	// Primary: details.meta.source.value (confirmed format)
	const details = msg.details as Record<string, unknown> | undefined;
	if (details) {
		const meta = details.meta as Record<string, unknown> | undefined;
		if (meta) {
			const source = meta.source as Record<string, unknown> | undefined;
			if (source && source.value) {
				return normalizePath(source.value as string);
			}
		}
	}
	return "";
}

function normalizePath(p: string): string {
	// Strip home dir prefix, normalize
	return p
		.replace(/^\/Users\/[^/]+\//, "~/")
		.replace(/\/+/g, "/");
}

async function analyzeSession(filePath: string) {
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter(Boolean);

	// Collect ordered file events from tool results
	const fileEvents: Map<string, FileEvent[]> = new Map();
	let seqIndex = 0;

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

		const toolName = msg.toolName as string;
		if (!["read", "edit", "write"].includes(toolName)) continue;

		const fp = extractFilePath(msg);
		if (!fp) continue;

		const text = extractText(msg.content);
		const tokens = estimateTokens(text);

		if (!fileEvents.has(fp)) {
			fileEvents.set(fp, []);
		}
		fileEvents.get(fp)!.push({
			action: toolName as "read" | "edit" | "write",
			tokens,
			seqIndex: seqIndex++,
		});
	}

	// Classify reads
	let readsAfterEdit = 0;
	let readsBeforeEdit = 0;
	let standaloneReads = 0;
	let rereadTokens = 0;
	let totalReadTokens = 0;
	let editCycleLengths: number[] = [];

	const heavyFiles: Array<{
		file: string;
		reads: number;
		edits: number;
		writes: number;
		readTokens: number;
		sequence: string;
	}> = [];

	for (const [file, evts] of fileEvents.entries()) {
		const readTokensForFile = evts
			.filter((e) => e.action === "read")
			.reduce((s, e) => s + e.tokens, 0);
		totalReadTokens += readTokensForFile;

		if (evts.length < 2) {
			if (evts[0].action === "read") standaloneReads++;
			continue;
		}

		let cycleLen = 0;
		for (let i = 0; i < evts.length; i++) {
			const evt = evts[i];
			const prev = i > 0 ? evts[i - 1] : null;
			const next = i < evts.length - 1 ? evts[i + 1] : null;

			if (evt.action === "read") {
				if (prev && (prev.action === "edit" || prev.action === "write")) {
					// Re-read after edit = hashline tax
					readsAfterEdit++;
					rereadTokens += evt.tokens;
					cycleLen++;
				} else if (next && (next.action === "edit" || next.action === "write")) {
					// Initial read before edit
					readsBeforeEdit++;
					cycleLen++;
				} else {
					standaloneReads++;
				}
			} else {
				cycleLen++;
			}
		}
		if (cycleLen > 1) {
			editCycleLengths.push(cycleLen);
		}

		// Track heavy files
		if (evts.length >= 4) {
			heavyFiles.push({
				file: file.split("/").slice(-3).join("/"),
				reads: evts.filter((e) => e.action === "read").length,
				edits: evts.filter((e) => e.action === "edit").length,
				writes: evts.filter((e) => e.action === "write").length,
				readTokens: readTokensForFile,
				sequence: evts.map((e) => e.action[0].toUpperCase()).join(""),
			});
		}
	}

	return {
		totalFiles: fileEvents.size,
		readsBeforeEdit,
		readsAfterEdit,
		standaloneReads,
		rereadTokens,
		totalReadTokens,
		editCycleLengths,
		heavyFiles: heavyFiles.sort((a, b) => b.readTokens - a.readTokens),
	};
}

async function main() {
	const entries = fs.readdirSync(SESSIONS_DIR);
	const projectDirs = entries.filter(
		(e) =>
			e.startsWith("-") &&
			!e.includes("--T-pi-") &&
			fs.statSync(path.join(SESSIONS_DIR, e)).isDirectory(),
	);

	let totalReadsBeforeEdit = 0;
	let totalReadsAfterEdit = 0;
	let totalStandaloneReads = 0;
	let totalRereadTokens = 0;
	let totalReadTokens = 0;
	let allCycleLengths: number[] = [];
	let allHeavyFiles: Array<{
		file: string;
		reads: number;
		edits: number;
		writes: number;
		readTokens: number;
		sequence: string;
		session: string;
	}> = [];
	let sessions = 0;

	for (const dir of projectDirs) {
		const dirPath = path.join(SESSIONS_DIR, dir);
		const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

		for (const file of files) {
			const fp = path.join(dirPath, file);
			const stat = fs.statSync(fp);
			if (stat.size < 1000) continue;

			try {
				const result = await analyzeSession(fp);
				sessions++;

				totalReadsBeforeEdit += result.readsBeforeEdit;
				totalReadsAfterEdit += result.readsAfterEdit;
				totalStandaloneReads += result.standaloneReads;
				totalRereadTokens += result.rereadTokens;
				totalReadTokens += result.totalReadTokens;
				allCycleLengths.push(...result.editCycleLengths);

				for (const hf of result.heavyFiles.slice(0, 3)) {
					allHeavyFiles.push({ ...hf, session: file.slice(0, 20) });
				}
			} catch {
				continue;
			}
		}
	}

	const totalReads =
		totalReadsBeforeEdit + totalReadsAfterEdit + totalStandaloneReads;

	console.log(`\n=== READ-EDIT CYCLE ANALYSIS (${sessions} sessions) ===`);
	console.log(`\nRead classification (${totalReads} total reads):`);
	if (totalReads > 0) {
		console.log(
			`  Re-reads AFTER edit (hashline tax):  ${totalReadsAfterEdit} (${((totalReadsAfterEdit / totalReads) * 100).toFixed(1)}%)`,
		);
		console.log(
			`  Initial reads BEFORE edit:            ${totalReadsBeforeEdit} (${((totalReadsBeforeEdit / totalReads) * 100).toFixed(1)}%)`,
		);
		console.log(
			`  Standalone reads (no adjacent edit):  ${totalStandaloneReads} (${((totalStandaloneReads / totalReads) * 100).toFixed(1)}%)`,
		);
	}

	console.log(`\nToken impact:`);
	console.log(
		`  Total tracked read tokens: ${Math.round(totalReadTokens / 1000)}K`,
	);
	console.log(
		`  Tokens on re-reads after edit: ${Math.round(totalRereadTokens / 1000)}K (${totalReadTokens > 0 ? ((totalRereadTokens / totalReadTokens) * 100).toFixed(1) : 0}% of read budget)`,
	);
	console.log(
		`  As fraction of total corpus (10001K): ${((totalRereadTokens / 10001000) * 100).toFixed(1)}%`,
	);

	if (allCycleLengths.length > 0) {
		const sorted = allCycleLengths.sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)];
		const max = sorted[sorted.length - 1];
		const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length;
		const p90 = sorted[Math.floor(sorted.length * 0.9)];
		console.log(`\nEdit cycle lengths (${sorted.length} files with cycles):`);
		console.log(`  Median: ${median} | Mean: ${avg.toFixed(1)} | P90: ${p90} | Max: ${max}`);
	}

	console.log(
		`\n=== TOP EDIT-HEAVY FILES (sorted by read token cost) ===`,
	);
	const topHeavy = allHeavyFiles
		.sort((a, b) => b.readTokens - a.readTokens)
		.slice(0, 25);
	for (const hf of topHeavy) {
		const seq =
			hf.sequence.length > 50
				? `${hf.sequence.slice(0, 50)}...`
				: hf.sequence;
		console.log(
			`  ${hf.file.padEnd(50)} ${String(hf.reads).padStart(3)}R ${String(hf.edits).padStart(3)}E ${String(hf.writes).padStart(3)}W | ${String(hf.readTokens).padStart(6)} tok | ${seq}`,
		);
	}

	// The key question
	console.log(`\n=== THE HASHLINE TAX ===`);
	console.log(`  If edits didn't invalidate anchors, re-reads wouldn't happen.`);
	console.log(`  Savings: ${Math.round(totalRereadTokens / 1000)}K tokens (${((totalRereadTokens / 10001000) * 100).toFixed(1)}% of total corpus)`);
	console.log(`  Per session average: ${sessions > 0 ? Math.round(totalRereadTokens / sessions / 1000) : 0}K tokens saved`);
}

main().catch(console.error);
