// Keep an installed copy up to date by fetching only what changed.
//
// WHY NOT THE INSTALLER. A release installer is 74.6 MB and unpacks to a 3.4 GB
// tree, almost all of which is node_modules and a bundled Node runtime that
// change perhaps twice a year. The files that actually change between releases
// are the app's own source: measured between v1.1.13 and v1.2.0, eleven files
// and 463 changed lines. Downloading those is a few hundred kilobytes.
//
// WHY NOT `git pull`. The install is not a git checkout and the reader has no
// git. GitHub's compare API gives the same answer over plain HTTPS.
//
// 🔴 THE RULE THIS MODULE EXISTS TO ENFORCE: copying files into a live install
// is only safe while the SHAPE of the install is unchanged. If a release
// renames the program, or needs a package that is not already on disk, the
// copied files land in a tree that cannot run them - and the reader is left
// with an app that will not start and no obvious way back. Every such release
// is refused here and sent to the full installer instead.
//
// That is not hypothetical. While this was being written, a live branch of this
// very repository had renamed the product, moved its data directory and added a
// `zod` dependency across 90 files. A naive file-copier would have replaced
// `bin/omni-agent.mjs` with nothing, pointed the app at an empty data folder,
// and imported a package that is not installed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// ⭐ `root` is threaded through rather than reading APP_ROOT directly, because
// applyUpdate DELETES AND OVERWRITES FILES. Without a seam, the only way to
// test it is to point it at the real install and hope.
import { PATHS, APP_ROOT } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";

const log = logger("update");

const REPO = "AnSa30-06/omni-agent";
const API = `https://api.github.com/repos/${REPO}`;
const UA = "omni-agent-updater";

/** Once a day. The reader is told; nothing is applied without them saying so. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Paths inside the repository that are ALSO inside an install and safe to
 * replace by copying one file over another.
 *
 * ⚠️ Deliberately a whitelist. A blacklist would let a new top-level directory
 * through by default, and "we did not think about it" is the wrong default when
 * the consequence is an install that will not start.
 *
 * `tests/`, `.github/` and `docs/` are not shipped at all. `installer/` is
 * shipped but only ever read by the build. `runtime/` holds the gateway's
 * package manifest, whose packages are installed on disk and cannot be updated
 * by copying a manifest over the top - see structuralReasons().
 */
const SHIPPED = ["src/", "config/", "plugin/", "skills/", "bin/", "scripts/"];
const SHIPPED_FILES = ["package.json", "README.md", "LICENSE"];

function isShipped(file) {
  return SHIPPED.some((p) => file.startsWith(p)) || SHIPPED_FILES.includes(file);
}

const stateFile = () => path.join(PATHS.home, "update-state.json");

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(PATHS.home, { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    log.warn("could not record update state", { error: err.message });
  }
  return next;
}

/** The version on disk right now. */
export function installedVersion(root = APP_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** -1, 0 or 1. Plain numeric compare; these tags have never carried a suffix. */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v ?? "")
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function gh(pathname) {
  const r = await fetch(API + pathname, {
    headers: { accept: "application/vnd.github+json", "user-agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    // 403 here is almost always the unauthenticated rate limit (60/hour/IP).
    // Checking once a day cannot reach it, but a developer loop can.
    throw new Error(`GitHub answered ${r.status} for ${pathname}`);
  }
  return r.json();
}

/**
 * Is there a newer RELEASE?
 *
 * ⚠️ Releases, never commits. A commit on any branch is work in progress: a
 * branch of this repository renames the product, and following commits rather
 * than releases would push that to every install. A release is the point at
 * which someone decided a version was fit to hand out.
 */
export async function checkForUpdate() {
  const current = installedVersion();
  if (!current) return { ok: false, reason: "this copy does not say which version it is" };
  let rel;
  try {
    rel = await gh("/releases/latest");
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const latest = String(rel.tag_name ?? "").replace(/^v/i, "");
  const newer = compareVersions(current, latest) < 0;
  writeState({ lastCheck: new Date().toISOString(), lastSeen: latest });
  return {
    ok: true,
    current,
    latest,
    updateAvailable: newer,
    notes: newer ? (rel.body ?? "").slice(0, 4000) : null,
    url: rel.html_url ?? null,
    publishedAt: rel.published_at ?? null,
  };
}

/**
 * Reasons this release cannot be applied by copying files.
 *
 * Each one is a way for the install's SHAPE to change. A file copy keeps the
 * shape and only swaps contents, so any of these means the copied files would
 * land somewhere that cannot run them.
 *
 * @returns {string[]} reader-facing sentences, empty when a copy is safe
 */
export function structuralReasons(oldPkg, newPkg, files) {
  const reasons = [];
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  if (oldPkg?.name !== newPkg?.name) {
    reasons.push(`the app has been renamed from "${oldPkg?.name}" to "${newPkg?.name}"`);
  }
  if (!same(oldPkg?.bin, newPkg?.bin)) {
    reasons.push("the file that starts the app has changed, so the shortcuts would stop working");
  }
  if (!same(oldPkg?.dependencies, newPkg?.dependencies)) {
    reasons.push("it needs supporting packages that are not on this computer yet");
  }
  // The gateway's own packages live on disk; its manifest alone cannot move them.
  if (files.some((f) => f.filename.startsWith("runtime/"))) {
    reasons.push("the model gateway itself has changed version");
  }
  return reasons;
}

/**
 * What this update would actually do, without doing any of it.
 *
 * Downloads nothing except the new package.json, which is needed to answer the
 * one question that decides everything: has the shape of the install changed?
 */
export async function planUpdate({ from, to, root = APP_ROOT } = {}) {
  const current = from ?? installedVersion(root);
  if (!current) return { ok: false, reason: "this copy does not say which version it is" };
  const target = to ?? (await checkForUpdate()).latest;
  if (!target) return { ok: false, reason: "could not read the latest version" };
  if (compareVersions(current, target) >= 0) {
    return { ok: true, upToDate: true, current, target };
  }

  let cmp;
  try {
    cmp = await gh(`/compare/v${current}...v${target}`);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  // "ahead" means the new tag simply continues from this one. "diverged" means
  // history was rewritten, and a file-by-file patch of a diverged tree is not a
  // patch at all.
  if (cmp.status !== "ahead") {
    return {
      ok: false,
      reason: `the published version does not follow on from this one (${cmp.status}), so it must be installed in full`,
      needsInstaller: true,
    };
  }

  const files = (cmp.files ?? []).filter((f) => isShipped(f.filename));
  if (!files.length) {
    return { ok: true, upToDate: false, current, target, files: [], nothingToCopy: true };
  }

  // The new package.json decides whether a copy is safe at all.
  let newPkg = null;
  const pj = files.find((f) => f.filename === "package.json");
  if (pj && pj.status !== "removed") {
    try {
      const r = await fetch(pj.raw_url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
      newPkg = JSON.parse(await r.text());
    } catch (err) {
      return { ok: false, reason: `could not read the new version's details: ${err.message}` };
    }
  }
  let oldPkg = {};
  try {
    oldPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {}

  const reasons = newPkg ? structuralReasons(oldPkg, newPkg, cmp.files ?? []) : [];
  const bytes = files.reduce((n, f) => n + (f.changes ?? 0), 0);

  return {
    ok: true,
    upToDate: false,
    current,
    target,
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      sha: f.sha,
      raw_url: f.raw_url,
      previous_filename: f.previous_filename ?? null,
    })),
    changedLines: bytes,
    blocked: reasons.length > 0,
    reasons,
    needsInstaller: reasons.length > 0,
  };
}

/** git's own object id for a file, which is what the compare API reports. */
function gitBlobSha(buf) {
  return crypto
    .createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]))
    .digest("hex");
}

/**
 * Apply a plan.
 *
 * The order is the whole safety story:
 *   1. download EVERYTHING to a staging folder first
 *   2. check every file against the id GitHub published for it
 *   3. only then copy the old files aside and move the new ones in
 *   4. if any single copy fails, put every old file back
 *
 * Nothing in the install is touched until every byte is present and verified,
 * so a dropped connection halfway through leaves the app exactly as it was.
 */
export async function applyUpdate(plan, { root = APP_ROOT, home = PATHS.home } = {}) {
  if (!plan?.ok || plan.upToDate) return { ok: false, reason: "there is nothing to update" };
  if (plan.blocked) {
    return { ok: false, reason: plan.reasons.join("; "), needsInstaller: true };
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const work = path.join(home, "updates", stamp);
  const staged = path.join(work, "new");
  const backup = path.join(work, "old");
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });

  // 1 + 2. Fetch and verify. A file whose id does not match is not written.
  const writes = [];
  const deletes = [];
  for (const f of plan.files) {
    if (f.status === "removed") {
      deletes.push(f.filename);
      continue;
    }
    let buf;
    try {
      const r = await fetch(f.raw_url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      return { ok: false, reason: `could not download ${f.filename}: ${err.message}` };
    }
    const got = gitBlobSha(buf);
    if (got !== f.sha) {
      // Either the download was damaged or it is not the file that was
      // published. Neither is something to copy into a working install.
      return { ok: false, reason: `${f.filename} did not arrive intact, so nothing was changed` };
    }
    const dest = path.join(staged, f.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    writes.push(f.filename);
    if (f.previous_filename) deletes.push(f.previous_filename);
  }

  // 3. Swap. Every file replaced is copied aside first, in the same layout, so
  //    restoring is a straight copy back rather than a second download.
  const moved = [];
  try {
    for (const rel of [...writes, ...deletes]) {
      const live = path.join(root, rel);
      if (fs.existsSync(live)) {
        const keep = path.join(backup, rel);
        fs.mkdirSync(path.dirname(keep), { recursive: true });
        fs.copyFileSync(live, keep);
        moved.push(rel);
      }
    }
    for (const rel of writes) {
      const live = path.join(root, rel);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.copyFileSync(path.join(staged, rel), live);
    }
    for (const rel of deletes) {
      const live = path.join(root, rel);
      if (fs.existsSync(live)) fs.rmSync(live);
    }
  } catch (err) {
    // 4. Put it back. This is why the copies were taken.
    for (const rel of moved) {
      try {
        fs.copyFileSync(path.join(backup, rel), path.join(root, rel));
      } catch {}
    }
    log.error("update failed and was rolled back", { error: err.message });
    return { ok: false, reason: `the update failed and was undone: ${err.message}`, rolledBack: true };
  }

  writeState({
    lastApplied: { at: new Date().toISOString(), from: plan.current, to: plan.target, files: writes.length, backup },
  });
  log.info("update applied", { from: plan.current, to: plan.target, files: writes.length });
  return { ok: true, from: plan.current, to: plan.target, files: writes.length, removed: deletes.length, backup };
}

/**
 * Start this copy again and stop being this one.
 *
 * ⚠️ The gateway is deliberately left alone. It is a separate long-running
 * process with its own SQLite database, the restarted app reuses it, and
 * stopping it here would add the one operation that has damaged that database
 * before. Nothing in an update changes the gateway - a release that did is
 * refused by structuralReasons().
 */
export async function restartApp({ spawn } = {}) {
  const { spawn: nodeSpawn } = spawn ? { spawn } : await import("node:child_process");
  // Re-run exactly however this copy was started: the packaged exe re-runs
  // itself with no arguments, and `node bin/... ui` re-runs the same script.
  const args = process.argv.slice(1);
  const child = nodeSpawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();
  return { ok: true, pid: child.pid };
}
