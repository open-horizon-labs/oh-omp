/**
 * Shared file path extraction from tool execution args and results.
 *
 * Used by both the bridge and telemetry modules to identify paths
 * touched during tool execution.
 */

/**
 * Extract file paths from tool execution args.
 *
 * Covers common arg patterns across all tool types:
 * - `path`, `file`, `filePath`, `file_path`, `target` for direct path args
 * - `directory`, `dir` for directory-scoped tools (grep, find)
 * - `notebook_path`, `notebookPath` for notebook tools
 */
export function extractPaths(toolName: string, args: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();

	const add = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0 && !seen.has(value)) {
			seen.add(value);
			paths.push(value);
		}
	};

	// Common direct-path arg names
	add(args.path);
	add(args.file);
	add(args.filePath);
	add(args.file_path);
	add(args.target);

	// Tool-specific extraction
	switch (toolName) {
		case "grep":
		case "find":
		case "ast_grep":
			add(args.directory);
			add(args.dir);
			break;

		case "notebook":
			add(args.notebook_path);
			add(args.notebookPath);
			break;

		case "lsp":
			add(args.file);
			break;
	}

	return paths;
}
