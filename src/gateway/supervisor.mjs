// Owns the lifecycle of the bundled OmniRoute process.
//
// Two properties matter here:
//  1. Isolation. We set DATA_DIR to our own directory and use our own port, so
//     installing this product never disturbs a pre-existing `omniroute` install
//     (which keeps its data in ~/.omniroute on :20128).
//  2. Per-install secrets. The npm package ships a .env with default
//     JWT_SECRET / API_KEY_SECRET / STORAGE_ENCRYPTION_KEY values. Those are
//     fine for a local dev toy and wrong for a distribution, because every
//     install would share them. We generate our own on first run.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig, gatewayBaseUrl } from "../config.mjs";
import { locateOmniRoute } from "./locate.mjs";
import { GatewayClient } from "./client.mjs";
import { nodeExe } from "../util/node-exe.mjs";

const log = logger("supervisor");
const PID_FILE = () => path.join(PATHS.gatewayData, "omni-agent-gateway.pid");
const ENV_FILE = () => path.join(PATHS.gatewayData, ".env");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create the isolated instance's .env once. Returns the admin password so the
 * setup wizard can store it in the DPAPI credential store.
 */
export function ensureGatewayEnv() {
  ensureDirs();
  const file = ENV_FILE();
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    const pw = /^INITIAL_PASSWORD=(.*)$/m.exec(text)?.[1] ?? null;
    return { created: false, adminPassword: pw };
  }
  const rand = (n) => crypto.randomBytes(n).toString("base64url");
  const adminPassword = rand(18);
  const lines = [
    "# Generated per-install by omni-agent. Do not copy between machines.",
    `JWT_SECRET=${rand(32)}`,
    `API_KEY_SECRET=${rand(32)}`,
    `STORAGE_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`,
    "STORAGE_ENCRYPTION_KEY_VERSION=1",
    `INITIAL_PASSWORD=${adminPassword}`,
    `MACHINE_ID_SALT=${rand(16)}`,
    "REQUIRE_API_KEY=false",
    "NODE_ENV=production",
    "",
  ];
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  log.info("generated per-install gateway env");
  return { created: true, adminPassword };
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * The pid of the gateway process we started, recovered from the process list.
 *
 * Needed because the gateway is launched through `cmd start /B` (see below), so
 * the child handle we hold belongs to a cmd that has already exited. Without
 * this the pid file would hold a dead pid, `gateway status` would report "not
 * running" and `gateway stop` would be a silent no-op.
 *
 * ⚠️ It matches the LAUNCHER, not whatever holds the port. omniroute serves
 * from a worker child (`dist/server-ws.mjs`), and killing that worker does not
 * stop the gateway - measured 2026-08-28, the port was listening again under a
 * new pid within three seconds because the launcher simply started another one.
 * Killing the launcher does take the worker with it.
 *
 * The `--port` match is what keeps this off a pre-existing `omniroute` install
 * running on its own port.
 */
function gatewayPid(port) {
  if (process.platform !== "win32") return null;
  try {
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*omniroute*' -and $_.CommandLine -like '*--port ${port}*' } | ` +
      `Select-Object -First 1 -ExpandProperty ProcessId`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    const pid = Number(out.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the gateway if it is not already answering. Idempotent. */
/**
 * @param {{onProgress?: (msg: string) => void, startTimeoutMs?: number}} [opts]
 *   `startTimeoutMs` overrides the configured window. Needed after the database
 *   has been rebuilt: a fresh file runs every migration from scratch and takes
 *   far longer than an ordinary start, and the normal window expiring made the
 *   repair report a failure while the gateway was coming up perfectly well.
 */
export async function ensureRunning({ onProgress = () => {}, startTimeoutMs = null } = {}) {
  const cfg = loadConfig();
  const baseUrl = gatewayBaseUrl(cfg);
  const client = new GatewayClient({ baseUrl });

  if (await client.isUp()) return { started: false, baseUrl, reason: "already-running" };

  if (cfg.gateway.externalBaseUrl || process.env.OMNI_AGENT_GATEWAY_URL) {
    return { started: false, baseUrl, ok: false, reason: "external-gateway-unreachable" };
  }
  if (!cfg.gateway.autoStart) {
    return { started: false, baseUrl, ok: false, reason: "autostart-disabled" };
  }

  const found = locateOmniRoute();
  if (!found) {
    return { started: false, baseUrl, ok: false, reason: "omniroute-not-installed" };
  }

  ensureGatewayEnv();
  onProgress(`Starting model gateway on port ${cfg.gateway.port} (first run can take a minute)...`);

  const logFile = path.join(PATHS.logs, "gateway.log");
  const out = fs.openSync(logFile, "a");
  const node = nodeExe() ?? process.execPath;
  const gwArgs = [found.entry, "serve", "--port", String(cfg.gateway.port), "--no-open", "--no-tray"];
  // Started through `cmd /c start "" /B` on Windows, and that is not
  // decoration. Measured 2026-08-28:
  //   detached:true + windowsHide:true  -> survives the parent, but puts a real
  //                                        "omniroute (v16.2.12)" window on the
  //                                        desktop next to the app
  //   neither                           -> no window, but the gateway dies the
  //                                        moment the CLI that started it exits
  //   cmd start "" /B                   -> no window AND survives
  // The gateway has to outlive whatever started it, and it must not look like
  // a second application, so this is the only option that satisfies both.
  const viaCmd = process.platform === "win32";
  const child = spawn(
    viaCmd ? "cmd" : node,
    viaCmd ? ["/c", "start", "", "/B", node, ...gwArgs] : gwArgs,
    {
      cwd: PATHS.gatewayData,
      env: {
        ...process.env,
        // 🔴 OUR gateway's own secrets, set explicitly, BEFORE anything else
        // gets a chance to supply them. See ownEnv() for why this is the
        // difference between a working gateway and one that answers 500 to
        // every request it receives.
        ...ownEnv(),
        DATA_DIR: PATHS.gatewayData,
        PORT: String(cfg.gateway.port),
        OMNIROUTE_BASE_URL: baseUrl,
        // Stop the child inheriting a parent's key and auto-authenticating.
        OMNIROUTE_API_KEY: "",
        NODE_ENV: "production",
      },
      // The log file handles are inherited straight through cmd, so the
      // gateway's output still lands in gateway.log.
      stdio: ["ignore", out, out],
      windowsHide: true,
      detached: !viaCmd,
    }
  );
  child.unref();
  // `child.pid` is cmd's, and cmd exits immediately - writing it would make
  // `gateway status` report "not running" and `gateway stop` a no-op. The real
  // pid is resolved from the listening port once the gateway answers.
  log.info("spawned gateway", { port: cfg.gateway.port, version: found.version });

  const deadline = Date.now() + (startTimeoutMs ?? cfg.gateway.startTimeoutMs);
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (await client.isUp(2_000)) {
      const pid = gatewayPid(cfg.gateway.port) ?? child.pid;
      try {
        fs.writeFileSync(PID_FILE(), String(pid));
      } catch {}
      onProgress("Model gateway is up.");
      return { started: true, baseUrl, pid, version: found.version, ok: true };
    }
    // Only meaningful when we spawned the gateway directly; through cmd the
    // launcher is gone within milliseconds and says nothing about the gateway.
    if (!viaCmd && !alive(child.pid)) {
      const tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n");
      return { started: false, baseUrl, ok: false, reason: "gateway-exited", detail: tail };
    }
    if (Date.now() - lastNote > 15_000) {
      lastNote = Date.now();
      onProgress("  still starting...");
    }
    await sleep(1_500);
  }
  return { started: false, baseUrl, ok: false, reason: "start-timeout" };
}

/**
 * The gateway that is actually running, whatever the pid file claims.
 *
 * 🔴 The pid file lies, and it lies in the direction that does damage. A
 * gateway started by a different launch writes its own pid; when THAT process
 * is replaced, or the file is left behind by a crash, `readPid()` names a dead
 * process and every caller concludes nothing is running. Measured 2026-08-28:
 * `gateway stop` answered `{"stopped": false, "reason": "not-running"}` while
 * omniroute was serving on port 20129 - and the in-place upgrade that ran next
 * deadlocked on the files that live gateway was holding.
 *
 * So the pid file is a hint, and the process table is the authority.
 */
function livePid(cfg = loadConfig()) {
  const fromFile = readPid();
  if (alive(fromFile)) return fromFile;
  const found = gatewayPid(cfg.gateway.port);
  return alive(found) ? found : null;
}

/**
 * The gateway's own .env, read and handed to the child directly.
 *
 * ⚠️ HARDENING, not a fix for any observed failure - and the difference matters,
 * because the first version of this comment claimed it cured a gateway that
 * answered HTTP 500 to everything. It did not. That was a corrupt
 * `storage.sqlite`, and this change made no difference to it.
 *
 * What IS measured (2026-08-28): OmniRoute loads `~/.omniroute/.env` at
 * startup - the config directory of a SEPARATE, pre-existing OmniRoute install
 * that this product deliberately keeps out of - and on this machine that file's
 * `STORAGE_ENCRYPTION_KEY` differs from the one in our own gateway directory.
 * dotenv does not overwrite a variable that is already set, so which key wins
 * depends on load order.
 *
 * Putting our values in the CHILD's environment makes them the ones already
 * set, so nothing loaded from a file can replace them. It is the one place the
 * isolation promise in PATHS is actually enforced rather than just stated.
 */
function ownEnv() {
  const out = {};
  let text = "";
  try {
    text = fs.readFileSync(ENV_FILE(), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1).trim();
    // Quoted values are common in generated .env files.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Stop a gateway this process (or a previous run) started. */
export async function stop() {
  const pid = livePid();
  if (!pid) return { stopped: false, reason: "not-running" };
  try {
    process.kill(pid);
  } catch (err) {
    return { stopped: false, reason: err.message };
  }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  // The launcher restarts its worker within seconds, so a stop that killed the
  // launcher has to check the port again rather than trust one kill.
  const survivor = livePid();
  if (survivor && survivor !== pid) {
    try {
      process.kill(survivor);
    } catch {}
    for (let i = 0; i < 20 && alive(survivor); i++) await sleep(250);
  }
  try {
    fs.unlinkSync(PID_FILE());
  } catch {}
  return { stopped: true, pid };
}

export function status() {
  const pid = livePid();
  return { pid, running: pid !== null, dataDir: PATHS.gatewayData, envFile: ENV_FILE() };
}
