/**
 * Helpers for extracting text and file paths from agent messages.
 *
 * Used by the ingest pipeline to produce embeddable text and metadata
 * for user, assistant, and tool result messages.
 */

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";

type MessageContent = UserMessage["content"];
type AssistantContent = AssistantMessage["content"];
type ToolResultContent = ToolResultMessage["content"];

/**
 * Extract plain text from a user or developer message's content field.
 * Handles both string content and TextContent[] arrays.
 */
export function extractUserText(content: MessageContent): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Extract plain text from an assistant message's content array.
 * Includes text blocks and thinking blocks (thinking contains reasoning
 * that may reference files/symbols relevant for recall).
 */
export function extractAssistantText(content: AssistantContent): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "thinking") {
			parts.push(block.thinking);
		}
	}
	return parts.join("\n");
}

/**
 * Extract plain text from a tool result message's content array.
 */
export function extractToolResultText(content: ToolResultContent): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Extract file paths from free text (user or assistant messages).
 *
 * Matches common path patterns:
 * - Paths with extensions: `src/foo/bar.ts`, `./config.json`
 * - Paths starting with known prefixes: `packages/`, `src/`, `lib/`, `test/`, `crates/`
 * - Backtick-wrapped paths: \`some/path.ext\`
 *
 * Does NOT match:
 * - URLs (http://, https://)
 * - Artifact/protocol URLs (artifact://, skill://, memory://)
 */
const PATH_PATTERN =
	/(?:^|[\s`"'([\]])(?!(?:https?|artifact|skill|memory|mcp|rule|local|pi|agent|jobs):\/\/)((?:\.{0,2}\/)?(?:[a-zA-Z0-9_@.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/gm;

export function extractPathsFromText(text: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const match of text.matchAll(PATH_PATTERN)) {
		const p = match[1];
		if (p && !seen.has(p)) {
			seen.add(p);
			paths.push(p);
		}
	}

	return paths;
}
