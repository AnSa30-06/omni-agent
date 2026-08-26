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
import { setSecret, getSecret, listSecretNames } from "../util/secrets.mjs";
import { ensureRunning, ensureGatewayEnv } from "../gateway/supervisor.mjs";
import { writeOpenCodeConfig, writeOpenCodeAuth } from "./opencode-config.mjs";
import { provisionGatewayToken } from "../gateway/provision.mjs";
import { runDoctor, renderDoctor } from "./doctor.mjs";
import { ADAPTERS } from "../providers/usage-adapters.mjs";
import { PRESETS } from "../routing/select.mjs";
import { logger } from "../util/log.mjs";

const log = logger("wizard");

const say = (s = "") => stdout.write(s + "\n");
const rule = () => say("-".repeat(66));

/** Providers offered in setup, in the order a user is likely to have them. */
const OFFERED = ["anthropic", "openai", "google", "deepseek", "moonshot", "openrouter"];

export async function installBrowser({ onProgress = say } = {}) {
  ensureDirs();
  const cli = pkg("node_modules", "playwright-core", "cli.js");
  if (!fs.existsSync(cli)) {
    return { ok: false, reason: "playwright-core is not installed; run npm install in the app directory" };
  }
  onProgress("Downloading the browser engine (about 150 MB, one time)...");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
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

/**
 * @param {{interactive?:boolean, skipBrowser?:boolean, skipDoctor?:boolean}} [opts]
 */
export async function runSetup(opts = {}) {
  const interactive = opts.interactive ?? stdin.isTTY === true;
  ensureDirs();
  const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;
  const ask = async (q, dflt = "") => {
    if (!rl) return dflt;
    const a = (await rl.question(q)).trim();
    return a || dflt;
  };

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
    if (interactive) await ask("  Press Enter to continue... ");

    // --- 1. Providers ------------------------------------------------------
    const enabled = [];
    if (interactive) {
      say();
      rule();
      say("  STEP 1 of 5   Your AI models");
      rule();
      say();
      say("  If you already pay for an AI service, entering the key here makes");
      say("  the agent noticeably faster. Leave every one blank to use the free");
      say("  models - the agent works either way.");
      say();
      for (const id of OFFERED) {
        const a = ADAPTERS[id];
        const key = await ask(`  ${a.label} API key (Enter to skip): `);
        if (key) {
          setSecret(a.secretName, key);
          enabled.push(id);
          say(`    Saved. Stored encrypted for your Windows account only.`);
        }
      }
      if (!enabled.length) say("\n  No keys entered. Using the free models.");
    }
    updateConfig({ providers: { enabled } });

    // --- 2. Routing --------------------------------------------------------
    let mode = loadConfig().routing.mode;
    if (interactive) {
      say();
      rule();
      say("  STEP 2 of 5   How should the agent pick a model?");
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
      say("  STEP 3 of 5   How much should it ask before acting?");
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
    say("  STEP 4 of 5   Installing components");
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

    say("  Writing configuration...");
    const wrote = writeOpenCodeConfig();
    const auth = writeOpenCodeAuth(getSecret("omniroute.apiKey"));
    say(`  Configuration written. ${wrote.skills} skills installed.`);
    say(`  Model gateway wired into OpenCode: ${wrote.omnirouteWired && auth.written ? "yes" : "NO"}`);

    // --- 5. Verify ---------------------------------------------------------
    if (!opts.skipDoctor) {
      say();
      rule();
      say("  STEP 5 of 5   Checking everything works");
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
