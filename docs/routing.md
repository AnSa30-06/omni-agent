# Model routing

## The idea

Route on **useful work per unit of budget**, not on maximum intelligence. Sending a
title-generation call to an elite model is the easiest way to waste money and the slowest
way to get a title.

Two dimensions, and both have to bite:

- **What the task needs** — coding, hard reasoning, cheap classification, vision.
- **What the user asked for** — fast, balanced, smart, quality, cheap.

## Presets

| Preset | capability | speed | cost | context | Minimum tier |
|---|---|---|---|---|---|
| `fast` | 0.20 | 0.55 | 0.15 | 0.10 | medium |
| `balanced` | 0.45 | 0.25 | 0.20 | 0.10 | strong |
| `smart` | 0.65 | 0.15 | 0.10 | 0.10 | strong |
| `quality` | 0.85 | 0.03 | 0.02 | 0.10 | very-strong |
| `cheap` | 0.25 | 0.20 | 0.45 | 0.10 | medium |

```
score = w.capability * capabilityScore
      + w.speed      * speedScore
      + w.cost       * costScore
      + w.context    * contextFit
```

There is deliberately **no single universal weighting**.

```bash
omni-agent config mode smart
```

The preset governs **the agent's own model too**, not only the routing this product does
internally. Changing it rewrites `model` in the OpenCode config to the combo the preset
resolves to, and the command says so:

```
Routing mode set to Smart.
The agent will run on: auto/pro-coding
Restart the agent for this to take effect.
```

The restart line is not boilerplate — OpenCode reads its configuration at launch and does
not hot-reload it.

> Left unpinned, OpenCode picks a model itself — observed choosing `oc/big-pickle`, one
> specific free model — which meant the preset chosen during setup governed nothing the
> agent actually did.

## Intent × preset

Every internal task maps to an intent; the intent and the preset together choose a gateway
combo.

| task | intent |
|---|---|
| `classify`, `title`, `extract-simple`, `dedupe` | `cheap` |
| `summarise` | `fast` |
| `plan`, `reason`, `browser-plan`, `synthesise` | `smart` |
| `code` | `coding` |
| `chat` | `balanced` |

Then, for `intent = coding`:

| preset | combo |
|---|---|
| `quality` | `auto/best-coding` |
| `smart` | `auto/pro-coding` |
| `balanced` | `auto/coding` |
| `fast` | `auto/coding:fast` |
| `cheap` | `auto/coding:cheap` |

**Cheap tasks stay cheap even in `quality` mode.** `classify` routes to `auto/cheap` under
every preset. That is intentional, and it is where most of the saving comes from.

> A regression worth knowing about: keying combos on intent alone made all five presets
> resolve to `auto/best-coding` for `task=code`, silently disabling the mode selector.
> `tests/unit/routing.test.mjs` now asserts the five picks are distinct.

## Why combos come first

Selection prefers an OmniRoute `auto/*` combo over naming a vendor model. The gateway knows
which credentials are live, which upstreams are rate-limited, and which are free *right
now*. This client knows none of that, so delegating is strictly better informed.

Scoring concrete models is the fallback for when no combo fits, or when the user pins one.

## The three inputs, and where each comes from

### Capability — local estimate

From [`config/models/metadata.json`](../config/models/metadata.json), matched on model
family by regex. Combos are tiered from their naming scheme.

**This is an editorial estimate, not a benchmark**, and the file says so. An unfamiliar
model gets `null` and `tierSource: "unknown"` rather than being guessed into a tier.

### Speed — measured here, or an estimate that says so

No provider publishes tokens/sec. So the product measures it:
`output_tokens / latency` on every real call, written to local telemetry.

- **Two or more observations** → measured rate wins, scaled against 120 tok/s.
- **Fewer** → falls back to the editorial `speed_tier`.
- **None** → the UI prints "throughput not measured yet", never a number.

This matters: on the free pool, models editorially tiered "very-fast" measured **2.03
tok/s**. The measurement corrects the estimate.

### Cost — the gateway's published price, or unknown

From the gateway's `/api/pricing`, matched on **exact `provider/model`**.

The pricing table and the live catalogue occupy disjoint namespaces on a fresh install:
pricing covers credentialed upstreams (`openai`, `anthropic`, `deepseek`, `cc`, …), while
the zero-credential catalogue is served by free proxies (`ddgw`, `felo`, `aug`, `pepper`,
…). Overlap on `provider/model` is **exactly zero**.

Matching on bare model name would "find" 5 of 115 — and every one would be wrong. It would
stamp OpenAI's $1.50/$6.00 on `ddgw/gpt-5.4-mini`, a free proxy, and then rank routing
decisions on a cost nobody is paying.

**When cost is unknown the term is dropped and the remaining weights renormalised.** Not
scored `0` (which punishes every model equally and misranks), not `1` (which pretends it is
free). `cheap` mode then degrades gracefully to "fast and small".

## Fallback

`fallbackChain()` returns the primary choice followed by `auto/smart`, `auto/chat`,
`auto/fast`, `auto/best-free`.

**Fallback is not retry.** The HTTP layer already retries a 429 against the *same* model
with bounded exponential backoff and jitter — correct for a transient blip. Fallback walks
to a *different* model when an upstream is exhausted, which is the common case on the free
pool where retrying the same combo just waits out the same rate limit.

Switches model on: `402`, `403`, `429`, `500`, `502`, `503`, `504`, and hard timeouts.
Anything else is a caller error and fails immediately with every attempt listed.

When a fallback was used, the result carries `fellBackFrom`, and the health check says so.

## Overriding

```bash
omni-agent models              # what the gateway serves right now
omni-agent route               # what each task would get, and why
```

Or ask the agent: *"use the cheapest model"*, *"switch to maximum quality"*, *"pin
claude-opus"*. A pin that names a model the gateway does not serve **fails loudly** at
resolve time rather than falling back silently.

## Token-budget behaviour

- `small_model` is pointed at `auto/cheap`, so OpenCode's own title and summary generation
  uses the cheap path.
- `data_analyze` is deterministic and local — profiling a spreadsheet costs **zero tokens**.
- Search results are deduplicated (normalised URL, tracking params stripped) before they
  reach the model.
- Tool output is truncated with an explicit marker, so the model knows it has a prefix.
- `compaction.auto` is on with a 15-turn tail.
