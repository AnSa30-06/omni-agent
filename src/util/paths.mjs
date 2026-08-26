// Filesystem layout for the Omni Agent distribution.
//
// Everything the app owns lives under one root so an uninstall is a single
// directory removal, and so the bundled OmniRoute never collides with a
// pre-existing user install (which keeps its own data in ~/.omniroute).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository / installation root (the directory containing package.json). */
export const APP_ROOT = path.resolve(HERE, "..", "..");

function baseDir() {
  if (process.env.OMNI_AGENT_HOME) return path.resolve(process.env.OMNI_AGENT_HOME);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "OmniAgent");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "omni-agent");
  return path.join(os.homedir(), ".omni-agent");
}

export const HOME = baseDir();

export const PATHS = {
  home: HOME,
  /** User-editable settings (never contains secrets). */
  config: path.join(HOME, "config.json"),
  /** DPAPI/0600-protected credential store. */
  secrets: path.join(HOME, "credentials.dat"),
  /** Isolated OmniRoute DATA_DIR - deliberately not ~/.omniroute. */
  gatewayData: path.join(HOME, "gateway"),
  /** Playwright browser download location. */
  browsers: path.join(HOME, "browsers"),
  /** Local usage telemetry (JSONL, one line per model call). */
  telemetry: path.join(HOME, "telemetry"),
  /** Cached provider quota responses, so the UI can show "last known value". */
  quotaCache: path.join(HOME, "quota-cache.json"),
  /** Diagnostics logs. Sanitised on export. */
  logs: path.join(HOME, "logs"),
  /** Where OpenCode config for this distribution is written. */
  opencode: path.join(HOME, "opencode"),
  /** Default workspace opened when the user launches with no directory. */
  workspace: path.join(os.homedir(), "OmniAgent Workspace"),
  /** Scratch space for downloads made by the browser/scraper tools. */
  downloads: path.join(HOME, "downloads"),
};

export function ensureDirs() {
  for (const key of ["home", "gatewayData", "browsers", "telemetry", "logs", "opencode", "downloads"]) {
    fs.mkdirSync(PATHS[key], { recursive: true });
  }
  return PATHS;
}

/** Resolve a path inside the installed package (config templates, skills, plugin). */
export function pkg(...parts) {
  return path.join(APP_ROOT, ...parts);
}
