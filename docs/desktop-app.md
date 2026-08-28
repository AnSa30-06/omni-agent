# The desktop app

**OmniAgent.exe** — the Omni Agent shortcut on your desktop and in the Start
Menu. `omni-agent ui` starts the same thing from a terminal.

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
| **Live output** | Text and tool calls stream in as they are produced, fading in fragment by fragment. |
| **Working folder** | Which folder the agent reads and writes in. Chosen with the Windows folder picker, fixed when a conversation starts. |
| **Routines** | Saved prompts on a schedule. |
| **Transcripts** | A copy of every conversation, kept outside the agent, so deleting one is recoverable. |
| **Tools & plugins** | Built-in tools, skills, and MCP connections you can add. |
| **Search tools** | The web-search chain, in the order it is tried, and where to add a free key. |
| **Free capacity** | Free model providers, sign-ins, and step-by-step setup for each. |
| **Token saving** | The seven-rung compression ladder, with savings measured on this machine. |
| **Advanced dashboard** | A door into the gateway's own 140-page web dashboard, with your password. |

## How it is built

```
OmniAgent.exe                               one process, no console
  ├─ the model gateway (OmniRoute)          started first, always
  ├─ `opencode serve`                       the agent, as an HTTP server
  ├─ the UI server (src/ui/server.mjs)      serves the page, proxies the rest
  └─ a browser window in --app mode         chromeless, its own taskbar entry
```

**`OmniAgent.exe` is a real executable**, built by `scripts/build-exe.mjs`: a
[Node Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
made from the same Node runtime the installer already bundles, with its PE
subsystem flipped from CONSOLE to WINDOWS so double-clicking it opens the app
and never a black terminal. It does not spawn a second process — SEA requires a
CommonJS entry, but a dynamic `import()` of an ESM file works from inside one,
so the exe loads `src/ui/launch.mjs` in-process. One process, one taskbar entry,
no `node.exe` anywhere on screen.

Because there is no console attached, everything it would have printed goes to
`%LOCALAPPDATA%\OmniAgent\logs\launcher.log`, and a start-up failure raises a
dialog rather than doing nothing. *Omni Agent in a terminal* in the Start Menu
runs the identical thing with the console visible.

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

**`GET /api/session/{id}/event` never sends response headers.** The request
hangs until it is aborted — no status line, no `content-type`, nothing. The app
subscribed to it for its live updates, so no event ever arrived and answers
appeared in one lump when the send request returned. The stream that works is
the **global `/event`**, filtered by session id.

**`POST /api/session?directory=X` accepts the directory and ignores it.** It
answers 200 and hands back a session rooted in the default workspace. The
legacy `POST /session?directory=X` honours it. This is the same v2/legacy split
as the message routes, and it fails the same way: silently, and in the wrong
place.

**Field names differ per route.** `POST /api/session/{id}/model` wants
`{model: {providerID, id}}`; `POST /session/{id}/message` wants
`{model: {providerID, modelID}}`.

**Preferences are on disk, not in the browser.** The UI server takes a fresh
port each launch, so the page is a new origin every time and `localStorage`
would start empty on every restart. They live in `ui-prefs.json`.

**The gateway is started through `cmd /c start "" /B`, and both halves of that
matter.** Spawning it `detached` makes it outlive whatever started it, but on
Windows that also creates a console — a second window titled *omniroute
(v16.2.12)* sitting next to the app, which `windowsHide` does not suppress.
Spawning it attached hides the window but kills the gateway the moment the
launcher exits. `start /B` is the only form that gives both.

**The pid recorded for the gateway is the launcher, not whatever holds the
port.** OmniRoute serves from a worker child, and killing that worker does not
stop it: the launcher starts another one within seconds. `omni-agent gateway
stop` therefore resolves the launcher from the process list — `start /B` means
the handle we hold belongs to a `cmd` that has already exited.

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

## Streaming

Answers are written into the page as they arrive, tool calls included. Three
things about how, because each replaced something that was quietly broken:

**Rendering is surgical, not wholesale.** The transcript used to be re-read and
re-rendered from scratch on every event. A full re-render per token restarts
every fade animation on every frame and makes the text strobe, so the assistant
turn is built once and streamed into. One authoritative re-render happens when
the turn settles — that is also what turns the literal streamed text into
rendered markdown, and what flattens the hundreds of per-fragment spans that
would otherwise make selection and scrolling gritty.

**Each fragment fades in.** `message.part.delta` carries incremental text (not
cumulative), and each one becomes a `<span class="tok">` that fades from
transparent. Text that simply appears reads as a page load; text that fades in
per fragment reads as something being written. A blinking caret marks the turn
still being written, and a running tool call gets a pulsing dot. All three are
switched off under `prefers-reduced-motion`.

⚠️ **The fade runs *from* transparent, and that is a correctness safeguard, not
a style.** Parking the element at `opacity: 0` and animating it back looks
identical while animations run and leaves the entire answer **permanently
invisible** when they do not — a throttled background tab, a compositor that is
not running. For the same reason the animation is `forwards` and never `both`:
`both` implies `backwards`, which pins the element to the transparent frame
before the animation starts.

**The view follows the answer with a sticky flag, not a distance measurement.**
Asking "is the reader near the bottom?" each time content arrives is always
answered "no" in a conversation with any history, so the view never follows what
is being written. Instead following starts on, and only a deliberate scroll *up*
turns it off. The scroll is `auto`, never smooth — a smooth scroll re-triggered
on every token restarts before it arrives.

## The working folder

The pill next to the mode button shows the folder the agent is working in, and
opens the ordinary Windows folder picker.

**A conversation's folder is fixed when it starts.** OpenCode takes it as
`POST /session?directory=<absolute path>` and the session remembers it from
then on; there is no route that moves an existing session somewhere else. So
the picker sets where your *next* conversation will work, and says so when one
is already open rather than offering a control that quietly does nothing. An
open conversation shows its own folder, not the one you have queued up.

The default is `%USERPROFILE%\OmniAgent Workspace`. Recently used folders are
remembered, and any that have since been deleted or unplugged are dropped from
the list instead of being offered as a choice that will fail.

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
