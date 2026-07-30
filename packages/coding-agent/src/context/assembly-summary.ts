/**
 * Compact assembly summary for LLM in-context consumption.
 *
 * Derives a concise one-line dashboard from an EffectivePromptSnapshot so the
 * LLM can make informed decisions about its context window state: what was
 * kept, what was stubbed/dropped, and how much headroom remains.
 *
 * Injected as a developer message immediately before the latest literal user —
 * not as user content — so it functions as system-level metadata without
 * displacing the user's current request as the final actionable instruction.
 */

import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TurnDecision } from "./assembler/message-transform";
import type { EffectivePromptSnapshot } from "./effective-prompt-snapshot";

/**
 * Format a compact assembly summary from a prompt snapshot.
 *
 * Returns null when there is no meaningful assembly metadata to surface
 * (no transform metadata and no budget data).
 *
 * Format (representative):
 * ```
 * [Assembly: 45 turns, 8 kept, 12 stubbed (turns 3-14), 25 dropped | Budget: 182K/200K tokens, 18K headroom]
 * ```
 */
export function formatAssemblySummary(snapshot: EffectivePromptSnapshot): string | null {
	const meta = snapshot.messages.transformMetadata;
	const budget = snapshot.budget;

	// Nothing to surface without at least one of these.
	if (!meta && !budget) return null;

	const parts: string[] = [];

	// Turn composition segment.
	if (meta) {
		const turnParts: string[] = [`${meta.totalTurns} turns`];
		if (meta.keptCount > 0) {
			if (meta.scoredCount > 0 && meta.similarityRange) {
				const min = meta.similarityRange.min.toFixed(2);
				const max = meta.similarityRange.max.toFixed(2);
				turnParts.push(`${meta.keptCount} kept (${meta.scoredCount} scored, sim ${min}-${max})`);
			} else {
				turnParts.push(`${meta.keptCount} kept`);
			}
		}
		const pinnedCount = meta.decisions.filter(d => d.reason === "working-set").length;
		if (pinnedCount > 0) {
			turnParts.push(`${pinnedCount} pinned (working set)`);
		}
		if (meta.stubbedCount > 0) {
			const range = describeStubbedRange(meta.decisions);
			turnParts.push(range ? `${meta.stubbedCount} stubbed (${range})` : `${meta.stubbedCount} stubbed`);
		}
		if (meta.compressedCount > 0) {
			const conversationCompressed = meta.decisions.filter(d => d.reason === "conversation-compressed").length;
			const recoveryTruncated = meta.decisions.filter(d => d.reason === "recovery-anchor-truncated").length;
			const overflowSummarized = meta.decisions.filter(d => d.reason === "overflow-summarized").length;
			const hotWindowOversizeCompressed = meta.decisions.filter(
				d => d.reason === "hot-window-oversize-compressed",
			).length;
			const codecCompressed =
				meta.compressedCount -
				conversationCompressed -
				recoveryTruncated -
				overflowSummarized -
				hotWindowOversizeCompressed;
			const compParts: string[] = [];
			if (codecCompressed > 0) compParts.push(`${codecCompressed} codec-compressed`);
			if (conversationCompressed > 0)
				compParts.push(`${conversationCompressed} conversation-compressed (recoverable via recall)`);
			if (recoveryTruncated > 0) compParts.push(`${recoveryTruncated} recovery-anchor-truncated`);
			if (overflowSummarized > 0) compParts.push(`${overflowSummarized} overflow-summarized`);
			if (hotWindowOversizeCompressed > 0)
				compParts.push(`${hotWindowOversizeCompressed} oversized hot-window compressed`);
			turnParts.push(compParts.length > 0 ? compParts.join(", ") : `${meta.compressedCount} compressed`);
		}
		if (meta.droppedCount > 0) {
			const devDropped = meta.decisions.filter(d => d.reason === "developer-dropped").length;
			const recoveryExcluded = meta.decisions.filter(d => d.reason === "recovery-excluded").length;
			const overflowPreAnchor = meta.decisions.filter(d => d.reason === "overflow-pre-anchor").length;
			const budgetDropped = meta.droppedCount - devDropped - recoveryExcluded - overflowPreAnchor;
			const dropParts: string[] = [];
			if (budgetDropped > 0) dropParts.push(`${budgetDropped} budget-dropped`);
			if (devDropped > 0) dropParts.push(`${devDropped} dev-dropped`);
			if (recoveryExcluded > 0) dropParts.push(`${recoveryExcluded} recovery-excluded`);
			if (overflowPreAnchor > 0) dropParts.push(`${overflowPreAnchor} pre-anchor-dropped`);
			turnParts.push(dropParts.length > 0 ? dropParts.join(", ") : `${meta.droppedCount} dropped`);
		}
		if (meta.recovery) {
			if (meta.recovery.outcome === "unrecoverable") {
				turnParts.push(`recovery: unrecoverable (${meta.recovery.unrecoverableAnchorReason ?? "unknown"})`);
			} else if (meta.recovery.anchorTruncated) {
				turnParts.push("recovery: recovered with truncated anchor and truncation nudge");
			} else if (meta.recovery.controlPrompt === "omitted") {
				turnParts.push("recovery: recovered full anchor, nudge omitted");
			} else {
				turnParts.push("recovery: recovered with reground nudge");
			}
		}
		if (meta.overflowSummary) {
			const overflow = meta.overflowSummary;
			if (overflow.outcome === "failed") {
				turnParts.push(`overflow summary: failed (${overflow.failureReason ?? "unknown"})`);
			} else {
				turnParts.push(
					`overflow summary: ${overflow.outcome} generation ${overflow.generation}, ${overflow.tailTurnCount} tail turns`,
				);
			}
		}
		parts.push(turnParts.join(", "));
	}

	// Budget segment.
	if (budget && budget.contextWindow > 0) {
		const used = budget.contextWindow - budget.headroom;
		parts.push(
			`Budget: ${formatNumber(used)}/${formatNumber(budget.contextWindow)} tokens, ${formatNumber(budget.headroom)} headroom`,
		);
	}

	if (parts.length === 0) return null;

	return `[Assembly: ${parts.join(" | ")}]`;
}

/**
 * Describe the turn range affected by stubbing as a compact string.
 *
 * Returns e.g. "turns 3-14", "turn 5", or null if no turns were stubbed.
 */
function describeStubbedRange(decisions: TurnDecision[]): string | null {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	for (const d of decisions) {
		if (d.action !== "stubbed") continue;
		if (d.turnIndex < min) min = d.turnIndex;
		if (d.turnIndex > max) max = d.turnIndex;
	}

	if (min === Number.POSITIVE_INFINITY) return null;
	if (min === max) return `turn ${min}`;
	return `turns ${min}-${max}`;
}
