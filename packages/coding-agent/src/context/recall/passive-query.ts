import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	extractSourceTags,
	extractToolCallInfo,
	formatStubText,
	segmentIntoTurns,
	type Turn,
	updateReadHistory,
} from "../assembler";
import { dedupCodec, readCodec, warmCodec } from "../assembler/codecs";
import { extractText } from "../assembler/codecs/shared";
import type { CodecContext, ContentCodec, FileReadEntry } from "../assembler/types";
import { extractAssistantText, extractToolResultText, extractUserText } from "./message-text";

const DEFAULT_PASSIVE_RECALL_CODECS: ContentCodec[] = [dedupCodec, readCodec, warmCodec];

export interface PassiveRecallQueryCodecStats {
	encoded: number;
	stubbed: number;
	counts: Record<string, number>;
}

export interface PassiveRecallQueryMetadata {
	originalCharCount: number;
	effectiveCharCount: number;
	toolResultRawCharCount: number;
	toolResultEffectiveCharCount: number;
	toolResults: PassiveRecallQueryCodecStats;
}

export interface PassiveRecallQuery {
	text: string | null;
	metadata: PassiveRecallQueryMetadata;
}

export interface PassiveRecallQueryOptions {
	windowTurns?: number;
	codecs?: ContentCodec[];
}

export function buildPassiveRecallQuery(
	messages: AgentMessage[],
	options: PassiveRecallQueryOptions = {},
): PassiveRecallQuery {
	const selected = new Set(selectHotWindowMessages(messages, options.windowTurns));
	const codecRegistry = options.codecs ?? DEFAULT_PASSIVE_RECALL_CODECS;
	const turns = segmentIntoTurns(messages);
	const readHistory = new Map<string, FileReadEntry>();
	const parts: string[] = [];
	const originalParts: string[] = [];
	const metadata: PassiveRecallQueryMetadata = {
		originalCharCount: 0,
		effectiveCharCount: 0,
		toolResultRawCharCount: 0,
		toolResultEffectiveCharCount: 0,
		toolResults: { encoded: 0, stubbed: 0, counts: {} },
	};

	for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
		const turn = turns[turnIndex];
		const sourceTags = extractSourceTags(turn.messages);
		for (const message of turn.messages) {
			if (message.role === "toolResult") {
				const toolMessage = message as ToolResultMessage;
				const isSelected = selected.has(message);
				if (isSelected) {
					const rawText = extractToolResultText(toolMessage.content);
					metadata.toolResultRawCharCount += rawText.length;
					if (rawText) originalParts.push(rawText);

					const projection = projectToolResult(toolMessage, {
						codecRegistry,
						readHistory,
						sourceTags,
						turn,
						turnIndex,
					});
					if (projection.text) {
						parts.push(projection.text);
						metadata.toolResultEffectiveCharCount += projection.text.length;
					}
					if (projection.codecName) {
						metadata.toolResults.encoded++;
						metadata.toolResults.counts[projection.codecName] =
							(metadata.toolResults.counts[projection.codecName] ?? 0) + 1;
					} else {
						metadata.toolResults.stubbed++;
					}
				}
				const { path: toolCallPath } = extractToolCallInfo(turn, toolMessage.toolCallId);
				updateReadHistory(readHistory, toolMessage, turnIndex, toolCallPath);
				continue;
			}

			if (!selected.has(message)) continue;
			if (message.role === "user") {
				const text = extractUserText(message.content);
				if (text) {
					parts.push(text);
					originalParts.push(text);
				}
			} else if (message.role === "assistant") {
				const text = extractAssistantText(message.content);
				if (text) {
					parts.push(text);
					originalParts.push(text);
				}
			}
		}
	}

	const text = parts.join("\n").trim();
	const originalText = originalParts.join("\n").trim();
	metadata.originalCharCount = originalText.length;
	metadata.effectiveCharCount = text.length;
	return { text: text.length > 0 ? text : null, metadata };
}

function selectHotWindowMessages(messages: AgentMessage[], windowTurns = 5): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let turnsCollected = 0;

	for (let i = messages.length - 1; i >= 0 && turnsCollected < windowTurns; i--) {
		const message = messages[i];
		if (!("role" in message) || typeof message.role !== "string") continue;
		if (message.role === "user") {
			selected.unshift(message);
			turnsCollected++;
		} else if (message.role === "assistant" || message.role === "toolResult") {
			selected.unshift(message);
		}
	}

	return selected;
}

function projectToolResult(
	message: ToolResultMessage,
	options: {
		codecRegistry: ContentCodec[];
		readHistory: Map<string, FileReadEntry>;
		sourceTags: string[];
		turn: Turn;
		turnIndex: number;
	},
): { text: string; codecName: string | null } {
	const { path: toolCallPath, args: toolCallArgs } = extractToolCallInfo(options.turn, message.toolCallId);
	const ctx: CodecContext = {
		sourceTags: options.sourceTags,
		toolName: message.toolName,
		toolCallPath,
		toolCallArgs,
		turnIndex: options.turnIndex,
		readHistory: options.readHistory,
	};

	for (const codec of options.codecRegistry) {
		if (!codec.matches(message, ctx)) continue;
		const encoded = codec.encode(message, ctx);
		const text = encoded ? extractTextFromBlocks(encoded) : "";
		if (text) return { text, codecName: codec.name };
	}

	return { text: formatStubText(options.sourceTags, null, message.toolName), codecName: null };
}

function extractTextFromBlocks(content: TextContent[]): string {
	return extractText({ role: "toolResult", content, toolCallId: "codec-projection" } as ToolResultMessage);
}
