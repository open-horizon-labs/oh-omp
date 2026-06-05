import {
	type ConceptGraphStore,
	formatResolvedConceptContext,
	type ResolvedConceptContext,
	resolveConceptContext,
} from "../concept-graph";

export type ConceptGraphCandidatePolicy = "none" | "conflicts-only" | "relevant-uncertainty";

export interface ResolveConceptGraphContextOptions {
	task: string;
	maxFacts?: number;
	maxLinks?: number;
	maxTokens?: number;
	includeCandidates?: ConceptGraphCandidatePolicy;
}

export interface ConceptGraphContextInjection {
	text: string;
	context: ResolvedConceptContext;
	factIds: string[];
	linkIds: string[];
	tokenEstimate: number;
}

const DEFAULT_MAX_FACTS = 20;
const DEFAULT_MAX_LINKS = 6;
const DEFAULT_MAX_TOKENS = 1_200;
const INSPECTION_AFFORDANCE =
	"Inspect/correct with concept_graph: explain_fact, mark_fact_disputed, retire_fact, propose_fact, or propose_link using the ids below.";

export function resolveConceptGraphInjection(
	store: ConceptGraphStore,
	options: ResolveConceptGraphContextOptions,
): ConceptGraphContextInjection | null {
	const task = options.task.trim();
	if (task.length === 0) return null;

	const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
	let maxFacts = Math.max(1, Math.floor(options.maxFacts ?? DEFAULT_MAX_FACTS));
	let maxLinks = Math.max(0, Math.floor(options.maxLinks ?? DEFAULT_MAX_LINKS));
	let context = resolveConceptContext(store, {
		task,
		maxFacts,
		maxLinks,
		maxDepth: 1,
		includeCandidates: options.includeCandidates ?? "relevant-uncertainty",
	});
	let text = formatConceptGraphInjection(context);
	let tokenEstimate = estimateTokens(text);

	while (tokenEstimate > maxTokens && (maxLinks > 0 || maxFacts > 1)) {
		if (maxLinks > 0) {
			maxLinks -= 1;
		} else {
			maxFacts -= 1;
		}
		context = resolveConceptContext(store, {
			task,
			maxFacts,
			maxLinks,
			maxDepth: 1,
			includeCandidates: options.includeCandidates ?? "relevant-uncertainty",
		});
		text = formatConceptGraphInjection(context);
		tokenEstimate = estimateTokens(text);
	}

	if (context.facts.length === 0 && context.links.length === 0) return null;
	if (tokenEstimate > maxTokens) return null;

	return {
		text,
		context,
		factIds: context.facts.map(result => result.fact.id),
		linkIds: context.links.map(result => result.link.id),
		tokenEstimate,
	};
}

function formatConceptGraphInjection(context: ResolvedConceptContext): string {
	return [
		"<concept_graph_context>",
		formatResolvedConceptContext(context),
		"",
		INSPECTION_AFFORDANCE,
		"</concept_graph_context>",
	].join("\n");
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
