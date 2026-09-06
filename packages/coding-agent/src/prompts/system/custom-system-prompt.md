{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{customPrompt}}
{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
{{#ifAny contextFiles.length git.isRepo}}
<project>
{{#if contextFiles.length}}
## Context
<instructions>
{{#list contextFiles join="\n"}}
<file path="{{path}}">
{{content}}
</file>
{{/list}}
</instructions>
{{/if}}
{{#if git.isRepo}}
## Version Control
Snapshot; does not update during conversation.
Current branch: {{git.currentBranch}}
Main branch: {{git.mainBranch}}
{{git.status}}
### History
{{git.commits}}
{{/if}}
</project>
{{/ifAny}}
{{#if skills.length}}
Skills provide specialized guidance. Read `skill://<name>` when its guidance is useful for the task or the user requests it; a domain match alone does not require loading it.
<skills>
{{#list skills join="\n"}}
<skill name="{{name}}">
{{description}}
</skill>
{{/list}}
</skills>
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/if}}
{{#if rules.length}}
Rules are local constraints.
You **MUST** read `rule://<name>` when working in that domain.
<rules>
{{#list rules join="\n"}}
<rule name="{{name}}">
{{description}}
{{#if globs.length}}
{{#list globs join="\n"}}<glob>{{this}}</glob>{{/list}}
{{/if}}
</rule>
{{/list}}
</rules>
{{/if}}
Current date: {{date}}
Current working directory: {{cwd}}
{{#if secretsEnabled}}
<redacted-content>
Some values in tool output are redacted for security. They appear as `#XXXX#` tokens (4 uppercase-alphanumeric characters wrapped in `#`). These are **not errors** — they are intentional placeholders for sensitive values (API keys, passwords, tokens). Treat them as opaque strings. Do not attempt to decode, fix, or report them as problems.
</redacted-content>
{{/if}}
