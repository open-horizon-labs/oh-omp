import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TurnDecisionAction } from "../../context/assembler/message-transform";
import { formatAssemblySummary } from "../../context/assembly-summary";
import type { EffectivePromptSnapshot } from "../../context/effective-prompt-snapshot";
import type { RecallDebugTrace } from "../../context/recall";
import type { AgentSessionEvent } from "../../session/agent-session";

const MAX_RECENT_SNAPSHOTS = 8;

export type CockpitContextSource =
	| "budget"
	| "system"
	| "tools"
	| "messages"
	| "passive-recall"
	| "concept-graph"
	| "assembly-summary";

export type CockpitContextStatus =
	| "included"
	| "compressed"
	| "stubbed"
	| "dropped"
	| "derived"
	| "unavailable"
	| "warning";

export type CockpitDetailRef =
	| { kind: "none" }
	| { kind: "snapshot"; turnId: string; section: CockpitContextSource }
	| { kind: "transform-decision"; turnId: string; decisionIndex: number }
	| { kind: "recall-trace"; turnId: string | null; section: "selected" | "dropped" | "injected" }
	| { kind: "timeline-block"; blockId: string };

export interface CockpitContextSection {
	id: string;
	label: string;
	source: CockpitContextSource;
	status: CockpitContextStatus;
	tokenEstimate: number | null;
	summary: string;
	detailRef: CockpitDetailRef;
	expandable: boolean;
}

export interface CockpitContextDelta {
	id: string;
	label: string;
	previous: string | null;
	current: string | null;
}

export interface CockpitContextWarning {
	id: string;
	severity: "info" | "warning" | "error";
	message: string;
}

export interface CockpitContextState {
	current: EffectivePromptSnapshot | null;
	previous: EffectivePromptSnapshot | null;
	recall: RecallDebugTrace | null;
	assemblySummary: string | null;
	sections: CockpitContextSection[];
	deltas: CockpitContextDelta[];
	warnings: CockpitContextWarning[];
}

export type CockpitTimelineBlockKind = "agent" | "turn" | "message" | "tool" | "compaction" | "retry" | "todo" | "ttsr";

export type CockpitTimelineBlockStatus = "pending" | "streaming" | "done" | "error" | "skipped" | "info";

export interface CockpitTimelineBlock {
	id: string;
	kind: CockpitTimelineBlockKind;
	status: CockpitTimelineBlockStatus;
	label: string;
	summary: string;
	metadata: Record<string, string | number | boolean | null>;
	detailRef: CockpitDetailRef;
	expandable: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface CockpitSnapshotSummary {
	turnId: string;
	capturedAt: string;
	model: string;
	messageCount: number;
	messageTokens: number;
	headroom: number | null;
}

export interface CockpitProjectionState {
	context: CockpitContextState;
	timelineBlocks: CockpitTimelineBlock[];
	selectedBlockId: string | null;
	recentSnapshots: CockpitSnapshotSummary[];
}

export interface ProjectCockpitContextInput {
	current: EffectivePromptSnapshot | null;
	previous?: EffectivePromptSnapshot | null;
	recall?: RecallDebugTrace | null;
}

export class CockpitProjectionStore {
	#current: EffectivePromptSnapshot | null = null;
	#previous: EffectivePromptSnapshot | null = null;
	#recall: RecallDebugTrace | null = null;
	#timelineBlocks: CockpitTimelineBlock[] = [];
	#selectedBlockId: string | null = null;
	#recentSnapshots: CockpitSnapshotSummary[] = [];
	#sequence = 0;

	updateContext(input: ProjectCockpitContextInput): void {
		if (input.current) {
			if (input.current.turnId !== this.#current?.turnId) {
				this.#previous = this.#current;
			}
			this.#current = input.current;
			this.#recordSnapshot(input.current);
		}
		if (input.previous !== undefined) {
			this.#previous = input.previous;
		}
		if (input.recall !== undefined) {
			this.#recall = input.recall;
		}
	}

	handleEvent(event: AgentSessionEvent): CockpitTimelineBlock {
		const now = Date.now();
		const existing = this.#findExistingBlock(event);
		if (existing) {
			const updated = this.#updateBlock(existing, event, now);
			this.#replaceBlock(updated);
			return updated;
		}

		const block = this.#attachBlockKey(this.#createBlock(event, now), event);
		this.#timelineBlocks = [...this.#timelineBlocks, block];
		if (!this.#selectedBlockId) {
			this.#selectedBlockId = block.id;
		}
		return block;
	}

	selectBlock(blockId: string | null): void {
		if (blockId === null || this.#timelineBlocks.some(block => block.id === blockId)) {
			this.#selectedBlockId = blockId;
		}
	}

	getState(): CockpitProjectionState {
		return {
			context: projectCockpitContext({ current: this.#current, previous: this.#previous, recall: this.#recall }),
			timelineBlocks: [...this.#timelineBlocks],
			selectedBlockId: this.#selectedBlockId,
			recentSnapshots: [...this.#recentSnapshots],
		};
	}

	#recordSnapshot(snapshot: EffectivePromptSnapshot): void {
		const summary = summarizeSnapshot(snapshot);
		const withoutCurrent = this.#recentSnapshots.filter(item => item.turnId !== snapshot.turnId);
		this.#recentSnapshots = [summary, ...withoutCurrent].slice(0, MAX_RECENT_SNAPSHOTS);
	}

	#createBlock(
		event: AgentSessionEvent,
		now: number,
		options: { id?: string; blockKey?: string | null } = {},
	): CockpitTimelineBlock {
		const blockKey = options.blockKey ?? this.#blockKeyForEvent(event);
		const id = options.id ?? this.#nextBlockId();
		const metadata: Record<string, string | number | boolean | null> = {};
		if (blockKey) metadata.blockKey = blockKey;
		const base = {
			id,
			metadata,
			detailRef: { kind: "timeline-block", blockId: id } satisfies CockpitDetailRef,
			expandable: true,
			createdAt: now,
			updatedAt: now,
		};

		switch (event.type) {
			case "agent_start":
				return { ...base, kind: "agent", status: "pending", label: "Agent", summary: "Agent run started" };
			case "agent_end":
				return {
					...base,
					kind: "agent",
					status: "done",
					label: "Agent",
					summary: `Agent run ended with ${event.messages.length} messages`,
					metadata: { messageCount: event.messages.length },
				};
			case "turn_start":
				return { ...base, kind: "turn", status: "pending", label: "Turn", summary: "Turn started" };
			case "turn_end":
				return {
					...base,
					kind: "turn",
					status: "done",
					label: "Turn",
					summary: `Turn ended with ${event.toolResults.length} tool results`,
					metadata: { toolResultCount: event.toolResults.length, role: getMessageRole(event.message) },
				};
			case "message_start":
				return this.#messageBlock(base, event.message, "pending", "Message started");
			case "message_update":
				return this.#messageBlock(base, event.message, "streaming", "Message streaming");
			case "message_end":
				return this.#messageBlock(base, event.message, "done", "Message ended");
			case "tool_execution_start":
				return {
					...base,
					kind: "tool",
					status: "pending",
					label: event.toolName,
					summary: `Tool ${event.toolName} started`,
					metadata: { toolCallId: event.toolCallId, toolName: event.toolName, intent: event.intent ?? null },
				};
			case "tool_execution_update":
				return {
					...base,
					kind: "tool",
					status: "streaming",
					label: event.toolName,
					summary: `Tool ${event.toolName} updated`,
					metadata: { toolCallId: event.toolCallId, toolName: event.toolName },
				};
			case "tool_execution_end":
				return {
					...base,
					kind: "tool",
					status: event.isError ? "error" : "done",
					label: event.toolName,
					summary: `Tool ${event.toolName} ${event.isError ? "failed" : "completed"}`,
					metadata: { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError ?? false },
				};
			case "auto_compaction_start":
				return {
					...base,
					kind: "compaction",
					status: "pending",
					label: "Auto compaction",
					summary: `Auto compaction started: ${event.reason}`,
					metadata: { reason: event.reason, action: event.action },
				};
			case "auto_compaction_end":
				return {
					...base,
					kind: "compaction",
					status: event.errorMessage ? "error" : event.skipped ? "skipped" : "done",
					label: "Auto compaction",
					summary: event.errorMessage ?? (event.skipped ? "Auto compaction skipped" : "Auto compaction ended"),
					metadata: {
						action: event.action,
						aborted: event.aborted,
						willRetry: event.willRetry,
						skipped: event.skipped ?? false,
					},
				};
			case "auto_retry_start":
				return {
					...base,
					kind: "retry",
					status: "pending",
					label: "Retry",
					summary: `Retry ${event.attempt}/${event.maxAttempts} scheduled`,
					metadata: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
				};
			case "auto_retry_end":
				return {
					...base,
					kind: "retry",
					status: event.success ? "done" : "error",
					label: "Retry",
					summary: event.success
						? `Retry ${event.attempt} succeeded`
						: (event.finalError ?? `Retry ${event.attempt} failed`),
					metadata: { attempt: event.attempt, success: event.success },
				};
			case "retry_fallback_applied":
			case "retry_fallback_succeeded":
				return {
					...base,
					kind: "retry",
					status: "info",
					label: "Retry fallback",
					summary:
						event.type === "retry_fallback_applied"
							? `${event.role}: ${event.from} → ${event.to}`
							: `${event.role}: ${event.model} succeeded`,
					metadata: { role: event.role },
				};
			case "ttsr_triggered":
				return {
					...base,
					kind: "ttsr",
					status: "info",
					label: "TTSR",
					summary: `${event.rules.length} rule${event.rules.length === 1 ? "" : "s"} triggered`,
					metadata: { ruleCount: event.rules.length },
				};
			case "todo_reminder":
				return {
					...base,
					kind: "todo",
					status: "info",
					label: "Todo reminder",
					summary: `${event.todos.length} todo${event.todos.length === 1 ? "" : "s"} on attempt ${event.attempt}/${event.maxAttempts}`,
					metadata: { todoCount: event.todos.length, attempt: event.attempt, maxAttempts: event.maxAttempts },
				};
			case "todo_auto_clear":
				return { ...base, kind: "todo", status: "done", label: "Todo", summary: "Todos auto-cleared" };
		}
		return assertNever(event);
	}

	#messageBlock(
		base: Omit<CockpitTimelineBlock, "kind" | "status" | "label" | "summary">,
		message: AgentMessage,
		status: CockpitTimelineBlockStatus,
		fallbackSummary: string,
	): CockpitTimelineBlock {
		const role = getMessageRole(message);
		return {
			...base,
			kind: "message",
			status,
			label: role,
			summary: summarizeMessage(message) ?? fallbackSummary,
			metadata: { role },
		};
	}

	#findExistingBlock(event: AgentSessionEvent): CockpitTimelineBlock | undefined {
		const blockKey = this.#blockKeyForEvent(event);
		if (!blockKey) return undefined;
		return this.#timelineBlocks.find(block => block.metadata.blockKey === blockKey && isOpenBlock(block));
	}

	#updateBlock(block: CockpitTimelineBlock, event: AgentSessionEvent, now: number): CockpitTimelineBlock {
		const blockKey =
			typeof block.metadata.blockKey === "string" ? block.metadata.blockKey : this.#blockKeyForEvent(event);
		const next = this.#createBlock(event, now, { id: block.id, blockKey });
		return {
			...next,
			createdAt: block.createdAt,
			updatedAt: now,
			detailRef: block.detailRef,
			metadata: { ...(blockKey ? { blockKey } : {}), ...block.metadata, ...next.metadata },
		};
	}

	#attachBlockKey(block: CockpitTimelineBlock, event: AgentSessionEvent): CockpitTimelineBlock {
		const blockKey = this.#blockKeyForEvent(event);
		if (!blockKey || block.metadata.blockKey === blockKey) return block;
		return { ...block, metadata: { blockKey, ...block.metadata } };
	}

	#replaceBlock(block: CockpitTimelineBlock): void {
		this.#timelineBlocks = this.#timelineBlocks.map(existing => (existing.id === block.id ? block : existing));
	}

	#blockKeyForEvent(event: AgentSessionEvent): string | null {
		switch (event.type) {
			case "agent_start":
			case "agent_end":
				return "agent:active";
			case "turn_start":
			case "turn_end":
				return "turn:active";
			case "message_start":
			case "message_update":
			case "message_end":
				return messageBlockKey(event.message);
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				return `tool:${event.toolCallId}`;
			case "auto_compaction_start":
			case "auto_compaction_end":
				return `compaction:${event.action}`;
			case "auto_retry_start":
			case "auto_retry_end":
				return `retry:${event.attempt}`;
			case "retry_fallback_applied":
			case "retry_fallback_succeeded":
			case "ttsr_triggered":
			case "todo_reminder":
			case "todo_auto_clear":
				return null;
		}
		return assertNever(event);
	}

	#nextBlockId(): string {
		this.#sequence += 1;
		return `event-${this.#sequence}`;
	}
}

export function projectCockpitContext(input: ProjectCockpitContextInput): CockpitContextState {
	const current = input.current;
	const previous = input.previous ?? null;
	const recall = input.recall ?? null;
	const assemblySummary = current ? formatAssemblySummary(current) : null;
	const sections = current ? projectSnapshotSections(current, assemblySummary) : [missingSnapshotSection()];
	sections.push(projectRecallSection(current, recall));
	const warnings = buildWarnings(current, recall);
	return {
		current,
		previous,
		recall,
		assemblySummary,
		sections,
		deltas: buildDeltas(current, previous),
		warnings,
	};
}

function projectSnapshotSections(
	snapshot: EffectivePromptSnapshot,
	assemblySummary: string | null,
): CockpitContextSection[] {
	const sections: CockpitContextSection[] = [];
	if (snapshot.budget) {
		const used = snapshot.budget.contextWindow - snapshot.budget.headroom;
		sections.push({
			id: "budget",
			label: "Budget",
			source: "budget",
			status: "included",
			tokenEstimate: used,
			summary: `${formatTokenCount(used)} used / ${formatTokenCount(snapshot.budget.contextWindow)} window (${formatTokenCount(snapshot.budget.headroom)} headroom)`,
			detailRef: { kind: "snapshot", turnId: snapshot.turnId, section: "budget" },
			expandable: true,
		});
	} else {
		sections.push({
			id: "budget",
			label: "Budget",
			source: "budget",
			status: "unavailable",
			tokenEstimate: null,
			summary: "No budget data captured for this turn",
			detailRef: { kind: "none" },
			expandable: false,
		});
	}

	sections.push({
		id: "system",
		label: "System prompt",
		source: "system",
		status: "included",
		tokenEstimate: snapshot.systemPrompt.tokenEstimate,
		summary: `${formatTokenCount(snapshot.systemPrompt.tokenEstimate)} · fingerprint ${snapshot.systemPrompt.fingerprint}`,
		detailRef: { kind: "snapshot", turnId: snapshot.turnId, section: "system" },
		expandable: true,
	});

	sections.push({
		id: "tools",
		label: "Tools",
		source: "tools",
		status: "included",
		tokenEstimate: snapshot.tools.totalDefinitionTokenEstimate,
		summary: `${snapshot.tools.names.length} tools · ${formatTokenCount(snapshot.tools.totalDefinitionTokenEstimate)}`,
		detailRef: { kind: "snapshot", turnId: snapshot.turnId, section: "tools" },
		expandable: true,
	});

	sections.push({
		id: "messages",
		label: "Messages",
		source: "messages",
		status: statusFromTransform(snapshot),
		tokenEstimate: snapshot.messages.tokenEstimate,
		summary: messageSummary(snapshot),
		detailRef: { kind: "snapshot", turnId: snapshot.turnId, section: "messages" },
		expandable: true,
	});

	sections.push(projectConceptGraphSection(snapshot));

	const metadata = snapshot.messages.transformMetadata;
	if (metadata) {
		for (const [index, decision] of metadata.decisions.entries()) {
			if (decision.action === "kept") continue;
			sections.push({
				id: `decision-${decision.turnIndex}`,
				label: `Turn ${decision.turnIndex}`,
				source: "messages",
				status: decision.action,
				tokenEstimate: decision.tokensAfter,
				summary: transformDecisionSummary(
					decision.action,
					decision.reason,
					decision.tokensBefore,
					decision.tokensAfter,
				),
				detailRef: { kind: "transform-decision", turnId: snapshot.turnId, decisionIndex: index },
				expandable: true,
			});
		}
	}

	sections.push({
		id: "assembly-summary",
		label: "Assembly summary",
		source: "assembly-summary",
		status: assemblySummary ? "derived" : "unavailable",
		tokenEstimate: assemblySummary ? Math.ceil(assemblySummary.length / 4) : null,
		summary: assemblySummary ?? "No assembly summary generated for this turn",
		detailRef: assemblySummary
			? { kind: "snapshot", turnId: snapshot.turnId, section: "assembly-summary" }
			: { kind: "none" },
		expandable: Boolean(assemblySummary),
	});

	return sections;
}

function projectConceptGraphSection(snapshot: EffectivePromptSnapshot): CockpitContextSection {
	const context = extractConceptGraphContext(snapshot);
	if (!context) {
		return {
			id: "concept-graph",
			label: "Concept graph",
			source: "concept-graph",
			status: "unavailable",
			tokenEstimate: null,
			summary: "No concept graph context injected for this turn",
			detailRef: { kind: "none" },
			expandable: false,
		};
	}

	return {
		id: "concept-graph",
		label: "Concept graph",
		source: "concept-graph",
		status: "included",
		tokenEstimate: context.tokenEstimate,
		summary: conceptGraphSummary(context.text),
		detailRef: { kind: "snapshot", turnId: snapshot.turnId, section: "concept-graph" },
		expandable: true,
	};
}

function projectRecallSection(
	snapshot: EffectivePromptSnapshot | null,
	recall: RecallDebugTrace | null,
): CockpitContextSection {
	if (!recall) {
		return {
			id: "passive-recall",
			label: "Passive recall",
			source: "passive-recall",
			status: "unavailable",
			tokenEstimate: null,
			summary: "No passive recall trace captured for this context",
			detailRef: { kind: "none" },
			expandable: false,
		};
	}

	const status: CockpitContextStatus = recall.injected
		? "included"
		: recall.dropped.length > 0
			? "dropped"
			: "unavailable";
	const turnLabel = snapshot && recall.turnId !== snapshot.turnId ? ` · trace turn ${recall.turnId ?? "unknown"}` : "";
	return {
		id: "passive-recall",
		label: "Passive recall",
		source: "passive-recall",
		status,
		tokenEstimate: recall.injectedTokenEstimate,
		summary: `${recall.selected.length} selected, ${recall.dropped.length} dropped, ${formatTokenCount(recall.injectedTokenEstimate)} injected${turnLabel}`,
		detailRef: { kind: "recall-trace", turnId: recall.turnId, section: recall.injected ? "injected" : "selected" },
		expandable: true,
	};
}

function buildWarnings(
	current: EffectivePromptSnapshot | null,
	recall: RecallDebugTrace | null,
): CockpitContextWarning[] {
	const warnings: CockpitContextWarning[] = [];
	if (!current) {
		warnings.push({
			id: "missing-snapshot",
			severity: "warning",
			message: "No effective prompt snapshot is available",
		});
		return warnings;
	}
	if (current.budget && current.budget.contextWindow > 0) {
		const headroomPercent = current.budget.headroom / current.budget.contextWindow;
		if (headroomPercent < 0.05) {
			warnings.push({ id: "low-headroom", severity: "warning", message: "Context headroom is below 5%" });
		}
	}
	if (recall?.turnId && recall.turnId !== current.turnId) {
		warnings.push({
			id: "recall-turn-mismatch",
			severity: "warning",
			message: `Recall trace ${recall.turnId} does not match snapshot ${current.turnId}`,
		});
	}
	if (recall?.failure) {
		warnings.push({ id: "recall-failure", severity: "error", message: recall.failure });
	}
	return warnings;
}

function buildDeltas(
	current: EffectivePromptSnapshot | null,
	previous: EffectivePromptSnapshot | null,
): CockpitContextDelta[] {
	if (!current || !previous) return [];
	const deltas: CockpitContextDelta[] = [];
	if (previous.systemPrompt.fingerprint !== current.systemPrompt.fingerprint) {
		deltas.push({
			id: "system-fingerprint",
			label: "System prompt fingerprint",
			previous: previous.systemPrompt.fingerprint,
			current: current.systemPrompt.fingerprint,
		});
	}
	if (previous.tools.names.join("\0") !== current.tools.names.join("\0")) {
		deltas.push({
			id: "tools",
			label: "Tool set",
			previous: `${previous.tools.names.length} tools`,
			current: `${current.tools.names.length} tools`,
		});
	}
	if (previous.messages.final.length !== current.messages.final.length) {
		deltas.push({
			id: "message-count",
			label: "Message count",
			previous: String(previous.messages.final.length),
			current: String(current.messages.final.length),
		});
	}
	if (previous.budget?.headroom !== current.budget?.headroom) {
		deltas.push({
			id: "headroom",
			label: "Headroom",
			previous: previous.budget ? formatTokenCount(previous.budget.headroom) : null,
			current: current.budget ? formatTokenCount(current.budget.headroom) : null,
		});
	}
	return deltas;
}

function summarizeSnapshot(snapshot: EffectivePromptSnapshot): CockpitSnapshotSummary {
	return {
		turnId: snapshot.turnId,
		capturedAt: snapshot.capturedAt,
		model: `${snapshot.model.provider}/${snapshot.model.id}`,
		messageCount: snapshot.messages.final.length,
		messageTokens: snapshot.messages.tokenEstimate,
		headroom: snapshot.budget?.headroom ?? null,
	};
}

function missingSnapshotSection(): CockpitContextSection {
	return {
		id: "snapshot",
		label: "Effective context",
		source: "messages",
		status: "unavailable",
		tokenEstimate: null,
		summary: "No effective prompt snapshot captured yet",
		detailRef: { kind: "none" },
		expandable: false,
	};
}

interface ExtractedConceptGraphContext {
	text: string;
	tokenEstimate: number;
	factCount: number;
	linkCount: number;
}

const CONCEPT_GRAPH_OPEN_TAG = "<concept_graph_context>";
const CONCEPT_GRAPH_CLOSE_TAG = "</concept_graph_context>";

function extractConceptGraphContext(snapshot: EffectivePromptSnapshot): ExtractedConceptGraphContext | null {
	for (const message of snapshot.messages.final) {
		if (getMessageRole(message) !== "developer") continue;
		const content = messageContentText(message);
		if (!content) continue;
		const start = content.indexOf(CONCEPT_GRAPH_OPEN_TAG);
		const end = content.indexOf(CONCEPT_GRAPH_CLOSE_TAG);
		if (start === -1 || end === -1 || end <= start) continue;
		const text = content.slice(start + CONCEPT_GRAPH_OPEN_TAG.length, end).trim();
		return {
			text,
			tokenEstimate: Math.ceil(text.length / 4),
			factCount: countMatchingLines(text, /^- \[[^\]]+\]\[[^\]]+\]\[[^\]]+\]/),
			linkCount: countMatchingLines(text, /^- \[[^\]]+\]\[[^\]]+\] \S+ -> \S+:/),
		};
	}
	return null;
}

function conceptGraphSummary(contextText: string): string {
	const extracted = {
		factCount: countMatchingLines(contextText, /^- \[[^\]]+\]\[[^\]]+\]\[[^\]]+\]/),
		linkCount: countMatchingLines(contextText, /^- \[[^\]]+\]\[[^\]]+\] \S+ -> \S+:/),
	};
	const firstFact = contextText

		.split("\n")
		.find(line => line.startsWith("- ["))
		?.replace(/^- \[[^\]]+\]\[[^\]]+\](?:\[[^\]]+\])?\s*/, "")
		.trim();
	const counts = `${extracted.factCount} facts, ${extracted.linkCount} links`;
	return firstFact ? `${counts} · ${truncateSummary(firstFact)}` : `${counts} injected`;
}

function messageContentText(message: AgentMessage): string | null {
	const content = message && typeof message === "object" && "content" in message ? message.content : null;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const text = content
		.map(block => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
	return text.length > 0 ? text : null;
}

function countMatchingLines(text: string, pattern: RegExp): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (pattern.test(line)) count += 1;
	}
	return count;
}

function statusFromTransform(snapshot: EffectivePromptSnapshot): CockpitContextStatus {
	const metadata = snapshot.messages.transformMetadata;
	if (!metadata) return "included";
	if (metadata.droppedCount > 0) return "dropped";
	if (metadata.compressedCount > 0) return "compressed";
	if (metadata.stubbedCount > 0) return "stubbed";
	return "included";
}

function messageSummary(snapshot: EffectivePromptSnapshot): string {
	const metadata = snapshot.messages.transformMetadata;
	const base = `${snapshot.messages.final.length} messages · ${formatTokenCount(snapshot.messages.tokenEstimate)}`;
	if (!metadata) return base;
	return `${base} · ${metadata.keptCount} kept, ${metadata.stubbedCount} stubbed, ${metadata.compressedCount} compressed, ${metadata.droppedCount} dropped`;
}

function transformDecisionSummary(
	action: TurnDecisionAction,
	reason: string,
	tokensBefore: number,
	tokensAfter: number,
): string {
	return `${action} because ${reason} · ${formatTokenCount(tokensBefore)} → ${formatTokenCount(tokensAfter)}`;
}

function isOpenBlock(block: CockpitTimelineBlock): boolean {
	return block.status === "pending" || block.status === "streaming";
}

function messageBlockKey(message: AgentMessage): string | null {
	const timestamp = getMessageTimestamp(message);
	if (timestamp === null) return null;
	return `message:${getMessageRole(message)}:${timestamp}`;
}

function getMessageTimestamp(message: AgentMessage): string | null {
	if (message && typeof message === "object" && "timestamp" in message) {
		const timestamp = message.timestamp;
		if (typeof timestamp === "string" || typeof timestamp === "number") return String(timestamp);
	}
	return null;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled cockpit projection event: ${JSON.stringify(value)}`);
}

function getMessageRole(message: AgentMessage): string {
	if (message && typeof message === "object" && "role" in message && typeof message.role === "string") {
		return message.role;
	}
	return "message";
}

function summarizeMessage(message: AgentMessage): string | null {
	if (!message || typeof message !== "object" || !("content" in message)) return null;
	const content = message.content;
	if (typeof content === "string") return truncateSummary(content);
	if (Array.isArray(content)) {
		const text = content
			.map(block => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object" && "text" in block && typeof block.text === "string")
					return block.text;
				return "";
			})
			.filter(Boolean)
			.join(" ");
		return text ? truncateSummary(text) : null;
	}
	return null;
}

function truncateSummary(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M tok`;
	if (value >= 1_000) return `${trimDecimal(value / 1_000)}K tok`;
	return `${value} tok`;
}

function trimDecimal(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
