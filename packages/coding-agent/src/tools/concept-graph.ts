import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import {
	type ConceptEvidence,
	ConceptGraphStore,
	FACT_KINDS,
	formatResolvedConceptContext,
	formatResolvedConceptNeighbors,
	LINK_KINDS,
	resolveConceptContext,
	resolveConceptNeighbors,
	searchConceptFacts,
} from "../concept-graph";
import type { ToolSession } from ".";

const conceptGraphSchema = Type.Object({
	action: StringEnum(
		[
			"search",
			"explain_fact",
			"resolve_context",
			"neighbors",
			"propose_fact",
			"propose_link",
			"mark_fact_disputed",
			"retire_fact",
			"retire_link",
		] as const,
		{ description: "Concept graph operation to run" },
	),
	query: Type.Optional(Type.String({ description: "Search query for action=search" })),
	task: Type.Optional(Type.String({ description: "Current task text for action=resolve_context" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results for search (default 6, max 10)" })),
	max_facts: Type.Optional(Type.Number({ description: "Max facts for resolve_context (default 6, max 10)" })),
	max_links: Type.Optional(Type.Number({ description: "Max links for resolve_context (default 6, max 10)" })),
	depth: Type.Optional(Type.Number({ description: "Traversal depth for action=neighbors (default 1, max 2)" })),
	direction: Type.Optional(
		StringEnum(["incoming", "outgoing", "both"] as const, {
			description: "Link direction for action=neighbors",
		}),
	),
	include_candidates: Type.Optional(
		StringEnum(["none", "conflicts-only", "relevant-uncertainty"] as const, {
			description: "Whether resolver can include candidate/stale/disputed uncertainty",
		}),
	),
	fact_id: Type.Optional(Type.String({ description: "Fact id for explain, neighbors, or fact lifecycle operations" })),
	link_id: Type.Optional(Type.String({ description: "Link id for link lifecycle operations" })),
	fact_kind: Type.Optional(StringEnum(FACT_KINDS, { description: "Fact kind for propose_fact" })),
	link_kind: Type.Optional(
		StringEnum(LINK_KINDS, { description: "Link kind for propose_link or neighbors filtering" }),
	),
	claim: Type.Optional(Type.String({ description: "Fact claim for propose_fact" })),
	confidence: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Confidence level" })),
	authority: Type.Optional(
		StringEnum(
			[
				"llm_inferred",
				"session_artifact",
				"current_session_artifact",
				"adr",
				"guardrail",
				"outcome",
				"user_confirmed",
				"system_policy",
			] as const,
			{ description: "Fact authority for propose_fact" },
		),
	),
	status: Type.Optional(
		StringEnum(["candidate", "active"] as const, { description: "Initial status for proposed facts/links" }),
	),
	from_fact_id: Type.Optional(Type.String({ description: "Source fact id for propose_link" })),
	to_fact_id: Type.Optional(Type.String({ description: "Target fact id for propose_link" })),
	rationale: Type.Optional(Type.String({ description: "Rationale for proposals or lifecycle updates" })),
	superseded_by_fact_id: Type.Optional(
		Type.String({ description: "Replacement fact id when marking a fact superseded" }),
	),
	evidence_id: Type.Optional(Type.String({ description: "Existing evidence id to attach" })),
	source_type: Type.Optional(
		StringEnum(
			["oh_session", "adr", "guardrail", "outcome", "user_turn", "repo_file", "tool_result", "manual_note"] as const,
			{
				description: "Evidence source type when creating evidence inline",
			},
		),
	),
	source_uri: Type.Optional(Type.String({ description: "Evidence source URI/path when creating evidence inline" })),
	locator: Type.Optional(Type.String({ description: "Evidence locator/section when creating evidence inline" })),
	summary: Type.Optional(Type.String({ description: "Evidence summary when creating evidence inline" })),
	quote: Type.Optional(Type.String({ description: "Optional evidence quote when creating evidence inline" })),
});

type ConceptGraphParams = Static<typeof conceptGraphSchema>;

export interface ConceptGraphToolDetails {
	action: ConceptGraphParams["action"];
	ids?: string[];
	count?: number;
}

const sharedStores = new Map<string, ConceptGraphStore>();

export class ConceptGraphTool implements AgentTool<typeof conceptGraphSchema, ConceptGraphToolDetails> {
	readonly name = "concept_graph";
	readonly label = "Concept Graph";
	readonly description = "Search, explain, propose, update, and resolve bounded concept graph facts with provenance.";
	readonly parameters = conceptGraphSchema;
	readonly strict = true;

	#dbPath: string;

	constructor(session: ToolSession) {
		this.#dbPath = path.join(session.settings.getAgentDir(), "concept-graph.db");
	}

	async execute(_toolCallId: string, params: ConceptGraphParams): Promise<AgentToolResult<ConceptGraphToolDetails>> {
		try {
			switch (params.action) {
				case "search":
					return this.#search(params);
				case "explain_fact":
					return this.#explainFact(params);
				case "neighbors":
					return this.#neighbors(params);
				case "resolve_context":
					return this.#resolveContext(params);
				case "propose_fact":
					return this.#proposeFact(params);
				case "propose_link":
					return this.#proposeLink(params);
				case "mark_fact_disputed":
					return this.#updateFact(params, "disputed");
				case "retire_fact":
					return this.#updateFact(params, "retired");
				case "retire_link":
					return this.#retireLink(params);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Concept graph error: ${message}` }],
				details: { action: params.action },
			};
		}
	}

	#getStore(): ConceptGraphStore {
		const existing = sharedStores.get(this.#dbPath);
		if (existing) return existing;
		const store = ConceptGraphStore.open(this.#dbPath);
		sharedStores.set(this.#dbPath, store);
		return store;
	}

	#search(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const query = requireParam(params.query, "query");
		const includeCandidates = params.include_candidates !== "none";
		const results = searchConceptFacts(this.#getStore(), { query, limit: params.limit, includeCandidates });
		if (results.length === 0)
			return {
				content: [{ type: "text", text: "No concept graph facts matched." }],
				details: { action: params.action, count: 0 },
			};
		const lines = results.map(result => {
			const fact = result.fact;
			return `- ${fact.id} [${fact.status}][${fact.kind}][${fact.authority}] ${fact.claim}\n  score: ${result.score}; ${result.reason}`;
		});
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: params.action, ids: results.map(result => result.fact.id), count: results.length },
		};
	}

	#explainFact(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const factId = requireParam(params.fact_id, "fact_id");
		const fact = this.#getStore().getFact(factId);
		if (!fact)
			return {
				content: [{ type: "text", text: `No concept graph fact found: ${factId}` }],
				details: { action: params.action, count: 0 },
			};
		const evidenceRows = this.#getStore().listFactEvidence(fact.id);
		const evidence = evidenceRows
			.map(row => this.#getStore().getEvidence(row.evidenceId))
			.filter((item): item is ConceptEvidence => item !== null);
		const links = this.#getStore().listLinksForFact(fact.id, 20);
		const lines = [
			`Fact ${fact.id}`,
			`[${fact.status}][${fact.kind}][${fact.authority}][${fact.confidence}] ${fact.claim}`,
			"",
			"Evidence:",
			...evidence.map(item => `- ${item.id} [${item.sourceType}] ${item.locator}: ${item.summary}`),
			"",
			"Links:",
			...(links.length === 0
				? ["- none"]
				: links.map(
						link =>
							`- ${link.id} [${link.status}][${link.kind}] ${link.fromFactId} -> ${link.toFactId}: ${link.rationale}`,
					)),
		];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: params.action, ids: [fact.id], count: 1 },
		};
	}

	#neighbors(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const factId = requireParam(params.fact_id, "fact_id");
		const neighbors = resolveConceptNeighbors(this.#getStore(), {
			factId,
			depth: params.depth,
			limit: params.limit,
			direction: params.direction,
			linkKind: params.link_kind,
			includeCandidates: params.include_candidates,
		});
		if (!neighbors)
			return {
				content: [{ type: "text", text: `No concept graph fact found for neighbors: ${factId}` }],
				details: { action: params.action, count: 0 },
			};
		return {
			content: [{ type: "text", text: formatResolvedConceptNeighbors(neighbors) }],
			details: {
				action: params.action,
				ids: [
					neighbors.root.id,
					...neighbors.facts.map(fact => fact.id),
					...neighbors.links.map(result => result.link.id),
				],
				count: neighbors.links.length,
			},
		};
	}

	#resolveContext(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const task = requireParam(params.task, "task");
		const context = resolveConceptContext(this.#getStore(), {
			task,
			maxFacts: params.max_facts,
			maxLinks: params.max_links,
			includeCandidates: params.include_candidates,
		});
		return {
			content: [{ type: "text", text: formatResolvedConceptContext(context) }],
			details: {
				action: params.action,
				ids: context.facts.map(result => result.fact.id),
				count: context.facts.length,
			},
		};
	}

	#proposeFact(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const evidenceId = this.#ensureEvidence(params).id;
		const authority = params.authority ?? "llm_inferred";
		const fact = this.#getStore().upsertFact(
			{
				kind: requireParam(params.fact_kind, "fact_kind"),
				claim: requireParam(params.claim, "claim"),
				status: authority === "llm_inferred" ? "candidate" : (params.status ?? "candidate"),
				authority,
				confidence: params.confidence ?? "medium",
				evidenceIds: [evidenceId],
			},
			{
				actor: "llm",
				activity: "propose fact",
				rationale: params.rationale ?? "LLM proposed fact",
				evidenceIds: [evidenceId],
			},
		);
		return {
			content: [{ type: "text", text: `Proposed fact ${fact.id}: ${fact.claim}` }],
			details: { action: params.action, ids: [fact.id], count: 1 },
		};
	}

	#proposeLink(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const evidenceId = this.#ensureEvidence(params).id;
		const link = this.#getStore().upsertLink(
			{
				fromFactId: requireParam(params.from_fact_id, "from_fact_id"),
				toFactId: requireParam(params.to_fact_id, "to_fact_id"),
				kind: requireParam(params.link_kind, "link_kind"),
				status: params.status ?? "candidate",
				confidence: params.confidence ?? "medium",
				rationale: requireParam(params.rationale, "rationale"),
				evidenceIds: [evidenceId],
			},
			{
				actor: "llm",
				activity: "propose link",
				rationale: params.rationale ?? "LLM proposed link",
				evidenceIds: [evidenceId],
			},
		);
		return {
			content: [
				{ type: "text", text: `Proposed link ${link.id}: ${link.fromFactId} -[${link.kind}]-> ${link.toFactId}` },
			],
			details: { action: params.action, ids: [link.id], count: 1 },
		};
	}

	#updateFact(params: ConceptGraphParams, status: "disputed" | "retired"): AgentToolResult<ConceptGraphToolDetails> {
		const fact = this.#getStore().updateFactStatus(requireParam(params.fact_id, "fact_id"), status, {
			rationale: requireParam(params.rationale, "rationale"),
			supersededByFactId: params.superseded_by_fact_id,
		});
		return {
			content: [{ type: "text", text: `Updated fact ${fact.id} to ${fact.status}.` }],
			details: { action: params.action, ids: [fact.id], count: 1 },
		};
	}

	#retireLink(params: ConceptGraphParams): AgentToolResult<ConceptGraphToolDetails> {
		const link = this.#getStore().updateLinkStatus(requireParam(params.link_id, "link_id"), "retired", {
			rationale: requireParam(params.rationale, "rationale"),
		});
		return {
			content: [{ type: "text", text: `Retired link ${link.id}.` }],
			details: { action: params.action, ids: [link.id], count: 1 },
		};
	}

	#ensureEvidence(params: ConceptGraphParams): ConceptEvidence {
		if (params.evidence_id) {
			const evidence = this.#getStore().getEvidence(params.evidence_id);
			if (!evidence) throw new Error(`Evidence not found: ${params.evidence_id}`);
			return evidence;
		}
		return this.#getStore().upsertEvidence({
			sourceType: requireParam(params.source_type, "source_type"),
			sourceUri: requireParam(params.source_uri, "source_uri"),
			locator: requireParam(params.locator, "locator"),
			quote: params.quote ?? null,
			summary: requireParam(params.summary, "summary"),
			extractedBy: "llm",
		});
	}
}

function requireParam<T extends string>(value: T | undefined, name: string): T {
	if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
	return value.trim() as T;
}
