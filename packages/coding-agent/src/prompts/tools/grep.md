Searches the codebase. Identifier patterns (function names, types, symbols) return RNA structural results with signatures, line ranges, and node IDs. Regex and text patterns fall through to ripgrep.

<instruction>
- Identifier patterns (e.g., `transformMessages`, `TokenBudget`) are routed through RNA — results include signatures, complexity, and stable node IDs
- Regex patterns (e.g., `log.*Error`, `"error_code":\s*"\w+"`) go through ripgrep text search
- `path` may be a file, directory, glob path, or comma/space-separated path list; pair it with `glob` when you need an additional relative file filter
- Filter files with `glob` (e.g., `*.json`, `**/*.yaml`) or `type` (e.g., `json`, `md`)
- Respects `.gitignore` by default; set `gitignore: false` to include ignored files
</instruction>

<when-to-use>
**Symbol search** (RNA-backed):
- `grep("transformMessages")` → structural results with signatures and node IDs
- `grep("TokenBudget")` → finds type definitions with metadata

**Text search** (ripgrep fallthrough):
- `grep("ENOENT|EACCES")` → regex text matches
- `grep("TODO|FIXME")` → text pattern matches in code/comments
- `grep("DATABASE_URL", path=".env")` → config search

**Follow-up from RNA results:**
- Node IDs can be used with `mcp_rna_server_search(node="<id>", include_body=true)` for bodies
- Or `mcp_rna_server_search(node="<id>", mode="neighbors")` for call graph
</when-to-use>

<output>
{{#if IS_HASHLINE_MODE}}
- Text output is CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- You **MUST** use Grep for codebase search — it routes to RNA or ripgrep automatically.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- If the search is open-ended, requiring multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>
