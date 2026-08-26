// A Node process that owns the browser and answers calls over loopback HTTP.
//
// WHY THIS EXISTS
//
// OpenCode plugins run inside OpenCode's embedded Bun (1.3.14, measured
// 2026-08-27). Playwright cannot drive Chromium from there. Both of its
// transports fail in the same place:
//
//   --remote-debugging-pipe   Chromium starts, logs normally, and the launch
//                             times out after 180s. Every time.
//   connectOverCDP(ws://...)  Chromium starts, prints "DevTools listening on
//                             ws://127.0.0.1:PORT/...", and Playwright hangs
//                             at "<ws connecting>" until the timeout.
//
// The second one localises the fault: spawning works, stdio works, the browser
// works - Playwright's WebSocket client cannot complete an upgrade handshake
// under that Bun build. (The same code launches in 6s under Node and in 10s
// under a standalone Bun 1.4.0, so this is a bug in the embedded version, not
// in Playwright and not in this product.)
//
// Plain HTTP from Bun is fine - web_fetch and web_search have always worked
// from the plugin - so the fix is to keep Playwright in a Node process and
// have the plugin talk to it over HTTP.
//
// The browser tool is the sixth priority in this product's specification. It
// working only when nobody is using it is not an acceptable state.
import http from "node:http";
import crypto from "node:crypto";
import * as browser from "./browser.mjs";
import { logger } from "../util/log.mjs";

const log = logger("browser-host");

// Explicit allowlist. Never dispatch by looking up an arbitrary name on the
// module - this endpoint takes its method name off the wire.
const METHODS = new Set([
  "launch",
  "close",
  "snapshot",
  "navigate",
  "goBack",
  "goForward",
  "newTab",
  "selectTab",
  "closeTab",
  "listTabs",
  "click",
  "type",
  "selectOption",
  "setChecked",
  "hover",
  "pressKey",
  "scroll",
  "uploadFile",
  "waitFor",
  "extract",
  "screenshot",
  "downloadVia",
  "renderPage",
]);

/** Shut down when nothing has called for this long, so no browser is left running. */
const IDLE_MS = 15 * 60 * 1000;

const token = crypto.randomBytes(24).toString("hex");
let idleTimer = null;

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    log.info("idle; shutting down");
    try {
      await browser.close();
    } catch {
      /* shutting down anyway */
    }
    process.exit(0);
  }, IDLE_MS);
  idleTimer.unref?.();
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  resetIdle();

  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, pid: process.pid });

  if (req.method !== "POST" || req.url !== "/call") return send(res, 404, { error: "not found" });

  // Constant-time compare so the token cannot be guessed a byte at a time.
  const supplied = Buffer.from(String(req.headers["x-omni-token"] ?? ""));
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return send(res, 401, { error: "unauthorised" });
  }

  let call;
  try {
    call = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, { error: `bad request: ${err.message}` });
  }

  const { method, args } = call ?? {};
  if (!METHODS.has(method)) return send(res, 400, { error: `unknown method: ${method}` });

  try {
    const value = await browser[method](...(Array.isArray(args) ? args : []));
    send(res, 200, { ok: true, value });
  } catch (err) {
    // The message matters to the model - it is what tells it to re-snapshot
    // after a stale ref, or that a submit needs confirming.
    send(res, 200, { ok: false, error: err?.message ?? String(err), name: err?.name ?? "Error" });
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // The client reads exactly this line, then stops reading stdout.
  process.stdout.write(JSON.stringify({ port, token, pid: process.pid }) + "\n");
  log.info("browser host listening", { port, pid: process.pid });
  resetIdle();
});

const shutdown = async () => {
  try {
    await browser.close();
  } catch {
    /* shutting down anyway */
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
