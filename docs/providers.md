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

Tried in the configured order; the first with a usable credential wins.

| Provider | Credential | Notes |
|---|---|---|
| **Brave Search** | `BRAVE_SEARCH_API_KEY` | Free tier available. Good quality. |
| **Tavily** | `TAVILY_API_KEY` | Built for agents; returns cleaner content. |
| **Serper** | `SERPER_API_KEY` | Google results via API. |
| **DuckDuckGo** | *none* | **The keyless default.** Always available. |

DuckDuckGo is last in the order and needs no account, which is what makes the product work
the moment it is installed. The parser drops paid placements (`result--ad`) and DuckDuckGo's
own redirector links, so what comes back is organic results with real destination URLs.

Change the order:

```jsonc
// %LOCALAPPDATA%\OmniAgent\config.json
{ "search": { "order": ["tavily", "brave", "duckduckgo"] } }
```

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
