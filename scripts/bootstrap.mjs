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

  let failures = 0;
  for (const c of COMPONENTS) {
    if (isInstalled(c.name)) {
      say(`  ${c.label} (${c.name}): already installed, skipping.`);
      continue;
    }
    say(`  Downloading the ${c.label} (${c.spec}, about ${c.approxMB} MB)...`);
    const r = await run(["install", c.spec, "--omit=dev", "--no-fund", "--no-audit", "--loglevel=error"], RUNTIME);
    if (r.ok && isInstalled(c.name)) {
      say(`  ${c.label}: installed.`);
    } else {
      failures++;
      say("");
      say(`  FAILED to install the ${c.label}.`);
      say(`  ${String(r.tail).split("\n").slice(-6).join("\n  ")}`);
      say("");
      say("  This is almost always a network problem, a proxy, or no disk space.");
      say("  Fix that and run 'Set up Omni Agent' from the Start Menu again.");
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
