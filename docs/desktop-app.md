# The desktop app

`omni-agent ui`, or the Omni Agent shortcut on your desktop.

Before this existed the product was a terminal interface (OpenCode's TUI) plus a
handful of CLI commands. The app is a real window with the same engine behind it,
and it exposes the parts of the system the terminal never showed.

---

## What is in it

| | |
|---|---|
| **Chat** | Conversation. Runs the `plan` agent, which reads, searches the web and explains, and **never edits your files**. |
| **Code** | Agentic work: writing code, running commands, using the browser. Runs `build`. |
| **Auto / Plan / Ask first** | How much the agent does before checking with you. Code only. |
| **Model picker** | Every model the gateway can serve — 160-odd on a keyless install — with a search box. |
| **Usage** | How full the conversation's context is, and any free allowance the provider actually publishes. |
| **Routines** | Saved prompts on a schedule. |
| **Transcripts** | A copy of every conversation, kept outside the agent, so deleting one is recoverable. |
| **Tools & plugins** | Built-in tools, skills, and MCP connections you can add. |
| **Search tools** | The web-search chain, in the order it is tried, and where to add a free key. |
| **Free capacity** | Free model providers, sign-ins, and step-by-step setup for each. |
| **Token saving** | The seven-rung compression ladder, with savings measured on this machine. |
| **Advanced dashboard** | A door into the gateway's own 140-page web dashboard, with your password. |

## How it is built

```
omni-agent ui
  ├─ the model gateway (OmniRoute)          started first, always
  ├─ `opencode serve`                       the agent, as an HTTP server
  ├─ the UI server (src/ui/server.mjs)      serves the page, proxies the rest
  └─ a browser window in --app mode         chromeless, its own taskbar entry
```

**The order is load-bearing.** The gateway's OpenCode plugin registers this
product's models by asking the gateway for them at boot. Start the agent first
and it registers nothing, falls back to OpenCode's own provider, and the first
message fails with *"Model x-preview-f-free is not supported"*.

**There is no Electron.** The window is the Chromium this product already
downloads for browser automation, opened with `--app=`. If that copy cannot
start, it falls back to Microsoft Edge, then Chrome, then your default browser.

## Security

- `opencode serve` is started with a **password generated per launch**
  (`OPENCODE_SERVER_PASSWORD`). Its scheme is HTTP Basic and the username must
  be exactly `opencode`. The page never sees this credential — the UI server
  attaches it.
- The UI server checks a **per-launch token** on `/x/*` and `/oc/*`, and rejects
  any request whose `Host` is not loopback. The page itself is unauthenticated,
  because it contains nothing and can do nothing without the token.
- The page runs under a content-security-policy that forbids loading anything
  from the network.

## Things that are not obvious

**Two halves of the OpenCode API, and they are not views of the same data.**
Messages sent through `POST /session/{id}/message` (legacy) do not appear in
`GET /api/session/{id}/message` (v2) at all. The app uses the legacy half for
everything to do with messages. `POST /api/session/{id}/prompt` accepts a
message, returns 200, and never runs it — it is not used.

**`DELETE /api/session/{id}` does not exist.** It falls through to the app shell
and answers `200` with HTML, so a delete through it silently does nothing. The
real one is `DELETE /session/{id}`.

**Field names differ per route.** `POST /api/session/{id}/model` wants
`{model: {providerID, id}}`; `POST /session/{id}/message` wants
`{model: {providerID, modelID}}`.

**Preferences are on disk, not in the browser.** The UI server takes a fresh
port each launch, so the page is a new origin every time and `localStorage`
would start empty on every restart. They live in `ui-prefs.json`.

## Models

The gateway is asked for **everything it can serve**, not just what it currently
rates as healthy (`usableOnly: false`). On this machine that is the difference
between 81 and 156 models. The tradeoff is real: some listed models need a free
key you have not added yet, and will answer `401`. So:

- the picker has a search box,
- a model that has actually failed here is marked **"failed here before"**,
- a failure offers *Choose a different model* directly in the transcript.

Nothing about a model's health is guessed. The gateway publishes no per-model
health — `theoldllm` reports `active: true` and answers `403` — so the only
signal shown is what has already happened on this machine.

## Transcripts

Every conversation is exported with `opencode export` into
`%LOCALAPPDATA%\OmniAgent\transcripts\` once a minute, and again immediately
before you delete one. Restoring is `opencode import`. Using the tool's own
round trip means the archive cannot drift into a shape OpenCode will not accept.

The archive is **not** sanitised: it is your complete record of your own
conversation, on your own machine, and nothing here is transmitted anywhere.

## Routines

A routine is a saved prompt plus a schedule. Running one creates an ordinary
session, so its output appears in the sidebar and is archived like any other.

Two ways to run, and the difference is stated in the UI:

- **while the app is open** — nothing to install, does nothing when closed.
- **even when closed** — registers a Windows Scheduled Task that runs
  `omni-agent routine run <id>`.

## If the window does not open

The app falls back to your default browser and says why. The most likely cause
on Windows is that the bundled Chromium cannot start — *"the application has
failed to start because its side-by-side configuration is incorrect"*, which
means the **Microsoft Visual C++ Redistributable (x64)** is missing. Installing
it fixes the window. Everything else works either way.

`omni-agent ui --no-window` starts the same stack and prints the address, if you
would rather use your own browser.
