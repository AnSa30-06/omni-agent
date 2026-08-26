// The browser, as seen by whatever is calling it.
//
// Under Node this is `browser.mjs`, unchanged and in-process. Under OpenCode's
// embedded Bun it is the same API forwarded over loopback HTTP to a Node host,
// because Playwright cannot reach Chromium from that runtime at all - see the
// header of browser-host.mjs for the measurements.
//
// Everything that runs inside the plugin imports from here. Nothing else needs
// to know which side of that line it is on.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as local from "./browser.mjs";
import { PATHS, pkg, ensureDirs } from "../util/paths.mjs";
import { nodeExe, IS_BUN } from "../util/node-exe.mjs";
import { logger } from "../util/log.mjs";

const log = logger("browser-proxy");

const HANDSHAKE_FILE = path.join(PATHS.home, "browser-host.json");
const START_TIMEOUT_MS = 30_000;

/** Same list the host allows, and for the same reason: no dispatch by arbitrary name. */
const METHODS = [
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
];

let handshake = null;
let starting = null;

async function alive(h) {
  if (!h?.port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

function readHandshakeFile() {
  try {
    return JSON.parse(fs.readFileSync(HANDSHAKE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function spawnHost() {
  const exe = nodeExe();
  if (!exe) {
    throw new Error(
      "the browser needs a Node.js runtime and none was found. Re-run setup, or install Node.js and try again."
    );
  }
  ensureDirs();
  const script = pkg("src", "tools", "browser-host.mjs");
  const child = spawn(exe, [script], {
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: PATHS.browsers,
      OMNI_AGENT_HOME: PATHS.home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });

  const line = await new Promise((resolve, reject) => {
    let buf = "";
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`the browser host did not start within ${START_TIMEOUT_MS / 1000}s. ${err.slice(-300)}`)),
      START_TIMEOUT_MS
    );
    child.stdout.on("data", (b) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        resolve(buf.slice(0, nl));
      }
    });
    child.stderr.on("data", (b) => {
      err += b.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser host exited with code ${code}. ${err.slice(-300)}`));
    });
  });

  const h = JSON.parse(line);
  fs.writeFileSync(HANDSHAKE_FILE, JSON.stringify(h), { mode: 0o600 });
  // Let this process exit without waiting for the host; the host idles out on
  // its own after fifteen minutes.
  child.unref();
  log.info("started browser host", { port: h.port, pid: h.pid });
  return h;
}

async function ensureHost() {
  if (await alive(handshake)) return handshake;

  // A second plugin instance in the same run should join the first one's host
  // rather than start a browser of its own.
  const onDisk = readHandshakeFile();
  if (await alive(onDisk)) {
    handshake = onDisk;
    return handshake;
  }

  starting ??= spawnHost().finally(() => {
    starting = null;
  });
  handshake = await starting;
  return handshake;
}

async function callHost(method, args) {
  const h = await ensureHost();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${h.port}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-omni-token": h.token },
      body: JSON.stringify({ method, args }),
    });
  } catch (err) {
    // The host died between the health check and the call.
    handshake = null;
    throw new Error(`the browser host stopped responding: ${err.message}`);
  }
  if (!res.ok) throw new Error(`browser host returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.ok) return body.value;
  const e = new Error(body.error);
  e.name = body.name ?? "Error";
  throw e;
}

const remote = Object.fromEntries(METHODS.map((m) => [m, (...args) => callHost(m, args)]));

/** True when browser work is being forwarded to a separate Node process. */
export const isRemote = IS_BUN;

// chromiumInstalled is a filesystem check with no browser in it, so it answers
// the same in either runtime and never needs the host.
export const chromiumInstalled = local.chromiumInstalled;

export const launch = IS_BUN ? remote.launch : local.launch;
export const close = IS_BUN ? remote.close : local.close;
export const snapshot = IS_BUN ? remote.snapshot : local.snapshot;
export const navigate = IS_BUN ? remote.navigate : local.navigate;
export const goBack = IS_BUN ? remote.goBack : local.goBack;
export const goForward = IS_BUN ? remote.goForward : local.goForward;
export const newTab = IS_BUN ? remote.newTab : local.newTab;
export const selectTab = IS_BUN ? remote.selectTab : local.selectTab;
export const closeTab = IS_BUN ? remote.closeTab : local.closeTab;
export const listTabs = IS_BUN ? remote.listTabs : local.listTabs;
export const click = IS_BUN ? remote.click : local.click;
export const type = IS_BUN ? remote.type : local.type;
export const selectOption = IS_BUN ? remote.selectOption : local.selectOption;
export const setChecked = IS_BUN ? remote.setChecked : local.setChecked;
export const hover = IS_BUN ? remote.hover : local.hover;
export const pressKey = IS_BUN ? remote.pressKey : local.pressKey;
export const scroll = IS_BUN ? remote.scroll : local.scroll;
export const uploadFile = IS_BUN ? remote.uploadFile : local.uploadFile;
export const waitFor = IS_BUN ? remote.waitFor : local.waitFor;
export const extract = IS_BUN ? remote.extract : local.extract;
export const screenshot = IS_BUN ? remote.screenshot : local.screenshot;
export const downloadVia = IS_BUN ? remote.downloadVia : local.downloadVia;
export const renderPage = IS_BUN ? remote.renderPage : local.renderPage;
