/**
 * Content codec for file read tool results.
 *
 * Produces warm representations that preserve structural information
 * when file reads age out of the hot window.
 *
 * Three modes:
 *   - RNA structural views (read without offset): already compact, preserved as-is.
 *   - Source reads (hashline format): anchor-aware skeleton extraction preserves
 *     declarations + scope boundaries with their edit anchors intact.
 *   - Plain reads (no hashlines, no RNA): compressed to file path + line count.
 */

import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { CodecContext, ContentCodec } from "../types";
import { extractText, isReadTool } from "./shared";

/** Marker prefix for RNA structural views in read tool output. */
const RNA_VIEW_PREFIX = "[RNA structural view of ";

/**
 * Detect whether this is an RNA structural view (read without offset).
 */
function isRnaStructuralView(text: string): boolean {
	return text.startsWith(RNA_VIEW_PREFIX);
}

/**
 * Extract line range info from source read content.
 * Looks for the "[Showing lines X-Y of Z. Use offset=N to continue]" trailer.
 */
function extractLineInfo(text: string): { start: number; end: number; total: number } | null {
	const match = text.match(/\[Showing lines (\d+)-(\d+) of (\d+)/);
	if (!match) return null;
	return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Anchor-aware skeleton extraction
// ═══════════════════════════════════════════════════════════════════════════

type Language = "ts" | "rust" | "unknown";

/** Detect language from file extension. */
function detectLanguage(filePath: string): Language {
	if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)) return "ts";
	if (/\.rs$/.test(filePath)) return "rust";
	return "unknown";
}

/** Hashline regex: `N#XX:content` */
const HASHLINE_RE = /^(\d+#[A-Z]{2}):(.*)$/;

interface ParsedLine {
	anchor: string; // e.g. "42#XN"
	content: string; // the actual source content
}

function parseHashline(line: string): ParsedLine | null {
	const m = HASHLINE_RE.exec(line);
	if (!m) return null;
	return { anchor: m[1], content: m[2] };
}

// TS/JS declaration patterns (applied to trimmed content)
const TS_STRUCTURAL_PATTERNS: RegExp[] = [
	// Declarations
	/^(export\s+)?(async\s+)?function\s/,
	/^(export\s+)?(const|let|var)\s+\w+\s*[:=(]/,
	/^(export\s+)?(class|interface|type|enum|namespace)\s/,
	/^(export\s+)?abstract\s+class\s/,
	// Imports / re-exports
	/^(import|export)\s/,
	// Decorators
	/^@\w/,
];

// Rust declaration patterns (applied to trimmed content)
const RUST_STRUCTURAL_PATTERNS: RegExp[] = [
	// Functions and methods
	/^(pub(\s*\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s/,
	// Type declarations
	/^(pub(\s*\([^)]*\))?\s+)?(struct|enum|trait|type|union|const|static|mod|use)\s/,
	// Impl blocks
	/^(unsafe\s+)?impl\s/,
	// Macros
	/^(pub(\s*\([^)]*\))?\s+)?macro_rules!\s/,
	// Attributes (keep for context)
	/^#\[/,
	/^#!\[/,
];

/** Scope boundary: opening or closing brace at line start. */
const SCOPE_BOUNDARY_RE = /^[}\]]/;

function isStructuralLine(content: string, lang: Language): boolean {
	const trimmed = content.trimStart();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
		return false;
	}
	// Closing scope boundaries are structural (function/block ends)
	if (SCOPE_BOUNDARY_RE.test(trimmed)) return true;

	const patterns = lang === "ts" ? TS_STRUCTURAL_PATTERNS : lang === "rust" ? RUST_STRUCTURAL_PATTERNS : [];
	return patterns.some(re => re.test(trimmed));
}

/**
 * Extract an anchored skeleton from hashline-formatted source text.
 *
 * Keeps only structural lines (declarations, scope boundaries, imports)
 * with their hashline anchors preserved. This means the model retains:
 *   - What symbols exist in this range
 *   - Their type signatures
 *   - Edit anchors for direct modification without re-reading
 *
 * Returns null if the text has no hashlines or no structural lines.
 */
function extractAnchoredSkeleton(text: string, filePath: string): string | null {
	const lang = detectLanguage(filePath);
	if (lang === "unknown") return null;

	const rawLines = text.split("\n");
	const structural: string[] = [];
	let hasHashlines = false;

	for (const line of rawLines) {
		const parsed = parseHashline(line);
		if (!parsed) {
			// Non-hashline lines: keep metadata lines (e.g. [Showing lines...])
			if (line.startsWith("[")) structural.push(line);
			continue;
		}
		hasHashlines = true;
		if (isStructuralLine(parsed.content, lang)) {
			structural.push(`${parsed.anchor}:${parsed.content}`);
		}
	}

	if (!hasHashlines || structural.length === 0) return null;

	// Build header with line range info
	const lineInfo = extractLineInfo(text);
	const rangeHint = lineInfo ? ` | lines ${lineInfo.start}-${lineInfo.end} of ${lineInfo.total}` : "";
	const header = `[warm:read:${filePath}${rangeHint} | skeleton: ${structural.length} structural lines]`;

	return `${header}\n${structural.join("\n")}`;
}

/**
 * Read codec: produces warm representations for file reads.
 */
export const readCodec: ContentCodec = {
	name: "read",

	matches(message: ToolResultMessage, ctx: CodecContext): boolean {
		const toolName = ctx.toolName ?? message.toolName;
		if (!toolName) return false;
		return isReadTool(toolName);
	},

	encode(message: ToolResultMessage, ctx: CodecContext): TextContent[] | null {
		const text = extractText(message);
		if (!text) return null;

		const filePath = ctx.toolCallPath ?? "unknown";

		// Case 1: RNA structural view — already compact. Preserve it.
		if (isRnaStructuralView(text)) {
			return [{ type: "text", text: `[warm:read:${filePath}]\n${text}` }];
		}

		// Case 2: Source read with line range — extract anchored skeleton.
		const lineInfo = extractLineInfo(text);
		if (lineInfo) {
			const skeleton = extractAnchoredSkeleton(text, filePath);
			if (skeleton) return [{ type: "text", text: skeleton }];
			// No skeleton (no hashlines or no structural lines) — fall back to metadata.
			const warmText = `[warm:read:${filePath} | lines ${lineInfo.start}-${lineInfo.end} of ${lineInfo.total}]`;
			return [{ type: "text", text: warmText }];
		}

		// Case 3: Source read without line info — try skeleton, fall back to line count.
		const lineCount = text.split("\n").length;
		if (lineCount <= 5) {
			// Very short content — preserve as-is, not worth compressing.
			return null;
		}
		const skeleton = extractAnchoredSkeleton(text, filePath);
		if (skeleton) return [{ type: "text", text: skeleton }];
		return [{ type: "text", text: `[warm:read:${filePath} | ${lineCount} lines]` }];
	},
};
