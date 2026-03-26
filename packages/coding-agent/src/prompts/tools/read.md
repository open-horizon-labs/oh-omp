Reads source lines from files for editing, and reads non-code files.

<instruction>
- Reads up to {{DEFAULT_LIMIT}} lines default
- Use `offset` and `limit` for large files; max {{DEFAULT_MAX_LINES}} lines per call
{{#if IS_HASHLINE_MODE}}
- Filesystem output is CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Filesystem output is line-number-prefixed
{{/if}}
{{/if}}
- Supports images (PNG, JPG) and PDFs
- For directories, returns formatted listing with modification times
</instruction>

<when-to-use>
**Use `read` for:**
- Getting source lines with anchors BEFORE calling `edit` — this is the primary use case
- Targeted line-range reads when RNA points you to specific lines (e.g., `read(path, offset=450, limit=50)`)
- Non-code files: JSON, YAML, configs, images, PDFs, markdown
- Directory listings: `read(path="dir/")`

**Do NOT use `read` for code understanding.** Use `mcp_rna_server_search` instead:
- "What functions does this file have?" → `mcp_rna_server_search(file="X", compact=true, include_markdown=false)`
- "What's the signature of X?" → `mcp_rna_server_search(query="X", compact=true, include_markdown=false)`
- "How does function X work?" → `mcp_rna_server_search(node="<id>", include_body=true, minify_body=true)`
- "What calls X?" → `mcp_rna_server_search(node="<id>", mode="neighbors", direction="incoming")`
- "Show me the codebase" → `mcp_rna_server_repo_map`
</when-to-use>

<output>
- Returns file content as text; images return visual content; PDFs return extracted text
- Missing files: returns closest filename matches for correction
</output>

<critical>
- You **MUST** use `read` instead of bash for ALL file reading: `cat`, `head`, `tail`, `less`, `more` are FORBIDDEN.
- You **MUST** use `read(path="dir/")` instead of `ls dir/` for directory listings.
- You **MUST** always include the `path` parameter — NEVER call `read` with empty arguments `{}`.
- You **MUST NOT** read whole files to understand code structure — use `mcp_rna_server_search` with `compact: true` instead.
- You **MUST** use `offset` and `limit` to read only the lines you need, not the whole file.
- When RNA search gives you a function at lines 450-600, read ONLY those lines: `read(path, offset=450, limit=150)`.
</critical>
