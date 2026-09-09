// A provider key that travels with the BUILD, so the person you send this to
// has working intelligence the moment they open it.
//
// 🔴 THE KEY MUST NEVER REACH THE REPOSITORY, and this file is built around
// that rather than trusting anyone to remember it:
//
//   - `bundled-key.json` is in .gitignore, and a unit test asserts that it is
//     still ignored. A test is the only thing that survives someone editing
//     .gitignore in a hurry six months from now.
//   - `npm run scan:secrets` reads what git TRACKS, so an ignored file is
//     invisible to it. The test above is what closes that gap.
//   - The build copies the file into the staging directory it zips. The key
//     therefore exists in the artifact you hand over and in your own working
//     copy, and nowhere else.
//
// This repository is PUBLIC. A key committed here is scraped and abused within
// minutes, and it is the author's own standing rule that keys are rotated
// before anything goes public.
//
// Shape:
//   {
//     "providers": [ { "id": "mistral", "key": "..." } ]
//   }
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../util/paths.mjs";
import { loadConfig, updateConfig } from "../config.mjs";
import { logger } from "../util/log.mjs";

const log = logger("bundled-key");

/** Where the file may be, most-installed first. */
export function locations() {
  return [
    path.join(APP_ROOT, "bundled-key.json"),
    path.join(APP_ROOT, "..", "bundled-key.json"),
    path.join(APP_ROOT, "installer", "bundled-key.json"),
  ];
}

/** The bundled key file, or null. Never logged, never returned to the UI. */
export function read() {
  for (const file of locations()) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const providers = (raw.providers ?? [])
        .filter((p) => p && typeof p.id === "string" && typeof p.key === "string" && p.key.trim())
        .map((p) => ({ id: p.id.trim(), key: p.key.trim() }));
      if (providers.length) return { file, providers };
    } catch (err) {
      log.warn("a bundled key file could not be read", { file, error: err.message });
    }
  }
  return null;
}

/** Provider ids only - safe to print, safe to show in the UI. */
export function describe() {
  const found = read();
  return found ? { present: true, providers: found.providers.map((p) => p.id) } : { present: false, providers: [] };
}

/**
 * Connect the bundled providers, once.
 *
 * Idempotent in two ways: a config flag records that it ran, and a provider
 * that is already connected is skipped. So re-running setup does not overwrite
 * a key the person added themselves - theirs wins, because they chose it.
 *
 * @param {{force?: boolean, onProgress?: (m: string) => void}} [opts]
 */
export async function applyBundledKey(opts = {}) {
  const onProgress = opts.onProgress ?? (() => {});
  const cfg = loadConfig();
  if (cfg.bundledKeyApplied && !opts.force) return { ok: true, skipped: "already applied" };

  const found = read();
  if (!found) return { ok: true, skipped: "no bundled key" };

  const providers = await import("./providers.mjs");
  let connected = [];
  try {
    connected = ((await providers.connected()).connections ?? []).map((c) => c.provider);
  } catch {
    // The gateway is not up yet. Leave the flag unset so this runs again later.
    return { ok: false, reason: "the model gateway is not reachable yet" };
  }

  const added = [];
  const failed = [];
  for (const p of found.providers) {
    if (connected.includes(p.id)) {
      continue;
    }
    onProgress(`Connecting the bundled ${p.id} key...`);
    try {
      const r = await providers.addModelProvider(p.id, p.key);
      if (r.ok) added.push(p.id);
      else failed.push({ id: p.id, reason: r.reason });
    } catch (err) {
      failed.push({ id: p.id, reason: err.message });
    }
  }

  // Only mark it done when nothing failed, so a temporary outage does not cost
  // the person their bundled key for ever.
  if (!failed.length) updateConfig({ bundledKeyApplied: true });
  if (added.length) log.info("bundled providers connected", { added });
  return { ok: true, added, failed };
}

/** Write the file. Used by `vireo bundle-key`. */
export function write(providersList, dest = path.join(APP_ROOT, "installer", "bundled-key.json")) {
  const body = {
    $comment:
      "A provider key shipped inside the build, so whoever you send this to has a working model on first run. " +
      "This file is gitignored and a unit test keeps it that way. Never commit it: this repository is public.",
    providers: providersList,
  };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  return dest;
}
