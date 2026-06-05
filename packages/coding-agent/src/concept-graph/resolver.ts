import type { ConceptGraphStore } from "./store";
import type { ConceptFact, ConceptLink, FactAuthority, FactStatus } from "./types";

export interface ConceptGraphSearchInput {
	query: string;
	limit?: number;
	includeCandidates?: boolean;
}

export interface ResolvedConceptFact {
	fact: ConceptFact;
	score: number;
	reason: string;
}

export interface ResolvedConceptLink {
	link: ConceptLink;
	from: ConceptFact;
	to: ConceptFact;
	reason: string;
}

export type ConceptGraphNeighborDirection = "incoming" | "outgoing" | "both";

export interface ResolveConceptNeighborsInput {
	factId: string;
	depth?: number;
	limit?: number;
	direction?: ConceptGraphNeighborDirection;
	linkKind?: ConceptLink["kind"];
	includeCandidates?: "none" | "conflicts-only" | "relevant-uncertainty";
}

export interface ResolvedConceptNeighbors {
	root: ConceptFact;
	facts: ConceptFact[];
	links: ResolvedConceptLink[];
	omitted: string[];
	depth: number;
	tokenEstimate: number;
	rationale: string;
	markdown: string;
}

export interface ResolveConceptContextInput {
	task: string;
	maxFacts?: number;
	maxLinks?: number;
	maxDepth?: number;
	includeCandidates?: "none" | "conflicts-only" | "relevant-uncertainty";
}

export interface ResolvedConceptContext {
	facts: ResolvedConceptFact[];
	links: ResolvedConceptLink[];
	omitted: string[];
	conflicts: ResolvedConceptLink[];
	tokenEstimate: number;
	rationale: string;
	markdown: string;
}

const DEFAULT_MAX_FACTS = 20;
const DEFAULT_MAX_LINKS = 6;
const MAX_FACTS = 20;
const MAX_LINKS = 10;
const MAX_DEPTH = 1;
const MAX_NEIGHBOR_DEPTH = 2;
const MAX_NEIGHBOR_LINKS = 25;
const PHRASE_MATCH_SCORE = 35;
const TOKEN_MATCH_SCORE = 10;
const GENERIC_TOKEN_MATCH_SCORE = 2;
const MAX_PHRASE_TOKENS = 5;
const MIN_PHRASE_TOKENS = 2;

const GENERIC_TOKENS = new Set([
	"agent",
	"agents",
	"concept",
	"concepts",
	"context",
	"contexts",
	"fact",
	"facts",
	"graph",
	"graphs",
	"memory",
	"project",
	"session",
	"sessions",
	"task",
	"tool",
	"tools",
	"user",
	"users",
	"work",
]);

interface QueryAnalysis {
	text: string;
	tokens: string[];
	phrases: string[];
}

const AUTHORITY_RANK: Record<FactAuthority, number> = {
	system_policy: 100,
	adr: 90,
	guardrail: 85,
	current_session_artifact: 80,
	user_confirmed: 75,
	outcome: 70,
	session_artifact: 45,
	llm_inferred: 20,
};

const STATUS_RANK: Record<FactStatus, number> = {
	active: 50,
	candidate: 15,
	disputed: -30,
	stale: -20,
	superseded: -40,
	retired: -50,
	erased: -100,
};

export function searchConceptFacts(store: ConceptGraphStore, input: ConceptGraphSearchInput): ResolvedConceptFact[] {
	const query = analyzeQuery(input.query);
	const limit = clamp(input.limit ?? DEFAULT_MAX_FACTS, 1, MAX_FACTS);
	if (query.tokens.length === 0) return [];
	const includeCandidates = input.includeCandidates ?? false;
	return store
		.listFacts(500)
		.map(fact => scoreFact(fact, query))
		.filter(result => result.score > 0)
		.filter(result => includeCandidates || result.fact.status === "active")
		.sort(compareResolvedFacts)
		.slice(0, limit);
}

export function resolveConceptContext(
	store: ConceptGraphStore,
	input: ResolveConceptContextInput,
): ResolvedConceptContext {
	const maxFacts = clamp(input.maxFacts ?? DEFAULT_MAX_FACTS, 1, MAX_FACTS);
	const maxLinks = clamp(input.maxLinks ?? DEFAULT_MAX_LINKS, 0, MAX_LINKS);
	const maxDepth = clamp(input.maxDepth ?? MAX_DEPTH, 0, MAX_DEPTH);
	const includeCandidates = input.includeCandidates ?? "relevant-uncertainty";
	const query = analyzeQuery(input.task);
	const omitted: string[] = [];

	if (query.tokens.length === 0) {
		return emptyContext("No task terms were available for concept graph resolution.");
	}

	const candidateFacts = store
		.listFacts(500)
		.map(fact => scoreFact(fact, query))
		.filter(result => result.score > 0)
		.filter(result => shouldIncludeFact(result.fact, includeCandidates))
		.sort(compareResolvedFacts);
	const facts = candidateFacts.slice(0, maxFacts);
	if (candidateFacts.length > facts.length)
		omitted.push(`${candidateFacts.length - facts.length} matching facts omitted by maxFacts=${maxFacts}`);

	const selectedIds = new Set(facts.map(result => result.fact.id));
	const linkCandidates =
		maxDepth === 0
			? []
			: collectLinks(
					store,
					facts.map(result => result.fact),
					selectedIds,
				);
	const conflicts = linkCandidates.filter(
		result => (result.link.kind === "contradicts" || result.link.kind === "supersedes") && isLiveLink(result.link),
	);
	const links = linkCandidates
		.filter(result => isLiveLink(result.link))
		.sort(compareResolvedLinks)
		.slice(0, maxLinks);
	if (linkCandidates.length > links.length)
		omitted.push(`${linkCandidates.length - links.length} links omitted by maxLinks=${maxLinks}`);

	const context: Omit<ResolvedConceptContext, "markdown" | "tokenEstimate"> = {
		facts,
		links,
		omitted,
		conflicts,
		rationale: `Resolved ${facts.length} fact(s) and ${links.length} link(s) for query terms: ${query.tokens.join(", ")}`,
	};
	const markdown = formatResolvedConceptContext({ ...context, tokenEstimate: 0, markdown: "" });
	return { ...context, tokenEstimate: estimateTokens(markdown), markdown };
}

export function resolveConceptNeighbors(
	store: ConceptGraphStore,
	input: ResolveConceptNeighborsInput,
): ResolvedConceptNeighbors | null {
	const root = store.getFact(input.factId);
	if (!root || root.status === "erased" || root.status === "retired") return null;

	const depth = clamp(input.depth ?? 1, 1, MAX_NEIGHBOR_DEPTH);
	const limit = clamp(input.limit ?? DEFAULT_MAX_LINKS, 1, MAX_NEIGHBOR_LINKS);
	const direction = input.direction ?? "both";
	const includeCandidates = input.includeCandidates ?? "relevant-uncertainty";
	const omitted: string[] = [];
	const seenLinkIds = new Set<string>();
	const seenFactIds = new Set<string>([root.id]);
	const neighborFacts: ConceptFact[] = [];
	const links: ResolvedConceptLink[] = [];
	let frontier = [root.id];

	for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0 && links.length < limit; currentDepth += 1) {
		const nextFrontier: string[] = [];
		for (const factId of frontier) {
			for (const link of store.listLinksForFact(factId, limit * 4)) {
				if (links.length >= limit) break;
				if (seenLinkIds.has(link.id)) continue;
				if (!shouldIncludeNeighborLink(link, includeCandidates)) continue;
				if (input.linkKind && link.kind !== input.linkKind) continue;
				if (!linkMatchesDirection(link, factId, direction)) continue;

				const from = store.getFact(link.fromFactId);
				const to = store.getFact(link.toFactId);
				if (!from || !to) continue;
				if (!shouldIncludeFact(from, includeCandidates) || !shouldIncludeFact(to, includeCandidates)) continue;

				seenLinkIds.add(link.id);
				links.push({ link, from, to, reason: `Depth ${currentDepth} ${direction} neighbor` });

				const otherId = link.fromFactId === factId ? link.toFactId : link.fromFactId;
				const other = otherId === from.id ? from : to;
				if (!seenFactIds.has(other.id)) {
					seenFactIds.add(other.id);
					neighborFacts.push(other);
					nextFrontier.push(other.id);
				}
			}
		}
		frontier = nextFrontier;
	}

	const reachableLinkCount = countReachableNeighborLinks(
		store,
		root.id,
		depth,
		direction,
		input.linkKind,
		includeCandidates,
	);
	if (reachableLinkCount > links.length)
		omitted.push(`${reachableLinkCount - links.length} neighbor links omitted by limit=${limit}`);

	const sortedLinks = [...links].sort(compareResolvedLinks);
	const context: Omit<ResolvedConceptNeighbors, "markdown" | "tokenEstimate"> = {
		root,
		facts: neighborFacts,
		links: sortedLinks,
		omitted,
		depth,
		rationale: `Resolved ${neighborFacts.length} neighbor fact(s) and ${sortedLinks.length} link(s) from ${root.id}`,
	};
	const markdown = formatResolvedConceptNeighbors({ ...context, tokenEstimate: 0, markdown: "" });
	return { ...context, tokenEstimate: estimateTokens(markdown), markdown };
}

export function formatResolvedConceptNeighbors(context: ResolvedConceptNeighbors): string {
	const lines = ["## Concept Graph Neighbors", "", "Root:"];
	lines.push(
		`- ${context.root.id} [${context.root.status}][${context.root.kind}][${context.root.authority}] ${context.root.claim}`,
	);

	if (context.links.length === 0) {
		lines.push("", `No neighbor links resolved within depth ${context.depth}.`);
	} else {
		lines.push("", "Neighbors:");
		for (const result of context.links) {
			lines.push(
				`- [${result.link.status}][${result.link.kind}] ${result.from.id} -> ${result.to.id}: ${result.link.rationale}`,
			);
			const neighbor = result.from.id === context.root.id ? result.to : result.from;
			lines.push(
				`  Neighbor: ${neighbor.id} [${neighbor.status}][${neighbor.kind}][${neighbor.authority}] ${neighbor.claim}`,
			);
		}
	}

	if (context.omitted.length > 0) {
		lines.push("", "### Omitted");
		for (const item of context.omitted) lines.push(`- ${item}`);
	}

	return lines.join("\n");
}

export function formatResolvedConceptContext(context: ResolvedConceptContext): string {
	if (context.facts.length === 0 && context.links.length === 0)
		return "## Concept Graph Context\n\nNo relevant concept graph facts resolved.";
	const lines = ["## Concept Graph Context", ""];
	for (const result of context.facts) {
		const fact = result.fact;
		lines.push(`- [${fact.status}][${fact.kind}][${fact.authority}] ${fact.claim}`);
		lines.push(`  Fact: ${fact.id}; confidence: ${fact.confidence}; reason: ${result.reason}`);
	}
	if (context.links.length > 0) {
		lines.push("", "### Links");
		for (const result of context.links) {
			lines.push(
				`- [${result.link.status}][${result.link.kind}] ${result.from.id} -> ${result.to.id}: ${result.link.rationale}`,
			);
		}
	}
	if (context.conflicts.length > 0) {
		lines.push("", "### Conflicts / Supersessions");
		for (const result of context.conflicts.slice(0, 4)) {
			lines.push(`- [${result.link.kind}] ${result.from.id} -> ${result.to.id}: ${result.link.rationale}`);
		}
	}
	if (context.omitted.length > 0) {
		lines.push("", "### Omitted");
		for (const item of context.omitted) lines.push(`- ${item}`);
	}
	return lines.join("\n");
}

function collectLinks(store: ConceptGraphStore, facts: ConceptFact[], selectedIds: Set<string>): ResolvedConceptLink[] {
	const byId = new Map(facts.map(fact => [fact.id, fact]));
	const seen = new Set<string>();
	const results: ResolvedConceptLink[] = [];
	for (const fact of facts) {
		for (const link of store.listLinksForFact(fact.id, 25)) {
			if (seen.has(link.id)) continue;
			seen.add(link.id);
			const from = byId.get(link.fromFactId) ?? store.getFact(link.fromFactId);
			const to = byId.get(link.toFactId) ?? store.getFact(link.toFactId);
			if (!from || !to) continue;
			const touchesSelected = selectedIds.has(link.fromFactId) || selectedIds.has(link.toFactId);
			if (!touchesSelected) continue;
			results.push({ link, from, to, reason: "Link touches a selected fact" });
		}
	}
	return results;
}

function scoreFact(fact: ConceptFact, query: QueryAnalysis): ResolvedConceptFact {
	const surface = normalizeSearchText(`${fact.claim} ${fact.normalizedClaim} ${fact.kind} ${fact.authority}`);
	const tokenSet = new Set(tokenize(surface));
	const matchedPhrases = query.phrases.filter(phrase => surface.includes(phrase));
	const matchedSpecificTokens: string[] = [];
	const matchedGenericTokens: string[] = [];

	for (const token of query.tokens) {
		if (!tokenSet.has(token)) continue;
		if (GENERIC_TOKENS.has(token)) matchedGenericTokens.push(token);
		else matchedSpecificTokens.push(token);
	}

	const matchScore =
		matchedPhrases.length * PHRASE_MATCH_SCORE +
		matchedSpecificTokens.length * TOKEN_MATCH_SCORE +
		matchedGenericTokens.length * GENERIC_TOKEN_MATCH_SCORE;
	if (matchScore === 0 || (matchedPhrases.length === 0 && matchedSpecificTokens.length === 0))
		return { fact, score: 0, reason: "no specific query terms matched" };

	const score =
		matchScore + AUTHORITY_RANK[fact.authority] + STATUS_RANK[fact.status] + confidenceBonus(fact.confidence);
	return { fact, score, reason: formatFactMatchReason(matchedPhrases, matchedSpecificTokens, matchedGenericTokens) };
}

function shouldIncludeFact(
	fact: ConceptFact,
	includeCandidates: ResolveConceptContextInput["includeCandidates"],
): boolean {
	if (fact.status === "erased" || fact.status === "retired") return false;
	if (fact.status === "active") return true;
	if (includeCandidates === "none") return false;
	if (includeCandidates === "conflicts-only") return fact.status === "disputed" || fact.status === "superseded";
	return (
		fact.status === "candidate" ||
		fact.status === "disputed" ||
		fact.status === "stale" ||
		fact.status === "superseded"
	);
}

function compareResolvedFacts(a: ResolvedConceptFact, b: ResolvedConceptFact): number {
	return (
		statusBucket(b.fact) - statusBucket(a.fact) ||
		b.score - a.score ||
		b.fact.updatedAt - a.fact.updatedAt ||
		a.fact.id.localeCompare(b.fact.id)
	);
}

function statusBucket(fact: ConceptFact): number {
	if (fact.status === "active") return 2;
	if (fact.status === "candidate") return 1;
	return 0;
}

function countReachableNeighborLinks(
	store: ConceptGraphStore,
	rootId: string,
	depth: number,
	direction: ConceptGraphNeighborDirection,
	linkKind: ConceptLink["kind"] | undefined,
	includeCandidates: ResolveConceptNeighborsInput["includeCandidates"],
): number {
	const seenLinkIds = new Set<string>();
	const seenFactIds = new Set<string>([rootId]);
	let frontier = [rootId];
	for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0; currentDepth += 1) {
		const nextFrontier: string[] = [];
		for (const factId of frontier) {
			for (const link of store.listLinksForFact(factId, MAX_NEIGHBOR_LINKS * 4)) {
				if (seenLinkIds.has(link.id)) continue;
				if (!shouldIncludeNeighborLink(link, includeCandidates)) continue;
				if (linkKind && link.kind !== linkKind) continue;
				if (!linkMatchesDirection(link, factId, direction)) continue;
				const from = store.getFact(link.fromFactId);
				const to = store.getFact(link.toFactId);
				if (!from || !to) continue;
				if (!shouldIncludeFact(from, includeCandidates) || !shouldIncludeFact(to, includeCandidates)) continue;
				seenLinkIds.add(link.id);
				const otherId = link.fromFactId === factId ? link.toFactId : link.fromFactId;
				if (!seenFactIds.has(otherId)) {
					seenFactIds.add(otherId);
					nextFrontier.push(otherId);
				}
			}
		}
		frontier = nextFrontier;
	}
	return seenLinkIds.size;
}

function linkMatchesDirection(link: ConceptLink, factId: string, direction: ConceptGraphNeighborDirection): boolean {
	if (direction === "incoming") return link.toFactId === factId;
	if (direction === "outgoing") return link.fromFactId === factId;
	return link.fromFactId === factId || link.toFactId === factId;
}

function shouldIncludeNeighborLink(
	link: ConceptLink,
	includeCandidates: ResolveConceptNeighborsInput["includeCandidates"],
): boolean {
	if (link.status === "retired") return false;
	if (link.status === "active") return true;
	if (includeCandidates === "none") return false;
	if (includeCandidates === "conflicts-only") return link.kind === "contradicts" || link.kind === "supersedes";
	return link.status === "candidate" || link.status === "disputed";
}

function compareResolvedLinks(a: ResolvedConceptLink, b: ResolvedConceptLink): number {
	return (
		linkRank(b.link) - linkRank(a.link) || b.link.updatedAt - a.link.updatedAt || a.link.id.localeCompare(b.link.id)
	);
}

function isLiveLink(link: ConceptLink): boolean {
	return link.status === "active" || link.status === "candidate";
}

function linkRank(link: ConceptLink): number {
	const kindRank = link.kind === "contradicts" || link.kind === "supersedes" ? 20 : 0;
	const statusRank = link.status === "active" ? 10 : link.status === "candidate" ? 5 : -10;
	return kindRank + statusRank + confidenceBonus(link.confidence);
}

function confidenceBonus(confidence: "low" | "medium" | "high"): number {
	if (confidence === "high") return 8;
	if (confidence === "medium") return 4;
	return 0;
}

function analyzeQuery(value: string): QueryAnalysis {
	const text = normalizeSearchText(value);
	const tokens = tokenize(text);
	return { text, tokens, phrases: queryPhrases(tokens) };
}

function queryPhrases(tokens: string[]): string[] {
	const phrases: string[] = [];
	const seen = new Set<string>();
	for (let size = Math.min(MAX_PHRASE_TOKENS, tokens.length); size >= MIN_PHRASE_TOKENS; size -= 1) {
		for (let index = 0; index <= tokens.length - size; index += 1) {
			const phraseTokens = tokens.slice(index, index + size);
			const phrase = phraseTokens.join(" ");
			if (seen.has(phrase)) continue;
			seen.add(phrase);
			phrases.push(phrase);
		}
	}
	return phrases;
}

function formatFactMatchReason(phrases: string[], specificTokens: string[], genericTokens: string[]): string {
	const parts: string[] = [];
	if (phrases.length > 0) parts.push(`phrase ${formatMatches(phrases.slice(0, 3))} matched`);
	if (specificTokens.length > 0) parts.push(`specific token ${formatMatches(specificTokens.slice(0, 5))} matched`);
	if (genericTokens.length > 0) parts.push(`generic token ${formatMatches(genericTokens.slice(0, 4))} weakly matched`);
	return parts.join("; ");
}

function formatMatches(values: string[]): string {
	return values.map(value => `"${value}"`).join(", ");
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenize(value: string): string[] {
	return Array.from(
		new Set(
			value
				.toLowerCase()
				.split(/[^a-z0-9_]+/)
				.map(token => token.trim())
				.filter(token => token.length >= 3),
		),
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.floor(value), min), max);
}

function estimateTokens(markdown: string): number {
	return Math.ceil(markdown.length / 4);
}

function emptyContext(rationale: string): ResolvedConceptContext {
	const markdown = "## Concept Graph Context\n\nNo relevant concept graph facts resolved.";
	return {
		facts: [],
		links: [],
		omitted: [],
		conflicts: [],
		tokenEstimate: estimateTokens(markdown),
		rationale,
		markdown,
	};
}
