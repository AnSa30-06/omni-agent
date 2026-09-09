# Sending Vireo to someone else

Two things make the difference between "here is an app" and "here is an app that
works": they should not have to sign up for anything, and they should not have to
know what an API key is.

---

## 1. Put a provider key inside the build

Vireo runs with no key at all, but only a handful of free models still answer and
they are slow. A single free key turns that into over a thousand models.

You can ship **your** key inside the build, so the person you send it to opens the
app and it simply works.

```bash
vireo bundle-key mistral YOUR-MISTRAL-KEY
```

It checks the key with a real call before saving it, so a mistyped key is caught
on your machine rather than on theirs.

```bash
vireo bundle-key show     # which providers are bundled (names only)
vireo bundle-key clear    # remove it
```

### 🔴 The key never enters git, and that is enforced

`bundled-key.json` is in `.gitignore`, and `tests/unit/bundled-key.test.mjs`
asks git on every test run whether it is still ignored. That test exists because
**this repository is public**, and because `npm run scan:secrets` only reads what
git *tracks* — an ignored file is invisible to it. The test is what closes that
gap.

So the key lives in exactly two places: your working copy, and the installer you
hand over.

### Which key to use

Get a free one from <https://console.mistral.ai/>. Mistral's free tier is by far
the largest of the free providers — on the order of two thirds of all the free
capacity Vireo knows about.

**Use a key you are willing to have used by someone else.** Whoever you send the
build to can make requests with it. If that matters, make a separate key for
this and delete it later.

---

## 2. Build the installer

```bash
npm run build:installer     # dist/VireoSetup-<version>.exe
npm run build:portable      # dist/Vireo-Portable-<version>.zip
```

The build prints a line confirming the key went in:

```
  Bundled provider key included: mistral
```

If you do not see that line, the key is not in the build. Run `vireo bundle-key
show` and check.

Send them **the .exe**. It is a per-user install, so it needs no administrator
password.

---

## 3. What they will see

1. Windows SmartScreen says *"Windows protected your PC"*, because the file is
   not code-signed. **Tell them about this before you send it**, or they will
   assume it is a virus. They click **More info**, then **Run anyway**.
2. It installs, then downloads the parts that are too big to ship — the model
   gateway, the agent and a browser. About 4 GB, ten to thirty minutes, once.
3. Setup connects your bundled key and says so.
4. They open Vireo. Models work with no signup.

Point them at:

- **[docs/decisions/getting-started.md](decisions/getting-started.md)** if you
  want them to look at Decisions.
- The main [README](../README.md) for the agent side.

The fastest thing to tell someone to try:

> Open Vireo, click **Decisions**, load the demo company, and press Run.

---

## What to say about privacy

Worth being straight with them, because it is their data:

- Everything runs on their machine. There is no account and no server of ours.
- Their files are never uploaded.
- When they use the agent, their prompts go to whichever model is serving them —
  with a bundled key, that is Mistral, under **your** account.
- In Decisions, the only thing that leaves the machine is a short fact sheet
  about one customer, with names replaced by codes by default.
  [docs/decisions/privacy.md](decisions/privacy.md) shows an example.

---

## Renaming it again

The product name is one command:

```bash
node scripts/rename-product.mjs --to "Some Name" --slug some-name --dry
node scripts/rename-product.mjs --to "Some Name" --slug some-name
```

It renames files, contents, the CLI, the environment variables and the data
directory, and deliberately leaves the upstream OmniRoute and OpenCode projects
and every real URL alone. Run the tests afterwards.

⚠️ It changes the data directory (`%LOCALAPPDATA%\Vireo`), so an existing
install's workspaces and decisions will not be found by the renamed build. That
is usually what you want for a fork; it is not what you want for an upgrade.
