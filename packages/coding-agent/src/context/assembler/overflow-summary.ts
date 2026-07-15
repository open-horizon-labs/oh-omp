import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Effort, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { renderPromptTemplate } from "../../config/prompt-templates";
import overflowSummaryPrompt from "../../prompts/system/context-overflow-summary.md" with { type: "text" };
import overflowSummaryContextPrompt from "../../prompts/system/context-overflow-summary-context.md" with {
	type: "text",
};
import overflowSummarySystemPrompt from "../../prompts/system/context-overflow-summary-system.md" with { type: "text" };
import { serializeConversation } from "../../session/compaction/utils";
import { convertToLlm } from "../../session/messages";
import {
	estimateMessageTokens,
	extractSourceTags,
	segmentIntoTurns,
	type TransformMetadata,
	type TransformOverflowSummaryMetadata,
	type Turn,
	type TurnDecision,
} from "./message-transform";

const LOW_WATERMARK_RATIO = 0.5;
const MAX_SUMMARY_OUTPUT_TOKENS = 8_192;
const MIN_SUMMARY_OUTPUT_TOKENS = 256;

export interface OverflowSummaryModelCandidate {
	model: Model<Api>;
	apiKey: string;
	reasoning?: Effort;
}

export interface OverflowSummaryCheckpoint {
	anchorId: string;
	summarizedThroughId: string;
	summary: string;
	summaryMessage: AgentMessage;
	sourceTurnCount: number;
	generation: number;
	model: string;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
}

export type OverflowSummaryFailureReason =
	| "no-summarizable-history"
	| "protected-hot-window-exceeds-budget"
	| "no-authenticated-model"
	| "model-context-too-small"
	| "generation-failed"
	| "empty-summary"
	| "summary-exceeds-budget"
	| "retry-deferred-no-progress";

export interface OverflowSummaryFailure {
	anchorId?: string;
	reason: OverflowSummaryFailureReason;
	attempts: number;
	lowWatermarkTokens: number;
	newlySummarizedTurnCount: number;
	tailTurnCount: number;
	hotWindowCompressedCount: number;
}

export interface OverflowSummaryAssembly {
	messages: AgentMessage[];
	metadata: TransformMetadata;
	checkpoint: OverflowSummaryCheckpoint;
}

export interface AssembleOverflowSummaryInput {
	sourceMessages: AgentMessage[];
	transformedMessages: AgentMessage[];
	compressedHotWindowMessages?: AgentMessage[];
	unboundedMetadata: TransformMetadata;
	maxTokens: number;
	hotWindowTurns: number;
	checkpoint?: OverflowSummaryCheckpoint;
	resolveModelCandidates: () => Promise<OverflowSummaryModelCandidate[]>;
	signal?: AbortSignal;
}

export type AssembleOverflowSummaryResult =
	| { outcome: "assembled"; assembly: OverflowSummaryAssembly }
	| { outcome: "failed"; failure: OverflowSummaryFailure; fallbackMessages?: AgentMessage[] };

interface OverflowSummaryPlan {
	anchorId: string;
	anchorTurn: Turn;
	historyTurns: Turn[];
	tailTurns: Turn[];
	summarizedTurnIds: Set<string>;
	tailTurnIds: Set<string>;
	previousSummary?: string;
	sourceTurnCount: number;
	generation: number;
	lowWatermarkTokens: number;
	maxSummaryOutputTokens: number;
	hotWindowCompressedTurnIds: Set<string>;
}

interface GeneratedSummary {
	summary: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	attempts: number;
}

function getTurnId(turn: Turn): string {
	const parts = turn.messages.map(message => {
		const timestamp = "timestamp" in message ? message.timestamp : 0;
		if (message.role === "assistant") {
			const toolCallIds = message.content
				.filter(block => block.type === "toolCall")
				.map(block => block.id)
				.join(",");
			return `${message.role}:${timestamp}:${toolCallIds}`;
		}
		if (message.role === "toolResult") {
			return `${message.role}:${timestamp}:${message.toolCallId}`;
		}
		return `${message.role}:${timestamp}`;
	});
	return parts.join("|");
}

function flattenTurns(turns: Turn[]): AgentMessage[] {
	return turns.flatMap(turn => turn.messages);
}

function summaryOutputReserve(maxTokens: number): number {
	return Math.min(MAX_SUMMARY_OUTPUT_TOKENS, Math.max(MIN_SUMMARY_OUTPUT_TOKENS, Math.floor(maxTokens * 0.1)));
}

function findLatestUserTurn(turns: Turn[]): number {
	for (let index = turns.length - 1; index >= 0; index--) {
		if (turns[index].messages[0]?.role === "user") return index;
	}
	return -1;
}

export function getOverflowSummaryAnchorId(messages: AgentMessage[]): string | undefined {
	const turns = segmentIntoTurns(messages);
	const latestUserTurn = findLatestUserTurn(turns);
	return latestUserTurn >= 0 ? getTurnId(turns[latestUserTurn]) : undefined;
}

function preparePlan(
	transformedMessages: AgentMessage[],
	maxTokens: number,
	hotWindowTurns: number,
	checkpoint: OverflowSummaryCheckpoint | undefined,
	hotWindowCompressedTurnIds: Set<string>,
): OverflowSummaryPlan | OverflowSummaryFailure {
	const turns = segmentIntoTurns(transformedMessages);
	const latestUserTurn = findLatestUserTurn(turns);
	const lowWatermarkTokens = Math.max(1, Math.floor(maxTokens * LOW_WATERMARK_RATIO));
	if (latestUserTurn < 0) {
		return {
			reason: "no-summarizable-history",
			attempts: 0,
			lowWatermarkTokens,
			newlySummarizedTurnCount: 0,
			tailTurnCount: 0,
			hotWindowCompressedCount: hotWindowCompressedTurnIds.size,
		};
	}

	const anchorTurn = turns[latestUserTurn];
	const anchorId = getTurnId(anchorTurn);
	let historyStart = latestUserTurn + 1;
	let previousSummary: string | undefined;
	let sourceTurnCount = 0;
	let generation = 1;

	if (checkpoint?.anchorId === anchorId) {
		const summarizedThrough = turns.findIndex(
			(turn, index) => index > latestUserTurn && getTurnId(turn) === checkpoint.summarizedThroughId,
		);
		if (summarizedThrough >= 0) {
			const retainedTail = turns.slice(summarizedThrough + 1);
			const cachedMessages = [anchorTurn.messages[0], checkpoint.summaryMessage, ...flattenTurns(retainedTail)];
			if (estimateMessageTokens(cachedMessages) <= maxTokens) {
				return {
					anchorId,
					anchorTurn,
					historyTurns: [],
					tailTurns: retainedTail,
					summarizedTurnIds: new Set(turns.slice(latestUserTurn + 1, summarizedThrough + 1).map(getTurnId)),
					tailTurnIds: new Set(retainedTail.map(getTurnId)),
					previousSummary: checkpoint.summary,
					sourceTurnCount: checkpoint.sourceTurnCount,
					generation: checkpoint.generation,
					lowWatermarkTokens,
					maxSummaryOutputTokens: 0,
					hotWindowCompressedTurnIds,
				};
			}
			historyStart = summarizedThrough + 1;
			previousSummary = checkpoint.summary;
			sourceTurnCount = checkpoint.sourceTurnCount;
			generation = checkpoint.generation + 1;
		}
	}

	const protectedTailTurns = Math.max(1, Math.floor(hotWindowTurns));
	const protectedTailStart = Math.max(historyStart, turns.length - protectedTailTurns);
	const lastSummarizableTurn = protectedTailStart - 1;
	if (historyStart > lastSummarizableTurn) {
		const fixedMessages = [
			anchorTurn.messages[0],
			...(previousSummary && checkpoint ? [checkpoint.summaryMessage] : []),
			...flattenTurns(turns.slice(historyStart)),
		];
		return {
			anchorId,
			reason:
				estimateMessageTokens(fixedMessages) > maxTokens
					? "protected-hot-window-exceeds-budget"
					: "no-summarizable-history",
			attempts: 0,
			lowWatermarkTokens,
			newlySummarizedTurnCount: 0,
			tailTurnCount: Math.max(0, turns.length - historyStart),
			hotWindowCompressedCount: hotWindowCompressedTurnIds.size,
		};
	}

	const maxSummaryOutputTokens = summaryOutputReserve(maxTokens);
	let historyEnd = -1;
	for (let candidate = historyStart; candidate <= lastSummarizableTurn; candidate++) {
		const retainedTail = turns.slice(candidate + 1);
		const projectedTokens = estimateMessageTokens([
			anchorTurn.messages[0],
			{ role: "developer", content: "x".repeat(maxSummaryOutputTokens * 3.2) },
			...flattenTurns(retainedTail),
		]);
		if (projectedTokens <= lowWatermarkTokens) {
			historyEnd = candidate;
			break;
		}
	}

	if (historyEnd < historyStart) {
		const retainedTail = turns.slice(lastSummarizableTurn + 1);
		const lowestReachableTokens = estimateMessageTokens([
			anchorTurn.messages[0],
			{ role: "developer", content: "x".repeat(maxSummaryOutputTokens * 3.2) },
			...flattenTurns(retainedTail),
		]);
		if (lowestReachableTokens <= maxTokens) {
			historyEnd = lastSummarizableTurn;
		} else {
			return {
				anchorId,
				reason: "protected-hot-window-exceeds-budget",
				attempts: 0,
				lowWatermarkTokens,
				newlySummarizedTurnCount: 0,
				tailTurnCount: retainedTail.length,
				hotWindowCompressedCount: hotWindowCompressedTurnIds.size,
			};
		}
	}

	const historyTurns = turns.slice(historyStart, historyEnd + 1);
	const tailTurns = turns.slice(historyEnd + 1);
	return {
		anchorId,
		anchorTurn,
		historyTurns,
		tailTurns,
		summarizedTurnIds: new Set(turns.slice(latestUserTurn + 1, historyEnd + 1).map(getTurnId)),
		tailTurnIds: new Set(tailTurns.map(getTurnId)),
		previousSummary,
		sourceTurnCount: sourceTurnCount + historyTurns.length,
		generation,
		lowWatermarkTokens,
		maxSummaryOutputTokens,
		hotWindowCompressedTurnIds,
	};
}

function buildSummaryPrompt(plan: OverflowSummaryPlan): string {
	return renderPromptTemplate(overflowSummaryPrompt, {
		userAnchor: serializeConversation(convertToLlm(plan.anchorTurn.messages)),
		previousSummary: plan.previousSummary,
		conversation: serializeConversation(convertToLlm(flattenTurns(plan.historyTurns))),
	});
}

async function generateSummary(
	plan: OverflowSummaryPlan,
	candidates: OverflowSummaryModelCandidate[],
	signal: AbortSignal | undefined,
): Promise<GeneratedSummary | OverflowSummaryFailure> {
	const prompt = buildSummaryPrompt(plan);
	const requestMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		},
	];
	const inputTokens = estimateMessageTokens([
		{ role: "developer", content: overflowSummarySystemPrompt },
		...requestMessages,
	]);
	let attempts = 0;
	let hadContextCandidate = false;
	let sawEmptySummary = false;

	for (const candidate of candidates) {
		const maxOutputTokens = Math.min(plan.maxSummaryOutputTokens, candidate.model.maxTokens);
		if (inputTokens + maxOutputTokens > candidate.model.contextWindow) continue;
		hadContextCandidate = true;
		if (signal?.aborted) break;
		const startedAt = performance.now();
		try {
			attempts++;
			const response = await ai.completeSimple(
				candidate.model,
				{ systemPrompt: overflowSummarySystemPrompt, messages: requestMessages },
				{ apiKey: candidate.apiKey, maxTokens: maxOutputTokens, reasoning: candidate.reasoning, signal },
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") continue;
			const summary = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("\n")
				.trim();
			if (!summary) {
				sawEmptySummary = true;
				continue;
			}
			return {
				summary,
				model: `${candidate.model.provider}/${candidate.model.id}`,
				inputTokens: response.usage.input,
				outputTokens: response.usage.output,
				durationMs: performance.now() - startedAt,
				attempts,
			};
		} catch {
			if (signal?.aborted) break;
		}
	}

	return {
		anchorId: plan.anchorId,
		reason:
			candidates.length === 0
				? "no-authenticated-model"
				: !hadContextCandidate
					? "model-context-too-small"
					: sawEmptySummary
						? "empty-summary"
						: "generation-failed",
		attempts,
		lowWatermarkTokens: plan.lowWatermarkTokens,
		newlySummarizedTurnCount: plan.historyTurns.length,
		tailTurnCount: plan.tailTurns.length,
		hotWindowCompressedCount: plan.hotWindowCompressedTurnIds.size,
	};
}

function buildMetadata(
	sourceMessages: AgentMessage[],
	unboundedMetadata: TransformMetadata,
	plan: OverflowSummaryPlan,
	summaryMessage: AgentMessage,
	summary: GeneratedSummary,
	outcome: "generated" | "reused",
	outputMessages: AgentMessage[],
): TransformMetadata {
	const sourceTurns = segmentIntoTurns(sourceMessages);
	const anchorIndex = sourceTurns.findIndex(turn => getTurnId(turn) === plan.anchorId);
	const summaryTokens = estimateMessageTokens([summaryMessage]);
	let assignedSummaryTokens = false;
	const decisions = sourceTurns.map((turn, turnIndex): TurnDecision => {
		const id = getTurnId(turn);
		const original = unboundedMetadata.decisions[turnIndex];
		if (turnIndex < anchorIndex) {
			return {
				...original,
				turnIndex,
				action: "dropped",
				reason: "overflow-pre-anchor",
				tokensAfter: 0,
			};
		}
		if (plan.hotWindowCompressedTurnIds.has(id)) {
			const compressedTurn = plan.tailTurns.find(tailTurn => getTurnId(tailTurn) === id);
			return {
				...original,
				action: "compressed",
				reason: "hot-window-oversize-compressed",
				tokensAfter: compressedTurn ? estimateMessageTokens(compressedTurn.messages) : original.tokensAfter,
			};
		}
		if (id === plan.anchorId || plan.tailTurnIds.has(id)) {
			return original;
		}
		if (plan.summarizedTurnIds.has(id)) {
			const tokensAfter = assignedSummaryTokens ? 0 : summaryTokens;
			assignedSummaryTokens = true;
			return {
				turnIndex,
				action: "compressed",
				reason: "overflow-summarized",
				messageCount: turn.messages.length,
				hasToolResults: turn.hasToolResults,
				tokensBefore: original.tokensBefore,
				tokensAfter,
				sourceTags: extractSourceTags(turn.messages),
			};
		}
		return {
			...original,
			turnIndex,
			action: "dropped",
			reason: original.reason === "developer-dropped" ? "developer-dropped" : "overflow-pre-anchor",
			tokensAfter: 0,
		};
	});
	const overflowSummary: TransformOverflowSummaryMetadata = {
		trigger: "latest-user-boundary",
		outcome,
		generation: plan.generation,
		model: summary.model,
		sourceTurnCount: plan.sourceTurnCount,
		newlySummarizedTurnCount: outcome === "generated" ? plan.historyTurns.length : 0,
		tailTurnCount: plan.tailTurns.length,
		outputMessageCount: outputMessages.length,
		outputTokens: estimateMessageTokens(outputMessages),
		summaryTokens,
		inputTokens: summary.inputTokens,
		durationMs: summary.durationMs,
		attempts: summary.attempts,
		lowWatermarkTokens: plan.lowWatermarkTokens,
		hotWindowCompressedCount: plan.hotWindowCompressedTurnIds.size,
	};

	return {
		...unboundedMetadata,
		decisions,
		keptCount: decisions.filter(decision => decision.action === "kept").length,
		stubbedCount: decisions.filter(decision => decision.action === "stubbed").length,
		compressedCount: decisions.filter(decision => decision.action === "compressed").length,
		droppedCount: decisions.filter(decision => decision.action === "dropped").length,
		tokensAfter: overflowSummary.outputTokens,
		scoredCount: 0,
		similarityRange: undefined,
		recovery: undefined,
		overflowSummary,
	};
}

export function buildOverflowSummaryFailureMetadata(failure: OverflowSummaryFailure): TransformOverflowSummaryMetadata {
	return {
		trigger: "latest-user-boundary",
		outcome: "failed",
		generation: 0,
		sourceTurnCount: 0,
		newlySummarizedTurnCount: failure.newlySummarizedTurnCount,
		tailTurnCount: failure.tailTurnCount,
		outputMessageCount: 0,
		outputTokens: 0,
		summaryTokens: 0,
		inputTokens: 0,
		durationMs: 0,
		attempts: failure.attempts,
		lowWatermarkTokens: failure.lowWatermarkTokens,
		hotWindowCompressedCount: failure.hotWindowCompressedCount,
		failureReason: failure.reason,
	};
}

export async function assembleOverflowSummary(
	input: AssembleOverflowSummaryInput,
): Promise<AssembleOverflowSummaryResult> {
	let workingMessages = input.transformedMessages;
	const compressedTurnIds = new Set<string>();
	let prepared = preparePlan(
		workingMessages,
		input.maxTokens,
		input.hotWindowTurns,
		input.checkpoint,
		compressedTurnIds,
	);
	if (
		"reason" in prepared &&
		prepared.reason === "protected-hot-window-exceeds-budget" &&
		input.compressedHotWindowMessages
	) {
		const turns = segmentIntoTurns(workingMessages);
		const compressedById = new Map(
			segmentIntoTurns(input.compressedHotWindowMessages).map(turn => [getTurnId(turn), turn]),
		);
		const latestUserTurn = findLatestUserTurn(turns);
		const protectedTailStart = Math.max(latestUserTurn + 1, turns.length - Math.max(1, input.hotWindowTurns));
		const candidates = turns
			.map((turn, index) => {
				const compressed = compressedById.get(getTurnId(turn));
				return {
					index,
					turn,
					compressed,
					savings: compressed
						? estimateMessageTokens(turn.messages) - estimateMessageTokens(compressed.messages)
						: 0,
				};
			})
			.filter(candidate => candidate.index >= protectedTailStart && candidate.compressed && candidate.savings > 0)
			.sort((a, b) => b.savings - a.savings);

		for (const candidate of candidates) {
			turns[candidate.index] = candidate.compressed!;
			compressedTurnIds.add(getTurnId(candidate.turn));
			workingMessages = flattenTurns(turns);
			prepared = preparePlan(
				workingMessages,
				input.maxTokens,
				input.hotWindowTurns,
				input.checkpoint,
				compressedTurnIds,
			);
			if (!("reason" in prepared) || prepared.reason !== "protected-hot-window-exceeds-budget") break;
		}
	}
	if ("reason" in prepared) {
		return {
			outcome: "failed",
			failure: prepared,
			fallbackMessages: compressedTurnIds.size > 0 ? workingMessages : undefined,
		};
	}

	if (prepared.historyTurns.length === 0 && input.checkpoint) {
		const messages = [
			prepared.anchorTurn.messages[0],
			input.checkpoint.summaryMessage,
			...flattenTurns(prepared.tailTurns),
		];
		const cachedSummary: GeneratedSummary = {
			summary: input.checkpoint.summary,
			model: input.checkpoint.model,
			inputTokens: input.checkpoint.inputTokens,
			outputTokens: input.checkpoint.outputTokens,
			durationMs: input.checkpoint.durationMs,
			attempts: 0,
		};
		return {
			outcome: "assembled",
			assembly: {
				messages,
				metadata: buildMetadata(
					input.sourceMessages,
					input.unboundedMetadata,
					prepared,
					input.checkpoint.summaryMessage,
					cachedSummary,
					"reused",
					messages,
				),
				checkpoint: input.checkpoint,
			},
		};
	}

	const generated = await generateSummary(prepared, await input.resolveModelCandidates(), input.signal);
	if ("reason" in generated) {
		return {
			outcome: "failed",
			failure: generated,
			fallbackMessages: compressedTurnIds.size > 0 ? workingMessages : undefined,
		};
	}

	const summaryMessage = {
		role: "developer" as const,
		content: renderPromptTemplate(overflowSummaryContextPrompt, { summary: generated.summary }),
		attribution: "agent" as const,
		timestamp: Date.now(),
	} satisfies AgentMessage;
	const messages = [prepared.anchorTurn.messages[0], summaryMessage, ...flattenTurns(prepared.tailTurns)];
	if (estimateMessageTokens(messages) > input.maxTokens) {
		return {
			outcome: "failed",
			failure: {
				anchorId: prepared.anchorId,
				reason: "summary-exceeds-budget",
				attempts: generated.attempts,
				lowWatermarkTokens: prepared.lowWatermarkTokens,
				newlySummarizedTurnCount: prepared.historyTurns.length,
				tailTurnCount: prepared.tailTurns.length,
				hotWindowCompressedCount: prepared.hotWindowCompressedTurnIds.size,
			},
			fallbackMessages: compressedTurnIds.size > 0 ? workingMessages : undefined,
		};
	}

	const checkpoint: OverflowSummaryCheckpoint = {
		anchorId: prepared.anchorId,
		summarizedThroughId: getTurnId(prepared.historyTurns.at(-1)!),
		summary: generated.summary,
		summaryMessage,
		sourceTurnCount: prepared.sourceTurnCount,
		generation: prepared.generation,
		model: generated.model,
		inputTokens: generated.inputTokens,
		outputTokens: generated.outputTokens,
		durationMs: generated.durationMs,
	};
	return {
		outcome: "assembled",
		assembly: {
			messages,
			metadata: buildMetadata(
				input.sourceMessages,
				input.unboundedMetadata,
				prepared,
				summaryMessage,
				generated,
				"generated",
				messages,
			),
			checkpoint,
		},
	};
}
