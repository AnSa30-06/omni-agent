// Routines - work the agent does on a schedule, without being asked each time.
//
// "Every weekday at 9, check my inbox folder and summarise what changed."
// A routine is a saved prompt plus a schedule; running one creates an ordinary
// session, so its output shows up in the sidebar like any other conversation
// and is archived by src/ui/transcripts.mjs like any other conversation.
//
// TWO WAYS TO RUN, and the difference is the whole honesty of the feature:
//
//   in-app    the scheduler below fires while the OmniAgent window is open.
//             Nothing to install, and it does nothing while the app is closed.
//   always    a Windows Scheduled Task runs `omni-agent routine run <id>`
//             whether the app is open or not.
//
// The UI states which one a routine is using, because a routine that silently
// only runs when you happen to have the app open is worse than no routine.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { PATHS, ensureDirs, APP_ROOT } from "../util/paths.mjs";
import { oc } from "./opencode-server.mjs";
import { logger } from "../util/log.mjs";

const log = logger("ui/routines");

const FILE = () => path.join(PATHS.home, "routines.json");

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return Array.isArray(raw.routines) ? raw.routines : [];
  } catch {
    return [];
  }
}
function save(routines) {
  ensureDirs();
  fs.writeFileSync(FILE(), JSON.stringify({ version: 1, routines }, null, 2));
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * When this routine should next fire, as an epoch ms, or null if never.
 *
 * @param {object} r
 * @param {number} [from] epoch ms to search forward from
 */
export function nextRun(r, from = Date.now()) {
  if (!r.enabled) return null;
  const s = r.schedule ?? {};
  if (s.kind === "interval") {
    const every = Math.max(5, Number(s.everyMinutes) || 60) * 60_000;
    const base = r.lastRun ?? from;
    let next = base + every;
    while (next <= from) next += every;
    return next;
  }
  const [hh, mm] = String(s.at ?? "09:00")
    .split(":")
    .map((n) => Number(n) || 0);
  // Walk forward a day at a time. Cheap, and it gets DST right for free
  // because each candidate is built from local calendar fields.
  const start = new Date(from);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, hh, mm, 0, 0);
    if (d.getTime() <= from) continue;
    if (s.kind === "weekly") {
      const want = (s.days ?? []).map((x) => String(x).toLowerCase().slice(0, 3));
      if (want.length && !want.includes(DAYS[d.getDay()])) continue;
    }
    if (s.kind === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) continue;
    return d.getTime();
  }
  return null;
}

export function list() {
  return load().map((r) => ({ ...r, nextRun: nextRun(r) }));
}

export function create(input) {
  const routines = load();
  if (!input?.name?.trim()) return { ok: false, reason: "a routine needs a name" };
  if (!input?.prompt?.trim()) return { ok: false, reason: "a routine needs something to do" };
  const r = {
    id: "rtn_" + crypto.randomBytes(8).toString("hex"),
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    agent: input.agent === "plan" ? "plan" : "build",
    schedule: {
      kind: ["daily", "weekdays", "weekly", "interval"].includes(input.schedule?.kind) ? input.schedule.kind : "daily",
      at: input.schedule?.at ?? "09:00",
      days: input.schedule?.days ?? [],
      everyMinutes: Number(input.schedule?.everyMinutes) || 60,
    },
    when: input.when === "always" ? "always" : "in-app",
    enabled: input.enabled !== false,
    lastRun: null,
    lastResult: null,
    lastSessionID: null,
  };
  routines.push(r);
  save(routines);
  if (r.when === "always") registerTask(r);
  log.info("routine created", { id: r.id, name: r.name, when: r.when });
  return { ok: true, routine: { ...r, nextRun: nextRun(r) } };
}

export function update(id, patch) {
  const routines = load();
  const i = routines.findIndex((r) => r.id === id);
  if (i === -1) return { ok: false, reason: "no such routine" };
  const before = routines[i];
  const r = { ...before, ...patch, id: before.id };
  if (patch.schedule) r.schedule = { ...before.schedule, ...patch.schedule };
  routines[i] = r;
  save(routines);
  // Keep Windows in step with what the user just chose.
  if (before.when === "always") unregisterTask(before);
  if (r.when === "always" && r.enabled) registerTask(r);
  return { ok: true, routine: { ...r, nextRun: nextRun(r) } };
}

export function remove(id) {
  const routines = load();
  const r = routines.find((x) => x.id === id);
  if (r) unregisterTask(r);
  save(routines.filter((x) => x.id !== id));
  return { ok: true, id };
}

/** Run a routine now: a fresh session, the saved prompt, the saved agent. */
export async function run(id) {
  const routines = load();
  const i = routines.findIndex((r) => r.id === id);
  if (i === -1) return { ok: false, reason: "no such routine" };
  const r = routines[i];

  const made = await oc("POST", "/api/session", { title: `${r.name} - ${new Date().toLocaleString()}` });
  if (!made.ok) return { ok: false, reason: made.reason };
  const sessionID = made.data?.data?.id ?? made.data?.id;
  if (!sessionID) return { ok: false, reason: "the agent server created no session" };

  // /session/{id}/message, not /api/session/{id}/prompt - the latter accepts
  // the message and never runs it. See the note in src/ui/public/app.js.
  const sent = await oc(
    "POST",
    `/session/${sessionID}/message`,
    { agent: r.agent, parts: [{ type: "text", text: r.prompt }] },
    { timeoutMs: 15 * 60_000 },
  );

  routines[i] = {
    ...r,
    lastRun: Date.now(),
    lastResult: sent.ok ? "completed" : `failed: ${sent.reason}`,
    lastSessionID: sessionID,
  };
  save(routines);
  log.info("routine run", { id, sessionID, ok: sent.ok });
  return sent.ok ? { ok: true, sessionID } : { ok: false, reason: sent.reason, sessionID };
}

// --- Windows Scheduled Tasks ------------------------------------------------

function taskName(r) {
  return `OmniAgent Routine ${r.id}`;
}

/** schtasks arguments for this routine's schedule, or null if it cannot map. */
function schtasksSchedule(r) {
  const s = r.schedule ?? {};
  const at = s.at ?? "09:00";
  if (s.kind === "interval") return ["/sc", "MINUTE", "/mo", String(Math.max(5, Number(s.everyMinutes) || 60))];
  if (s.kind === "daily") return ["/sc", "DAILY", "/st", at];
  if (s.kind === "weekdays") return ["/sc", "WEEKLY", "/d", "MON,TUE,WED,THU,FRI", "/st", at];
  if (s.kind === "weekly") {
    const days = (s.days ?? []).map((d) => String(d).toUpperCase().slice(0, 3));
    return ["/sc", "WEEKLY", "/d", (days.length ? days : ["MON"]).join(","), "/st", at];
  }
  return null;
}

function schtasks(args) {
  return new Promise((resolve) => {
    const child = spawn("schtasks", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("error", (e) => resolve({ ok: false, reason: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, code, output: out.trim().slice(0, 500) }));
  });
}

export async function registerTask(r) {
  if (process.platform !== "win32") return { ok: false, reason: "scheduled tasks are Windows-only here" };
  const sched = schtasksSchedule(r);
  if (!sched) return { ok: false, reason: "that schedule cannot be mapped to a Windows task" };
  const node = process.execPath;
  const entry = path.join(APP_ROOT, "bin", "omni-agent.mjs");
  const cmd = `"${node}" "${entry}" routine run ${r.id}`;
  const res = await schtasks(["/create", "/f", "/tn", taskName(r), "/tr", cmd, ...sched]);
  if (!res.ok) log.warn("could not register scheduled task", { id: r.id, output: res.output });
  return res;
}

export async function unregisterTask(r) {
  if (process.platform !== "win32") return { ok: true };
  return schtasks(["/delete", "/f", "/tn", taskName(r)]);
}

// --- in-app scheduler -------------------------------------------------------

let _timer = null;
/**
 * Fire due routines while the app is open.
 *
 * Only `when: "in-app"` routines are fired here. An "always" routine already
 * has a Windows task, and running it from both places would double it.
 */
export function startScheduler({ everyMs = 30_000 } = {}) {
  if (_timer) return;
  const tick = async () => {
    const now = Date.now();
    for (const r of load()) {
      if (!r.enabled || r.when !== "in-app") continue;
      const due = nextRun(r, r.lastRun ?? now - 1);
      if (due && due <= now) {
        log.info("routine due", { id: r.id });
        await run(r.id).catch((e) => log.warn("routine failed", { id: r.id, error: e.message }));
      }
    }
  };
  _timer = setInterval(() => tick().catch(() => {}), everyMs);
  _timer.unref?.();
}
export function stopScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
