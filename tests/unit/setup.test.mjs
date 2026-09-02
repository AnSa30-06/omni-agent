// The setup wizard's prompt, which had a silent-success failure in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import { makeAsk } from "../../src/setup/wizard.mjs";
import { permissionProfile } from "../../src/setup/opencode-config.mjs";
import { pkg, PATHS } from "../../src/util/paths.mjs";

/** A readline interface over a stdin that is already at end-of-file. */
function eofInterface() {
  const input = Readable.from([]); // ends immediately, exactly like a closed stdin
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  return readline.createInterface({ input, output });
}

function scriptedInterface(lines) {
  const input = Readable.from(lines.map((l) => l + "\n"));
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  return readline.createInterface({ input, output });
}

test("a question against an EOF stdin settles instead of hanging forever", async () => {
  // THE BUG: rl.question() on a stdin that is already at EOF neither throws nor
  // resolves - it stays pending, the event loop empties, and Node exits 0. The
  // shipped 1.1.0 build printed its welcome, stopped at the first prompt, and
  // reported success having installed nothing.
  const rl = eofInterface();
  const ask = makeAsk(rl);
  const answered = await Promise.race([
    ask("anything? ", "the-default"),
    new Promise((r) => setTimeout(() => r("NEVER-SETTLED"), 2000)),
  ]);
  assert.notEqual(answered, "NEVER-SETTLED", "the prompt must not hang on a dead stdin");
  assert.equal(answered, "the-default");
  rl.close();
});

test("every later question on a dead stdin also settles, and adds no listeners", async () => {
  // A wizard asks a dozen questions. Attaching a close listener per call leaks
  // them and trips the max-listeners warning.
  const rl = eofInterface();
  const ask = makeAsk(rl);
  await ask("first? ", "a");
  const before = rl.listenerCount("close");
  for (let i = 0; i < 12; i++) {
    assert.equal(await ask(`q${i}? `, `d${i}`), `d${i}`);
  }
  assert.ok(rl.listenerCount("close") <= before, "no listener may be added per question");
  rl.close();
});

test("a real answer still wins, and a bare Enter takes the default", async () => {
  const rl = scriptedInterface(["Yes", ""]);
  const ask = makeAsk(rl);
  assert.equal(await ask("one? ", "dflt"), "Yes");
  assert.equal(await ask("two? ", "dflt"), "dflt");
  rl.close();
});

test("with no interface at all, questions answer with their default", async () => {
  const ask = makeAsk(null);
  assert.equal(await ask("q? ", "d"), "d");
  assert.equal(await ask("q? "), "");
});

test("setup records the model that answered, resolved to a concrete id", () => {
  // 🔴 The first message of a clean keyless install died on
  //   [401] Model north-mini-code-free is not supported
  // because the gateway's configured default is an auto/ combo that resolves
  // somewhere new on every call. Seeding the app with the combo would reinstate
  // exactly that, so `r.servedBy` - the model that actually produced the tokens
  // - is resolved against the catalogue ("hy3-free" -> "oc/hy3-free") before it
  // is remembered.
  const src = fs.readFileSync(pkg("src", "setup", "doctor.mjs"), "utf8");
  assert.match(src, /servedModel = concrete \?\? requested;/);
  assert.match(src, /catalogue\.find\(\(m\) => m\.id\.endsWith\(`\/\$\{r\.servedBy\}`\)\)/);
  assert.match(src, /return \{ rows, failed, warned, ok: failed === 0, servedModel \};/);
  // ...and the wizard has to actually persist it, or the whole path is dead.
  const wiz = fs.readFileSync(pkg("src", "setup", "wizard.mjs"), "utf8");
  assert.match(wiz, /rememberVerifiedModel\(result\.servedModel\)/);
});


test("every missing component is installed in ONE npm run", () => {
  // 🔴 `npm install <pkg>` reifies the whole tree and prunes anything the
  // prefix's package.json does not list. A component that FAILS is never
  // saved, so the next component's install deletes whatever it managed to lay
  // down. Measured 2026-08-28 on a clean install: omniroute failed, then
  // installing opencode-ai reported "added 3 packages, and removed 1192
  // packages" and the machine was left with neither.
  const src = fs.readFileSync(pkg("scripts", "bootstrap.mjs"), "utf8");
  assert.match(src, /const missing = COMPONENTS\.filter/);
  assert.match(src, /\["install", \.\.\.missing\.map\(\(c\) => c\.spec\)/, "one install for all of them");
  assert.ok(
    !/for \(const c of COMPONENTS\) \{[\s\S]{0,400}await run\(\["install", c\.spec/.test(src),
    "components must not be installed one at a time",
  );
});

test("a locked file is not reported as a network problem", () => {
  // ENOTEMPTY on Windows is antivirus, an open Explorer window, or a running
  // Omni Agent - telling someone to check their connection sends them the
  // wrong way entirely.
  const src = fs.readFileSync(pkg("scripts", "bootstrap.mjs"), "utf8");
  assert.match(src, /ENOTEMPTY\|EPERM\|EBUSY\|EACCES/);
  assert.match(src, /Windows would not let npm replace a folder that is still in use/);
  assert.match(src, /ENOSPC/, "a full drive is its own diagnosis");
});

test("the installer allows the command line to choose the install mode", () => {
  // With `dialog` alone, Inno IGNORES /CURRENTUSER and shows "Select install
  // mode" anyway - which /VERYSILENT then renders invisible, so an unattended
  // install looks exactly like a hang. Measured 2026-08-28 against 1.1.3.
  const iss = fs.readFileSync(pkg("installer", "omni-agent.iss"), "utf8");
  assert.match(iss, /PrivilegesRequiredOverridesAllowed=dialog commandline/);
});

test("stopping the gateway does not trust a stale pid file", () => {
  // Measured 2026-08-28: `gateway stop` answered "not-running" while omniroute
  // was serving on its port, because the pid file named a process from an
  // earlier launch - and the in-place upgrade that ran next deadlocked on the
  // files that live gateway was holding.
  const src = fs.readFileSync(pkg("src", "gateway", "supervisor.mjs"), "utf8");
  assert.match(src, /function livePid\(/);
  assert.match(src, /const found = gatewayPid\(cfg\.gateway\.port\);/);
  const stop = src.slice(src.indexOf("export async function stop()"), src.indexOf("export function status()"));
  assert.match(stop, /const pid = livePid\(\);/);
  assert.ok(!/const pid = readPid\(\);/.test(stop), "stop must not read the pid file directly");
  // The launcher restarts its worker, so one kill is not a stop.
  assert.match(stop, /const survivor = livePid\(\);/);
});

test("the wizard's last words fit the person who installed the exe", () => {
  // They have a desktop shortcut and no terminal, and this block used to tell
  // them to type `omni-agent`.
  const src = fs.readFileSync(pkg("src", "setup", "wizard.mjs"), "utf8");
  const ready = src.slice(src.indexOf('say("  Ready.")'));
  assert.match(ready, /Open Omni Agent from your Desktop or Start Menu/);
  assert.ok(ready.indexOf("fs.existsSync(exe)") !== -1, "the desktop wording is shown only when the exe exists");
  assert.match(ready, /omni-agent ui/, "a source checkout is told the command that opens the app");
  assert.ok(!/Start the agent with:   omni-agent"/.test(ready), "the terminal command is no longer the headline");
});

test("the agent's file tools cannot silently read the gateway's secrets", () => {
  // The whole data directory used to be allowed through the external-directory
  // gate, which let a prompt-injected page make the agent read gateway\.env
  // (JWT_SECRET, the admin password) and auth.json (the gateway admin token)
  // and post them to an attacker with no prompt. The work directories stay
  // allowed; everything else, the secrets included, falls to "ask".
  const ext = permissionProfile("standard").external_directory;
  assert.equal(typeof ext, "object", "external_directory is a rule map, not a bare string");
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/$/, "");
  const rule = (target) => {
    const t = norm(target);
    let verdict = ext["*"] ?? "ask";
    for (const [pat, v] of Object.entries(ext)) {
      if (pat === "*") continue;
      const suffix = pat.endsWith("/**") ? pat.slice(0, -3) : pat;
      if (pat.startsWith("**/")) {
        if (t.includes(norm(suffix).replace(/^\*\*\//, ""))) verdict = v;
      } else if (t === norm(suffix) || t.startsWith(norm(suffix) + "/")) {
        verdict = v;
      }
    }
    return verdict;
  };
  // Work dirs: still allowed, or the agent cannot save the user's work.
  assert.equal(rule(PATHS.workspace + "/site/index.html"), "allow", "the workspace stays writable");
  assert.equal(rule(PATHS.downloads + "/report.pdf"), "allow", "downloads stay writable");
  // Secrets: no longer silently allowed.
  const home = PATHS.home;
  assert.notEqual(rule(home + "/gateway/.env"), "allow", "gateway/.env is not silently readable");
  assert.notEqual(rule(home + "/oc-data/opencode/auth.json"), "allow", "the gateway token file is not silently readable");
  assert.notEqual(rule(home + "/credentials.dat"), "allow", "the credential store is not silently readable");
  // And the broad allows are gone from the source.
  const src = fs.readFileSync(pkg("src", "setup", "opencode-config.mjs"), "utf8");
  assert.ok(!/\[glob\(PATHS\.home\)\]: "allow"/.test(src), "the whole-home allow is removed");
  assert.ok(!/"\*\*\/OmniAgent\/\*\*": "allow"/.test(src), "the broad OmniAgent name-net is removed");
});

test("a busy free pool does not fail first-run setup", () => {
  // A fresh keyless install is commonly rate-limited on its very first probe.
  // Failing setup over a 429/401 told every such user their install was broken
  // when it was fine; a genuinely dead pool still fails.
  const doctor = fs.readFileSync(pkg("src", "setup", "doctor.mjs"), "utf8");
  assert.match(doctor, /const busy = \/[^\n]*429[^\n]*\.test\(/, "the model-responds failure is classified as busy-or-not");
  assert.match(doctor, /busy\s*\?\s*row\(\s*\n?\s*"Model responds",\s*\n?\s*WARN/, "a busy pool is a WARN, not a FAIL");
  // 401 must be switch-worthy so the probe walks the whole combo chain.
  const exec = fs.readFileSync(pkg("src", "routing", "execute.mjs"), "utf8");
  assert.match(exec, /SWITCH_MODEL = new Set\(\[401, 402, 403, 429, 500, 502, 503, 504\]\)/, "401 walks to the next model");
  // doctor finishes what a rate-limited setup could not.
  const bin = fs.readFileSync(pkg("bin", "omni-agent.mjs"), "utf8");
  const dcmd = bin.slice(bin.indexOf('case "doctor":'), bin.indexOf('case "usage":'));
  assert.match(dcmd, /if \(result\.ok\) \{\s*\n\s*updateConfig\(\{ configured: true \}\)/, "a passing doctor marks the install configured");
  assert.match(dcmd, /rememberVerifiedModel\(result\.servedModel\)/, "and remembers the model that answered");
});

test("the health check reports each result as it happens, and its window stays open", () => {
  // Every error message in this product points at "Check Omni Agent health".
  // It ran node.exe directly, so the console closed on the same millisecond
  // the report appeared, and nothing printed for the 83 s before that
  // (measured 2026-09-02) - a blank window that then vanished.
  const doctor = fs.readFileSync(pkg("src", "setup", "doctor.mjs"), "utf8");
  assert.match(doctor, /const onRow = typeof opts\.onRow === "function" \? opts\.onRow : null;/);
  assert.match(doctor, /const add = \(r\) => \{\s*\n\s*rows\.push\(r\);\s*\n\s*onRow\?\.\(r\);/, "add pushes then reports - never calls itself");
  assert.ok(!/rows\.push\(\s*\n?\s*row\(/.test(doctor), "every check goes through add(), so every check streams");
  assert.ok((doctor.match(/\badd\(/g) ?? []).length > 20, "all the checks stream, not a couple");
  assert.match(doctor, /export function renderRow/);
  assert.match(doctor, /export function renderSummary/);

  // The CLI prints them live, and only --json stays silent so it stays parseable.
  const bin = fs.readFileSync(pkg("bin", "omni-agent.mjs"), "utf8");
  const cmd = bin.slice(bin.indexOf('case "doctor":'), bin.indexOf('case "usage":'));
  assert.match(cmd, /onRow: asJson \? undefined : \(r\) => say\(renderRow\(r\)\)/);
  assert.match(cmd, /ensureReady\(\{ quiet: asJson \}\)/, "the gateway's own slow start is narrated too");

  // And the shortcut goes through a .cmd that pauses.
  const doc = fs.readFileSync(pkg("installer", "OmniAgentDoctor.cmd"), "utf8");
  assert.match(doc, /omni-agent\.mjs" doctor/);
  assert.match(doc, /\npause\r?\n/, "the console must wait before closing");
  const iss = fs.readFileSync(pkg("installer", "omni-agent.iss"), "utf8");
  assert.match(iss, /Source: "OmniAgentDoctor\.cmd";/, "the .cmd is installed");
  assert.match(
    iss,
    /Name: "\{group\}\\Check \{#AppName\} health"; Filename: "\{app\}\\OmniAgentDoctor\.cmd"/,
    "the shortcut runs the .cmd, not node.exe directly",
  );
});

test("a stored gateway token is verified before it is trusted", () => {
  // 🔴 Why a VALID OpenRouter key answered "unauthorized". The gateway's admin
  // password and the database that validates it can get out of step, and when
  // they do the stored token is refused by every /api/* call - including the
  // one that adds a provider key. provisionGatewayToken returned
  // {ok:true, reused:true} the moment a token existed, so the repair path right
  // below it (reset the password with OmniRoute's own tool, restart, re-mint)
  // was unreachable and the install stayed broken forever.
  // Measured 2026-09-02 on a real install; verified self-healing after the fix.
  const prov = fs.readFileSync(pkg("src", "gateway", "provision.mjs"), "utf8");
  assert.match(prov, /async function tokenStillWorks\(\)/);
  assert.match(
    prov,
    /if \(existing && \(await tokenStillWorks\(\)\)\) return \{ ok: true, reused: true \}/,
    "a token is reused only after the gateway has accepted it",
  );
  assert.match(prov, /the stored gateway token is no longer accepted; re-provisioning/);
  // Only an auth refusal condemns the token - a gateway that is down or
  // rate-limiting says nothing about the credential.
  assert.match(
    prov,
    /err instanceof HttpError && \(err\.status === 401 \|\| err\.status === 403\)\) return false/,
    "only an auth refusal condemns the token",
  );
  assert.match(prov, /return true;\s*\n\s*\}\s*\n\}/, "any other error leaves the token alone");
  // And a lockout is explained rather than reported as a raw status code.
  assert.match(prov, /the gateway is rate-limiting sign-in attempts/);
  assert.ok(!/429[\s\S]{0,200}delete/i.test(prov), "a rate limit must never advise deleting the data directory");
});
