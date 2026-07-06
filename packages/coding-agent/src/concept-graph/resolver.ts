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
// Relevance is corpus-derived term informativeness (IDF) with an explicit
// lexical guardrail for high-frequency discourse words. The resolver is backed
// by a global store, so a single weak overlap must never select a fact from an
// unrelated workstream.
const RELEVANCE_SCALE = 10;
const PHRASE_COHESION_BONUS = 0.5;
const RELEVANCE_FLOOR_FACTOR = 1.5;
const MIN_INFORMATIVE_IDF = 0.75;
const REQUIRED_INFORMATIVE_TERM_MATCHES = 2;
const MAX_PHRASE_TOKENS = 5;
const MIN_PHRASE_TOKENS = 2;
interface QueryAnalysis {
	text: string;
	tokens: string[];
	phrases: string[];
}

const STOPWORDS = new Set([
	"about",
	"above",
	"across",
	"after",
	"again",
	"against",
	"already",
	"also",
	"although",
	"always",
	"among",
	"and",
	"another",
	"any",
	"are",
	"around",
	"because",
	"been",
	"before",
	"being",
	"best",
	"between",
	"both",
	"but",
	"can",
	"cannot",
	"could",
	"did",
	"does",
	"doing",
	"done",
	"each",
	"every",
	"exist",
	"exists",
	"for",
	"from",
	"had",
	"has",
	"have",
	"having",
	"into",
	"last",
	"like",
	"may",
	"might",
	"more",
	"must",
	"need",
	"needs",
	"not",
	"often",
	"only",
	"other",
	"over",
	"same",
	"shall",
	"should",
	"since",
	"some",
	"stage",
	"stay",
	"still",
	"such",
	"task",
	"than",
	"that",
	"the",
	"then",
	"there",
	"these",
	"they",
	"this",
	"those",
	"through",
	"turn",
	"under",
	"until",
	"uses",
	"via",
	"was",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"will",
	"with",
	"within",
	"would",
	"you",
	"your",
]);

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
	const candidates = store.listFacts(500);
	const idf = buildIdfModel(candidates);
	return candidates
		.map(fact => scoreFact(fact, query, idf))
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

	const candidates = store.listFacts(500);
	const idf = buildIdfModel(candidates);
	const candidateFacts = candidates
		.map(fact => scoreFact(fact, query, idf))
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

interface IdfModel {
	idf: Map<string, number>;
	/** Mean informativeness per token-occurrence; the relevance floor. */
	floor: number;
}

function factSurface(fact: ConceptFact): string {
	return normalizeSearchText(`${fact.claim} ${fact.normalizedClaim} ${fact.kind} ${fact.authority}`);
}

/**
 * Build corpus-derived term informativeness over the candidate fact set.
 * IDF(t) = log((N+1)/(df(t)+1)): a token in every fact scores ~0, a rare token
 * scores high. The floor is the mean IDF per token-occurrence multiplied by the
 * precision dial, so corpus-common terms outside the stopword list still fail
 * the informative-term bar.
 */
function buildIdfModel(facts: ConceptFact[]): IdfModel {
	const n = facts.length;
	const df = new Map<string, number>();
	for (const fact of facts) {
		for (const token of new Set(tokenize(factSurface(fact)))) {
			df.set(token, (df.get(token) ?? 0) + 1);
		}
	}
	const idf = new Map<string, number>();
	let weightedSum = 0;
	let occurrences = 0;
	for (const [token, count] of df) {
		const weight = Math.log((n + 1) / (count + 1));
		idf.set(token, weight);
		weightedSum += weight * count;
		occurrences += count;
	}
	const floor = (occurrences === 0 ? 0 : weightedSum / occurrences) * RELEVANCE_FLOOR_FACTOR;
	return { idf, floor };
}

function scoreFact(fact: ConceptFact, query: QueryAnalysis, model: IdfModel): ResolvedConceptFact {
	const surface = factSurface(fact);
	const tokenSet = new Set(tokenize(surface));

	const informativeMatches: Array<{ token: string; idf: number }> = [];
	for (const token of new Set(query.tokens)) {
		if (!tokenSet.has(token)) continue;
		const idf = model.idf.get(token) ?? 0;
		if (isInformativeTerm(token, idf, model)) informativeMatches.push({ token, idf });
	}

	const matchedPhrases = query.phrases.filter(phrase => surface.includes(phrase) && phraseQualifies(phrase, model));
	if (matchedPhrases.length === 0 && informativeMatches.length < REQUIRED_INFORMATIVE_TERM_MATCHES) {
		return { fact, score: 0, reason: "no qualifying phrase or informative term set matched" };
	}

	const tokenScore = informativeMatches.reduce((sum, m) => sum + m.idf, 0);
	const phraseScore = matchedPhrases.reduce(
		(sum, phrase) =>
			sum +
			tokenize(phrase).reduce((s, t) => s + Math.max(model.idf.get(t) ?? 0, model.floor), 0) * PHRASE_COHESION_BONUS,
		0,
	);
	const relevance = (tokenScore + phraseScore) * RELEVANCE_SCALE;
	if (relevance < model.floor * RELEVANCE_SCALE) {
		return { fact, score: 0, reason: "match scored below relevance floor" };
	}

	const score =
		relevance + AUTHORITY_RANK[fact.authority] + STATUS_RANK[fact.status] + confidenceBonus(fact.confidence);
	informativeMatches.sort((a, b) => b.idf - a.idf);
	return { fact, score, reason: formatFactMatchReason(informativeMatches, matchedPhrases) };
}

function isInformativeTerm(token: string, idf: number, model: IdfModel): boolean {
	return token.length >= 3 && !STOPWORDS.has(token) && idf >= Math.max(model.floor, MIN_INFORMATIVE_IDF);
}

function phraseQualifies(phrase: string, model: IdfModel): boolean {
	const tokens = tokenize(phrase);
	return (
		tokens.length > 0 &&
		tokens.every(token => !STOPWORDS.has(token)) &&
		tokens.some(token => (model.idf.get(token) ?? 0) >= MIN_INFORMATIVE_IDF)
	);
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

function formatFactMatchReason(matched: Array<{ token: string; idf: number }>, phrases: string[]): string {
	const parts: string[] = [];
	if (phrases.length > 0) parts.push(`phrase ${formatMatches(phrases.slice(0, 3))} matched`);
	const informative = matched.slice(0, 4).map(m => m.token);
	if (informative.length > 0) parts.push(`informative terms ${formatMatches(informative)} matched`);
	return parts.join("; ") || "matched";
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
