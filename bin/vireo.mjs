#!/usr/bin/env node
// Vireo launcher.
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
import { opencodeEnv, ocConfigDir } from "../src/setup/opencode-config.mjs";
import { applyConfig } from "../src/setup/apply-config.mjs";
import { runSetup, installBrowser } from "../src/setup/wizard.mjs";
import { runDoctor, renderDoctor, renderRow, renderSummary } from "../src/setup/doctor.mjs";
import { buildDashboard, renderDashboard } from "../src/usage/dashboard.mjs";
import { getCatalogue } from "../src/routing/catalog.mjs";
import { selectModel, PRESETS } from "../src/routing/select.mjs";
import { setSecret, listSecretNames } from "../src/util/secrets.mjs";
import { ADAPTERS } from "../src/providers/usage-adapters.mjs";
import { exportDiagnostics } from "../src/util/diagnostics.mjs";
import { PAGES, dashboardUrl, openInBrowser, copyToClipboard, password as dashPassword } from "../src/gateway/dashboard.mjs";
import { TIERS, getSaving, setSaving, measure, renderTiers, tier as findTier } from "../src/routing/compression.mjs";
import * as providers from "../src/setup/providers.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const say = (s = "") => process.stdout.write(s + "\n");

const [, , cmd = "start", ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

function usage() {
  say(`
Vireo ${VERSION}

  vireo ui              Open the Vireo desktop app (recommended)
  vireo [folder]        Start the agent in the terminal instead
  vireo setup           First-run setup wizard
  vireo doctor          Check that everything works
  vireo usage           Show model, quota and token usage
  vireo models          List the models available right now
  vireo route           Show which model would be chosen and why

  vireo provider [list]   Free providers you can add, and what each gives you
  vireo provider setup <id>    Step-by-step instructions for one provider
  vireo provider add <id> <key>
  vireo provider signin <id>
  vireo dashboard [page]  Open the gateway's own web dashboard
  vireo saving [tier]     Show or set how hard it compresses to save tokens
  vireo routine list      Scheduled routines
  vireo routine run <id>  Run one now

  vireo decisions         Open Decisions: turn customer data into decisions
  vireo decisions run     Run the analysis now, without opening a window
  vireo decisions seed [demo|demo-cohort|edge]   Load a demo company
  vireo decisions list    Show the open decisions

  vireo gateway start|stop|status
  vireo config mode <fast|balanced|smart|quality|cheap>
  vireo config key <provider> <api-key>
  vireo config management-key <key>
  vireo config show
  vireo diagnostics                Export a sanitised diagnostics bundle
  vireo bundle-key <provider> <key>   Ship a provider key inside your builds, so
                                      whoever you send this to has working
                                      models on first run. Never committed.
  vireo bundle-key show               Which providers are bundled (names only)
  vireo bundle-key clear              Remove the bundled key

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
  const gw = await ensureRunning({ onProgress: quiet ? () => {} : (m) => say(m) });
  // After the gateway, not before: applyConfig resolves the model the current
  // routing mode implies, and that needs a live catalogue.
  if (!fs.existsSync(path.join(ocConfigDir(), "opencode.json"))) {
    if (!quiet) say("First run: writing configuration...");
    await applyConfig();
  }
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
    say("Run `vireo doctor` for details. Starting anyway - models will not work.");
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
      const asJson = flags.has("--json");
      // Not quiet any more: starting the gateway is the longest silent phase of
      // all, and the supervisor already narrates it ("first run can take a
      // minute"). Only --json stays silent, so its output remains parseable.
      await ensureReady({ quiet: asJson }).catch(() => {});
      if (!asJson) {
        say("");
        say("OMNI AGENT HEALTH CHECK");
        say("");
      }
      const result = await runDoctor({
        deep: !flags.has("--quick"),
        onRow: asJson ? undefined : (r) => say(renderRow(r)),
      });
      // A passing doctor finishes what a rate-limited setup could not: mark the
      // install configured and remember the model that actually answered, so
      // the app stops printing "First run: writing configuration..." and starts
      // on a model this machine has proven works. Setup tells people to run
      // `vireo doctor` after a failure, and before this that never cleared
      // the failure state.
      if (result.ok) {
        updateConfig({ configured: true });
        if (result.servedModel) {
          const { rememberVerifiedModel } = await import("../src/ui/prefs.mjs");
          rememberVerifiedModel(result.servedModel);
        }
      }
      if (asJson) say(JSON.stringify(result, null, 2));
      else {
        // The rows already printed as they were checked; only the verdict is
        // left. renderDoctor still exists for callers that want it whole.
        say("");
        say(renderSummary(result));
      }
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
        say(`Routing mode set to ${PRESETS[mode].label}.`);
        // The mode only means something once the agent's pinned model changes
        // with it, and OpenCode reads its config at launch - it does not
        // hot-reload. So rewrite it now, and say plainly when it takes effect.
        const applied = await applyConfig();
        say(applied.model ? `The agent will run on: ${applied.model}` : "Could not reach the gateway; the model will be resolved at next start.");
        return say("Restart the agent for this to take effect.");
      }
      if (sub === "key") {
        const [provider, key] = [args[1], args[2]];
        const a = ADAPTERS[provider];
        if (!a) {
          say(`Unknown provider "${provider}". Choose one of: ${Object.keys(ADAPTERS).join(", ")}`);
          return process.exit(1);
        }
        if (!key) {
          say("Usage: vireo config key <provider> <api-key>");
          return process.exit(1);
        }
        setSecret(a.secretName, key);
        return say(`Stored ${a.label} key (encrypted for this Windows account).`);
      }
      if (sub === "management-key") {
        if (!args[1]) {
          say("Usage: vireo config management-key <key>");
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
      say("Usage: vireo config <mode|key|management-key|show> ...");
      return process.exit(1);
    }

    case "provider": {
      const sub = args[0] ?? "list";
      await ensureReady({ quiet: true });

      if (sub === "list") {
        const all = await providers.listAll();
        if (!all.gatewayReachable) {
          say(`The gateway is not reachable (${all.reason}), so what is already connected cannot be shown.`);
          say("");
        }
        say("");
        say(providers.render(all));
        return;
      }

      if (sub === "add") {
        const [id, key] = [args[1], args[2]];
        if (!id) {
          say("Usage: vireo provider add <id> <key>");
          return process.exit(1);
        }
        // A search key is a local secret, not a gateway connection.
        if (providers.catalogue().search.some((sp) => sp.id === id)) {
          const r = providers.addSearchKey(id, key);
          if (!r.ok) {
            say(`Could not store that key: ${r.reason}`);
            return process.exit(1);
          }
          say(`Stored the ${id} search key, encrypted for this Windows account.`);
          // Verified: availableProviders() filters the default order by which
          // credentials exist, and the keyed providers sit ahead of the keyless
          // ones - so storing the key is the whole job.
          say("It is now used FIRST for searches. No configuration to edit.");
          say("Check it with:  vireo doctor");
          return;
        }
        const r = await providers.addModelProvider(id, key);
        if (!r.ok) {
          say(`Could not add ${id}: ${r.reason}`);
          return process.exit(1);
        }
        say(`Added ${id}.`);
        if (r.connectionId) {
          say("Testing it with a real call...");
          const t = await providers.testConnection(r.connectionId);
          if (t.ok) {
            say("  It works.");
          } else {
            say(`  The gateway could not use it: ${t.error ?? t.reason ?? "no reason given"}`);
            if (t.remedy) say(`  ${t.remedy}`);
          }
        }
        say("Run `vireo models` to see what it added.");
        return;
      }

      if (sub === "setup") {
        const id = args[1];
        if (!id) {
          const cat = providers.catalogue();
          say("");
          say("Setup instructions are available for:");
          say("");
          say("  Web search:  " + cat.search.map((x) => x.id).join(", "));
          say("  No key:      " + (cat.keyless ?? []).map((x) => x.id).join(", "));
          say("  Models:      " + cat.models.map((x) => x.id).join(", "));
          say("  Sign-in:     " + cat.signIn.map((x) => x.id).join(", "));
          say("");
          say("  vireo provider setup <id>");
          return;
        }
        const st = providers.setupSteps(id);
        if (!st.ok) {
          say(st.reason);
          return process.exit(1);
        }
        say("");
        say(providers.renderSetup(st));
        say("");
        return;
      }

      if (sub === "signin") {
        const id = args[1];
        if (!id) {
          say("Usage: vireo provider signin <id>");
          return process.exit(1);
        }
        const u = await providers.signInUrl(id);
        if (!u.ok) {
          say(u.reason);
          return process.exit(1);
        }
        say("");
        say(`Sign in to ${id} in your browser:`);
        say(`  ${u.url}`);
        say("");
        say("  This uses a subscription you already pay for. Nothing is charged twice.");
        say("  Approve it yourself - this program will not click through a consent screen for you.");
        say("");
        const opened = openInBrowser(u.url);
        if (!opened.ok) say(`Could not open a browser automatically (${opened.reason}). Paste the URL above.`);
        say("When it is done, check with:  vireo provider list");
        return;
      }

      say("Usage: vireo provider <list|setup|add|signin> ...");
      return process.exit(1);
    }

    case "dashboard": {
      const page = args[0] ?? "home";
      const url = dashboardUrl(page);
      if (!url) {
        say(`Unknown page "${page}". Choose one of:`);
        for (const [k, v] of Object.entries(PAGES)) say(`  ${k.padEnd(12)} ${v.label}`);
        return process.exit(1);
      }
      const { gw } = await ensureReady({ quiet: true });
      if (gw.ok === false) {
        say(`The gateway is not running (${gw.reason}), so the dashboard has nothing to serve.`);
        say("Try `vireo gateway start`.");
        return process.exit(1);
      }
      const pw = dashPassword();
      say("");
      say(`Opening ${PAGES[page].label}`);
      say(`  ${url}`);
      say("");
      if (pw) {
        const copied = await copyToClipboard(pw);
        say("  It will ask for a password. This one was generated for you at setup:");
        say("");
        say(`      ${pw}`);
        say("");
        say(copied ? "  (copied to your clipboard)" : "  (select and copy it from above)");
        say("");
        say("  It is stored on this machine only, and the dashboard is not reachable");
        say("  from any other computer.");
      } else {
        say("  No dashboard password was found. Run `vireo setup --non-interactive` first.");
      }
      say("");
      const opened = openInBrowser(url);
      if (!opened.ok) say(`Could not open a browser automatically (${opened.reason}). Paste the URL above.`);
      return;
    }

    case "saving": {
      const wanted = args[0];
      if (wanted) {
        if (!findTier(wanted)) {
          say(`Unknown tier "${wanted}". Choose one of: ${TIERS.map((t) => t.id).join(", ")}`);
          return process.exit(1);
        }
        await ensureReady({ quiet: true });
        const r = await setSaving(wanted);
        if (!r.ok) {
          say(`Could not change the saving tier: ${r.reason}`);
          if (r.remedy) say(r.remedy);
          return process.exit(1);
        }
        say(`Token saving set to ${r.tier.label} (${r.tier.id}).`);
        say(`  ${r.tier.summary}`);
        say(`  ${r.tier.costs}`);
        say("");
        say("This applies to every request from now on, including the agent's own.");
        return;
      }
      await ensureReady({ quiet: true });
      const cur = await getSaving();
      if (!cur.ok) {
        say(`Could not read the current saving tier: ${cur.reason}`);
        if (cur.remedy) say(cur.remedy);
        return process.exit(1);
      }
      const measured = flags.has("--quick") ? null : await measure();
      say("");
      say(renderTiers({ current: cur.tier, measured }));
      say("");
      say("  Change it with:  vireo saving <tier>");
      return;
    }

    /**
     * A provider key that travels inside the build you hand to someone else.
     *
     * 🔴 It is written to a GITIGNORED file, and `tests/unit/bundled-key.test.mjs`
     * asserts that it stays ignored. This repository is public: a key committed
     * here is scraped within minutes, and `npm run scan:secrets` only reads what
     * git tracks, so an ignored file is invisible to it. The test is what closes
     * that gap.
     */
    case "bundle-key": {
      const bundled = await import("../src/setup/bundled-key.mjs");
      const sub = args[0];

      if (!sub || sub === "show") {
        const d = bundled.describe();
        const found = bundled.read();
        say("");
        if (!d.present) {
          say("  No key is bundled with this build.");
          say("");
          say("  Add one so whoever you send this to has working models immediately:");
          say("    vireo bundle-key mistral YOUR-KEY");
          say("");
          return;
        }
        // Names only. The value is never printed, the same rule `config show`
        // follows.
        say(`  Bundled providers: ${d.providers.join(", ")}`);
        say(`  File: ${found.file}`);
        say("");
        say("  This file is gitignored. It is copied into the installer and the");
        say("  portable zip when you build, and nowhere else.");
        say("");
        return;
      }

      if (sub === "clear") {
        const found = bundled.read();
        if (!found) {
          say("Nothing is bundled.");
          return;
        }
        fs.rmSync(found.file, { force: true });
        say(`Removed ${found.file}.`);
        return;
      }

      const [provider, key] = [args[0], args[1]];
      if (!provider || !key) {
        say("Usage: vireo bundle-key <provider> <key>");
        say("       vireo bundle-key show | clear");
        return process.exit(1);
      }
      const known = providers.catalogue().models.map((p) => p.id);
      if (!known.includes(provider)) {
        say(`"${provider}" is not one of the providers this knows about.`);
        say(`Choose one of: ${known.join(", ")}`);
        return process.exit(1);
      }

      // Prove it works BEFORE writing it, so a mistyped key is caught here
      // rather than on someone else's machine an hour later.
      say(`Checking the ${provider} key...`);
      const check = await providers.verifyModelProvider([], provider, key);
      if (check.state === "rejected") {
        say(`  ${provider} refused that key. Nothing was saved.`);
        say("  Check you copied the whole key and that it is still active.");
        return process.exit(1);
      }
      if (check.state !== "ok") {
        say(`  It could not be checked right now (${check.reason ?? "no answer"}).`);
        say("  Saving it anyway - this is usually the provider being busy, not a bad key.");
      } else {
        say("  It works.");
      }

      const existing = bundled.read()?.providers ?? [];
      const next = [...existing.filter((p) => p.id !== provider), { id: provider, key }];
      const dest = bundled.write(next);
      say("");
      say(`Bundled: ${next.map((p) => p.id).join(", ")}`);
      say(`Written to ${dest}`);
      say("");
      say("  This file is GITIGNORED and must stay that way - this repository is public.");
      say("  It is copied into the build by `npm run build:installer`, so the person");
      say("  you send the installer to gets working models with no setup at all.");
      say("");
      return;
    }

    case "diagnostics": {
      const r = await exportDiagnostics();
      say(`Diagnostics written to: ${r.path}`);
      say("Secrets are redacted. Check it before sharing.");
      return;
    }

    case "ui":
    case "app": {
      const { launchUI } = await import("../src/ui/launch.mjs");
      // --no-window starts everything and prints the address instead of
      // opening a window, for anyone who would rather use their own browser.
      const r = await launchUI({ onProgress: say, open: !flags.has("--no-window") });
      if (!r.ok) return process.exit(1);
      // Another copy owns this data directory; it has been asked to show its
      // window. Nothing was started here, so this process just ends.
      if (r.alreadyRunning) return process.exit(0);
      say("");
      if (r.ready === false) say("The start hit a problem. The window says what happened and what to do.");
      say("Vireo is open. Close the window when you are done.");
      say("Leave this running - closing it stops the agent.");
      // Nothing else to do; the HTTP servers hold the process open.
      return;
    }

    case "routine": {
      const sub = args[0];
      const routines = await import("../src/ui/routines.mjs");
      if (sub === "list") {
        for (const r of routines.list()) {
          say(`${r.enabled ? "[on] " : "[   ]"} ${r.id}  ${r.name}`);
          say(`        ${r.schedule.kind} ${r.schedule.at ?? ""} - next ${r.nextRun ? new Date(r.nextRun).toLocaleString() : "never"}`);
        }
        return;
      }
      if (sub === "run") {
        const id = args[1];
        if (!id) {
          say("Usage: vireo routine run <id>");
          return process.exit(1);
        }
        // Scheduled Tasks run this with no app open, so bring up what it needs.
        const { ensureRunning } = await import("../src/gateway/supervisor.mjs");
        await ensureRunning();
        const { start: startAgent, stop: stopAgent } = await import("../src/ui/opencode-server.mjs");
        const a = await startAgent();
        if (!a.ok) {
          say(`The agent server did not start: ${a.reason}`);
          return process.exit(1);
        }
        const r = await routines.run(id);
        say(r.ok ? `Started (session ${r.sessionID}).` : `Failed: ${r.reason}`);
        stopAgent();
        return process.exit(r.ok ? 0 : 1);
      }
      say("Usage: vireo routine [list|run <id>]");
      return process.exit(1);
    }

    case "decisions": {
      const sub = args[0] ?? "open";
      const ws = await import("../src/decisions/workspace.mjs");

      if (sub === "open") {
        // The window, straight onto the Decisions surface.
        const { launchUI } = await import("../src/ui/launch.mjs");
        const r = await launchUI({ onProgress: say, open: !flags.has("--no-window"), page: "decisions" });
        if (!r.ok) return process.exit(1);
        if (r.alreadyRunning) return process.exit(0);
        say("");
        say("Vireo is open on Decisions. Close the window when you are done.");
        return;
      }

      // Everything below is headless: no window, no agent, only the gateway
      // (and only when a model is actually needed).
      const { workspaces, selected } = ws.list();
      if (!selected && sub !== "seed") {
        say("There is no workspace yet. Run `vireo decisions seed` to load the demo company,");
        say("or open the app with `vireo decisions` and import your own data.");
        return process.exit(1);
      }

      if (sub === "seed") {
        const variantName = args[1] ?? "demo";
        let id = selected;
        if (!id) {
          const made = ws.create("Demo Company");
          if (!made.ok) {
            say(made.error);
            return process.exit(1);
          }
          id = made.workspace.id;
        }
        const { decisionRoutes } = await import("../src/decisions/routes.mjs");
        const r = await decisionRoutes.decisionsSeedDemo({ body: { variant: variantName } });
        if (!r.ok) {
          say(`Could not load the demo data: ${r.error}`);
          return process.exit(1);
        }
        say(`Loaded the "${variantName}" demo company: ${r.accounts} customers.`);
        say("Now run:  vireo decisions run");
        return;
      }

      if (sub === "run") {
        // --no-model runs the rules only, and the rules need no gateway. Starting
        // a 2.7 GB model gateway to compute percentages would be absurd.
        if (!flags.has("--no-model")) await ensureReady({ quiet: true });
        const { runAnalysis } = await import("../src/decisions/run.mjs");
        const db = ws.openWorkspace(selected);
        try {
          say("Analysing...");
          const r = await runAnalysis({
            db,
            noModel: flags.has("--no-model"),
            onProgress: (p) => {
              if (p.phase === "reasoning" && p.reasoned) process.stdout.write(`
  reasoning ${p.reasoned} of ${p.of}...   `);
            },
          });
          say("");
          if (!r.ok) {
            say(`The analysis failed: ${r.error}`);
            return process.exit(1);
          }
          const s2 = r.summary;
          say("");
          say(`  Customers checked      ${s2.accounts}`);
          say(`  Signals computed       ${s2.signals}`);
          say(`  Situations found       ${s2.candidates}`);
          say(`  Sent to a model        ${s2.reasoned}${s2.cached ? ` (${s2.cached} unchanged, so not sent)` : ""}`);
          say(`  Decisions created      ${s2.created}`);
          say(`  Decisions updated      ${s2.updated}`);
          if (s2.llmFailures) say(`  Model failures         ${s2.llmFailures} (those decisions were raised from the rules alone)`);
          say(`  Tokens                 ${s2.inputTokens + s2.outputTokens}${s2.model ? ` on ${s2.model}` : ""}`);
          if (s2.cohort) say(`  Company-wide change    usage ${s2.cohort.direction} for ${s2.cohort.share}% of customers`);
          say("");
          ws.touchRun(selected);
          return;
        } finally {
          db.close();
        }
      }

      if (sub === "list") {
        const db = ws.openWorkspace(selected);
        try {
          const rows = db
            .prepare("SELECT * FROM decision WHERE status NOT IN ('resolved','dismissed') ORDER BY severity, updated_at DESC")
            .all();
          if (!rows.length) {
            say("Nothing is waiting for a decision.");
            return;
          }
          say("");
          for (const d of rows) {
            say(`  [${String(d.severity).toUpperCase().padEnd(8)}] ${d.title}`);
            say(`             ${d.status}${d.owner ? ` · ${d.owner}` : ""}${d.due_at ? ` · due ${d.due_at}` : ""}`);
          }
          say("");
          return;
        } finally {
          db.close();
        }
      }

      if (sub === "eval") {
        const { main } = await import("../tests/eval/decisions/run-eval.mjs");
        const code = await main(rest);
        return process.exit(code);
      }

      say("Usage: vireo decisions [open|run|seed|list|eval]");
      return process.exit(1);
    }

    case "start":
      return start();

    default:
      // `vireo ./some/folder` should just start there.
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
  if (process.env.VIREO_DEBUG) say(err.stack);
  say(`\nRun \`vireo doctor\` to diagnose, or \`vireo diagnostics\` to export a report.`);
  process.exit(1);
});
