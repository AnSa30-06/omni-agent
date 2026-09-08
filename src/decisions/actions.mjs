// The two actions, both human-in-the-loop.
//
// 🔴 NOTHING HERE SENDS ANYTHING. There is no send path in this file, no SMTP,
// no API call to a mail provider, and that is deliberate rather than
// unfinished: an agent that can email your customers is a different product
// with a different risk, and the MVP has no business being it. A draft is
// written, the person edits it, and their own mail client sends it.
import { actionId } from "./ids.mjs";
import { actionLabel, limit } from "./rules.mjs";
import { getSettings } from "./db.mjs";
import { logEvent, getDecision, suggestedDue } from "./decisions.mjs";
import { draftEmail, splitEmail } from "./reason.mjs";
import { buildPacket } from "./packet.mjs";
import { asOfFor } from "./run.mjs";
import { daysBetween, addDays } from "./format.mjs";

export const ACTION_KINDS = { draft_email: "Draft an email", task: "Create a task" };

function rowToAction(r) {
  return r ? { ...r, payload: JSON.parse(r.payload_json || "{}") } : null;
}

export function listActions(db, decisionId) {
  return db.prepare("SELECT * FROM action WHERE decision_id = ? ORDER BY created_at").all(decisionId).map(rowToAction);
}

/**
 * The conflict guard: at most one live outreach per customer per window.
 *
 * Two decisions on one account (a churn risk and a payment problem, say) would
 * otherwise each prepare their own email, and the customer would get two
 * unrelated notes from the same person in a week.
 */
export function outreachConflict(db, accountId, settings, asOf) {
  if (!accountId) return null;
  const days = limit("outreachCooldownDays", settings);
  const rows = db
    .prepare("SELECT * FROM action WHERE account_id = ? AND kind = 'draft_email' AND status != 'cancelled' ORDER BY created_at DESC")
    .all(accountId);
  for (const r of rows) {
    const age = daysBetween(r.created_at, asOf);
    if (age != null && age <= days) {
      const d = getDecision(db, r.decision_id);
      return { action: rowToAction(r), decision: d, daysAgo: age, windowDays: days };
    }
  }
  return null;
}

/**
 * Prepare a draft email for a decision.
 * Returns {ok:false, conflict} when the guard above refuses.
 */
export async function prepareDraftEmail(db, decisionId, { complete, force = false } = {}) {
  const d = getDecision(db, decisionId);
  if (!d) return { ok: false, error: "no such decision" };
  const settings = getSettings(db);
  const asOf = asOfFor(db);

  if (!force) {
    const clash = outreachConflict(db, d.account_id, settings, asOf);
    if (clash) {
      return {
        ok: false,
        conflict: true,
        error: `An email to this customer was already prepared ${clash.daysAgo === 0 ? "today" : `${clash.daysAgo} days ago`} for "${clash.decision?.title ?? "another decision"}". Open that one instead, or cancel it first.`,
        actionId: clash.action.id,
        decisionId: clash.decision?.id,
      };
    }
  }

  const account = d.account_id ? db.prepare("SELECT * FROM account WHERE id = ?").get(d.account_id) : null;
  const evidence = db.prepare("SELECT statement FROM decision_evidence WHERE decision_id = ? ORDER BY rank LIMIT 3").all(decisionId);

  // The packet here exists only to bound the numbers in the draft.
  const packet = buildPacket({
    situation: {
      kind: d.kind,
      accountId: d.account_id,
      signals: evidence.map((e, i) => ({ id: `S${i + 1}`, kind: "evidence", band: 1, statement: e.statement })),
      score: 0,
      severity: d.severity,
      impact: { amount: d.impact_amount, basis: d.impact_basis, currency: d.currency },
      daysToRenewal: null,
    },
    account,
    settings: { ...settings, pseudonymise: false },
    asOf,
  });

  const drafted = await draftEmail({
    packet,
    accountName: account?.name ?? "the customer",
    senderName: d.owner || (settings.owners?.[0] ?? ""),
    actionLabel: actionLabel(d.recommended_action_id),
    whyItMatters: d.why_it_matters,
    evidence: evidence.map((e) => e.statement),
    complete,
    db,
    decisionId,
    kind: d.kind,
  });

  const { subject, body } = splitEmail(drafted.text);
  const id = actionId();
  const payload = { subject, body, source: drafted.source, to: "", accountName: account?.name ?? null };
  db.prepare("INSERT INTO action (id, decision_id, account_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, 'draft_email', 'prepared', ?, ?)").run(
    id,
    decisionId,
    d.account_id,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
  logEvent(db, decisionId, "user", "action_prepared", { kind: "draft_email", source: drafted.source });
  return { ok: true, action: { id, kind: "draft_email", status: "prepared", payload } };
}

/**
 * Create a task. Sets the decision's owner and due date when they are empty,
 * because a task with an owner and a decision without one is two records
 * disagreeing about who is doing this.
 */
export function prepareTask(db, decisionId, { title, owner, dueAt, note } = {}) {
  const d = getDecision(db, decisionId);
  if (!d) return { ok: false, error: "no such decision" };
  const clean = String(title ?? "").trim();
  if (!clean) return { ok: false, error: "give the task a title" };

  const asOf = asOfFor(db);
  const due = dueAt || d.due_at || suggestedDue(d.severity, asOf);
  const id = actionId();
  const payload = { title: clean, owner: owner || d.owner || null, dueAt: due, note: String(note ?? "").trim() || null };
  db.prepare("INSERT INTO action (id, decision_id, account_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, 'task', 'prepared', ?, ?)").run(
    id,
    decisionId,
    d.account_id,
    JSON.stringify(payload),
    new Date().toISOString(),
  );

  const sets = [];
  const args = [];
  if (!d.owner && payload.owner) {
    sets.push("owner = ?");
    args.push(payload.owner);
  }
  if (!d.due_at && payload.dueAt) {
    sets.push("due_at = ?");
    args.push(payload.dueAt);
  }
  if (sets.length) {
    db.prepare(`UPDATE decision SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, new Date().toISOString(), decisionId);
  }
  logEvent(db, decisionId, "user", "action_prepared", { kind: "task", title: clean, owner: payload.owner, dueAt: payload.dueAt });
  return { ok: true, action: { id, kind: "task", status: "prepared", payload } };
}

/** Mark an action done or cancelled, or save an edited draft. */
export function updateAction(db, id, { status, payload } = {}) {
  const row = db.prepare("SELECT * FROM action WHERE id = ?").get(id);
  if (!row) return { ok: false, error: "no such action" };
  const next = { ...JSON.parse(row.payload_json || "{}"), ...(payload ?? {}) };
  const newStatus = status ?? row.status;
  if (!["prepared", "done", "cancelled"].includes(newStatus)) return { ok: false, error: "unknown status" };

  db.prepare("UPDATE action SET status = ?, payload_json = ?, done_at = ? WHERE id = ?").run(
    newStatus,
    JSON.stringify(next),
    newStatus === "done" ? new Date().toISOString() : null,
    id,
  );
  if (newStatus !== row.status) {
    logEvent(db, row.decision_id, "user", newStatus === "done" ? "action_done" : "action_cancelled", { kind: row.kind });
    // Doing something about a decision means it is in progress. Saying so here
    // saves the person a second click that they would forget anyway.
    if (newStatus === "done") {
      const d = getDecision(db, row.decision_id);
      if (d && ["new", "accepted"].includes(d.status)) {
        db.prepare("UPDATE decision SET status = 'in_progress', updated_at = ? WHERE id = ?").run(new Date().toISOString(), d.id);
        logEvent(db, d.id, "system", "status", { from: d.status, to: "in_progress", because: "an action was completed" });
      }
    }
  }
  return { ok: true, action: rowToAction(db.prepare("SELECT * FROM action WHERE id = ?").get(id)) };
}
