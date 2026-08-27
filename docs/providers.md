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

It caught one on the first run: `console.mistral.ai` did not resolve, so Mistral
was dropped rather than shipped as a dead link.

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

