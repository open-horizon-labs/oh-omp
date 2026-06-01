import type * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ConceptGraphStore } from "./store";
import type {
	Concept,
	ConceptCreateInput,
	ConceptEvidence,
	ConceptFact,
	ConceptFactCreateInput,
	ConceptLink,
	ConceptLinkCreateInput,
	EvidenceSourceType,
	FactAuthority,
} from "./types";

export interface OhSessionSection {
	sourceUri: string;
	locator: string;
	heading: string;
	headingPath: string[];
	depth: number;
	body: string;
	startLine: number;
	endLine: number;
	sourceType: EvidenceSourceType;
	authority: FactAuthority;
	promotable: boolean;
}

export interface ProposedConceptCandidate extends Omit<ConceptCreateInput, "id"> {
	localId: string;
	id?: string;
}

export interface ProposedFactCandidate
	extends Omit<ConceptFactCreateInput, "id" | "subjectConceptId" | "evidenceIds" | "authority"> {
	localId: string;
	id?: string;
	authority?: FactAuthority;
	subjectConceptLocalId?: string | null;
	subjectConceptId?: string | null;
}

export interface ProposedLinkCandidate
	extends Omit<ConceptLinkCreateInput, "id" | "fromFactId" | "toFactId" | "evidenceIds"> {
	localId: string;
	id?: string;
	fromFactLocalId: string;
	toFactLocalId: string;
}

export interface IgnoredGraphSeedItem {
	reason: string;
	text: string;
}

export interface ConceptGraphSeedPatch {
	concepts: ProposedConceptCandidate[];
	facts: ProposedFactCandidate[];
	links: ProposedLinkCandidate[];
	ignored: IgnoredGraphSeedItem[];
}

export interface ConceptGraphSeedExtractor {
	extract(section: OhSessionSection): Promise<ConceptGraphSeedPatch>;
}

export interface SeedConceptGraphOptions {
	projectRoot: string;
	ohDir?: string;
	includeNested?: boolean;
	limitFiles?: number;
	limitSections?: number;
}

export interface SeedConceptGraphReport {
	filesScanned: number;
	sectionsParsed: number;
	sectionsExtracted: number;
	conceptsProposed: number;
	factsProposed: number;
	linksProposed: number;
	ignoredItems: number;
	errors: string[];
}

const MARKDOWN_EXTENSION = ".md";
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const HIGH_VALUE_HEADINGS = new Set([
	"aim",
	"problem space",
	"solution space",
	"dissent",
	"recommendation",
	"decision",
	"guardrails",
	"accepted defaults",
	"constraints",
	"implementation notes",
	"salvage",
	"learnings",
]);

export async function seedConceptGraphFromOhArtifacts(
	store: ConceptGraphStore,
	extractor: ConceptGraphSeedExtractor,
	options: SeedConceptGraphOptions,
): Promise<SeedConceptGraphReport> {
	const ohDir = options.ohDir ?? path.join(options.projectRoot, ".oh");
	const files = await listOhMarkdownFiles(ohDir, options.includeNested ?? true, options.limitFiles);
	const report: SeedConceptGraphReport = {
		filesScanned: files.length,
		sectionsParsed: 0,
		sectionsExtracted: 0,
		conceptsProposed: 0,
		factsProposed: 0,
		linksProposed: 0,
		ignoredItems: 0,
		errors: [],
	};

	let sectionCount = 0;
	for (const filePath of files) {
		if (options.limitSections !== undefined && sectionCount >= options.limitSections) break;
		try {
			const content = await Bun.file(filePath).text();
			const sourceUri = path.relative(options.projectRoot, filePath) || filePath;
			const sections = parseOhSessionSections(content, sourceUri);
			report.sectionsParsed += sections.length;
			for (const section of sections) {
				if (options.limitSections !== undefined && sectionCount >= options.limitSections) break;
				sectionCount += 1;
				if (!shouldExtractSection(section)) continue;
				const patch = await extractor.extract(section);
				applySeedPatch(store, section, patch);
				report.sectionsExtracted += 1;
				report.conceptsProposed += patch.concepts.length;
				report.factsProposed += patch.facts.length;
				report.linksProposed += patch.links.length;
				report.ignoredItems += patch.ignored.length;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			report.errors.push(`${filePath}: ${message}`);
			logger.warn("Concept graph seed file failed", { filePath, error: message });
		}
	}
	return report;
}

export async function listOhMarkdownFiles(ohDir: string, includeNested = true, limit?: number): Promise<string[]> {
	const files: string[] = [];
	await collectMarkdownFiles(ohDir, includeNested, files, limit);
	files.sort();
	return files;
}

export function parseOhSessionSections(markdown: string, sourceUri: string): OhSessionSection[] {
	const lines = markdown.split("\n");
	const sections: OhSessionSection[] = [];
	const headingStack: Array<{ depth: number; heading: string }> = [];
	let current: {
		heading: string;
		headingPath: string[];
		depth: number;
		startLine: number;
		bodyLines: string[];
	} | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = line.match(HEADING_PATTERN);
		if (!match) {
			if (current) current.bodyLines.push(line);
			continue;
		}

		if (current) {
			sections.push(sectionFromCurrent(sourceUri, current, index));
		}

		const depth = match[1].length;
		const heading = match[2].trim();
		while (headingStack.length > 0 && headingStack[headingStack.length - 1].depth >= depth) headingStack.pop();
		headingStack.push({ depth, heading });
		current = {
			heading,
			headingPath: headingStack.map(entry => entry.heading),
			depth,
			startLine: index + 1,
			bodyLines: [],
		};
	}

	if (current) sections.push(sectionFromCurrent(sourceUri, current, lines.length));
	return sections.filter(section => section.body.trim().length > 0 || shouldExtractSection(section));
}

export function classifyOhSourceType(sourceUri: string): EvidenceSourceType {
	if (sourceUri.startsWith("docs/adr/") || sourceUri.includes("/adr/")) return "adr";
	if (sourceUri.startsWith(".oh/guardrails/") || sourceUri.includes("/guardrails/")) return "guardrail";
	if (sourceUri.startsWith(".oh/outcomes/") || sourceUri.includes("/outcomes/")) return "outcome";
	return "oh_session";
}

export function classifySectionAuthority(section: Pick<OhSessionSection, "sourceType" | "headingPath" | "sourceUri">): {
	authority: FactAuthority;
	promotable: boolean;
} {
	if (section.sourceType === "adr") return { authority: "adr", promotable: true };
	if (section.sourceType === "guardrail") return { authority: "guardrail", promotable: true };
	if (section.sourceType === "outcome") return { authority: "outcome", promotable: true };
	const headings = section.headingPath.map(normalizeHeading);
	const last = headings[headings.length - 1] ?? "";
	const currentSession = section.sourceUri === ".oh/conceptual-fact-store.md";
	if (currentSession && (last === "accepted defaults" || last === "decision" || last === "dissent")) {
		return { authority: "current_session_artifact", promotable: true };
	}
	return { authority: "session_artifact", promotable: false };
}

export function shouldExtractSection(section: OhSessionSection): boolean {
	const headings = section.headingPath.map(normalizeHeading);
	return headings.some(heading => HIGH_VALUE_HEADINGS.has(heading));
}

export function applySeedPatch(
	store: ConceptGraphStore,
	section: OhSessionSection,
	patch: ConceptGraphSeedPatch,
): { concepts: Concept[]; facts: ConceptFact[]; links: ConceptLink[]; evidence: ConceptEvidence } {
	const evidence = store.upsertEvidence({
		sourceType: section.sourceType,
		sourceUri: section.sourceUri,
		locator: section.locator,
		quote: section.body.slice(0, 2_000) || null,
		summary: `Seed evidence from ${section.headingPath.join(" > ")}`,
		extractedBy: "llm",
	});
	const conceptIds = new Map<string, string>();
	const factIds = new Map<string, string>();
	const concepts: Concept[] = [];
	const facts: ConceptFact[] = [];
	const links: ConceptLink[] = [];

	for (const proposed of patch.concepts) {
		const concept = store.upsertConcept(
			{
				...proposed,
				id: proposed.id ?? stableId("concept", proposed.canonicalKey),
			},
			{
				actor: "llm",
				activity: "seed concept",
				rationale: `Extracted from ${section.locator}`,
				evidenceIds: [evidence.id],
			},
		);
		conceptIds.set(proposed.localId, concept.id);
		concepts.push(concept);
	}

	for (const proposed of patch.facts) {
		const subjectConceptId =
			proposed.subjectConceptId ?? resolveOptionalLocalId(conceptIds, proposed.subjectConceptLocalId);
		const status = proposed.status ?? (section.promotable ? "active" : "candidate");
		const authority = proposed.authority ?? section.authority;
		const fact = store.upsertFact(
			{
				...proposed,
				id: proposed.id ?? stableId("fact", `${section.locator}:${proposed.localId}`),
				subjectConceptId,
				status,
				authority,
				evidenceIds: [evidence.id],
			},
			{
				actor: "llm",
				activity: "seed fact",
				rationale: `Extracted from ${section.locator}`,
				evidenceIds: [evidence.id],
			},
		);
		factIds.set(proposed.localId, fact.id);
		facts.push(fact);
	}

	for (const proposed of patch.links) {
		const fromFactId = requireLocalId(factIds, proposed.fromFactLocalId, "fromFactLocalId");
		const toFactId = requireLocalId(factIds, proposed.toFactLocalId, "toFactLocalId");
		const link = store.upsertLink(
			{
				...proposed,
				id: proposed.id ?? stableId("link", `${fromFactId}:${proposed.kind}:${toFactId}`),
				fromFactId,
				toFactId,
				evidenceIds: [evidence.id],
			},
			{
				actor: "llm",
				activity: "seed link",
				rationale: `Extracted from ${section.locator}`,
				evidenceIds: [evidence.id],
			},
		);
		links.push(link);
	}

	return { concepts, facts, links, evidence };
}

function sectionFromCurrent(
	sourceUri: string,
	current: { heading: string; headingPath: string[]; depth: number; startLine: number; bodyLines: string[] },
	endLine: number,
): OhSessionSection {
	const sourceType = classifyOhSourceType(sourceUri);
	const authority = classifySectionAuthority({ sourceType, sourceUri, headingPath: current.headingPath });
	return {
		sourceUri,
		locator: `${sourceUri}#${current.headingPath.map(slugify).join("/")}`,
		heading: current.heading,
		headingPath: current.headingPath,
		depth: current.depth,
		body: current.bodyLines.join("\n").trim(),
		startLine: current.startLine,
		endLine,
		sourceType,
		authority: authority.authority,
		promotable: authority.promotable,
	};
}

async function collectMarkdownFiles(
	dir: string,
	includeNested: boolean,
	files: string[],
	limit: number | undefined,
): Promise<void> {
	if (limit !== undefined && files.length >= limit) return;
	let entries: fsNode.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		logger.debug("Concept graph seed directory unavailable", { dir, error: String(error) });
		return;
	}
	for (const entry of entries) {
		if (limit !== undefined && files.length >= limit) return;
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (includeNested) await collectMarkdownFiles(entryPath, includeNested, files, limit);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)) files.push(entryPath);
	}
}

function normalizeHeading(value: string): string {
	return value.trim().toLowerCase();
}

function slugify(value: string): string {
	return normalizeHeading(value)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function stableId(prefix: string, key: string): string {
	const encoded = key
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 96);
	return `${prefix}-${encoded || crypto.randomUUID()}`;
}

function resolveOptionalLocalId(ids: Map<string, string>, localId: string | null | undefined): string | null {
	if (!localId) return null;
	return requireLocalId(ids, localId, "subjectConceptLocalId");
}

function requireLocalId(ids: Map<string, string>, localId: string, label: string): string {
	const id = ids.get(localId);
	if (!id) throw new Error(`Seed patch references unknown ${label}: ${localId}`);
	return id;
}
