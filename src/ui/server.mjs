// The desktop UI's own server.
//
// Three jobs:
//   1. serve the app (src/ui/public) - plain files, no build step, matching the
//      rest of this codebase
//   2. proxy /oc/* to `opencode serve`, attaching the Basic credential so the
//      browser never holds it - including the SSE streams, which is what makes
//      replies appear a token at a time
//   3. serve /x/* - everything this product knows that OpenCode does not:
//      the gateway, token saving, free providers, search tools, settings,
//      transcripts, routines and the dashboard
//
// SECURITY. A loopback HTTP server is reachable by every page in every browser
// on this machine, so two things are checked on every request: a per-launch
// token that only our own window is given, and a Host header that is actually
// loopback (which is what stops a DNS-rebinding page from talking to us). The
// token arrives once in the URL that opens the window and is then kept in the
// page; it is never written to disk.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { credentials, oc, start as startOpencode, stop as stopOpencode } from "./opencode-server.mjs";
import { routes } from "./api.mjs";
import { logger } from "../util/log.mjs";

const log = logger("ui/server");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

let _server = null;
let _token = null;
let _port = 0;

export function uiUrl() {
  return _server ? `http://127.0.0.1:${_port}/?t=${_token}` : null;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // Nothing here should ever be embedded by another page or cached across
    // launches, and the token lives in the URL.
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/** Reject anything not addressed to loopback - this is what stops DNS rebinding. */
function loopback(req) {
  const host = (req.headers.host ?? "").split(":")[0];
  return host === "127.0.0.1" || host === "localhost";
}

function authorised(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!loopback(req)) return false;
  const t = url.searchParams.get("t") ?? req.headers["x-omni-token"];
  return typeof t === "string" && t.length > 0 && crypto.timingSafeEqual(Buffer.from(t.padEnd(64).slice(0, 64)), Buffer.from(_token.padEnd(64).slice(0, 64)));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    // A UI request is a prompt or a form, never a payload. The cap exists so a
    // stray upload cannot exhaust memory.
    if (size > 8 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pipe an OpenCode Server-Sent Events stream straight through to the page. */
async function proxyStream(req, res, target) {
  const c = credentials();
  if (!c) return send(res, 503, { error: "the agent server is not running" });
  const upstream = new AbortController();
  req.on("close", () => upstream.abort());
  try {
    const r = await fetch(c.baseUrl + target, {
      headers: { authorization: c.header, accept: "text/event-stream" },
      signal: upstream.signal,
    });
    res.writeHead(r.status, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (err) {
    if (err.name !== "AbortError") log.warn("stream ended", { error: err.message });
  } finally {
    try {
      res.end();
    } catch {}
  }
}

/** Forward an ordinary request to the agent server. */
async function proxyJson(req, res, target) {
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : undefined;
  const r = await oc(req.method, target, body, { timeoutMs: 120_000 });
  if (!r.ok && r.status === 0) return send(res, 503, { error: r.reason });
  send(res, r.status || (r.ok ? 200 : 500), r.data ?? { error: r.reason });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Resolve then confirm containment, so "..%2f" cannot escape the directory.
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: "forbidden" });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "not found" });
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    // The app is entirely self-contained; nothing may be loaded from the web.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' http://127.0.0.1:*",
  });
  res.end(fs.readFileSync(file));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;

  // The token guards the API, not the shell. index.html/app.css/app.js carry no
  // secrets and can do nothing on their own, and the browser requests the two
  // subresources with no query string of their own - so requiring a token here
  // returned 401 for app.js and left a page that rendered but never booted.
  if (p.startsWith("/oc/") || p.startsWith("/x/")) {
    if (!authorised(req)) return send(res, 401, { error: "unauthorised" });
  } else if (!loopback(req)) {
    return send(res, 403, { error: "forbidden" });
  }

  if (p.startsWith("/oc/")) {
    const target = p.slice(3) + (url.search ? url.search.replace(/[?&]t=[^&]*/, "").replace(/^&/, "?") : "");
    if (p.endsWith("/event")) return proxyStream(req, res, target);
    return proxyJson(req, res, target);
  }

  if (p.startsWith("/x/")) {
    const name = p.slice(3);
    const fn = routes[name];
    if (!fn) return send(res, 404, { error: `unknown action "${name}"`, known: Object.keys(routes) });
    try {
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : undefined;
      const out = await fn({ body: body ?? {}, query: Object.fromEntries(url.searchParams), method: req.method });
      return send(res, out?.ok === false ? 400 : 200, out);
    } catch (err) {
      log.error("action failed", { name, error: err.message });
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  return serveStatic(res, p);
}

/**
 * Start the UI server. Does not open a window - see window.mjs.
 * @param {{port?:number}} [opts]
 */
export async function startServer(opts = {}) {
  if (_server) return { ok: true, url: uiUrl(), reused: true };
  _token = crypto.randomBytes(32).toString("base64url");
  _server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error("request failed", { url: req.url, error: err.message });
      try {
        send(res, 500, { error: err.message });
      } catch {}
    });
  });
  await new Promise((resolve, reject) => {
    _server.on("error", reject);
    _server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  _port = _server.address().port;
  log.info("ui server listening", { port: _port });
  return { ok: true, url: uiUrl(), port: _port };
}

export function stopServer() {
  try {
    _server?.close();
  } catch {}
  _server = null;
  stopOpencode();
}

export { startOpencode };
