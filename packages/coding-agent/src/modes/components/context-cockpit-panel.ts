import {
	type Component,
	type Focusable,
	matchesKey,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type {
	CockpitContextDelta,
	CockpitContextSection,
	CockpitContextStatus,
	CockpitProjectionState,
	CockpitSnapshotSummary,
	CockpitTimelineBlock,
	CockpitTimelineBlockStatus,
} from "../cockpit";
import { theme } from "../theme/theme";

const DEFAULT_MAX_SECTIONS = 8;
const DEFAULT_MAX_TIMELINE_BLOCKS = 6;
const MAX_DETAIL_LINES = 8;

export interface ContextCockpitPanelOptions {
	maxSections?: number;
	maxTimelineBlocks?: number;
}

type ContextCockpitStateSource = CockpitProjectionState | (() => CockpitProjectionState);

export interface ContextCockpitSplitViewOptions {
	minWidth?: number;
	rightWidthPercent?: number;
	minRightWidth?: number;
	maxRightWidth?: number;
	gap?: number;
}

type CockpitRow =
	| {
			id: string;
			kind: "warning";
			label: string;
			summary: string;
			status: "warning" | "error" | "info";
			expandable: true;
	  }
	| { id: string; kind: "section"; section: CockpitContextSection }
	| { id: string; kind: "delta"; delta: CockpitContextDelta }
	| { id: string; kind: "snapshot"; snapshot: CockpitSnapshotSummary }
	| { id: string; kind: "timeline"; block: CockpitTimelineBlock };

export class ContextCockpitPanel implements Component, Focusable {
	onClose?: () => void;
	focused = false;

	#stateSource: () => CockpitProjectionState;
	#maxSections: number;
	#maxTimelineBlocks: number;
	#selectedIndex = 0;
	#expandedRowId: string | null = null;

	constructor(state: ContextCockpitStateSource, options: ContextCockpitPanelOptions = {}) {
		this.#stateSource = typeof state === "function" ? state : () => state;
		this.#maxSections = options.maxSections ?? DEFAULT_MAX_SECTIONS;
		this.#maxTimelineBlocks = options.maxTimelineBlocks ?? DEFAULT_MAX_TIMELINE_BLOCKS;
	}

	setState(state: CockpitProjectionState): void {
		this.#stateSource = () => state;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const state = this.#stateSource();
		const rows = buildRows(state, this.#maxSections, this.#maxTimelineBlocks);
		this.#clampSelection(rows.length);

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, "up")) {
			this.#moveSelection(-1, rows.length);
			return;
		}
		if (matchesKey(data, "down")) {
			this.#moveSelection(1, rows.length);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const row = rows[this.#selectedIndex];
			if (row && isExpandable(row)) {
				this.#expandedRowId = this.#expandedRowId === row.id ? null : row.id;
			}
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const state = this.#stateSource();
		const rows = buildRows(state, this.#maxSections, this.#maxTimelineBlocks);
		this.#clampSelection(rows.length);
		const lines: string[] = [];
		lines.push(borderLine(safeWidth));
		lines.push(line(this.focused ? "› Context Cockpit" : "Context Cockpit", titleSummary(state), safeWidth));
		lines.push(borderLine(safeWidth));

		lines.push(...this.#renderOverview(state, safeWidth));
		lines.push("");
		lines.push(...renderRows(state, rows, this.#selectedIndex, this.#expandedRowId, this.focused, safeWidth));
		lines.push("");
		const help = this.focused
			? "↑/↓ select  enter details  esc editor  /prompt full inspector"
			: "/cockpit focus  /prompt full inspector  /recall details";
		lines.push(dimLine(help, safeWidth));
		lines.push(borderLine(safeWidth));
		return lines;
	}

	#renderOverview(state: CockpitProjectionState, width: number): string[] {
		const context = state.context;
		const snapshot = context.current;
		if (!snapshot) {
			return [
				mutedLine("No effective context snapshot captured yet.", width),
				dimLine("Send a prompt to populate cockpit context data.", width),
			];
		}

		const budget = snapshot.budget;
		const model = `${snapshot.model.provider}/${snapshot.model.id}`;
		const budgetText = budget
			? `${formatTokenCount(Math.max(0, budget.contextWindow - budget.headroom))} used · ${formatTokenCount(budget.headroom)} headroom`
			: "budget unavailable";
		const recallText = context.recall
			? `${context.recall.selected.length} selected / ${context.recall.dropped.length} dropped`
			: "recall unavailable";
		const assemblyText = context.assemblySummary ? "assembly summary represented" : "assembly summary unavailable";
		return [
			line("Model", model, width),
			line("Budget", budgetText, width),
			line("Recall", recallText, width),
			line("Assembly", assemblyText, width),
		];
	}

	#moveSelection(delta: number, rowCount: number): void {
		if (rowCount === 0) {
			this.#selectedIndex = 0;
			return;
		}
		this.#selectedIndex = (this.#selectedIndex + delta + rowCount) % rowCount;
		this.#expandedRowId = null;
	}

	#clampSelection(rowCount: number): void {
		if (rowCount === 0) {
			this.#selectedIndex = 0;
			this.#expandedRowId = null;
			return;
		}
		if (this.#selectedIndex >= rowCount) this.#selectedIndex = rowCount - 1;
	}
}

export class ContextCockpitSplitView implements Component {
	#left: Component;
	#right: Component;
	#minWidth: number;
	#rightWidthPercent: number;
	#minRightWidth: number;
	#maxRightWidth: number;
	#gap: number;
	#visible = true;

	constructor(left: Component, right: Component, options: ContextCockpitSplitViewOptions = {}) {
		this.#left = left;
		this.#right = right;
		this.#minWidth = options.minWidth ?? 120;
		this.#rightWidthPercent = options.rightWidthPercent ?? 0.32;
		this.#minRightWidth = options.minRightWidth ?? 38;
		this.#maxRightWidth = options.maxRightWidth ?? 64;
		this.#gap = options.gap ?? 2;
	}

	invalidate(): void {
		this.#left.invalidate();
		this.#right.invalidate();
	}

	setVisible(visible: boolean): void {
		this.#visible = visible;
	}

	toggleVisible(): boolean {
		this.#visible = !this.#visible;
		return this.#visible;
	}

	isVisible(): boolean {
		return this.#visible;
	}

	isActiveForWidth(width: number): boolean {
		return this.#visible && width >= this.#minWidth;
	}

	render(width: number): string[] {
		if (!this.#visible || width < this.#minWidth) return this.#left.render(width);

		const rightWidth = clamp(Math.floor(width * this.#rightWidthPercent), this.#minRightWidth, this.#maxRightWidth);
		const leftWidth = Math.max(1, width - rightWidth - this.#gap);
		const leftLines = this.#left.render(leftWidth);
		const rightLines = this.#right.render(rightWidth);
		const height = Math.max(leftLines.length, rightLines.length);
		const rightStart = Math.max(0, height - rightLines.length);
		const lines: string[] = [];

		for (let i = 0; i < height; i++) {
			const left = padToWidth(truncateToWidth(leftLines[i] ?? "", leftWidth), leftWidth);
			const rightIndex = i - rightStart;
			const right = rightIndex >= 0 ? (rightLines[rightIndex] ?? "") : "";
			lines.push(truncateToWidth(`${left}${" ".repeat(this.#gap)}${right}`, width));
		}

		return lines;
	}
}

function buildRows(state: CockpitProjectionState, maxSections: number, maxTimelineBlocks: number): CockpitRow[] {
	const warningRows: CockpitRow[] = state.context.warnings.slice(0, 3).map(warning => ({
		id: `warning-${warning.id}`,
		kind: "warning",
		label: warning.severity.toUpperCase(),
		summary: warning.message,
		status: warning.severity,
		expandable: true,
	}));
	const sectionRows: CockpitRow[] = state.context.sections.slice(0, maxSections).map(section => ({
		id: `section-${section.id}`,
		kind: "section",
		section,
	}));
	const deltaRows: CockpitRow[] = state.context.deltas.slice(0, 4).map(delta => ({
		id: `delta-${delta.id}`,
		kind: "delta",
		delta,
	}));
	const snapshotRows: CockpitRow[] = state.recentSnapshots.slice(0, 4).map(snapshot => ({
		id: `snapshot-${snapshot.turnId}`,
		kind: "snapshot",
		snapshot,
	}));
	const timelineRows: CockpitRow[] = state.timelineBlocks.slice(-maxTimelineBlocks).map(block => ({
		id: `timeline-${block.id}`,
		kind: "timeline",
		block,
	}));
	return [...warningRows, ...sectionRows, ...deltaRows, ...snapshotRows, ...timelineRows];
}

function renderRows(
	state: CockpitProjectionState,
	rows: CockpitRow[],
	selectedIndex: number,
	expandedRowId: string | null,
	focused: boolean,
	width: number,
): string[] {
	const lines: string[] = [];
	const warningCount = rows.filter(row => row.kind === "warning").length;
	if (warningCount > 0) lines.push(heading("Warnings", width));
	let contextHeadingRendered = false;
	let timelineHeadingRendered = false;
	let deltaHeadingRendered = false;
	let snapshotHeadingRendered = false;

	for (const [index, row] of rows.entries()) {
		if (row.kind === "section" && !contextHeadingRendered) {
			if (warningCount > 0) lines.push("");
			lines.push(heading("Context", width));
			contextHeadingRendered = true;
		}
		if (row.kind === "delta" && !deltaHeadingRendered) {
			lines.push("");
			lines.push(heading("Changed since previous", width));
			deltaHeadingRendered = true;
		}
		if (row.kind === "snapshot" && !snapshotHeadingRendered) {
			lines.push("");
			lines.push(heading("Recent turns", width));
			snapshotHeadingRendered = true;
		}
		if (row.kind === "timeline" && !timelineHeadingRendered) {
			lines.push("");
			lines.push(heading("Recent activity", width));
			timelineHeadingRendered = true;
		}

		const selected = index === selectedIndex;
		lines.push(renderRow(row, selected, focused, width));
		if (selected && expandedRowId === row.id) {
			lines.push(...renderRowDetail(state, row, width));
		}
	}

	if (rows.length === 0) lines.push(mutedLine("No cockpit rows projected yet.", width));
	if (!contextHeadingRendered && rows.every(row => row.kind !== "section")) {
		lines.push("");
		lines.push(heading("Context", width));
		lines.push(mutedLine("No context sections projected.", width));
	}
	if (!timelineHeadingRendered && rows.every(row => row.kind !== "timeline")) {
		lines.push("");
		lines.push(heading("Recent activity", width));
		lines.push(mutedLine("No session activity projected yet.", width));
	}
	return lines;
}

function renderRow(row: CockpitRow, selected: boolean, focused: boolean, width: number): string {
	const marker = selected ? (focused ? theme.fg("accent", "›") : theme.fg("dim", "•")) : " ";
	if (row.kind === "warning") {
		const icon = warningIcon(row.status);
		return truncateToWidth(
			`${marker} ${icon} ${theme.fg("muted", sanitize(row.label))} ${theme.fg("dim", sanitize(row.summary))}`,
			width,
		);
	}
	if (row.kind === "delta") return renderDelta(row.delta, width, marker);
	if (row.kind === "snapshot") return renderSnapshotSummary(row.snapshot, width, marker);
	if (row.kind === "timeline") return renderTimelineBlock(row.block, width, marker);
	return renderSection(row.section, width, marker);
}

function renderRowDetail(state: CockpitProjectionState, row: CockpitRow, width: number): string[] {
	const details = detailLinesForRow(state, row).slice(0, MAX_DETAIL_LINES);
	if (details.length === 0) return [detailLine("No detail available for this row.", width)];
	return details.map(detail => detailLine(detail, width));
}

function detailLinesForRow(state: CockpitProjectionState, row: CockpitRow): string[] {
	if (row.kind === "warning") return [`warning: ${row.summary}`];
	if (row.kind === "timeline") return detailLinesForTimeline(row.block);
	if (row.kind === "delta") return detailLinesForDelta(row.delta);
	if (row.kind === "snapshot") return detailLinesForSnapshotSummary(row.snapshot);
	const section = row.section;
	const snapshot = state.context.current;
	const detailRef = section.detailRef;
	if (detailRef.kind === "transform-decision") {
		const decision = snapshot?.messages.transformMetadata?.decisions[detailRef.decisionIndex];
		if (!decision) return [`decision ${detailRef.decisionIndex} unavailable`];
		return [
			`action: ${decision.action}`,
			`reason: ${decision.reason}`,
			`turn: ${decision.turnIndex} · messages: ${decision.messageCount}`,
			`tokens: ${formatTokenCount(decision.tokensBefore)} → ${formatTokenCount(decision.tokensAfter)}`,
			`tool results: ${decision.hasToolResults ? "yes" : "no"}`,
			`sources: ${decision.sourceTags.length > 0 ? decision.sourceTags.join(", ") : "none"}`,
		];
	}
	if (detailRef.kind === "recall-trace") return detailLinesForRecall(state, detailRef.section);
	if (detailRef.kind !== "snapshot") return [section.summary];
	if (!snapshot) return ["snapshot unavailable"];
	return detailLinesForSnapshotSection(state, section, detailRef.section);
}

function detailLinesForSnapshotSection(
	state: CockpitProjectionState,
	section: CockpitContextSection,
	source: CockpitContextSection["source"],
): string[] {
	const snapshot = state.context.current;
	if (!snapshot) return [section.summary];
	switch (source) {
		case "budget": {
			const budget = snapshot.budget;
			if (!budget) return ["budget unavailable"];
			return [
				`context window: ${formatTokenCount(budget.contextWindow)}`,
				`headroom: ${formatTokenCount(budget.headroom)}`,
				`message tokens: ${formatTokenCount(budget.messageTokens)}`,
				`tool definitions: ${formatTokenCount(budget.toolDefinitionTokens)}`,
				`hydration budget max: ${formatTokenCount(budget.hydrationBudgetMax)}`,
				`assembled context: ${formatTokenCount(budget.assembledContextTokens)}`,
			];
		}
		case "system":
			return [
				`fingerprint: ${snapshot.systemPrompt.fingerprint}`,
				`tokens: ${formatTokenCount(snapshot.systemPrompt.tokenEstimate)}`,
			];
		case "tools":
			return [
				`count: ${snapshot.tools.names.length}`,
				`definition tokens: ${formatTokenCount(snapshot.tools.totalDefinitionTokenEstimate)}`,
				`names: ${snapshot.tools.names.slice(0, 10).join(", ") || "none"}`,
			];
		case "messages": {
			const metadata = snapshot.messages.transformMetadata;
			return [
				`final messages: ${snapshot.messages.final.length}`,
				`message tokens: ${formatTokenCount(snapshot.messages.tokenEstimate)}`,
				metadata
					? `decisions: ${metadata.keptCount} kept, ${metadata.stubbedCount} stubbed, ${metadata.compressedCount} compressed, ${metadata.droppedCount} dropped`
					: "decisions: unavailable",
			];
		}
		case "concept-graph":
			return detailLinesForConceptGraph(state, section);
		case "assembly-summary":
			return state.context.assemblySummary ? [state.context.assemblySummary] : ["assembly summary unavailable"];
		case "passive-recall":
			return detailLinesForRecall(state, "injected");
	}
}

function detailLinesForConceptGraph(state: CockpitProjectionState, section: CockpitContextSection): string[] {
	const snapshot = state.context.current;
	if (!snapshot) return [section.summary];
	const contextText = extractConceptGraphText(snapshot);
	if (!contextText) return [section.summary];
	return contextText
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.slice(0, MAX_DETAIL_LINES);
}

function extractConceptGraphText(snapshot: CockpitProjectionState["context"]["current"]): string | null {
	if (!snapshot) return null;
	for (const message of snapshot.messages.final) {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "developer") continue;
		const content = "content" in message ? message.content : null;
		const text = typeof content === "string" ? content : null;
		if (!text) continue;
		const start = text.indexOf("<concept_graph_context>");
		const end = text.indexOf("</concept_graph_context>");
		if (start === -1 || end === -1 || end <= start) continue;
		return text.slice(start + "<concept_graph_context>".length, end).trim();
	}
	return null;
}

function detailLinesForDelta(delta: CockpitContextDelta): string[] {
	return [`field: ${delta.label}`, `previous: ${delta.previous ?? "none"}`, `current: ${delta.current ?? "none"}`];
}

function detailLinesForSnapshotSummary(snapshot: CockpitSnapshotSummary): string[] {
	return [
		`turn: ${snapshot.turnId}`,
		`captured: ${snapshot.capturedAt}`,
		`model: ${snapshot.model}`,
		`messages: ${snapshot.messageCount}`,
		`message tokens: ${formatTokenCount(snapshot.messageTokens)}`,
		`headroom: ${snapshot.headroom === null ? "unavailable" : formatTokenCount(snapshot.headroom)}`,
	];
}

function detailLinesForRecall(state: CockpitProjectionState, section: "selected" | "dropped" | "injected"): string[] {
	const recall = state.context.recall;
	if (!recall) return ["recall trace unavailable"];
	if (section === "injected") {
		return [
			`turn: ${recall.turnId ?? "unknown"}`,
			`selected: ${recall.selected.length} · dropped: ${recall.dropped.length}`,
			`tokens: ${formatTokenCount(recall.injectedTokenEstimate)}`,
			`text: ${recall.injectedText || "none"}`,
		];
	}
	const entries = section === "selected" ? recall.selected : recall.dropped;
	if (entries.length === 0) return [`${section}: none`];
	return entries.slice(0, 5).map(entry => `${entry.rank}. ${entry.role} turn ${entry.turn}: ${entry.textPreview}`);
}

function detailLinesForTimeline(block: CockpitTimelineBlock): string[] {
	const metadata = Object.entries(block.metadata).map(([key, value]) => `${key}: ${value ?? "null"}`);
	return [`kind: ${block.kind}`, `status: ${block.status}`, `summary: ${block.summary}`, ...metadata];
}

function isExpandable(row: CockpitRow): boolean {
	if (row.kind === "warning") return row.expandable;
	if (row.kind === "section") return row.section.expandable;
	if (row.kind === "delta" || row.kind === "snapshot") return true;
	return row.block.expandable;
}

function renderDelta(delta: CockpitContextDelta, width: number, marker = " "): string {
	return truncateToWidth(
		`${marker} ${theme.fg("accent", "Δ")} ${theme.fg("muted", sanitize(delta.label))} ${theme.fg("dim", `${sanitize(delta.previous ?? "none")} → ${sanitize(delta.current ?? "none")}`)}`,
		width,
	);
}

function renderSnapshotSummary(snapshot: CockpitSnapshotSummary, width: number, marker = " "): string {
	const headroom = snapshot.headroom === null ? "headroom ?" : `${formatTokenCount(snapshot.headroom)} headroom`;
	return truncateToWidth(
		`${marker} ${theme.fg("accent", "◇")} ${theme.fg("muted", sanitize(snapshot.turnId))} ${theme.fg("dim", `${snapshot.messageCount} msgs · ${formatTokenCount(snapshot.messageTokens)} · ${headroom}`)}`,
		width,
	);
}

function renderSection(section: CockpitContextSection, width: number, marker = " "): string {
	const badge = statusBadge(section.status);
	const tokenText =
		section.tokenEstimate === null ? "" : theme.fg("dim", ` ${formatTokenCount(section.tokenEstimate)}`);
	const expandable = section.expandable ? theme.fg("dim", " ↵") : "";
	return truncateToWidth(
		`${marker} ${badge} ${theme.fg("muted", sanitize(section.label))}${tokenText}${expandable} ${theme.fg("dim", sanitize(section.summary))}`,
		width,
	);
}

function renderTimelineBlock(block: CockpitTimelineBlock, width: number, marker = " "): string {
	const badge = statusBadge(statusForTimeline(block.status));
	return truncateToWidth(
		`${marker} ${badge} ${theme.fg("muted", sanitize(block.label))} ${theme.fg("dim", sanitize(block.summary))}`,
		width,
	);
}

function statusForTimeline(
	status: CockpitTimelineBlockStatus,
): CockpitContextStatus | "pending" | "streaming" | "done" | "error" | "skipped" {
	if (status === "info") return "derived";
	if (status === "done") return "included";
	return status;
}

function titleSummary(state: CockpitProjectionState): string {
	const snapshot = state.context.current;
	if (!snapshot) return "waiting for first prompt snapshot";
	return `${snapshot.turnId} · ${snapshot.messages.final.length} msgs · ${formatTokenCount(snapshot.messages.tokenEstimate)}`;
}

function statusBadge(status: CockpitContextStatus | "pending" | "streaming" | "done" | "error" | "skipped"): string {
	switch (status) {
		case "included":
		case "done":
			return theme.fg("success", "●");
		case "compressed":
		case "stubbed":
		case "streaming":
			return theme.fg("warning", "◐");
		case "dropped":
		case "error":
			return theme.fg("error", "●");
		case "derived":
		case "pending":
			return theme.fg("accent", "◆");
		case "unavailable":
		case "skipped":
		case "warning":
			return theme.fg("dim", "○");
	}
}

function line(label: string, value: string, width: number): string {
	return truncateToWidth(`${theme.fg("muted", `${label}:`)} ${sanitize(value)}`, width);
}

function heading(value: string, width: number): string {
	return truncateToWidth(theme.bold(theme.fg("accent", sanitize(value))), width);
}

function warningIcon(severity: "info" | "warning" | "error"): string {
	switch (severity) {
		case "error":
			return theme.fg("error", "!");
		case "warning":
			return theme.fg("warning", "!");
		case "info":
			return theme.fg("accent", "i");
	}
}

function mutedLine(value: string, width: number): string {
	return truncateToWidth(theme.fg("muted", sanitize(value)), width);
}

function dimLine(value: string, width: number): string {
	return truncateToWidth(theme.fg("dim", sanitize(value)), width);
}

function detailLine(value: string, width: number): string {
	return truncateToWidth(`  ${theme.fg("dim", "└")} ${sanitize(value)}`, width);
}

function padToWidth(value: string, width: number): string {
	const missing = Math.max(0, width - visibleWidth(value));
	return missing === 0 ? value : `${value}${" ".repeat(missing)}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function borderLine(width: number): string {
	return theme.fg("dim", theme.boxSharp.horizontal.repeat(Math.max(1, width)));
}

function sanitize(value: string): string {
	return replaceTabs(value).replace(/\s+/g, " ").trim();
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M tok`;
	if (value >= 1_000) return `${trimDecimal(value / 1_000)}K tok`;
	return `${value} tok`;
}

function trimDecimal(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
