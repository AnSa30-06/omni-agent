# Omni Decisions: MVP plan

*Written 2026-09-09 after a full read of the `omni-agent` repository at 1.2.0 (commit `5ab3c0a`).
This is a plan, not an implementation. Nothing in the repository was changed to produce it.
It is written for the engineer who will build it (Claude Opus) and assumes they have never
seen the product concept or this conversation.*

*The source brief lives at `C:\Users\Abc\Desktop\cobiprompt.txt`. The transcript it refers
to was not supplied and was not found on disk; the concept was taken from the brief itself and
from the public descriptions of Cobi (hellocobi.com) and Shiplog (useshiplog.com), which both
describe the same loop: read customer data continuously, notice what changed, recommend the
next action with evidence, act inside the tools the team already uses.*

---

## Table of contents

1. Executive summary
2. What Omni Agent already provides (measured, not assumed)
2A. Cobi, and Shiplog beside it: what they built, what they claim, and the gaps this clone takes
3. What the new product is
4. Core user problem
5. MVP hypothesis
6. Target user
7. Core user journey
8. MVP feature list
9. Explicit non-goals
10. Data architecture
11. Signal architecture
12. LLM architecture
13. Decision architecture
14. Follow-up and action architecture
15. Dashboard and UI architecture
16. Screen-by-screen UX specification
17. Synthetic and demo data strategy
18. External intelligence recommendation
19. Security and privacy architecture
20. Testing strategy
21. Evaluation methodology
22. Success metrics
23. Implementation phases
24. File-level implementation plan
25. Opus execution checklist
26. "How to use the MVP" documentation outline
27. Risks and technical unknowns
28. What to validate before expanding
29. BUILD NOW / BUILD LATER / DO NOT BUILD
30. Final recommendation

Appendix A: the Opus execution specification (self-contained)

---

## 1. Executive summary

**Build a second product surface inside the existing Omni Agent desktop app, called
Decisions.** It reads a small set of customer-data tables (accounts, usage, tickets,
invoices, contacts), computes signals deterministically, combines them into candidate
situations with declarative rules, sends only the top candidates to one model call each,
and turns the answer into a persistent Decision with evidence, hypotheses, a recommended
action, an owner, a due date, a status, a history, and eventually an outcome.

**What gets reused (about half the work is already done):**

- the desktop shell, its HTTP server, per-launch token, loopback guard and CSP
  (`src/ui/server.mjs`), and the page/card/tag/modal/toast design system (`app.css`);
- the only model-calling function in the product, `complete()` in
  `src/routing/execute.mjs`, which already does intent-based routing, fallback across
  models, and per-call telemetry;
- `node:sqlite`, which the bundled Node 24.18.0 provides and which `api.mjs` already uses;
- the CSV/XLSX readers in `src/tools/documents.mjs`, the Windows folder picker in
  `src/ui/api.mjs`, the DPAPI secret store, the redacting logger, the in-app scheduler
  pattern in `src/ui/routines.mjs`, the hermetic `node --test` unit-test convention, and
  the CLI dispatcher in `bin/omni-agent.mjs`.

**What is new:** a `src/decisions/` module (database, ingest, synthetic data, signal engine,
situation rules, LLM packet/prompt/validator, decision lifecycle, follow-up scheduler,
two human-in-the-loop actions, routes), a `src/ui/public/decisions/` shell (its own HTML
page, JS module and CSS, importing `app.css`), a `config/decisions/rules.json` threshold
file, unit tests, an evaluation harness with a labelled synthetic benchmark, and a user
manual under `docs/decisions/`.

**What is deliberately not built:** integrations (Stripe, HubSpot, Salesforce and the
rest), external-news lookup, autonomous actions, multi-user accounts, a chat interface,
charts, model training, and anything that runs when the app is closed.

**Data strategy:** a synthetic SaaS company generated deterministically with six planted
scenario types, imported through the same CSV path a real export would use. One real
connector (Stripe) is a later phase, once the loop is proven.

**The smallest version worth building** is Phases 0 to 8 in section 23: demo data in,
decisions out, a human handles them, reminders persist, an outcome is recorded. Phases 9
(evaluation) and 10 (documentation) are what make it a validated product rather than a
demo. All eleven phases are in scope for the MVP; nothing beyond them is.

---

## 2. What Omni Agent already provides (measured, not assumed)

Everything below was read from the code, not from the README. Where the README and the
code disagree, the code is stated.

### 2.1 Shape

```
OmniAgent.exe (Node SEA)  -> src/ui/launch.mjs
  starts OmniRoute gateway  (127.0.0.1:20129, isolated DATA_DIR)
  starts `opencode serve`   (random port, HTTP Basic, per-launch password)
  starts src/ui/server.mjs  (random loopback port, per-launch token)
  opens Chromium --app=     (or Edge / Chrome / default browser)
```

Plain ESM JavaScript, **no build step, no TypeScript, no bundler, no frontend framework.**
Node `>=22.12.0` declared; the installer bundles **v24.18.0** and CI runs Node 24.

### 2.2 Frontend

- `src/ui/public/index.html`: one static page. Sidebar with a Chat/Code segment, a
  session list and nine nav buttons (`data-page`). Main area is either the conversation
  view or `#view-page`, into which every settings-style page renders.
- `src/ui/public/app.js` (2,997 lines, an ES module): `api(name, {method, body, query})`
  calls `/x/<name>`; `ocall()` proxies to OpenCode. Pages are `pages[name] = async () =>
  {...}` and use `page(title, lede)`, `el(tag, cls, text)`, `toast(msg, kind)`, `$()`.
  Everything is built with DOM calls; **model output is never inserted as HTML.**
- `src/ui/public/app.css` (585 lines): CSS variables for a light and dark palette
  (`--bg`, `--ink`, `--accent #c15f3c`, `--good`, `--warn`, `--bad`), cards, tags
  (`.tag.on/.off/.warn`), pills, buttons (`.btn`, `.primary`, `.danger`), form fields
  (`label.f`, `.grid2`), popovers, modal, toasts, `.bar` meters, startup screen.
- CSP is `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  connect-src 'self'`. **Nothing can be loaded from a CDN.** ES module `import` of local
  files works under `script-src 'self'`.
- Preferences are on disk (`ui-prefs.json`) because the page's origin changes every
  launch; `localStorage` is useless here.

### 2.3 Backend

- `src/ui/server.mjs`: serves `src/ui/public/**` (any path under it, with containment
  check), rejects non-loopback Host headers, requires the token on `/oc/*` and `/x/*`,
  caps request bodies at 8 MB, dispatches `/x/<name>` to the `routes` table exported by
  `src/ui/api.mjs`. Route shape: `async fn({body, query, method}) => ({ok, ...})`;
  `ok:false` becomes HTTP 400.
- `src/ui/api.mjs` (1,232 lines): 40-odd routes: status, models, usage, saving, providers,
  search, settings, prefs, folders/files (with real Windows dialogs via PowerShell
  WinForms, one at a time), transcripts, routines, tools/MCP, dashboard, gateway repair,
  session compaction.
- `src/ui/launch.mjs`: single-instance lock, startup steps, starts the transcript
  archiver and the routine scheduler after the agent is up.

### 2.4 Agents

OpenCode 1.18.23 is the harness. `src/setup/opencode-config.mjs` writes `opencode.json`
with agents `omni` (primary), `research`, `browse`, `code` (subagents); the desktop UI uses
OpenCode's built-in `plan` (Chat) and `build` (Code). Instructions in
`config/opencode/AGENTS.md`. Skills in `skills/*/SKILL.md`, generated by
`scripts/write-skills.mjs`. **An agent session is a conversation; it is not a job runner.**

### 2.5 Models

- OmniRoute 3.8.49 gateway, OpenAI-compatible `/v1/chat/completions`. `GatewayClient.chat()`
  in `src/gateway/client.mjs` sends `model, messages, stream:false, max_tokens, tools?,
  temperature?`. **It does not send `response_format`.** Usage is normalised and labelled
  `source: "provider" | "unavailable"`.
- `complete({task, messages, maxTokens, timeoutMs, model?, mode?})` in
  `src/routing/execute.mjs` is **the only place that calls a model.** It maps
  `task -> intent` through `config/models/metadata.json` (`tasks` table: classify, title,
  extract-simple, dedupe -> cheap; summarise -> fast; plan, reason, browser-plan,
  synthesise -> smart; code -> coding; chat -> balanced), then `intent x preset -> auto/*
  combo`, then walks a fallback chain (`auto/smart`, `auto/chat`, `auto/fast`,
  `auto/best-free`) on 401/402/403/429/5xx/timeouts. Every attempt is recorded by
  `recordCall()` in `src/usage/telemetry.mjs` as JSONL under
  `%LOCALAPPDATA%\OmniAgent\telemetry\`.
- Keyless reality (dev-log `omni-agent-free-model-pool`, 2026-09-03): **without a provider
  key only the six `oc/*` models answer.** They are slow and mostly non-reasoning. A
  provider key (Mistral, Gemini, DeepSeek, OpenRouter) is what makes the model layer
  dependable. This matters for the LLM design in section 12.

### 2.6 Tools

Eight in-process tools in `plugin/index.mjs`: `web_search`, `web_fetch`, `web_scrape`,
`browser` (Playwright in a separate Node host process), `document_read`, `document_write`,
`data_analyze` (deterministic, local), `gateway`, `agent_status`. The underlying modules
are importable from `src/tools/` without OpenCode: `documents.mjs` exports `parseCsv`,
`toCsv`, `readDocument`, `writeDocument`, `analyzeData` (CSV, TSV, XLSX, JSON, PDF, DOCX).

### 2.7 Persistence

JSON files under `%LOCALAPPDATA%\OmniAgent\` (`config.json`, `ui-prefs.json`,
`routines.json`, `transcripts/index.json`, telemetry JSONL). **No application database.**
The gateway keeps its own `storage.sqlite`. `node:sqlite` (`DatabaseSync`) is available
without a flag on the bundled Node and is already imported in `api.mjs` (`gatewayRepair`).
Verified on this machine: `new DatabaseSync(':memory:')`, `exec`, `prepare().run/get/all`
all work.

### 2.8 Authentication

Local, single user. Per-launch UI token in the window URL, loopback Host check, OpenCode
Basic auth held server-side. **No user accounts, no roles, no multi-tenancy.** Secrets:
DPAPI-encrypted `credentials.dat` via `src/util/secrets.mjs`.

### 2.9 Background execution

`src/ui/routines.mjs`: a saved prompt plus a schedule. In-app scheduler is a 30-second
`setInterval` started from `launch.mjs`; "even when closed" registers a Windows Scheduled
Task running `omni-agent routine run <id>`. **A routine runs an agent session**, so it is
the wrong primitive for deterministic analysis; its scheduler pattern is the right one to
copy.

### 2.10 Notifications

`toast()` in the page. Nothing else: no OS notifications, no email, no Telegram.

### 2.11 APIs

`/x/*` (above) and OpenCode's own server through `/oc/*`. CLI in `bin/omni-agent.mjs`:
`ui`, `setup`, `doctor`, `usage`, `models`, `route`, `provider`, `dashboard`, `saving`,
`routine`, `gateway`, `config`, `diagnostics`.

### 2.12 Reusable UI components

`page()`, `el()`, `toast()`, `.card`, `.tag`, `.btn`, `.pill`, `label.f` fields, `.grid2`,
`.modal` + `.modal-actions`, `.popover`/`.pop-item`, `.bar`, `.empty` + `.starter`, the
startup screen, `fmtWhen()`, `fmtNum()`. All live in `app.js`/`app.css`; the CSS is
importable, the JS helpers are five lines each and are copied, not imported (app.js
exports nothing and boots on import).

### 2.13 Tests and CI

`npm test` runs `tests/unit/*.test.mjs` with `node --test` (hermetic, synthetic catalogue).
`tests/integration/*.test.mjs` hit the live internet and a real browser. `tests/e2e/`
runs the real agent and independently re-verifies its output. CI on GitHub Actions
(Windows + Ubuntu, Node 24) runs unit tests and `scan:secrets` on every push.

### 2.14 Technical debt and constraints that shape the MVP

| Constraint | Consequence for Decisions |
|---|---|
| `app.js` is one 3,000-line file with no exports | Do not add a product to it. Build a second HTML shell that imports `app.css` and copies the five helpers. Touch `app.js` only to add a link. |
| No `response_format` in `GatewayClient.chat` | Structured output must be enforced by prompt + local validation + retry, not by the API. See section 12 and the probe in 27. |
| Free models are slow and some are non-reasoning | One model call per situation, small packets, a hard cap per run, and a rule-only fallback so the product still works when the model does not. |
| Routes table is a literal object in `api.mjs` | Merge a second table in `server.mjs` rather than editing the 1,232-line file. |
| `zod` is present only as a transitive dependency | Declare it in `package.json` (already installed, no new download) or hand-write the validator. Recommendation: declare it. |
| Unit tests must stay hermetic | The LLM layer needs a recorded-response mode; the runner accepts an injected `complete` function. |
| No OS notifications | Reminders are in-app state ("You have not handled this yet"), not pushes. |
| Windows-only dialogs | Import uses the existing folder picker on Windows and a typed path elsewhere, same as `folderSet`. |
| `scan:secrets` runs on everything git tracks | Fixture data must use `example.com` addresses and no key-shaped strings. |

### 2.15 Where to build it

Three options were weighed:

1. **New pages inside the existing Chat/Code shell.** Cheapest, but the shell is built
   around a composer and a session list; a decision workspace would be a settings page
   in a chat app, and the brief says the product must not read as a chatbot.
2. **A second product surface in the same repository and the same process: its own HTML
   page under `src/ui/public/decisions/`, its own server module under `src/decisions/`,
   served by the same UI server with the same token.** Reuses everything server-side,
   keeps `app.js` untouched, gives the product its own information architecture.
3. **A separate application** importing omni-agent as a library. Duplicates the gateway
   lifecycle, the installer, the single-instance lock and setup for no MVP benefit.

**Decision: option 2.** The product opens from a nav item in Omni Agent ("Decisions") and
from `omni-agent decisions`. Nothing about Omni Agent's existing behaviour changes.

### 2.16 What is not reusable

`company-brain/` in the working directory is a different product (knowledge compilation
from Slack/tickets/docs) and shares nothing useful. The routines feature is a scheduling
pattern only. The `browser` tool is not needed by the MVP at all.

---

## 2A. Cobi, and Shiplog beside it: what they built, what they claim, and the gaps this clone takes

*Data collected 2026-09-09 with live scrapes of hellocobi.com, docs.hellocobi.com,
useshiplog.com, both companies' LinkedIn pages, and the press coverage of both funding
rounds. Every fact below carries its source. Facts are separated from interpretation:
"Fact" paragraphs quote or paraphrase a source; "Read" paragraphs are this plan's
analysis. Where nothing was found, that is stated rather than filled in.*

### 2A.1 Snapshot: Cobi (hellocobi.com)

| | Fact | Source |
|---|---|---|
| Company | HelloCobi, doing business as Cobi. DIFC, Dubai, UAE, in the Dubai AI Campus; in the Mastercard Engage, Presight and Nvidia Inception programmes; commercial activity in the UAE, Egypt, Bahrain and the wider GCC. 2 to 10 employees; 6 on LinkedIn; 785 followers. The founding date is stated three ways: launch 2023 (Dealroom), founded 2024 (trust centre, LinkedIn), founded 2025 (press coverage). Dealroom lists an enterprise value of $4 to 6m and an earlier Plug and Play round in Jan 2025 that no other source mentions. | [tbreak](https://tbreak.com/cobi-ai-customer-intelligence-1m-pre-seed/), [LinkedIn](https://www.linkedin.com/company/hellocobi), [trust centre](https://trust.hellocobi.com/), [Dealroom](https://app.dealroom.co/companies/hellocobi) |
| Founders | Darren Edmund, CEO: "a decade in data-driven digital transformation, including advising European financial institutions while at Deloitte and serving as Chief Business Officer at dropp." Botlhale Mosoane, CTO: "a decade of experience building and scaling technology across startups and global enterprises, including Amazon Web Services." | [press](https://www.hellocobi.com/press) |
| Funding | $1M pre-seed announced 11 Aug 2026, led by Lunara Partners (Dubai, MENA-focused), with Plug and Play (Saudi Arabia), Annex Investments (Abu Dhabi), Spring (Bahrain venture studio) and angels. Use of funds, in the release's words: "accelerate enterprise deployments across the Middle East and internationally; deepen Cobi's customer intelligence, recommendation and decisioning capabilities; and automate more workflows between raw customer signals and executed decisions." | [press](https://www.hellocobi.com/press), [LinkedIn post](https://www.linkedin.com/posts/hellocobi_we-just-raised-1m-in-pre-seed-funding-led-activity-7492815791982284800-t086), [Inc. Arabia](https://en.incarabia.com/uaebased-cobi-raises-us1-million-to-scale-its-customer-intelligence-platform-883073.html) |
| Target buyer, in their words | "Product marketing, growth and customer experience teams"; "organizations with multiple products, propositions and customer segments"; where intelligence intervenes is "further upstream in how teams make decisions, or downstream in shaping the customer experience itself." Geography: "the Middle East remains our immediate focus", then North and Sub-Saharan Africa (mobile-led), then the US. | [press](https://www.hellocobi.com/press), [Inc. Arabia](https://en.incarabia.com/uaebased-cobi-raises-us1-million-to-scale-its-customer-intelligence-platform-883073.html) |
| Security posture | Sprinto-hosted trust centre: "ISO 27001 v2022: In progress", "GDPR: Coming soon"; subprocessors GitHub, AWS, Google Workspace, Qdrant; policies behind "Request access"; no hosting region and no retention period stated. The homepage FAQ says data is "encrypted, never used to train external models". | [trust centre](https://trust.hellocobi.com/), [homepage](https://www.hellocobi.com/) |
| Tagline | "AI Decision Stack for Customer Intelligence. Stop Guessing What Your Customers Want. Cobi reads their actual behaviour, tells you what they care about right now, and shows you exactly what to do about it." LinkedIn slogan: "Make every decision the right decision." | [homepage](https://www.hellocobi.com/), [LinkedIn](https://www.linkedin.com/company/hellocobi) |
| Named customers and partners | Logo strip: NymCard, Mastercard, Presight, Epic Padel, eFinance, Unipal, Lari Exchange, Modupay. The release's own wording is exploratory: "has been working with enterprises such as Mastercard, Emirates Flight Catering, Presight AI (a G42 Company) and Lari Exchange, **to explore** how customer intelligence can help shape better customer experiences." The one contracted deployment is the five-year agreement with eNovate (eFinance subsidiary, Egypt) starting with the Rize youth digital wallet, enabled by Mastercard's Engage programme, initial deployment Q1 2026. Cobi went through the Presight AI Startup Accelerator and showed a "fintech demo at Mastercard EDGE and Mastercard Engage" at GITEX 2025. | [press](https://www.hellocobi.com/press), [homepage](https://www.hellocobi.com/), [TechAfrica News](https://techafricanews.com/2026/02/17/enovate-and-cobi-integrate-ai-intelligence-to-transform-egypts-digital-payment-experience/), [Presight post](https://www.linkedin.com/feed/update/urn:li:activity:7386685356320141312/) |
| Pricing | Starter $19/month (100 questions, 1 data source), Pro $49/month (300 questions, 2 sources, 5 Stories/month, weekly agentic analysis), Team $59/seat/month (400 questions per seat pooled, 5 shared sources, "Team suggestions run daily; data scans run weekly"), Business custom. 14-day trial, no card. | [pricing](https://www.hellocobi.com/pricing) |
| Reviews | No G2, Capterra or Product Hunt listing was found. | searches run 2026-09-09 |
| Hiring | The LinkedIn jobs lookup returned no listings (HTTP 400 from the structured endpoint); no careers page exists on the site. | attempted 2026-09-09 |

### 2A.2 How Cobi actually works, from its own documentation

The marketing site and the documentation describe two different products. Both are
quoted so the difference is visible.

**Fact, the press release's own model.** "Cobi's platform is built around a continuous
customer decision cycle: Understand. Cobi connects signals from across the customer
journey to create a clearer view of what is happening and who is affected. Decide.
Proactively identifies the opportunities, risks and behavioural changes that matter,
then recommends actions most likely to improve activation, engagement, retention or
customer value. Act and learn. Decisions can be delivered through the applications,
engagement platforms and operational systems a business already uses. The outcome is
then used to improve future recommendations." And: "Cobi explains why the changes
matter, recommends the next best action, product, offer or experience, and helps deliver
that decision via existing workflows." Source: [press](https://www.hellocobi.com/press).

**Fact, marketing site.** Three pillars: *Understand* ("Connect the tools holding your
customer, transaction and engagement data. Add business definitions so Cobi knows how to
interpret it"), *Decide* ("Cobi applies your context when analysing records. Explore the
answer and decide what to track or who to act on"), *Act* ("Build an audience for your
next move. **Coming next:** share useful context with your team and prepare customer
messages for your connected channels"). The hero shows customers labelled High value,
New user, Activated, At risk, Retained, Power user, Upsell ready, Dormant. The FAQ answer
to "Can Cobi take action?" is: "It helps you act by creating segments, suggesting
experiments, drafting recommendations, and triggering engagement flows". A 30-logo
integrations wall lists PostgreSQL, MySQL, MongoDB, Snowflake, BigQuery, Databricks,
HubSpot, Salesforce, Stripe, Shopify, Zendesk, Intercom, Mailchimp, Slack, Mixpanel and
more. Four metrics are shown with no method or source: "12x time to executed action
reduced", "68% user activation improvement through dynamic segmentation", "3.8x average
increase in revenue per engaged user segment", "89% growth decisions executed
autonomously end-to-end". Source: [homepage](https://www.hellocobi.com/), FAQ text read
from the page's embedded data.

**Fact, documentation.** "Cobi is an AI-powered data analytics platform that lets you
ask questions about your data in plain English, no SQL required. Connect your database
and the Data Assistant handles the rest." The documented surface is: a **Data Assistant**
(chat over a connected database), an **Embed Widget** (iframe, with "Data Scopes" for
row-level multi-tenant isolation), **Slack** (ask questions, create charts, `/cobi`),
a **Data API** ("Upload customers, transactions, and offers programmatically") and a
**Recommendations API** ("Surface personalised offers and segments for your users").
Documented connectors are PostgreSQL, MySQL and MongoDB only. Context is supplied through
**Custom Instructions** (free-text terminology, joins, status codes, metric definitions
such as "Active users = users who have logged in within the last 30 days") plus
**Learned Information** the assistant accumulates from queries. Source:
[introduction](https://docs.hellocobi.com/introduction),
[custom instructions](https://docs.hellocobi.com/platform/custom-instructions.md),
[data scopes](https://docs.hellocobi.com/platform/channels/data-scopes.md),
[llms.txt index](https://docs.hellocobi.com/llms.txt).

**Fact, the data model.** The Data API's record types are Customers, Transactions,
Offers, Shops, Branches, Categories, Tags, Keywords, Student Favourites, Institutes,
Courses and Interactions (with items TAG, OFFER, SHOP, KEYWORD). The Customer model's
required fields are `customer_id`, `user_id`, `region`; optional fields are `birthdate`,
`institute_id`, `course_id`, `gender`. The Recommendations API returns, per customer or
segment, an array of offer UUIDs, rate-limited at 1,000 requests a minute. Source:
[data API overview](https://docs.hellocobi.com/api-reference/data/overview.md),
[customer model](https://docs.hellocobi.com/api-reference/data/models/customer.md),
[recommendations overview](https://docs.hellocobi.com/api-reference/recommendations/overview.md).

**Fact, deployment.** An on-premises Helm chart (`cobi-dashboard`) for Kubernetes or
OpenShift deploys a Vite/React frontend, a Node.js backend, a "connect" ingestion
service, PostgreSQL, Qdrant (vector search), MinIO (documents) and a **self-hosted vLLM
inference stack** with model weights hosted in the customer's own Git or MinIO "instead of
pulling from Hugging Face Hub", plus Grafana observability. Source:
[deployment overview](https://docs.hellocobi.com/deployment/overview.md),
[llms.txt](https://docs.hellocobi.com/llms.txt).

**Fact, the live deployment.** With eNovate, "Cobi's intelligence layer will power
real-time personalisation for Egypt's youth segment" in the Rize wallet; "Cobi's
behavioural AI engine ... builds deep context on how users engage, identifies patterns,
and recommends or triggers next-best-actions across acquisition, activation, and
retention journeys"; "Looking ahead, the partnership will extend toward agentic payment
experiences". Initial deployment Q1 2026. Source:
[TechAfrica News](https://techafricanews.com/2026/02/17/enovate-and-cobi-integrate-ai-intelligence-to-transform-egypts-digital-payment-experience/).

**Read.** Cobi's shipped product is (a) a text-to-SQL data assistant with saved metrics,
charts, dashboards and scheduled "Stories", sold per question per month, and (b) a
consumer offer-recommendation engine with a fintech and student-discount data model,
deployed on-premises for banks and payment companies in the Gulf and Egypt. The
"decision stack" and the "Understand, Decide, Act and learn" cycle describe a direction:
the press release hedges every delivery verb ("helps deliver", "can be delivered"), the
homepage's *Act* pillar says "Coming next", and the stated use of the new money is to
"automate more workflows between raw customer signals and executed decisions", which
says those workflows are partly manual today. Nothing in the documentation or the
pricing table describes a persistent decision object, an owner, a due date, a reminder,
a status, an audit trail or an outcome; the docs do not contain the words decision,
alert, notification, evidence or next best action at all. The words "alert" and
"notification" do not appear anywhere in the homepage's source either. The unit of
pricing, questions per month, is the unit of a chat product. Every enterprise name
except eNovate is attached to "explore" wording. Cobi's real customers are B2C fintech
portfolios (a wallet, a card issuer, a student-discount app), not B2B SaaS account
teams, so the brief's example (ARR, renewal in 40 days, seat utilisation, an inactive
champion) is closer to Shiplog's product than to Cobi's. Security is a trust page with
both certifications pending, which for a bank buyer is the reason the on-premises Helm
chart exists.

### 2A.3 Snapshot: Shiplog (useshiplog.com), the closer mechanism

| | Fact | Source |
|---|---|---|
| Company | Paris, Station F. Founded March 2026 by Khushi Mehta (CEO, "six years in go-to-market") and Mehdi Gribaa (CTO). 3 people on LinkedIn, 377 followers. | [pre-seed post](https://useshiplog.com/blog/pre-seed-round), [LinkedIn](https://www.linkedin.com/company/useshiplog) |
| Funding | "nearly $1 million" pre-seed (Aug 2026) from Kima Ventures, Project Europe, Purple, No Label Ventures, 100IN, Station F Fund. "We're hiring exceptional engineers globally." | [pre-seed post](https://useshiplog.com/blog/pre-seed-round) |
| Product | "Ada", an agent that "builds a live profile of every customer, reasons over that profile to work out what matters right now, and recommends or takes the next best action inside the tools your teams already use." Integrations claimed: Salesforce, HubSpot, Snowflake, Shopify, Stripe; "integrations with Amplitude and PostHog are now complete and tested. Mixpanel soon?" | [Ada deep dive](https://useshiplog.com/blog/ada), [LinkedIn post 13 Aug 2026](https://www.linkedin.com/posts/useshiplog_introducing-shiplogs-product-release-series-activity-7493690735746064384-D_Ns) |
| Go-to-market | "Run Shiplog on a subset of your accounts and measure the impact on retention and expansion" (pilot sign-up); "Comment CS below and we'll give you 1 month free". No public pricing. First use case: product-led growth SaaS. | [Ada deep dive](https://useshiplog.com/blog/ada), [LinkedIn post 20 Aug 2026](https://www.linkedin.com/posts/useshiplog_customersuccess-ai-saas-activity-7496227173918400512-_AJ7) |
| Roadmap named | "Customer 360, Ada's memory, outcome first insights". | same LinkedIn post |
| Published thinking | Six blog posts: the pre-seed note, "Net Revenue Retention", "Churn: catching risk from behaviour before the renewal", "Expansion: reading the signals that mean an account is ready to buy more", "Personalisation at scale", and the Ada deep dive. "New writing is on the way." | [blog](https://useshiplog.com/blog) |

**Fact, the mechanism, in Shiplog's words.** "It weighs behavioural signals together
rather than in isolation, because a single dropping metric is noise while several moving
in concert is a real signal." "Risk that needs 60 days of lead time is surfaced early
enough to act on." "Ada can distinguish an activation failure in the first 90 days from a
value question at the year two mark." "Every conclusion Ada reaches carries the evidence
behind it. A recommendation is never a black box score." "Each recommendation is
concrete, owned and timed, not a vague flag." "It will not enrol the same customer in
conflicting campaigns." "Every recommendation can be reviewed and approved by a person,
or automated once a team is confident in a given play." "It ... reads the outcome of that
action back into the profile, which sharpens the next decision." The launch demo: "a
customer who is highly engaged, hitting their seat limit, researching pricing, and
actively hiring after a recent funding round ... Ada identifies the expansion
opportunity, explains why it matters, drafts the outreach, and recommends the next best
action." Source: [Ada deep dive](https://useshiplog.com/blog/ada), [LinkedIn post 20 Aug
2026](https://www.linkedin.com/posts/useshiplog_customersuccess-ai-saas-activity-7496227173918400512-_AJ7).

**Read.** Shiplog describes the loop this plan builds, almost clause for clause:
multi-signal detection with a single-signal noise rule, timing awareness, evidence on
every recommendation, an owned and timed action, a conflict guard, human-in-the-loop by
default, and outcomes fed back. What Shiplog has not shown publicly is any of it running:
the homepage is a JavaScript shell that scrapes as "Unpacking...", the product is
pilot-only, and the "memory" and "outcome first insights" pieces are listed as coming.
Its distinctive extra is external signals in the demo (hiring, a funding round), which
this plan keeps out of the MVP on purpose (section 18).

### 2A.4 The wider field, from search only (not scraped in depth)

Gainsight's Staircase AI "analyzes every customer conversation to surface churn risk,
expansion momentum, and stakeholder disengagement"; ChurnZero, Vitally, Planhat, Totango,
Custify and Catalyst are the customer-success suites with health scores and playbooks;
Successifier claims "85%+ accuracy 30-90 days in advance". Source: search results
2026-09-09 ([Staircase](https://www.gainsight.com/staircase-ai/),
[Vitally](https://www.vitally.io/post/csm-guide-ai-for-churn-management),
[retain.so comparison](https://retain.so/blog/vitally-alternatives-2026)). **Read:** the
incumbents sell a CRM-shaped workspace with a health score; the two startups sell an
agent; nobody in this set sells a local, model-agnostic decision queue that runs on a
laptop from a folder of CSVs.

### 2A.5 Gap table: what the clone takes, where the gaps are, and what it changes in this plan

| Cobi / Shiplog element | Status there | This plan | Change made to the plan |
|---|---|---|---|
| A persistent decision with owner, due date, status, history, outcome | Cobi: in the press release's cycle ("Act and learn ... the outcome is then used"), absent from docs and pricing; "Act" is "coming next". Shiplog: described, not shown. | Core of the MVP (sections 13, 14) | none; this is the whole bet |
| Reminders, "you have not handled this yet" | Neither mentions reminders; "alert"/"notification" absent from Cobi's site | Section 14 | none |
| Evidence on every recommendation, labelled by kind | Shiplog: "never a black box score". Cobi: "controlled AI outputs ... guardrails" (no detail) | Section 12.6, kind chips in 16.4 | none |
| Single metric is noise; several in concert is a signal | Shiplog states it; Cobi does not | Section 13.1 single-signal watch rule | none; cite as convergent |
| Lifecycle labels on customers (At risk, Upsell ready, Dormant, Power user, New user ...) | Cobi's hero and segments | Not in the first draft | **Added**: a deterministic `status_label` per account, computed from the same signals (section 11.5), shown as a chip on Customers |
| Business definitions / Custom Instructions as context | Cobi's main context mechanism; Learned Information on top | Thresholds in `rules.json` only | **Added**: a workspace "Business context" note (max 1,000 chars) passed into the packet as `business_context`; grounding rules unchanged (section 12.2, 16.7) |
| Timing and tenure: activation failure vs year-two value question | Shiplog | Packet had renewal timing only | **Added**: `tenure_days` in the packet from `account.created_at`; the prompt names the two cases (section 12.2, 12.3) |
| Conflict guard: no conflicting outreach to one customer | Shiplog | One open decision per fingerprint only | **Added**: at most one prepared outreach action per account in 14 days; a second is refused with the existing one named (section 14.4) |
| Outcomes read back to sharpen the next decision | Shiplog (planned) | Outcomes stored | **Added**: `prior_decisions` in the packet carries the outcome result and note (section 12.2) |
| Human-in-the-loop or automated per play | Shiplog offers both | Human only | BUILD LATER: per-action automation toggle (section 29) |
| External signals (hiring, funding, news) | Shiplog's demo; Cobi none | Excluded | unchanged (section 18) |
| Chat with your data, Slack bot, embed widget, Stories/dashboards | Cobi's shipped core | Excluded | DO NOT BUILD (section 29); a weekly digest file is BUILD LATER |
| Offer recommendations for consumers | Cobi's Recommendations API | Out of domain | DO NOT BUILD |
| Live connectors (30 logos on Cobi; 3 documented) | Cobi 3 documented; Shiplog 2 tested | CSV folder | unchanged; the "documented vs claimed" gap is a reason to ship one working import rather than a logo wall |
| On-premises, self-hosted model | Cobi's Helm chart with vLLM, a real differentiator for banks | Local-first by construction; any model through the gateway | **Added** to positioning (section 3): data stays on the machine, the model is the user's choice, no cluster required |
| Unevidenced metrics (12x, 68%, 3.8x, 89%) | Cobi's homepage | Evaluation harness with a committed report | unchanged; publish measured numbers with method, never headline multipliers |
| Pricing unit | Cobi: questions per month; Shiplog: pilots | n/a for the MVP | note for later: charge for accounts monitored, never for questions asked |
| Multi-tenant data scopes, row-level isolation | Cobi (for its embed widget) | Single user, one file per workspace | unchanged; irrelevant until multi-user |

### 2A.6 Strategic recommendations (the "so what")

1. **Position against the gap, not against the pitch.** Both competitors say "decision".
   Neither documents the decision as an object with a life. Make the decision object, its
   reminders and its outcomes the demo, and say in the docs that the model only writes
   the words.
2. **Prove what they assert.** Publish the evaluation report (section 21) with recall,
   false-positive count, evidence hit rate and cost per run. Cobi's four multipliers have
   no method; Shiplog's have not been published. A measured 0.85 beats an unmeasured 12x
   with a serious buyer.
3. **Make "runs on your laptop, on any model" the privacy story.** Cobi's answer to data
   residency is a Kubernetes cluster with a self-hosted vLLM, behind a trust page whose
   ISO 27001 is "in progress" and GDPR "coming soon"; Shiplog's is unstated. A local
   SQLite file, a pseudonymised packet and a model the user chooses is the same promise
   at zero infrastructure, and it needs no certificate to be true.
4. **Stay B2B SaaS for the MVP.** Cobi's traction is B2C fintech in the Gulf and Egypt
   with an offers data model. The brief's scenario is B2B accounts. Do not chase both.
5. **Ship one working import, not thirty logos.** Cobi documents three of the thirty
   connectors on its homepage. A CSV contract that a real Stripe or HubSpot export
   satisfies is more credible than a wall, and it is what section 28 validates first.
6. **Borrow the four cheap ideas and nothing else:** lifecycle labels, a business-context
   note, tenure in the packet, and the outreach conflict guard. Each is under a day and
   each closes a visible gap between this plan and the two competitors' stories. Chat,
   Slack, widgets and offer recommendations stay out.
7. **Re-check both companies before release.** Cobi's "Act" pillar and Shiplog's
   "memory" and "outcome first insights" are announced; if either ships a documented
   decision loop before this MVP is validated, section 2A.5 is the list to re-score.

---

## 3. What the new product is

**Decisions** is a local desktop workspace that watches a company's customer data and
turns meaningful changes into decisions a person can act on.

Data -> Signal -> Situation -> Decision -> Action -> Outcome

It is:

- a **decision queue**, not a dashboard: the unit on screen is "Acme needs attention,
  here is why, here is what to do", not a chart;
- **deterministic first**: every number on screen was computed by code from the imported
  rows and can be traced to them;
- **reasoned second**: one model call per situation writes the interpretation, the
  hypotheses and the recommendation, and may only cite evidence the code gave it;
- **persistent**: a decision stays until someone resolves or dismisses it, reminds the
  owner when it is overdue, and records what happened afterwards;
- **human-in-the-loop**: the two actions (draft an email, create a task with an owner and
  a due date) are prepared by the system and done by the person.

The model is a component. The product is the loop around it.

**Positioning, after the competitor read in section 2A.** Cobi sells a chat over your
database with a "decision stack" story whose *Act* step is "coming next"; Shiplog
describes the right loop and is running private pilots. This product is the loop itself,
shipped small: the decision is a record with a life, every claim on screen is labelled as
fact, interpretation, hypothesis or recommendation, and the whole thing runs on the
user's own machine from a folder of CSVs, with whichever model they choose through the
gateway. No cluster, no per-question quota, no data leaving the laptop except a
pseudonymised fact sheet.

---

## 4. Core user problem

A customer-success or revenue lead at a B2B SaaS company with 50 to 2,000 accounts has
the data already: Stripe knows the failed payment, the product database knows usage is
down, the help desk knows tickets are up, the CRM knows the renewal date. Nobody reads all
four for every account every week. Churn is noticed at the renewal call; expansion is
noticed when the customer asks. The interpretation step is done by humans, late, and only
for the accounts someone happened to look at.

The product does the interpretation step for every account, every run, and hands over
only the ones that need a decision.

---

## 5. MVP hypothesis

> Software can reliably identify an important business situation from existing customer
> data and turn it into a decision that a human understands, trusts, and acts on, at a
> model cost low enough to run daily.

Broken into the five questions the MVP must answer (metrics in section 22):

1. Detection: does it find the planted situations and not the healthy accounts?
2. Understanding: can a person say, in their own words, why a decision was raised?
3. Usefulness: would they act on the recommendation?
4. Cost: how many model calls and tokens per run over N accounts?
5. Loop: does the status/reminder/outcome workflow make sense to someone using it?

---

## 6. Target user

Primary: a head of customer success, revenue operations or a founder-CEO at a B2B SaaS
company, non-technical, who already exports CSVs from Stripe/HubSpot/the product database
when asked. They open the app in the morning, want three things to look at, and want to
know what happened to last week's three.

Secondary (for the MVP demo): the person evaluating the concept, who needs to understand
the value in under five minutes without a narrator.

Not the user: a data analyst who wants to write queries; an engineer who wants an API.

---

## 7. Core user journey

```
First launch
  -> Onboarding (3 steps): name the workspace -> choose data (Load the demo company | Import a folder) -> Run first analysis
  -> Today: "5 decisions need your attention"
  -> Open one: why it matters, what changed, evidence, hypotheses, recommended action, impact
  -> Handle: Accept (owner + due date set) | Snooze (until date) | Dismiss (reason)
  -> Decision is In progress; a Draft email action is prepared; the person edits and sends it from their own mail app; marks the action done
  -> Time passes (or the demo clock is advanced): the due date passes -> "Still not handled, 3 days overdue" on Today
  -> Waiting: the person marks it Waiting on the customer
  -> Resolve: pick an outcome (Renewed | Churned | Expanded | Payment recovered | No change) and a note
  -> Activity shows the whole story; the customer page shows the decision under History
```

Points where the user could be confused, and the design answer for each:

| Moment | Confusion | Answer |
|---|---|---|
| Onboarding, data step | "What data? What format?" | A "Load the demo company" button that needs nothing, and a one-screen description of the five CSV files with a "download a template" link. |
| First analysis | "Is it doing anything?" | A progress card: accounts read, signals computed, N situations found, reasoning 3 of 5, with the model name. Analysis can take a minute on free models. |
| Today | "Why these five?" | The card says severity, impact and the two strongest signals; the detail says the rest. "Sorted by severity, then by money at stake" is written on the page. |
| Detail | "Is this a fact or a guess?" | Every block carries a kind chip: Observed fact, AI interpretation, Hypothesis, Recommendation. Numbers link to the signal that produced them. |
| Handle | "What does Accept do?" | The button says "Accept and assign". Nothing is sent anywhere. The dialog says so. |
| Draft email | "Did it send it?" | It never sends. The button is "Open in my mail app", and the action stays Prepared until the person marks it done. |
| Snooze | "Will it come back?" | The dialog states the date it returns. Snoozed decisions remain visible under a Snoozed filter. |
| Dismiss | "Will it nag me again?" | Dismissed decisions are not re-raised for the same situation unless it gets worse; the dialog says so. |
| Nothing found | "Is it broken?" | The empty state says how many accounts were checked, how many single signals are being watched, and when the next check is. |
| Model failure | "Where is the explanation?" | The card exists from the rules alone and says "AI explanation unavailable: <reason>. Try again." |

---

## 8. MVP feature list

1. Workspace: create one, name it, delete it and its data.
2. Data import: a folder of CSVs (five tables, one optional), with an import report.
3. Demo company: one click loads a synthetic company with planted scenarios.
4. Analysis run: deterministic signals, situations, prioritisation, LLM reasoning for the
   top candidates, decision upsert, run log, progress and cost shown.
5. Decisions: list with filters; detail with the nine sections from the brief; status
   transitions; owner; due date; snooze; dismiss with reason; resolve with outcome.
6. Follow-up: overdue reminders, snooze expiry, waiting nudges, "you have not handled
   this yet", all persistent and visible on Today.
7. Actions: Draft email (model-written, template fallback, opened in the user's mail
   app), Create task (owner + due date + note). Both human-approved.
8. Customers: list and per-customer page with facts, signals, watch items, decision
   history, and a deterministic lifecycle label (Healthy, At risk, Expansion ready,
   Payment issue, Dormant, New, Watching) computed from the same signals.
9. Activity: chronological log of everything the system and the person did.
10. Settings: workspace name, owners list, a "Business context" note the model is shown,
    thresholds (read, and a few editable), per-run LLM cap, pseudonymise-names switch,
    demo clock, re-import, delete data.
11. CLI: `omni-agent decisions open|run|seed|eval`.
12. Evaluation harness with a labelled benchmark and a committed report.
13. User manual and getting-started guide.

---

## 9. Explicit non-goals

- No live integrations (Stripe, HubSpot, Salesforce, PostHog, Amplitude, Intercom,
  email, Slack). CSV import is the connector.
- No external-world context (news, competitors, regulation, economy). See section 18.
- No autonomous actions. Nothing leaves the machine.
- No chat interface. Not even a secondary one in the MVP.
- No charts beyond a tiny inline bar for a single number.
- No multi-user, no accounts, no roles, no sharing.
- No scheduled runs while the app is closed.
- No model training, fine-tuning or embeddings.
- No general anomaly detection or forecasting; signals are windows and thresholds.
- No CDP, no data warehouse, no replacement for any existing system.

---

## 10. Data architecture

### 10.1 Storage

One SQLite file per workspace, via `node:sqlite`:

```
%LOCALAPPDATA%\OmniAgent\decisions\
  workspaces.json                       [{id, name, createdAt, lastRunAt}]
  <workspaceId>\
    decisions.sqlite                    everything below
    imports\<yyyymmdd-hhmmss>\*.csv     byte copies of what was imported, plus report.json
```

`PATHS.decisions` is added to `src/util/paths.mjs` and to `ensureDirs()`.

Why SQLite and not the JSON-file convention the rest of the app uses: decisions, events
and signals are relational, they are queried with filters, and the history table is
append-only and grows. `node:sqlite` needs no dependency and is already in use.

### 10.2 Import format (the connector contract)

A folder containing these CSV files. Column names are exact; order is free; dates are ISO
(`2026-09-01` or `2026-09-01T10:00:00Z`); booleans are `true`/`false`.

| File | Required | Columns |
|---|---|---|
| `accounts.csv` | yes | `account_id, name, arr, plan, seats_purchased, renewal_date, owner, segment, industry, created_at` (segment/industry optional) |
| `usage_daily.csv` | yes | `account_id, day, active_users, sessions, seats_used` |
| `contacts.csv` | no | `contact_id, account_id, name, role, is_champion, last_active_at` |
| `tickets.csv` | no | `ticket_id, account_id, opened_at, closed_at, priority, subject` (priority: low/normal/high/urgent; closed_at empty = open) |
| `invoices.csv` | no | `invoice_id, account_id, due_at, amount, status, attempts, paid_at` (status: paid/open/failed) |
| `events.csv` | no | `event_id, account_id, at, kind, detail` (kind: pricing_page_view, seat_limit_hit, champion_left, exec_meeting) |
| `workspace.json` | no | `{ "name", "currency", "as_of", "seat_price_monthly" }` |

Import rules: unknown columns ignored; missing required column rejects the file with the
column named; a child row whose `account_id` is not in `accounts.csv` is rejected and
counted; duplicate ids keep the last row and count a warning; unparseable dates or numbers
reject the row. The import report (rows read/accepted/rejected per file, reasons with
counts, first three offending rows) is stored in `imports\...\report.json` and shown in
the UI. A re-import replaces the raw tables inside one transaction; decisions and history
are untouched.

Why this shape: every one of these tables is a straight export from the systems the brief
lists (Stripe invoices, HubSpot contacts and deals, a product events table, a help desk),
so a real customer can produce them without an integration, and the same importer is what
a connector would write into later.

### 10.3 Schema

```sql
-- metadata
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);          -- schema_version, workspace_name, currency, as_of, seat_price_monthly, settings_json

-- raw, normalised
CREATE TABLE account (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, arr REAL NOT NULL DEFAULT 0, plan TEXT,
  seats_purchased INTEGER, renewal_date TEXT, owner TEXT, segment TEXT, industry TEXT,
  created_at TEXT);
CREATE TABLE contact (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT, role TEXT, is_champion INTEGER NOT NULL DEFAULT 0, last_active_at TEXT);
CREATE TABLE metric_daily (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (account_id, day, metric));                       -- metrics: active_users, sessions, seats_used
CREATE TABLE ticket (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL, closed_at TEXT, priority TEXT, subject TEXT);
CREATE TABLE invoice (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL, amount REAL, status TEXT NOT NULL, attempts INTEGER DEFAULT 0, paid_at TEXT);
CREATE TABLE event (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);

-- computed per run
CREATE TABLE run (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, as_of TEXT NOT NULL,
  status TEXT NOT NULL,                                         -- running|done|failed
  accounts INTEGER, signals INTEGER, candidates INTEGER, reasoned INTEGER, cached INTEGER,
  decisions_created INTEGER, decisions_updated INTEGER, dropped_not_actionable INTEGER,
  llm_calls INTEGER, llm_failures INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  model TEXT, error TEXT, progress_json TEXT);
CREATE TABLE signal (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, kind TEXT NOT NULL, band INTEGER NOT NULL,   -- 0..3
  direction TEXT,                                               -- up|down|null
  value REAL, baseline REAL, change_pct REAL, window_days INTEGER,
  statement TEXT NOT NULL,                                      -- the evidence sentence, written by code
  detail_json TEXT);
CREATE INDEX signal_run_account ON signal(run_id, account_id);
CREATE TABLE situation (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  account_id TEXT,                                              -- null for cohort_shift
  kind TEXT NOT NULL,                                           -- churn_risk|expansion|payment_risk|cohort_shift|watch
  score REAL NOT NULL, priority REAL NOT NULL, signal_ids_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL, packet_hash TEXT,
  outcome TEXT NOT NULL,                                        -- watch|reasoned|cached|rule_only|not_actionable|skipped_cap|failed
  decision_id TEXT);

-- the product
CREATE TABLE decision (
  id TEXT PRIMARY KEY, account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,                                    -- account_id + ':' + kind, or 'cohort:' + kind
  kind TEXT NOT NULL, title TEXT NOT NULL,
  severity TEXT NOT NULL,                                       -- critical|high|medium|low   (rule-derived)
  confidence TEXT,                                              -- high|medium|low           (model-stated, null when rule_only)
  status TEXT NOT NULL,                                         -- new|accepted|in_progress|waiting|snoozed|resolved|dismissed
  status_before_snooze TEXT, snoozed_until TEXT,
  owner TEXT, due_at TEXT,
  impact_amount REAL, impact_basis TEXT, currency TEXT,
  why_it_matters TEXT, recommended_action_id TEXT, recommended_action_text TEXT, rationale TEXT,
  reasoning_source TEXT NOT NULL,                               -- model|rule_only
  model TEXT, prompt_version INTEGER, packet_hash TEXT,
  first_run_id TEXT, last_run_id TEXT, last_situation_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, dismissed_reason TEXT,
  reasoning_error TEXT);
CREATE INDEX decision_status ON decision(status);
CREATE UNIQUE INDEX decision_open_fp ON decision(fingerprint) WHERE status NOT IN ('resolved','dismissed');
CREATE TABLE decision_evidence (
  decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  signal_id TEXT NOT NULL, rank INTEGER NOT NULL, statement TEXT NOT NULL, kind TEXT NOT NULL,   -- observed
  PRIMARY KEY (decision_id, signal_id));
CREATE TABLE decision_hypothesis (
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL, text TEXT NOT NULL, confidence TEXT NOT NULL, evidence_ids_json TEXT NOT NULL);
CREATE TABLE decision_event (                                   -- append-only history / audit
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  at TEXT NOT NULL, actor TEXT NOT NULL,                        -- system|user
  kind TEXT NOT NULL,                                           -- created|updated|escalated|status|owner|due|snoozed|unsnoozed|dismissed|resolved|note|action_prepared|action_done|action_cancelled|reminder|outcome
  data_json TEXT);
CREATE INDEX decision_event_decision ON decision_event(decision_id, at);
CREATE TABLE action (
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                           -- draft_email|task
  status TEXT NOT NULL,                                         -- prepared|done|cancelled
  payload_json TEXT NOT NULL,                                   -- {to, subject, body, source: model|template} or {title, owner, due_at, note}
  created_at TEXT NOT NULL, done_at TEXT);
CREATE TABLE outcome (
  decision_id TEXT PRIMARY KEY REFERENCES decision(id) ON DELETE CASCADE,
  result TEXT NOT NULL,                                         -- renewed|churned|expanded|payment_recovered|no_change|unknown
  note TEXT, recorded_at TEXT NOT NULL, arr_after REAL);
CREATE TABLE llm_call (
  id TEXT PRIMARY KEY, run_id TEXT, situation_id TEXT, decision_id TEXT, purpose TEXT NOT NULL,   -- brief|draft_email
  model_requested TEXT, model_served TEXT, prompt_version INTEGER, packet_hash TEXT,
  input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER,
  attempt INTEGER NOT NULL, valid INTEGER NOT NULL, error TEXT, at TEXT NOT NULL);
CREATE TABLE watch (                                            -- single signals, shown on the customer page, never reasoned
  run_id TEXT NOT NULL, account_id TEXT NOT NULL, signal_id TEXT NOT NULL, PRIMARY KEY (run_id, signal_id));
CREATE TABLE account_run_state (                                -- the lifecycle label and tenure, per account per run (section 11.5)
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  label TEXT NOT NULL, tenure_days INTEGER, PRIMARY KEY (run_id, account_id));
```

`meta.settings_json` also holds `business_context` (string, max 1,000 characters) and
`outreachCooldownDays` overrides; neither needs a column.

Ids: `acc_`, `dec_`, `sit_`, `sig_`, `run_`, `act_`, `evt_` + 12 hex chars from
`crypto.randomBytes`, matching the `rtn_` convention in `routines.mjs`.

Migrations: `meta.schema_version`; `db.mjs` holds an array of migration SQL strings and
applies the ones above the stored version inside a transaction. Version 1 is the whole
schema above.

### 10.4 Company, Customer, Signal, Situation, Decision, Evidence, Recommendation, Owner, Status, Action, Outcome

| Brief concept | Where it lives |
|---|---|
| Company | the workspace (`meta` + folder) |
| Customer / Account | `account`, `contact`, raw tables |
| Signal | `signal` (per run) |
| Situation | `situation` (per run), `watch` for single signals |
| Decision | `decision` |
| Evidence | `decision_evidence` -> `signal.statement` |
| Recommendation | `decision.recommended_action_*`, `rationale` |
| Owner | `decision.owner` (from the workspace owners list in `meta.settings_json`) |
| Status | `decision.status` and the transition table in 13.3 |
| Actions | `action` |
| Outcomes | `outcome` |
| History | `decision_event` |

---

## 11. Signal architecture

### 11.1 Principle

**Code computes every number. The model reads sentences.** A signal is a pure function of
the raw tables, a window and an `as_of` date. Its output is a band (0 to 3), the numbers
that produced it, and one evidence sentence written from a template. The model never sees
a row, never sees a table, and never computes a percentage.

### 11.2 Signal catalogue (`config/decisions/rules.json`)

Thresholds are data, not code, so they can be shown in Settings and tuned without a
release. Default values:

| id | source | computation (relative to `as_of`) | band 1 | band 2 | band 3 | evidence template |
|---|---|---|---|---|---|---|
| `usage_drop_30d` | metric_daily.active_users | mean of last 30 days vs mean of the 30 days before; needs >= 20 days in each window | <= -25% | <= -40% | <= -60% | "Average daily active users fell {abs_change_pct}% over the last 30 days ({current} vs {baseline})." |
| `usage_rise_30d` | same | same, upward | >= +30% | >= +60% | >= +100% | "Average daily active users rose {change_pct}% over the last 30 days ({current} vs {baseline})." |
| `usage_drop_7d` | same | mean of last 7 days vs mean of the 28 days before | <= -40% | <= -60% | never | "Active users this week are {abs_change_pct}% below the previous four weeks ({current} vs {baseline})." |
| `renewal_near` | account.renewal_date | days until renewal | <= 90 | <= 45 | <= 21 | "Renewal is in {days} days ({date})." |
| `tickets_up_30d` | ticket | count opened in last 30 days vs the 30 before; +1 band if any open ticket is urgent | >= +50% and >= 3 | >= +100% and >= 5 | urgent open and band 2 | "Support tickets rose from {baseline} to {current} in the last 30 days{urgent_clause}." |
| `seat_util_low` | metric_daily.seats_used, account.seats_purchased | 7-day mean seats_used / seats_purchased | <= 50% | <= 30% | never | "{used} of {purchased} seats were used in the last 7 days ({pct}%)." |
| `seat_util_high` | same | same | >= 90% | >= 100% or a seat_limit_hit event in 14 days | never | "{used} of {purchased} seats are in use ({pct}%)." |
| `payment_failed` | invoice | failed invoices due in last 30 days; attempts; amount / ARR | 1 attempt | >= 2 attempts | >= 3 attempts or amount >= 10% of ARR | "A payment of {amount} due {date} has failed {attempts} time(s)." |
| `champion_inactive` | contact (is_champion) | days since last_active_at | >= 14 | >= 30 | champion_left event | "The champion ({role}) has not been active for {days} days." |
| `pricing_interest` | event.pricing_page_view | count in last 14 days | >= 1 | >= 3 | never | "The pricing page was viewed {n} time(s) in the last 14 days." |
| `data_stale` | metric_daily | days since the last usage day | > 7 | > 21 | never | "Usage data ends on {last_day}, {days} days before today." |

`data_stale` is a data-quality signal: when it is band >= 1, usage-based signals for that
account are computed but flagged `unreliable`, the situation rules ignore them, and the
customer page shows the warning. This is the "stale data" failure case from the brief,
handled at the source.

Rules for windows with missing days: a day with no row counts as missing, not zero. A
window with fewer than the minimum days yields band 0 and a `detail_json.reason =
"insufficient_data"`. Division by a zero baseline yields band 0 with reason
`"no_baseline"`. All of this is unit-tested (section 20).

### 11.3 Cohort detection

After per-account signals: for `usage_drop_30d` and `usage_rise_30d`, compute the share of
accounts with band >= 1 in the same direction. If the share is >= 40% and at least 5
accounts, emit **one** `cohort_shift` situation for the run (kind, direction, share,
median change, account count) and attach `cohort: {kind, share, direction}` to the packet
of every affected account's situation. The per-account decisions then say "this is part
of a company-wide change" rather than blaming the account, and the cohort decision says
"something changed for 62% of accounts at once; this is not explained by the internal
data". That last sentence is where external context would plug in later (section 18).

### 11.4 What is deterministic, what is cached, what is batched

| Step | Runs where | Cached? |
|---|---|---|
| Import and normalisation | code | raw tables replaced per import |
| Signals for every account | code, every run, milliseconds for thousands of accounts | stored per run; not cached across runs (cheap) |
| Situations, cohort, priority | code | stored per run |
| Packet building and hashing | code | `packet_hash` compared with the open decision's `packet_hash`: unchanged -> no model call (`outcome = cached`) |
| Model reasoning | one call per candidate, top N by priority, N <= `maxReasonedPerRun` (default 10) | by packet hash; a decision is re-reasoned when any signal band changes or 7 days pass |
| Decision upsert, history, follow-up | code | n/a |
| Draft email | one call, on demand, when the person clicks | stored as an action |

Nothing is batched across situations in one prompt. Batching would couple failures, make
grounding checks per-situation harder, and save little at N <= 10.

### 11.5 Lifecycle label (deterministic, one per account per run)

Borrowed from Cobi's customer labels (section 2A), computed by code from the signals
already produced, and never by the model. First matching rule wins:

| Label | Rule |
|---|---|
| `payment_issue` | `payment_failed` band >= 1 |
| `at_risk` | a `churn_risk` situation exists this run |
| `expansion_ready` | an `expansion` situation exists this run |
| `dormant` | `usage_drop_30d` band >= 2 and 7-day mean active users below 1 |
| `new` | `tenure_days` < 90 |
| `watching` | at least one signal with band >= 1 and no situation |
| `healthy` | none of the above |

Stored per run in `account_run_state(run_id, account_id, label, tenure_days)` (schema in
10.3), shown as a chip on the Customers list and detail, and filterable. It is a summary
of the signals, so the customer page still shows the signals themselves underneath it.

---

## 12. LLM architecture

### 12.1 Role

The model is a **customer-success analyst who writes a decision brief from a fact sheet.**
It interprets, it hypothesises, it recommends from a fixed menu, and it may veto ("this is
not actionable"). It does not compute, prioritise, or invent facts.

### 12.2 Model input: the situation packet

Built by `src/decisions/packet.mjs`, deterministic, hashed with SHA-256 (the hash is the
cache key). Example (churn risk, ~700 tokens):

```json
{
  "packet_version": 1,
  "as_of": "2026-09-09",
  "account": {
    "ref": "A-17",
    "arr": 50000, "currency": "USD", "plan": "Team", "seats_purchased": 40,
    "renewal_date": "2026-10-19", "days_to_renewal": 40, "owner": "unassigned",
    "segment": "mid-market", "industry": "logistics",
    "tenure_days": 412
  },
  "business_context": "Contracts are annual. Logistics customers are seasonally quiet in August.",
  "situation": { "kind": "churn_risk", "score": 7, "rule_severity": "high" },
  "signals": [
    { "id": "S1", "kind": "usage_drop_30d", "band": 2, "statement": "Average daily active users fell 45% over the last 30 days (11 vs 20)." },
    { "id": "S2", "kind": "renewal_near", "band": 2, "statement": "Renewal is in 40 days (2026-10-19)." },
    { "id": "S3", "kind": "tickets_up_30d", "band": 1, "statement": "Support tickets rose from 4 to 9 in the last 30 days; 1 open ticket is marked urgent." },
    { "id": "S4", "kind": "champion_inactive", "band": 1, "statement": "The champion (VP Operations) has not been active for 17 days." },
    { "id": "S5", "kind": "seat_util_low", "band": 1, "statement": "14 of 40 seats were used in the last 7 days (35%)." }
  ],
  "cohort": null,
  "prior_decisions": [
    { "kind": "churn_risk", "status": "dismissed", "when": "2026-07-30", "reason": "Seasonal dip, confirmed with customer", "outcome": null },
    { "kind": "payment_risk", "status": "resolved", "when": "2026-03-02", "reason": null, "outcome": "payment_recovered" }
  ],
  "impact": { "amount": 50000, "basis": "annual contract value at risk", "currency": "USD" },
  "action_catalogue": [
    { "id": "exec_outreach", "label": "Executive outreach call" },
    { "id": "technical_review", "label": "Technical health review with the customer" },
    { "id": "renewal_prep", "label": "Start the renewal conversation early" },
    { "id": "billing_contact", "label": "Contact the billing owner about the failed payment" },
    { "id": "expansion_call", "label": "Contact the account owner about adding seats" },
    { "id": "monitor", "label": "Keep watching; no action yet" }
  ]
}
```

Rules for the packet:

- Names are pseudonymised by default (`ref: "A-17"`, contact roles instead of names). The
  UI re-hydrates. A setting turns this off. Section 19 explains why.
- Only signals with band >= 1 are included; band 0 signals are omitted, not sent as
  "normal", to keep the packet small. Exception: for `expansion` and `payment_risk` the
  packet also carries `renewal_near` at any band because timing matters to the action.
- `prior_decisions` carries at most three, with the dismissal reason and, for resolved
  ones, the recorded outcome, so the model can say "this was dismissed six weeks ago as
  seasonal; the decline has continued" or "a payment problem on this account was
  recovered in March". This is the outcome-read-back that Shiplog describes (section 2A),
  done as data in the packet rather than as agent memory.
- `tenure_days` lets the brief distinguish an onboarding failure (under 90 days) from a
  value question on a mature account; the prompt names both cases.
- `business_context` is the workspace's free-text note (Settings, max 1,000 characters).
  It is the one place a person can tell the model things the data cannot (seasonality,
  contract shape, a known migration). It is included verbatim, it is not a source of
  numbers (the number-grounding check still applies), and it is shown on the decision
  detail as "Context you gave the model" so its influence is visible.
- The `impact` block is computed by code (section 13.2). The model never produces a money
  figure.
- The action catalogue is fixed per situation kind (a subset of the six).

### 12.3 System prompt (`src/decisions/prompts.mjs`, `PROMPT_VERSION = 1`)

```
You are a customer-success analyst. You are given a fact sheet about one customer account
of a software company, and you write a short decision brief for a busy manager.

The fact sheet is the only thing you know. Every fact in it was computed by software from
the company's own data. You must not add facts, numbers, dates, names or causes that are
not in the fact sheet. If you refer to a fact, cite its signal id (S1, S2, ...). The
business_context field is written by the company; use it to interpret the signals (for
example a known seasonal dip), never as a source of numbers. Use tenure_days to tell an
account that never got going (under 90 days) from a mature account that has changed;
these need different actions.

Write four things:
1. why_it_matters: two or three sentences a manager can act on. Interpretation, not a
   restatement of the signals. No new numbers.
2. what_changed: the signal ids, most important first.
3. hypotheses: one to three possible explanations, each with a confidence (high, medium,
   low) and the signal ids that support it. These are guesses; write them as guesses. If
   the fact sheet has a "cohort" entry, one hypothesis must say the change is shared by
   many accounts and is probably not specific to this one.
4. recommended_action: exactly one id from action_catalogue, with a one-sentence rationale.

Also return severity (critical, high, medium, low) and confidence (high, medium, low) for
the brief as a whole, and actionable: false with a not_actionable_reason if the fact sheet
does not justify a decision (for example, one weak signal, or a prior decision already
covers it and nothing has changed).

Return only a JSON object with these keys and nothing else:
{"actionable": true, "why_it_matters": "...", "what_changed": ["S1"], "hypotheses":
[{"text": "...", "confidence": "medium", "evidence": ["S1"]}], "recommended_action":
{"id": "...", "rationale": "..."}, "severity": "high", "confidence": "medium",
"not_actionable_reason": null}
```

The user message is the packet JSON. Temperature 0 (the `GatewayClient.chat` `temperature`
option is already plumbed). `maxTokens: 900`, `timeoutMs: 90_000`, `task: "decision-brief"`.

### 12.4 Output schema and validation (`src/decisions/schema.mjs`)

Declared with `zod` (add it to `package.json` dependencies; it is already installed as a
transitive dependency of `@opencode-ai/plugin`, so no download):

```js
const Brief = z.object({
  actionable: z.boolean(),
  why_it_matters: z.string().min(20).max(600),
  what_changed: z.array(z.string()).min(1).max(8),
  hypotheses: z.array(z.object({
    text: z.string().min(10).max(300),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string()).min(1).max(6),
  })).min(1).max(3),
  recommended_action: z.object({ id: z.string(), rationale: z.string().min(10).max(300) }),
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]),
  not_actionable_reason: z.string().max(300).nullable(),
});
```

Then four grounding checks that zod cannot express, in `validateBrief(brief, packet)`:

1. Every id in `what_changed` and every `evidence` id exists in `packet.signals`.
2. `recommended_action.id` is in `packet.action_catalogue`.
3. **Number grounding:** every numeric token in `why_it_matters`, hypothesis texts and the
   rationale (integers, decimals, percentages, currency amounts, dates) must appear in the
   set of numbers extracted from the packet (signal statements, account block, impact
   block). Formatting variants are normalised (`45%`, `-45`, `45 percent`; `50,000`,
   `50000`, `$50K`). Ordinals and small counting words up to ten are allowed.
4. **No URLs, no email addresses** in any text.
5. If `actionable` is false, `not_actionable_reason` must be non-empty; the rest may be
   minimal.

Parsing: strip a leading/trailing code fence, take the first `{` to the last `}`, then
`JSON.parse`. Free models add prose around JSON often enough that this matters.

### 12.5 Failure handling

```
attempt 1 -> invalid? -> attempt 2 with the validator's message appended as a user turn
             ("Your previous answer failed validation: <reasons>. Return corrected JSON only.")
attempt 2 -> invalid? -> rule_only decision
```

`complete()` already walks the model fallback chain on 401/402/403/429/5xx/timeouts, so a
dead upstream is handled below this layer. What this layer adds: a **rule-only decision**
when reasoning fails twice or throws. The decision exists (title, severity, evidence,
impact, a template action for the situation kind), `reasoning_source = "rule_only"`,
`reasoning_error` holds the reason, the UI shows "AI explanation unavailable" with a
"Try again" button that re-runs reasoning for that decision alone. **The product never
hides a situation because a model failed.**

Every attempt is written to `llm_call` (valid/invalid, tokens, latency, model served),
in addition to the telemetry JSONL `recordCall()` already writes.

A per-run budget: `maxReasonedPerRun` (default 10) and `maxLlmFailuresPerRun` (default
5, after which the run stops reasoning and marks the rest `skipped_cap`, so a broken model
cannot burn an hour).

### 12.6 Grounding and hallucination constraints, in one list

- The packet contains sentences, not tables: there is nothing to mis-add.
- Numbers in the output are checked against numbers in the input.
- Evidence ids are checked against the packet.
- Money is never produced by the model; `impact` is code-computed and displayed from the
  decision row, not from the brief.
- Severity is rule-derived; the model's severity is stored in the event data and shown as
  "the model rated this <x>" only when it differs. Prioritisation is therefore
  deterministic and explainable.
- The UI labels every block by kind (Observed fact / AI interpretation / Hypothesis /
  Recommendation). Observed facts come from `signal.statement`; the model's text is never
  shown under "Observed".
- Prompt version is stored on each decision; changing the prompt bumps the version and
  invalidates the cache.

### 12.7 Model abstraction and routing

- All calls go through `complete()` in `src/routing/execute.mjs`, so provider choice,
  mode, pinning and fallback are inherited unchanged. The Decisions settings page shows
  the current mode and links to Omni Agent's Settings; it does not add a second selector.
- Two new tasks are added to `config/models/metadata.json` `tasks`:
  `"decision-brief": "smart"` and `"decision-draft": "fast"`. That is the whole of model
  routing for the MVP: reasoning goes to the smart combo, email drafting to the fast one.
- No separate triage model. The deterministic rules are the triage. A cheap-model
  pre-filter is listed under BUILD LATER for when N per run grows past what the cap can
  hold.
- The run orchestrator takes `complete` as an injectable function, so unit tests use a
  recorded-response stub and the eval harness can run in `--recorded` or `--live` mode.

### 12.8 Draft email (`purpose = draft_email`)

Input: the decision (title, why_it_matters, top three evidence statements, recommended
action label), account name (real name here, since the person is about to send it), the
owner's name, and the tone ("plain, short, no jargon, no numbers the customer would not
know"). Output: plain text, first line `Subject: ...`, then the body; no JSON. Grounding
check: numbers in the body must appear in the evidence statements. Fallback: a template
per situation kind with `{account}`, `{owner}` placeholders. Never sent: the UI offers
"Copy" and "Open in my mail app" (`mailto:` built client-side from the payload).

---

## 13. Decision architecture

### 13.1 Situation rules (`config/decisions/rules.json`, `situations` block)

| kind | requires | min score | action catalogue |
|---|---|---|---|
| `churn_risk` | `usage_drop_30d` >= 1 AND at least one of `renewal_near` >= 1, `tickets_up_30d` >= 1, `champion_inactive` >= 1, `seat_util_low` >= 1 | 3 | exec_outreach, technical_review, renewal_prep, monitor |
| `expansion` | `usage_rise_30d` >= 1 AND (`seat_util_high` >= 1 OR `pricing_interest` >= 1) | 2 | expansion_call, renewal_prep, monitor |
| `payment_risk` | `payment_failed` >= 2, OR `payment_failed` >= 1 AND (`usage_drop_30d` >= 1 OR `champion_inactive` >= 1) | 2 | billing_contact, exec_outreach, monitor |
| `cohort_shift` | see 11.3; one per run | n/a | monitor (the decision is informational) |
| `watch` | exactly one signal with band >= 1 and no rule matched | n/a | none; never reasoned |

Score = sum of the bands of the signals the rule used. Usage signals flagged `unreliable`
by `data_stale` do not count. **A single signal never becomes a decision.** That is the
false-positive guard and it is a rule, not a model judgement.

### 13.2 Severity, priority and impact (all code)

- Severity from score: >= 8 critical, >= 6 high, >= 4 medium, else low; `payment_risk`
  with band 3 is at least high; `cohort_shift` is medium unless share >= 60% (high).
- Priority (for ordering the LLM queue and Today) = severity rank x 10 + log10(max(arr,
  1000)) x 2, tie-break by fewer days to renewal.
- Impact: `churn_risk` -> `arr`, basis "annual contract value at risk"; `expansion` ->
  `(max(seats_used_7d, seats_purchased) - seats_purchased + 5) x seat_price_monthly x 12`
  when `seat_price_monthly` is known, else null with basis "not estimated: seat price not
  provided"; `payment_risk` -> failed amount, basis "unpaid invoice", plus the ARR shown
  separately as context; `cohort_shift` -> sum of ARR of affected accounts, basis "ARR of
  accounts showing the change". Impact is never a prediction; the basis string says what
  the number is.

### 13.3 Lifecycle

```
new --accept--> accepted --start--> in_progress --wait--> waiting --resume--> in_progress
 |                 |                    |                    |
 |                 +---------- snooze(until) ---------------+   -> snoozed --expiry/wake--> (status_before_snooze)
 |                 |                    |                    |
 +--- dismiss(reason) from any open status ---> dismissed
 |
 +--- resolve(outcome, note) from accepted / in_progress / waiting ---> resolved
```

Enforced by a transition table in `src/decisions/decisions.mjs`; an illegal transition
returns `ok:false` with the allowed next states. Every transition writes a
`decision_event`. `resolved` requires an `outcome` row in the same transaction.
`dismissed` requires a reason (free text, min 3 characters). Reopening a resolved or
dismissed decision is a user action ("Reopen") that creates a `status` event and returns
it to `accepted`.

### 13.4 Upsert and dedupe across runs

Fingerprint = `account_id:kind` (or `cohort:kind`). On each run, for each reasoned or
rule-only candidate:

1. **No open decision with this fingerprint** -> create (`created` event). If a dismissed
   decision with the same fingerprint exists from the last 14 days, create only if the
   new severity is higher than the dismissed one's; otherwise record `situation.outcome =
   "suppressed_dismissed"` and do not create. The customer page shows "a similar decision
   was dismissed on <date>".
2. **Open decision exists, packet hash unchanged** -> no model call (`cached`), touch
   `last_run_id`, no event (nothing changed).
3. **Open decision exists, packet changed** -> re-reason, replace evidence and
   hypotheses, keep status/owner/due, write `updated` event with the diff of bands; if
   severity rose, write `escalated`; if the decision is `snoozed` and severity rose, wake
   it (`unsnoozed`, reason "got worse").
4. **Open decision exists and the candidate is now `not_actionable` or the rule no longer
   matches** -> do not auto-resolve. Write a `note` event "the signals that raised this
   have eased" and show a "Signals eased" chip so the person decides. Auto-closing would
   hide the outcome the product exists to record.

### 13.5 Title (code, not model)

`"{Account name}: {kind label}"` with a suffix from the strongest signal:
"Acme: churn risk, renewal in 40 days", "Beta Corp: expansion opportunity, 9 seats over
limit", "Gamma: payment failed 3 times", "Company-wide: usage down for 62% of accounts".
Consistent titles make the list scannable; the model's phrasing goes into
`why_it_matters`.

---

## 14. Follow-up and action architecture

### 14.1 The clock

Signals are computed relative to `meta.as_of`, which defaults to the real date and is
refreshed to today on each run unless **demo mode** pins it. Demo mode (Settings) adds
"Advance the clock by N days", which moves `as_of`, re-runs follow-up, and re-runs the
analysis. This is what lets a five-minute demo show a reminder appearing and an
expiry firing without waiting a week. The synthetic dataset is generated relative to
`as_of` so it never looks stale.

### 14.2 Follow-up tick (`src/decisions/followup.mjs`)

Started from `launch.mjs` next to `startScheduler()`, same shape as `routines.mjs`
(`setInterval`, `unref`, guarded), every 5 minutes and once at start:

1. `snoozed` with `snoozed_until <= now` -> status = `status_before_snooze` (or `new`),
   `unsnoozed` event.
2. Open decisions with `due_at < now` and no `reminder` event in the last 24 h ->
   `reminder` event `{days_overdue}`. Today shows them under "Overdue".
3. `waiting` for more than `waitingNudgeDays` (default 7) with no `reminder` in 7 days ->
   `reminder` event `{waiting_days}`.
4. If `settings.autoRunDaily` and the last run is older than 24 h -> run the analysis.
   Off by default in the MVP so the person sees the Run button do the work.

All in-app. "Even when closed" is BUILD LATER (a Windows task running
`omni-agent decisions run`, mirroring `registerTask()` in `routines.mjs`).

### 14.3 What the person sees

- Today: "Needs your attention" (new + escalated), "Overdue" (reminder events), "Waiting
  on you" (accepted with no action in N days), "Snoozed until ...", "Resolved this month".
- Every open decision shows its age ("raised 6 days ago") and, when overdue, "You have not
  handled this yet: 3 days overdue".
- Activity lists reminders as system entries so the nag is visible and auditable.

### 14.4 Actions (two, human-in-the-loop)

| Action | Prepared by | Done by |
|---|---|---|
| **Draft email** | model (section 12.8), template fallback; stored as `action(kind=draft_email, status=prepared)`; editable text area | the person: Copy or "Open in my mail app" (`mailto:` with subject and body), then "Mark as sent" -> `done`, `action_done` event |
| **Create task** | the person fills title (prefilled from the recommendation), owner (from the owners list), due date (prefilled from the decision), note | saving it sets `decision.owner` and `decision.due_at` if empty, writes `action(kind=task)` and `action_prepared`; "Mark as done" -> `done` |

Nothing is sent, posted or written outside the machine. An action can be cancelled with a
reason. Accepting a decision without an action is allowed; the "Waiting on you" bucket is
what nudges.

**Conflict guard** (Shiplog's "will not enrol the same customer in conflicting
campaigns", section 2A): at most one `draft_email` action in `prepared` or `done` status
per account in any 14-day window. A second request is refused and the dialog names the
existing one ("An email to Acme was prepared 3 days ago for the churn-risk decision;
open it instead"). The window is `outreachCooldownDays` in `rules.json`.

---

## 15. Dashboard and UI architecture

### 15.1 Shell

A second page, `src/ui/public/decisions/index.html`, served by the existing server at
`/decisions/?t=<token>`. It imports `../app.css` for tokens and components and
`decisions.css` for its own layout. Its module `decisions.js` copies the five helpers
(`api`, `$`, `el`, `toast`, `fmtWhen`) from `app.js` verbatim (with a comment saying so)
and adds a hash router (`#/today`, `#/decisions`, `#/decisions/<id>`,
`#/customers`, `#/customers/<id>`, `#/activity`, `#/settings`, `#/onboarding`).

Layout: left sidebar (220 px): product mark and workspace name; nav Today, Decisions,
Customers, Activity, Settings; footer: "Last analysis 2 h ago", a "Run analysis" button,
"Back to Omni Agent". Main: a 46 px top bar (view title, filters, primary button) and the
view. Max content width 920 px for lists, 760 px for the detail's reading column with a
280 px right rail.

Model output is inserted with `textContent` only, as in `app.js`.

### 15.2 Visual language

Inherits `app.css`: Segoe UI, the warm neutral palette, terracotta accent, light and dark.
Severity uses the existing semantic colours only: critical = `--bad` filled chip, high =
`--bad` outline, medium = `--warn`, low = `--ink-faint`. Kind chips for evidence blocks:
Observed fact (`--good` tint), AI interpretation (`--accent` tint), Hypothesis (`--warn`
tint), Recommendation (`--ink` on `--line-soft`). No icons beyond the existing glyph
style, no illustrations, no charts. One inline `.bar` for seat utilisation on the customer
page is the only graphic.

### 15.3 Information hierarchy on a decision card

```
[HIGH]  Acme: churn risk, renewal in 40 days                      $50,000 ARR at risk
        Active users fell 45% over 30 days · Tickets up 4 -> 9 · Champion inactive 17 days
        Recommended: Technical health review with the customer
        raised 2 days ago · owner: unassigned                     [Handle] [Snooze] [Dismiss]
```

Everything on the card is either a rule-computed fact or the recommendation label. The
model's prose appears only in the detail, under its kind chip.

---

## 16. Screen-by-screen UX specification

Every screen states: purpose, layout, components, information, primary CTA, secondary
actions, empty state, loading state, error state.

### 16.1 Onboarding (`#/onboarding`, shown when no workspace exists)

- Purpose: get from install to first decision in three steps without explaining AI.
- Layout: centred card, 520 px, a three-step indicator.
- Step 1 "Name your workspace": text field, prefilled "My company". CTA "Continue".
- Step 2 "Add your data": two large cards. "Load the demo company" (recommended for a
  first look; says "48 made-up customers, no real data") and "Import a folder of CSV
  files" (opens the folder picker; below it, the five file names and a "Show me the
  columns" disclosure). CTA is on each card.
- Step 3 "Run the first analysis": a summary ("48 accounts, 90 days of usage, 212
  tickets, 96 invoices") and CTA "Run analysis". Progress card as in 16.2. On completion,
  "Open Today".
- Empty: n/a. Loading: the import card shows "Reading files..." with per-file rows.
  Error: import report inline with the offending column or rows, CTA "Choose a different
  folder"; a failed run shows the error and "Try again".

### 16.2 Today (`#/today`)

- Purpose: answer "what needs my attention?" in one screen.
- Layout: title "Today", a one-line status ("Last analysis 2 h ago · 48 accounts · 3 new
  decisions · model: auto/smart"), a stat strip of five tiles (Needs attention, Overdue,
  Waiting on you, Snoozed, Resolved this month), then sections of decision cards.
- Components: stat tile, decision card (15.3), section headers with counts, the Run
  analysis button (top right) with an inline progress card while running (accounts read,
  signals, candidates, "reasoning 3 of 5", tokens so far, elapsed).
- Information: cards sorted by priority within each section; "ARR under review" total in
  the strip's subtitle.
- Primary CTA: Handle on the first card. Secondary: Snooze, Dismiss, Run analysis, open a
  card.
- Empty (no run yet): "No analysis yet" with Run analysis. Empty (run done, nothing):
  "Nothing needs a decision. 48 accounts checked, 6 single signals being watched (see
  Customers). Next check: when you run it." Loading: skeleton tiles and three skeleton
  cards. Error: a card "The last analysis failed: <reason>" with Try again and a link to
  Activity.

### 16.3 Decisions (`#/decisions`)

- Purpose: every decision, filterable.
- Layout: filter row (Status: Open / New / Accepted / In progress / Waiting / Snoozed /
  Resolved / Dismissed; Severity; Owner; Kind; sort by Priority / Newest / Due date),
  then a table-like list: severity chip, title, customer, impact, owner, status tag, age,
  due.
- Primary CTA: open a row. Secondary: bulk nothing (MVP), filter chips clearable.
- Empty: per filter, "No decisions match" with "Clear filters". Loading: skeleton rows.
  Error: inline message with Retry.

### 16.4 Decision detail (`#/decisions/<id>`)

- Purpose: the person understands why, decides, and acts, without leaving the page.
- Layout: breadcrumb "Decisions / Acme"; title; severity chip, kind, status tag, "raised
  N days ago", "updated N days ago"; reading column (760 px) and right rail (280 px).
- Reading column, in this order, each a card with a kind chip:
  1. **Why this matters** (AI interpretation) - `why_it_matters`; when `rule_only`, the
     card reads "AI explanation unavailable: <reason>" with Try again.
  2. **What changed** (Observed fact) - the `what_changed` signals as a list: statement,
     band as "notable / significant / severe", window.
  3. **Evidence** (Observed fact) - every signal on the account this run, including the
     ones not cited, each with its numbers and the rule threshold it crossed ("fell 45%;
     the rule flags 25%"). This is where "the AI does not magically know things" is made
     visible.
  4. **What might be causing it** (Hypothesis) - up to three, each with a confidence tag
     and "based on S1, S5" links that highlight the evidence rows. Wording is the model's;
     the header says "These are possible explanations, not findings."
  5. **Recommended action** (Recommendation) - the catalogue label, the rationale, and
     the two action buttons: Draft an email, Create a task. If a prior decision was
     dismissed, a note "A similar decision was dismissed on <date>: '<reason>'". If the
     workspace has a business-context note, a collapsed line "Context you gave the
     model" showing it verbatim.
  6. **Business impact** (Observed fact) - amount, basis sentence, ARR, renewal date,
     seats. Never a forecast.
  7. **Decision history** - timeline from `decision_event`: created, updated (with the
     band diff), escalated, status changes, owner/due changes, snooze/unsnooze, reminders,
     notes. Add a note field at the bottom.
  8. **Actions taken** - the `action` rows with status and payload preview; Mark as done /
     Cancel.
  9. **Outcome** - empty until resolved: "Not resolved yet"; after: result, note, date,
     ARR after (optional).
- Right rail: Status (current, with the allowed next transitions as buttons: Accept and
  assign / Start / Mark waiting / Resume / Resolve / Reopen), Owner (select from owners
  list + "add"), Due date (date input), Snooze (opens dialog: 3 days / 1 week / until
  renewal / pick a date; states the return date), Dismiss (dialog with reason; states the
  re-raise rule), Customer link, "Model: <served model>, prompt v1" in small text, and
  "Re-run reasoning".
- Dialogs: Resolve (result select + note + optional ARR after), Draft email (editable
  subject/body, Copy, Open in my mail app, Mark as sent, Discard), Create task.
- Empty: n/a. Loading: the title and skeleton cards. Error: "This decision could not be
  loaded" with Back.

### 16.5 Customers (`#/customers`, `#/customers/<id>`)

- Purpose: "what does it know about this account?"
- List: lifecycle label chip (section 11.5), name, ARR, plan, renewal, owner, open
  decisions count, watch count, a "stale data" tag when applicable; search box; filter by
  label; sort by ARR / renewal.
- Detail: facts card (ARR, plan, seats, renewal, owner, segment, contacts with roles and
  last active), "Signals this run" (every signal with band, numbers, statement, and the
  threshold), "Watching" (single signals not yet a situation, with "why this is not a
  decision: only one signal"), "Decisions" (open and past, with status), "Data" (last
  usage day, rows of each type, the import it came from).
- Primary CTA: open a decision. Secondary: none.
- Empty (no accounts): "No data imported" with Import. Loading: skeleton. Error: inline.

### 16.6 Activity (`#/activity`)

- Purpose: what the system detected and what the person did, in time order.
- Layout: a day-grouped list; entries: runs ("Analysis: 48 accounts, 5 situations, 3 new
  decisions, 4 model calls, 6,120 tokens, 41 s"), decision events (linked), imports,
  reminders, settings changes. Filter: All / System / Me.
- Empty: "Nothing has happened yet." Loading: skeleton. Error: inline.

### 16.7 Settings (`#/settings`)

- Sections: Workspace (name; delete workspace with typed confirmation), Data (import
  another folder; the last import report; "download CSV templates" writes them to the
  Downloads folder with `writeDocument`), Owners (list of names; add/remove), Business
  context (one text area, max 1,000 characters, with the sentence "The model reads this
  with every decision. Say what the data cannot: seasonality, contract terms, known
  changes. Do not put numbers here."), Analysis
  (max decisions reasoned per run; thresholds table from `rules.json` shown read-only with
  three editable numbers: usage drop band 1, renewal band 1, ticket rise band 1; reset
  to defaults), Privacy (pseudonymise customer names before sending to the model: on by
  default; the sentence explains that free models are third-party services), Model (the
  current Omni Agent routing mode and served model, read-only, link to Omni Agent's
  Settings), Demo (demo mode switch, "Advance the clock by [7] days", "Reload the demo
  company"), About (version, prompt version, data folder path, "Open folder").
- Error: any failed save shows the message inline next to the control.

### 16.8 Global states

- Analysis running: the Run button becomes a progress pill in the sidebar footer, visible
  from every view; a second click is refused ("already running").
- Model unavailable: a banner on Today: "The model gateway is not answering. Decisions
  will be raised from rules only until it is back." with a link to Omni Agent's Free
  capacity page.
- Data stale for the whole workspace (last usage day > 7 days before as_of): a banner
  "Usage data ends on <date>. Import fresher data or, in demo mode, advance the clock."

### 16.9 Accessibility and responsiveness

Keyboard: every control is a real button or input; the detail page's rail buttons are in
tab order after the reading column; dialogs trap focus and close on Escape (the existing
modal already closes on backdrop click). Colour is never the only carrier: severity chips
carry the word. Reduced motion respected as in `app.css`. Below 900 px the rail stacks
under the reading column and the sidebar collapses to the existing hamburger pattern.

---

## 17. Synthetic and demo data strategy

### 17.1 Recommendation on the data source

**Option D-lite: a synthetic company, imported through the CSV path, with one real
connector (Stripe) deferred to BUILD LATER.**

| Option | Verdict | Why |
|---|---|---|
| A. Synthetic only, in memory | rejected | It would bypass the importer, so the demo would exercise a path no real customer uses. |
| B. Local CSV/JSON dataset | **chosen, generated rather than hand-written** | Reproducible, credential-free, and the same importer serves a real export. |
| C. One real integration (Stripe) | later | Stripe alone yields payment status and MRR; it cannot produce usage, tickets, champions or seat data, so it demonstrates one situation kind out of four and adds key handling and rate limits before the loop is proven. Stripe test mode plus test clocks is the right second step. |
| D. Synthetic + one connector | later | Same as C; it is the first expansion once section 28 is satisfied. |

### 17.2 The generator (`src/decisions/synthetic.mjs`)

Deterministic from a seed (a small mulberry32 PRNG, no dependency), relative to `as_of`,
90 days of daily usage, writing the five CSVs plus `workspace.json` into a folder, then
imported through `ingest.mjs` like any other folder. Default: 48 accounts, ARR from 6,000
to 240,000 on a log-normal spread, plans Starter/Team/Business, seats 5 to 120, renewal
dates spread over 0 to 365 days, one champion per account, tickets at a base rate tied to
seats, invoices monthly.

Planted scenarios (each with a `scenario` label kept out of the CSVs and written to
`scenarios.json` beside them for the evaluation harness):

| Scenario | Count | Construction | Expected outcome |
|---|---|---|---|
| Healthy | 28 | flat or gently rising usage, renewal > 90 days, normal tickets, paid invoices | no decision; at most a watch |
| Churn risk, clear | 4 | usage down 40 to 60% over 30 days, renewal 20 to 50 days, tickets up, champion inactive 15 to 40 days, seat util 25 to 40% | `churn_risk`, severity high or critical |
| Churn risk, subtle | 2 | usage down 28 to 35%, renewal 60 to 85 days, tickets up modestly | `churn_risk`, severity medium |
| Expansion | 3 | usage up 70 to 120%, seats used >= purchased, 2 to 4 pricing page views | `expansion` |
| Payment problem | 3 | failed invoice with 2 to 3 attempts, usage down 20 to 30%, champion quiet | `payment_risk` |
| False positive: single metric | 4 | one of: tickets up 120% on a tiny base (2 -> 5) with everything else healthy; a 7-day dip that recovers; renewal in 18 days with strong usage; champion inactive 20 days with rising usage | watch only, **no decision** |
| Previously dismissed, unchanged | 1 | a churn-risk account with a dismissed decision seeded 10 days ago and no worsening | suppressed |
| Previously dismissed, worse | 1 | same, but usage fell a further band | new decision, note about the dismissal |
| Stale data | 1 | usage rows stop 15 days before as_of | `data_stale`, usage signals unreliable, no usage-based decision |
| Company-wide event | applied to 60% of accounts in the `cohort` variant | usage down 20 to 35% for all of them from day -21 | one `cohort_shift` decision, member decisions carry the cohort hypothesis, healthy members do **not** each become a churn decision (their score stays below 3) |

Two named datasets ship: `demo` (the default, no cohort) and `demo-cohort` (the same seed
with the company-wide event applied), selectable in Settings > Demo. Both are also written
as fixtures under `tests/fixtures/decisions/` by a script so the tests and the demo never
drift apart.

### 17.3 Why this proves more than threshold-flagging

The four false-positive accounts each cross one threshold and must produce no decision;
the subtle churn accounts cross no single dramatic threshold and must produce one; the
cohort variant must produce one company-wide decision rather than 29 churn decisions.
Passing all three is the difference between "a rules engine" and "a decision system".

---

## 18. External intelligence recommendation

**Do not build it in the MVP.** The reasons, in order:

1. The hypothesis is about the internal loop. External lookups add a second unproven
   component and a second failure mode before the first is measured.
2. Attributing a decline to a news item is exactly the unsupported causal claim section
   12.6 forbids, and the free-model pool is the least reliable place to draw that line.
3. The one situation where it matters, the company-wide shift, is detected without it
   (section 11.3) and the decision already says "not explained by internal data".

**Where it plugs in later**, specified so nothing in the MVP blocks it:

```
cohort_shift decision created
  -> (later) web_search via src/tools/search.mjs: "<industry> <segment> news" limited to the last 45 days, 5 results
  -> web_fetch the top 3; extract title, date, final URL
  -> one model call: "do any of these plausibly relate to a usage decline starting around <date>? answer with the item ids and a confidence, or none"
  -> stored as decision_hypothesis rows with kind = "external", confidence <= medium by rule, text prefixed "Possible external factor (unverified): " and the final URL attached
  -> the UI shows them under "What might be causing it" with a distinct chip "External, unverified"
```

Constraints to write into that phase: never above medium confidence; never in
`why_it_matters`; never for per-account decisions, only for `cohort_shift`; every item
carries the fetched URL and date; the product never uses the words "caused" or "because"
for an external item. In the MVP the cohort decision shows one line: "External context:
not checked in this version."

---

## 19. Security and privacy architecture

| Concern | MVP design |
|---|---|
| Data isolation | One SQLite file per workspace under the app's own data directory, user-only permissions (inherited). No cross-workspace queries. Deleting a workspace deletes the folder. |
| Credentials and API keys | None new. Model keys stay in the existing DPAPI store; Decisions never reads them (it calls `complete()`). A future Stripe key would use `setSecret("stripe.apiKey")`. |
| Secrets storage | Unchanged: `credentials.dat`, DPAPI. Nothing in `decisions.sqlite` is a secret. |
| Least privilege | The Decisions module reads its own folder and the import folder the person chose, and writes only its own folder and, for templates, the Downloads folder. It never spawns a shell. It does not use the browser tool. |
| LLM data handling | The packet is the only thing sent. **Pseudonymised by default**: account names become `A-17`, contacts become roles, no emails, no free-text ticket subjects (only counts). The Privacy setting states in one sentence that free models are third-party services and shows an example packet. The draft-email call sends the real account name only after the person clicks Draft, and the dialog says so. |
| Logs | `logger()` redacts by key and value shape already. The Decisions module logs ids, counts and durations at `info`, never packet bodies; packets are logged at `debug` only, and `debug` is off by default. `llm_call` stores hashes and tokens, not text. |
| PII | Contact names and emails exist only in the raw tables and the UI. The importer drops any column not in the contract, so an export with extra PII columns is not stored. |
| Deletion | Settings > Delete workspace (typed confirmation) removes the SQLite file and the import copies. Re-import replaces raw tables in a transaction. |
| User permissions | Single local user, same as the rest of the app. No roles. |
| Action authorisation | No action leaves the machine. Draft email is opened in the person's own mail client by their click. There is no send path in the code. |
| Audit history | `decision_event` is append-only (no update or delete statements exist for it). `llm_call` records every model attempt. `run` records every analysis. |
| Transport | Same loopback server, same per-launch token, same Host check, same CSP. New routes are added to the same table and inherit the guard. |
| Fixtures | Synthetic data uses `example.com`, generated names from a word list, and no key-shaped strings, so `scan:secrets` stays clean. |

---

## 20. Testing strategy

Convention: `node --test`, hermetic unit tests under `tests/unit/`, live tests under
`tests/integration/`, the eval harness under `tests/eval/decisions/`. `npm test` picks up
new unit files automatically (`tests/unit/*.test.mjs`).

### 20.1 Unit tests (no network, no gateway, in-memory SQLite)

| File | Covers |
|---|---|
| `tests/unit/decisions-db.test.mjs` | migrations apply once; schema version stored; the partial unique index on open fingerprints holds; cascade deletes. |
| `tests/unit/decisions-ingest.test.mjs` | the five CSVs from fixtures import; missing required column is rejected and named; unknown account rows are counted; duplicate ids keep the last; bad dates and numbers reject the row; re-import replaces raw tables and leaves decisions alone; the report matches the counts. |
| `tests/unit/decisions-signals.test.mjs` | each signal with hand-built rows: exact band boundaries (24.9% vs 25%), missing days, fewer than the minimum days, zero baseline, stale data flag, urgent-ticket band bump, seat util with 0 seats purchased, champion_left event, renewal today, renewal in the past. |
| `tests/unit/decisions-situations.test.mjs` | rule matching, min scores, single signal -> watch, unreliable usage ignored, cohort emitted at 40% and not at 39%, priority ordering, cap and skipped_cap, severity bands, impact computation incl. the "not estimated" basis. |
| `tests/unit/decisions-schema.test.mjs` | validator: fenced JSON, prose around JSON, missing key, bad enum, unknown evidence id, action not in catalogue, a number not in the packet (e.g. "38 days" when the packet says 40), URL in text, actionable:false without a reason. |
| `tests/unit/decisions-packet.test.mjs` | pseudonymisation on/off; hash stability (same rows -> same hash; one band change -> different hash); band-0 signals omitted; prior decisions capped at three. |
| `tests/unit/decisions-run.test.mjs` | the orchestrator with a stub `complete`: valid brief -> decision with evidence and hypotheses; invalid then valid -> one retry recorded; twice invalid -> rule_only with reasoning_error; thrown error -> rule_only; cap respected; unchanged packet -> cached, no call; changed packet -> updated event; severity rise -> escalated and wakes a snoozed decision; dismissed-recently suppression; not_actionable -> dropped and counted; failure budget stops reasoning. |
| `tests/unit/decisions-lifecycle.test.mjs` | every legal transition; every illegal one refused with the allowed list; resolve requires outcome; dismiss requires reason; reopen; events written for each. |
| `tests/unit/decisions-followup.test.mjs` | with an injected clock: snooze expiry restores the prior status; overdue writes one reminder per 24 h; waiting nudge after 7 days; nothing fires twice in one tick. |
| `tests/unit/decisions-synthetic.test.mjs` | the generator is deterministic for a seed; scenario counts match; each planted scenario produces the expected signal bands through the real signal engine (this is the fixture's own self-check). |
| `tests/unit/decisions-actions.test.mjs` | draft email template fallback; grounding check on the model draft; task creation sets owner/due when empty and not when set. |
| `tests/unit/decisions-routes.test.mjs` | every `api("decisions...")` name in `decisions.js` exists in the route table (mirror of the existing `ui.test.mjs` check); routes return `ok:false` with a reason on bad input; the demo clock route is refused outside demo mode. |

### 20.2 Integration tests (live gateway, live model)

`tests/integration/decisions-reason.test.mjs`: three packets (clear churn, expansion,
cohort member) through the real `complete()`; assert at least two of three briefs pass the
validator on the first or second attempt, log the served model, and assert that a brief
for the cohort member mentions the shared change in a hypothesis. Skipped with a message
when the gateway is down, like the existing integration tests do for the network.

`tests/integration/decisions-ui.test.mjs`: start `startServer()` (no window), seed the demo
workspace with a recorded-response `complete`, drive the page with Playwright through
`src/tools/browser.mjs`: Today shows decisions; open one; Accept and assign; Create task;
Snooze; advance the clock 8 days via the settings route; the decision shows "overdue";
Resolve with an outcome; Activity lists the chain. Asserts on `read`-style text, not on
pixels.

### 20.3 Failure tests (in the unit suite above, listed here against the brief)

| Failure | Test |
|---|---|
| Missing data | account with no usage rows; workspace with no tickets file |
| Malformed data | bad dates, text in numeric columns, missing columns, BOM in the header, CRLF |
| API failure | `complete` throws `HttpError 503` -> rule_only |
| LLM failure | empty content; prose only; truncated JSON; wrong enum |
| Contradictory signals | usage up 60% and tickets up 150% and champion inactive: no churn rule fires (no usage drop), expansion fires only with seats/pricing; the packet carries both and the test asserts the hypotheses cite both |
| Stale data | `data_stale` suppresses usage-based situations and shows on the account |
| Duplicate events | duplicate ticket and invoice ids on import; the same run executed twice -> cached, no duplicate decision |
| Invalid model output | the schema tests |

### 20.4 Evaluation harness

`tests/eval/decisions/run-eval.mjs` (section 21). Its report is written to
`tests/eval/decisions/results/report.json` and committed, following the `tests/e2e/results`
convention of committing evidence.

---

## 21. Evaluation methodology

### 21.1 Benchmark

The two synthetic datasets (`demo`, `demo-cohort`) with their `scenarios.json` labels, plus
a third, `edge`, of 20 accounts built only from the false-positive and subtle rows. Each
account has: `scenario`, `expected_kind` (or `none`), `expected_severity_min`,
`expected_signals` (the ids planted), `acceptable_actions` (the catalogue subset a
reasonable person would accept).

### 21.2 What is measured, per dataset and per run

| Question from the brief | Metric | Computed from |
|---|---|---|
| Did it detect the situation? | recall = planted situations with an open decision of the expected kind / planted | `decision` vs labels |
| Did it avoid false decisions? | precision = decisions on planted accounts / all decisions; false-positive count on the `none` accounts | same |
| Did it prioritise correctly? | Spearman correlation between priority order and the label's severity order; the top 3 on Today are all severity >= high | `situation.priority` |
| Did it cite the right evidence? | evidence hit rate = cited signal ids that are in `expected_signals` / cited; missed-key-signal count | `decision_evidence` |
| Did it avoid unsupported causal claims? | ungrounded-number rate (numbers in model text not in packet), external-cause rate (regex over "market", "competitor", "economy", "news", "COVID" in hypotheses unless cohort), certainty-language rate in hypotheses ("definitely", "clearly", "is caused by") | validator log + regex over stored text |
| Was the recommendation reasonable? | acceptable-action rate = recommended id in `acceptable_actions` / decisions | `decision.recommended_action_id` |
| Cost | model calls, input/output tokens, wall time per run, per account | `run`, `llm_call` |
| Robustness | first-attempt validity rate, retry rate, rule_only rate | `llm_call` |
| Cohort behaviour | on `demo-cohort`: exactly one `cohort_shift`, and the number of churn decisions on healthy cohort members is 0 | decisions |

Modes: `--recorded` (uses `tests/fixtures/decisions/responses/*.json`, hermetic, run in
CI) and `--live` (real gateway; run before a release; the report names the served model).

### 21.3 Human evaluation (small, real)

Three people who have not seen the product, each given the demo workspace and the
Getting Started guide, timed and observed:

1. Time to first Handle (target under 5 minutes).
2. Comprehension: after opening one decision, say in their own words why it was raised
   and what the recommendation is. Scored 0/1/2 by the observer against the evidence.
3. Trust: "would you send that email as drafted, after edits?" yes/no and why.
4. Loop: after the clock is advanced, do they notice the overdue reminder without being
   told? Do they find where the outcome is recorded?
5. Confusions: every question they ask is written down and mapped to section 7's table.

---

## 22. Success metrics

Targets for the MVP to be called validated (on `demo`, `demo-cohort`, `edge`, live model,
three runs each):

| Metric | Target |
|---|---|
| Recall of planted situations | >= 0.85 (at least 11 of 13 on `demo`) |
| False decisions on healthy and false-positive accounts | <= 1 per dataset |
| Cohort dataset | exactly 1 cohort decision; 0 churn decisions on healthy members |
| Evidence hit rate | >= 0.90; no decision misses its strongest planted signal |
| Ungrounded numbers | 0 in stored text (the validator guarantees this; the metric checks the guarantee) |
| Certainty language in hypotheses | 0 |
| Acceptable-action rate | >= 0.80 |
| First-attempt validity (live, with a provider key) | >= 0.70; rule_only rate <= 0.15 |
| Cost per full run over 48 accounts | <= 12 model calls, <= 30,000 tokens, <= 3 minutes on the free pool, <= 45 s with a key |
| Human: time to first Handle | median under 5 minutes, no help |
| Human: comprehension score | >= 1.5 of 2 average |
| Human: would act on the recommendation | >= 2 of 3 |
| Human: notices the overdue reminder unprompted | >= 2 of 3 |

"The UI works" is not a metric. Every target above is either computed by the harness or
observed with a person.

---

## 23. Implementation phases

Sizes: S = under a day, M = one to two days, L = three to four days of focused work.

### Phase 0: scaffolding (S)

- Files: `src/util/paths.mjs` (add `decisions`), `package.json` (add `zod`, add
  `test:eval` script), `config/models/metadata.json` (two tasks), `src/ui/server.mjs`
  (merge route tables), `src/decisions/routes.mjs` (empty table + `decisionsStatus`),
  `src/ui/public/decisions/index.html` + `decisions.js` + `decisions.css` (shell with nav
  and a "coming soon" Today), `src/ui/public/index.html` + `app.js` (one nav link),
  `bin/omni-agent.mjs` (`decisions open`).
- Verify: `npm test` passes; the app opens; the Decisions link opens `/decisions/` with
  the token and the shell renders; `omni-agent decisions open` prints the URL.
- Depends on: nothing.

### Phase 1: data model and ingest (M)

- Files: `src/decisions/db.mjs`, `src/decisions/ids.mjs`, `src/decisions/workspace.mjs`,
  `src/decisions/ingest.mjs`, `config/decisions/csv-templates/*.csv`, tests
  `decisions-db`, `decisions-ingest`, fixtures `tests/fixtures/decisions/tiny/*.csv`
  (5 accounts, hand-written, with deliberate defects).
- Routes: `decisionsWorkspaces`, `decisionsWorkspaceCreate/Select/Delete`,
  `decisionsImport`, `decisionsImportPick`, `decisionsImportReport`,
  `decisionsCustomers`, `decisionsCustomer`.
- Verify: unit tests; importing the tiny fixture from the UI shows the report with the
  planted defects counted; Customers lists five accounts.
- Depends on: Phase 0.

### Phase 2: synthetic data (M)

- Files: `src/decisions/synthetic.mjs`, `scripts/write-decisions-fixtures.mjs`,
  `tests/fixtures/decisions/{demo,demo-cohort,edge}/` (CSVs + `scenarios.json`), test
  `decisions-synthetic` (partly; the signal self-check lands in Phase 3), route
  `decisionsSeedDemo`, CLI `decisions seed [demo|demo-cohort|edge]`.
- Verify: same seed -> byte-identical files; scenario counts match the table in 17.2; the
  onboarding "Load the demo company" path works end to end into Customers.
- Depends on: Phase 1.

### Phase 3: signal engine (M)

- Files: `src/decisions/signals.mjs` (pure functions over rows), `config/decisions/
  rules.json` (signals block), `src/decisions/rules.mjs` (load, validate, expose
  thresholds), test `decisions-signals`, the self-check half of `decisions-synthetic`.
- Verify: every boundary test in 20.1; running signals over `demo` yields the planted
  bands for every scenario; 48 accounts x 11 signals in under 100 ms.
- Depends on: Phases 1 and 2.

### Phase 4: situations, cohort, priority, impact (M)

- Files: `src/decisions/situations.mjs`, `rules.json` (situations block, severity, impact
  parameters), test `decisions-situations`, route `decisionsRules`.
- Verify: `demo` yields 13 situations and 4 watches and 0 for the false positives;
  `demo-cohort` yields 1 cohort situation and no churn situation on healthy members.
- Depends on: Phase 3.

### Phase 5: LLM layer (L)

- Files: `src/decisions/packet.mjs`, `src/decisions/prompts.mjs`,
  `src/decisions/schema.mjs`, `src/decisions/reason.mjs` (call, parse, validate, retry,
  rule_only fallback, `llm_call` rows, injectable `complete`), fixtures
  `tests/fixtures/decisions/responses/*.json` (recorded briefs incl. invalid ones), tests
  `decisions-schema`, `decisions-packet`, integration `decisions-reason`.
- Verify: unit tests; the live integration test passes with a provider key configured;
  the probe in section 27.1 is re-run and its result written into `docs/decisions/
  how-it-works.md`.
- Depends on: Phase 4.

### Phase 6: decision engine and run orchestrator (L)

- Files: `src/decisions/decisions.mjs` (upsert, dedupe, transitions, events, outcomes),
  `src/decisions/run.mjs` (orchestrator with progress and budget), routes `decisionsRun`,
  `decisionsRunStatus`, `decisionsOverview`, `decisionsList`, `decisionsGet`,
  `decisionsUpdate`, `decisionsSnooze`, `decisionsDismiss`, `decisionsResolve`,
  `decisionsReopen`, `decisionsNote`, `decisionsRereason`, `decisionsActivity`; CLI
  `decisions run`; tests `decisions-run`, `decisions-lifecycle`.
- Verify: `omni-agent decisions run` on the demo workspace creates decisions and prints
  the run summary; running twice creates none and reports cached; the lifecycle tests.
- Depends on: Phase 5.

### Phase 7: UI (L)

- Files: `src/ui/public/decisions/{index.html,decisions.js,decisions.css}` filled out:
  onboarding, Today, Decisions, Detail (all nine sections and the rail), Customers,
  Activity, Settings, dialogs, empty/loading/error states, banners; test
  `decisions-routes` (client/server name check).
- Verify: every screen in section 16 has its three states reachable (a `?state=` debug
  query renders them for review); the demo flow in section 7 can be walked by hand.
- Depends on: Phase 6 (routes). Can start against stub JSON after Phase 0 if parallelised.

### Phase 8: follow-up and persistence (M)

- Files: `src/decisions/followup.mjs`, `src/ui/launch.mjs` (start/stop), routes
  `decisionsSettingsGet/Set`, `decisionsClockAdvance`; test `decisions-followup`.
- Verify: snooze a demo decision for 3 days, advance the clock 4 days, it is back;
  accept one with a due date, advance 8 days, Today shows it under Overdue with "You have
  not handled this yet".
- Depends on: Phases 6 and 7.

### Phase 9: actions (M)

- Files: `src/decisions/actions.mjs`, routes `decisionsActionPrepare`,
  `decisionsActionUpdate`, dialogs in `decisions.js`; test `decisions-actions`.
- Verify: Draft email produces a grounded draft (or the template when the model fails);
  "Open in my mail app" opens the default client with subject and body; Create task sets
  owner and due; both appear under Actions taken and in Activity.
- Depends on: Phase 8.

### Phase 10: testing and evaluation (M)

- Files: `tests/eval/decisions/run-eval.mjs`, `tests/eval/decisions/results/report.json`,
  `tests/integration/decisions-ui.test.mjs`, `package.json` script `test:eval`.
- Verify: `--recorded` passes in CI; `--live` report committed with the served model
  named; the targets in section 22 are met or the misses are written into the report and
  section 27 of this plan is updated.
- Depends on: Phase 9.

### Phase 11: documentation and polish (M)

- Files: `docs/decisions/*.md` (section 26), `README.md` (one section and a table row),
  `docs/desktop-app.md` (one paragraph), release notes; the in-app "How to use this" link
  in Settings pointing at the local docs folder.
- Verify: a person following Getting Started alone reaches a resolved decision; every
  feature in section 8 has a page.
- Depends on: Phase 10.

---

## 24. File-level implementation plan

### 24.1 Existing files to modify (all small, all listed)

| File | Change | Why |
|---|---|---|
| `src/util/paths.mjs` | add `decisions: path.join(HOME, "decisions")` to `PATHS` and `"decisions"` to `ensureDirs()` | one data root per feature, same as `telemetry`, `downloads` |
| `src/ui/server.mjs` | `import { decisionRoutes } from "../decisions/routes.mjs"` and dispatch against `{ ...routes, ...decisionRoutes }` (build the merged table once at module load) | keeps `api.mjs` untouched; the guard and the `ok:false -> 400` rule are inherited |
| `src/ui/launch.mjs` | call `startFollowup()` after `startScheduler()` and `stopFollowup()` in `shutdown()` | the follow-up tick lives with the other in-app timers |
| `src/ui/public/index.html` | one nav button `data-page="decisions"` labelled "Decisions" | the entry point |
| `src/ui/public/app.js` | `pages.decisions = async () => { location.href = "/decisions/?t=" + encodeURIComponent(TOKEN); }` | three lines; nothing else in the file changes |
| `bin/omni-agent.mjs` | `case "decisions"` with `open | run | seed | eval` subcommands; `usage()` gets four lines | headless runs and the demo seed without the window |
| `config/models/metadata.json` | add `"decision-brief": "smart"` and `"decision-draft": "fast"` to `tasks` | routing for the two new call purposes |
| `package.json` | `dependencies.zod` (pin to the version already in `node_modules/zod/package.json`); `scripts["test:eval"]` | declare what is used; the harness command |
| `README.md` | a "Decisions" row in the capabilities table and a short section linking `docs/decisions/` | discoverability |
| `docs/desktop-app.md` | one paragraph under "What is in it" | same |
| `.github/workflows/ci.yml` | add `npm run test:eval -- --recorded` to the unit job | the benchmark runs on every push |

`src/gateway/client.mjs`: **modify only if the probe in 27.1 shows `response_format`
improves first-attempt validity.** Then add an optional `responseFormat` field to
`chat()` and pass it through as `response_format`. Otherwise leave it.

### 24.2 New files

```
src/decisions/
  routes.mjs          the /x/decisions* table; thin: validates input, calls the modules, returns ok()/bad()
  workspace.mjs       workspaces.json, create/select/delete, opens the sqlite for the selected one
  db.mjs              DatabaseSync open, pragmas (WAL, foreign_keys), migrations, tx() helper
  ids.mjs             prefixed random ids
  ingest.mjs          folder -> validated rows -> raw tables in one transaction; report.json; uses parseCsv from src/tools/documents.mjs
  synthetic.mjs       seeded generator -> CSV folder; scenario labels
  rules.mjs           loads config/decisions/rules.json, validates shape, exposes thresholds and editable overrides from meta.settings_json
  signals.mjs         pure signal functions; computeSignals(db, accountId, asOf, rules) -> signal rows; cohort()
  situations.mjs      rules -> situations, watches, score, severity, priority, impact
  packet.mjs          buildPacket(), pseudonymise(), hashPacket(), numbersIn()
  prompts.mjs         PROMPT_VERSION, system prompts for brief and draft_email, action catalogues
  schema.mjs          zod Brief schema, parseBriefText(), validateBrief()
  reason.mjs          reasonSituation({packet, complete}) -> {brief|null, attempts, error}; records llm_call
  decisions.mjs       upsertFromCandidate(), transition(), snooze(), dismiss(), resolve(), reopen(), note(), events
  run.mjs             runAnalysis({db, complete, onProgress}) end to end; budget; run row; single-flight guard
  followup.mjs        tick(now), startFollowup(), stopFollowup(); clock helpers (asOf, demo advance)
  actions.mjs         prepareDraftEmail(), prepareTask(), updateAction()
  format.mjs          money, percent, date formatting shared by titles, statements and the email template

src/ui/public/decisions/
  index.html          the shell (sidebar, top bar, #view, modal, toasts), imports ../app.css and decisions.css
  decisions.js        helpers copied from app.js; hash router; views: onboarding, today, list, detail, customers, customer, activity, settings; dialogs
  decisions.css       stat strip, decision card, severity and kind chips, evidence rows, timeline, rail, table, skeletons, banners

config/decisions/
  rules.json          signals, situations, severity bands, impact parameters, limits (maxReasonedPerRun, maxLlmFailuresPerRun, waitingNudgeDays, dismissedSuppressDays)
  csv-templates/      accounts.csv, usage_daily.csv, contacts.csv, tickets.csv, invoices.csv, events.csv (header rows + two example rows)

scripts/
  write-decisions-fixtures.mjs   regenerates tests/fixtures/decisions/* from synthetic.mjs

tests/unit/
  decisions-db.test.mjs  decisions-ingest.test.mjs  decisions-signals.test.mjs  decisions-situations.test.mjs
  decisions-schema.test.mjs  decisions-packet.test.mjs  decisions-run.test.mjs  decisions-lifecycle.test.mjs
  decisions-followup.test.mjs  decisions-synthetic.test.mjs  decisions-actions.test.mjs  decisions-routes.test.mjs
tests/integration/
  decisions-reason.test.mjs  decisions-ui.test.mjs
tests/eval/decisions/
  run-eval.mjs  results/report.json
tests/fixtures/decisions/
  tiny/*.csv  demo/*.csv + scenarios.json  demo-cohort/*  edge/*  responses/*.json

docs/decisions/
  README.md  getting-started.md  how-it-works.md  today.md  decisions.md  decision-detail.md  customers.md
  activity.md  settings.md  actions.md  importing-data.md  demo-company.md  troubleshooting.md  privacy.md  limitations.md
```

### 24.3 Files to reuse without change

| File | Used for |
|---|---|
| `src/routing/execute.mjs` `complete()` | every model call |
| `src/gateway/client.mjs` | through `complete()` |
| `src/usage/telemetry.mjs` | call records (automatic) |
| `src/tools/documents.mjs` `parseCsv`, `toCsv`, `writeDocument` | import, templates, CSV export of decisions (Settings) |
| `src/ui/api.mjs` `showDialog` pattern | **not exported.** Either export `showDialog` and `FOLDER_DIALOG` from `api.mjs` (a two-word change to two declarations) or copy the 30 lines. Recommendation: export them; note it in the modify table. |
| `src/util/log.mjs`, `src/util/paths.mjs`, `src/util/redact.mjs` | logging and paths |
| `src/ui/public/app.css` | the design system |
| `src/ui/routines.mjs` | the scheduler pattern (copied, not imported) |
| `tests/unit/ui.test.mjs` | the "client calls only routes the server has" test, mirrored |

### 24.4 Where exact files cannot be determined yet

- Whether `GatewayClient.chat` gains `responseFormat` depends on the probe (27.1).
- Whether the Windows Scheduled Task for headless runs is added depends on section 28;
  it is BUILD LATER and touches `routines.mjs`'s `registerTask` pattern.
- The exact CSS class list in `decisions.css` will follow from the screens; the
  component names in 15 and 16 are the contract.

---

## 25. Opus execution checklist

Ordered. Each item ends with the check that proves it. Do not start an item before the
one it depends on is checked.

**Phase 0**
1. Add `PATHS.decisions` and `ensureDirs` entry. Check: `node -e` prints the path and the folder exists after `ensureDirs()`.
2. Add `zod` to `package.json` at the installed version; `npm ls zod` shows it as a direct dependency.
3. Add the two tasks to `metadata.json`. Check: `selectModel({task:"decision-brief", catalogue: synthetic})` picks a smart combo in the routing test's synthetic catalogue (add one assertion to `routing.test.mjs`).
4. Create `src/decisions/routes.mjs` exporting `decisionRoutes = { decisionsStatus }`. Merge in `server.mjs`. Check: `GET /x/decisionsStatus?t=` returns `{ok:true}`; an existing route still works.
5. Create the shell files; add the nav link and `pages.decisions`. Check: clicking Decisions in the app opens the shell with the token; Back returns.
6. Add `omni-agent decisions open`. Check: it starts the stack and prints the `/decisions/` URL.
7. `npm test` and `npm run scan:secrets` pass.

**Phase 1**
8. `db.mjs` with migration v1 (schema in 10.3), WAL, foreign keys on, `tx(fn)`. Check: `decisions-db.test.mjs`.
9. `workspace.mjs`: create/select/delete; `workspaces.json`. Check: create two, select, delete one, folder gone.
10. `ingest.mjs`: contract validation, row validation, report, transaction. Check: `decisions-ingest.test.mjs` against `tests/fixtures/decisions/tiny`.
11. Routes for workspaces, import (path and picker), report, customers. Export `showDialog`/`FOLDER_DIALOG` from `api.mjs`. Check: import the tiny fixture from the shell; report shows defects; Customers lists 5.
12. CSV templates and the "download templates" route. Check: files appear in Downloads with headers.

**Phase 2**
13. `synthetic.mjs` with the scenario table in 17.2, seeded PRNG, `scenarios.json`. Check: two runs with seed 7 produce identical bytes.
14. `scripts/write-decisions-fixtures.mjs` writes `demo`, `demo-cohort`, `edge`. Commit the fixtures. Check: `git status` shows only fixture files; `scan:secrets` clean.
15. `decisionsSeedDemo` route and `decisions seed`. Check: onboarding "Load the demo company" ends on Customers with 48 accounts.

**Phase 3**
16. `rules.mjs` + `rules.json` signals block. Check: loading validates; a malformed rules file fails loudly with the key named.
17. `signals.mjs`: eleven signals, cohort, `unreliable` flag. Check: `decisions-signals.test.mjs`, every boundary in 20.1.
18. Self-check: run signals over `demo`; every planted account shows its expected bands. Check: the second half of `decisions-synthetic.test.mjs`.
18a. Lifecycle label and `tenure_days` into `account_run_state` (section 11.5). Check: every demo scenario carries the expected label; a label never contradicts the signals beneath it (unit test over the table in 11.5).

**Phase 4**
19. `situations.mjs`: rules, watches, score, severity, priority, impact. Check: `decisions-situations.test.mjs`; `demo` -> 13 situations, 4 watches; `demo-cohort` -> 1 cohort.
20. `decisionsRules` route (for Settings). Check: returns thresholds with the editable ones marked.

**Phase 5**
21. `packet.mjs` (pseudonymise, hash, numbers, `tenure_days`, `business_context`, prior outcomes). Check: `decisions-packet.test.mjs`, including that a number typed into the business-context note does not widen the grounding set.
22. `prompts.mjs` v1 and `schema.mjs`. Check: `decisions-schema.test.mjs` incl. the number-grounding cases.
23. `reason.mjs` with retry, rule_only, `llm_call`, injectable `complete`. Check: recorded-response fixtures cover valid, invalid-then-valid, twice-invalid, thrown.
24. Live: `decisions-reason.test.mjs` with a provider key configured. Record the served model and validity rate in `docs/decisions/how-it-works.md`.
25. Re-run the `response_format` probe (27.1). If first-attempt validity improves by 20 points or more, add `responseFormat` to `GatewayClient.chat` and pass it from `reason.mjs`; otherwise write "measured no benefit" in how-it-works.

**Phase 6**
26. `decisions.mjs`: upsert/dedupe rules from 13.4, transitions from 13.3, events, outcomes, notes, reopen. Check: `decisions-lifecycle.test.mjs`.
27. `run.mjs`: end to end with progress, budget, single-flight, run row. Check: `decisions-run.test.mjs`.
28. Routes: run, run status, overview, list, get, update, snooze, dismiss, resolve, reopen, note, re-reason, activity. Check: `decisions-routes.test.mjs` (names) and manual calls.
29. `omni-agent decisions run`. Check: prints the run summary; second run reports cached.

**Phase 7**
30. Shell: sidebar, top bar, router, helpers, skeletons, banners, modal, toasts.
31. Onboarding (16.1) with both data paths. Check: both reach Today.
32. Today (16.2) with stat strip, sections, progress card, all three states (`?state=empty|loading|error` debug query).
33. Decisions list (16.3) with filters and sort.
34. Detail (16.4): nine sections with kind chips, rail with transitions, Snooze/Dismiss/Resolve dialogs, notes, re-reason, "Signals eased" chip.
35. Customers (16.5) list and detail incl. Watching and stale-data tag.
36. Activity (16.6) with filter.
37. Settings (16.7) all sections; delete with typed confirmation.
38. Global states (16.8). Check: stop the gateway, Today shows the banner, a run produces rule_only decisions.
39. Keyboard and reduced-motion pass; narrow-window pass at 880 px.

**Phase 8**
40. `followup.mjs` tick with injected clock; start/stop in `launch.mjs`. Check: `decisions-followup.test.mjs`.
41. Settings routes incl. demo mode and clock advance (refused outside demo mode). Check: the two scenarios in Phase 8 "Verify".
42. Overdue and waiting buckets on Today; "You have not handled this yet" on cards and detail.

**Phase 9**
43. `actions.mjs`: draft email (model, grounded, template fallback), task, and the 14-day outreach conflict guard (section 14.4). Check: `decisions-actions.test.mjs`, including a second draft for the same account being refused with the first one named.
44. Dialogs: Draft email (edit, Copy, Open in my mail app via `mailto:`, Mark as sent, Discard), Create task. Check: the mail client opens with subject and body; actions appear under Actions taken and Activity.

**Phase 10**
45. `run-eval.mjs` with `--recorded` and `--live`, metrics from 21.2, JSON report. Check: `npm run test:eval -- --recorded` passes in CI.
46. `decisions-ui.test.mjs` Playwright flow from 20.2. Check: passes locally.
47. Live eval on `demo`, `demo-cohort`, `edge`, three runs each, with a provider key; commit `results/report.json`. Check: targets in section 22, misses documented.
48. Three-person evaluation from 21.3; write the observations into `docs/decisions/limitations.md` and the confusions into a follow-up list.

**Phase 11**
49. Write `docs/decisions/*` from the outline in section 26; every feature page follows the twelve headings.
50. README and desktop-app doc updates; release notes; bump version; `npm run build:installer` and the pre-push gate (`npm test`, `npm run test:integration`, `npm run scan:secrets`).

---

## 26. "How to use the MVP" documentation outline

Written for a normal user. No AI terminology without a one-line explanation. Every feature
page uses the same twelve headings: What it does · Why it exists · How to use it · What it
needs · What it produces · What the AI is doing · What to expect · Common errors · How to
fix them · Example · Limits · Privacy.

```
docs/decisions/
  README.md              what Decisions is in five sentences; the loop diagram in words; where to start
  getting-started.md     Install -> open Decisions -> name a workspace -> load the demo or import a folder
                         -> run the first analysis -> read one decision -> handle it -> see the reminder
                         -> record the outcome. Screenshots at each step. Under 15 minutes.
  how-it-works.md        the six steps (data, signals, situations, reasoning, decision, follow-up),
                         what is computed by rules and what the model writes, the measured model behaviour
                         (validity rate, model used), what "confidence" means here
  today.md               the Today screen: the five tiles, the sections, sorting, the Run button, the progress card
  decisions.md           the list: filters, statuses explained in one line each, what "age" and "due" mean
  decision-detail.md     the nine sections and the four kinds of statement (Observed fact, AI interpretation,
                         Hypothesis, Recommendation); the rail; snooze, dismiss and resolve rules; reopen
  customers.md           the customer page; "Watching" and why one signal is not a decision; stale data
  activity.md            reading the log; system vs you
  settings.md            every setting, its default, and what changes when you change it; thresholds explained
                         with the demo company as the example
  actions.md             Draft email (nothing is sent; how to open it in your mail app; editing) and Create task
  importing-data.md      the five files, every column, date and number formats, where to get each file from
                         Stripe / HubSpot / a help desk / a product database, the import report, re-importing
  demo-company.md        what the 48 made-up customers are, the planted situations, the cohort variant,
                         advancing the clock
  troubleshooting.md     "No decisions after a run", "AI explanation unavailable", "The model gateway is not
                         answering", "Import rejected my file", "The same decision keeps coming back",
                         "Numbers look wrong" (stale data, as_of), "It is slow" (free models; add a key),
                         where the logs are, what to send in a bug report
  privacy.md             what leaves your machine (the pseudonymised fact sheet, only when you run an analysis
                         or draft an email), what never does, how to delete everything, the setting that
                         sends real names and why it is off
  limitations.md         honest list: CSV only, in-app reminders only, two actions, no external context,
                         rules are fixed thresholds, the model can be wrong and how to tell
```

---

## 27. Risks and technical unknowns

### 27.1 Structured output on the free pool (measured, partially)

`GatewayClient.chat` does not send `response_format`. A probe script
(`scratchpad/gwprobe.mjs`, written during this planning session) sends one classification
prompt to `auto/smart` and `auto/cheap`, with and without `response_format:
{type:"json_object"}`, and checks whether the reply parses. **It could not run: the
bundled gateway was not running on this machine during planning** (`GET
127.0.0.1:20129/api/monitoring/health` refused the connection), and starting it only for
the probe was not done. So whether OmniRoute passes `response_format` through to the
free upstreams, and whether those upstreams honour it, is **unmeasured**. The design does
not depend on the answer: the validator, the retry, the rule-only fallback and the
per-run failure budget exist so the product works either way. Checklist item 25 runs the
probe with the gateway up and a provider key configured, and records the result in
`docs/decisions/how-it-works.md`. The probe script itself is twenty lines; rewrite it in
`scripts/probe-json-mode.mjs` so the measurement is repeatable.

### 27.2 Model quality on a keyless install

Six working keyless models, mostly non-reasoning (dev-log `omni-agent-free-model-pool`).
Expect a low first-attempt validity rate and slow runs without a key. Mitigations: the
rule-only path; the run budget; a banner recommending a free-tier key with a link to
Free capacity; the evaluation is run with a key and says so.

### 27.3 The rules are the product's judgement

Thresholds were chosen, not measured against real churn. The synthetic data is built from
the same assumptions, so the benchmark proves internal consistency and false-positive
discipline, not real-world calibration. Section 28 makes real data the first validation
step before expanding.

### 27.4 Demo-mode clock

`as_of` drives everything. A workspace left in demo mode with a pinned clock will show
"today" as the wrong day; the banner in 16.8 exists for this. Real workspaces never pin
the clock.

### 27.5 SQLite and concurrency

One process, one writer. A second copy of the app is already refused by the instance
lock. `omni-agent decisions run` from a terminal while the app is open would be a second
writer: WAL mode makes it safe, and the run uses a `meta.run_lock` row with a timestamp so
two runs cannot overlap.

### 27.6 Node version

`node:sqlite` is available without a flag on the bundled 24.18.0 and in CI (Node 24).
`engines` still says `>=22.12.0`; on 22.12 `node:sqlite` needs `--experimental-sqlite`.
Either bump `engines` to `>=22.13.0` (where it is unflagged) or state it in
`docs/development.md`. Recommendation: bump `engines`, since the installer ships 24.

### 27.7 Scope creep

The brief lists ten integrations, external intelligence and autonomous actions as
eventual. Every one is in BUILD LATER or DO NOT BUILD. A phase that adds one is out of
scope until section 28 is satisfied.

---

## 28. What to validate before expanding

Before any integration, any external-context feature, or any scheduled headless run:

1. The section 22 targets are met on the live evaluation, with the report committed.
2. One real company's export (the five CSVs from real systems, anonymised if needed) has
   been imported and run, and the person who owns those accounts has reviewed every
   decision: which were right, which were noise, which were missed. Their per-decision
   verdicts are recorded (a "Was this useful?" yes/no on the detail page is a five-line
   addition worth making in Phase 11).
3. At least one decision has gone through the full loop on real data: accepted, actioned,
   waited, resolved with an outcome, over real days.
4. The thresholds have been adjusted once from that review, and the change is recorded.
5. Cost per run on the real dataset is within the section 22 budget or the cap has been
   tuned.
6. The three-person study's confusions have been fixed or written into limitations.

Only then: Stripe test-mode connector (payments and MRR into `invoice` and `account.arr`),
then a Windows task for daily headless runs, then the external-context step for
`cohort_shift` as specified in section 18.

---

## 29. BUILD NOW / BUILD LATER / DO NOT BUILD

### BUILD NOW

- Workspace with one SQLite file; create, delete.
- CSV folder import with contract validation and a report; templates.
- Synthetic company generator with the ten planted scenarios and the cohort variant.
- Eleven deterministic signals with declarative thresholds; stale-data handling.
- Four situation kinds, the single-signal watch rule, cohort detection, deterministic
  severity, priority and impact.
- One model call per candidate through `complete()`, pseudonymised packet, zod schema,
  grounding checks, one retry, rule-only fallback, per-run budget, packet-hash cache.
- Decision upsert with dedupe, escalation, dismissed suppression, "signals eased" note.
- Full lifecycle with transitions, owner, due date, snooze, dismiss with reason, resolve
  with outcome, reopen, notes, append-only history.
- Follow-up tick: snooze expiry, overdue reminders, waiting nudges; demo clock.
- Two actions: Draft email (to the user's mail app) and Create task.
- The seven screens with empty, loading and error states; the four kind chips.
- CLI: open, run, seed, eval.
- Unit, integration, failure and UI tests; the evaluation harness with a committed
  report; the three-person study.
- The user manual and Getting Started.

### BUILD LATER

- Per-action automation toggle ("automate this play once you trust it"), Shiplog-style,
  only after the human-approved version has real outcomes recorded.
- A weekly digest written to a markdown file (and later Slack), the nearest sane
  equivalent of Cobi's "Stories".
- Stripe test-mode connector; then HubSpot or a product-events CSV upload on a schedule.
- Windows Scheduled Task for daily headless runs ("even when closed").
- External context for `cohort_shift` (section 18), with the constraints written there.
- Renewal-prep decisions for healthy accounts nearing renewal.
- A cheap-model triage step if candidates per run exceed the cap regularly.
- Windows toast notifications for overdue decisions (PowerShell `BurntToast`-free
  approach via `[Windows.UI.Notifications]`), and a Telegram hook.
- Editable thresholds for every signal; per-segment thresholds.
- Decision CSV export; weekly digest markdown.
- "Was this useful?" feedback on each decision, feeding a calibration table.
- A second owner-facing view for the person who is assigned decisions.
- Multi-workspace switching in the sidebar.

### DO NOT BUILD

- Any chat interface, primary or secondary. That includes Cobi's whole shipped core: a
  plain-English question box over the data, saved charts and dashboards, a Slack bot, an
  embeddable widget, and per-question quotas.
- Consumer offer recommendations, shops, loyalty or student-discount data models (Cobi's
  Data and Recommendations APIs). Different product, different buyer.
- Autonomous actions of any kind; anything that sends, posts or writes to an external
  system without a click.
- A CRM, CDP, warehouse or replacement for any source system.
- Charts, dashboards of metrics, trend explorers.
- Forecasting, ML churn models, embeddings, fine-tuning, training.
- Multi-user accounts, roles, sharing, cloud sync.
- More than the two actions, more than the four situation kinds, more than the eleven
  signals, in the MVP.
- Anything that lets the model produce a number, a money figure, a severity that
  overrides the rules, or a decision without evidence ids.

---

## 30. Final recommendation

Build it as a second surface inside Omni Agent, in the order of section 23, with the
demo company as the only data source and the rules engine as the thing that decides what
the model is allowed to see. The smallest version worth showing to another person is the
end of Phase 8: demo data in, five decisions out, handle one, advance the clock, see the
reminder, resolve it with an outcome. The smallest version worth calling validated is the
end of Phase 10, with the live evaluation report committed and three people having used it
without help. Expand only after section 28.

The thing most likely to go wrong is the model layer on a keyless install. The design
already tolerates that: every decision exists from the rules first, and the model only
adds the words. If the words are missing, the product still says what is happening and
what the money is; it just cannot yet say why.

---

# Appendix A: the Opus execution specification

*Self-contained. Everything needed to implement without reading the rest of this
document, though the rest is the reference.*

## A.1 Product objective

Add **Decisions** to Omni Agent: a local workspace that reads customer-data CSVs, finds
situations with deterministic rules, has a model explain and recommend for the top ones,
and keeps each resulting decision alive (owner, due date, reminders, history, outcome)
until a person resolves it. Prove that software can turn existing data into decisions a
person understands and acts on, cheaply.

## A.2 MVP scope

Sections 8 (features) and 9 (non-goals) verbatim. Four situation kinds, eleven signals,
two actions, seven screens, one data path (CSV folder), one demo generator, one model
call per situation, in-app reminders only.

## A.3 Architecture

- Same process, same UI server (`src/ui/server.mjs`), same per-launch token, same CSP.
- Server module `src/decisions/` (file list in 24.2). Routes in
  `src/decisions/routes.mjs`, merged into the dispatcher in `server.mjs`.
- Client: `src/ui/public/decisions/{index.html, decisions.js, decisions.css}`, importing
  `../app.css`. Hash router. DOM building only, `textContent` for model text.
- Storage: `node:sqlite`, one file per workspace under `PATHS.decisions`, schema in 10.3,
  migrations in `db.mjs`.
- Model: only through `complete()` in `src/routing/execute.mjs`, tasks `decision-brief`
  and `decision-draft`; `complete` is injectable for tests.
- Rules: `config/decisions/rules.json`.
- Scheduling: `followup.mjs` tick every 5 minutes in-app, started from `launch.mjs`.
- CLI: `omni-agent decisions open|run|seed|eval` in `bin/omni-agent.mjs`.

## A.4 Data model

Section 10.3 SQL verbatim. Import contract in 10.2.

## A.5 User flows

Section 7 (journey and confusion table) and section 16 (screens).

## A.6 UI specification

Sections 15 and 16. Severity colours map to the existing `--bad`, `--warn`, `--ink-faint`.
Kind chips: Observed fact, AI interpretation, Hypothesis, Recommendation. Decision card
layout in 15.3. No charts, no icons beyond the existing glyph style, no CDN.

## A.7 LLM architecture

Section 12: packet (12.2), system prompt (12.3), zod schema and grounding checks (12.4),
retry and rule-only fallback and budget (12.5), constraints (12.6), routing (12.7), draft
email (12.8). Prompt version constant; bumping it invalidates the packet cache.

## A.8 APIs

All routes take `{body, query}` and return `{ok:true, ...}` or `{ok:false, error}`.

| Route | Method | Input | Output |
|---|---|---|---|
| `decisionsStatus` | GET | | `{workspace, lastRun, running, modelMode, gatewayUp}` |
| `decisionsWorkspaces` | GET | | `{workspaces:[...], selected}` |
| `decisionsWorkspaceCreate` | POST | `{name}` | `{workspace}` |
| `decisionsWorkspaceSelect` | POST | `{id}` | `{workspace}` |
| `decisionsWorkspaceDelete` | POST | `{id, confirmName}` | `{deleted}` |
| `decisionsImportPick` | POST | | folder picker -> `decisionsImport` |
| `decisionsImport` | POST | `{path}` | `{report}` |
| `decisionsImportReport` | GET | | `{report}` (last) |
| `decisionsTemplates` | POST | | `{paths:[...]}` written to Downloads |
| `decisionsSeedDemo` | POST | `{variant: "demo"|"demo-cohort"|"edge"}` | `{report}` |
| `decisionsRun` | POST | | `{runId}` (202-style; poll status) |
| `decisionsRunStatus` | GET | `?id` | `{run, progress}` |
| `decisionsOverview` | GET | | `{tiles, sections:{attention:[], overdue:[], waiting:[], snoozed:[], resolved:[]}, lastRun}` |
| `decisionsList` | GET | `?status&severity&owner&kind&sort` | `{decisions:[card rows]}` |
| `decisionsGet` | GET | `?id` | `{decision, evidence, signals, hypotheses, events, actions, outcome, account, prior}` |
| `decisionsUpdate` | POST | `{id, status?, owner?, dueAt?}` | `{decision}` or `{ok:false, error, allowed:[...]}` |
| `decisionsSnooze` | POST | `{id, until}` | `{decision}` |
| `decisionsDismiss` | POST | `{id, reason}` | `{decision}` |
| `decisionsResolve` | POST | `{id, result, note, arrAfter?}` | `{decision, outcome}` |
| `decisionsReopen` | POST | `{id}` | `{decision}` |
| `decisionsNote` | POST | `{id, text}` | `{event}` |
| `decisionsRereason` | POST | `{id}` | `{decision}` |
| `decisionsActionPrepare` | POST | `{id, kind, task?:{title, owner, dueAt, note}}` | `{action}` |
| `decisionsActionUpdate` | POST | `{actionId, status, payload?}` | `{action}` |
| `decisionsCustomers` | GET | `?q&sort` | `{customers:[...]}` |
| `decisionsCustomer` | GET | `?id` | `{account, contacts, signals, watching, decisions, data}` |
| `decisionsActivity` | GET | `?filter&before&limit` | `{entries:[...], next}` |
| `decisionsRules` | GET | | `{signals, situations, editable}` |
| `decisionsSettingsGet` / `decisionsSettingsSet` | GET / POST | settings object | `{settings}` |
| `decisionsClockAdvance` | POST | `{days}` | `{asOf}`; refused unless demo mode |

## A.9 Implementation phases

Section 23, in order, with the checks listed there.

## A.10 Testing requirements

Section 20. `npm test` must stay hermetic. The recorded-response fixtures are the unit
suite's model. The eval harness runs `--recorded` in CI and `--live` before release.

## A.11 Acceptance criteria

- Every phase's "Verify" line in section 23 passes.
- Section 22 targets are met on the live evaluation, or each miss is written into
  `tests/eval/decisions/results/report.json` and `docs/decisions/limitations.md`.
- The demo flow in section 7 can be completed by a person who has read only
  `docs/decisions/getting-started.md`.
- `npm test`, `npm run test:integration`, `npm run scan:secrets`, `npm run build:installer`
  pass (the existing pre-push gate).
- No existing Omni Agent behaviour changes except the added nav link and CLI command.

## A.12 Documentation requirements

Section 26. Every feature page has the twelve headings. Written for a non-technical
reader; code, paths and error text kept exact.

## A.13 Explicit non-goals

Section 9 and the DO NOT BUILD list in section 29.

## A.14 Ordered checklist

Section 25, items 1 to 50.

## A.15 House rules inherited from the repository (read `docs/development.md`)

- Never state a number the data did not give you; `null` with a reason beats a guess.
- A check that passes on a broken system is worse than no check; every "Verify" is a real
  run.
- Measure, then claim; write the measurement into the code comment where the design
  depends on it.
- Plain ESM, no build step, no new frameworks, no CDN, tool descriptions and prompts are
  budget.
- Comments say why, not what, and record the bug they prevent.
