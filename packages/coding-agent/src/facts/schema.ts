export const FACT_KINDS = [
	"user_preference",
	"project_decision",
	"project_constraint",
	"date_deadline",
	"ownership",
	"environment_tooling",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_STATUSES = ["active", "superseded", "retracted", "disputed", "expired", "erased"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_SCOPE_KINDS = ["global", "project", "session", "task", "external"] as const;
export type FactScopeKind = (typeof FACT_SCOPE_KINDS)[number];

export const FACT_SOURCE_KINDS = ["user", "assistant", "tool", "document", "memory_extraction", "manual"] as const;
export type FactSourceKind = (typeof FACT_SOURCE_KINDS)[number];

export const FACT_SENSITIVITIES = ["normal", "personal", "sensitive", "secret"] as const;
export type FactSensitivity = (typeof FACT_SENSITIVITIES)[number];

export const DEFAULT_FACT_CONFIDENCE = 0.98;
export const MIN_ACTIVE_FACT_CONFIDENCE = 0.5;

const factKindSet = new Set<string>(FACT_KINDS);
const factStatusSet = new Set<string>(FACT_STATUSES);
const factScopeKindSet = new Set<string>(FACT_SCOPE_KINDS);
const factSourceKindSet = new Set<string>(FACT_SOURCE_KINDS);
const factSensitivitySet = new Set<string>(FACT_SENSITIVITIES);

export interface FactScope {
	kind: FactScopeKind;
	projectCwd?: string;
	repoRemote?: string;
	branch?: string;
	sessionId?: string;
	taskId?: string;
	externalId?: string;
}

export interface FactTemporal {
	observedAt: string;
	effectiveFrom?: string;
	effectiveUntil?: string;
	expiresAt?: string;
	asOf?: string;
}

export interface FactSource {
	kind: FactSourceKind;
	sessionId?: string;
	turn?: number;
	locator?: string;
}

export interface FactEvidence {
	locator: string;
	quote?: string;
}

export interface FactAssertion {
	id: string;
	kind: FactKind;
	subject: string;
	predicate: string;
	object: unknown;
	canonicalText: string;
	scope: FactScope;
	temporal: FactTemporal;
	status: FactStatus;
	confidence: number;
	source: FactSource;
	evidence: FactEvidence[];
	supersedes: string[];
	tags: string[];
	sensitivity: FactSensitivity;
	createdAt: number;
	updatedAt: number;
}

export interface NewFactAssertionInput {
	kind: FactKind;
	subject: string;
	predicate: string;
	object: unknown;
	canonicalText: string;
	scope: FactScope;
	temporal?: Partial<FactTemporal>;
	confidence?: number;
	source?: Partial<FactSource>;
	evidence?: FactEvidence[];
	supersedes?: string[];
	tags?: string[];
	sensitivity?: FactSensitivity;
	id?: string;
	nowMs?: number;
}

export function isFactKind(value: unknown): value is FactKind {
	return typeof value === "string" && factKindSet.has(value);
}

export function isFactStatus(value: unknown): value is FactStatus {
	return typeof value === "string" && factStatusSet.has(value);
}

export function isFactScopeKind(value: unknown): value is FactScopeKind {
	return typeof value === "string" && factScopeKindSet.has(value);
}

export function isFactSourceKind(value: unknown): value is FactSourceKind {
	return typeof value === "string" && factSourceKindSet.has(value);
}

export function isFactSensitivity(value: unknown): value is FactSensitivity {
	return typeof value === "string" && factSensitivitySet.has(value);
}

export function normalizeFactSubject(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function normalizeFactPredicate(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

export function normalizeScope(scope: FactScope): FactScope {
	if (!isFactScopeKind(scope.kind)) {
		throw new Error(`Invalid fact scope kind: ${String(scope.kind)}`);
	}
	return {
		kind: scope.kind,
		projectCwd: normalizeOptionalString(scope.projectCwd),
		repoRemote: normalizeOptionalString(scope.repoRemote),
		branch: normalizeOptionalString(scope.branch),
		sessionId: normalizeOptionalString(scope.sessionId),
		taskId: normalizeOptionalString(scope.taskId),
		externalId: normalizeOptionalString(scope.externalId),
	};
}

export function buildScopeKey(scope: FactScope): string {
	const normalized = normalizeScope(scope);
	return [
		normalized.kind,
		normalized.projectCwd ?? "",
		normalized.repoRemote ?? "",
		normalized.branch ?? "",
		normalized.sessionId ?? "",
		normalized.taskId ?? "",
		normalized.externalId ?? "",
	].join("|");
}

export function buildFactConflictKey(assertion: Pick<FactAssertion, "subject" | "predicate" | "scope">): string {
	return `${assertion.subject}\u0000${assertion.predicate}\u0000${buildScopeKey(assertion.scope)}`;
}

export function createFactAssertion(input: NewFactAssertionInput): FactAssertion {
	if (!isFactKind(input.kind)) {
		throw new Error(`Invalid fact kind: ${String(input.kind)}`);
	}
	const subject = normalizeFactSubject(input.subject);
	if (!subject) throw new Error("Fact subject is required.");

	const predicate = normalizeFactPredicate(input.predicate);
	if (!predicate) throw new Error("Fact predicate is required.");

	const canonicalText = input.canonicalText.trim().replace(/\s+/g, " ");
	if (!canonicalText) throw new Error("Fact canonical text is required.");

	const sensitivity = input.sensitivity ?? defaultSensitivityForKind(input.kind);
	if (!isFactSensitivity(sensitivity)) {
		throw new Error(`Invalid fact sensitivity: ${String(sensitivity)}`);
	}
	if (sensitivity === "secret") {
		throw new Error("Secret facts must not be stored.");
	}

	const confidence = input.confidence ?? DEFAULT_FACT_CONFIDENCE;
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
		throw new Error("Fact confidence must be a finite number between 0 and 1.");
	}

	const nowMs = input.nowMs ?? Date.now();
	const observedAt = input.temporal?.observedAt ?? new Date(nowMs).toISOString();
	const sourceKind = input.source?.kind ?? "manual";
	if (!isFactSourceKind(sourceKind)) {
		throw new Error(`Invalid fact source kind: ${String(sourceKind)}`);
	}

	return {
		id: input.id ?? `fact_${crypto.randomUUID()}`,
		kind: input.kind,
		subject,
		predicate,
		object: input.object,
		canonicalText,
		scope: normalizeScope(input.scope),
		temporal: {
			observedAt,
			effectiveFrom: normalizeOptionalString(input.temporal?.effectiveFrom),
			effectiveUntil: normalizeOptionalString(input.temporal?.effectiveUntil),
			expiresAt: normalizeOptionalString(input.temporal?.expiresAt),
			asOf: normalizeOptionalString(input.temporal?.asOf),
		},
		status: "active",
		confidence,
		source: {
			kind: sourceKind,
			sessionId: normalizeOptionalString(input.source?.sessionId),
			turn: input.source?.turn,
			locator: normalizeOptionalString(input.source?.locator),
		},
		evidence: normalizeEvidence(input.evidence ?? []),
		supersedes: normalizeStringArray(input.supersedes ?? []),
		tags: normalizeStringArray(input.tags ?? []),
		sensitivity,
		createdAt: nowMs,
		updatedAt: nowMs,
	};
}

export function defaultSensitivityForKind(kind: FactKind): FactSensitivity {
	return kind === "user_preference" ? "personal" : "normal";
}

export function normalizeEvidence(evidence: FactEvidence[]): FactEvidence[] {
	return evidence
		.map(item => ({
			locator: item.locator.trim(),
			quote: normalizeOptionalString(item.quote),
		}))
		.filter(item => item.locator.length > 0)
		.map(item => {
			if (!item.quote) return { locator: item.locator };
			return { locator: item.locator, quote: item.quote.slice(0, 500) };
		});
}

function normalizeStringArray(values: string[]): string[] {
	return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
