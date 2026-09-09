// The part that makes this more than a report: a decision that is not handled
// comes BACK.
//
// A recommendation shown once and forgotten is what every dashboard already
// does. The tick below is what turns a decision into something with a life:
// a snooze expires, an overdue decision says so, and a decision left waiting
// gets a nudge. All of it is in-app state, not a notification - nothing here
// interrupts anyone outside the window.
import { getSettings } from "./db.mjs";
import { logEvent } from "./decisions.mjs";
import { limit } from "./rules.mjs";
import { asOfFor } from "./run.mjs";
import { daysBetween } from "./format.mjs";
import * as workspace from "./workspace.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/followup");

/** Has this decision had a reminder in the last `hours`? */
function remindedRecently(db, decisionId, hours = 24) {
  const row = db
    .prepare("SELECT at FROM decision_event WHERE decision_id = ? AND kind = 'reminder' ORDER BY at DESC LIMIT 1")
    .get(decisionId);
  if (!row) return false;
  const age = Date.now() - Date.parse(row.at);
  return Number.isFinite(age) && age < hours * 3600 * 1000;
}

/**
 * One pass over a workspace. Pure of side effects other than the database, and
 * takes `now` so the tests can move time without waiting.
 */
export function tick(db, now = new Date()) {
  const settings = getSettings(db);
  const asOf = asOfFor(db);
  const nowIso = new Date(now).toISOString();
  const out = { unsnoozed: 0, overdue: 0, waiting: 0 };

  // 1. Snoozes that have expired.
  const snoozed = db.prepare("SELECT * FROM decision WHERE status = 'snoozed' AND snoozed_until IS NOT NULL").all();
  for (const d of snoozed) {
    if (d.snoozed_until > asOf) continue;
    const back = d.status_before_snooze || "new";
    db.prepare("UPDATE decision SET status = ?, snoozed_until = NULL, status_before_snooze = NULL, updated_at = ? WHERE id = ?").run(
      back,
      nowIso,
      d.id,
    );
    logEvent(db, d.id, "system", "unsnoozed", { reason: "the snooze ran out", back });
    out.unsnoozed++;
  }

  // 2. Overdue. One reminder a day, so a decision left for a fortnight does not
  //    produce fourteen identical entries in its own history.
  const open = db
    .prepare(`SELECT * FROM decision WHERE status IN ('new','accepted','in_progress','waiting') AND due_at IS NOT NULL`)
    .all();
  for (const d of open) {
    if (d.due_at >= asOf) continue;
    if (remindedRecently(db, d.id)) continue;
    logEvent(db, d.id, "system", "reminder", { daysOverdue: daysBetween(d.due_at, asOf), due: d.due_at });
    out.overdue++;
  }

  // 3. Waiting too long.
  const nudgeAfter = limit("waitingNudgeDays", settings);
  const waiting = db.prepare("SELECT * FROM decision WHERE status = 'waiting'").all();
  for (const d of waiting) {
    const days = daysBetween(d.updated_at, asOf);
    if (days == null || days < nudgeAfter) continue;
    if (remindedRecently(db, d.id, 7 * 24)) continue;
    logEvent(db, d.id, "system", "reminder", { waitingDays: days });
    out.waiting++;
  }

  return out;
}

/** How overdue an open decision is, or null. Used by the UI and by Today. */
export function overdueDays(decision, asOf) {
  if (!decision.due_at) return null;
  if (!["new", "accepted", "in_progress", "waiting"].includes(decision.status)) return null;
  const days = daysBetween(decision.due_at, asOf);
  return days != null && days > 0 ? days : null;
}

// --- the in-app scheduler ---------------------------------------------------
//
// Same shape as src/ui/routines.mjs: a plain interval started by launch.mjs and
// stopped with it, unref'd so it can never hold the process open. Five minutes
// is often enough that a snooze expiring feels immediate and rare enough that
// it costs nothing.

let _timer = null;

export function startFollowup({ everyMs = 5 * 60_000 } = {}) {
  if (_timer) return;
  const run = () => {
    try {
      const { workspaces } = workspace.list();
      for (const w of workspaces) {
        const db = workspace.openWorkspace(w.id);
        try {
          const r = tick(db);
          if (r.unsnoozed || r.overdue || r.waiting) log.info("follow-up", { workspace: w.id, ...r });
        } finally {
          db.close();
        }
      }
    } catch (err) {
      log.warn("follow-up failed", { error: err.message });
    }
  };
  run();
  _timer = setInterval(run, everyMs);
  _timer.unref?.();
}

export function stopFollowup() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
