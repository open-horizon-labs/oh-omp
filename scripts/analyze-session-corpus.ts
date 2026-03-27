#!/usr/bin/env bun
/**
 * Analyze session JSONL files to find compression opportunities.
 * Scans all sessions, categorizes content by type, measures token volume,
 * and identifies the most common compressible patterns.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = path.join(
	process.env.HOME ?? "",
	".oh-omp/agent/sessions",
);

// Token estimation: chars / 4 (rough but directionally correct)
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

interface ToolStats {
	count: number;
	totalChars: number;
	totalTokens: number;
	maxTokens: number;
	samples: string[]; // first N samples for pattern analysis
}

interface PatternMatch {
	pattern: string;
	totalChars: number;
	occurrences: number;
}

interface SessionStats {
	file: string;
	messageCount: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	totalChars: number;
	totalTokens: number;
	toolTokens: Record<string, ToolStats>;
	assistantTokens: number;
	assistantThinkingChars: number;
	assistantProviderPayloadChars: number;
	userTokens: number;
}

// Pattern matchers for compressible content
const PATTERNS = {
	// LINE#ID: anchors in read/grep results
	lineAnchors: /^\s*>>?\d+#[A-Z]{2}:/gm,
	// Tree formatting in grep: # dir / ## └─ file
	treeHeaders: /^# .+\n## └─ .+$/gm,
	// Blank separator lines
	blankLines: /^\s*$/gm,
	// JSDoc blocks
	jsdocBlocks: /\/\*\*[\s\S]*?\*\//gm,
	// Inline comments
	inlineComments: /^\s*\/\/.+$/gm,
	// Import blocks
	importLines: /^import .+$/gm,
	// Filler phrases in assistant text
	fillerPhrases:
		/(?:Let me |Now I'll |Looking at |I can see that |The key insight here is |Now I have |Let me also |I'll also |Let me check |First, let me )/gm,
	// Encrypted thinking signatures (massive base64 blobs)
	thinkingSignatures: /"thinkingSignature":"[^"]+"/g,
	// Provider payload duplicates
	providerPayloads: /"providerPayload":\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g,
};

function analyzeToolResultContent(text: string): Record<string, PatternMatch> {
	const results: Record<string, PatternMatch> = {};

	for (const [name, regex] of Object.entries(PATTERNS)) {
		const matches = text.match(regex);
		if (matches) {
			const totalChars = matches.reduce((sum, m) => sum + m.length, 0);
			results[name] = {
				pattern: name,
				totalChars,
				occurrences: matches.length,
			};
		}
	}

	return results;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: Record<string, unknown>) => {
				if (c.type === "text") return c.text as string;
				if (c.type === "thinking")
					return (c.thinking as string) || (c.thinkingSignature as string) || "";
				if (c.type === "toolCall")
					return JSON.stringify(c.arguments || "");
				return "";
			})
			.join("\n");
	}
	return "";
}

async function analyzeSession(filePath: string): Promise<SessionStats | null> {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim());

		const stats: SessionStats = {
			file: path.basename(filePath),
			messageCount: 0,
			userMessages: 0,
			assistantMessages: 0,
			toolResults: 0,
			totalChars: 0,
			totalTokens: 0,
			toolTokens: {},
			assistantTokens: 0,
			assistantThinkingChars: 0,
			assistantProviderPayloadChars: 0,
			userTokens: 0,
		};

		for (const line of lines) {
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}

			if (event.type !== "message") continue;
			stats.messageCount++;

			const msg = event.message as Record<string, unknown>;
			if (!msg) continue;

			const role = msg.role as string;

			if (role === "user") {
				stats.userMessages++;
				const text = extractTextContent(msg.content);
				const tokens = estimateTokens(text);
				stats.userTokens += tokens;
				stats.totalChars += text.length;
				stats.totalTokens += tokens;
			} else if (role === "assistant") {
				stats.assistantMessages++;
				const text = extractTextContent(msg.content);
				const tokens = estimateTokens(text);
				stats.assistantTokens += tokens;
				stats.totalChars += text.length;
				stats.totalTokens += tokens;

				// Measure thinking signature size
				const rawLine = line;
				const thinkingSigMatch = rawLine.match(
					/"thinkingSignature":"([^"]+)"/,
				);
				if (thinkingSigMatch) {
					stats.assistantThinkingChars += thinkingSigMatch[1].length;
				}

				// Measure provider payload size
				const ppStart = rawLine.indexOf('"providerPayload"');
				if (ppStart !== -1) {
					// Rough extraction: find the matching closing brace
					let depth = 0;
					let end = ppStart;
					for (let i = rawLine.indexOf("{", ppStart); i < rawLine.length; i++) {
						if (rawLine[i] === "{") depth++;
						if (rawLine[i] === "}") depth--;
						if (depth === 0) {
							end = i + 1;
							break;
						}
					}
					stats.assistantProviderPayloadChars += end - ppStart;
				}
			} else if (role === "toolResult") {
				stats.toolResults++;
				const toolName = (msg.toolName as string) || "unknown";
				const text = extractTextContent(msg.content);
				const tokens = estimateTokens(text);
				stats.totalChars += text.length;
				stats.totalTokens += tokens;

				if (!stats.toolTokens[toolName]) {
					stats.toolTokens[toolName] = {
						count: 0,
						totalChars: 0,
						totalTokens: 0,
						maxTokens: 0,
						samples: [],
					};
				}
				const ts = stats.toolTokens[toolName];
				ts.count++;
				ts.totalChars += text.length;
				ts.totalTokens += tokens;
				ts.maxTokens = Math.max(ts.maxTokens, tokens);
				if (ts.samples.length < 3 && text.length > 100) {
					ts.samples.push(text.slice(0, 500));
				}
			}
		}

		return stats;
	} catch (e) {
		return null;
	}
}

async function main() {
	// Find all project session dirs (skip temp/test dirs)
	const entries = fs.readdirSync(SESSIONS_DIR);
	const projectDirs = entries.filter(
		(e) =>
			e.startsWith("-") &&
			!e.includes("--T-pi-") &&
			!e.includes("--T-pi-new-session") &&
			fs.statSync(path.join(SESSIONS_DIR, e)).isDirectory(),
	);

	console.log(`Found ${projectDirs.length} project session directories`);

	const allStats: SessionStats[] = [];
	const globalToolStats: Record<string, ToolStats> = {};
	const globalPatterns: Record<string, PatternMatch> = {};
	let totalSessions = 0;
	let totalMessages = 0;
	let totalTokens = 0;
	let totalAssistantTokens = 0;
	let totalToolTokens = 0;
	let totalUserTokens = 0;
	let totalThinkingChars = 0;
	let totalProviderPayloadChars = 0;

	// Analyze pattern frequency across all tool results
	let patternAnalysisCount = 0;
	const MAX_PATTERN_SAMPLES = 500;

	for (const dir of projectDirs) {
		const dirPath = path.join(SESSIONS_DIR, dir);
		const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

		for (const file of files) {
			const filePath = path.join(dirPath, file);
			const stat = fs.statSync(filePath);
			// Skip tiny files
			if (stat.size < 1000) continue;

			const stats = await analyzeSession(filePath);
			if (!stats || stats.messageCount === 0) continue;

			allStats.push(stats);
			totalSessions++;
			totalMessages += stats.messageCount;
			totalTokens += stats.totalTokens;
			totalAssistantTokens += stats.assistantTokens;
			totalUserTokens += stats.userTokens;
			totalThinkingChars += stats.assistantThinkingChars;
			totalProviderPayloadChars += stats.assistantProviderPayloadChars;

			// Aggregate tool stats
			for (const [tool, ts] of Object.entries(stats.toolTokens)) {
				totalToolTokens += ts.totalTokens;
				if (!globalToolStats[tool]) {
					globalToolStats[tool] = {
						count: 0,
						totalChars: 0,
						totalTokens: 0,
						maxTokens: 0,
						samples: [],
					};
				}
				const g = globalToolStats[tool];
				g.count += ts.count;
				g.totalChars += ts.totalChars;
				g.totalTokens += ts.totalTokens;
				g.maxTokens = Math.max(g.maxTokens, ts.maxTokens);
			}

			// Pattern analysis on tool results (sample)
			if (patternAnalysisCount < MAX_PATTERN_SAMPLES) {
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.split("\n");
				for (const line of lines) {
					try {
						const event = JSON.parse(line) as Record<string, unknown>;
						if (event.type !== "message") continue;
						const msg = event.message as Record<string, unknown>;
						if (msg?.role !== "toolResult") continue;
						const text = extractTextContent(msg.content);
						if (text.length < 50) continue;

						const patterns = analyzeToolResultContent(text);
						for (const [name, pm] of Object.entries(patterns)) {
							if (!globalPatterns[name]) {
								globalPatterns[name] = {
									pattern: name,
									totalChars: 0,
									occurrences: 0,
								};
							}
							globalPatterns[name].totalChars += pm.totalChars;
							globalPatterns[name].occurrences += pm.occurrences;
						}
						patternAnalysisCount++;
						if (patternAnalysisCount >= MAX_PATTERN_SAMPLES) break;
					} catch {
						continue;
					}
				}
			}
		}
	}

	// Print results
	console.log("\n=== CORPUS SUMMARY ===");
	console.log(`Sessions analyzed: ${totalSessions}`);
	console.log(`Total messages: ${totalMessages}`);
	console.log(
		`Total estimated tokens: ${(totalTokens / 1000).toFixed(0)}K`,
	);
	console.log(
		`  User messages: ${(totalUserTokens / 1000).toFixed(0)}K (${((totalUserTokens / totalTokens) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Assistant messages: ${(totalAssistantTokens / 1000).toFixed(0)}K (${((totalAssistantTokens / totalTokens) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Tool results: ${(totalToolTokens / 1000).toFixed(0)}K (${((totalToolTokens / totalTokens) * 100).toFixed(1)}%)`,
	);

	console.log("\n=== ASSISTANT MESSAGE OVERHEAD ===");
	console.log(
		`  Thinking signatures: ${(totalThinkingChars / 1000).toFixed(0)}K chars (${(estimateTokens(String(totalThinkingChars)) / 1000).toFixed(0)}K est. tokens in JSONL, NOT sent to model)`,
	);
	console.log(
		`  Provider payloads: ${(totalProviderPayloadChars / 1000).toFixed(0)}K chars (storage overhead, NOT sent to model)`,
	);

	console.log("\n=== TOOL RESULT BREAKDOWN (sorted by total tokens) ===");
	const sortedTools = Object.entries(globalToolStats).sort(
		(a, b) => b[1].totalTokens - a[1].totalTokens,
	);
	for (const [tool, ts] of sortedTools) {
		const avg = ts.count > 0 ? Math.round(ts.totalTokens / ts.count) : 0;
		const pct = ((ts.totalTokens / totalToolTokens) * 100).toFixed(1);
		console.log(
			`  ${tool.padEnd(20)} ${String(ts.count).padStart(6)} calls | ${String(Math.round(ts.totalTokens / 1000)).padStart(7)}K tokens (${pct}%) | avg ${avg} | max ${ts.maxTokens}`,
		);
	}

	console.log(
		"\n=== COMPRESSIBLE PATTERNS IN TOOL RESULTS (sorted by total chars) ===",
	);
	const sortedPatterns = Object.entries(globalPatterns).sort(
		(a, b) => b[1].totalChars - a[1].totalChars,
	);
	for (const [name, pm] of sortedPatterns) {
		const tokens = estimateTokens("x".repeat(pm.totalChars));
		console.log(
			`  ${name.padEnd(25)} ${String(pm.occurrences).padStart(8)} occurrences | ${String(Math.round(pm.totalChars / 1000)).padStart(7)}K chars (~${Math.round(tokens / 1000)}K tokens)`,
		);
	}

	// Top 10 largest individual tool results
	console.log("\n=== TOP 10 LARGEST TOOL RESULT TYPES (by max single result) ===");
	const byMax = Object.entries(globalToolStats).sort(
		(a, b) => b[1].maxTokens - a[1].maxTokens,
	);
	for (const [tool, ts] of byMax.slice(0, 10)) {
		console.log(`  ${tool.padEnd(20)} max ${ts.maxTokens} tokens`);
	}

	// Average tokens per message type per session
	if (allStats.length > 0) {
		const avgMessagesPerSession = totalMessages / totalSessions;
		const avgTokensPerSession = totalTokens / totalSessions;
		console.log("\n=== PER-SESSION AVERAGES ===");
		console.log(`  Messages/session: ${avgMessagesPerSession.toFixed(0)}`);
		console.log(
			`  Tokens/session: ${(avgTokensPerSession / 1000).toFixed(0)}K`,
		);
		console.log(
			`  Tool tokens/session: ${(totalToolTokens / totalSessions / 1000).toFixed(0)}K`,
		);
		console.log(
			`  Assistant tokens/session: ${(totalAssistantTokens / totalSessions / 1000).toFixed(0)}K`,
		);
	}
}

main().catch(console.error);
