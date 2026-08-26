// Find the OmniRoute entry point.
//
// We spawn `node <entry>` rather than the `omniroute` PATH shim: on Windows the
// global npm shim is a .cmd file, which Node 24 refuses to run through
// execFile/spawn without a shell (CVE-2024-27980 hardening), and shell-spawning
// a long-lived server makes it awkward to kill cleanly.
//
// The global npm root is derived from well-known locations rather than by
// shelling out to `npm root -g`, for the same reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pkg } from "../util/paths.mjs";

const ENTRY_REL = path.join("bin", "omniroute.mjs");

function globalNodeModulesDirs() {
  const dirs = [];
  const execDir = path.dirname(process.execPath);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    dirs.push(path.join(appData, "npm", "node_modules"));
    dirs.push(path.join(execDir, "node_modules"));
  } else {
    dirs.push(path.join(execDir, "..", "lib", "node_modules"));
    dirs.push("/usr/local/lib/node_modules");
    dirs.push("/usr/lib/node_modules");
    dirs.push(path.join(os.homedir(), ".npm-global", "lib", "node_modules"));
  }
  if (process.env.NPM_CONFIG_PREFIX) {
    dirs.push(
      process.platform === "win32"
        ? path.join(process.env.NPM_CONFIG_PREFIX, "node_modules")
        : path.join(process.env.NPM_CONFIG_PREFIX, "lib", "node_modules")
    );
  }
  return dirs;
}

function candidateRoots() {
  const roots = [];
  if (process.env.OMNI_AGENT_OMNIROUTE_HOME) roots.push(process.env.OMNI_AGENT_OMNIROUTE_HOME);
  // Installed by scripts/bootstrap.mjs into the app's private prefix. Checked
  // BEFORE the machine's global npm root, so the version this build was tested
  // against wins over whatever the user happens to have installed globally.
  roots.push(pkg("runtime", "node_modules", "omniroute"));
  roots.push(pkg("vendor", "omniroute"));
  roots.push(pkg("node_modules", "omniroute"));
  for (const dir of globalNodeModulesDirs()) roots.push(path.join(dir, "omniroute"));
  return roots;
}

/** @returns {{entry:string, root:string, version:string|null}|null} */
export function locateOmniRoute() {
  for (const root of candidateRoots()) {
    const entry = path.join(root, ENTRY_REL);
    if (fs.existsSync(entry)) {
      let version = null;
      try {
        version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null;
      } catch {}
      return { entry, root, version };
    }
  }
  return null;
}

/**
 * Locate the OpenCode CLI.
 *
 * Prefers the REAL executable inside the opencode-ai package over the `.cmd`
 * shim on PATH. The shim needs `shell: true` to spawn, which drags in shell
 * quoting - and the end-to-end test passes a multi-line prompt as one argument,
 * which shell quoting mangles. The .exe takes argv directly.
 */
export function locateOpenCode() {
  if (process.env.OMNI_AGENT_OPENCODE_BIN) return process.env.OMNI_AGENT_OPENCODE_BIN;

  const exeName = process.platform === "win32" ? "opencode.exe" : "opencode";
  // Package roots that may contain the real binary, private prefix first.
  const pkgRoots = [pkg("runtime", "node_modules"), pkg("node_modules")];
  for (const dir of globalNodeModulesDirs()) pkgRoots.push(dir);
  for (const root of pkgRoots) {
    const full = path.join(root, "opencode-ai", "bin", exeName);
    if (fs.existsSync(full)) return full;
  }

  // Fall back to a shim on PATH.
  const names = process.platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"];
  const dirs = [pkg("runtime", "node_modules", ".bin")];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    dirs.push(path.join(appData, "npm"));
  }
  dirs.push(path.dirname(process.execPath));
  for (const p of (process.env.PATH || "").split(path.delimiter)) if (p) dirs.push(p);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}
