Searches files for TEXT patterns using regex — error messages, string literals, config keys, comments, non-code content.

<instruction>
- Supports full regex syntax (e.g., `log.*Error`, `"error_code":\\s*"\\w+"`); literal braces need escaping (`interface\\{\\}` for `interface{}` in Go)
- `path` may be a file, directory, glob path, or comma/space-separated path list; pair it with `glob` when you need an additional relative file filter
- Filter files with `glob` (e.g., `*.json`, `**/*.yaml`) or `type` (e.g., `json`, `md`)
- Respects `.gitignore` by default; set `gitignore: false` to include ignored files
- For cross-line patterns, set `multiline: true` if needed
- If the pattern contains a literal `\n`, multiline defaults to true
</instruction>

<when-to-use>
**Use `grep` for:**
- Error messages and log strings: `grep(pattern="ENOENT|EACCES", path="src/")`
- Config values and environment variables: `grep(pattern="DATABASE_URL", path=".env")`
- String literals and comments: `grep(pattern="TODO|FIXME|HACK", path="src/")`
- Non-code file content: JSON keys, YAML values, markdown headings
- Regex text patterns that need exact text matching

**Do NOT use `grep` for code symbol search.** Use `mcp_rna_server_search` instead:
- "Find function X" → `mcp_rna_server_search(query="X", kind="function", compact=true)`
- "Find all types/interfaces" → `mcp_rna_server_search(query="X", kind="trait", compact=true)`
- "Find imports of X" → `mcp_rna_server_search(query="X", mode="neighbors", direction="incoming")`
- "Find files containing symbol X" → `mcp_rna_server_search(query="X", compact=true)`
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
- You **MUST** use Grep for text/string content search.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- You **MUST NOT** use `grep` to find function definitions, type declarations, or call sites — use `mcp_rna_server_search` instead.
- If the search is open-ended, requiring multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>
