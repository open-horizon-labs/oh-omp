import { getAgentDir } from "@oh-my-pi/pi-utils";
import { formatKnownFactsBlock } from "../facts/prompt-format";
import {
	FACT_KINDS,
	FACT_SCOPE_KINDS,
	FACT_SENSITIVITIES,
	type FactAssertion,
	type FactScope,
	type FactScopeKind,
	type FactSensitivity,
	isFactKind,
	isFactScopeKind,
	isFactSensitivity,
} from "../facts/schema";
import { FactStore, getFactsDbPath } from "../facts/storage";

export type FactsAction = "add" | "view" | "search" | "explain" | "retract" | "erase" | "path" | "prompt";

export interface FactsCommandArgs {
	action: FactsAction;
	values: string[];
	flags: {
		json?: boolean;
		all?: boolean;
		scope?: string;
		sensitivity?: string;
		canonical?: string;
		limit?: number;
		db?: string;
		includePersonal?: boolean;
	};
}

export interface FactsCommandOptions {
	agentDir?: string;
	cwd?: string;
	write?: (text: string) => void;
}

const FACTS_ACTIONS: FactsAction[] = ["add", "view", "search", "explain", "retract", "erase", "path", "prompt"];

export function parseFactsArgv(argv: string[]): FactsCommandArgs {
	const action = (argv[0] ?? "view") as FactsAction;
	if (!FACTS_ACTIONS.includes(action)) {
		throw new Error(`Unknown facts command: ${action}. Valid commands: ${FACTS_ACTIONS.join(", ")}`);
	}
	const flags: FactsCommandArgs["flags"] = {};
	const values: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (action === "add" && values.length >= 3) {
			values.push(arg);
			continue;
		}
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--all") {
			flags.all = true;
		} else if (arg === "--include-personal") {
			flags.includePersonal = true;
		} else if (arg === "--scope") {
			flags.scope = readFlagValue(argv, ++i, "--scope");
		} else if (arg === "--sensitivity") {
			flags.sensitivity = readFlagValue(argv, ++i, "--sensitivity");
		} else if (arg === "--canonical") {
			flags.canonical = readFlagValue(argv, ++i, "--canonical");
		} else if (arg === "--limit") {
			flags.limit = Number(readFlagValue(argv, ++i, "--limit"));
		} else if (arg === "--db") {
			flags.db = readFlagValue(argv, ++i, "--db");
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown facts flag: ${arg}`);
		} else {
			values.push(arg);
		}
	}
	return { action, values, flags };
}

export async function runFactsCommand(cmd: FactsCommandArgs, options: FactsCommandOptions = {}): Promise<string> {
	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = options.cwd ?? process.cwd();
	const dbPath = cmd.flags.db ?? getFactsDbPath(agentDir);
	if (cmd.action === "path") {
		return emit(dbPath, options.write);
	}

	const store = FactStore.open(dbPath);
	try {
		const output = handleFactsCommand(store, cmd, cwd);
		return emit(output, options.write);
	} finally {
		store.close();
	}
}

function handleFactsCommand(store: FactStore, cmd: FactsCommandArgs, cwd: string): string {
	switch (cmd.action) {
		case "add":
			return handleAdd(store, cmd, cwd);
		case "view":
			return handleView(store, cmd);
		case "search":
			return handleSearch(store, cmd);
		case "explain":
			return handleExplain(store, cmd);
		case "retract":
			return handleRetract(store, cmd);
		case "erase":
			return handleErase(store, cmd);
		case "prompt":
			return handlePrompt(store, cmd);
		case "path":
			throw new Error("facts path is handled before storage opens.");
	}
}

function handleAdd(store: FactStore, cmd: FactsCommandArgs, cwd: string): string {
	const [kindRaw, subject, predicate, ...objectParts] = cmd.values;
	if (!kindRaw || !subject || !predicate || objectParts.length === 0) {
		throw new Error(`Usage: facts add <kind> <subject> <predicate> <value>. Kinds: ${FACT_KINDS.join(", ")}`);
	}
	if (!isFactKind(kindRaw)) {
		throw new Error(`Invalid fact kind: ${kindRaw}. Kinds: ${FACT_KINDS.join(", ")}`);
	}
	const sensitivity = parseSensitivity(cmd.flags.sensitivity);
	const objectRaw = objectParts.join(" ");
	const object = parseObjectValue(objectRaw);
	const canonicalText = cmd.flags.canonical ?? `${subject} ${predicate}: ${formatObjectValue(object)}`;
	const fact = store.add({
		kind: kindRaw,
		subject,
		predicate,
		object,
		canonicalText,
		scope: buildScope(cmd.flags.scope, cwd),
		sensitivity,
		source: { kind: "manual" },
	});
	if (cmd.flags.json) return JSON.stringify(fact, null, 2);
	return `Added fact ${fact.id}\n${formatFactLine(fact)}`;
}

function handleView(store: FactStore, cmd: FactsCommandArgs): string {
	const facts = store.list({ includeHistory: cmd.flags.all, limit: cmd.flags.limit });
	if (cmd.flags.json) return JSON.stringify(facts, null, 2);
	if (facts.length === 0) return cmd.flags.all ? "No facts stored." : "No active facts stored.";
	return facts.map(formatFactLine).join("\n");
}

function handleSearch(store: FactStore, cmd: FactsCommandArgs): string {
	const query = cmd.values.join(" ").trim();
	if (!query) throw new Error("Usage: facts search <query>");
	const facts = store.search({ query, includeHistory: cmd.flags.all, limit: cmd.flags.limit });
	if (cmd.flags.json) return JSON.stringify(facts, null, 2);
	if (facts.length === 0) return "No matching facts.";
	return facts.map(formatFactLine).join("\n");
}

function handleExplain(store: FactStore, cmd: FactsCommandArgs): string {
	const id = cmd.values[0];
	if (!id) throw new Error("Usage: facts explain <id>");
	const fact = store.get(id);
	if (!fact) return `Fact not found: ${id}`;
	const events = store.events(id);
	if (cmd.flags.json) return JSON.stringify({ fact, events }, null, 2);
	const lines = [
		formatFactLine(fact),
		`status: ${fact.status}`,
		`scope: ${JSON.stringify(fact.scope)}`,
		`source: ${JSON.stringify(fact.source)}`,
		`evidence: ${fact.evidence.length === 0 ? "none" : JSON.stringify(fact.evidence)}`,
		"events:",
		...events.map(
			event =>
				`- ${new Date(event.createdAt).toISOString()} ${event.action}${event.reason ? `: ${event.reason}` : ""}`,
		),
	];
	return lines.join("\n");
}

function handleRetract(store: FactStore, cmd: FactsCommandArgs): string {
	const [id, ...reasonParts] = cmd.values;
	if (!id) throw new Error("Usage: facts retract <id> [reason]");
	const fact = store.retract(id, reasonParts.join(" ") || undefined);
	if (!fact) return `Fact not found: ${id}`;
	if (cmd.flags.json) return JSON.stringify(fact, null, 2);
	return `Retracted fact ${fact.id}`;
}

function handleErase(store: FactStore, cmd: FactsCommandArgs): string {
	const [id, ...reasonParts] = cmd.values;
	if (!id) throw new Error("Usage: facts erase <id> [reason]");
	const fact = store.erase(id, reasonParts.join(" ") || undefined);
	if (!fact) return `Fact not found: ${id}`;
	if (cmd.flags.json) return JSON.stringify(fact, null, 2);
	return `Erased fact ${fact.id}`;
}

function handlePrompt(store: FactStore, cmd: FactsCommandArgs): string {
	const facts = store.list({ includeHistory: true, limit: 100 });
	const formatted = formatKnownFactsBlock(facts, {
		includePersonal: cmd.flags.includePersonal,
		maxFacts: cmd.flags.limit,
	});
	if (cmd.flags.json) return JSON.stringify(formatted, null, 2);
	return formatted.text || "No injectable facts.";
}

function formatFactLine(fact: FactAssertion): string {
	return `${fact.id} [${fact.kind}/${fact.status}/${fact.sensitivity}] ${fact.subject}.${fact.predicate} — ${fact.canonicalText}`;
}

function buildScope(scopeRaw: string | undefined, cwd: string): FactScope {
	const kind = parseScopeKind(scopeRaw);
	if (kind === "project") return { kind, projectCwd: cwd };
	return { kind };
}

function parseScopeKind(value: string | undefined): FactScopeKind {
	const scope = value ?? "project";
	if (!isFactScopeKind(scope)) {
		throw new Error(`Invalid fact scope: ${scope}. Scopes: ${FACT_SCOPE_KINDS.join(", ")}`);
	}
	return scope;
}

function parseSensitivity(value: string | undefined): FactSensitivity | undefined {
	if (!value) return undefined;
	if (!isFactSensitivity(value)) {
		throw new Error(`Invalid fact sensitivity: ${value}. Sensitivities: ${FACT_SENSITIVITIES.join(", ")}`);
	}
	return value;
}

function parseObjectValue(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function formatObjectValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function readFlagValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value) throw new Error(`${flag} requires a value.`);
	return value;
}

function emit(output: string, write: ((text: string) => void) | undefined): string {
	if (write) write(output);
	return output;
}
