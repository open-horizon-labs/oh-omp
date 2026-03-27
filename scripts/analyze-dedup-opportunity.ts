#!/usr/bin/env bun
/**
 * Analyze deduplication opportunity: how often is the same file read
 * multiple times in a session? And how much do assistant messages contribute
 * in actual text (not thinking signatures)?
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

interface DedupStats {
	totalReadCalls: number;
	uniqueFiles: number;
	duplicateReads: number;
	duplicateTokens: number;
	totalReadTokens: number;
	topDuplicates: Array<{ file: string; reads: number; avgTokens: number }>;
}

interface AssistantBreakdown {
	totalMessages: number;
	textTokens: number;
	toolCallArgTokens: number;
	thinkingTextTokens: number;
	thinkingSigTokens: number;
}

async function analyzeSession(filePath: string) {
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim());

	// Track file reads per session
	const fileReads: Map<string, { count: number; totalTokens: number }> =
		new Map();
	const dedup: DedupStats = {
		totalReadCalls: 0,
		uniqueFiles: 0,
		duplicateReads: 0,
		duplicateTokens: 0,
		totalReadTokens: 0,
		topDuplicates: [],
	};

	const assistant: AssistantBreakdown = {
		totalMessages: 0,
		textTokens: 0,
		toolCallArgTokens: 0,
		thinkingTextTokens: 0,
		thinkingSigTokens: 0,
	};

	// Also track: what fraction of grep results are "context lines" vs match lines
	let grepMatchLineChars = 0;
	let grepContextLineChars = 0;
	let grepTotalCalls = 0;

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
			assistant.totalMessages++;
			const contentArr = msg.content as Array<Record<string, unknown>>;
			if (!Array.isArray(contentArr)) continue;

			for (const c of contentArr) {
				if (c.type === "text") {
					assistant.textTokens += estimateTokens(
						(c.text as string) || "",
					);
				} else if (c.type === "thinking") {
					const thinkingText = (c.thinking as string) || "";
					const thinkingSig = (c.thinkingSignature as string) || "";
					assistant.thinkingTextTokens += estimateTokens(thinkingText);
					assistant.thinkingSigTokens += estimateTokens(thinkingSig);
				} else if (c.type === "toolCall") {
					const args = (c.arguments as string) || JSON.stringify(c.arguments || "");
					assistant.toolCallArgTokens += estimateTokens(
						typeof args === "string" ? args : JSON.stringify(args),
					);
				}
			}
		}

		if (msg.role === "toolResult") {
			const toolName = msg.toolName as string;
			const details = msg.details as Record<string, unknown> | undefined;

			// Analyze read deduplication
			if (toolName === "read") {
				const resolvedPath =
					(details?.resolvedPath as string) ||
					(details?.meta?.source?.value as string) ||
					"";
				if (resolvedPath) {
					const text = extractText(msg.content);
					const tokens = estimateTokens(text);
					dedup.totalReadCalls++;
					dedup.totalReadTokens += tokens;

					const existing = fileReads.get(resolvedPath);
					if (existing) {
						existing.count++;
						existing.totalTokens += tokens;
					} else {
						fileReads.set(resolvedPath, {
							count: 1,
							totalTokens: tokens,
						});
					}
				}
			}

			// Analyze grep context vs match lines
			if (toolName === "grep") {
				grepTotalCalls++;
				const text = extractText(msg.content);
				for (const gline of text.split("\n")) {
					const trimmed = gline.trim();
					if (!trimmed) continue;
					if (trimmed.startsWith(">>")) {
						grepMatchLineChars += gline.length;
					} else if (trimmed.startsWith("#") || trimmed.startsWith("##")) {
						// tree header - already counted
					} else if (/^\d+#[A-Z]{2}:/.test(trimmed)) {
						// context line with anchor
						grepContextLineChars += gline.length;
					}
				}
			}
		}
	}

	// Compute dedup stats
	for (const [file, info] of fileReads.entries()) {
		if (info.count > 1) {
			dedup.duplicateReads += info.count - 1;
			// Estimate: duplicate reads waste (count-1) * avgTokens
			const avgTokens = Math.round(info.totalTokens / info.count);
			dedup.duplicateTokens += (info.count - 1) * avgTokens;
		}
	}
	dedup.uniqueFiles = fileReads.size;

	// Top duplicated files
	const topDups = [...fileReads.entries()]
		.filter(([_, info]) => info.count > 1)
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, 5)
		.map(([file, info]) => ({
			file: file.split("/").slice(-2).join("/"),
			reads: info.count,
			avgTokens: Math.round(info.totalTokens / info.count),
		}));
	dedup.topDuplicates = topDups;

	return { dedup, assistant, grepMatchLineChars, grepContextLineChars, grepTotalCalls };
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

async function main() {
	const entries = fs.readdirSync(SESSIONS_DIR);
	const projectDirs = entries.filter(
		(e) =>
			e.startsWith("-") &&
			!e.includes("--T-pi-") &&
			fs.statSync(path.join(SESSIONS_DIR, e)).isDirectory(),
	);

	let totalReadCalls = 0;
	let totalDuplicateReads = 0;
	let totalDuplicateTokens = 0;
	let totalReadTokens = 0;
	let totalUniqueFiles = 0;

	let totalAssistantText = 0;
	let totalAssistantToolCallArgs = 0;
	let totalAssistantThinkingText = 0;
	let totalAssistantThinkingSig = 0;
	let totalAssistantMessages = 0;

	let totalGrepMatchChars = 0;
	let totalGrepContextChars = 0;
	let totalGrepCalls = 0;

	const allTopDups: Array<{
		file: string;
		reads: number;
		avgTokens: number;
		session: string;
	}> = [];

	let sessions = 0;

	for (const dir of projectDirs) {
		const dirPath = path.join(SESSIONS_DIR, dir);
		const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

		for (const file of files) {
			const filePath = path.join(dirPath, file);
			const stat = fs.statSync(filePath);
			if (stat.size < 1000) continue;

			try {
				const result = await analyzeSession(filePath);
				sessions++;

				totalReadCalls += result.dedup.totalReadCalls;
				totalDuplicateReads += result.dedup.duplicateReads;
				totalDuplicateTokens += result.dedup.duplicateTokens;
				totalReadTokens += result.dedup.totalReadTokens;
				totalUniqueFiles += result.dedup.uniqueFiles;

				totalAssistantText += result.assistant.textTokens;
				totalAssistantToolCallArgs += result.assistant.toolCallArgTokens;
				totalAssistantThinkingText += result.assistant.thinkingTextTokens;
				totalAssistantThinkingSig += result.assistant.thinkingSigTokens;
				totalAssistantMessages += result.assistant.totalMessages;

				totalGrepMatchChars += result.grepMatchLineChars;
				totalGrepContextChars += result.grepContextLineChars;
				totalGrepCalls += result.grepTotalCalls;

				for (const d of result.dedup.topDuplicates) {
					allTopDups.push({ ...d, session: file.slice(0, 20) });
				}
			} catch {
				continue;
			}
		}
	}

	console.log(`\n=== FILE READ DEDUPLICATION (${sessions} sessions) ===`);
	console.log(`  Total read calls: ${totalReadCalls}`);
	console.log(`  Unique files: ${totalUniqueFiles}`);
	console.log(`  Duplicate reads: ${totalDuplicateReads} (${((totalDuplicateReads / totalReadCalls) * 100).toFixed(1)}% of all reads)`);
	console.log(`  Tokens in duplicates: ${Math.round(totalDuplicateTokens / 1000)}K (${((totalDuplicateTokens / totalReadTokens) * 100).toFixed(1)}% of read tokens)`);
	console.log(`  Total read tokens: ${Math.round(totalReadTokens / 1000)}K`);

	console.log("\n  Top duplicated files across all sessions:");
	const sortedDups = allTopDups
		.sort((a, b) => b.reads * b.avgTokens - a.reads * a.avgTokens)
		.slice(0, 15);
	for (const d of sortedDups) {
		console.log(
			`    ${d.file.padEnd(45)} ${d.reads}x reads, ~${d.avgTokens} tokens each = ${d.reads * d.avgTokens} wasted tokens`,
		);
	}

	console.log(`\n=== ASSISTANT MESSAGE BREAKDOWN ===`);
	const totalAssistant =
		totalAssistantText + totalAssistantToolCallArgs + totalAssistantThinkingText + totalAssistantThinkingSig;
	console.log(`  Total assistant content: ${Math.round(totalAssistant / 1000)}K tokens`);
	console.log(
		`  Actual text: ${Math.round(totalAssistantText / 1000)}K (${((totalAssistantText / totalAssistant) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Tool call args: ${Math.round(totalAssistantToolCallArgs / 1000)}K (${((totalAssistantToolCallArgs / totalAssistant) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Thinking text: ${Math.round(totalAssistantThinkingText / 1000)}K (${((totalAssistantThinkingText / totalAssistant) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Thinking signatures: ${Math.round(totalAssistantThinkingSig / 1000)}K (${((totalAssistantThinkingSig / totalAssistant) * 100).toFixed(1)}%) [opaque, not compressible]`,
	);

	console.log(`\n=== GREP CONTEXT vs MATCH LINES (${totalGrepCalls} calls) ===`);
	const totalGrepChars = totalGrepMatchChars + totalGrepContextChars;
	if (totalGrepChars > 0) {
		console.log(`  Match lines: ${Math.round(totalGrepMatchChars / 1000)}K chars (${((totalGrepMatchChars / totalGrepChars) * 100).toFixed(1)}%)`);
		console.log(`  Context lines: ${Math.round(totalGrepContextChars / 1000)}K chars (${((totalGrepContextChars / totalGrepChars) * 100).toFixed(1)}%)`);
		console.log(`  Context is compressible: ${((totalGrepContextChars / totalGrepChars) * 100).toFixed(1)}% potential reduction`);
	} else {
		console.log(`  No grep content parsed (format may differ)`);
	}
}

main().catch(console.error);
