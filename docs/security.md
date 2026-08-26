# Security

This product has shell access, filesystem access, a real browser, and your API keys. That
combination deserves to be taken seriously, so this page states exactly what is enforced,
where, and what is *not* protected.

## The confirmation boundary

**Filling in a form and stopping is the normal, expected outcome.**

Before the agent activates any control that submits, sends, publishes, posts, applies,
buys, pays or deletes, it must have your explicit authorisation *for that specific action*.
A general "go ahead" earlier in the conversation does not count.

### How it is enforced

This is enforced in code, in [`src/tools/browser.mjs`](../src/tools/browser.mjs), not by a
prompt and not by a permission setting:

```js
export async function click(ref, { confirmSubmit = false } = {}) {
  const submitish = await looksLikeSubmit(loc);
  if (submitish && !confirmSubmit) {
    return { blocked: true, reason: "submit-confirmation-required", ... };
  }
```

`looksLikeSubmit` treats a control as consequential when it is an `input[type=submit]`
inside a form, or when its visible text matches submit / send / apply now / place order /
buy / pay / purchase / checkout / confirm / delete / publish / post comment / sign up /
register / subscribe / book now / donate.

`confirmSubmit: true` may only be passed after you have said yes. When it is passed, the
plugin *also* raises OpenCode's own permission prompt (`ToolContext.ask`), so the
authorisation appears in the interface rather than being decided inside the model.

**No permission profile can switch this off.** The `open` profile relaxes shell and file
permissions; it does not touch this.

Both directions are covered by automated tests in
[`tests/integration/browser.test.mjs`](../tests/integration/browser.test.mjs) — one asserts
a submit button is refused and the page did not navigate, another asserts the same button
goes through once authorised and the server received the values.

### What is deliberately not built

No CAPTCHA solving. No bot-detection evasion. No authentication bypass. If one of these
blocks the agent, it reports that and hands the task back to you.

## Credential storage

Keys are encrypted with **Windows DPAPI**, via PowerShell's `ConvertFrom-SecureString`,
which binds the ciphertext to your Windows user account. Another account on the same
machine cannot decrypt them.

This was chosen over `keytar` and friends because it needs **no native module**: nothing to
compile, nothing to go wrong in the installer, no prebuilt binary to trust.

- Stored at `%LOCALAPPDATA%\OmniAgent\credentials.dat`, mode 0600.
- On non-Windows the store falls back to a 0600 file — the same guarantee the OpenCode and
  omniroute CLIs give their own auth files, and no more.
- `omni-agent config show` prints credential **names**, never values.
- Environment variables are honoured as a fallback for CI and technical users; the store
  wins when both are present.

The gateway's own instance secrets (`JWT_SECRET`, `API_KEY_SECRET`,
`STORAGE_ENCRYPTION_KEY`, admin password) are **generated per install** in
[`src/gateway/supervisor.mjs`](../src/gateway/supervisor.mjs). The upstream npm package
ships a `.env` with fixed defaults, which would mean every install on earth shared the same
database encryption key.

## Logging

Every log write goes through [`src/util/redact.mjs`](../src/util/redact.mjs), which strips
values by key name (`apiKey`, `token`, `password`, `authorization`, `cookie`, …) and by
value shape (`sk-ant-…`, `sk-proj-…`, `AIza…`, `ghp_…`, `oma_live_…`, `Bearer …`).

`omni-agent diagnostics` produces a bundle for bug reports. It redacts, then **re-scans the
rendered text** and aborts rather than write a file that still matches a secret pattern. A
"sanitised" bundle that is not sanitised is worse than none.

Never logged: API keys, passwords, cookies, session tokens, or the contents of forms the
browser fills.

## Permissions

Three profiles, in [`config/permissions.json`](../config/permissions.json), selected during
setup:

| Profile | Shape |
|---|---|
| **Standard** (default) | Reading, searching, browsing and writing files are automatic. Anything touching the wider system, or outside the project, asks. Destructive commands are refused. |
| **Cautious** | Reading and searching are automatic; everything that writes, runs or reaches the network asks first. |
| **Open** | For experienced users. Only unambiguously destructive commands are refused. |

Refused in **every** profile, including `open`:

```
rm -rf /*      rm -rf ~*      del /f /s /q C:*     format *
diskpart*      mkfs*          shutdown*            bcdedit*
reg delete*    net user*      netsh advfirewall*
Set-MpPreference*  Add-MpPreference*                 (Defender tampering)
curl * | sh    curl * | bash  iwr * | iex          *Invoke-Expression*
git push --force*  git push -f*
```

Windows security controls are never disabled. Nothing here asks you to add an antivirus
exclusion.

## Network and data

- **Telemetry is local only.** Token counts, latencies and model choices are written to
  `%LOCALAPPDATA%\OmniAgent\telemetry\*.jsonl` and never transmitted anywhere.
- The gateway binds to `127.0.0.1`. It is not exposed to your network.
- Provider usage adapters talk only to the provider's own documented endpoint.
- Web search defaults to DuckDuckGo, which needs no account.

## What this does NOT protect you from

Stated plainly, because a security page that only lists wins is not useful:

- **The agent runs shell commands.** In the `standard` profile many are automatic. A
  cleverly-worded request, or a prompt injection embedded in a web page it reads, could get
  a command run that you did not intend. The destructive-command denylist is a backstop,
  not a sandbox.
- **Content the browser reads is untrusted.** A malicious page can contain text aimed at
  the model. The confirmation boundary is what stops that becoming an irreversible action;
  it does not stop the model being misled about facts.
- **Anything you type into a form, the browser sends.** It is a real browser with a real
  session.
- **There is no sandbox.** Code the agent writes runs with your user's privileges.
- **The bundled gateway is a third-party application.** Its own security posture is
  upstream's, not ours.

If you are working with something genuinely sensitive, use the `cautious` profile and read
each prompt.

## Reporting a vulnerability

Open a
[security advisory](https://github.com/AnSa30-06/omni-agent/security/advisories/new) rather
than a public issue.
