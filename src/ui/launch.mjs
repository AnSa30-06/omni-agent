// Starting the desktop app.
//
// The window opens FIRST and shows what is happening; the gateway and the
// agent are started after it. Before this the order was gateway, then agent,
// then window, which is right for the wiring (see bringUp) and wrong for the
// person waiting: measured 2026-09-02, the gateway took 28 s to answer on a
// cold start and the agent 3 s more, and for all of that the exe put nothing
// on screen. That reads as "it did not work", and the natural response -
// double-click again - started a second copy of everything. Now the page is up
// in well under a second and shows each step as it happens (see startup.mjs).
//
// Inside bringUp the order is still load-bearing: the OmniRoute plugin
// registers this product's models by asking the gateway for them when OpenCode
// boots; if the gateway is not up yet the plugin registers nothing, OpenCode
// silently falls back to its own provider, and the user gets "Model
// x-preview-f-free is not supported" on their first message. Measured
// 2026-08-27 - so the gateway starts first and the agent server second, always.
import path from "node:path";
import { ensureRunning } from "../gateway/supervisor.mjs";
import { applyConfig } from "../setup/apply-config.mjs";
import { provisionGatewayToken } from "../gateway/provision.mjs";
import { start as startAgent, stop as stopAgent } from "./opencode-server.mjs";
import { startServer, stopServer, uiUrl } from "./server.mjs";
import { openWindow } from "./window.mjs";
import { startArchiver, stopArchiver } from "./transcripts.mjs";
import { startScheduler, stopScheduler } from "./routines.mjs";
import { loadConfig } from "../config.mjs";
import { PATHS } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { startupBegin, startupStep, startupProblem, startupReady, onRetry, retry as retryStartup } from "./startup.mjs";

const log = logger("ui/launch");

const STEPS = [
  { id: "gateway", label: "Starting the model gateway" },
  { id: "agent", label: "Starting the agent" },
];

// Reset to 0 by a successful bringUp. An agent that crashes is restarted a few
// times; past that it is almost certainly a real fault, so the page is shown a
// problem it can act on instead of a restart loop nobody can see.
let agentCrashes = 0;

/** What to do when `opencode serve` dies on its own after the app was running. */
function onAgentExit(code, say) {
  agentCrashes += 1;
  if (agentCrashes <= 3) {
    say(`The agent stopped unexpectedly (code ${code}); restarting it...`);
    // retryStartup re-runs bringUp through the onRetry hook, which re-shows the
    // startup screen; the page is already polling /x/status via recover().
    retryStartup();
  } else {
    startupBegin(STEPS);
    startupStep("gateway", "done");
    startupStep("agent", "failed", "it keeps stopping");
    startupProblem({
      title: "The agent keeps stopping",
      detail:
        "It has stopped several times in a row. Your conversations are safe. " +
        "Try again restarts it; if it keeps happening, close Omni Agent and open it again, " +
        "or run \"Check Omni Agent health\" from the Start Menu.",
      action: "retry",
      actionLabel: "Try again",
    });
  }
}

/**
 * "The parts it downloads after installing were never downloaded."
 *
 * The third form is the agent binary being named but not there - a half-deleted
 * install, or a runtime folder an antivirus quarantined - which surfaces as an
 * ENOENT from spawn rather than as "not installed".
 */
function componentsMissing(reason) {
  return /omniroute-not-installed|OpenCode is not installed|opencode.*ENOENT/i.test(String(reason ?? ""));
}

/**
 * What the page says when a step fails - written for someone who cannot fix
 * a computer, with the one thing they can actually do about it. The exe used
 * to raise a dialog telling them to run a package-manager command.
 */
function problemFor(reason, detail) {
  if (componentsMissing(reason)) {
    return {
      title: "Omni Agent has not finished setting itself up",
      detail:
        "The parts it downloads after installing are missing. Finishing setup downloads them " +
        "(about 3 GB, one time) and can take 10-30 minutes. It opens in its own window; come " +
        "back here when it says it is ready.",
      action: "setup",
      actionLabel: "Finish setup",
    };
  }
  if (/start-timeout/.test(String(reason ?? ""))) {
    return {
      title: "The model gateway is taking too long to start",
      detail:
        "It usually answers within a minute; this time it did not within three. Trying again " +
        `often works. Details: ${path.join(PATHS.logs, "gateway.log")}`,
      action: "retry",
      actionLabel: "Try again",
    };
  }
  const tail = detail ? "\n" + String(detail).split("\n").slice(-4).join("\n") : "";
  return {
    title: "Omni Agent could not start",
    detail: `${String(reason ?? "unknown reason")}${tail}\n\nDetails are in ${PATHS.logs}`,
    action: "retry",
    actionLabel: "Try again",
  };
}

/**
 * Start the gateway and then the agent, reporting each step to the page.
 * Idempotent: ensureRunning and startAgent both return early when their
 * process is already up, so a retry only redoes what failed.
 */
async function bringUp(say) {
  startupBegin(STEPS);

  startupStep("gateway", "running");
  say("Starting the model gateway...");
  const gw = await ensureRunning({
    onProgress: (m) => {
      say("  " + m);
      startupStep("gateway", "running", m.trim());
    },
  });
  if (gw.ok === false) {
    say(`  The gateway did not start: ${gw.reason}`);
    log.error("gateway failed", gw);
    startupStep("gateway", "failed", gw.reason);
    startupProblem(problemFor(gw.reason, gw.detail));
    return { ok: false, reason: gw.reason };
  }
  startupStep("gateway", "done");

  // A gateway that is up but has no credential leaves OpenCode with no models
  // for the same reason, so make sure one exists before the agent boots.
  const prov = await provisionGatewayToken();
  if (!prov.ok) say(`  Could not create a gateway credential: ${prov.reason}`);
  if (!loadConfig().configured) {
    say("  First run: writing configuration...");
    await applyConfig();
  }

  startupStep("agent", "running");
  say("Starting the agent...");
  const agent = await startAgent({ onProgress: (m) => say("  " + m), onExit: (code) => onAgentExit(code, say) });
  if (!agent.ok) {
    say(`  The agent server did not start: ${agent.reason}`);
    if (agent.remedy) say(`  ${agent.remedy}`);
    log.error("agent failed", agent);
    startupStep("agent", "failed", agent.reason);
    startupProblem(problemFor(agent.reason, agent.detail));
    return { ok: false, reason: agent.reason };
  }
  startupStep("agent", "done");

  startArchiver();
  startScheduler();
  agentCrashes = 0;
  startupReady();
  return { ok: true };
}

/**
 * @param {{onProgress?:(m:string)=>void, open?:boolean}} [opts]
 */
export async function launchUI(opts = {}) {
  const say = opts.onProgress ?? (() => {});

  // The window first, so there is something to look at while the slow parts
  // start. The page polls the startup state and boots itself when it is ready.
  say("Starting the interface...");
  startupBegin(STEPS);
  const ui = await startServer();
  const url = uiUrl();

  const shutdown = () => {
    stopArchiver();
    stopScheduler();
    stopServer();
    stopAgent();
  };

  if (opts.open === false) {
    say("  Not opening a window. Use this address in any browser:");
    say(`    ${url}`);
  } else {
    const w = openWindow(url);
    if (!w.ok) {
      say(`  Could not open a window: ${w.reason}`);
      say("  Open this address in any browser instead:");
      say(`    ${url}`);
    } else if (w.degraded) {
      say("  Opened in your default browser instead of its own window,");
      say(`  because ${w.reason}.`);
      if (w.remedy) say(`  ${w.remedy}`);
      say(`    ${url}`);
    } else {
      say(`  Omni Agent is open (via ${w.via}).`);
      // Closing the window closes the app. Without this the agent server and
      // the UI server keep running after the user thinks they have quit, which
      // is exactly the complaint people have about local web apps.
      //
      // The gateway is deliberately NOT stopped: it takes half a minute to
      // boot, `ensureRunning` is idempotent, and the CLI shares it. It runs
      // with no window and is stopped with `omni-agent gateway stop`.
      const openedAt = Date.now();
      w.child?.once?.("exit", () => {
        // A browser launched against a profile that is already open hands the
        // window to the existing process and exits immediately. Treating that
        // as "the user closed the app" would quit a second after starting, so
        // only a process that actually lived counts as the window's lifetime.
        if (Date.now() - openedAt < 8000) {
          say("  (the window is being hosted by an existing browser process)");
          return;
        }
        shutdown();
        process.exit(0);
      });
    }
  }
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  // "Try again" on the startup screen runs this same sequence.
  onRetry(() => bringUp(say));

  const r = await bringUp(say);
  log.info("ui launched", { url: ui.port, ready: r.ok });
  // Deliberately ok:true even when a step failed: the window is open and is
  // showing the problem with a way out, which is the point. ok:false is
  // reserved for "no page could be served at all" - the case the exe turns
  // into a dialog because there is nothing else it can do.
  return { ok: true, url, port: ui.port, shutdown, ready: r.ok, reason: r.ok ? null : r.reason };
}
