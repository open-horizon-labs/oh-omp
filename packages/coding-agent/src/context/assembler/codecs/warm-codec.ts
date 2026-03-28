/**
 * Warm codec: generic catch-all that preserves a head/tail peek of any tool result.
 *
 * Fires for ANY tool result not handled by a preceding codec (dedup, read).
 * Tool-agnostic — no command-specific parsing. Extracts key arguments from
 * the tool call and keeps a truncated peek of the output so the model knows
 * what was asked and what came back, without the full payload.
 *
 * Skips edit tool results — those need message expansion tooling before
 * we can safely compress them.
 *
 * Format:
 *   [warm:<tool> | <key args> | <N lines>]
 *   <first HEAD_LINES of output>
 *   [... M lines omitted]
 *   <last TAIL_LINES of output>
 */

import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { CodecContext, ContentCodec } from "../types";
import { extractText } from "./shared";

/** Number of lines to keep from the start of the output. */
const HEAD_LINES = 3;
/** Number of lines to keep from the end of the output. */
const TAIL_LINES = 2;
/** Total peek lines — outputs at or below this size are kept verbatim. */
const VERBATIM_THRESHOLD = HEAD_LINES + TAIL_LINES;

/** Argument names worth preserving in the warm header. */
const ARG_ALLOWLIST = new Set(["path", "pattern", "command", "action", "query", "url"]);
/** Max length for argument values before truncation. */
const ARG_MAX_LENGTH = 60;

/** Tools to skip — these need special handling or are already small. */
const SKIP_TOOLS = new Set(["edit", "proxy_edit"]);

function formatArgValue(value: unknown): string {
	if (typeof value !== "string") return String(value);
	if (value.length <= ARG_MAX_LENGTH) return value;
	return `${value.slice(0, ARG_MAX_LENGTH)}…`;
}

function buildArgSummary(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of Object.keys(args)) {
		if (!ARG_ALLOWLIST.has(key)) continue;
		const val = args[key];
		if (val === undefined || val === null) continue;
		parts.push(`${key}=${JSON.stringify(formatArgValue(val))}`);
	}
	return parts.join(" ");
}

function buildPeek(lines: string[], lineCount: number): string {
	if (lineCount <= VERBATIM_THRESHOLD) {
		return lines.join("\n");
	}
	const head = lines.slice(0, HEAD_LINES);
	const tail = lines.slice(-TAIL_LINES);
	const omitted = lineCount - HEAD_LINES - TAIL_LINES;
	return [...head, `[... ${omitted} lines omitted]`, ...tail].join("\n");
}

export const warmCodec: ContentCodec = {
	name: "warm",

	matches(_message: ToolResultMessage, ctx: CodecContext): boolean {
		if (!ctx.toolName) return false;
		return !SKIP_TOOLS.has(ctx.toolName);
	},

	encode(message: ToolResultMessage, ctx: CodecContext): TextContent[] | null {
		const text = extractText(message);
		if (!text) return null;

		const lines = text.split("\n");
		const lineCount = lines.length;
		const toolName = ctx.toolName ?? "unknown";
		const argSummary = buildArgSummary(ctx.toolCallArgs);

		const headerParts = [`warm:${toolName}`];
		if (argSummary) headerParts.push(argSummary);
		headerParts.push(`${lineCount} lines`);
		const header = `[${headerParts.join(" | ")}]`;

		const peek = buildPeek(lines, lineCount);
		return [{ type: "text", text: `${header}\n${peek}` }];
	},
};
