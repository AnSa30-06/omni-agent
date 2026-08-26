#!/usr/bin/env node
// Omni Agent launcher.
//
// With no arguments this is the thing a desktop shortcut runs: make sure the
// gateway is up, make sure configuration exists, then hand over to OpenCode
// with our isolated config directory.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PATHS, ensureDirs } from "../src/util/paths.mjs";
import { loadConfig, updateConfig, gatewayBaseUrl } from "../src/config.mjs";
import { ensureRunning, stop as stopGateway, status as gatewayStatus } from "../src/gateway/supervisor.mjs";
import { locateOpenCode } from "../src/gateway/locate.mjs";
import { writeOpenCodeConfig, opencodeEnv, ocConfigDir } from "../src/setup/opencode-config.mjs";
import { runSetup, installBrowser } from "../src/setup/wizard.mjs";
import { runDoctor, renderDoctor } from "../src/setup/doctor.mjs";
import { buildDashboard, renderDashboard } from "../src/usage/dashboard.mjs";
import { getCatalogue } from "../src/routing/catalog.mjs";
import { selectModel, PRESETS } from "../src/routing/select.mjs";
import { setSecret, listSecretNames } from "../src/util/secrets.mjs";
import { ADAPTERS } from "../src/providers/usage-adapters.mjs";
import { exportDiagnostics } from "../src/util/diagnostics.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const say = (s = "") => process.stdout.write(s + "\n");

const [, , cmd = "start", ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

function usage() {
  say(`
Omni Agent ${VERSION}

  omni-agent [folder]        Start the agent (default). Opens OpenCode.
  omni-agent setup           First-run setup wizard
  omni-agent doctor          Check that everything works
  omni-agent usage           Show model, quota and token usage
  omni-agent models          List the models available right now
  omni-agent route           Show which model would be chosen and why

  omni-agent gateway start|stop|status
  omni-agent config mode <fast|balanced|smart|quality|cheap>
  omni-agent config key <provider> <api-key>
  omni-agent config management-key <key>
  omni-agent config show
  omni-agent diagnostics                Export a sanitised diagnostics bundle

Options
  --non-interactive   Never prompt (for installers and CI)
  --browser           setup: only (re)install the browser engine
  --quick             doctor: skip the slow live probes
  --json              machine-readable output where supported
`);
}

async function ensureReady({ quiet = false } = {}) {
  ensureDirs();
  const cfg = loadConfig();
  if (!fs.existsSync(path.join(ocConfigDir(), "opencode.json"))) {
    if (!quiet) say("First run: writing configuration...");
    writeOpenCodeConfig();
  }
  const gw = await ensureRunning({ onProgress: quiet ? () => {} : (m) => say(m) });
  return { cfg, gw };
}

async function start() {
  const oc = locateOpenCode();
  if (!oc) {
    say("OpenCode is not installed.");
    say("Install it with:  npm install -g opencode-ai");
    process.exit(1);
  }
  const { gw } = await ensureReady();
  if (gw.ok === false) {
    say("");
    say(`The model gateway did not start (${gw.reason}).`);
    say(`Log: ${path.join(PATHS.logs, "gateway.log")}`);
    say("Run `omni-agent doctor` for details. Starting anyway - models will not work.");
    say("");
  }

  const workspace = args[0] ? path.resolve(args[0]) : PATHS.workspace;
  fs.mkdirSync(workspace, { recursive: true });

  // locateOpenCode prefers the real .exe, which takes argv directly. Only a
  // .cmd shim needs a shell, and going through one mangles arguments.
  const isCmd = /\.cmd$/i.test(oc);
  const child = spawn(isCmd ? `"${oc}"` : oc, [workspace], {
    cwd: workspace,
    env: opencodeEnv(),
    stdio: "inherit",
    shell: isCmd,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    say(`Could not start OpenCode: ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      return usage();

    case "version":
    case "--version":
    case "-v":
      return say(VERSION);

    case "setup": {
      if (flags.has("--browser")) {
        const r = await installBrowser();
        say(r.ok ? "Browser engine installed." : `Failed: ${r.reason}`);
        return process.exit(r.ok ? 0 : 1);
      }
      const r = await runSetup({ interactive: !flags.has("--non-interactive") });
      return process.exit(r.ok ? 0 : 1);
    }

    case "doctor": {
      await ensureReady({ quiet: true }).catch(() => {});
      const result = await runDoctor({ deep: !flags.has("--quick") });
      if (flags.has("--json")) say(JSON.stringify(result, null, 2));
      else say(renderDoctor(result));
      return process.exit(result.ok ? 0 : 1);
    }

    case "usage": {
      const d = await buildDashboard();
      if (flags.has("--json")) say(JSON.stringify(d, null, 2));
      else say("\n" + renderDashboard(d) + "\n");
      return;
    }

    case "models": {
      await ensureReady({ quiet: true });
      const cat = await getCatalogue({ force: true });
      if (flags.has("--json")) return say(JSON.stringify(cat, null, 2));
      say("");
      say("Capability and speed tiers are LOCAL ESTIMATES from this product, not benchmarks.");
      say("Throughput appears only where this machine has measured it.");
      say("");
      const fmt = (m) =>
        `  ${m.id.padEnd(34)} ${String(m.capabilityTier ?? "unrated").padEnd(12)} ${String(m.speedTier ?? "-").padEnd(10)}` +
        `${m.capabilities.toolCalling ? " tools" : "      "}${m.capabilities.vision ? " vision" : ""}` +
        `${m.observed?.outputTokensPerSec != null ? `  ${m.observed.outputTokensPerSec} tok/s` : ""}`;
      say(`AUTOMATIC ROUTING (${cat.filter((m) => m.isCombo).length}):`);
      cat.filter((m) => m.isCombo).forEach((m) => say(fmt(m)));
      say("");
      say(`SPECIFIC MODELS (${cat.filter((m) => !m.isCombo).length}):`);
      cat.filter((m) => !m.isCombo).forEach((m) => say(fmt(m)));
      say("");
      return;
    }

    case "route": {
      await ensureReady({ quiet: true });
      const cat = await getCatalogue();
      say("");
      for (const task of ["classify", "summarise", "code", "plan", "reason"]) {
        const r = await selectModel({ task, needsTools: true, catalogue: cat });
        say(`  ${task.padEnd(10)} -> ${String(r.model).padEnd(26)} (${r.via})`);
      }
      say("");
      say(`  Mode: ${loadConfig().routing.mode}`);
      say("");
      return;
    }

    case "gateway": {
      const sub = args[0] ?? "status";
      if (sub === "start") {
        const r = await ensureRunning({ onProgress: say });
        say(JSON.stringify(r, null, 2));
        return process.exit(r.ok === false ? 1 : 0);
      }
      if (sub === "stop") return say(JSON.stringify(await stopGateway(), null, 2));
      const s = gatewayStatus();
      say(JSON.stringify({ ...s, baseUrl: gatewayBaseUrl() }, null, 2));
      return;
    }

    case "config": {
      const sub = args[0];
      if (sub === "mode") {
        const mode = args[1];
        if (!PRESETS[mode]) {
          say(`Unknown mode "${mode}". Choose one of: ${Object.keys(PRESETS).join(", ")}`);
          return process.exit(1);
        }
        updateConfig({ routing: { ...loadConfig().routing, mode } });
        return say(`Routing mode set to ${PRESETS[mode].label}.`);
      }
      if (sub === "key") {
        const [provider, key] = [args[1], args[2]];
        const a = ADAPTERS[provider];
        if (!a) {
          say(`Unknown provider "${provider}". Choose one of: ${Object.keys(ADAPTERS).join(", ")}`);
          return process.exit(1);
        }
        if (!key) {
          say("Usage: omni-agent config key <provider> <api-key>");
          return process.exit(1);
        }
        setSecret(a.secretName, key);
        return say(`Stored ${a.label} key (encrypted for this Windows account).`);
      }
      if (sub === "management-key") {
        if (!args[1]) {
          say("Usage: omni-agent config management-key <key>");
          return process.exit(1);
        }
        setSecret("omniroute.managementKey", args[1]);
        return say("Stored gateway management key. Quota figures will now be read live.");
      }
      if (sub === "show") {
        const cfg = loadConfig();
        say(JSON.stringify(cfg, null, 2));
        say("");
        say(`Credentials stored (names only): ${listSecretNames().join(", ") || "none"}`);
        return;
      }
      say("Usage: omni-agent config <mode|key|management-key|show> ...");
      return process.exit(1);
    }

    case "diagnostics": {
      const r = await exportDiagnostics();
      say(`Diagnostics written to: ${r.path}`);
      say("Secrets are redacted. Check it before sharing.");
      return;
    }

    case "start":
      return start();

    default:
      // `omni-agent ./some/folder` should just start there.
      if (!cmd.startsWith("-") && fs.existsSync(cmd)) {
        args.unshift(cmd);
        return start();
      }
      say(`Unknown command: ${cmd}`);
      usage();
      return process.exit(1);
  }
}

main().catch((err) => {
  say(`\nError: ${err.message}`);
  if (process.env.OMNI_AGENT_DEBUG) say(err.stack);
  say(`\nRun \`omni-agent doctor\` to diagnose, or \`omni-agent diagnostics\` to export a report.`);
  process.exit(1);
});
