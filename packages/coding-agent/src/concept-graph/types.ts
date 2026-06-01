export const CONCEPT_KINDS = [
	"project",
	"system",
	"feature",
	"architecture",
	"workflow",
	"policy",
	"role",
	"term",
	"artifact",
] as const;

export type ConceptKind = (typeof CONCEPT_KINDS)[number];

export const CONCEPT_STATUSES = ["candidate", "active", "merged", "retired"] as const;

export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export const FACT_KINDS = [
	"definition",
	"decision",
	"constraint",
	"assumption",
	"goal",
	"mechanism",
	"ownership",
	"workflow_convention",
	"architecture_boundary",
	"open_question",
	"risk",
	"success_signal",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_STATUSES = ["candidate", "active", "disputed", "stale", "superseded", "retired", "erased"] as const;

export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_AUTHORITIES = [
	"llm_inferred",
	"session_artifact",
	"current_session_artifact",
	"adr",
	"guardrail",
	"outcome",
	"user_confirmed",
	"system_policy",
] as const;

export type FactAuthority = (typeof FACT_AUTHORITIES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const SENSITIVITY_LEVELS = ["public", "project", "private", "sensitive"] as const;

export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

export const LINK_KINDS = [
	"supports",
	"contradicts",
	"supersedes",
	"depends_on",
	"scoped_by",
	"owned_by",
	"evidenced_by",
] as const;

export type ConceptLinkKind = (typeof LINK_KINDS)[number];

export const LINK_STATUSES = ["candidate", "active", "disputed", "retired"] as const;

export type ConceptLinkStatus = (typeof LINK_STATUSES)[number];

export const EVIDENCE_SOURCE_TYPES = [
	"oh_session",
	"adr",
	"guardrail",
	"outcome",
	"user_turn",
	"repo_file",
	"tool_result",
	"manual_note",
] as const;

export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const EVIDENCE_EXTRACTORS = ["llm", "deterministic_parser", "user", "system"] as const;

export type EvidenceExtractor = (typeof EVIDENCE_EXTRACTORS)[number];

export const FACT_EVIDENCE_ROLES = ["source", "supporting", "conflicting", "superseding"] as const;

export type FactEvidenceRole = (typeof FACT_EVIDENCE_ROLES)[number];

export const GRAPH_EVENT_KINDS = [
	"concept_proposed",
	"concept_merged",
	"fact_proposed",
	"fact_updated",
	"fact_promoted",
	"fact_disputed",
	"fact_superseded",
	"fact_retired",
	"fact_erased",
	"link_proposed",
	"link_promoted",
	"link_retired",
] as const;

export type ConceptGraphEventKind = (typeof GRAPH_EVENT_KINDS)[number];

export const GRAPH_EVENT_ACTORS = ["llm", "user", "system"] as const;

export type ConceptGraphEventActor = (typeof GRAPH_EVENT_ACTORS)[number];

export interface ConceptScope {
	repo?: string;
	package?: string;
	session?: string;
	path?: string;
}

export interface Concept {
	id: string;
	kind: ConceptKind;
	canonicalName: string;
	canonicalKey: string;
	aliases: string[];
	description: string | null;
	scope: ConceptScope;
	status: ConceptStatus;
	mergedIntoConceptId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ConceptCreateInput {
	id?: string;
	kind: ConceptKind;
	canonicalName: string;
	canonicalKey: string;
	aliases?: string[];
	description?: string | null;
	scope?: ConceptScope;
	status?: ConceptStatus;
	mergedIntoConceptId?: string | null;
}

export interface ConceptFact {
	id: string;
	kind: FactKind;
	subjectConceptId: string | null;
	claim: string;
	normalizedClaim: string;
	scope: ConceptScope;
	status: FactStatus;
	authority: FactAuthority;
	confidence: ConfidenceLevel;
	sensitivity: SensitivityLevel;
	ownerRef: string | null;
	validFrom: string | null;
	validUntil: string | null;
	supersededByFactId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ConceptFactCreateInput {
	id?: string;
	kind: FactKind;
	subjectConceptId?: string | null;
	claim: string;
	normalizedClaim?: string;
	scope?: ConceptScope;
	status?: FactStatus;
	authority: FactAuthority;
	confidence: ConfidenceLevel;
	sensitivity?: SensitivityLevel;
	ownerRef?: string | null;
	validFrom?: string | null;
	validUntil?: string | null;
	supersededByFactId?: string | null;
	evidenceIds: string[];
	evidenceRole?: FactEvidenceRole;
}

export interface ConceptLink {
	id: string;
	fromFactId: string;
	toFactId: string;
	kind: ConceptLinkKind;
	status: ConceptLinkStatus;
	confidence: ConfidenceLevel;
	rationale: string;
	evidenceIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface ConceptLinkCreateInput {
	id?: string;
	fromFactId: string;
	toFactId: string;
	kind: ConceptLinkKind;
	status?: ConceptLinkStatus;
	confidence: ConfidenceLevel;
	rationale: string;
	evidenceIds: string[];
}

export interface ConceptEvidence {
	id: string;
	sourceType: EvidenceSourceType;
	sourceUri: string;
	locator: string;
	quote: string | null;
	summary: string;
	extractedBy: EvidenceExtractor;
	extractedAt: number;
}

export interface ConceptEvidenceCreateInput {
	id?: string;
	sourceType: EvidenceSourceType;
	sourceUri: string;
	locator: string;
	quote?: string | null;
	summary: string;
	extractedBy: EvidenceExtractor;
	extractedAt?: number;
}

export interface ConceptFactEvidence {
	factId: string;
	evidenceId: string;
	role: FactEvidenceRole;
}

export interface ConceptGraphEvent {
	id: string;
	kind: ConceptGraphEventKind;
	targetId: string;
	actor: ConceptGraphEventActor;
	activity: string;
	rationale: string;
	evidenceIds: string[];
	createdAt: number;
}

export interface ConceptGraphEventCreateInput {
	id?: string;
	kind: ConceptGraphEventKind;
	targetId: string;
	actor: ConceptGraphEventActor;
	activity: string;
	rationale: string;
	evidenceIds?: string[];
	createdAt?: number;
}

export interface ConceptGraphCounts {
	concepts: number;
	facts: number;
	links: number;
	evidence: number;
	events: number;
}
