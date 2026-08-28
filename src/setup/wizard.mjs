// First-run setup.
//
// Written for someone who has never opened a terminal on purpose. Every step
// either succeeds visibly or explains what to do; nothing fails silently, and
// nothing asks a question whose answer the program can work out for itself.
//
// The single most important property: THE AGENT WORKS WITHOUT ANY API KEY. The
// gateway serves free, no-credential models out of the box. Keys are offered as
// an upgrade for speed and higher limits, never as a gate.
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { PATHS, ensureDirs, pkg } from "../util/paths.mjs";
import { loadConfig, updateConfig } from "../config.mjs";
import { listSecretNames } from "../util/secrets.mjs";
import { ensureRunning, ensureGatewayEnv } from "../gateway/supervisor.mjs";
import { applyConfig } from "./apply-config.mjs";
import { catalogue as providerCatalogue, addModelProvider, addSearchKey } from "./providers.mjs";
import { setSaving, TIERS } from "../routing/compression.mjs";
import { provisionGatewayToken } from "../gateway/provision.mjs";
import { runDoctor, renderDoctor } from "./doctor.mjs";
import { PRESETS } from "../routing/select.mjs";
import { logger } from "../util/log.mjs";
import { nodeExe } from "../util/node-exe.mjs";

const log = logger("wizard");

const say = (s = "") => stdout.write(s + "\n");
const rule = () => say("-".repeat(66));

export async function installBrowser({ onProgress = say } = {}) {
  ensureDirs();
  const cli = pkg("node_modules", "playwright-core", "cli.js");
  if (!fs.existsSync(cli)) {
    return { ok: false, reason: "playwright-core is not installed; run npm install in the app directory" };
  }
  onProgress("Downloading the browser engine (about 150 MB, one time)...");
  return new Promise((resolve) => {
    const child = spawn(nodeExe() ?? process.execPath, [cli, "install", "chromium"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PATHS.browsers },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    const cap = (b) => {
      tail = (tail + b.toString()).slice(-2000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => {
      if (code === 0) {
        onProgress("Browser engine installed.");
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: `browser download exited ${code}`, detail: tail });
      }
    });
    child.on("error", (err) => resolve({ ok: false, reason: err.message }));
  });
}

/** Returned by the race below when stdin ended instead of answering. */
const CLOSED = Symbol("stdin-closed");

/**
 * A prompt that survives a stdin which is already at end-of-file.
 *
 * 🔴 THE BUG THIS EXISTS FOR, and it is not the obvious one. `rl.question()`
 * against a stdin that is already at EOF does not throw and does not resolve -
 * the interface emits 'close' and the promise is simply left PENDING FOREVER.
 * With nothing else keeping the loop alive, Node then exits normally, with
 * status 0. Measured 2026-08-28 on the shipped 1.1.0 build: `omni-agent setup`
 * printed its welcome banner, stopped at "Press Enter to continue...", and
 * exited 0 having installed nothing and having reported no error anywhere.
 *
 * A silent success for work that was never done is the worst failure this
 * product can produce, so the question is raced against the interface closing
 * and a dead stdin simply yields the default.
 *
 * ⚠️ One shared close-promise, created once. Attaching a listener per call
 * leaks them and trips the max-listeners warning on a wizard that asks a
 * dozen questions.
 *
 * @param {import("node:readline/promises").Interface|null} rl
 * @returns {(q: string, dflt?: string) => Promise<string>}
 */
export function makeAsk(rl) {
  if (!rl) return async (_q, dflt = "") => dflt;
  let closed = false;
  const onClosed = new Promise((resolve) => {
    rl.once("close", () => {
      closed = true;
      resolve(CLOSED);
    });
  });
  return async (q, dflt = "") => {
    if (closed) return dflt;
    const a = await Promise.race([rl.question(q), onClosed]);
    return a === CLOSED ? dflt : String(a).trim() || dflt;
  };
}

/**
 * @param {{interactive?:boolean, skipBrowser?:boolean, skipDoctor?:boolean}} [opts]
 */
export async function runSetup(opts = {}) {
  const interactive = opts.interactive ?? stdin.isTTY === true;
  ensureDirs();
  const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;
  const ask = makeAsk(rl);

  try {
    say();
    rule();
    say("  Welcome to Omni Agent");
    rule();
    say();
    say("  This sets up an AI agent that can write code, browse the web, do");
    say("  research, fill in web forms and work with your documents.");
    say();
    say("  It works straight away with free models, so you do not need an");
    say("  API key. You can add one later for more speed.");
    say();
    if (interactive) {
      await ask("  Press Enter to continue... ");
      // stdin.isTTY is true under Git Bash on Windows even when stdin delivers
      // EOF immediately, so "interactive" can be wrong. Say so rather than
      // silently answering every question on the user's behalf.
      if (rl?.closed) {
        say();
        say("  (no keyboard input available - continuing with the defaults)");
      }
    }

    // --- 1. Providers ------------------------------------------------------
    const enabled = [];
    if (interactive) {
      say();
      rule();
      say("  STEP 1 of 6   Your AI models");
      rule();
      say();
      say("  The agent already works with no key at all. Everything below is an");
      say("  upgrade: more models, more speed, higher limits - and every one of");
      say("  these has a genuinely free tier that needs no card.");
      say();
      say("  Skip all of it now and run `omni-agent provider` whenever you like.");
      say();
      const freeCat = providerCatalogue();
      // The three worth a non-technical person's time on first run. The full
      // list of fifteen is one command away, and putting it all here would turn
      // setup into a form.
      for (const id of ["cerebras", "groq", "openrouter"]) {
        const entry = freeCat.models.find((m) => m.id === id);
        if (!entry) continue;
        say(`  ${entry.label} - ${entry.gives}`);
        if (entry.signup) say(`    Free key: ${entry.signup}`);
        const key = await ask("    Paste the key (Enter to skip): ");
        if (key) {
          const r = await addModelProvider(id, key);
          say(r.ok ? "    Connected." : `    Could not connect: ${r.reason}`);
          if (r.ok) enabled.push(id);
        }
        say();
      }

      say("  Web search works without a key too, but the free endpoints throttle");
      say("  a machine that searches a lot. A free search key removes that.");
      say();
      const brave = freeCat.search.find((x) => x.id === "brave");
      if (brave) {
        say(`  ${brave.label} - ${brave.gives}`);
        say(`    Free key: ${brave.signup}`);
        const key = await ask("    Paste the key (Enter to skip): ");
        if (key) {
          const r = addSearchKey("brave", key);
          say(r.ok ? "    Saved, encrypted for this Windows account." : `    ${r.reason}`);
        }
        say();
      }

      say("  If you already PAY for Claude, ChatGPT, Copilot, Cursor or Gemini,");
      say("  you can sign in and use that subscription instead - nothing is");
      say("  charged twice. Run `omni-agent provider signin <name>` when ready.");
      if (!enabled.length) say("\n  Nothing added. The free models will be used.");
    }
    updateConfig({ providers: { enabled } });

    // --- 2. Routing --------------------------------------------------------
    let mode = loadConfig().routing.mode;
    if (interactive) {
      say();
      rule();
      say("  STEP 2 of 6   How should the agent pick a model?");
      rule();
      say();
      const keys = Object.keys(PRESETS);
      keys.forEach((k, i) => say(`  ${i + 1}. ${PRESETS[k].label.padEnd(16)} ${PRESETS[k].description}`));
      say();
      const pick = await ask(`  Choose 1-${keys.length} [2 = Balanced]: `, "2");
      const idx = Number(pick) - 1;
      mode = keys[idx] ?? "balanced";
      say(`  Using: ${PRESETS[mode].label}`);
    }
    updateConfig({ routing: { ...loadConfig().routing, mode } });

    // --- 3. Permissions ----------------------------------------------------
    let profile = loadConfig().permissions.profile;
    if (interactive) {
      const all = JSON.parse(fs.readFileSync(pkg("config", "permissions.json"), "utf8"));
      say();
      rule();
      say("  STEP 3 of 6   How much should it ask before acting?");
      rule();
      say();
      const keys = Object.keys(all.profiles);
      keys.forEach((k, i) => {
        say(`  ${i + 1}. ${all.profiles[k].label}`);
        say(`     ${all.profiles[k].description}`);
        say();
      });
      const pick = await ask(`  Choose 1-${keys.length} [1 = Standard]: `, "1");
      profile = keys[Number(pick) - 1] ?? "standard";
      say(`  Using: ${all.profiles[profile].label}`);
      say();
      say("  Regardless of this setting, the agent always stops and asks before");
      say("  submitting a web form, sending anything, buying anything or deleting");
      say("  anything. That cannot be switched off.");
    }
    updateConfig({ permissions: { profile } });

    // --- 4. Components -----------------------------------------------------
    say();
    rule();
    say("  STEP 4 of 6   Installing components");
    rule();
    say();

    ensureGatewayEnv();

    if (!opts.skipBrowser) {
      const { chromiumInstalled } = await import("../tools/browser.mjs");
      if (chromiumInstalled()) {
        say("  Browser engine: already installed.");
      } else {
        const r = await installBrowser({ onProgress: (m) => say("  " + m) });
        if (!r.ok) {
          say(`  Browser engine FAILED: ${r.reason}`);
          say("  Browser tasks will not work. Re-run: omni-agent setup --browser");
          log.error("browser install failed", r);
        }
      }
    }

    say("  Starting the model gateway...");
    const gw = await ensureRunning({ onProgress: (m) => say("  " + m) });
    if (gw.ok === false) {
      say(`  Gateway FAILED to start: ${gw.reason}`);
      if (gw.detail) say("  " + String(gw.detail).split("\n").slice(-4).join("\n  "));
      say(`  Log: ${PATHS.logs}\\gateway.log`);
    } else {
      say(`  Gateway ready at ${gw.baseUrl}`);
    }

    // Must happen while the gateway is up, and before the OpenCode config is
    // written, because the OmniRoute plugin only registers its provider when it
    // finds a key in auth.json.
    say("  Creating gateway credentials...");
    const prov = await provisionGatewayToken();
    if (prov.ok) {
      say(prov.reused ? "  Reusing the existing gateway credential." : `  Gateway credential created (${prov.scope} scope).`);
    } else {
      say(`  Could not create a gateway credential: ${prov.reason}`);
      if (prov.remedy) say(`  ${prov.remedy}`);
      say("  OpenCode will not see any models until this succeeds.");
    }

    // --- 4. Token saving ---------------------------------------------------
    //
    // Deliberately AFTER the gateway is up and credentialed, because setting it
    // is an authenticated call to the gateway. Asked late, applied immediately.
    let savingTier = "tools";
    if (interactive && prov.ok) {
      say();
      rule();
      say("  STEP 5 of 6   Saving tokens");
      rule();
      say();
      say("  Free models come with limits. The gateway can compress what gets");
      say("  sent so the same work costs far fewer tokens. Code, links and");
      say("  structured data are never touched, whichever you pick.");
      say();
      say("  1. Tool output only   Shrinks command, test and search output.");
      say("                        Your conversation is untouched. Recommended.");
      say("  2. Maximum            Compresses the conversation as well. Saves");
      say("                        the most; replies get noticeably terse.");
      say("  3. Off                Send everything exactly as written.");
      say();
      const pick = await ask("  Choose 1-3 [1]: ", "1");
      savingTier = { "1": "tools", "2": "max", "3": "off" }[pick] ?? "tools";
    }
    if (prov.ok) {
      const sv = await setSaving(savingTier);
      const t = TIERS.find((x) => x.id === savingTier);
      say(sv.ok ? `  Token saving: ${t?.label ?? savingTier}.` : `  Could not set token saving: ${sv.reason}`);
    }

    say("  Writing configuration...");
    const wrote = await applyConfig();
    say(`  Configuration written. ${wrote.skills} skills installed.`);
    say(`  Model gateway wired into OpenCode: ${wrote.omnirouteWired && wrote.authWritten ? "yes" : "NO"}`);
    say(wrote.model ? `  The agent will run on: ${wrote.model}` : "  Agent model: OpenCode will choose (gateway was unreachable)");

    // --- 5. Verify ---------------------------------------------------------
    if (!opts.skipDoctor) {
      say();
      rule();
      say("  STEP 6 of 6   Checking everything works");
      rule();
      say("  (this runs a real model request and launches a real browser)");
      const result = await runDoctor({ deep: true });
      say(renderDoctor(result));
      updateConfig({ configured: result.ok });
      if (!result.ok) {
        say("  Setup finished with failures. Fix the items above, then run:");
        say("    omni-agent doctor");
        return { ok: false, doctor: result };
      }
    } else {
      updateConfig({ configured: true });
    }

    say();
    rule();
    say("  Ready.");
    rule();
    say();
    say("  Start the agent with:   omni-agent");
    say("  Check quota and usage:  omni-agent usage");
    say("  Re-run these checks:    omni-agent doctor");
    say();
    say(`  Your files live in: ${PATHS.home}`);
    if (listSecretNames().length) say(`  Credentials stored (encrypted): ${listSecretNames().join(", ")}`);
    say();
    return { ok: true };
  } finally {
    rl?.close();
  }
}
