import { type FactOmission, type FactResolveOptions, resolveActiveFacts } from "./resolver";
import type { FactAssertion } from "./schema";

export const DEFAULT_KNOWN_FACTS_MAX_FACTS = 5;
export const DEFAULT_KNOWN_FACTS_MAX_CHARS = 2000;

export interface KnownFactsFormatOptions extends FactResolveOptions {
	maxFacts?: number;
	maxChars?: number;
	now?: Date;
}

export interface KnownFactsFormatResult {
	text: string;
	selected: FactAssertion[];
	omitted: FactOmission[];
	estimatedChars: number;
}

export function formatKnownFactsBlock(
	facts: readonly FactAssertion[],
	options: KnownFactsFormatOptions = {},
): KnownFactsFormatResult {
	const now = options.now ?? new Date(options.nowMs ?? Date.now());
	const maxFacts = normalizePositiveInteger(options.maxFacts, DEFAULT_KNOWN_FACTS_MAX_FACTS);
	const maxChars = normalizePositiveInteger(options.maxChars, DEFAULT_KNOWN_FACTS_MAX_CHARS);
	const resolved = resolveActiveFacts(facts, { ...options, nowMs: now.getTime() });
	const selected: FactAssertion[] = [];
	const omitted: FactOmission[] = [...resolved.omitted];

	const lines = [
		`<known-facts as_of="${escapeXml(now.toISOString())}" precedence="current user instructions, repo state, runtime output, and explicit corrections outrank stored facts">`,
	];
	let charCount = lines[0]?.length ?? 0;

	for (const fact of resolved.active) {
		if (selected.length >= maxFacts) {
			omitted.push({ id: fact.id, reason: "max_facts" });
			continue;
		}
		const rendered = renderFact(fact);
		const projected = charCount + rendered.length + "\n</known-facts>".length;
		if (projected > maxChars) {
			omitted.push({ id: fact.id, reason: "max_chars" });
			continue;
		}
		lines.push(rendered);
		charCount += rendered.length;
		selected.push(fact);
	}

	lines.push("</known-facts>");
	const text = selected.length === 0 ? "" : lines.join("\n");
	return {
		text,
		selected,
		omitted,
		estimatedChars: text.length,
	};
}

function renderFact(fact: FactAssertion): string {
	const attrs = [
		formatAttr("id", fact.id),
		formatAttr("kind", fact.kind),
		formatAttr("subject", fact.subject),
		formatAttr("predicate", fact.predicate),
		formatAttr("confidence", fact.confidence.toFixed(2)),
		formatAttr("observed_at", fact.temporal.observedAt),
		formatAttr("source", fact.source.kind),
	];
	if (fact.temporal.effectiveFrom) attrs.push(formatAttr("effective_from", fact.temporal.effectiveFrom));
	if (fact.temporal.effectiveUntil) attrs.push(formatAttr("effective_until", fact.temporal.effectiveUntil));
	if (fact.supersedes.length > 0) attrs.push(formatAttr("supersedes", fact.supersedes.join(",")));
	return `  <fact ${attrs.join(" ")}>${escapeXml(fact.canonicalText)}</fact>`;
}

function formatAttr(name: string, value: string): string {
	return `${name}="${escapeXml(value)}"`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value ?? fallback)) return fallback;
	return Math.max(0, Math.floor(value ?? fallback));
}
