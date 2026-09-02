# Installation

## The EXE (recommended)

Download `OmniAgentSetup-<version>.exe` and run it.

It is a **per-user** install into `%LOCALAPPDATA%\Programs\OmniAgent`, so it does **not**
ask for an administrator password. It:

- checks the architecture (x64) and warns if free disk is under 6 GB
- installs the application and a **private Node.js runtime**, so the machine needs nothing
  preinstalled
- installs **`OmniAgent.exe`**, the application itself
- creates Start Menu entries (*Omni Agent*, *Omni Agent in a terminal*, *Set up Omni Agent*,
  *Check Omni Agent health*) and, optionally, a desktop shortcut
- offers to run first-time setup immediately

### What happens on first run

`Set up Omni Agent` runs two stages.

**Stage 1 — `scripts/bootstrap.mjs`** downloads the components too large to ship:

| Component | Installed size |
|---|---|
| `omniroute@3.8.49` (model gateway) | ~2.7 GB |
| `opencode-ai@1.18.23` (agent harness) | ~514 MB |

They go into `<install dir>\runtime\node_modules` — a **private prefix**. If you already
have your own global `omniroute` or `opencode`, it is untouched and keeps its own version.

Versions are pinned so a surprise upstream release cannot break a fresh install.

**Stage 2 — `omni-agent setup`** is the wizard:

1. **Your AI models.** Paste any API keys you have. **Leave every one blank if you like** —
   the gateway serves free models and the agent works either way.
2. **Routing mode.** fast / balanced / smart / quality / cheap.
3. **Permissions.** Standard / Cautious / Open — see [security.md](security.md).
4. **Components.** Downloads Chromium (~700 MB), generates the gateway's per-install
   secrets, starts it, mints its credential, and writes the OpenCode configuration.
5. **Health check.** Real probes: a real model request through the fallback chain, a real
   search, a real page fetch, and a real browser launch.

Anything that fails prints what failed and how to fix it. Nothing is reported as OK because
a file exists.

### Total footprint

About **6 GB** once fully set up. The installer is 74.6 MB and puts about 380 MB on disk
(the application, a private Node.js runtime and `OmniAgent.exe`); the rest is downloaded on
first run.

---

## The portable ZIP

For users who would rather not run an installer, and for debugging.

```
1. Extract OmniAgent-Portable-<version>.zip anywhere
2. Run setup.bat   (once)
3. Run start.bat
```

Same application, same bundled Node runtime, no registry entries and no shortcuts. Data
still goes to `%LOCALAPPDATA%\OmniAgent` unless you set `OMNI_AGENT_HOME`.

`install.ps1` is the scriptable equivalent:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -SkipSetup   # unattended
```

---

## From source

Requires Node 22 or newer.

```bash
git clone https://github.com/AnSa30-06/omni-agent.git
cd omni-agent
npm install
node scripts/bootstrap.mjs      # gateway + harness into ./runtime
node bin/omni-agent.mjs setup
node bin/omni-agent.mjs
```

`install.ps1` from `installer/portable/` also works on a source checkout — it detects the
absence of a bundled runtime and uses the system Node instead.

This is the path that works on macOS and Linux. Only the Windows installer is built today.

---

## Unattended / CI

```bash
node bin/omni-agent.mjs setup --non-interactive
```

Skips all prompts and keeps the defaults (balanced routing, standard permissions, no
provider keys). Configure afterwards:

```bash
node bin/omni-agent.mjs config key deepseek "$DEEPSEEK_API_KEY"
node bin/omni-agent.mjs config mode cheap
node bin/omni-agent.mjs doctor --quick   # skips the slow live probes
```

Credentials can also come from environment variables — see
[`.env.example`](../.env.example). The encrypted store wins when both are present.

The installer itself supports Inno Setup's standard switches:

```
OmniAgentSetup-1.1.7.exe /VERYSILENT /CURRENTUSER /SUPPRESSMSGBOXES /NORESTART /DIR="C:\Apps\OmniAgent"
```

---

## Verifying a download

Each release publishes a SHA-256 for both artefacts.

```powershell
Get-FileHash .\OmniAgentSetup-1.1.7.exe -Algorithm SHA256
```

The installer is **not code-signed** — Windows SmartScreen will warn on first run. Choose
*More info* → *Run anyway*, after checking the hash. Signing needs a certificate this
project does not have.

---

## Uninstalling

*Settings → Apps → Omni Agent*, or the Start Menu uninstaller.

It removes the program files and asks separately whether to delete
`%LOCALAPPDATA%\OmniAgent` — your settings, saved keys, logs and downloaded browser. Choose
*No* to keep them for a reinstall.

Your global `opencode` and `omniroute` installs, if any, are never touched.

---

## Upgrading

Run the new installer over the old one. Settings and credentials in
`%LOCALAPPDATA%\OmniAgent` are preserved; the program files are replaced.

`omni-agent setup` is safe to re-run at any time — it detects what is already installed and
skips it.

To move the pinned component versions, edit `COMPONENTS` in
[`scripts/bootstrap.mjs`](../scripts/bootstrap.mjs), delete `runtime/node_modules`, and
re-run bootstrap.
