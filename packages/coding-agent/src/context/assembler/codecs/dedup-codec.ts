/**
 * Dedup codec: detects re-reads of unchanged files across turns.
 *
 * When a file has been read before and its content hasn't changed,
 * emits a compact back-reference instead of producing a redundant
 * skeleton or stub. Must be registered BEFORE the read codec in
 * the codec registry (first match wins).
 *
 * Detection: compares Bun.hash of the tool result text content
 * against the readHistory entry for the same file path.
 */

import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { CodecContext, ContentCodec } from "../types";
import { contentHash, extractText, isReadTool } from "./shared";

/**
 * Dedup codec: emits a back-reference for re-reads of unchanged files.
 */
export const dedupCodec: ContentCodec = {
	name: "dedup",

	matches(_message: ToolResultMessage, ctx: CodecContext): boolean {
		if (!isReadTool(ctx.toolName)) return false;
		if (!ctx.readHistory) return false;
		const filePath = ctx.toolCallPath;
		if (!filePath) return false;
		return ctx.readHistory.has(filePath);
	},

	encode(message: ToolResultMessage, ctx: CodecContext): TextContent[] | null {
		const filePath = ctx.toolCallPath;
		if (!filePath || !ctx.readHistory) return null;

		const prior = ctx.readHistory.get(filePath);
		if (!prior) return null;

		const text = extractText(message);
		if (!text) return null;

		const currentHash = contentHash(text);
		if (currentHash !== prior.contentHash) {
			// File changed since last read — fall through to read codec for fresh skeleton.
			return null;
		}

		// Content identical to prior read — emit back-reference.
		return [{ type: "text", text: `[unchanged since T${prior.turnIndex}:read:${filePath}]` }];
	},
};
