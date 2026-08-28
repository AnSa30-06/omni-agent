// Fetch the heavy components that are too large to ship inside the installer.
//
// Measured installed sizes, which is why these are downloaded rather than
// bundled: omniroute 2.7 GB, opencode-ai 514 MB, Chromium 701 MB. An installer
// carrying those would be unusable.
//
// They go into a PRIVATE prefix under the application directory, not into the
// machine's global npm root. A user who already has their own `omniroute` or
// `opencode` install keeps it, at their own version, untouched.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { APP_ROOT, pkg } from "../src/util/paths.mjs";

const say = (s = "") => process.stdout.write(s + "\n");

// Pinned so a surprise upstream release cannot break a fresh install. Bump
// these deliberately, after testing, rather than tracking latest.
const COMPONENTS = [
  { name: "omniroute", spec: "omniroute@3.8.49", label: "model gateway", approxMB: 2700 },
  { name: "opencode-ai", spec: "opencode-ai@1.18.23", label: "agent harness", approxMB: 514 },
];

const RUNTIME = pkg("runtime");

function npmBin() {
  // Prefer the npm that ships beside the Node we are running, so the bundled
  // runtime is used rather than whatever is on PATH.
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const cli = npmBin();
    if (!cli) return resolve({ ok: false, code: -1, tail: "npm was not found next to the Node runtime" });
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, npm_config_yes: "true", npm_config_fund: "false", npm_config_audit: "false" },
    });
    let tail = "";
    const cap = (b) => {
      const s = b.toString();
      tail = (tail + s).slice(-4000);
      // Stream a heartbeat so a long install does not look frozen.
      for (const line of s.split("\n")) {
        if (/added|changed|reify|WARN|ERR!|npm error/.test(line) && line.trim()) say("    " + line.trim().slice(0, 160));
      }
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => resolve({ ok: code === 0, code, tail }));
    child.on("error", (err) => resolve({ ok: false, code: -1, tail: err.message }));
  });
}

function isInstalled(name) {
  return fs.existsSync(path.join(RUNTIME, "node_modules", name, "package.json"));
}

async function main() {
  say("");
  say(`Installing into: ${RUNTIME}`);
  say("(your own global npm packages are not touched)");
  say("");

  fs.mkdirSync(RUNTIME, { recursive: true });
  // A prefix install needs a package.json or npm walks up and installs into the
  // parent, which would pollute the app's own dependency tree.
  const marker = path.join(RUNTIME, "package.json");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({ name: "omni-agent-runtime", private: true, version: "1.0.0" }, null, 2));
  }

  const missing = COMPONENTS.filter((c) => !isInstalled(c.name));
  for (const c of COMPONENTS) {
    if (!missing.includes(c)) say(`  ${c.label} (${c.name}): already installed, skipping.`);
  }

  // 🔴 ONE npm install for everything that is missing, never one per component.
  //
  // `npm install <pkg>` reifies the WHOLE tree and prunes anything the prefix's
  // package.json does not list. A component that fails is therefore not just a
  // failure of its own: it is unsaved, so the NEXT component's install deletes
  // whatever it managed to lay down. Measured 2026-08-28 on a clean install -
  // omniroute failed, and installing opencode-ai then reported
  // "added 3 packages, and removed 1192 packages", leaving a machine with
  // neither a gateway nor a recoverable half of one.
  let failures = 0;
  if (missing.length) {
    const total = missing.reduce((n, c) => n + c.approxMB, 0);
    say(`  Downloading ${missing.map((c) => c.label).join(" and ")} (about ${total} MB)...`);
    const r = await run(
      ["install", ...missing.map((c) => c.spec), "--omit=dev", "--no-fund", "--no-audit", "--loglevel=error"],
      RUNTIME,
    );
    const stillMissing = missing.filter((c) => !isInstalled(c.name));
    for (const c of missing) if (!stillMissing.includes(c)) say(`  ${c.label}: installed.`);
    failures = stillMissing.length;
    if (failures) {
      const tail = String(r.tail);
      say("");
      say(`  FAILED to install: ${stillMissing.map((c) => c.label).join(", ")}.`);
      say(`  ${tail.split("\n").slice(-6).join("\n  ")}`);
      say("");
      // Name the cause the message can actually tell apart, rather than
      // blaming the network for everything. ENOTEMPTY is a Windows lock -
      // antivirus, an open Explorer window, or a still-running Omni Agent -
      // and telling someone to check their connection sends them the wrong way.
      if (/ENOTEMPTY|EPERM|EBUSY|EACCES/.test(tail)) {
        say("  Windows would not let npm replace a folder that is still in use.");
        say("  Close Omni Agent and any Explorer window inside its folder, then");
        say("  run 'Set up Omni Agent' again. If it keeps happening, your");
        say("  antivirus is holding the files while they are being written.");
      } else if (/ENOSPC/.test(tail)) {
        say("  The drive is full. Free up space and run 'Set up Omni Agent' again.");
      } else {
        say("  This is usually a network problem or a proxy.");
        say("  Fix that and run 'Set up Omni Agent' from the Start Menu again.");
      }
    }
  }

  if (failures) {
    say("");
    say(`${failures} component(s) could not be installed. Setup cannot continue.`);
    process.exit(1);
  }

  say("");
  say("All components installed.");
  say("");
  process.exit(0);
}

main().catch((err) => {
  say(`\nBootstrap failed: ${err.message}`);
  process.exit(1);
});
