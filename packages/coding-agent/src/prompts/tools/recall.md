Search the recall store for relevant past context. The recall store is global and persists across sessions and projects — you can find context from any past session in any project. Use when you need to recall something that was done, read, or discussed. Returns the most relevant past messages and tool results matching your query.

<instruction>
- Describe what you're looking for naturally: the file, decision, error, or event
- Use `role` filter to narrow results (e.g., `tool_result` for file contents you read)
- Use `project` filter to scope results: `current` for this project only, or omit/`all` for cross-project search
- Default returns 5 results; increase `limit` for broader searches (max 20)
- Results are diversity-ranked to avoid repetitive matches
</instruction>

<output>
Returns matching recall entries with turn number, role, tool name, project path, referenced file paths, and full content. Results may come from any session in any project unless filtered.
</output>