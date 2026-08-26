---
name: deep-research
description: Multi-source investigation where a single page will not answer the question: comparing several options, building a list of many items, or tracing a topic across sources. Use when the user wants breadth and verified detail rather than a quick answer.
---

# Deep research

Use this when the task is "find N things" or "compare X, Y and Z", not when one page answers it.

## Structure the work before searching

Write down what a *complete* answer looks like — the fields every item must have — before you start. Fields you did not plan for are fields you will end up guessing.

## Breadth then depth

1. **Sweep.** Several searches from genuinely different angles. Collect candidate URLs; do not read yet.
2. **Deduplicate the candidate list.** Same organisation + same role = one item, whichever four sites carry it.
3. **Read the survivors.** Fetch each one. Fill the fields from the retrieved page.
4. **Fill gaps at the source.** If a field is missing, go to the organisation's own site rather than trusting an aggregator's version of it.
5. **Report the gaps you could not fill.** An item with an honest "deadline not stated" is worth more than one with an invented date.

## Coverage

Track what you have and what you still need. When you are short, change the *angle* rather than repeating the search — a different vocabulary, a different kind of publisher, a direct crawl of the section that would list it.

Stop when either the target count is met with verified sources, or you can state specifically why the remainder does not exist in reachable form.

## Output

Save structured results with `document_write` (`.csv` or `.xlsx`) as well as summarising them. Keep one column for the source URL and one for anything unverified.
