/**
 * Compiles a system prompt by calling an LLM with the meta-prompt,
 * environment inventory, and session-scoped guidance library. Caches
 * results on input hash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { loadManagedPolicy, resolvePolicyEnforcementMode } from "../../security/policy.js";

import type { ManagedPolicyIntegrity, PolicyEnforcementMode } from "../../security/types.js";
import { buildInventory, type InventoryInput } from "./inventory.js";
import { collectGuidanceLibrary } from "./library.js";

import metaPromptContent from "./meta-prompt.md" with { type: "text" };

export interface CompileOptions {
	/** Active session model to compile with */
	model: Model;
	/** Session-authenticated API key/token for the active model */
	apiKey: string;
	/** Environment data for inventory building */
	inventory: InventoryInput;
	/** Project context files content */
	contextFiles: string;
	/** Invariant rules that must appear verbatim */
	invariants: string;
	/** Target token budget for the compiled prompt */
	tokenBudget: number;
	/** Skip cache and recompile */
	noCache?: boolean;
}

export interface CompileResult {
	/** The compiled system prompt */
	systemPrompt: string;
	/** Which model compiled it */
	modelId: string;
	/** Compilation duration in milliseconds */
	durationMs: number;
	/** Whether this was served from cache */
	cacheHit: boolean;
}

const CACHE_DIR = path.join(getAgentDir(), "cache", "composer");
const COMPILED_PROMPT_TAG = "compiled-system-prompt";
const MANAGED_INTEGRITY_CACHE_REASON = "managed-integrity-requires-fresh-compilation";

export async function compileSystemPrompt(options: CompileOptions): Promise<CompileResult> {
	const { model, apiKey, inventory, contextFiles, invariants, tokenBudget, noCache } = options;

	const inventoryText = buildInventory(inventory);
	logger.debug("composer: inventory built", {
		inventoryLength: inventoryText.length,
		toolCount: inventory.tools.length,
		skillCount: inventory.skills.length,
		editMode: inventory.editMode,
	});

	const library = collectGuidanceLibrary({
		activeToolNames: inventory.tools.map(tool => tool.name),
		editMode: inventory.editMode,
	});
	logger.debug("composer: guidance library collected", {
		toolDocsLength: library.toolDocs.length,
		editModeGuidanceLength: library.editModeGuidance.length,
		additionalGuidanceLength: library.additionalGuidance.length,
	});

	const cacheInput = [
		metaPromptContent,
		inventoryText,
		library.toolDocs,
		library.editModeGuidance,
		library.additionalGuidance,
		contextFiles,
		invariants,
		String(tokenBudget),
		`${model.provider}/${model.id}`,
	].join("\n---\n");

	const cacheKey = Bun.hash(cacheInput).toString(36);
	const cachePath = path.join(CACHE_DIR, `${cacheKey}.txt`);
	const managedPolicyResult = await loadManagedPolicy();
	const cacheDisabledForIntegrity = shouldDisableCompiledPromptCache(
		managedPolicyResult.policy?.document.integrity,
		resolvePolicyEnforcementMode(managedPolicyResult.policy),
	);
	const cacheEnabled = !noCache && !cacheDisabledForIntegrity;

	logger.debug("composer: checking cache", {
		cachePath,
		noCache: !!noCache,
		integrityCacheBypass: cacheDisabledForIntegrity,
	});
	if (cacheEnabled) {
		try {
			const cached = await Bun.file(cachePath).text();
			validateCompiledPrompt(cached, invariants);
			logger.debug("composer: cache hit", { cacheKey, outputLength: cached.length });
			return {
				systemPrompt: cached,
				modelId: `${model.provider}/${model.id}`,
				durationMs: 0,
				cacheHit: true,
			};
		} catch (err) {
			logger.debug("composer: cache miss or invalid", {
				cacheKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} else if (cacheDisabledForIntegrity) {
		logger.debug("composer: cache bypassed", {
			cacheKey,
			reason: MANAGED_INTEGRITY_CACHE_REASON,
		});
	}

	const userMessage = buildCompilationMessage({
		inventoryText,
		toolDocs: library.toolDocs,
		editModeGuidance: library.editModeGuidance,
		additionalGuidance: library.additionalGuidance,
		contextFiles,
		invariants,
		tokenBudget,
	});
	logger.debug("composer: compilation message built", {
		messageLength: userMessage.length,
		contextFilesLength: contextFiles.length,
		invariantsLength: invariants.length,
		tokenBudget,
	});

	const start = performance.now();
	logger.debug("composer: compiling system prompt", {
		model: `${model.provider}/${model.id}`,
		cacheKey,
	});

	let response: AssistantMessage;
	try {
		response = await completeSimple(
			model,
			{
				systemPrompt: metaPromptContent,
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{ apiKey, maxTokens: tokenBudget },
		);
	} catch (err) {
		logger.error("composer: compilation failed", {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			model: `${model.provider}/${model.id}`,
			cacheKey,
		});
		throw err;
	}

	const durationMs = Math.round(performance.now() - start);
	logger.debug("composer: response received", {
		contentBlockCount: response.content.length,
	});

	let systemPrompt = extractCompiledPrompt(response);
	if (!systemPrompt) {
		logger.error("composer: response text extraction failed", {
			contentBlockCount: response.content.length,
		});
		throw new Error("composer: compilation produced empty output");
	}
	try {
		validateCompiledPrompt(systemPrompt, invariants);
	} catch {
		logger.warn("composer: invariants missing from compiled prompt, appending");
		systemPrompt = `${systemPrompt}\n\n${invariants}`;
	}

	logger.debug("composer: compiled", {
		durationMs,
		outputLength: systemPrompt.length,
		cacheKey,
	});

	if (cacheDisabledForIntegrity) {
		logger.debug("composer: skipping cache write", {
			cachePath,
			reason: MANAGED_INTEGRITY_CACHE_REASON,
		});
	} else {
		logger.debug("composer: writing cache", { cachePath, outputLength: systemPrompt.length });
		try {
			await fs.promises.mkdir(CACHE_DIR, { recursive: true });
			await Bun.write(cachePath, systemPrompt);
			logger.debug("composer: cache written", { cachePath });
		} catch (err) {
			logger.warn("composer: cache write failed", {
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}
	}

	return {
		systemPrompt,
		modelId: `${model.provider}/${model.id}`,
		durationMs,
		cacheHit: false,
	};
}

function shouldDisableCompiledPromptCache(
	integrity: ManagedPolicyIntegrity | undefined,
	enforcementMode: PolicyEnforcementMode,
): boolean {
	if (enforcementMode !== "enforce" || !integrity) return false;
	return integrity.requireSignedManagedPolicy === true || integrity.disableUnsignedUserCodeLoad === true;
}

function buildCompilationMessage(input: {
	inventoryText: string;
	toolDocs: string;
	editModeGuidance: string;
	additionalGuidance: string;
	contextFiles: string;
	invariants: string;
	tokenBudget: number;
}): string {
	const sections = [
		"Compile a system prompt for a coding agent session.\n",
		"## Environment Inventory\n",
		input.inventoryText,
	];

	if (input.toolDocs) {
		sections.push("\n## Guidance Library — Active Tool Documentation\n", input.toolDocs);
	}

	if (input.editModeGuidance) {
		sections.push("\n## Guidance Library — Active Edit Mode\n", input.editModeGuidance);
	}

	if (input.additionalGuidance) {
		sections.push("\n## Guidance Library — Working Guidance\n", input.additionalGuidance);
	}

	sections.push("\n## Invariants (MUST include verbatim)\n", input.invariants);

	if (input.contextFiles) {
		sections.push(
			"\n## Project Context\n",
			"These are project-specific rules and conventions. Include them in the compiled prompt.\n",
			input.contextFiles,
		);
	}

	sections.push(
		`\n## Budget\n\nTarget: approximately ${input.tokenBudget} tokens. This is a guideline, not a hard limit. Prioritize completeness over brevity, but do not pad.`,
	);

	return sections.join("\n");
}

function extractCompiledPrompt(message: { content: Array<{ type: string; text?: string }> }): string {
	const text = extractText(message);
	if (!text) return "";

	const match = text.match(new RegExp(`<${COMPILED_PROMPT_TAG}>\\s*([\\s\\S]*?)\\s*</${COMPILED_PROMPT_TAG}>`, "i"));
	if (!match?.[1]) {
		throw new Error(`composer: compilation response missing <${COMPILED_PROMPT_TAG}> wrapper`);
	}
	return match[1].trim();
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}

function validateCompiledPrompt(systemPrompt: string, invariants: string): void {
	const normalizedPrompt = normalizePromptText(systemPrompt);
	if (!normalizedPrompt) {
		throw new Error("composer: compilation produced empty output");
	}

	const normalizedInvariants = normalizePromptText(invariants);
	if (normalizedInvariants && !normalizedPrompt.includes(normalizedInvariants)) {
		throw new Error("composer: compiled prompt omitted invariants");
	}
}

function normalizePromptText(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}
