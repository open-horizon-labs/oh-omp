/**
 * Projection utilities for the Prompt Composition Inspector.
 *
 * Transforms an EffectivePromptSnapshot into navigable InspectorSections
 * with compact summaries and on-demand detail rendering.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TurnDecision } from "../../../context/assembler/message-transform";
import type { EffectivePromptSnapshot } from "../../../context/effective-prompt-snapshot";
import { theme } from "../../theme/theme";
import type { ContentStatus, InspectorSection } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Token formatting
// ═══════════════════════════════════════════════════════════════════════════

/** Format a token count with "tok" suffix. */
export function formatTokens(count: number): string {
	return `${formatNumber(count)} tok`;
}

/** Format a percentage with one decimal. */
function formatPercent(value: number, total: number): string {
	if (total === 0) return "0%";
	return `${((value / total) * 100).toFixed(1)}%`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Status badge rendering
// ═══════════════════════════════════════════════════════════════════════════

/** Render a colored status badge. */
export function renderStatusBadge(status: ContentStatus): string {
	switch (status) {
		case "included":
			return theme.fg("success", "included");
		case "stubbed":
			return theme.fg("warning", "stubbed");
		case "dropped":
			return theme.fg("error", "dropped");
	}
}

/** Render compact status counts (e.g., "12 included, 3 stubbed, 2 dropped"). */
export function renderStatusCounts(counts: { included: number; stubbed: number; dropped: number }): string {
	const parts: string[] = [];
	if (counts.included > 0) parts.push(theme.fg("success", `${counts.included} included`));
	if (counts.stubbed > 0) parts.push(theme.fg("warning", `${counts.stubbed} stubbed`));
	if (counts.dropped > 0) parts.push(theme.fg("error", `${counts.dropped} dropped`));
	return parts.join(theme.fg("dim", ", "));
}

// ═══════════════════════════════════════════════════════════════════════════
// Bar chart rendering
// ═══════════════════════════════════════════════════════════════════════════

interface BarSegment {
	label: string;
	value: number;
	color: string;
}

/** Render a horizontal budget bar chart within the given width. */
export function renderBudgetBar(segments: BarSegment[], total: number, width: number): string[] {
	if (total === 0) return [theme.fg("dim", "(no budget data)")];

	const barWidth = Math.max(10, Math.min(width - 4, 60));
	const lines: string[] = [];

	// Build the bar
	let bar = "";
	for (const seg of segments) {
		const segWidth = Math.max(0, Math.round((seg.value / total) * barWidth));
		bar += theme.fg(seg.color as never, "\u2588".repeat(segWidth));
	}
	// Fill remaining with dim block
	const usedWidth = segments.reduce((sum, s) => sum + Math.max(0, Math.round((s.value / total) * barWidth)), 0);
	if (usedWidth < barWidth) {
		bar += theme.fg("dim", "\u2591".repeat(barWidth - usedWidth));
	}

	lines.push(`  ${bar}`);

	// Legend
	for (const seg of segments) {
		if (seg.value === 0) continue;
		const pct = formatPercent(seg.value, total);
		const badge = theme.fg(seg.color as never, "\u2588");
		lines.push(`  ${badge} ${seg.label}: ${formatTokens(seg.value)} (${pct})`);
	}

	return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section projectors
// ═══════════════════════════════════════════════════════════════════════════

function projectBudgetSection(snapshot: EffectivePromptSnapshot): InspectorSection {
	const budget = snapshot.budget;
	const model = snapshot.model;

	const summaryParts: string[] = [];
	if (budget) {
		const used = budget.contextWindow - budget.headroom;
		summaryParts.push(`${formatTokens(used)}/${formatTokens(budget.contextWindow)}`);
		summaryParts.push(`${formatPercent(used, budget.contextWindow)} used`);
		summaryParts.push(`${formatTokens(budget.headroom)} free`);
	} else {
		summaryParts.push("No budget data");
	}

	return {
		kind: "budget",
		label: "Budget Allocation",
		summary: summaryParts.join(theme.fg("dim", " \u2502 ")),
		renderDetail(width: number): string[] {
			const lines: string[] = [];

			lines.push(theme.bold(theme.fg("accent", "Budget Allocation")));
			lines.push("");

			// Model info
			lines.push(`  ${theme.fg("muted", "Model:")} ${model.provider}/${model.id}`);
			lines.push(`  ${theme.fg("muted", "Context window:")} ${formatTokens(model.contextWindow)}`);
			lines.push("");

			if (!budget) {
				lines.push(theme.fg("dim", "  No budget breakdown available."));
				return lines;
			}

			// Bar chart
			const segments: BarSegment[] = [
				{ label: "System prompt", value: budget.systemPromptTokens, color: "accent" },
				{ label: "Tool definitions", value: budget.toolDefinitionTokens, color: "warning" },
				{ label: "Messages", value: budget.messageTokens, color: "success" },
				{ label: "Assembled context", value: budget.assembledContextTokens, color: "muted" },
			];

			lines.push(...renderBudgetBar(segments, budget.contextWindow, width));
			lines.push("");

			// Headroom
			const headroomPct = formatPercent(budget.headroom, budget.contextWindow);
			const headroomColor =
				budget.headroom < budget.contextWindow * 0.1
					? "error"
					: budget.headroom < budget.contextWindow * 0.25
						? "warning"
						: "success";
			lines.push(
				`  ${theme.fg("dim", "\u2591")} ${theme.fg(headroomColor, `Headroom: ${formatTokens(budget.headroom)} (${headroomPct})`)}`,
			);

			return lines;
		},
	};
}

function projectSystemPromptSection(snapshot: EffectivePromptSnapshot): InspectorSection {
	const sp = snapshot.systemPrompt;

	return {
		kind: "system-prompt",
		label: "System Prompt",
		summary: `${formatTokens(sp.tokenEstimate)} \u2502 fingerprint ${sp.fingerprint.slice(0, 8)}`,
		renderDetail(_width: number): string[] {
			const lines: string[] = [];

			lines.push(theme.bold(theme.fg("accent", "System Prompt")));
			lines.push("");
			lines.push(`  ${theme.fg("muted", "Token estimate:")} ${formatTokens(sp.tokenEstimate)}`);
			lines.push(`  ${theme.fg("muted", "Fingerprint:")} ${sp.fingerprint}`);
			lines.push("");
			lines.push(theme.fg("dim", "  Content available via system prompt hash; not stored in snapshot."));

			return lines;
		},
	};
}

function projectToolsSection(snapshot: EffectivePromptSnapshot): InspectorSection {
	const tools = snapshot.tools;

	return {
		kind: "tools",
		label: "Tool Definitions",
		summary: `${tools.names.length} tools \u2502 ${formatTokens(tools.totalDefinitionTokenEstimate)}`,
		count: tools.names.length,
		renderDetail(width: number): string[] {
			const lines: string[] = [];

			lines.push(theme.bold(theme.fg("accent", "Tool Definitions")));
			lines.push("");
			lines.push(`  ${theme.fg("muted", "Count:")} ${tools.names.length}`);
			lines.push(`  ${theme.fg("muted", "Total tokens:")} ${formatTokens(tools.totalDefinitionTokenEstimate)}`);
			lines.push("");

			if (tools.names.length === 0) {
				lines.push(theme.fg("dim", "  No tools included."));
				return lines;
			}

			// Tool list in columns
			lines.push(theme.fg("muted", "  Tools:"));
			const colWidth = Math.max(20, Math.floor((width - 6) / 2));
			for (let i = 0; i < tools.names.length; i += 2) {
				const left = tools.names[i];
				const right = tools.names[i + 1];
				let line = `    ${theme.fg("accent", left.padEnd(colWidth))}`;
				if (right) {
					line += theme.fg("accent", right);
				}
				lines.push(truncateToWidth(line, width));
			}

			return lines;
		},
	};
}

function projectMessagesSection(snapshot: EffectivePromptSnapshot): InspectorSection {
	const msgs = snapshot.messages;
	const meta = msgs.transformMetadata;

	const statusCounts = meta
		? {
				included: meta.keptCount,
				stubbed: meta.stubbedCount,
				dropped: meta.droppedCount,
			}
		: undefined;

	const summaryParts = [`${msgs.final.length} msgs`, formatTokens(msgs.tokenEstimate)];
	if (meta) {
		const parts: string[] = [];
		if (meta.keptCount > 0) parts.push(`${meta.keptCount} kept`);
		if (meta.stubbedCount > 0) parts.push(`${meta.stubbedCount} stubbed`);
		if (meta.droppedCount > 0) parts.push(`${meta.droppedCount} dropped`);
		summaryParts.push(parts.join(", "));
	}

	return {
		kind: "messages",
		label: "Messages",
		summary: summaryParts.join(theme.fg("dim", " \u2502 ")),
		count: msgs.final.length,
		statusCounts,
		renderDetail(width: number): string[] {
			const lines: string[] = [];

			lines.push(theme.bold(theme.fg("accent", "Messages")));
			lines.push("");
			lines.push(`  ${theme.fg("muted", "Final count:")} ${msgs.final.length}`);
			lines.push(`  ${theme.fg("muted", "Token estimate:")} ${formatTokens(msgs.tokenEstimate)}`);

			if (meta) {
				lines.push("");
				lines.push(`  ${theme.fg("muted", "Transform:")} ${meta.totalTurns} turns total`);
				if (meta.keptCount > 0) lines.push(`    ${theme.fg("success", `${meta.keptCount} kept verbatim`)}`);
				if (meta.stubbedCount > 0)
					lines.push(`    ${theme.fg("warning", `${meta.stubbedCount} stubbed (tool results replaced)`)}`);
				if (meta.droppedCount > 0)
					lines.push(`    ${theme.fg("error", `${meta.droppedCount} dropped (budget exceeded)`)}`);

				if (meta.tokensBefore !== meta.tokensAfter) {
					lines.push("");
					lines.push(`  ${theme.fg("muted", "Tokens before transform:")} ${formatTokens(meta.tokensBefore)}`);
					lines.push(`  ${theme.fg("muted", "Tokens after transform:")} ${formatTokens(meta.tokensAfter)}`);
					const saved = meta.tokensBefore - meta.tokensAfter;
					lines.push(`  ${theme.fg("success", `Saved: ${formatTokens(saved)}`)}`);
				}

				// Per-turn decisions
				if (meta.decisions.length > 0) {
					lines.push("");
					lines.push(theme.fg("muted", "  Per-turn decisions:"));
					lines.push(theme.fg("dim", `  ${"\u2500".repeat(Math.min(width - 4, 50))}`));

					for (const d of meta.decisions) {
						const badge = renderDecisionBadge(d);
						const tokInfo =
							d.action === "dropped"
								? theme.fg("dim", `(${formatTokens(d.tokensBefore)} removed)`)
								: d.tokensBefore !== d.tokensAfter
									? theme.fg("dim", `(${formatTokens(d.tokensBefore)} \u2192 ${formatTokens(d.tokensAfter)})`)
									: theme.fg("dim", `(${formatTokens(d.tokensAfter)})`);
						lines.push(truncateToWidth(`  Turn ${d.turnIndex}: ${badge} ${tokInfo}`, width));
					}
				}
			}

			// Message role breakdown
			lines.push("");
			lines.push(theme.fg("muted", "  Message roles:"));
			const roleCounts = countMessageRoles(msgs.final);
			for (const [role, count] of Object.entries(roleCounts)) {
				lines.push(`    ${role}: ${count}`);
			}

			return lines;
		},
	};
}

function projectAssembledContextSection(snapshot: EffectivePromptSnapshot): InspectorSection | null {
	const ctx = snapshot.assemblerContext;
	if (!ctx) return null;

	const packet = ctx.packet;
	const fragmentCount = packet.fragments.length;
	const droppedCount = packet.dropped.length;

	return {
		kind: "assembled-context",
		label: "Assembled Context",
		summary: `${fragmentCount} fragments \u2502 ${formatTokens(packet.usage.consumedTokens)}`,
		count: fragmentCount,
		statusCounts: {
			included: fragmentCount,
			stubbed: 0,
			dropped: droppedCount,
		},
		renderDetail(width: number): string[] {
			const lines: string[] = [];

			lines.push(theme.bold(theme.fg("accent", "Assembled Context")));
			lines.push("");
			lines.push(`  ${theme.fg("muted", "Objective:")} ${packet.objective || "(none)"}`);
			lines.push(`  ${theme.fg("muted", "Generated at:")} ${packet.generatedAt}`);
			lines.push("");

			// Budget usage
			lines.push(
				`  ${theme.fg("muted", "Budget:")} ${formatTokens(packet.usage.consumedTokens)}/${formatTokens(packet.budget.maxTokens)}`,
			);
			lines.push(
				`  ${theme.fg("muted", "Latency:")} ${packet.usage.consumedLatencyMs}ms/${packet.budget.maxLatencyMs}ms`,
			);
			lines.push("");

			// Fragments
			if (fragmentCount > 0) {
				lines.push(theme.fg("muted", "  Included fragments:"));
				lines.push(theme.fg("dim", `  ${"\u2500".repeat(Math.min(width - 4, 50))}`));
				for (const frag of packet.fragments) {
					const tierBadge = theme.fg("accent", frag.tier.padEnd(6));
					const score = theme.fg("dim", `score=${frag.score.toFixed(2)}`);
					lines.push(truncateToWidth(`  ${tierBadge} ${frag.id} ${score}`, width));
					if (frag.locatorKey) {
						lines.push(truncateToWidth(`           ${theme.fg("dim", `locator: ${frag.locatorKey}`)}`, width));
					}
				}
			}

			// Dropped fragments
			if (droppedCount > 0) {
				lines.push("");
				lines.push(theme.fg("muted", "  Dropped fragments:"));
				lines.push(theme.fg("dim", `  ${"\u2500".repeat(Math.min(width - 4, 50))}`));
				for (const d of packet.dropped) {
					lines.push(truncateToWidth(`  ${theme.fg("error", d.id)}: ${theme.fg("dim", d.reason)}`, width));
				}
			}

			return lines;
		},
	};
}

function projectDroppedItemsSection(snapshot: EffectivePromptSnapshot): InspectorSection | null {
	const meta = snapshot.messages.transformMetadata;
	const assemblerDropped = snapshot.assemblerContext?.packet.dropped ?? [];
	const messageDropped = meta?.decisions.filter(d => d.action === "dropped") ?? [];

	const totalDropped = assemblerDropped.length + messageDropped.length;
	if (totalDropped === 0) return null;

	// Collect drop reasons
	const reasonCounts = new Map<string, number>();
	for (const d of messageDropped) {
		const count = reasonCounts.get(d.reason) ?? 0;
		reasonCounts.set(d.reason, count + 1);
	}
	for (const d of assemblerDropped) {
		const count = reasonCounts.get(d.reason) ?? 0;
		reasonCounts.set(d.reason, count + 1);
	}

	const topReasons = [...reasonCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([reason, count]) => `${reason} (${count})`)
		.join(", ");

	return {
		kind: "dropped-items",
		label: "Dropped Items",
		summary: `${totalDropped} items \u2502 ${topReasons}`,
		count: totalDropped,
		renderDetail(width: number): string[] {
			const lines: string[] = [];

			lines.push(theme.bold(theme.fg("accent", "Dropped Items")));
			lines.push("");
			lines.push(`  ${theme.fg("muted", "Total dropped:")} ${theme.fg("error", String(totalDropped))}`);
			lines.push("");

			// Reason breakdown
			lines.push(theme.fg("muted", "  Exclusion reasons:"));
			lines.push(theme.fg("dim", `  ${"\u2500".repeat(Math.min(width - 4, 50))}`));
			for (const [reason, count] of reasonCounts.entries()) {
				lines.push(`  ${theme.fg("error", String(count).padStart(3))} ${reason}`);
			}

			// Dropped turns
			if (messageDropped.length > 0) {
				lines.push("");
				lines.push(theme.fg("muted", "  Dropped message turns:"));
				for (const d of messageDropped) {
					lines.push(
						truncateToWidth(
							`    Turn ${d.turnIndex}: ${d.messageCount} msgs, ${formatTokens(d.tokensBefore)}`,
							width,
						),
					);
				}
			}

			// Dropped fragments
			if (assemblerDropped.length > 0) {
				lines.push("");
				lines.push(theme.fg("muted", "  Dropped context fragments:"));
				for (const d of assemblerDropped) {
					lines.push(truncateToWidth(`    ${d.id}: ${d.reason}`, width));
				}
			}

			return lines;
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project an EffectivePromptSnapshot into an ordered list of InspectorSections.
 *
 * Sections are always in a fixed order:
 *   1. Budget Allocation
 *   2. System Prompt
 *   3. Tool Definitions
 *   4. Messages (with transform metadata)
 *   5. Assembled Context (if active)
 *   6. Dropped Items (if any)
 */
export function projectSnapshot(snapshot: EffectivePromptSnapshot): InspectorSection[] {
	const sections: InspectorSection[] = [
		projectBudgetSection(snapshot),
		projectSystemPromptSection(snapshot),
		projectToolsSection(snapshot),
		projectMessagesSection(snapshot),
	];

	const assembledCtx = projectAssembledContextSection(snapshot);
	if (assembledCtx) sections.push(assembledCtx);

	const dropped = projectDroppedItemsSection(snapshot);
	if (dropped) sections.push(dropped);

	return sections;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function renderDecisionBadge(decision: TurnDecision): string {
	switch (decision.action) {
		case "kept":
			return theme.fg("success", "kept");
		case "stubbed":
			return theme.fg("warning", "stubbed");
		case "dropped":
			return theme.fg("error", "dropped");
	}
}

function countMessageRoles(messages: AgentMessage[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const msg of messages) {
		counts[msg.role] = (counts[msg.role] ?? 0) + 1;
	}
	return counts;
}
