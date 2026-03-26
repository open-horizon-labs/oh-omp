/**
 * RNA output compression — transforms verbose RNA compact output into
 * token-efficient format. Shared by read, grep, lsp, find.
 *
 * Input line format (RNA compact):
 *   - **function** `execute` `packages/coding-agent/src/tools/read.ts`:429-757 `async execute(` async cc:60 edges:26
 *     `packages/coding-agent/src/tools/read.ts:execute:function`
 *
 * Output line format:
 *   fn execute  tools/read.ts:429-757  async cc:6 e:26  →read.ts:execute:function
 */

const KIND_SHORT: Record<string, string> = {
	function: "fn",
	trait: "iface",
	struct: "class",
	type_alias: "type",
	enum: "enum",
	module: "mod",
	markdown: "md",
};

const INTERESTING_KINDS = new Set(["function", "trait", "struct", "type_alias", "enum", "module"]);

/**
 * Parse a single RNA compact result (main line + optional node ID line).
 * Returns null for metadata/uninteresting lines.
 */
function parseRnaLine(mainLine: string): {
	kind: string;
	name: string;
	file: string;
	range: string;
	signature: string;
	flags: string;
	nodeId: string;
} | null {
	const trimmed = mainLine.trim();
	// Match: - **kind** `name` `file`:L1-L2 `signature` flags
	const m = trimmed.match(/^- \*\*(\w+)\*\*\s+`([^`]+)`\s+`([^`]+)`:(\d+-\d+)\s+(?:`([^`]*)`\s*)?(.*)$/);
	if (!m) return null;
	const [, kind = "", name = "", file = "", range = "", , flags = ""] = m;
	return { kind, name, file, range, signature: "", flags: flags.trim(), nodeId: "" };
}

/**
 * Find the longest common path prefix across a set of file paths.
 */
function findCommonPrefix(paths: string[]): string {
	if (paths.length === 0) return "";
	const parts = paths.map(p => p.split("/"));
	const first = parts[0]!;
	let prefixLen = 0;
	for (let i = 0; i < first.length - 1; i++) {
		if (parts.every(p => p[i] === first[i])) {
			prefixLen = i + 1;
		} else {
			break;
		}
	}
	return prefixLen > 0 ? `${first.slice(0, prefixLen).join("/")}/` : "";
}

export interface CompressOptions {
	/** Only include these symbol kinds (default: INTERESTING_KINDS) */
	kinds?: Set<string>;
	/** Strip markdown-only results (default: true) */
	stripMarkdown?: boolean;
}

/**
 * Compress RNA compact output into token-efficient format.
 * Strips metadata, reformats lines, strips common path prefix, inlines node IDs.
 */
export function compressRnaOutput(stdout: string, options?: CompressOptions): string | null {
	const kinds = options?.kinds ?? INTERESTING_KINDS;
	const stripMarkdown = options?.stripMarkdown ?? true;

	const lines = stdout.split("\n");

	// First pass: parse symbol entries (main line + node ID line pairs)
	const entries: { kind: string; name: string; file: string; range: string; flags: string; nodeId: string }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();

		// Skip metadata
		if (!line || line.startsWith("##") || line.startsWith("*Index:")) continue;

		// Skip markdown results
		if (stripMarkdown && line.startsWith("- **markdown**")) {
			// Skip the node ID line too
			if (i + 1 < lines.length && lines[i + 1]?.startsWith("  ")) i++;
			continue;
		}

		const parsed = parseRnaLine(line);
		if (!parsed) continue;
		if (!kinds.has(parsed.kind)) {
			// Skip the node ID line too
			if (i + 1 < lines.length && lines[i + 1]?.startsWith("  ")) i++;
			continue;
		}

		// Grab node ID from next line if present
		if (i + 1 < lines.length) {
			const nextLine = lines[i + 1]?.trim() ?? "";
			if (nextLine.startsWith("`") && nextLine.endsWith("`")) {
				parsed.nodeId = nextLine.slice(1, -1);
				i++;
			}
		}

		entries.push(parsed);
	}

	if (entries.length === 0) return null;

	// Find common prefix to strip
	const filePaths = entries.map(e => e.file);
	const prefix = findCommonPrefix(filePaths);

	// Format compressed output
	const formatted = entries.map(e => {
		const shortKind = KIND_SHORT[e.kind] ?? e.kind;
		const shortFile = prefix ? e.file.slice(prefix.length) : e.file;
		// Compress flags: "async cc:6 edges:26" → "async cc:6 e:26"
		const flags = e.flags.replace(/edges:/, "e:");
		// Compress node ID: strip common prefix if present
		const shortNodeId = e.nodeId ? (prefix ? e.nodeId.slice(prefix.length) : e.nodeId) : "";
		const parts = [shortKind, e.name, ` ${shortFile}:${e.range}`];
		if (flags) parts.push(` ${flags}`);
		if (shortNodeId) parts.push(` →${shortNodeId}`);
		return parts.join("  ");
	});

	return formatted.join("\n");
}
