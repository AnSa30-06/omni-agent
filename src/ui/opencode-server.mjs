// The agent, as a server instead of a terminal.
//
// OpenCode ships two front ends for the same engine: a TUI, and `opencode
// serve` - a headless HTTP server with 188 routes covering sessions, messages,
// streaming events, agents, models, permissions, skills, MCP and a PTY. The
// desktop UI is a client of that server, which is why it is a real interface
// and not a screen-scrape of a terminal.
//
// SECURITY. `opencode serve` prints "server is unsecured" when it starts
// without a password, and that warning is right: it binds a loopback port that
// any local process - or any web page the user has open, via a plain form POST
// - can reach. So we always set OPENCODE_SERVER_PASSWORD to a value generated
// fresh for this launch. The browser never learns it: src/ui/server.mjs holds
// it and attaches it server-side.
//
// The scheme is HTTP Basic and the USERNAME IS LOAD-BEARING: it must be exactly
// "opencode". Measured 2026-08-27 - "omni", "admin", "user" and an empty
// username all return 401 against the correct password, and bearer and
// x-opencode-password are rejected outright. (I first wrote "any username"
// after testing exactly one, which cost an hour of debugging a 401 that looked
// like the password was not reaching the child at all.)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { opencodeEnv } from "../setup/opencode-config.mjs";
import { locateOpenCode } from "../gateway/locate.mjs";
import { logger } from "../util/log.mjs";

const log = logger("ui/opencode");

let _state = null;
// Set while stop() is running, so the exit handler can tell a deliberate
// shutdown from a crash and only report the crash.
let _stopping = false;

/** A port nothing is using, by letting the OS pick and immediately releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Basic credentials for the running server, or null when it is not up. */
export function credentials() {
  if (!_state) return null;
  return {
    baseUrl: _state.baseUrl,
    header: "Basic " + Buffer.from(`opencode:${_state.password}`).toString("base64"),
  };
}

export function running() {
  return !!_state && !_state.child.killed;
}

/**
 * Start `opencode serve` and wait until it answers.
 *
 * @param {{workspace?:string, onProgress?:(m:string)=>void}} [opts]
 */
export async function start(opts = {}) {
  if (_state) return { ok: true, baseUrl: _state.baseUrl, reused: true };
  ensureDirs();
  _stopping = false;
  const onProgress = opts.onProgress ?? (() => {});

  const exe = locateOpenCode();
  if (!exe) {
    return {
      ok: false,
      reason: "OpenCode is not installed",
      remedy: "Install it with:  npm install -g opencode-ai",
    };
  }

  const workspace = opts.workspace ?? PATHS.workspace;
  fs.mkdirSync(workspace, { recursive: true });

  const password = crypto.randomBytes(24).toString("base64url");
  // Ask the OS for a free port and hand opencode that exact number. `--port 0`
  // looks like it means "pick one" and does not: measured 2026-08-27 it lands
  // on the default 4096 every time, so two copies of the app would collide and
  // the second would talk to the first one's server with the wrong password.
  // The port is still re-read from stdout afterwards rather than assumed.
  const port = await freePort();
  const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
  const isCmd = /\.cmd$/i.test(exe);
  const child = spawn(isCmd ? `"${exe}"` : exe, args, {
    cwd: workspace,
    env: opencodeEnv({ OPENCODE_SERVER_PASSWORD: password }),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isCmd,
    windowsHide: true,
  });

  const logFile = path.join(PATHS.logs, "opencode-server.log");
  const sink = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(sink);
  child.stderr.pipe(sink);

  const baseUrl = await new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const scan = (b) => {
      buf += b.toString();
      // "opencode server listening on http://127.0.0.1:53124"
      const m = buf.match(/listening on (http:\/\/[\d.]+:\d+)/i);
      if (m) finish(m[1]);
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => finish({ error: `opencode serve exited ${code}` }));
    child.on("error", (err) => finish({ error: err.message }));
    setTimeout(() => finish({ error: "opencode serve did not report a port within 60s" }), 60_000);
  });

  if (typeof baseUrl !== "string") {
    try {
      child.kill();
    } catch {}
    let tail = "";
    try {
      tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-6).join("\n");
    } catch {}
    return { ok: false, reason: baseUrl.error, detail: tail };
  }

  _state = { child, baseUrl, password, workspace, onExit: opts.onExit };
  child.on("exit", (code) => {
    const wasDeliberate = _stopping;
    const onExit = _state?.onExit;
    _state = null;
    _stopping = false;
    if (wasDeliberate) {
      log.info("opencode serve stopped");
    } else {
      // The agent died on its own - a crash, an OOM, being ended from Task
      // Manager. The launcher restarts it and the page re-shows its startup
      // screen; without this hook the page would 503 every call forever and
      // look permanently blank. Measured 2026-09-02.
      log.warn("opencode serve exited unexpectedly", { code });
      onExit?.(code);
    }
  });

  onProgress(`Agent server ready at ${baseUrl}`);
  log.info("opencode serve started", { baseUrl, workspace });
  return { ok: true, baseUrl };
}

/**
 * Stop the agent and start it again.
 *
 * 🔴 The reason adding an API key appeared to do nothing. OpenCode learns this
 * product's models from the OmniRoute plugin, and that plugin force-syncs them
 * only when it BOOTS. Its five-minute auto-sync does not notice a new provider:
 * measured 2026-09-02, an app that had been running 21 minutes after a key was
 * added still offered the 119 models it had cached before it, so the picker's
 * "From your keys" was empty while the gateway was holding 995 of them. The
 * key worked; the list the reader was looking at was simply old.
 *
 * ⚠️ stop() only ASKS the process to go. The exit handler is what clears
 * `_state`, and start() returns `{reused:true}` while `_state` is still set -
 * so starting immediately after stopping is a no-op. Hence the wait.
 */
export async function restart(opts = {}) {
  if (!_state) return start(opts);
  const workspace = _state.workspace;
  stop();
  for (let i = 0; i < 100 && _state; i++) await new Promise((r) => setTimeout(r, 100));
  return start({ workspace, ...opts });
}

export function stop() {
  if (!_state) return;
  // Deliberate: the exit handler must NOT treat this as a crash and restart.
  // _state is cleared by that handler, which then sees _stopping.
  _stopping = true;
  try {
    _state.child.kill();
  } catch {}
}

/** Call the agent server with authentication attached. */
export async function oc(method, pathname, body, extra = {}) {
  const c = credentials();
  if (!c) return { ok: false, status: 0, reason: "the agent server is not running" };
  const headers = { authorization: c.header, ...(extra.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const r = await fetch(c.baseUrl + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: extra.signal ?? AbortSignal.timeout(extra.timeoutMs ?? 30_000),
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) return { ok: false, status: r.status, reason: data?.message ?? `HTTP ${r.status}`, data };
    return { ok: true, status: r.status, data };
  } catch (err) {
    return { ok: false, status: 0, reason: err.message };
  }
}
