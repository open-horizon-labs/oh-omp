/**
 * Canonical effective-prompt snapshot captured at composition time.
 *
 * Provides a single source of truth for what the model saw on a given turn,
 * created inside the real composition path (sdk.ts transformContext) after
 * message transformation, budget derivation, assembler packet creation,
 * and message bounding, immediately before the model call.
 *
 * Downstream observability surfaces can project compact views from this
 * canonical representation without reconstructing composition decisions.
 */

import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { TransformMetadata } from "./assembler";
import { estimateMessageTokens, estimateToolDefinitionTokens } from "./assembler";
import type { MemoryAssemblyBudget, WorkingContextPacketV1 } from "./memory-contract";

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot type
// ═══════════════════════════════════════════════════════════════════════════

/** System prompt composition data within a snapshot. */
export interface PromptSnapshotSystemPrompt {
	/**
	 * Stable fingerprint of the system prompt text.
	 * Uses xxHash64 for speed; suitable for change detection, not security.
	 */
	fingerprint: string;
	/** Estimated token count (chars/4 heuristic). */
	tokenEstimate: number;
}

/** Tool definitions data within a snapshot. */
export interface PromptSnapshotTools {
	/** Ordered list of tool names included in the request. */
	names: string[];
	/** Total estimated tokens for all tool definition schemas. */
	totalDefinitionTokenEstimate: number;
}

/** Message composition data within a snapshot. */
export interface PromptSnapshotMessages {
	/** The final post-transform, bounded message array sent to the model. */
	final: AgentMessage[];
	/** Estimated token count for the final message array. */
	tokenEstimate: number;
	/**
	 * Structured transform metadata from message-transform.ts (#25).
	 * Null when no message transform was applied (e.g., legacy mode).
	 */
	transformMetadata: TransformMetadata | null;
}

/** Assembler context within a snapshot (null when assembler is not active). */
export interface PromptSnapshotAssemblerContext {
	/** The assembled working-context packet from the kernel. */
	packet: WorkingContextPacketV1;
}

/** Budget/headroom breakdown within a snapshot. */
export interface PromptSnapshotBudget {
	/** Model context window in tokens. */
	contextWindow: number;
	/** Tokens consumed by the system prompt. */
	systemPromptTokens: number;
	/** Tokens consumed by tool definitions. */
	toolDefinitionTokens: number;
	/** Tokens consumed by messages (post-transform). */
	messageTokens: number;
	/** Tokens consumed by assembled context fragments. */
	assembledContextTokens: number;
	/** Remaining headroom in tokens. */
	headroom: number;
}

/**
 * Canonical runtime snapshot of the effective prompt composition for a turn.
 *
 * This is the authoritative record of what the model received: system prompt
 * fingerprint, tool definitions, final bounded messages, assembler context,
 * budget allocation, and structured transform metadata.
 */
export interface EffectivePromptSnapshot {
	/** Turn identifier (monotonic within a session). */
	turnId: string;
	/** ISO 8601 timestamp when the snapshot was captured. */
	capturedAt: string;
	/** Model used for this turn. */
	model: {
		provider: string;
		id: string;
		contextWindow: number;
	};
	/** System prompt composition data. */
	systemPrompt: PromptSnapshotSystemPrompt;
	/** Tool definitions data. */
	tools: PromptSnapshotTools;
	/** Message composition data. */
	messages: PromptSnapshotMessages;
	/** Assembler context (null when assembler is not active). */
	assemblerContext: PromptSnapshotAssemblerContext | null;
	/** Budget/headroom breakdown (null when budget derivation is unavailable). */
	budget: PromptSnapshotBudget | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Capture input
// ═══════════════════════════════════════════════════════════════════════════

/** Input required to capture an effective-prompt snapshot. */
export interface CaptureSnapshotInput {
	turnId: string;
	model: Model | undefined;
	systemPrompt: string;
	tools: AgentTool[];
	finalMessages: AgentMessage[];
	transformMetadata: TransformMetadata | null;
	assemblerPacket: WorkingContextPacketV1 | null;
	assemblerBudget: MemoryAssemblyBudget | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fingerprinting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a stable fingerprint of a string using xxHash64.
 * Not cryptographic — used for change detection only.
 */
export function fingerprintText(text: string): string {
	return Bun.hash.xxHash64(text).toString(36);
}

// ═══════════════════════════════════════════════════════════════════════════
// Capture function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Capture an effective-prompt snapshot from the actual runtime composition data.
 *
 * Called inside the transformContext closure in sdk.ts after all transformations
 * are complete and before the messages are returned to the agent loop for the
 * model call.
 */
export function captureEffectivePromptSnapshot(input: CaptureSnapshotInput): EffectivePromptSnapshot {
	const capturedAt = new Date().toISOString();
	const systemPromptTokens = estimateTokensFromLength(input.systemPrompt.length);
	const toolDefinitionTokens = estimateToolDefinitionTokens(input.tools);
	const messageTokens = estimateMessageTokens(input.finalMessages);
	const contextWindow = input.model?.contextWindow ?? 0;

	const assembledContextTokens = input.assemblerPacket?.usage.consumedTokens ?? 0;
	const headroom = Math.max(
		0,
		contextWindow - systemPromptTokens - toolDefinitionTokens - messageTokens - assembledContextTokens,
	);

	return {
		turnId: input.turnId,
		capturedAt,
		model: {
			provider: input.model?.provider ?? "unknown",
			id: input.model?.id ?? "unknown",
			contextWindow,
		},
		systemPrompt: {
			fingerprint: fingerprintText(input.systemPrompt),
			tokenEstimate: systemPromptTokens,
		},
		tools: {
			names: input.tools.map(t => t.name),
			totalDefinitionTokenEstimate: toolDefinitionTokens,
		},
		messages: {
			final: input.finalMessages,
			tokenEstimate: messageTokens,
			transformMetadata: input.transformMetadata,
		},
		assemblerContext: input.assemblerPacket ? { packet: input.assemblerPacket } : null,
		budget: input.model
			? {
					contextWindow,
					systemPromptTokens,
					toolDefinitionTokens,
					messageTokens,
					assembledContextTokens,
					headroom,
				}
			: null,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Estimate tokens from character length using the chars/4 heuristic. */
function estimateTokensFromLength(charCount: number): number {
	return Math.ceil(charCount / 4);
}
