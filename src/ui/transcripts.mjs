// A record of every conversation that survives deleting the conversation.
//
// OpenCode owns the live sessions and will happily delete one forever. This
// keeps a second copy outside it, so "I deleted the wrong chat" is recoverable
// rather than final.
//
// FORMAT. The archive is whatever `opencode export <id>` produces, byte for
// byte, and restoring is `opencode import <file>`. That pairing is the tool's
// own documented round trip, so the archive cannot drift out of a shape
// OpenCode will accept - which a hand-rolled schema would do the first time
// they add a field.
//
// It is NOT sanitised. `opencode export --sanitize` exists and is deliberately
// not used: the point of this archive is to be the user's complete record of
// their own conversation on their own machine, and a redacted copy fails the
// job it was added for. It inherits the user-only permissions of the app's data
// directory, and nothing here is ever transmitted anywhere.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { opencodeEnv } from "../setup/opencode-config.mjs";
import { locateOpenCode } from "../gateway/locate.mjs";
import { oc } from "./opencode-server.mjs";
import { logger } from "../util/log.mjs";

const log = logger("ui/transcripts");

export function archiveDir() {
  return path.join(PATHS.home, "transcripts");
}
function indexPath() {
  return path.join(archiveDir(), "index.json");
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeIndex(idx) {
  fs.mkdirSync(archiveDir(), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2));
}

/** Run an opencode subcommand and collect stdout. */
function run(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const exe = locateOpenCode();
    if (!exe) return resolve({ ok: false, reason: "OpenCode is not installed" });
    const isCmd = /\.cmd$/i.test(exe);
    const child = spawn(isCmd ? `"${exe}"` : exe, args, {
      env: opencodeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isCmd,
      windowsHide: true,
      cwd: PATHS.workspace,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString().slice(0, 4000)));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, reason: `opencode ${args[0]} timed out` });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout: out });
      else resolve({ ok: false, reason: `exited ${code}`, detail: err.split("\n").slice(-4).join("\n") });
    });
  });
}

/**
 * Copy ONE session into the archive, now.
 *
 * This is what the delete button uses. `archiveAll({force:true})` re-exports
 * every session, and each export is a separate `opencode export` process - at
 * 25 sessions that is over half a minute, during which a delete looks like it
 * did nothing at all.
 */
export async function archiveOne(id) {
  ensureDirs();
  fs.mkdirSync(archiveDir(), { recursive: true });
  const ex = await run(["export", id]);
  if (!ex.ok || !ex.stdout.trim()) return { ok: false, reason: ex.reason ?? "empty export" };
  try {
    JSON.parse(ex.stdout);
  } catch {
    return { ok: false, reason: "export was not valid JSON" };
  }
  fs.writeFileSync(path.join(archiveDir(), `${id}.json`), ex.stdout);

  const idx = readIndex();
  const s = (await oc("GET", `/api/session/${id}`)).data?.data ?? {};
  idx[id] = {
    id,
    title: s.title ?? idx[id]?.title ?? "Untitled",
    updated: s.time?.updated ?? Date.now(),
    created: s.time?.created ?? idx[id]?.created ?? Date.now(),
    archivedAt: Date.now(),
    bytes: Buffer.byteLength(ex.stdout),
    cost: s.cost ?? 0,
    tokens: s.tokens ?? null,
  };
  writeIndex(idx);
  return { ok: true, id, bytes: idx[id].bytes };
}

/**
 * Copy every live session into the archive.
 *
 * Sessions whose `time.updated` has not moved since the last archive are
 * skipped, so this stays cheap enough to run on a timer.
 */
export async function archiveAll({ force = false } = {}) {
  ensureDirs();
  fs.mkdirSync(archiveDir(), { recursive: true });
  const r = await oc("GET", "/api/session");
  if (!r.ok) return { ok: false, reason: r.reason };
  const sessions = r.data?.data ?? r.data ?? [];
  const idx = readIndex();
  let saved = 0;
  let skipped = 0;
  const failed = [];

  for (const s of sessions) {
    const id = s.id;
    if (!id) continue;
    const updated = s.time?.updated ?? 0;
    if (!force && idx[id] && idx[id].updated === updated) {
      skipped++;
      continue;
    }
    const ex = await run(["export", id]);
    if (!ex.ok || !ex.stdout.trim()) {
      failed.push({ id, reason: ex.reason ?? "empty export" });
      continue;
    }
    // Only write once it parses. A truncated file in the archive is worse than
    // a missing one, because it looks like a backup right up until you need it.
    try {
      JSON.parse(ex.stdout);
    } catch {
      failed.push({ id, reason: "export was not valid JSON" });
      continue;
    }
    fs.writeFileSync(path.join(archiveDir(), `${id}.json`), ex.stdout);
    idx[id] = {
      id,
      title: s.title ?? "Untitled",
      updated,
      created: s.time?.created ?? updated,
      archivedAt: Date.now(),
      bytes: Buffer.byteLength(ex.stdout),
      cost: s.cost ?? 0,
      tokens: s.tokens ?? null,
    };
    saved++;
  }
  writeIndex(idx);
  if (saved || failed.length) log.info("archived transcripts", { saved, skipped, failed: failed.length });
  return { ok: true, saved, skipped, failed, total: Object.keys(idx).length };
}

/**
 * Every archived transcript, newest first, flagged with whether it is still live.
 *
 * Liveness is checked per session rather than read off the session list.
 * Measured 2026-08-27: immediately after a successful DELETE the session is
 * still present in `GET /api/session`, so a list-based check reported a
 * just-deleted conversation as live - which is exactly the moment the user
 * needs the "bring it back" button to appear. A direct GET 404s straight away.
 */
export async function list() {
  const idx = readIndex();
  const entries = Object.values(idx).sort((a, b) => b.updated - a.updated);
  const checks = await Promise.all(
    entries.map(async (e) => {
      const r = await oc("GET", `/api/session/${e.id}`, undefined, { timeoutMs: 8000 });
      // Only a definite 404 proves absence; a transport failure is unknown, and
      // must not be reported as "deleted" or the page invites a pointless restore.
      return r.ok ? true : r.status === 404 ? false : null;
    }),
  );
  const rows = entries.map((e, i) => ({
    ...e,
    live: checks[i] === true,
    deleted: checks[i] === false,
    unknown: checks[i] === null,
  }));
  return { ok: true, transcripts: rows, archiveDir: archiveDir() };
}

/** Put an archived conversation back into the agent. */
export async function restore(id) {
  const file = path.join(archiveDir(), `${id}.json`);
  if (!fs.existsSync(file)) return { ok: false, reason: `nothing archived for "${id}"` };
  const r = await run(["import", file], { timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  log.info("restored transcript", { id });
  return { ok: true, id };
}

/**
 * Restore everything that was archived and is no longer live.
 *
 * This is the "auto import" switch: turn it on and a conversation deleted by
 * accident comes back the next time the app starts. Off by default, because
 * silently resurrecting something a user deliberately deleted is its own kind
 * of wrong - deleting on purpose has to keep working.
 */
export async function autoImport() {
  const l = await list();
  const gone = l.transcripts.filter((t) => t.deleted);
  const restored = [];
  const failed = [];
  for (const t of gone) {
    const r = await restore(t.id);
    if (r.ok) restored.push(t.id);
    else failed.push({ id: t.id, reason: r.reason });
  }
  return { ok: true, restored, failed, considered: gone.length };
}

/** Remove one archived copy. The live session is untouched. */
export function forget(id) {
  const file = path.join(archiveDir(), `${id}.json`);
  try {
    fs.rmSync(file, { force: true });
  } catch {}
  const idx = readIndex();
  delete idx[id];
  writeIndex(idx);
  return { ok: true, id };
}

let _timer = null;
/** Archive now, then every `everyMs` while the app is open. */
export function startArchiver({ everyMs = 60_000 } = {}) {
  if (_timer) return;
  const tick = () => {
    archiveAll().catch((e) => log.warn("archive failed", { error: e.message }));
  };
  tick();
  _timer = setInterval(tick, everyMs);
  _timer.unref?.();
}
export function stopArchiver() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
