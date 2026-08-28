// The desktop app's preferences, on disk.
//
// Not localStorage: the UI server takes a fresh port on every launch, which
// makes the page a new browser origin each time, so anything kept in browser
// storage is silently empty on every restart.
//
// Shared by the UI's own routes and by the setup wizard, which records the
// model it actually got an answer from here (see `verifiedModel`).
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../util/paths.mjs";

export const prefsFile = () => path.join(PATHS.home, "ui-prefs.json");

export function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8"));
  } catch {
    return { kinds: {} };
  }
}

export function writePrefs(p) {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record the model that actually answered during setup.
 *
 * 🔴 This is what stops the first message of a fresh install failing. The
 * gateway's configured default is an `auto/` combo, and on a keyless machine
 * that can resolve to a model needing a key: measured 2026-08-28, the very
 * first message on a clean install died on
 * "[401] Model north-mini-code-free is not supported". Setup already sends a
 * real request and already falls back until something answers - so the model
 * that answered is a MEASURED fact about this machine, and it is a far better
 * starting point than a published default.
 *
 * Kept under its own key rather than written into `model`, which is what makes
 * it impossible for this to overrule a model the user picked: the UI reads
 * `model` first and only falls back to `verifiedModel` when nothing has been
 * chosen. Setup may re-run at any time, so overwriting a real choice here would
 * be a silent model change.
 */
export function rememberVerifiedModel(modelId) {
  if (typeof modelId !== "string" || !modelId) return false;
  const prefs = readPrefs();
  prefs.verifiedModel = modelId;
  return writePrefs(prefs);
}
