<critical>
Plan approved. You **MUST** execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`

## Plan

{{planContent}}

<instruction>
Implement the approved plan from `{{finalPlanFilePath}}`. You have full tool access. Respect its scope and dependencies, and verify the result with checks appropriate to the changes.
{{#has tools "todo_write"}}
Use `todo_write` if tracking helps maintain continuity or the user requested it. Update at meaningful milestones and batch related changes; plan approval alone does not require a task list.
{{/has}}
</instruction>

<critical>
You **MUST** keep going until complete. This matters.
</critical>
