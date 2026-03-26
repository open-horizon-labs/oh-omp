Searches for patterns in the codebase. For identifier-like patterns (function names, types, symbols), returns structural results from RNA with signatures, line ranges, and node IDs. For regex patterns and text literals, falls through to ripgrep.

<instruction>
- Identifier patterns (e.g., `transformMessages`, `TokenBudget`) are routed through RNA structural search — results include signatures, complexity, and stable node IDs you can use with `mcp_rna_server_search(node=..., include_body=true)` for function bodies or `mode="neighbors"` for call graph traversal
- Regex patterns (e.g., `log.*Error`, `"error_code":\s*"\w+"`) go through ripgrep text search
- `path` may be a file, directory, glob path, or comma/space-separated path list; pair it with `glob` when you need an additional relative file filter
- Filter files with `glob` (e.g., `*.json`, `**/*.yaml`) or `type` (e.g., `json`, `md`)
- Respects `.gitignore` by default; set `gitignore: false` to include ignored files
</instruction>

<output>
{{#if IS_HASHLINE_MODE}}
- Text output is CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
- RNA results include node IDs — use them for follow-up queries: `mcp_rna_server_search(node="<id>", include_body=true, minify_body=true)` for bodies, or `mode="neighbors"` for call graph
</output>

<critical>
- You **MUST** use Grep for codebase search — it routes automatically to RNA or ripgrep.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- If the search is open-ended, requiring multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>
