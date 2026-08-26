# Troubleshooting

Start here:

```bash
omni-agent doctor
```

Every row is a live probe — a real model request, a real search, a real page fetch, a real
browser launch. Nothing reports OK because a file exists.

For a bug report:

```bash
omni-agent diagnostics
```

Writes a sanitised JSON bundle to `%LOCALAPPDATA%\OmniAgent\logs\`. Secrets are redacted,
and the exporter **refuses to write the file** if anything in it still matches a secret
pattern. Look at it before you send it.

---

## "Model responds — FAIL — HTTP 429"

The free model pool is rate-limited right now.

- **Retry in a minute.** The fallback chain usually finds a working model; a 429 here means
  every model in the chain refused at once.
- **Add a provider key.** One paid key removes this permanently:
  ```bash
  omni-agent config key deepseek sk-...
  ```

This is the most common failure on a fresh install and it is not a bug — it is what a free
tier under load looks like.

## "Gateway running — FAIL"

```bash
omni-agent gateway status
omni-agent gateway start
```

If it will not start, read `%LOCALAPPDATA%\OmniAgent\logs\gateway.log`.

- **Port 20129 already taken** — change it in
  `%LOCALAPPDATA%\OmniAgent\config.json` (`gateway.port`) and re-run
  `omni-agent setup`.
- **First start is slow.** It is a Next.js application with database migrations; a cold
  first start can take a minute. The supervisor allows 180 s.
- **`omniroute-not-installed`** — the bootstrap did not finish. Run *Set up Omni Agent* from
  the Start Menu again.

## OpenCode shows no models / "undefined is not an object (evaluating '$.models')"

The gateway credential is missing, so the OmniRoute plugin registered no provider.

```bash
omni-agent setup --non-interactive
```

That re-mints the gateway token and rewrites the OpenCode configuration.

To confirm what the plugin saw, look for this line when OpenCode starts:

```
[omniroute-plugin] config shim skipped: no apiKey for providerId=opencode-omniroute
```

If you see it, the plugin could not find `auth.json`. It resolves that path from
`OPENCODE_DATA_DIR` — which the launcher sets. Launch through `omni-agent`, not by running
`opencode` directly.

## Browser tasks fail

```bash
omni-agent setup --browser
```

Re-downloads Chromium into `%LOCALAPPDATA%\OmniAgent\browsers`.

- **"ref eN is not on the current page"** — expected and self-correcting. The page changed
  and the agent must re-snapshot. If it keeps happening the page is re-rendering constantly.
- **The agent refuses to click a button** — that is the confirmation boundary. Tell it
  explicitly to submit, and it will ask you to confirm. See [security.md](security.md).
- **A CAPTCHA or bot check** — the agent will not attempt to bypass one. Do that step
  yourself.

## Web search returns nothing

DuckDuckGo rate-limits aggressively when queried in bursts. Wait, or add a keyed provider:

```bash
omni-agent config key brave BSA...     # then set search.order in config.json
```

## "Quota unavailable from provider"

That is usually the correct answer, not a fault:

- **Google** publishes no quota API for Gemini keys.
- **Anthropic** and **OpenAI** publish usage only to *Admin* keys, which are separate
  credentials.
- **The gateway free tier** needs a management-scoped key. Setup mints one; if it failed,
  re-run setup.

See [providers.md](providers.md) for exactly what each provider publishes. **This product
never estimates a quota**, so "unavailable" is what you get when nobody published a number.

## Setup fails downloading components

Almost always network, a corporate proxy, or disk space.

```bash
# Check space - about 6 GB is needed
# Then re-run:
node scripts/bootstrap.mjs
```

Behind a proxy, set `HTTP_PROXY` / `HTTPS_PROXY` before running setup.

The bootstrap is resumable: components already installed are skipped.

## SmartScreen blocks the installer

It is unsigned. Check the published SHA-256 first:

```powershell
Get-FileHash .\OmniAgentSetup-1.0.0.exe -Algorithm SHA256
```

Then *More info* → *Run anyway*.

## It is slow

Free models are slow — 57 s for a short reply has been measured. The fix is a provider key.

You can also trade quality for speed:

```bash
omni-agent config mode fast
```

Check what it is actually doing:

```bash
omni-agent usage      # measured tokens/sec per model, on your machine
omni-agent route      # which model each kind of task gets
```

## Antivirus interferes

Some products flag automated browser control or a locally-bound server. Nothing here asks
you to disable your antivirus or add an exclusion. If yours blocks the gateway, the failure
appears in `gateway.log` as an immediate exit.

## Starting over

```bash
omni-agent gateway stop
```

Then delete `%LOCALAPPDATA%\OmniAgent` and re-run setup. That discards settings, saved
keys, telemetry and the downloaded browser — the program files are untouched.
