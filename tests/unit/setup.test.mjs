// The setup wizard's prompt, which had a silent-success failure in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import { makeAsk } from "../../src/setup/wizard.mjs";
import { pkg } from "../../src/util/paths.mjs";

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
