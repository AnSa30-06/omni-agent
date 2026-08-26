---
name: web-research
description: Find and verify information on the open web. Use when the user asks you to look something up, find sources, compare options, check whether something is true, or gather current information. Also use whenever an answer would otherwise rest on memory of a fast-moving subject.
---

# Web research

## The loop

1. **Search broadly first.** Two or three differently-angled queries beat one query run five ways. Vary the *frame*, not the wording: the official term, the colloquial term, the name of the organisation that would publish it.
2. **Triage on URLs, not snippets.** A primary source (the organisation's own domain) outranks an aggregator, a listicle or an SEO farm, regardless of which one ranked higher.
3. **Fetch before believing.** `web_search` gives you snippets written by a search engine. Nothing from a snippet may be stated as fact.
4. **Escalate when a fetch comes back thin.** `web_fetch` reports `thin: true` when it extracted almost nothing — that is a JavaScript-rendered page. Use `web_scrape` with mode `page`, or the browser.
5. **Stop when the sources agree and you can cite them.** More searching after that is spend without return.

## Recording what you found

For every claim keep: the **final URL**, the **date on the page** if it has one, and **whether you retrieved it or only saw a snippet**. If you cannot produce those three things, you do not have a citation.

## Traps

- **The redirect trap.** Cite the URL the tool reports back, not the one you requested.
- **The aggregator trap.** Four job boards carrying the same posting is one item. Deduplicate on the underlying thing, not the URL.
- **The stale-page trap.** A page can be live and still describe a closed cycle. Look for an explicit year or deadline before treating it as current, and say so when it has none.
- **The confident-guess trap.** If the page does not state a deadline, the answer is "not stated on the page", not a plausible date.
