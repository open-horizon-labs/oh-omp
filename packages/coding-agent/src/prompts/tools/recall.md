Search the recall store for relevant past context. The recall store is global and persists across sessions and projects — you can find context from any past session in any project. Use when you need to recall something that was done, read, or discussed. Returns the most relevant past messages and tool results matching your query.

<instruction>
- Describe what you're looking for naturally: the file, decision, error, or event
- Use `role` filter to narrow results (e.g., `tool_result` for file contents you read)
- Use `project` filter to scope results: `current` for this project only, or omit/`all` for cross-project search
- Default returns 5 results; increase `limit` for broader searches (max 20)
- Results are diversity-ranked to avoid repetitive matches
- Use `mode: "keyword"` for exact text search (BM25 ranking) over tool results AND conversation messages. Best for identifiers, error codes, file paths, exact values, and specific terms that vector search blurs together in long sessions. Default mode is `"semantic"` (vector search).
- **Expand compressed content:** Two methods depending on the compression type:
  - `[warm:…]` or `[ref:…]` stubs: follow the stub's inline recipe when it has one (e.g. `recall("<path>")` as the query; a stub flagged `edited since this read` means re-read instead — the stored copy is stale). For stubs without a recipe, search by `query` first; result entries include turn numbers, and `turn: N` with a number from those results expands that turn in full. Turn numbers come from recall results, not from stubs.
  - `[… N lines compressed — use recall(query=…) to expand]`: use `query` with text from the visible head/tail lines to find the full original message via semantic search.
</instruction>

<output>
Returns matching recall entries with turn number, role, tool name, project path, referenced file paths, and full content. Results may come from any session in any project unless filtered.
</output>
