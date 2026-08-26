# Omni Agent

## What is this?

This is a ready-to-use AI agent that can write code, browse the web, research information,
automate browser tasks, work with files, analyse data and use multiple AI models
automatically.

You install one program. It sets itself up. Then you ask it to do things, in plain English.

**You do not need an API key.** It works out of the box using free models. If you already
pay for Claude, ChatGPT, Gemini, DeepSeek or Kimi, you can add your key and it will be
faster — but that is an upgrade, not a requirement.

---

## Install

1. **Download** `OmniAgentSetup-1.0.0.exe` from the
   [Releases page](https://github.com/AnSa30-06/omni-agent/releases).
2. **Run it.** No administrator password needed.
3. When it finishes, it opens a setup window that downloads the rest and checks everything
   works. This takes a while and needs about 4 GB — see [Disk and download](#disk-and-download).
4. **Launch** *Omni Agent* from your Desktop or Start Menu.

That's it. Ask it something.

> Find 10 computer science internships that are open right now, with links.

> Open this website and fill in the form using the details in my CV, but don't submit it.

> Read this spreadsheet and tell me which product line lost money last quarter.

> Write me a Python program that renames all the photos in a folder by their date.

### If you would rather not use an installer

Download `OmniAgent-Portable-1.0.0.zip`, extract it anywhere, and run `setup.bat` once,
then `start.bat`. Nothing is written outside the folder and your own data directory.

---

## What it can do

| | |
|---|---|
| **Write and run code** | Any language. It reads your project first, then edits, runs and tests. |
| **Browse the web for real** | A real Chromium browser. It clicks, types, fills forms, switches tabs, downloads files, and handles JavaScript-heavy sites. |
| **Search and read the web** | Searches, then actually fetches the pages before quoting them. Cites the URL it really loaded. |
| **Scrape and crawl** | Bulk extraction from one page or a whole site section. |
| **Documents** | Reads PDF, Word, Excel, CSV, JSON, text and Markdown. Writes CSV, Excel, JSON, Markdown. |
| **Data analysis** | Profiles a spreadsheet — types, missing values, statistics — without spending tokens on it. |
| **Git and GitHub** | Branches, commits, pull requests, issues. |
| **Choose its own model** | Picks a cheap fast model for simple work and a strong one for hard work. |

### It stops before doing anything irreversible

Filling in a form and stopping is the **normal** outcome. Before it submits anything, sends
anything, buys anything, publishes anything or deletes anything, it stops and asks you
about that specific action. That is enforced in code and no setting turns it off.

It will not defeat CAPTCHAs, bot checks or access controls.

---

## Disk and download

Be aware of this before you start:

| Component | Size | When |
|---|---|---|
| The installer itself | ~90 MB | download |
| Node.js runtime | ~80 MB | bundled in the installer |
| Model gateway (OmniRoute) | ~2.7 GB | first run |
| Agent harness (OpenCode) | ~514 MB | first run |
| Chromium browser | ~700 MB | first run |

Roughly **6 GB** of disk once fully set up. The big components are downloaded on first run
rather than bundled, because an installer carrying them would be unusable.

---

## Usage and cost

Run `omni-agent usage`, or just ask the agent "what model am I on and what is this
costing?".

**The numbers you see are real or they are absent.** This product never estimates a quota
or a balance. Providers differ in what they publish, and the dashboard says which is which:

- **DeepSeek** and **OpenRouter** publish a live balance — you see it.
- **Anthropic** and **OpenAI** publish usage only to *Admin* keys — without one, it says
  "unavailable" and tells you why.
- **Google** publishes nothing for Gemini API keys — it says so.
- Token counts come from what each API response actually reported, and are labelled
  "provider-reported".
- Speed is measured on your machine from real calls. A model you have not used yet shows
  "not measured yet", not a number.

Capability rankings ("strong", "elite") are this project's own editorial estimates, kept in
[`config/models/metadata.json`](config/models/metadata.json). They are **not** benchmark
scores and are never presented as such.

---

## Choosing a model

The agent routes automatically. Five modes:

| Mode | Meaning |
|---|---|
| `fast` | Highest throughput, lowest latency |
| `balanced` | The default |
| `smart` | The strongest model that is still reasonably efficient |
| `quality` | The strongest suitable model, cost be damned |
| `cheap` | The cheapest model that can still do the job |

```bash
omni-agent config mode smart
```

Or ask it: *"switch to the cheapest model"*. To pin one specific model, `omni-agent models`
lists what is available right now, and the agent's `agent_status` tool can pin it.

Simple work (classifying, naming, extracting a field) is deliberately sent to a cheap fast
model even in `quality` mode. Spending an elite model on a title is the single easiest way
to waste a budget.

---

## Commands

```bash
omni-agent                 # start the agent
omni-agent doctor          # check everything works, with real probes
omni-agent usage           # model, quota and token usage
omni-agent models          # what the gateway currently serves
omni-agent route           # which model each kind of task would get
omni-agent setup           # re-run the setup wizard
omni-agent gateway status  # is the model gateway running
omni-agent diagnostics     # export a sanitised report for bug reports
```

---

## Architecture

```
                    You
                     |
              omni-agent  (launcher, setup, health, usage)
                     |
                 OpenCode  (the agent harness and TUI)
                     |
        +------------+--------------------------+
        |                                       |
  Built-in tools                     Omni Agent plugin
  files, shell, git                  8 high-level tools
                                       |
        +----------+----------+--------+---------+----------+
        |          |          |        |         |          |
    web_search  web_fetch  web_scrape browser  documents  agent_status
                                       |
                                  Playwright
                     |
                 OmniRoute  (model gateway: routing, fallback, quotas)
                     |
     Claude · GPT · Gemini · DeepSeek · Kimi · 100+ free models
```

**Composition, not forking.** OpenCode and OmniRoute are used unmodified, through their
documented extension points: an OpenCode plugin for the tools, OmniRoute's own first-party
OpenCode plugin for the models. Not one line of either project is patched.

**Isolation.** The bundled gateway runs on its own port with its own data directory, and
OpenCode is pointed at a private config directory. Installing this cannot disturb an
existing `omniroute` or `opencode` setup, and uninstalling it cannot take theirs with it.

### Tool count is a budget

Every tool description is spent from the model's context on **every turn**. So the whole
browser — navigate, snapshot, click, type, select, upload, tabs, extract, screenshot,
download, wait — is *one* tool with an `action` argument, not eighteen tools. Eight tools
total.

### Documentation

| | |
|---|---|
| [Installation](docs/installation.md) | Every install path, and what each one does |
| [Architecture](docs/architecture.md) | How the pieces fit, and the decisions behind them |
| [Providers](docs/providers.md) | Model, search and scraping providers; what each publishes |
| [Model routing](docs/routing.md) | How a model gets chosen |
| [Security](docs/security.md) | The confirmation boundary, credential storage, permissions |
| [Troubleshooting](docs/troubleshooting.md) | When something breaks |
| [Development](docs/development.md) | Running from source, tests, building the installer |

---

## Security

- Credentials are encrypted with **Windows DPAPI**, bound to your Windows account. No
  native module, no plaintext key file.
- Nothing is logged that looks like a secret — every log write and the diagnostics export
  both pass through redaction, and the exporter **aborts** rather than emit a bundle that
  still matches a secret pattern.
- Genuinely destructive shell commands are refused outright, whatever permission profile is
  selected.
- Telemetry is local-only. Nothing about your usage leaves the machine.

Details in [docs/security.md](docs/security.md).

---

## Requirements

- Windows 10 or 11, 64-bit
- ~6 GB free disk
- An internet connection for setup

macOS and Linux work from source (`npm install && node bin/omni-agent.mjs setup`); only the
Windows installer is built today.

---

## Licence

MIT — see [LICENSE](LICENSE).

Built on [OpenCode](https://opencode.ai) (MIT) and
[OmniRoute](https://github.com/diegosouzapw/OmniRoute) (MIT), both used unmodified.
Browser automation by [Playwright](https://playwright.dev) (Apache-2.0).
