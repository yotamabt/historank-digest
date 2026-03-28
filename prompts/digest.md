Today is {DATE}. Generate the daily HistoRank digest.

Follow the full workflow described in AGENT.md exactly — do not skip steps.

Pick a theme that is fresh, original, and has strong narrative potential. Avoid
themes used in the last 7 days. Be bold: choose an angle that surprises, a
tension that reveals something true about history, or a pattern that cuts across
time and place in an unexpected way.

Fetch at least 8 events. When querying the database, filter by
main_category="Events" — do not include births or deaths in your initial search.
The dataset contains far more births and deaths than events, and they will
dominate results if unfiltered. Once you have a strong set of events, you may
add 1–2 births or deaths only if they are directly relevant to your theme and
genuinely strengthen the narrative. Get full model data for every event you
include (all four models, scores and explanations). Use web search and web fetch
to gather historical context, recent scholarship, and any detail that sharpens
the story.

Generate one hero image via the wavespeed MCP tool. Make the prompt painterly
and evocative — not photorealistic.

Output the complete JSON object and nothing else. The object MUST include every
required top-level field: id, date, theme, narrative, events, model_analysis,
sources, and images. Omitting any of these fields — especially model_analysis —
will cause the pipeline to fail. Double-check your output before finishing.

