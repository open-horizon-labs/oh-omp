import {
	buildFactConflictKey,
	type FactAssertion,
	type FactSensitivity,
	type FactSourceKind,
	MIN_ACTIVE_FACT_CONFIDENCE,
} from "./schema";

export interface FactResolveOptions {
	nowMs?: number;
	minConfidence?: number;
	includePersonal?: boolean;
	includeSensitive?: boolean;
	includeDisputed?: boolean;
}

export interface FactResolutionResult {
	active: FactAssertion[];
	omitted: FactOmission[];
}

export interface FactOmission {
	id: string;
	reason:
		| "status"
		| "expired"
		| "low_confidence"
		| "personal"
		| "sensitive"
		| "secret"
		| "superseded_by_selected"
		| "max_facts"
		| "max_chars";
	detail?: string;
}

const SOURCE_AUTHORITY: Record<FactSourceKind, number> = {
	user: 6,
	manual: 5,
	document: 4,
	tool: 3,
	assistant: 2,
	memory_extraction: 1,
};

export function resolveActiveFacts(
	facts: readonly FactAssertion[],
	options: FactResolveOptions = {},
): FactResolutionResult {
	const nowMs = options.nowMs ?? Date.now();
	const minConfidence = options.minConfidence ?? MIN_ACTIVE_FACT_CONFIDENCE;
	const omitted: FactOmission[] = [];
	const grouped = new Map<string, FactAssertion[]>();

	for (const fact of facts) {
		const omitReason = getBaseOmissionReason(fact, { ...options, minConfidence, nowMs });
		if (omitReason) {
			omitted.push(omitReason);
			continue;
		}
		const key = buildFactConflictKey(fact);
		const list = grouped.get(key) ?? [];
		list.push(fact);
		grouped.set(key, list);
	}

	const active: FactAssertion[] = [];
	for (const group of grouped.values()) {
		const selected = [...group].sort(compareFactAuthority)[0];
		if (!selected) continue;
		active.push(selected);
		for (const fact of group) {
			if (fact.id === selected.id) continue;
			omitted.push({ id: fact.id, reason: "superseded_by_selected", detail: selected.id });
		}
	}

	active.sort(compareFactAuthority);
	return { active, omitted };
}

export function isFactExpired(fact: FactAssertion, nowMs: number = Date.now()): boolean {
	const expiresAt = fact.temporal.expiresAt ?? fact.temporal.effectiveUntil;
	if (!expiresAt) return false;
	const expiresMs = Date.parse(expiresAt);
	return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

export function compareFactAuthority(a: FactAssertion, b: FactAssertion): number {
	const sourceDelta = sourceAuthority(b.source.kind) - sourceAuthority(a.source.kind);
	if (sourceDelta !== 0) return sourceDelta;

	const confidenceDelta = b.confidence - a.confidence;
	if (Math.abs(confidenceDelta) >= 0.0001) return confidenceDelta;

	return b.updatedAt - a.updatedAt;
}

function getBaseOmissionReason(
	fact: FactAssertion,
	options: FactResolveOptions & { minConfidence: number; nowMs: number },
): FactOmission | null {
	if (fact.status === "disputed" && !options.includeDisputed) {
		return { id: fact.id, reason: "status", detail: fact.status };
	}
	if (fact.status !== "active" && fact.status !== "disputed") {
		return { id: fact.id, reason: "status", detail: fact.status };
	}
	if (isFactExpired(fact, options.nowMs)) {
		return { id: fact.id, reason: "expired" };
	}
	if (fact.confidence < options.minConfidence) {
		return { id: fact.id, reason: "low_confidence", detail: String(fact.confidence) };
	}
	return getSensitivityOmissionReason(fact.id, fact.sensitivity, options);
}

function getSensitivityOmissionReason(
	id: string,
	sensitivity: FactSensitivity,
	options: FactResolveOptions,
): FactOmission | null {
	if (sensitivity === "secret") return { id, reason: "secret" };
	if (sensitivity === "sensitive" && !options.includeSensitive) return { id, reason: "sensitive" };
	if (sensitivity === "personal" && !options.includePersonal) return { id, reason: "personal" };
	return null;
}

function sourceAuthority(kind: FactSourceKind): number {
	return SOURCE_AUTHORITY[kind] ?? 0;
}
