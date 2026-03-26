Reads files. Code files return RNA structural view by default (signatures, types, line ranges, node IDs). Specify `offset` to get actual source lines with edit anchors. Non-code files return content normally.

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
**Code files — two modes:**
- `read(path="file.ts")` → RNA structural view with signatures, types, and node IDs. Use to understand a file.
- `read(path="file.ts", offset=50, limit=100)` → actual source lines with edit anchors. Use when editing.

**Follow-up from structural view:**
- Node IDs in results can be used with `mcp_rna_server_search(node="<id>", include_body=true, minify_body=true)` for function bodies
- Or `mcp_rna_server_search(node="<id>", mode="neighbors")` for call graph

**Non-code files:** JSON, YAML, configs, images, PDFs, markdown — works normally.
**Directory listings:** `read(path="dir/")` — works normally.
</when-to-use>

<output>
- Code files without offset: RNA structural view with signatures and node IDs
- Code files with offset: source lines with edit anchors
- Non-code files: file content as text
- Images: visual content; PDFs: extracted text
- Missing files: closest filename matches for correction
</output>

<critical>
- You **MUST** use `read` instead of bash for ALL file reading: `cat`, `head`, `tail`, `less`, `more` are FORBIDDEN.
- You **MUST** use `read(path="dir/")` instead of `ls dir/` for directory listings.
- You **MUST** always include the `path` parameter — NEVER call `read` with empty arguments `{}`.
- When RNA gives you a function at lines 450-600, read ONLY those lines: `read(path, offset=450, limit=150)`.
</critical>