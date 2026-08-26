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
import { spawn } from "node:child_process";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig, gatewayBaseUrl } from "../config.mjs";
import { locateOmniRoute } from "./locate.mjs";
import { GatewayClient } from "./client.mjs";

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
export async function ensureRunning({ onProgress = () => {} } = {}) {
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
  const child = spawn(
    process.execPath,
    [found.entry, "serve", "--port", String(cfg.gateway.port), "--no-open", "--no-tray"],
    {
      cwd: PATHS.gatewayData,
      env: {
        ...process.env,
        DATA_DIR: PATHS.gatewayData,
        PORT: String(cfg.gateway.port),
        OMNIROUTE_BASE_URL: baseUrl,
        // Stop the child inheriting a parent's key and auto-authenticating.
        OMNIROUTE_API_KEY: "",
        NODE_ENV: "production",
      },
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    }
  );
  child.unref();
  fs.writeFileSync(PID_FILE(), String(child.pid));
  log.info("spawned gateway", { pid: child.pid, port: cfg.gateway.port, version: found.version });

  const deadline = Date.now() + cfg.gateway.startTimeoutMs;
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (await client.isUp(2_000)) {
      onProgress("Model gateway is up.");
      return { started: true, baseUrl, pid: child.pid, version: found.version, ok: true };
    }
    if (!alive(child.pid)) {
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

/** Stop a gateway this process (or a previous run) started. */
export async function stop() {
  const pid = readPid();
  if (!alive(pid)) return { stopped: false, reason: "not-running" };
  try {
    process.kill(pid);
  } catch (err) {
    return { stopped: false, reason: err.message };
  }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  try {
    fs.unlinkSync(PID_FILE());
  } catch {}
  return { stopped: true, pid };
}

export function status() {
  const pid = readPid();
  return { pid, running: alive(pid), dataDir: PATHS.gatewayData, envFile: ENV_FILE() };
}
