/**
 * Types for the Prompt Composition Inspector.
 *
 * The inspector projects canonical EffectivePromptSnapshot data into
 * a navigable section-based view for operators.
 */

import type { EffectivePromptSnapshot } from "../../../context/effective-prompt-snapshot";

// ═══════════════════════════════════════════════════════════════════════════
// Section model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Content status for items within the inspector.
 *
 * - `included` — Item is present in the final prompt verbatim.
 * - `stubbed`  — Item is present but with content replaced by a stub.
 * - `dropped`  — Item was removed entirely (budget or policy).
 */
export type ContentStatus = "included" | "stubbed" | "dropped";

/**
 * Identifies the kind of prompt section in the inspector.
 */
export type SectionKind = "budget" | "system-prompt" | "tools" | "messages" | "assembled-context" | "dropped-items";

/**
 * A navigable section within the inspector.
 *
 * The `summary` line appears in the compact list view.
 * The `detail` callback returns full content for drill-down on demand.
 */
export interface InspectorSection {
	/** Section kind (unique identifier). */
	kind: SectionKind;
	/** Display label for the section. */
	label: string;
	/** One-line summary for the compact list view. */
	summary: string;
	/** Item count (e.g., number of tools, messages, fragments). */
	count?: number;
	/** Content status breakdown if applicable. */
	statusCounts?: {
		included: number;
		stubbed: number;
		dropped: number;
	};
	/** Returns rendered detail lines for drill-down. Width-aware. */
	renderDetail: (width: number) => string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Inspector state
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full inspector state derived from a snapshot.
 */
export interface InspectorState {
	/** The source snapshot. */
	snapshot: EffectivePromptSnapshot;
	/** Projected sections in display order. */
	sections: InspectorSection[];
	/** Currently selected section index. */
	selectedIndex: number;
}
