/**
 * Query-oriented inspection of effective-prompt snapshots.
 *
 * Projects compact overviews, section-level detail, and decision reports
 * from the canonical EffectivePromptSnapshot captured per turn (issue #26).
 *
 * All functions are pure projections — no side effects, no mutation.
 */

import type { EffectivePromptSnapshot } from "../../context/effective-prompt-snapshot";
import type {
	RpcPromptDecisionFilter,
	RpcPromptDecisionReport,
	RpcPromptSectionDetail,
	RpcPromptSnapshotOverview,
	RpcPromptSnapshotSectionName,
} from "./rpc-types";

// ============================================================================
// Overview
// ============================================================================

/**
 * Build a compact overview of the prompt composition snapshot.
 *
 * Returns token estimates, section availability indicators, and model info
 * without any raw content (messages, packet payloads, etc.).
 */
export function buildPromptSnapshotOverview(snapshot: EffectivePromptSnapshot | null): RpcPromptSnapshotOverview {
	if (!snapshot) {
		return {
			available: false,
			turnId: null,
			capturedAt: null,
			model: null,
			sections: {
				systemPrompt: null,
				tools: null,
				messages: null,
				assemblerContext: null,
				budget: null,
			},
		};
	}

	return {
		available: true,
		turnId: snapshot.turnId,
		capturedAt: snapshot.capturedAt,
		model: snapshot.model,
		sections: {
			systemPrompt: {
				fingerprint: snapshot.systemPrompt.fingerprint,
				tokenEstimate: snapshot.systemPrompt.tokenEstimate,
			},
			tools: {
				count: snapshot.tools.names.length,
				totalDefinitionTokenEstimate: snapshot.tools.totalDefinitionTokenEstimate,
			},
			messages: {
				count: snapshot.messages.final.length,
				tokenEstimate: snapshot.messages.tokenEstimate,
				hasTransformMetadata: snapshot.messages.transformMetadata !== null,
			},
			assemblerContext: snapshot.assemblerContext
				? {
						fragmentCount: snapshot.assemblerContext.packet.fragments.length,
						droppedCount: snapshot.assemblerContext.packet.dropped.length,
						consumedTokens: snapshot.assemblerContext.packet.usage.consumedTokens,
					}
				: null,
			budget: snapshot.budget
				? {
						contextWindow: snapshot.budget.contextWindow,
						headroom: snapshot.budget.headroom,
					}
				: null,
		},
	};
}

// ============================================================================
// Section detail
// ============================================================================

/**
 * Extract full detail for a specific prompt section.
 *
 * Returns the complete data for the requested section, intended for
 * targeted drill-down rather than bulk inspection.
 *
 * Returns null when the snapshot is unavailable or the requested section
 * has no data (e.g., assembler_context when assembler is inactive).
 */
export function buildPromptSectionDetail(
	snapshot: EffectivePromptSnapshot | null,
	section: RpcPromptSnapshotSectionName,
): RpcPromptSectionDetail | null {
	if (!snapshot) return null;

	switch (section) {
		case "system_prompt":
			return {
				section: "system_prompt",
				fingerprint: snapshot.systemPrompt.fingerprint,
				tokenEstimate: snapshot.systemPrompt.tokenEstimate,
			};

		case "tools":
			return {
				section: "tools",
				names: snapshot.tools.names,
				totalDefinitionTokenEstimate: snapshot.tools.totalDefinitionTokenEstimate,
			};

		case "messages":
			return {
				section: "messages",
				messages: snapshot.messages.final,
				tokenEstimate: snapshot.messages.tokenEstimate,
				transformMetadata: snapshot.messages.transformMetadata,
			};

		case "assembler_context":
			if (!snapshot.assemblerContext) return null;
			return {
				section: "assembler_context",
				packet: snapshot.assemblerContext.packet,
			};

		case "budget":
			if (!snapshot.budget) return null;
			return {
				section: "budget",
				budget: snapshot.budget,
			};

		case "transform_metadata":
			if (!snapshot.messages.transformMetadata) return null;
			return {
				section: "transform_metadata",
				metadata: snapshot.messages.transformMetadata,
			};
	}
}

// ============================================================================
// Decision report
// ============================================================================

/**
 * Build a report on turn-level composition decisions.
 *
 * Extracts structured decision records from the transform metadata,
 * optionally filtered by action or turn index.
 *
 * Returns an unavailable report when no snapshot or no transform metadata
 * exists (e.g., in legacy/non-assembler mode).
 */
export function buildPromptDecisionReport(
	snapshot: EffectivePromptSnapshot | null,
	filter?: RpcPromptDecisionFilter,
): RpcPromptDecisionReport {
	const unavailable: RpcPromptDecisionReport = {
		available: false,
		summary: null,
		decisions: [],
	};

	if (!snapshot) return unavailable;

	const metadata = snapshot.messages.transformMetadata;
	if (!metadata) return unavailable;

	let decisions = metadata.decisions.map(d => ({
		turnIndex: d.turnIndex,
		action: d.action,
		reason: d.reason,
		messageCount: d.messageCount,
		hasToolResults: d.hasToolResults,
		tokensBefore: d.tokensBefore,
		tokensAfter: d.tokensAfter,
	}));

	if (filter?.action) {
		decisions = decisions.filter(d => d.action === filter.action);
	}
	if (filter?.turnIndex !== undefined) {
		decisions = decisions.filter(d => d.turnIndex === filter.turnIndex);
	}

	return {
		available: true,
		summary: {
			totalTurns: metadata.totalTurns,
			keptCount: metadata.keptCount,
			stubbedCount: metadata.stubbedCount,
			droppedCount: metadata.droppedCount,
			tokensBefore: metadata.tokensBefore,
			tokensAfter: metadata.tokensAfter,
		},
		decisions,
	};
}
