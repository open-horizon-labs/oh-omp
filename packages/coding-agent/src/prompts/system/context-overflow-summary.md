Update the historical execution summary for the current user request.

<current-user-request>
{{{userAnchor}}}
</current-user-request>

{{#if previousSummary}}
<previous-historical-summary>
{{{previousSummary}}}
</previous-historical-summary>
{{/if}}

<newly-absorbed-history>
{{{conversation}}}
</newly-absorbed-history>

Return only the updated historical summary. Integrate the previous summary with the newly absorbed history instead of describing the summarization process.
