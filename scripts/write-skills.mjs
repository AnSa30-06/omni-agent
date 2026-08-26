// Generates the skill library. Kept as a script so the skills stay in one
// reviewable place and cannot drift apart in tone or structure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "skills");

const SKILLS = {
  "web-research": {
    description:
      "Find and verify information on the open web. Use when the user asks you to look something up, find sources, compare options, check whether something is true, or gather current information. Also use whenever an answer would otherwise rest on memory of a fast-moving subject.",
    body: `# Web research

## The loop

1. **Search broadly first.** Two or three differently-angled queries beat one query run five ways. Vary the *frame*, not the wording: the official term, the colloquial term, the name of the organisation that would publish it.
2. **Triage on URLs, not snippets.** A primary source (the organisation's own domain) outranks an aggregator, a listicle or an SEO farm, regardless of which one ranked higher.
3. **Fetch before believing.** \`web_search\` gives you snippets written by a search engine. Nothing from a snippet may be stated as fact.
4. **Escalate when a fetch comes back thin.** \`web_fetch\` reports \`thin: true\` when it extracted almost nothing — that is a JavaScript-rendered page. Use \`web_scrape\` with mode \`page\`, or the browser.
5. **Stop when the sources agree and you can cite them.** More searching after that is spend without return.

## Recording what you found

For every claim keep: the **final URL**, the **date on the page** if it has one, and **whether you retrieved it or only saw a snippet**. If you cannot produce those three things, you do not have a citation.

## Traps

- **The redirect trap.** Cite the URL the tool reports back, not the one you requested.
- **The aggregator trap.** Four job boards carrying the same posting is one item. Deduplicate on the underlying thing, not the URL.
- **The stale-page trap.** A page can be live and still describe a closed cycle. Look for an explicit year or deadline before treating it as current, and say so when it has none.
- **The confident-guess trap.** If the page does not state a deadline, the answer is "not stated on the page", not a plausible date.`,
  },

  "deep-research": {
    description:
      "Multi-source investigation where a single page will not answer the question: comparing several options, building a list of many items, or tracing a topic across sources. Use when the user wants breadth and verified detail rather than a quick answer.",
    body: `# Deep research

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

Save structured results with \`document_write\` (\`.csv\` or \`.xlsx\`) as well as summarising them. Keep one column for the source URL and one for anything unverified.`,
  },

  "browser-automation": {
    description:
      "Drive a real browser: fill web forms, log in, navigate JavaScript applications, download files, extract data that only appears after interaction. Use whenever a task needs clicking or typing on a website rather than just reading it.",
    body: `# Browser automation

## Snapshot, act, re-snapshot

The single most common failure is acting on a stale ref.

\`\`\`
browser action=snapshot        -> every element gets [ref=eN]
browser action=type ref=e3 ... -> target by ref
browser action=snapshot        -> ALWAYS, after anything that changed the page
\`\`\`

Navigation, submission, opening a modal, expanding a section — all invalidate refs. A ref that no longer exists gives you a clear error; a ref that now points at a *different* element does not. Re-snapshot.

## Filling a form

1. Snapshot. Read the field labels, types and \`required\` markers off the outline.
2. Fill fields one at a time.
3. **Snapshot again and read back the values.** The outline shows \`value="..."\` and \`checked\`. Confirm every field landed before going further. Date pickers, masked inputs and custom dropdowns silently reject \`type\` more often than plain text fields do.
4. Report the filled values to the user.
5. **Stop.** Do not submit.

## Submission

Filling and stopping is the correct default outcome.

Clicking a submit-shaped control returns \`BLOCKED\` unless you pass \`confirmSubmit: true\`. Only pass it after the user has authorised **that specific submission** in the conversation. Show them what will be sent first.

Never try to defeat a CAPTCHA, bot check, rate limit or access control. If one stops you, say so and hand back.

## When things go wrong

- **Element not found** — re-snapshot; the page moved.
- **Click did nothing** — the real control may be a parent or child of what you clicked. Look at the outline again.
- **Page looks empty** — content may load late. \`action=wait\` then snapshot.
- **A new tab opened** — \`action=list_tabs\`, then \`select_tab\`.

Close the browser when the task is finished.`,
  },

  "data-extraction": {
    description:
      "Pull structured records out of unstructured pages or documents — tables of items, lists of entries, fields from many sources — and validate them before they are used. Use when the output is a table, list or dataset rather than prose.",
    body: `# Structured extraction

## Define the schema first

Name the fields, their types, and which are required, before you extract anything. Extracting first and imposing structure later produces records with fields that were never actually on the page.

## Extract per source, not in bulk

Take one source at a time and fill the schema from *that* source. Filling a field from a different page than the rest of the record is how a record ends up internally inconsistent and unciteable.

Every record carries the URL it came from.

## Validate before reporting

Run these checks and act on them:

- **Required fields present.** A missing required field is \`null\` plus a note, never a guess.
- **Types plausible.** Dates parse. Numbers are numbers. URLs are absolute and were actually fetched.
- **Duplicates collapsed.** Match on the underlying entity, not the URL.
- **Row count matches** what you claimed to have found.

Say explicitly how many records were complete and how many had gaps. A validated table of 8 beats an unvalidated table of 15.

## Output

\`document_write\` to \`.csv\` or \`.xlsx\` with one column per schema field plus \`source_url\`. Keep a \`notes\` column for anything uncertain rather than dropping the uncertainty.`,
  },

  "document-analysis": {
    description:
      "Read and analyse PDFs, Word documents, text and Markdown files: extract specific information, summarise, compare documents, or pull fields out for reuse. Use when the user points at a document on disk.",
    body: `# Document analysis

## Read it before answering

\`document_read\` handles PDF, DOCX, TXT and Markdown. For a long PDF, pass \`maxPages\` and read the section you need rather than the whole thing.

Output is truncated when large, and says so. If you see the truncation marker and the answer might be past it, read further — do not answer from the prefix and hope.

## Extracting specific fields

Quote the document for anything you report as its content. If a field is absent, say it is absent; documents routinely omit what you were asked to find, and inventing a plausible value is worse than reporting the gap.

Note the page number for anything important, so the user can check it.

## Scanned PDFs

If a PDF returns little or no text, it is probably a scan with no text layer. Say so — do not report an empty extraction as an empty document.

## Feeding a form

When filling a web form from a document: read the document first, list the field-to-value mapping, show the user that mapping, then fill. Do not read and type in the same step — that is where values end up in the wrong boxes.`,
  },

  "spreadsheet-analysis": {
    description:
      "Analyse CSV, TSV, XLSX and JSON data files: summary statistics, column profiling, finding patterns, answering questions about a dataset, and producing derived tables. Use whenever the user points at tabular data.",
    body: `# Spreadsheet and data analysis

## Start with data_analyze, always

\`data_analyze\` is deterministic, runs locally, and **costs no model tokens**. It gives you row and column counts, per-column type, missing-value counts, distinct counts, min/max/mean/median/stdev for numeric columns and top values for text columns.

Reading a whole spreadsheet into the conversation to compute a mean is the single most wasteful thing you can do with a data file.

## Read the profile before trusting the data

The profile tells you what is wrong with the file:

- **Missing values** — decide explicitly whether to drop or keep those rows, and say which.
- **A "numeric" column typed as text** — currency symbols, thousands separators or stray units. Say so before averaging it.
- **\`distinct\` equal to row count** on a column you expected to repeat — probably an id, not a category.
- **\`distinct\` of 1** — a constant column, carrying no information.

## Computation

For anything beyond the profile, write a small script (Python or Node) and run it. Do not do arithmetic over many rows in your head — it is slower and it is wrong more often.

Show the script. The user should be able to re-run it.

## Output

Save derived tables with \`document_write\`. State the row count of every table you produce, and whether rows were dropped and why.`,
  },

  coding: {
    description:
      "Write, extend or refactor code in any language. Use when the user asks for a program, a script, a feature, or changes to existing code.",
    body: `# Coding

## Read before writing

Look at the surrounding code first. Match its style, its naming, its error handling and its comment density, even where you would personally do it differently. Consistency is worth more than your preference.

## The smallest change that works

- No features that were not asked for.
- No abstraction for a single call site.
- No configurability nobody requested.
- No error handling for conditions that cannot occur.

If the implementation is much longer than the problem, rewrite it shorter.

## Verify, then claim

Run it. Run the tests. Report the actual output, including failures — a failing test reported honestly is worth far more than a passing claim that is not true.

If you cannot run it, say exactly that: "I could not execute this; here is what I would check."

## Cleaning up

Remove imports and variables that *your* change orphaned. Leave pre-existing dead code alone — mention it instead.

## For a non-technical user

Explain in the answer what the program does and how to run it. Keep the technical detail in the code and its comments.`,
  },

  debugging: {
    description:
      "Diagnose why code, a script or a tool is failing. Use when something errors, produces the wrong result, or behaves inconsistently.",
    body: `# Debugging

## Reproduce first

You cannot fix what you have not seen fail. Get the actual error text and the actual command. A described symptom is a hypothesis; a reproduction is evidence.

## Read the whole error

The first line names the symptom. The stack trace names the location. The lines *above* the error often name the cause. People skip those.

## Narrow before theorising

Bisect: what is the smallest input that still fails? What is the last version that worked? Which half of the pipeline still produces the right value?

Print the actual values at the boundary. Assumptions about what a variable contains are the usual culprit — especially "it returned an object" when it returned a promise, or "it's a number" when it's a numeric string.

## Beware the check that passes on a broken system

A test that passes because it never ran, a health check that returns 200 from a cached page, a mock that answers the question the real thing would fail. When a result seems to clear something you expected to be broken, verify the check itself actually exercised the thing.

## Fix the cause

A fix that makes the symptom disappear without explaining it is a fix you will pay for again. If you genuinely cannot find the cause and must work around it, say so and mark it in the code.

Then re-run the reproduction and show it passing.`,
  },

  github: {
    description:
      "Git and GitHub workflows: inspecting history, branching, committing, pull requests and issues. Use when the user mentions git, GitHub, commits, branches, PRs or issues.",
    body: `# Git and GitHub

## Look before you act

\`git status\` and \`git diff\` before anything that changes state. Know what is staged, what is not, and what branch you are on.

Never commit or push unless the user asked. If you are on the default branch and about to commit, branch first.

## Commits

One logical change per commit. A message that says *why*, not a restatement of the diff.

Do not commit build output, dependency directories, local config, or anything under a data or cache directory. Check \`.gitignore\` covers them.

## Before any push

**Scan for secrets.** API keys, tokens, \`.env\` files, credential stores. A pushed secret is a rotated secret, not a deleted one — removing the file does not remove it from history.

## Destructive operations

\`push --force\`, \`reset --hard\` and \`clean -fd\` destroy work that may not exist anywhere else. Confirm with the user, and prefer the safer form (\`--force-with-lease\`) where one exists.

## GitHub

Use the \`gh\` CLI. For a PR: state what changed and why, and what you tested. Link the issue it closes.`,
  },

  "file-organization": {
    description:
      "Find, sort, rename, move and tidy files and folders. Use when the user asks you to organise, clean up, locate or restructure files on disk.",
    body: `# File organisation

## Survey before moving

List what is actually there and report the plan before executing it. Folder names lie in both directions — a directory called \`old\` may hold the current work.

Read enough of an ambiguous file to know what it is. Do not classify by extension alone.

## Moving is reversible; deleting is not

Prefer moving to an \`_archive\` folder over deleting. If the user explicitly wants deletion, list exactly what will go and get confirmation on that list.

Never delete something you have not looked at.

## Renaming in bulk

Show the first few old-to-new pairs and get agreement before applying the rest. Check for collisions first — two source files mapping to one destination name silently destroys one of them.

## Report

Say what moved, what was skipped and why, and where things went. A tidy-up nobody can retrace is not a tidy-up.`,
  },

  "quota-and-models": {
    description:
      "Answer questions about which AI model is being used, what it costs, how much quota or credit is left, and how to switch to a faster, cheaper or stronger model. Use when the user asks about models, speed, cost, credits, quota or billing.",
    body: `# Models, quota and cost

Use \`agent_status\` for all of this. It reads live figures; do not answer from memory.

## What the numbers actually mean

The dashboard keeps three different things apart, and so should you:

- **Provider balance or quota** — read live from the provider's own API. Only some providers publish one. DeepSeek and OpenRouter do. Anthropic and OpenAI expose usage only to *Admin* keys. Google publishes none at all.
- **Gateway free tier** — the model gateway's own accounting, and only visible when a management-scoped key is configured.
- **Token usage** — measured on this machine, from the usage each API response reported.

When something says **Unavailable**, that is the true answer. Report it as such, with the reason the dashboard gives. **Never estimate a quota, a balance or a remaining-token figure.** A confident invented number is the worst possible output here.

Distinguish **Live** from **Last known value** — the dashboard labels both, and so should you.

## Speed

Throughput is shown only for models this machine has actually measured, and it is a local measurement, not a provider specification. If a model has no measurement, say it has not been measured yet.

## Switching

- \`agent_status action=set_mode mode=fast|balanced|smart|quality|cheap\`
- \`agent_status action=models\` to list what the gateway currently serves
- \`agent_status action=pin_model model=<id>\` to force one model, \`unpin_model\` to restore automatic routing

Capability tiers ("strong", "elite") are this product's own editorial estimates, held in a config file. They are **not** benchmark scores. Say so if the user asks where the ranking comes from.`,
  },
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const [name, s] of Object.entries(SKILLS)) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const front = ["---", `name: ${name}`, `description: ${s.description}`, "---", ""].join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), front + "\n" + s.body + "\n");
}

console.log(`wrote ${Object.keys(SKILLS).length} skills to ${OUT}`);
