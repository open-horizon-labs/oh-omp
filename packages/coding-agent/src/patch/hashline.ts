/**
 * Hashline edit mode — a line-addressable edit format using text hashes.
 *
 * Each line in a file is identified by its 1-indexed line number and a short
 * hexadecimal hash derived from the normalized line text (xxHash32, truncated to 2
 * hex chars).
 * The combined `LINE#ID` reference acts as both an address and a staleness check:
 * if the file has changed since the caller last read it, hash mismatches are caught
 * before any mutation occurs.
 *
 * Displayed format: `LINENUM#HASH:TEXT`
 * Reference format: `"LINENUM#HASH"` (e.g. `"5#aa"`)
 */

import type { HashMismatch } from "./types";

export type Anchor = { line: number; hash: string };
export type HashlineEdit =
	| { op: "replace_line"; pos: Anchor; lines: string[] }
	| { op: "replace_range"; pos: Anchor; end: Anchor; lines: string[] }
	| { op: "append_at"; pos: Anchor; lines: string[] }
	| { op: "prepend_at"; pos: Anchor; lines: string[] }
	| { op: "append_file"; lines: string[] }
	| { op: "prepend_file"; lines: string[] };

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

/**
 * Compute a short hexadecimal hash of a single line.
 *
 * Uses xxHash32 on a trailing-whitespace-trimmed, CR-stripped line, truncated to 2 chars from
 * {@link NIBBLE_STR}. For lines containing no alphanumeric characters (only
 * punctuation/symbols/whitespace), the line number is mixed in to reduce hash collisions.
 * The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();

	let seed = 0;
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx;
	}
	return DICT[Bun.hash.xxHash32(line, seed) & 0xff];
}

/**
 * Formats a tag given the line number and text.
 */
export function formatLineTag(line: number, lines: string): string {
	return `${line}#${computeLineHash(line, lines)}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINENUM#HASH:TEXT` where LINENUM is 1-indexed.
 *
 * @param text - Raw file text string
 * @param startLine - First line number (1-indexed, defaults to 1)
 * @returns Formatted string with one hashline-prefixed line per input line
 *
 * @example
 * ```
 * formatHashLines("function hi() {\n  return;\n}")
 * // "1#HH:function hi() {\n2#HH:  return;\n3#HH:}"
 * ```
 */
export function formatHashLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines
		.map((line, i) => {
			const num = startLine + i;
			return `${formatLineTag(num, line)}:${line}`;
		})
		.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Hashline streaming formatter
// ═══════════════════════════════════════════════════════════════════════════

export interface HashlineStreamOptions {
	/** First line number to use when formatting (1-indexed). */
	startLine?: number;
	/** Maximum formatted lines per yielded chunk (default: 200). */
	maxChunkLines?: number;
	/** Maximum UTF-8 bytes per yielded chunk (default: 64 KiB). */
	maxChunkBytes?: number;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return (
		typeof value === "object" &&
		value !== null &&
		"getReader" in value &&
		typeof (value as { getReader?: unknown }).getReader === "function"
	);
}

async function* bytesFromReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Stream hashline-formatted output from a UTF-8 byte source.
 *
 * This is intended for large files where callers want incremental output
 * (e.g. while reading from a file handle) rather than allocating a single
 * large string.
 */
export async function* streamHashLinesFromUtf8(
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const startLine = options.startLine ?? 1;
	const maxChunkLines = options.maxChunkLines ?? 200;
	const maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
	const decoder = new TextDecoder("utf-8");
	const chunks = isReadableStream(source) ? bytesFromReadableStream(source) : source;
	let lineNum = startLine;
	let pending = "";
	let sawAnyText = false;
	let endedWithNewline = false;
	let outLines: string[] = [];
	let outBytes = 0;

	const flush = (): string | undefined => {
		if (outLines.length === 0) return undefined;
		const chunk = outLines.join("\n");
		outLines = [];
		outBytes = 0;
		return chunk;
	};

	const pushLine = (line: string): string[] => {
		const formatted = `${lineNum}#${computeLineHash(lineNum, line)}:${line}`;
		lineNum++;

		const chunksToYield: string[] = [];
		const sepBytes = outLines.length === 0 ? 0 : 1; // "\n"
		const lineBytes = Buffer.byteLength(formatted, "utf-8");

		if (
			outLines.length > 0 &&
			(outLines.length >= maxChunkLines || outBytes + sepBytes + lineBytes > maxChunkBytes)
		) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		outLines.push(formatted);
		outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

		if (outLines.length >= maxChunkLines || outBytes >= maxChunkBytes) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		return chunksToYield;
	};

	const consumeText = (text: string): string[] => {
		if (text.length === 0) return [];
		sawAnyText = true;
		pending += text;
		const chunksToYield: string[] = [];
		while (true) {
			const idx = pending.indexOf("\n");
			if (idx === -1) break;
			const line = pending.slice(0, idx);
			pending = pending.slice(idx + 1);
			endedWithNewline = true;
			chunksToYield.push(...pushLine(line));
		}
		if (pending.length > 0) endedWithNewline = false;
		return chunksToYield;
	};
	for await (const chunk of chunks) {
		for (const out of consumeText(decoder.decode(chunk, { stream: true }))) {
			yield out;
		}
	}

	for (const out of consumeText(decoder.decode())) {
		yield out;
	}
	if (!sawAnyText) {
		// Mirror `"".split("\n")` behavior: one empty line.
		for (const out of pushLine("")) {
			yield out;
		}
	} else if (pending.length > 0 || endedWithNewline) {
		// Emit the final line (may be empty if the file ended with a newline).
		for (const out of pushLine(pending)) {
			yield out;
		}
	}

	const last = flush();
	if (last) yield last;
}

/**
 * Stream hashline-formatted output from an (async) iterable of lines.
 *
 * Each yielded chunk is a `\n`-joined string of one or more formatted lines.
 */
export async function* streamHashLinesFromLines(
	lines: Iterable<string> | AsyncIterable<string>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const startLine = options.startLine ?? 1;
	const maxChunkLines = options.maxChunkLines ?? 200;
	const maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;

	let lineNum = startLine;
	let outLines: string[] = [];
	let outBytes = 0;
	let sawAnyLine = false;
	const flush = (): string | undefined => {
		if (outLines.length === 0) return undefined;
		const chunk = outLines.join("\n");
		outLines = [];
		outBytes = 0;
		return chunk;
	};

	const pushLine = (line: string): string[] => {
		sawAnyLine = true;
		const formatted = `${lineNum}#${computeLineHash(lineNum, line)}:${line}`;
		lineNum++;

		const chunksToYield: string[] = [];
		const sepBytes = outLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(formatted, "utf-8");

		if (
			outLines.length > 0 &&
			(outLines.length >= maxChunkLines || outBytes + sepBytes + lineBytes > maxChunkBytes)
		) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		outLines.push(formatted);
		outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

		if (outLines.length >= maxChunkLines || outBytes >= maxChunkBytes) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		return chunksToYield;
	};

	const asyncIterator = (lines as AsyncIterable<string>)[Symbol.asyncIterator];
	if (typeof asyncIterator === "function") {
		for await (const line of lines as AsyncIterable<string>) {
			for (const out of pushLine(line)) {
				yield out;
			}
		}
	} else {
		for (const line of lines as Iterable<string>) {
			for (const out of pushLine(line)) {
				yield out;
			}
		}
	}
	if (!sawAnyLine) {
		// Mirror `"".split("\n")` behavior: one empty line.
		for (const out of pushLine("")) {
			yield out;
		}
	}

	const last = flush();
	if (last) yield last;
}

/**
 * Parse a line reference string like `"5#abcd"` into structured form.
 *
 * @throws Error if the format is invalid (not `NUMBER#HEXHASH`)
 */
export function parseTag(ref: string): { line: number; hash: string } {
	// This regex captures:
	//  1. optional leading ">+" and whitespace
	//  2. line number (1+ digits)
	//  3. "#" with optional surrounding spaces
	//  4. hash (2 hex chars)
	//  5. optional trailing display suffix (":..." or "  ...")
	const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
	if (!match) {
		throw new Error(`Invalid line reference "${ref}". Expected format "LINE#ID" (e.g. "5#aa").`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}
	return { line, hash: match[2] };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hash Mismatch Error
// ═══════════════════════════════════════════════════════════════════════════

/** Number of context lines shown above/below each mismatched line */
const MISMATCH_CONTEXT = 2;

/**
 * Error thrown when one or more hashline references have stale hashes.
 *
 * Displays grep-style output with `>>>` markers on mismatched lines,
 * showing the correct `LINE#ID` so the caller can fix all refs at once.
 */
export class HashlineMismatchError extends Error {
	readonly remaps: ReadonlyMap<string, string>;
	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
		const remaps = new Map<string, string>();
		for (const m of mismatches) {
			const actual = computeLineHash(m.line, fileLines[m.line - 1]);
			remaps.set(`${m.line}#${m.expected}`, `${m.line}#${actual}`);
		}
		this.remaps = remaps;
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Map<number, HashMismatch>();
		for (const m of mismatches) {
			mismatchSet.set(m.line, m);
		}

		// Collect line ranges to display (mismatch lines + context)
		const displayLines = new Set<number>();
		for (const m of mismatches) {
			const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
			const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
			for (let i = lo; i <= hi; i++) {
				displayLines.add(i);
			}
		}

		const sorted = [...displayLines].sort((a, b) => a - b);
		const lines: string[] = [];

		lines.push(
			`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`,
		);
		lines.push("");

		let prevLine = -1;
		for (const lineNum of sorted) {
			// Gap separator between non-contiguous regions
			if (prevLine !== -1 && lineNum > prevLine + 1) {
				lines.push("    ...");
			}
			prevLine = lineNum;

			const text = fileLines[lineNum - 1];
			const hash = computeLineHash(lineNum, text);
			const prefix = `${lineNum}#${hash}`;

			if (mismatchSet.has(lineNum)) {
				lines.push(`>>> ${prefix}:${text}`);
			} else {
				lines.push(`    ${prefix}:${text}`);
			}
		}
		return lines.join("\n");
	}
}

/**
 * Validate that a line reference points to an existing line with a matching hash.
 *
 * @param ref - Parsed line reference (1-indexed line number + expected hash)
 * @param fileLines - Array of file lines (0-indexed)
 * @throws HashlineMismatchError if the hash doesn't match (includes correct hashes in context)
 * @throws Error if the line is out of range
 */
export function validateLineRef(ref: { line: number; hash: string }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
	if (actualHash !== ref.hash) {
		throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
	}
}

function isEscapedTabAutocorrectEnabled(): boolean {
	switch (Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS) {
		case "0":
			return false;
		case "1":
			return true;
		default:
			return true;
	}
}

function maybeAutocorrectEscapedTabIndentation(edits: HashlineEdit[], warnings: string[]): void {
	if (!isEscapedTabAutocorrectEnabled()) return;
	for (const edit of edits) {
		if (edit.lines.length === 0) continue;
		const hasEscapedTabs = edit.lines.some(line => line.includes("\\t"));
		if (!hasEscapedTabs) continue;
		const hasRealTabs = edit.lines.some(line => line.includes("\t"));
		if (hasRealTabs) continue;
		let correctedCount = 0;
		const corrected = edit.lines.map(line =>
			line.replace(/^((?:\\t)+)/, escaped => {
				correctedCount += escaped.length / 2;
				return "\t".repeat(escaped.length / 2);
			}),
		);
		if (correctedCount === 0) continue;
		edit.lines = corrected;
		warnings.push(
			`Auto-corrected escaped tab indentation in edit: converted leading \\t sequence(s) to real tab characters`,
		);
	}
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(edits: HashlineEdit[], warnings: string[]): void {
	for (const edit of edits) {
		if (edit.lines.length === 0) continue;
		if (!edit.lines.some(line => /\\uDDDD/i.test(line))) continue;
		warnings.push(
			`Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.`,
		);
	}
}

type ReplacementHashlineEdit =
	| { op: "replace_line"; pos: Anchor; lines: string[] }
	| { op: "replace_range"; pos: Anchor; end: Anchor; lines: string[] };

interface ReplacementBounds {
	startLine: number;
	endLine: number;
}

function replacementBounds(edit: HashlineEdit): ReplacementBounds | undefined {
	switch (edit.op) {
		case "replace_line":
			return { startLine: edit.pos.line, endLine: edit.pos.line };
		case "replace_range":
			return { startLine: edit.pos.line, endLine: edit.end.line };
		default:
			return undefined;
	}
}

function isReplacementEdit(edit: HashlineEdit): edit is ReplacementHashlineEdit {
	return edit.op === "replace_line" || edit.op === "replace_range";
}

function collectProtectedAnchorLines(edits: HashlineEdit[]): Set<number> {
	const protectedLines = new Set<number>();
	for (const edit of edits) {
		switch (edit.op) {
			case "replace_line":
			case "append_at":
			case "prepend_at":
				protectedLines.add(edit.pos.line);
				break;
			case "replace_range":
				protectedLines.add(edit.pos.line);
				protectedLines.add(edit.end.line);
				break;
			case "append_file":
			case "prepend_file":
				break;
		}
	}
	return protectedLines;
}

function hasProtectedAnchorInRange(protectedLines: Set<number>, startLine: number, endLine: number): boolean {
	for (let line = startLine; line <= endLine; line++) {
		if (protectedLines.has(line)) return true;
	}
	return false;
}

function countDuplicatePrefix(
	insertedLines: string[],
	startLine: number,
	originalFileLines: string[],
	protectedLines: Set<number>,
): number {
	const maxCount = Math.min(insertedLines.length - 1, startLine - 1);
	for (let count = maxCount; count >= 2; count--) {
		const sourceStartLine = startLine - count;
		const sourceEndLine = startLine - 1;
		if (hasProtectedAnchorInRange(protectedLines, sourceStartLine, sourceEndLine)) continue;
		const sourceLines = originalFileLines.slice(sourceStartLine - 1, sourceEndLine);
		if (sourceLines.every((line, index) => line === insertedLines[index])) return count;
	}
	return 0;
}

function countDuplicateSuffix(
	insertedLines: string[],
	endLine: number,
	originalFileLines: string[],
	protectedLines: Set<number>,
): number {
	const maxCount = Math.min(insertedLines.length - 1, originalFileLines.length - endLine);
	for (let count = maxCount; count >= 2; count--) {
		const sourceStartLine = endLine + 1;
		const sourceEndLine = endLine + count;
		if (hasProtectedAnchorInRange(protectedLines, sourceStartLine, sourceEndLine)) continue;
		const sourceLines = originalFileLines.slice(sourceStartLine - 1, sourceEndLine);
		const insertedStart = insertedLines.length - count;
		if (sourceLines.every((line, index) => line === insertedLines[insertedStart + index])) return count;
	}
	return 0;
}

function absorbDuplicateReplacementBoundaries(
	edits: HashlineEdit[],
	originalFileLines: string[],
	warnings: string[],
): void {
	const protectedLines = collectProtectedAnchorLines(edits);
	for (const edit of edits) {
		if (!isReplacementEdit(edit)) continue;
		const bounds = replacementBounds(edit);
		if (!bounds || edit.lines.length < 3) continue;

		const prefixCount = countDuplicatePrefix(edit.lines, bounds.startLine, originalFileLines, protectedLines);
		if (prefixCount >= 2) {
			edit.lines = edit.lines.slice(prefixCount);
			const tag = formatLineTag(
				bounds.startLine - prefixCount,
				originalFileLines[bounds.startLine - prefixCount - 1],
			);
			warnings.push(
				`Auto-absorbed ${prefixCount} duplicate line(s) above replacement at ${tag}; replacement content repeated unchanged boundary lines immediately before the target.`,
			);
		}

		if (edit.lines.length < 3) continue;
		const suffixCount = countDuplicateSuffix(edit.lines, bounds.endLine, originalFileLines, protectedLines);
		if (suffixCount >= 2) {
			edit.lines = edit.lines.slice(0, -suffixCount);
			const tag = formatLineTag(bounds.endLine + 1, originalFileLines[bounds.endLine]);
			warnings.push(
				`Auto-absorbed ${suffixCount} duplicate line(s) below replacement at ${tag}; replacement content repeated unchanged boundary lines immediately after the target.`,
			);
		}
	}
}
// ═══════════════════════════════════════════════════════════════════════════
// Edit Application
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply an array of hashline edits to file content.
 *
 * Each edit operation identifies target lines directly (`replace`,
 * `append`, `prepend`). Line references are resolved via {@link parseTag}
 * and hashes validated before any mutation.
 *
 * Edits are sorted bottom-up (highest effective line first) so earlier
 * splices don't invalidate later line numbers.
 *
 * @returns The modified content and the 1-indexed first changed line number
 */
export function applyHashlineEdits(
	text: string,
	edits: HashlineEdit[],
): {
	lines: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
} {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const originalFileLines = [...fileLines];
	let firstChangedLine: number | undefined;
	const noopEdits: Array<{ editIndex: number; loc: string; current: string }> = [];
	const warnings: string[] = [];

	// Pre-validate: collect all hash mismatches before mutating
	const mismatches: HashMismatch[] = [];
	function validateRef(ref: { line: number; hash: string }): boolean {
		if (ref.line < 1 || ref.line > fileLines.length) {
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
		}
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash === ref.hash) {
			return true;
		}
		mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
		return false;
	}
	for (const edit of edits) {
		switch (edit.op) {
			case "replace_line": {
				if (!validateRef(edit.pos)) continue;
				break;
			}
			case "replace_range": {
				const startValid = validateRef(edit.pos);
				const endValid = validateRef(edit.end);
				if (!startValid || !endValid) continue;
				if (edit.pos.line > edit.end.line) {
					throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`);
				}
				break;
			}
			case "append_at":
			case "prepend_at": {
				if (!validateRef(edit.pos)) continue;
				if (edit.lines.length === 0) {
					edit.lines = [""]; // insert an empty line
				}
				break;
			}
			case "append_file":
			case "prepend_file": {
				if (edit.lines.length === 0) {
					edit.lines = [""]; // insert an empty line
				}
				break;
			}
		}
	}
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}
	maybeAutocorrectEscapedTabIndentation(edits, warnings);
	maybeWarnSuspiciousUnicodeEscapePlaceholder(edits, warnings);
	absorbDuplicateReplacementBoundaries(edits, originalFileLines, warnings);

	// Warn when a replace_range/replace_line's last inserted line duplicates the next surviving line.
	// This catches the common boundary-overreach pattern where the agent includes a closing delimiter
	// in the replacement but sets `end` to the line before the delimiter, causing duplication.
	for (const edit of edits) {
		let endLine: number;
		switch (edit.op) {
			case "replace_line":
				endLine = edit.pos.line;
				break;
			case "replace_range":
				endLine = edit.end.line;
				break;
			default:
				continue;
		}
		if (edit.lines.length === 0) continue;
		const nextSurvivingIdx = endLine; // 0-indexed: endLine (1-indexed) is the next line after `end`
		if (nextSurvivingIdx >= originalFileLines.length) continue;
		const nextSurvivingLine = originalFileLines[nextSurvivingIdx];
		const lastInsertedLine = edit.lines[edit.lines.length - 1];
		const trimmedNext = nextSurvivingLine.trim();
		const trimmedLast = lastInsertedLine.trim();
		// Only warn for non-trivial lines to avoid false positives on blank lines or bare punctuation
		if (trimmedLast.length > 0 && trimmedLast === trimmedNext) {
			const tag = formatLineTag(endLine + 1, nextSurvivingLine);
			warnings.push(
				`Possible boundary duplication: your last replacement line \`${trimmedLast}\` is identical to the next surviving line ${tag}. ` +
					`If you meant to replace the entire block, set \`end\` to ${tag} instead.`,
			);
		}
	}
	// Deduplicate identical edits targeting the same line(s)
	const seenEditKeys = new Map<string, number>();
	const dedupIndices = new Set<number>();
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		let lineKey: string;
		switch (edit.op) {
			case "replace_line":
				lineKey = `s:${edit.pos.line}`;
				break;
			case "replace_range":
				lineKey = `r:${edit.pos.line}:${edit.end.line}`;
				break;
			case "append_at":
				lineKey = `i:${edit.pos.line}`;
				break;
			case "prepend_at":
				lineKey = `ib:${edit.pos.line}`;
				break;
			case "append_file":
				lineKey = "ieof";
				break;
			case "prepend_file":
				lineKey = "ibef";
				break;
		}
		const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
		if (seenEditKeys.has(dstKey)) {
			dedupIndices.add(i);
		} else {
			seenEditKeys.set(dstKey, i);
		}
	}
	if (dedupIndices.size > 0) {
		for (let i = edits.length - 1; i >= 0; i--) {
			if (dedupIndices.has(i)) edits.splice(i, 1);
		}
	}

	// Compute sort key (descending) — bottom-up application
	const annotated = edits.map((edit, idx) => {
		let sortLine: number;
		let precedence: number;
		switch (edit.op) {
			case "replace_line":
				sortLine = edit.pos.line;
				precedence = 0;
				break;
			case "replace_range":
				sortLine = edit.end.line;
				precedence = 0;
				break;
			case "append_at":
				sortLine = edit.pos.line;
				precedence = 1;
				break;
			case "prepend_at":
				sortLine = edit.pos.line;
				precedence = 2;
				break;
			case "append_file":
				sortLine = fileLines.length + 1;
				precedence = 1;
				break;
			case "prepend_file":
				sortLine = 0;
				precedence = 2;
				break;
		}
		return { edit, idx, sortLine, precedence };
	});

	annotated.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);

	// Apply edits bottom-up
	for (const { edit, idx } of annotated) {
		switch (edit.op) {
			case "replace_line": {
				const origLines = originalFileLines.slice(edit.pos.line - 1, edit.pos.line);
				const newLines = edit.lines;
				if (origLines.length === newLines.length && origLines.every((line, i) => line === newLines[i])) {
					noopEdits.push({
						editIndex: idx,
						loc: `${edit.pos.line}#${edit.pos.hash}`,
						current: origLines.join("\n"),
					});
					break;
				}
				fileLines.splice(edit.pos.line - 1, 1, ...newLines);
				trackFirstChanged(edit.pos.line);
				break;
			}
			case "replace_range": {
				const count = edit.end.line - edit.pos.line + 1;
				fileLines.splice(edit.pos.line - 1, count, ...edit.lines);
				trackFirstChanged(edit.pos.line);
				break;
			}
			case "append_at": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: `${edit.pos.line}#${edit.pos.hash}`,
						current: originalFileLines[edit.pos.line - 1],
					});
					break;
				}
				fileLines.splice(edit.pos.line, 0, ...inserted);
				trackFirstChanged(edit.pos.line + 1);
				break;
			}
			case "prepend_at": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: `${edit.pos.line}#${edit.pos.hash}`,
						current: originalFileLines[edit.pos.line - 1],
					});
					break;
				}
				fileLines.splice(edit.pos.line - 1, 0, ...inserted);
				trackFirstChanged(edit.pos.line);
				break;
			}
			case "append_file": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({ editIndex: idx, loc: "EOF", current: "" });
					break;
				}
				if (fileLines.length === 1 && fileLines[0] === "") {
					fileLines.splice(0, 1, ...inserted);
					trackFirstChanged(1);
				} else {
					fileLines.splice(fileLines.length, 0, ...inserted);
					trackFirstChanged(fileLines.length - inserted.length + 1);
				}
				break;
			}
			case "prepend_file": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({ editIndex: idx, loc: "BOF", current: "" });
					break;
				}
				if (fileLines.length === 1 && fileLines[0] === "") {
					fileLines.splice(0, 1, ...inserted);
				} else {
					fileLines.splice(0, 0, ...inserted);
				}
				trackFirstChanged(1);
				break;
			}
		}
	}

	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
		...(noopEdits.length > 0 ? { noopEdits } : {}),
	};

	function trackFirstChanged(line: number): void {
		if (firstChangedLine === undefined || line < firstChangedLine) {
			firstChangedLine = line;
		}
	}
}

export interface HashlineAnchorRemap {
	from: string;
	to: string;
	fromLine: number;
	toLine: number;
}

export interface HashlineRemappedAnchor {
	from: string;
	to: string;
}

export interface HashlineRemapEditsResult {
	edits: HashlineEdit[];
	remappedAnchors: HashlineRemappedAnchor[];
}

export interface HashlineEditAnalysis {
	remaps: HashlineAnchorRemap[];
	changedLines: number[];
}

export interface HashlineDeltaContextBlock {
	startLine: number;
	endLine: number;
	text: string;
}

export interface HashlineDeltaContextOptions {
	contextLines?: number;
	maxLines?: number;
}

type HashlineTrackedLine = {
	kind: "line";
	text: string;
	originalLine: number | undefined;
	changed: boolean;
};

type HashlineDeletionMarker = {
	kind: "marker";
	changed: true;
};

type HashlineTrackedEntry = HashlineTrackedLine | HashlineDeletionMarker;

function anchorKey(anchor: Anchor): string {
	return `${anchor.line}#${anchor.hash}`;
}

function cloneAnchor(anchor: Anchor): Anchor {
	return { line: anchor.line, hash: anchor.hash };
}

function isValidAnchor(anchor: Anchor, fileLines: string[]): boolean {
	if (anchor.line < 1 || anchor.line > fileLines.length) return false;
	return computeLineHash(anchor.line, fileLines[anchor.line - 1]) === anchor.hash;
}

function resolveAnchorRemap(
	anchor: Anchor,
	fileLines: string[],
	remaps: ReadonlyMap<string, Anchor>,
): { anchor: Anchor; remapped?: HashlineRemappedAnchor } {
	if (isValidAnchor(anchor, fileLines)) {
		return { anchor: cloneAnchor(anchor) };
	}

	const from = anchorKey(anchor);
	const mapped = remaps.get(from);
	if (!mapped || !isValidAnchor(mapped, fileLines)) {
		return { anchor: cloneAnchor(anchor) };
	}

	return { anchor: cloneAnchor(mapped), remapped: { from, to: anchorKey(mapped) } };
}

export function remapHashlineEdits(
	edits: readonly HashlineEdit[],
	currentText: string,
	remaps: ReadonlyMap<string, Anchor>,
): HashlineRemapEditsResult {
	if (remaps.size === 0) {
		return {
			edits: edits.map(edit => ({ ...edit, lines: [...edit.lines] }) as HashlineEdit),
			remappedAnchors: [],
		};
	}

	const fileLines = currentText.split("\n");
	const remappedAnchors = new Map<string, HashlineRemappedAnchor>();
	const track = (remapped: HashlineRemappedAnchor | undefined) => {
		if (!remapped) return;
		remappedAnchors.set(`${remapped.from}->${remapped.to}`, remapped);
	};

	const remappedEdits = edits.map<HashlineEdit>(edit => {
		switch (edit.op) {
			case "replace_line": {
				const pos = resolveAnchorRemap(edit.pos, fileLines, remaps);
				track(pos.remapped);
				return { ...edit, pos: pos.anchor, lines: [...edit.lines] };
			}
			case "replace_range": {
				const pos = resolveAnchorRemap(edit.pos, fileLines, remaps);
				const end = resolveAnchorRemap(edit.end, fileLines, remaps);
				track(pos.remapped);
				track(end.remapped);
				return { ...edit, pos: pos.anchor, end: end.anchor, lines: [...edit.lines] };
			}
			case "append_at": {
				const pos = resolveAnchorRemap(edit.pos, fileLines, remaps);
				track(pos.remapped);
				return { ...edit, pos: pos.anchor, lines: [...edit.lines] };
			}
			case "prepend_at": {
				const pos = resolveAnchorRemap(edit.pos, fileLines, remaps);
				track(pos.remapped);
				return { ...edit, pos: pos.anchor, lines: [...edit.lines] };
			}
			case "append_file":
			case "prepend_file":
				return { ...edit, lines: [...edit.lines] };
			default: {
				const exhaustive: never = edit;
				return exhaustive;
			}
		}
	});

	return { edits: remappedEdits, remappedAnchors: [...remappedAnchors.values()] };
}

function sortHashlineEditsForApplication(edits: readonly HashlineEdit[], fileLineCount: number) {
	const annotated = edits.map((edit, idx) => {
		let sortLine: number;
		let precedence: number;
		switch (edit.op) {
			case "replace_line":
				sortLine = edit.pos.line;
				precedence = 0;
				break;
			case "replace_range":
				sortLine = edit.end.line;
				precedence = 0;
				break;
			case "append_at":
				sortLine = edit.pos.line;
				precedence = 1;
				break;
			case "prepend_at":
				sortLine = edit.pos.line;
				precedence = 2;
				break;
			case "append_file":
				sortLine = fileLineCount + 1;
				precedence = 1;
				break;
			case "prepend_file":
				sortLine = 0;
				precedence = 2;
				break;
		}

		return { edit, idx, sortLine, precedence };
	});

	annotated.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);
	return annotated;
}

function changedEntries(lines: readonly string[]): HashlineTrackedLine[] {
	return lines.map(line => ({ kind: "line", text: line, originalLine: undefined, changed: true }));
}

function textEntries(entries: readonly HashlineTrackedEntry[]): HashlineTrackedLine[] {
	return entries.filter((entry): entry is HashlineTrackedLine => entry.kind === "line");
}

function normalizedChangedLine(line: number, lineCount: number): number {
	return Math.min(Math.max(1, line), Math.max(1, lineCount));
}

function fallbackChangedLines(originalText: string, newText: string): number[] {
	const oldLines = originalText.split("\n");
	const newLines = newText.split("\n");
	const maxPrefix = Math.min(oldLines.length, newLines.length);
	let first = 0;
	while (first < maxPrefix && oldLines[first] === newLines[first]) first++;

	if (first === oldLines.length && first === newLines.length) return [];

	let oldLast = oldLines.length - 1;
	let newLast = newLines.length - 1;
	while (oldLast >= first && newLast >= first && oldLines[oldLast] === newLines[newLast]) {
		oldLast--;
		newLast--;
	}

	const startLine = normalizedChangedLine(first + 1, newLines.length);
	const endLine = normalizedChangedLine(Math.max(startLine, newLast + 1), newLines.length);
	const changed: number[] = [];
	for (let line = startLine; line <= endLine; line++) changed.push(line);
	return changed;
}

export function analyzeHashlineEdit(
	originalText: string,
	newText: string,
	edits: readonly HashlineEdit[],
): HashlineEditAnalysis {
	if (edits.length === 0 || originalText === newText) {
		return { remaps: [], changedLines: [] };
	}

	const originalLines = originalText.split("\n");
	const entries: HashlineTrackedEntry[] = originalLines.map((text, index) => ({
		kind: "line",
		text,
		originalLine: index + 1,
		changed: false,
	}));

	for (const { edit } of sortHashlineEditsForApplication(edits, originalLines.length)) {
		switch (edit.op) {
			case "replace_line": {
				const originalLine = entries[edit.pos.line - 1];
				if (originalLine?.kind === "line" && edit.lines.length === 1 && originalLine.text === edit.lines[0]) {
					break;
				}
				entries.splice(edit.pos.line - 1, 1, ...changedEntries(edit.lines));
				if (edit.lines.length === 0) entries.splice(edit.pos.line - 1, 0, { kind: "marker", changed: true });
				break;
			}
			case "replace_range": {
				const count = edit.end.line - edit.pos.line + 1;
				entries.splice(edit.pos.line - 1, count, ...changedEntries(edit.lines));
				if (edit.lines.length === 0) entries.splice(edit.pos.line - 1, 0, { kind: "marker", changed: true });
				break;
			}
			case "append_at":
				entries.splice(edit.pos.line, 0, ...changedEntries(edit.lines));
				break;
			case "prepend_at":
				entries.splice(edit.pos.line - 1, 0, ...changedEntries(edit.lines));
				break;
			case "append_file":
				if (entries.length === 1 && entries[0].kind === "line" && entries[0].text === "") {
					entries.splice(0, 1, ...changedEntries(edit.lines));
				} else {
					entries.splice(entries.length, 0, ...changedEntries(edit.lines));
				}
				break;
			case "prepend_file":
				if (entries.length === 1 && entries[0].kind === "line" && entries[0].text === "") {
					entries.splice(0, 1, ...changedEntries(edit.lines));
				} else {
					entries.splice(0, 0, ...changedEntries(edit.lines));
				}
				break;
		}
	}

	const simulatedLines = textEntries(entries);
	const simulatedText = simulatedLines.map(entry => entry.text).join("\n");
	if (simulatedText !== newText) {
		return { remaps: [], changedLines: fallbackChangedLines(originalText, newText) };
	}

	const remaps: HashlineAnchorRemap[] = [];
	const changedLines = new Set<number>();
	let lineNumber = 0;
	for (const entry of entries) {
		if (entry.kind === "marker") {
			changedLines.add(normalizedChangedLine(lineNumber + 1, simulatedLines.length));
			continue;
		}

		lineNumber++;
		if (entry.changed) changedLines.add(lineNumber);
		if (entry.originalLine !== undefined && entry.text === originalLines[entry.originalLine - 1]) {
			const from = formatLineTag(entry.originalLine, entry.text);
			const to = formatLineTag(lineNumber, entry.text);
			remaps.push({ from, to, fromLine: entry.originalLine, toLine: lineNumber });
		}
	}

	return { remaps, changedLines: [...changedLines].sort((a, b) => a - b) };
}

export function buildHashlineDeltaContext(
	text: string,
	changedLines: readonly number[],
	options: HashlineDeltaContextOptions = {},
): HashlineDeltaContextBlock[] {
	if (changedLines.length === 0) return [];

	const contextLines = options.contextLines ?? 5;
	const maxLines = options.maxLines ?? 80;
	const fileLines = text.split("\n");
	const sortedChanged = [...new Set(changedLines)]
		.filter(line => line >= 1 && line <= fileLines.length)
		.sort((a, b) => a - b);

	const blocks: HashlineDeltaContextBlock[] = [];
	let remainingLines = maxLines;
	for (const line of sortedChanged) {
		if (remainingLines <= 0) break;

		const startLine = Math.max(1, line - contextLines);
		const endLine = Math.min(fileLines.length, line + contextLines);
		const previous = blocks[blocks.length - 1];
		if (previous && startLine <= previous.endLine + 1) {
			if (line <= previous.endLine) {
				const extraLines = Math.min(remainingLines, Math.max(0, endLine - previous.endLine));
				previous.endLine += extraLines;
				remainingLines -= extraLines;
				continue;
			}

			const requiredExtraLines = line - previous.endLine;
			if (requiredExtraLines > remainingLines) {
				const blockLineCount = remainingLines;
				const blockStartLine = Math.max(
					previous.endLine + 1,
					Math.min(Math.max(startLine, line - blockLineCount + 1), line),
				);
				blocks.push({ startLine: blockStartLine, endLine: blockStartLine + blockLineCount - 1, text: "" });
				remainingLines = 0;
				break;
			}

			const extraLines = Math.min(remainingLines, endLine - previous.endLine);
			previous.endLine += extraLines;
			remainingLines -= extraLines;
			continue;
		}

		const rangeLineCount = endLine - startLine + 1;
		const blockLineCount = Math.min(remainingLines, rangeLineCount);
		const blockStartLine = Math.min(Math.max(startLine, line - blockLineCount + 1), line);
		blocks.push({ startLine: blockStartLine, endLine: blockStartLine + blockLineCount - 1, text: "" });
		remainingLines -= blockLineCount;
	}

	return blocks.map(block => {
		const blockText = fileLines.slice(block.startLine - 1, block.endLine).join("\n");
		return { ...block, text: formatHashLines(blockText, block.startLine) };
	});
}

export interface CompactHashlineDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

export interface CompactHashlineDiffOptions {
	maxUnchangedRun?: number;
	maxAdditionRun?: number;
	maxDeletionRun?: number;
	maxOutputLines?: number;
}

const NUMBERED_DIFF_LINE_RE = /^([ +-])(\s*\d+)\|(.*)$/;
const HASHLINE_PREVIEW_PLACEHOLDER = "   ";

type DiffRunKind = " " | "+" | "-" | "meta";
type DiffRun = { kind: DiffRunKind; lines: string[] };

interface ParsedNumberedDiffLine {
	kind: " " | "+" | "-";
	lineNumber: number;
	lineWidth: number;
	content: string;
	raw: string;
}

interface CompactPreviewCounters {
	oldLine?: number;
	newLine?: number;
}

function parseNumberedDiffLine(line: string): ParsedNumberedDiffLine | undefined {
	const match = NUMBERED_DIFF_LINE_RE.exec(line);
	if (!match) return undefined;

	const kind = match[1];
	if (kind !== " " && kind !== "+" && kind !== "-") return undefined;

	const lineField = match[2];
	const lineNumber = Number(lineField.trim());
	if (!Number.isInteger(lineNumber)) return undefined;

	return { kind, lineNumber, lineWidth: lineField.length, content: match[3], raw: line };
}

function syncOldLineCounters(counters: CompactPreviewCounters, lineNumber: number): void {
	if (counters.oldLine === undefined || counters.newLine === undefined) {
		counters.oldLine = lineNumber;
		counters.newLine = lineNumber;
		return;
	}

	const delta = lineNumber - counters.oldLine;
	counters.oldLine = lineNumber;
	counters.newLine += delta;
}

function syncNewLineCounters(counters: CompactPreviewCounters, lineNumber: number): void {
	if (counters.oldLine === undefined || counters.newLine === undefined) {
		counters.oldLine = lineNumber;
		counters.newLine = lineNumber;
		return;
	}

	const delta = lineNumber - counters.newLine;
	counters.oldLine += delta;
	counters.newLine = lineNumber;
}

function formatCompactHashlineLine(kind: " " | "+", lineNumber: number, width: number, content: string): string {
	const padded = String(lineNumber).padStart(width, " ");
	return `${kind}${padded}#${computeLineHash(lineNumber, content)}|${content}`;
}

function formatCompactRemovedLine(lineNumber: number, width: number, content: string): string {
	const padded = String(lineNumber).padStart(width, " ");
	return `-${padded}${HASHLINE_PREVIEW_PLACEHOLDER}|${content}`;
}

function formatCompactPreviewLine(line: string, counters: CompactPreviewCounters): { kind: DiffRunKind; text: string } {
	const parsed = parseNumberedDiffLine(line);
	if (!parsed) return { kind: "meta", text: line };

	if (parsed.content === "...") {
		if (parsed.kind === "+") {
			syncNewLineCounters(counters, parsed.lineNumber);
		} else {
			syncOldLineCounters(counters, parsed.lineNumber);
		}
		return { kind: parsed.kind, text: parsed.raw };
	}

	switch (parsed.kind) {
		case "+": {
			syncNewLineCounters(counters, parsed.lineNumber);
			const newLine = counters.newLine;
			if (newLine === undefined) return { kind: "+", text: parsed.raw };
			const text = formatCompactHashlineLine("+", newLine, parsed.lineWidth, parsed.content);
			counters.newLine = newLine + 1;
			return { kind: "+", text };
		}
		case "-": {
			syncOldLineCounters(counters, parsed.lineNumber);
			const text = formatCompactRemovedLine(parsed.lineNumber, parsed.lineWidth, parsed.content);
			counters.oldLine = parsed.lineNumber + 1;
			return { kind: "-", text };
		}
		case " ": {
			syncOldLineCounters(counters, parsed.lineNumber);
			const newLine = counters.newLine;
			if (newLine === undefined) return { kind: " ", text: parsed.raw };
			const text = formatCompactHashlineLine(" ", newLine, parsed.lineWidth, parsed.content);
			counters.oldLine = parsed.lineNumber + 1;
			counters.newLine = newLine + 1;
			return { kind: " ", text };
		}
	}
}

function splitDiffRuns(lines: string[]): DiffRun[] {
	const runs: DiffRun[] = [];
	const counters: CompactPreviewCounters = {};

	for (const line of lines) {
		const formatted = formatCompactPreviewLine(line, counters);
		const prev = runs[runs.length - 1];
		if (prev && prev.kind === formatted.kind) {
			prev.lines.push(formatted.text);
			continue;
		}
		runs.push({ kind: formatted.kind, lines: [formatted.text] });
	}

	return runs;
}

function collapseFromStart(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	return [...lines.slice(0, maxLines), ` ... ${hidden} more ${label} lines`];
}

function collapseFromEnd(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	return [` ... ${hidden} more ${label} lines`, ...lines.slice(-maxLines)];
}

function collapseFromMiddle(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines * 2) return lines;
	const hidden = lines.length - maxLines * 2;
	return [...lines.slice(0, maxLines), ` ... ${hidden} more ${label} lines`, ...lines.slice(-maxLines)];
}

/**
 * Build a compact diff preview suitable for model-visible tool responses.
 *
 * Collapses long unchanged runs and long consecutive additions/removals so the
 * model sees the shape of edits without replaying full file content.
 */
export function buildCompactHashlineDiffPreview(
	diff: string,
	options: CompactHashlineDiffOptions = {},
): CompactHashlineDiffPreview {
	const maxUnchangedRun = options.maxUnchangedRun ?? 2;
	const maxAdditionRun = options.maxAdditionRun ?? 2;
	const maxDeletionRun = options.maxDeletionRun ?? 2;
	const maxOutputLines = options.maxOutputLines ?? 16;

	const inputLines = diff.length === 0 ? [] : diff.split("\n");
	const runs = splitDiffRuns(inputLines);

	const out: string[] = [];
	let addedLines = 0;
	let removedLines = 0;

	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex];
		switch (run.kind) {
			case "meta":
				out.push(...run.lines);
				break;
			case "+":
				addedLines += run.lines.length;
				out.push(...collapseFromStart(run.lines, maxAdditionRun, "added"));
				break;
			case "-":
				removedLines += run.lines.length;
				out.push(...collapseFromStart(run.lines, maxDeletionRun, "removed"));
				break;
			case " ":
				if (runIndex === 0) {
					out.push(...collapseFromEnd(run.lines, maxUnchangedRun, "unchanged"));
					break;
				}
				if (runIndex === runs.length - 1) {
					out.push(...collapseFromStart(run.lines, maxUnchangedRun, "unchanged"));
					break;
				}
				out.push(...collapseFromMiddle(run.lines, maxUnchangedRun, "unchanged"));
				break;
		}
	}

	if (out.length > maxOutputLines) {
		const hidden = out.length - maxOutputLines;
		return {
			preview: [...out.slice(0, maxOutputLines), ` ... ${hidden} more preview lines`].join("\n"),
			addedLines,
			removedLines,
		};
	}

	return { preview: out.join("\n"), addedLines, removedLines };
}

// ─── AST boundary detection ────────────────────────────────────────────────

/**
 * Thrown when a replace operation targets a structural boundary line —
 * i.e. a line that is simultaneously the end of one AST construct and the
 * start of its sibling (e.g. `} else {`, `} catch (err) {`, `},`).
 *
 * To fix: expand the range to include the full construct on one side,
 * or target only body-owned lines inside the construct.
 */
export class SharedBoundaryError extends Error {
	readonly editIndex: number;
	readonly line: number;
	readonly role: "start" | "end";
	readonly construct: string;

	constructor(editIndex: number, line: number, role: "start" | "end", construct: string) {
		const boundary = role === "end" ? "closing" : "opening";
		super(
			`edit[${editIndex}] targets a shared boundary (line ${line + 1}): ` +
				`the ${boundary} line of ${construct} is also the boundary of its sibling. ` +
				`Include the full ${construct} in the range, or target only body-owned lines inside it.`,
		);
		this.name = "SharedBoundaryError";
		this.editIndex = editIndex;
		this.line = line;
		this.role = role;
		this.construct = construct;
	}
}

/**
 * Shared boundary detection.
 *
 * A line L is a shared boundary when it is simultaneously the end of one
 * symbol's range and the start of an adjacent symbol's range — e.g. `} else {`,
 * `} catch (err) {`, `},`. Targeting such a line with a replace operation
 * is ambiguous and typically produces duplicate or missing lines.
 *
 * Throws `SharedBoundaryError` on the first violation found.
 * Pass `null` for `symbols` to skip the check.
 */
export function checkBoundariesForEdits(edits: HashlineEdit[], symbols: DocSymbol[] | null): void {
	if (!symbols?.length) return;

	// Only replace ops can straddle a boundary.
	const replaceOps = edits.flatMap((edit, i) => {
		if (edit.op === "replace_line") return [{ editIndex: i, posLine: edit.pos.line, endLine: edit.pos.line }];
		if (edit.op === "replace_range") return [{ editIndex: i, posLine: edit.pos.line, endLine: edit.end.line }];
		return [];
	});
	if (replaceOps.length === 0) return;

	// Flatten the symbol tree
	const flat: DocSymbol[] = [];
	const flatten = (nodes: DocSymbol[]): void => {
		for (const n of nodes) {
			flat.push(n);
			if (n.children) flatten(n.children);
		}
	};
	flatten(symbols);

	// For each targeted line, check if it is shared between adjacent symbols.
	for (const { editIndex, posLine, endLine } of replaceOps) {
		for (const [line, role] of [[posLine, "start"] as const, [endLine, "end"] as const]) {
			const endsHere = flat.filter(n => n.range.end.line === line);
			const startsHere = flat.filter(n => n.range.start.line === line);
			// A shared boundary requires two DIFFERENT symbols overlapping at this line.
			// A single-line declaration (start === end === line) is not a shared boundary.
			const sharedPair = endsHere.find(e => startsHere.some(s => s !== e));
			if (sharedPair) {
				const construct = sharedPair.name ? `"${sharedPair.name}"` : "the enclosing block";
				throw new SharedBoundaryError(editIndex, line, role, construct);
			}
		}
	}
}

/** Symbol shape returned by `textDocument/documentSymbol`. */
export type DocSymbol = {
	name: string;
	kind: number;
	range: { start: { line: number }; end: { line: number } };
	children?: DocSymbol[];
};

// --- Pre-flight tag verification -------------------------------------------

export interface VerifyTagsResult {
	valid: boolean;
	/** Present when valid is false. Contains remaps for the full edit range. */
	error?: HashlineMismatchError;
}

/**
 * Validate that every tag referenced by `edits` still matches the current
 * file content. Returns `{ valid: true }` when all tags are fresh, or
 * `{ valid: false, error }` with a `HashlineMismatchError` whose `remaps`
 * covers the full `pos..end` range of every failing edit — enough for the
 * caller to rebuild the edit without re-reading the file.
 *
 * This is the same validation that `applyHashlineEdits` runs internally,
 * extracted so callers can check before attempting mutation.
 */
export function verifyTags(text: string, edits: HashlineEdit[]): VerifyTagsResult {
	const fileLines = text.split("\n");
	const mismatches: HashMismatch[] = [];

	function validateRef(ref: { line: number; hash: string }): boolean {
		if (ref.line < 1 || ref.line > fileLines.length) return false;
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash === ref.hash) return true;
		mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
		return false;
	}

	for (const edit of edits) {
		switch (edit.op) {
			case "replace_line": {
				validateRef(edit.pos);
				break;
			}
			case "replace_range": {
				validateRef(edit.pos);
				validateRef(edit.end);
				break;
			}
			case "append_at":
			case "prepend_at": {
				validateRef(edit.pos);
				break;
			}
		}
	}

	if (mismatches.length === 0) return { valid: true };

	// Build enriched remaps: include ALL lines in each edit's pos..end range,
	// not just the mismatched ones, so the caller can rebuild without re-reading.
	const enrichedRemaps = new Map<string, string>();
	for (const m of mismatches) {
		const actual = computeLineHash(m.line, fileLines[m.line - 1]);
		enrichedRemaps.set(`${m.line}#${m.expected}`, `${m.line}#${actual}`);
	}
	for (const edit of edits) {
		const startLine = "pos" in edit ? edit.pos.line : 1;
		const endLine = edit.op === "replace_range" ? edit.end.line : startLine;
		for (let i = startLine; i <= endLine && i <= fileLines.length; i++) {
			const hash = computeLineHash(i, fileLines[i - 1]);
			const key = `${i}#${hash}`;
			// Only add if not already in remaps (mismatched lines keep their old->new mapping)
			if (!enrichedRemaps.has(key)) {
				enrichedRemaps.set(key, key); // identity: this tag is still valid
			}
		}
	}

	const error = new HashlineMismatchError(mismatches, fileLines);
	// Override remaps with enriched version
	(error as { remaps: ReadonlyMap<string, string> }).remaps = enrichedRemaps;
	return { valid: false, error };
}
