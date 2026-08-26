# Architecture

## The shape

```
                              You
                               |
                    bin/omni-agent.mjs
         launcher · setup wizard · health check · usage dashboard
                               |
                          OpenCode 1.18
                   agent harness, TUI, sessions, permissions
                               |
        +----------------------+---------------------------+
        |                                                  |
  Built-in tools                              plugin/index.mjs
  read write edit bash                      the Omni Agent tool layer
  glob grep list task                                      |
                          +---------+---------+---------+--+------+
                          |         |         |         |         |
                     web_search  web_fetch  web_scrape  browser  documents
                                                         |        + data
                                                    Playwright   + agent_status
                               |
                          OmniRoute 3.8
              model catalogue · routing combos · fallback · quotas
                               |
        Claude · GPT · Gemini · DeepSeek · Kimi · 100+ free models
```

## Composition, not forking

Neither OpenCode nor OmniRoute is modified. Everything is done through documented extension
points:

| Need | Mechanism |
|---|---|
| Custom tools | An OpenCode plugin exporting `tool: { ... }` |
| Model provider | OmniRoute's own first-party `@omniroute/opencode-plugin`, copied out of the npm package |
| Agents, permissions, skills | `opencode.json` and `skills/*/SKILL.md` |
| Instructions | `AGENTS.md`, loaded by `instructions:` |
| Model gateway lifecycle | A supervised child process |

**No modification to either upstream was necessary.** If that ever changes, the reason
belongs here.

## Isolation

Installing this must not disturb a user who already runs `opencode` or `omniroute`, and
uninstalling it must not take their setup with it. Three mechanisms:

| Thing | Default location | Ours |
|---|---|---|
| Gateway data | `~/.omniroute` | `%LOCALAPPDATA%\OmniAgent\gateway` (via `DATA_DIR`) |
| Gateway port | 20128 | 20129 |
| OpenCode config | `~/.config/opencode` | `%LOCALAPPDATA%\OmniAgent\opencode` (via `XDG_CONFIG_HOME`) |
| OpenCode data | `~/.local/share/opencode` | `%LOCALAPPDATA%\OmniAgent\oc-data\opencode` (via `XDG_DATA_HOME` **and** `OPENCODE_DATA_DIR`) |
| npm packages | global npm root | `<app>/runtime/node_modules` |

Two of these were found the hard way and are worth stating:

- **`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are honoured by OpenCode on Windows.** Verified
  with `opencode debug paths`.
- **The OmniRoute plugin does *not* read `XDG_DATA_HOME`.** It resolves `auth.json` from
  `OPENCODE_DATA_DIR`, falling back to a hardcoded `~/.local/share/opencode`. Without
  `OPENCODE_DATA_DIR` set it cannot see the credential, logs
  `config shim skipped: no apiKey`, and registers **no models at all**. Both variables are
  set in `opencodeEnv()`.

OpenCode also auto-scans `~/.claude/skills` and `~/.agents/skills`. On a machine that also
runs Claude Code, that pulls the user's entire personal skill library into this product.
`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` prevent it.

## Tool count is a budget

OpenCode's documentation warns that MCP tools consume model context and that too many make
models worse at choosing. Every tool description is spent on **every turn**.

So the entire browser — navigate, snapshot, click, type, select, check, hover, key, scroll,
upload, extract, screenshot, download, wait, back, forward, tabs, close: eighteen
operations — is **one** tool with an `action` argument.

Eight tools total:

| Tool | Covers |
|---|---|
| `web_search` | Search, across pluggable providers |
| `web_fetch` | One page, readable extraction |
| `web_scrape` | Page with render escalation, or site crawl |
| `browser` | All eighteen browser operations |
| `document_read` | PDF, DOCX, XLSX, CSV, JSON, TXT, MD |
| `document_write` | CSV, XLSX, JSON, MD, TXT |
| `data_analyze` | Tabular statistics, computed locally |
| `agent_status` | Model, routing, quota, usage; and changing them |

**No MCP servers are installed.** Everything is an in-process tool, which costs one
description each and no subprocess.

## Interaction by ref, not selector

The `browser` tool's `snapshot` action returns a numbered outline:

```
- textbox "Customer name:" [ref=e1]
- textbox "Telephone:" [ref=e2] type=tel
- radio "Medium" [ref=e5] value="medium" checked
- button "Submit order" [ref=e13]
```

Every other action targets an element by that ref. The model never guesses a CSS selector.

**Where the refs come from.** Playwright MCP uses `page._snapshotForAI()`. Measured on
`playwright-core@1.62.1`: that method **does not exist** in core, and the public
`ariaSnapshot({ ref: true })` silently ignores the ref option — its output is byte-identical
to `ariaSnapshot()` and carries no refs. So `domSnapshot()` in
[`src/tools/browser.mjs`](../src/tools/browser.mjs) walks the DOM once, stamps
`data-omni-ref` on every visible interactive element, and emits the outline itself.

Refs are invalidated by anything that changes the page. A stale ref fails with an
instruction to re-snapshot rather than silently hitting a different element.

### Playwright runs in its own process

OpenCode plugins execute inside OpenCode's embedded Bun. Playwright cannot reach Chromium
from there. Both of its transports fail at the same step, measured on Bun 1.3.14:

| Transport | What happens |
|---|---|
| `--remote-debugging-pipe` (the default) | Chromium starts, logs normally, `launch` times out after 180 s |
| `connectOverCDP(ws://…)` | Chromium starts and prints its DevTools URL; Playwright hangs at `<ws connecting>` |

The second one localises the fault. Spawning works, stdio works, Chromium works — what
fails is Playwright's WebSocket client completing an upgrade handshake in that runtime. The
same code launches in 6 s under Node and 10 s under a standalone Bun 1.4.0.

Plain HTTP from Bun has never been a problem — `web_fetch` and `web_search` run there — so
Playwright stays on the Node side of a loopback HTTP boundary:

```
  plugin (Bun)  --HTTP 127.0.0.1--> browser-host.mjs (Node) --> Playwright --> Chromium
```

[`browser-host.mjs`](../src/tools/browser-host.mjs) owns the browser and answers on a
random loopback port, with a per-process token and an explicit method allowlist — the
method name arrives over the wire, so it is never used to look something up on the module.
It shuts the browser down after fifteen idle minutes.
[`browser-proxy.mjs`](../src/tools/browser-proxy.mjs) picks the in-process or the forwarded
implementation from the runtime, so no caller has to know which side it is on.

> This bug survived a full suite of passing browser tests because every one of them drove
> `browser.mjs` directly, under Node — which is not how the product calls it.
> `tests/integration/browser-host.test.mjs` drives the wire instead.

## Escalation

Three strategies for getting a page, cheapest first:

1. **builtin** — HTTP + Readability + Turndown. Handles most of the web in well under a
   second.
2. **browser** — full Playwright render. For JavaScript shells.
3. **firecrawl** — a paid API, only if the user configured a key.

Escalation is triggered by `thin`: a small text yield **from a large HTML payload**. The
size test alone was wrong — `example.com` is a complete page with 149 characters of text and
was being sent to the browser every time, turning a 700 ms fetch into 8 s. A real SPA shell
is kilobytes of script around an empty root.

## Model routing

Two layers, in order:

1. **Delegate to an OmniRoute `auto/*` combo.** The gateway knows which credentials are
   live, which upstreams are rate-limited and which are free *right now*. This client knows
   none of that, so delegating is strictly better informed than choosing a vendor model
   here.
2. **Score concrete models** only when no combo fits.

Routing is genuinely two-dimensional — intent × preset:

| task=`code` | combo chosen |
|---|---|
| `quality` | `auto/best-coding` |
| `smart` | `auto/pro-coding` |
| `balanced` | `auto/coding` |
| `fast` | `auto/coding:fast` |
| `cheap` | `auto/coding:cheap` |

Keying on intent alone made every preset resolve to the same combo, which silently disabled
the mode selector. A unit test now asserts all five differ.

See [routing.md](routing.md).

## Fallback is not retry

`request()` already retries a 429 against the *same* model with backoff — right for a
transient blip. [`src/routing/execute.mjs`](../src/routing/execute.mjs) adds walking to a
*different* model when one upstream is exhausted, which is the common case on the free pool
where retrying the same combo just waits for the same rate limit.

Measured: the health check's model probe was failing with HTTP 429 against `auto/fast`;
routed through the fallback chain it answers in 5.8 s.

Statuses that switch model: 402, 403, 429, 500, 502, 503, 504, and hard timeouts.

## Honesty constraints in the design

Three places where the code is deliberately more restrictive than it could be:

**Pricing is exact-match only.** The gateway's pricing table and the live catalogue occupy
disjoint provider namespaces on a fresh install — pricing covers credentialed upstreams
(`openai`, `anthropic`, `deepseek`, …), the zero-credential catalogue is served by free
proxies (`ddgw`, `felo`, `aug`, …). Overlap on `provider/model` is exactly zero. Matching on
bare model name instead would "find" 5 of 115 — and every one would be wrong, stamping
OpenAI's $1.50/$6.00 on a free proxy and then ranking routing decisions on it.

**Unknown cost is `null`, not `0`.** Scoring it zero would punish every model equally and
misrank; scoring it one would pretend it is free. When cost is unknown the term is dropped
and the remaining weights renormalised, so `cheap` mode degrades to "fast and small".

**Throughput is measured, never claimed.** No provider publishes tokens/sec, so rather than
invent one the product measures `output_tokens / latency` on every real call. A model with
fewer than two observations keeps its editorial tier and the UI says "not measured yet".

## Data layout

```
%LOCALAPPDATA%\OmniAgent\
  config.json          settings, no secrets
  credentials.dat      DPAPI-encrypted keys
  quota-cache.json     last known provider figures, with timestamps
  gateway\             the isolated OmniRoute instance (DATA_DIR)
    .env               per-install generated secrets
  opencode\            our OpenCode config (XDG_CONFIG_HOME)
    opencode.json  AGENTS.md  skills\  plugins\
  oc-data\opencode\    OpenCode sessions and auth (XDG_DATA_HOME)
  browsers\            Chromium
  telemetry\           local usage, JSONL per day
  logs\                diagnostics
  downloads\           files the browser saved
```
