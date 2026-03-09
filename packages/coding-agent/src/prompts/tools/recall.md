Search your project's recall store for relevant past context. The recall store is project-scoped (per working directory) and persists across sessions — you can find context from any past session in this project, not just the current one. Use when you need to recall something that was done, read, or discussed in this project. Returns the most relevant past messages and tool results matching your query.

<instruction>
- Describe what you're looking for naturally: the file, decision, error, or event
- Use `role` filter to narrow results (e.g., `tool_result` for file contents you read)
- Default returns 5 results; increase `limit` for broader searches (max 20)
- Results are diversity-ranked to avoid repetitive matches
</instruction>

<output>
Returns matching recall entries with turn number, role, tool name, referenced paths, and full content. Results may come from any session in the current project.
</output>