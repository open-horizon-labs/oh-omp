/**
 * PromptInspector - Compact prompt composition inspector with drill-down.
 *
 * Layout:
 * - Top: Title + turn/timestamp info
 * - Body: 2-column grid (section list | detail panel)
 * - Bottom: Navigation hints
 *
 * Navigation:
 * - Up/Down/j/k: Navigate section list
 * - Esc: Close inspector
 */

import {
	type Component,
	Container,
	matchesKey,
	padding,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

import type { EffectivePromptSnapshot } from "../../../context/effective-prompt-snapshot";
import { theme } from "../../theme/theme";
import { DynamicBorder } from "../dynamic-border";
import { DetailPanel } from "./detail-panel";
import { projectSnapshot, renderStatusCounts } from "./projection";
import type { InspectorSection, InspectorState } from "./types";

export class PromptInspector extends Container {
	#state: InspectorState | null = null;
	#detailPanel: DetailPanel;
	#terminalHeight: number;

	onClose?: () => void;

	constructor(snapshot: EffectivePromptSnapshot | null, terminalHeight?: number) {
		super();
		this.#terminalHeight = terminalHeight ?? process.stdout.rows ?? 24;
		this.#detailPanel = new DetailPanel();

		if (snapshot) {
			this.setSnapshot(snapshot);
		} else {
			this.#buildEmptyLayout();
		}
	}

	setSnapshot(snapshot: EffectivePromptSnapshot): void {
		const sections = projectSnapshot(snapshot);
		this.#state = {
			snapshot,
			sections,
			selectedIndex: 0,
		};
		this.#detailPanel.setSection(sections[0] ?? null);
		this.#buildLayout();
	}

	#buildEmptyLayout(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Prompt Composition Inspector")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", " No prompt snapshot available yet."), 0, 0));
		this.addChild(new Text(theme.fg("dim", " Run a prompt to capture composition data."), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", " Esc: close"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	#buildLayout(): void {
		this.clear();

		const state = this.#state;
		if (!state) {
			this.#buildEmptyLayout();
			return;
		}

		// Top border
		this.addChild(new DynamicBorder());

		// Title with turn info
		const turnInfo = theme.fg("dim", ` Turn ${state.snapshot.turnId} \u2502 ${state.snapshot.capturedAt}`);
		this.addChild(new Text(theme.bold(theme.fg("accent", " Prompt Composition Inspector")) + turnInfo, 0, 0));

		this.addChild(new Spacer(1));

		// 2-column body
		const bodyMaxHeight = Math.max(5, this.#terminalHeight - 8);
		const sectionList = new SectionListPane(state.sections, state.selectedIndex);
		this.addChild(new TwoColumnBody(sectionList, this.#detailPanel, bodyMaxHeight));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", " \u2191/\u2193: navigate sections  Esc: close"), 0, 0));

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		// Ctrl+C — close immediately
		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}

		// Escape — close
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.onClose?.();
			return;
		}

		if (!this.#state) return;

		const sections = this.#state.sections;
		if (sections.length === 0) return;

		// Up/k — previous section
		if (matchesKey(data, "up") || data === "k") {
			this.#state.selectedIndex = Math.max(0, this.#state.selectedIndex - 1);
			this.#detailPanel.setSection(sections[this.#state.selectedIndex]);
			this.#buildLayout();
			return;
		}

		// Down/j — next section
		if (matchesKey(data, "down") || data === "j") {
			this.#state.selectedIndex = Math.min(sections.length - 1, this.#state.selectedIndex + 1);
			this.#detailPanel.setSection(sections[this.#state.selectedIndex]);
			this.#buildLayout();
			return;
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Section list pane
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Left pane: compact list of prompt sections with status indicators.
 */
class SectionListPane implements Component {
	constructor(
		private readonly sections: InspectorSection[],
		private readonly selectedIndex: number,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.sections.length === 0) {
			lines.push(theme.fg("dim", "No sections"));
			return lines;
		}

		for (let i = 0; i < this.sections.length; i++) {
			const section = this.sections[i];
			const isSelected = i === this.selectedIndex;

			// Selection indicator
			const cursor = isSelected ? theme.fg("accent", "\u25b6 ") : "  ";

			// Label
			const label = isSelected ? theme.bold(theme.fg("accent", section.label)) : theme.fg("muted", section.label);

			// Status counts badge (if applicable)
			let badge = "";
			if (section.statusCounts) {
				badge = ` ${renderStatusCounts(section.statusCounts)}`;
			} else if (section.count !== undefined) {
				badge = theme.fg("dim", ` (${section.count})`);
			}

			lines.push(truncateToWidth(`${cursor}${label}${badge}`, width));

			// Summary line (indented)
			const summaryLine = `    ${theme.fg("dim", section.summary)}`;
			lines.push(truncateToWidth(summaryLine, width));

			// Add spacing between sections (except the last)
			if (i < this.sections.length - 1) {
				lines.push("");
			}
		}

		return lines;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Two-column body
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Two-column body component for side-by-side rendering.
 */
class TwoColumnBody implements Component {
	constructor(
		private readonly leftPane: SectionListPane,
		private readonly rightPane: DetailPanel,
		private readonly maxHeight: number,
	) {}

	render(width: number): string[] {
		const leftWidth = Math.floor(width * 0.35);
		const rightWidth = Math.max(0, width - leftWidth - 3);

		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);

		// Limit to maxHeight lines
		const numLines = Math.min(this.maxHeight, Math.max(leftLines.length, rightLines.length));
		const combined: string[] = [];
		const separator = theme.fg("dim", ` ${theme.boxSharp.vertical} `);

		for (let i = 0; i < numLines; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			combined.push(leftPadded + separator + right);
		}

		return combined;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}
