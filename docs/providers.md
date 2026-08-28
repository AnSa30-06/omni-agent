# Providers

Three independent provider layers: **models**, **search**, **scraping**. Each is pluggable,
each has a working default that needs no credential.

---

## Model providers

You reach models through the **gateway**, not directly. The gateway holds the credentials,
publishes the catalogue, and does the routing and fallback.

### It works with no API key

The gateway serves free, no-credential upstreams out of the box. Measured on a fresh
install: **115 models, 100 of them tool-capable**, and a real completion succeeds with zero
credentials configured.

The trade-off is speed and reliability. The free pool is slow (57 s for a short reply was
observed) and rate-limits under load — which is exactly why the fallback chain exists. Add
one paid key and both problems disappear.

### Adding a key

During setup, or later:

```bash
omni-agent config key deepseek sk-...
```

`anthropic` · `openai` · `google` · `deepseek` · `moonshot` · `openrouter`

Keys are stored encrypted (see [security.md](security.md)). To connect an upstream to the
gateway itself — which is what makes its models appear in the catalogue — open the gateway
dashboard at `http://127.0.0.1:20129` and add the connection there.

---

## What each provider publishes about your account

This table is the reason the usage dashboard looks the way it does. **Where a provider
publishes nothing, the dashboard says "unavailable" and why. It never estimates.**

| Provider | Endpoint | What you get | With a normal key? |
|---|---|---|---|
| **DeepSeek** | `GET /user/balance` | Money balance: total, granted, topped-up, currency | **Yes** |
| **OpenRouter** | `GET /api/v1/key` | Credits used, limit, remaining, free-tier flag, rate limit | **Yes** |
| **Moonshot / Kimi** | `GET /v1/users/me/balance` | Money balance in CNY | **Yes** |
| **Anthropic** | `GET /v1/organizations/usage_report/messages` | Token usage | **No — needs an Admin key** (`sk-ant-admin-…`) |
| **OpenAI** | `GET /v1/organization/costs` | Money spend | **No — needs an Admin key** |
| **Google (Gemini)** | *none* | — | **No API exists** |
| **Gateway free tier** | `GET /api/free-tier/summary` | Monthly token allowance | Needs a management-scoped gateway key (setup creates one) |

Notes that matter:

- **DeepSeek reports money, not tokens.** The dashboard says "Balance: 110.00 CNY", not a
  token allowance, because that is what the API returns.
- **OpenRouter's `limit: null` means "no spending limit set"**, not "zero remaining". The
  adapter distinguishes these; conflating them would show a full bar as empty.
- **Anthropic and OpenAI usage needs an *Admin* key**, which is a different credential from
  your API key. Add one with `omni-agent config key anthropic.admin sk-ant-admin-…` if you
  want those figures. Without it: "unavailable", with the reason and how to fix it.
- **Google publishes nothing** for Gemini API keys. Quota is visible only in AI Studio.

### Adding a provider adapter

Add an entry to `ADAPTERS` in
[`src/providers/usage-adapters.mjs`](../src/providers/usage-adapters.mjs). Implement only
the methods your provider actually supports:

```js
myprovider: {
  id: "myprovider",
  label: "My Provider",
  secretName: "provider.myprovider",
  envVar: "MYPROVIDER_API_KEY",
  docs: "https://...",
  async getBalance(key) {
    // Return exactly one of:
    //   { state: "live", kind: "money-balance"|"credit-usage"|"token-usage"|"money-spend", ..., fetchedAt }
    //   { state: "unavailable", reason, remedy }
    //   { state: "error", reason }
  },
}
```

**Do not invent a shape your provider does not report.** If it publishes nothing, return
`unavailable` with the reason. That is a correct, useful answer.

---

## Search providers

Tried in the configured order; the first with a usable credential wins, and the chain falls
through on failure.

| Provider | Credential | Notes |
|---|---|---|
| **Brave Search** | `BRAVE_SEARCH_API_KEY` | Free tier available. Good quality. |
| **Tavily** | `TAVILY_API_KEY` | Built for agents; returns cleaner content. |
| **Serper** | `SERPER_API_KEY` | Google results via API. |
| **DuckDuckGo** | *none* | First keyless option. HTML endpoint, sub-second. |
| **SearXNG** | *none* | Second keyless option, **independent index**. Public instances, or your own via `SEARXNG_INSTANCE`. |
| **Browser** | *none* | Last resort. Runs the query in the bundled Chromium. Slow but survives HTTP-level throttling. |

Three keyless providers, not one, and that is not belt-and-braces — it is the fix for a
failure that actually happened.

### Keyless search gets rate-limited, and the product now handles it

Measured during a research run: DuckDuckGo began returning an **empty page** to every
query from this machine part-way through. Empty is also how "nothing matched" looks, so the
agent read it as "no results", reworded the query, and searched again — which made it
worse.

Three changes came out of that:

1. **A politeness throttle.** Keyless providers are spaced 1.5–2.5 s apart. An agent fires
   five queries in as many seconds while exploring; that burst is what triggers the block. A
   couple of seconds per search is nothing next to a model turn.
2. **Throttling is reported as throttling.** An empty page now raises a distinct error, so
   the chain falls through to the next provider instead of the agent rewording forever. When
   *every* keyless provider is throttled the message says exactly that, and says that a
   search API key removes the limit.
3. **An independent second option.** SearXNG reaches results by a different path, so it does
   not fail at the same moment and for the same reason.

If you do a lot of research, configure one keyed provider. It is the single biggest
reliability improvement available, and Brave and Tavily both have free tiers.

> Mojeek was evaluated as the independent option and dropped: its search page is a 5 KB
> JavaScript shell over plain HTTP and carries no results without rendering.

Change the order:

```jsonc
// %LOCALAPPDATA%\OmniAgent\config.json
{ "search": { "order": ["tavily", "brave", "duckduckgo", "searxng", "browser"] } }
```

The DuckDuckGo parser drops paid placements (`result--ad`) and the engine's own redirector
links, so what comes back is organic results with real destination URLs.

Results are always labelled `kind: "search-snippets"`. The skills instruct the agent that a
snippet is a lead, not evidence, and that it must fetch before quoting.

---

## Scraping providers

| Provider | Credential | When it is used |
|---|---|---|
| **builtin** | none | Default. HTTP + Readability. Sub-second. |
| **browser** | none | Escalation when a page needs JavaScript. |
| **Firecrawl** | `FIRECRAWL_API_KEY` | Only if you configure it. |

The architecture permits more; **none are installed by default**, deliberately. Bright Data,
Apify and similar are excellent for large commercial crawls and are the wrong default for a
desktop agent: they need an account, they cost money per request, and the builtin path plus
a real browser already covers what a personal agent does.

To add one, implement a branch in `scrapeUrl()` in
[`src/tools/web.mjs`](../src/tools/web.mjs) and add its id to `config.scrape.order`.

---

## Model catalogue and metadata

**No model id is hardcoded anywhere in this repository.** The catalogue is read live from
the gateway's `/v1/models` on a 5-minute TTL, so a new model upstream appears without a code
change and a retired one disappears instead of 404-ing at call time.

Local metadata in [`config/models/metadata.json`](../config/models/metadata.json) adds
capability and speed tiers. Two things about it:

- It is keyed on model **family** by regex (`opus`, `sonnet`, `gemini.*flash`, …), not exact
  versions, so a point release inherits sensible defaults.
- Combos are tiered from their own naming scheme (`auto/best-*` → elite, `auto/pro-*` →
  very-strong, `:cheap` → medium), so the table does not have to be exhaustive. Before that,
  55 of the gateway's combos had no tier at all.

`capability_tier` is a **local editorial estimate**, and the file says so in a `disclaimer`
field. It is not a benchmark score and this product never presents it as one. An unfamiliar
model gets `tierSource: "unknown"` rather than being guessed into a tier.

## Adding free capacity

`omni-agent provider` lists providers with a genuine free tier. Every id in
`config/providers/free.json` is verified to exist in the gateway's own provider
manifest (`GET /api/v1/provider-plugin-manifest`, 222 providers), and base URLs
and auth mechanics are read from that manifest rather than hardcoded — so the
catalogue cannot drift from what the gateway actually supports.

Signup links are checked, not trusted:

```bash
node scripts/check-provider-links.mjs
```

It caught one on the first run — `console.mistral.ai` "did not resolve", so
Mistral was dropped rather than shipped as a dead link. **That verdict was wrong
and was reversed on 2026-08-28.** The host is alive and answers `302`; signed
out it redirects `console.mistral.ai` → `auth.mistral.ai` →
`v2.auth.mistral.ai` → back again with a fresh flow id every time, which a
cookie-less client can never settle. `fetch()` gives up after 20 hops and
reports a bare `fetch failed`, which reads exactly like a dead host. The checker
now recognises a redirect loop and marks it `warn` — a login wall, not a 404 —
and Mistral is back in the catalogue.

**Three different routes in, and they are not the same thing.**

| Route | What it creates | Where the credential lives |
|---|---|---|
| Paste a free API key | a gateway provider connection | the gateway |
| Sign in (OAuth, 22 providers) | a gateway provider connection | the gateway |
| Web-search key | nothing in the gateway | this product's encrypted local store |

A connection test distinguishes "your credential is wrong" from "their server is
down" using the gateway's own diagnosis, because the remedy is completely
different. Telling someone to check a key they never entered is worse than
saying nothing.

OAuth returns a URL for the user to open. This program does not click through a
consent screen on anyone's behalf.

## Adding one of the free providers yourself

`omni-agent provider list` shows a **curated** set. The gateway itself knows
**222**, so anything in its manifest can be added by id whether or not it is in
that list:

```bash
omni-agent provider add <id> YOUR-KEY
```

The base URL and auth mechanics come from the gateway's manifest, so an id it
does not know fails by name (`the gateway does not know a provider called "x"`)
rather than half-working. To see every id it will accept:

```bash
curl http://127.0.0.1:20129/api/v1/provider-plugin-manifest
```

That endpoint needs no authentication. Ids measured there on 2026-08-28 for the
providers people ask about most: `mistral` · `cerebras` · `groq` · `cohere` ·
`together` · `sambanova` · `scaleway` · `nebius` · `novita` · `deepinfra` ·
`hyperbolic` · `llm7` · `nara` · `openrouter`.

### Worked example: Mistral

```bash
omni-agent provider setup mistral      # the steps, without leaving the terminal
```

1. Open <https://console.mistral.ai/> and sign in. Signed out it redirects
   through `auth.mistral.ai` first — that is their login flow, not a broken
   link.
2. Read their plan page before picking one. Mistral's free tier has changed more
   than once; **their page is the authority**, not this one.
3. Create a key under **API Keys** in the console's left-hand menu.
4. `omni-agent provider add mistral YOUR-KEY`

The command creates a **gateway provider connection**, then asks the gateway to
make a real call against it and reports the verdict — so a bad key is caught
there and then rather than on your next message. Its models then appear in the
app's model picker under **From your keys**, prefixed `mistral/`.

The same four steps are the whole procedure for `cerebras`, `groq`, `cohere` and
the rest; only the console differs.

### Which models did my key actually give me?

The picker has three lenses — **All**, **Free**, **From your keys**. They split
on the gateway's own connection list, **not on price**, because a free-tier key
costs nothing per token: splitting on price filed the models you had just paid
an account for under "Free" and left the lens you opened it for empty.

A model id's first segment is the provider's **alias**, and 109 of the 222
providers publish an alias that differs from their id — `duckduckgo-web` serves
`ddgw/…`, `opencode` serves `oc/…`. Measured against what the gateway was
actually serving on 2026-08-28: of ten distinct prefixes, **eight matched a
manifest alias, one matched an id, and one was `auto`** (the gateway's own
routing combos, not a provider at all). Matching on the id alone would have
identified one of nine.

### Not every provider in the manifest still exists

**GitHub Models was going to be added here on 2026-08-28 and was not.** It is
retired: `https://models.github.ai/inference/chat/completions` answers

```
HTTP 410  {"error":{"code":"github_models_retirement_brownout", ...}}
```

and GitHub's own documentation says the playground, catalogue, inference API and
BYOK were fully retired on **2026-07-30**. The gateway's manifest still carries
`github-models` (alias `ghm`), and the dashboard's Free-tiers page still
advertises it. **Being in the manifest is not evidence that a provider works.**

GitHub *Copilot* is a different product and is still live — it is the `github`
OAuth entry, `omni-agent provider signin github`, and it needs a paid seat.

## About that "1.6 billion tokens a month"

**Where to sign up, in what order, and what each one is worth is its own
document: [free-tiers.md](free-tiers.md).** What follows is what the number
means.

It is **per month, not per day** — an earlier version of this page said "a day"
and that was wrong. The gateway's own **Free-token budget** widget reports
**1,526,225,000 steady per month**, and **2,152,725,000 in the first month**
with one-time signup credits included.

**It is a sum over ~40 separate accounts you would have to open yourself.** It
is not a pool, and nothing hands you any part of it. Each row is one signup, one
key, one `omni-agent provider add`. **Two thirds of it is Mistral alone**, and
six signups reach 93% of it.

The figures come from `GET /api/free-tier/summary` — **there is an API, contrary
to what this page said before**; the guesses that 404'd (`/api/free-tiers`,
`/api/providers/free-tiers`, `/api/provider-limits`) were simply the wrong
paths. Its method is honest: summing its per-model rows naively gives 6.86 B,
and deduplicating by `poolKey` reproduces the published 1,526,225,000 exactly.

⚠️ **The catalogue behind it is dated 2026-07-22 and has already rotted** — it
still counts 18 M/month of GitHub Models, retired on 2026-07-30.

**The per-provider numbers are the providers' own claims.** Two were already
stale when checked on 2026-08-27: Cerebras was listed at "1M tokens/day" and its
own pricing page said free *credits*; Brave at "2,000 searches a month" against
its own page's "$5 monthly credit". This product therefore shows what **kind**
of thing a provider gives and links to their page, and never restates their
numbers.

**The blocking you are seeing is a different thing entirely.** With no keys, the
gateway routes through shared, unauthenticated endpoints — everyone using them
arrives from the same handful of egress IPs. Measured 2026-08-28 on this
machine, `connections: 0`, one short completion per upstream:

| Upstream | Result |
|---|---|
| `oc/hy3-free` | **200** — answered in 2.4 s |
| `oc/big-pickle` | 429 rate limit exceeded |
| `ddgw/gpt-5.4-mini` | 418 anti-abuse challenge failed, "retry from a less rate-limited IP" |
| `aug/sonnet4.6` | 502 stream ended before a non-ping event |
| `pepper/pepper-1` | 502 fetch failed |
| `felo/felo-chat` | 400 thread creation failed |
| `tllm/GPT_5_4` | 403 "blocked by Vercel for this server egress IP" |
| `mcode/mimo-auto` | 400 unsupported model |

One of eight. **Not one of those is a quota you exhausted** — they are
anti-abuse, shared-IP blocks and upstream faults on endpoints nobody
authenticated to. The agent still works, because the router falls back until
something answers; it is slow because it is doing that.

**A key is what changes it, and it changes it for a reason that has nothing to
do with the token count.** Your own credential moves you off the shared pool
onto your own authenticated rate limit, which is why the 418s and 403s stop.
Four or five keys is where the returns flatten — enough that a failure has
somewhere to fall back to. Forty is a chore that buys very little over five.

**Which five, and where to get them: [free-tiers.md](free-tiers.md).**

## What the gateway does NOT provide

**Web search.** OmniRoute has no search API — its "search tools" are
search-grounded *model* providers. On a keyless install all four
(`felo/felo-search`, `pol/perplexity-fast`, `tllm/sonar-pro`,
`pol/gemini-search`) returned 400/401/403, so routing search through the gateway
is not available unless you connect a search-capable provider yourself. This
product's own search stack is what actually runs.

## Setting up a search provider

Search works with **no key at all** — DuckDuckGo, then Brave's public results
page, then public SearXNG instances, then the bundled browser. Those free
endpoints throttle a machine that searches in bursts, which is what an agent
doing research looks like. A key removes that.

Every provider carries step-by-step instructions:

```bash
omni-agent provider setup brave
```

Once a key is stored it is used **first**, automatically — there is no
configuration to edit. Verified: `availableProviders()` filters the default
order by which credentials exist, and the keyed providers sit ahead of the
keyless ones.

| Provider | Where | What the free tier is |
|---|---|---|
| **Brave** | <https://brave.com/search/api/> | $5 of credit every month, auto-applied, at $5 per 1,000 requests — so roughly 1,000 searches/month, renewing *(their pricing page, read 2026-08-27)* |
| **Tavily** | <https://app.tavily.com/> | A free monthly allowance; returns cleaned page content rather than links |
| **Serper** | <https://serper.dev/> | A **one-time** free grant of Google results — it does not renew |
| **Firecrawl** | <https://firecrawl.dev/> | A free allowance of page **scrapes**, not searches |

Brave is the one to add first: it is an independent index, so it does not fail
at the same moment and for the same reason as DuckDuckGo.

**Self-hosting SearXNG** removes almost all throttling without any account:

```powershell
setx SEARXNG_INSTANCE https://my-searxng.example.com
```

Then restart the agent.

Secrets are stored under the names the code actually reads — `search.brave`,
`search.tavily`, `search.serper`, `scrape.firecrawl` — or the matching
environment variables (`BRAVE_SEARCH_API_KEY` and so on). An earlier version of
the catalogue stored them under different names, which meant the key was saved
somewhere nothing looked.

