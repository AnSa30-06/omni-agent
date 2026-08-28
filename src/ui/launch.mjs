// Starting the desktop app, in the order the pieces actually depend on.
//
// The order is not cosmetic. The OmniRoute plugin registers this product's
// models by asking the gateway for them when OpenCode boots; if the gateway is
// not up yet the plugin registers nothing, OpenCode silently falls back to its
// own provider, and the user gets "Model x-preview-f-free is not supported" on
// their first message. Measured 2026-08-27 - so the gateway starts first and
// the agent server second, always.
import { ensureRunning } from "../gateway/supervisor.mjs";
import { applyConfig } from "../setup/apply-config.mjs";
import { provisionGatewayToken } from "../gateway/provision.mjs";
import { start as startAgent, stop as stopAgent } from "./opencode-server.mjs";
import { startServer, stopServer, uiUrl } from "./server.mjs";
import { openWindow } from "./window.mjs";
import { startArchiver, stopArchiver } from "./transcripts.mjs";
import { startScheduler, stopScheduler } from "./routines.mjs";
import { loadConfig } from "../config.mjs";
import { logger } from "../util/log.mjs";

const log = logger("ui/launch");

/**
 * @param {{onProgress?:(m:string)=>void, open?:boolean}} [opts]
 */
export async function launchUI(opts = {}) {
  const say = opts.onProgress ?? (() => {});

  say("Starting the model gateway...");
  const gw = await ensureRunning({ onProgress: (m) => say("  " + m) });
  if (gw.ok === false) {
    say(`  The gateway did not start: ${gw.reason}`);
    say("  The app will open, but no models will answer until this is fixed.");
    log.error("gateway failed", gw);
  }

  // A gateway that is up but has no credential leaves OpenCode with no models
  // for the same reason, so make sure one exists before the agent boots.
  const prov = await provisionGatewayToken();
  if (!prov.ok) say(`  Could not create a gateway credential: ${prov.reason}`);
  if (!loadConfig().configured) {
    say("  First run: writing configuration...");
    await applyConfig();
  }

  say("Starting the agent...");
  const agent = await startAgent({ onProgress: (m) => say("  " + m) });
  if (!agent.ok) {
    say(`  The agent server did not start: ${agent.reason}`);
    if (agent.remedy) say(`  ${agent.remedy}`);
    return { ok: false, reason: agent.reason };
  }

  say("Starting the interface...");
  const ui = await startServer();
  startArchiver();
  startScheduler();

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

  log.info("ui launched", { url: ui.port });
  return { ok: true, url, port: ui.port, shutdown };
}
