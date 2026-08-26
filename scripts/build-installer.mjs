// Build OmniAgentSetup-<version>.exe.
//
// Stages a private Node.js runtime plus this application (source and its own
// node_modules) into installer/../staging, then invokes Inno Setup.
//
// What is bundled and what is not, and why - measured installed sizes:
//   bundled     Node.js runtime          ~80 MB   nothing preinstalled required
//   bundled     omni-agent + deps        ~180 MB  offline-installable, no npm flakiness
//   downloaded  omniroute                2.7 GB   far too large to ship
//   downloaded  opencode-ai              514 MB   too large to ship
//   downloaded  Chromium                 701 MB   too large to ship
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { APP_ROOT } from "../src/util/paths.mjs";

const say = (s = "") => process.stdout.write(s + "\n");

// Pinned to the runtime everything in this repo was actually verified against.
const NODE_VERSION = process.env.OMNI_AGENT_NODE_VERSION || "v24.18.0";
const ARCH = "x64";
const NODE_DIR_NAME = `node-${NODE_VERSION}-win-${ARCH}`;
const NODE_ZIP = `${NODE_DIR_NAME}.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;

const CACHE = path.join(os.tmpdir(), "omni-agent-build-cache");
const STAGING = path.join(APP_ROOT, "staging");
const DIST = path.join(APP_ROOT, "dist");

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version;

function iscc() {
  const candidates = [
    process.env.ISCC_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Fetch the Node runtime and VERIFY it against nodejs.org's own SHASUMS. */
async function fetchNode() {
  const zip = path.join(CACHE, NODE_ZIP);
  if (!fs.existsSync(zip)) {
    say(`  Downloading ${NODE_URL} ...`);
    await download(NODE_URL, zip);
  } else {
    say(`  Using cached ${NODE_ZIP}`);
  }

  say("  Verifying checksum against nodejs.org SHASUMS256.txt ...");
  const sums = await (await fetch(SHASUMS_URL)).text();
  const expected = sums.split("\n").find((l) => l.trim().endsWith(NODE_ZIP))?.trim().split(/\s+/)[0];
  if (!expected) throw new Error(`no published checksum for ${NODE_ZIP}`);
  const actual = sha256(zip);
  if (actual !== expected) {
    fs.rmSync(zip, { force: true });
    throw new Error(`checksum mismatch for ${NODE_ZIP}\n  expected ${expected}\n  got      ${actual}`);
  }
  say("  Checksum OK.");

  const extracted = path.join(CACHE, NODE_DIR_NAME);
  if (!fs.existsSync(extracted)) {
    say("  Extracting Node runtime ...");
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Path '${zip}' -DestinationPath '${CACHE}' -Force`],
      { stdio: "inherit", windowsHide: true }
    );
    if (r.status !== 0) throw new Error("failed to extract the Node runtime");
  }
  return extracted;
}

/** Files that make up the application. Deliberately explicit - no stray output. */
const APP_INCLUDE = [
  "package.json",
  "LICENSE",
  "README.md",
  "bin",
  "src",
  "plugin",
  "config",
  "skills",
  "scripts",
  "node_modules",
  "installer/assets",
];

const EXCLUDE_DIRS = new Set([".git", ".scratch", "dist", "staging", "tests", "runtime", ".github"]);

function copyApp(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of APP_INCLUDE) {
    const src = path.join(APP_ROOT, rel);
    if (!fs.existsSync(src)) {
      say(`  (skipping missing ${rel})`);
      continue;
    }
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(src, target, {
      recursive: true,
      filter: (s) => {
        const base = path.basename(s);
        if (EXCLUDE_DIRS.has(base)) return false;
        // Never ship a credential or a local env file, whatever it is called.
        if (/^\.env($|\.)/.test(base)) return false;
        if (base === "credentials.dat" || base === "config.json") return false;
        return true;
      },
    });
  }
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          total += fs.statSync(p).size;
        } catch {}
    }
  };
  walk(dir);
  return Math.round(total / 1048576);
}

async function main() {
  say("");
  say(`Building Omni Agent installer ${VERSION}`);
  say("");

  const compiler = iscc();
  if (!compiler) {
    say("Inno Setup 6 was not found.");
    say("Install it with:  winget install --id JRSoftware.InnoSetup");
    say("or set ISCC_PATH to ISCC.exe.");
    process.exit(1);
  }
  say(`  Compiler: ${compiler}`);

  say("");
  say("Staging Node runtime:");
  const nodeSrc = await fetchNode();

  say("");
  say("Staging application:");
  fs.rmSync(STAGING, { recursive: true, force: true });
  const appStage = path.join(STAGING, "app");
  const nodeStage = path.join(STAGING, "node");
  copyApp(appStage);
  fs.cpSync(nodeSrc, nodeStage, { recursive: true });
  say(`  app:  ${dirSizeMB(appStage)} MB`);
  say(`  node: ${dirSizeMB(nodeStage)} MB`);

  // A bundled runtime with no npm cannot bootstrap the gateway.
  const npmCli = path.join(nodeStage, "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) throw new Error("the staged Node runtime has no npm; the bootstrap step would fail");
  say("  npm present in the bundled runtime.");

  say("");
  say("Compiling installer:");
  fs.mkdirSync(DIST, { recursive: true });
  const r = spawnSync(compiler, [`/DAppVersion=${VERSION}`, path.join(APP_ROOT, "installer", "omni-agent.iss")], {
    cwd: path.join(APP_ROOT, "installer"),
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.status !== 0) {
    say("");
    say("Inno Setup failed.");
    process.exit(1);
  }

  const out = path.join(DIST, `OmniAgentSetup-${VERSION}.exe`);
  if (!fs.existsSync(out)) throw new Error(`installer was not produced at ${out}`);
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  say("");
  say(`Built: ${out}  (${mb} MB)`);
  say(`SHA256: ${sha256(out)}`);
  say("");
}

main().catch((err) => {
  say(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
