/**
 * Content codec for file read tool results.
 *
 * Produces warm representations that preserve structural information
 * when file reads age out of the hot window.
 *
 * Two modes:
 *   - RNA structural views (read without offset): already compact.
 *     Preserved as-is with a warm marker.
 *   - Source reads (read with offset): compressed to file path, line range,
 *     and a "Showing lines X-Y of Z" summary.
 */

import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { CodecContext, ContentCodec } from "../types";

/** Marker prefix for RNA structural views in read tool output. */
const RNA_VIEW_PREFIX = "[RNA structural view of ";

/** Tool names that represent file reads. */
const READ_TOOL_NAMES = new Set(["proxy_read", "read"]);

/**
 * Extract text content from a tool result message.
 * Returns the concatenated text of all text content blocks.
 */
function extractText(message: ToolResultMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
		} else if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			parts.push(block.text as string);
		}
	}
	return parts.join("\n");
}

/**
 * Detect whether this is an RNA structural view (read without offset).
 */
function isRnaStructuralView(text: string): boolean {
	return text.startsWith(RNA_VIEW_PREFIX);
}

/**
 * Extract line range info from source read content.
 * Looks for the "[Showing lines X-Y of Z. Use offset=N to continue]" trailer.
 */
function extractLineInfo(text: string): { start: number; end: number; total: number } | null {
	const match = text.match(/\[Showing lines (\d+)-(\d+) of (\d+)/);
	if (!match) return null;
	return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/**
 * Read codec: produces warm representations for file reads.
 */
export const readCodec: ContentCodec = {
	name: "read",

	matches(message: ToolResultMessage, ctx: CodecContext): boolean {
		const toolName = ctx.toolName ?? message.toolName;
		if (!toolName) return false;
		// Match both direct tool names and proxy- prefixed variants
		const baseName = toolName.replace(/^proxy_/, "");
		return READ_TOOL_NAMES.has(baseName) || READ_TOOL_NAMES.has(toolName);
	},

	encode(message: ToolResultMessage, ctx: CodecContext): TextContent[] | null {
		const text = extractText(message);
		if (!text) return null;

		const filePath = ctx.locator?.where ?? "unknown";

		// Case 1: RNA structural view — already compact. Preserve it.
		if (isRnaStructuralView(text)) {
			return [{ type: "text", text: `[warm:read:${filePath}]\n${text}` }];
		}

		// Case 2: Source read with line range — compress to metadata + summary.
		const lineInfo = extractLineInfo(text);
		if (lineInfo) {
			const warmText = `[warm:read:${filePath} | lines ${lineInfo.start}-${lineInfo.end} of ${lineInfo.total}]`;
			return [{ type: "text", text: warmText }];
		}

		// Case 3: Source read without line info (short files read entirely).
		// Count lines and produce compact representation.
		const lineCount = text.split("\n").length;
		if (lineCount <= 5) {
			// Very short content — preserve as-is, not worth compressing.
			return null;
		}

		return [{ type: "text", text: `[warm:read:${filePath} | ${lineCount} lines]` }];
	},
};
