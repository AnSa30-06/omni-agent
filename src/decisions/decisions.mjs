// The decision itself: creating it, keeping it up to date across runs, and the
// state machine that governs its life.
//
// 🔴 THE DEDUPE RULE IS THE PRODUCT. A system that raises "Acme churn risk"
// again every morning is a system people turn off in a week. One OPEN decision
// per (account, kind) - enforced by a partial unique index in the schema, not
// only by this code - and a re-run either changes it or leaves it alone.
//
// 🔴 NOTHING AUTO-CLOSES. When the signals ease, the decision is FLAGGED and
// left open for a person to close. Auto-resolving would delete exactly the
// thing this product exists to capture: what happened, and whether what we did
// mattered.
import { decisionId, eventId, hypothesisId } from "./ids.mjs";
import { actionLabel, limit } from "./rules.mjs";
import { severityRank } from "./situations.mjs";
import { daysBetween, money, addDays } from "./format.mjs";

/** Legal status moves. Anything not listed is refused with this table shown. */
export const TRANSITIONS = {
  new: ["accepted", "snoozed", "dismissed"],
  accepted: ["in_progress", "waiting", "snoozed", "dismissed", "resolved"],
  in_progress: ["waiting", "snoozed", "dismissed", "resolved"],
  waiting: ["in_progress", "snoozed", "dismissed", "resolved"],
  snoozed: ["new", "accepted", "in_progress", "waiting", "dismissed", "resolved"],
  resolved: ["accepted"],
  dismissed: ["accepted"],
};

export const STATUS_LABELS = {
  new: "New",
  accepted: "Accepted",
  in_progress: "In progress",
  waiting: "Waiting",
  snoozed: "Snoozed",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const OPEN_STATUSES = ["new", "accepted", "in_progress", "waiting", "snoozed"];

export function logEvent(db, decId, actor, kind, data = null) {
  db.prepare("INSERT INTO decision_event (id, decision_id, at, actor, kind, data_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    eventId(),
    decId,
    new Date().toISOString(),
    actor,
    kind,
    data == null ? null : JSON.stringify(data),
  );
}

/** The decision title. Written by code so the list stays scannable. */
export function titleFor({ kind, accountName, signals = [], cohort = null }) {
  if (kind === "cohort_shift") {
    const dir = cohort?.direction === "up" ? "up" : "down";
    return `Company-wide: usage ${dir} for ${cohort?.share ?? "many"}% of customers`;
  }
  const label = { churn_risk: "churn risk", expansion: "expansion opportunity", payment_risk: "payment problem" }[kind] ?? kind;
  const strongest = [...signals].sort((a, b) => b.band - a.band)[0];
  const suffix = strongest
    ? {
        renewal_near: `renewal in ${strongest.value} days`,
        usage_drop_30d: `usage down ${Math.abs(strongest.changePct ?? 0)}%`,
        usage_rise_30d: `usage up ${strongest.changePct ?? 0}%`,
        seat_util_high: "seats nearly full",
        seat_util_low: "seats under-used",
        payment_failed: `payment failed ${strongest.detail?.attempts ?? 1} times`,
        champion_inactive: `champion quiet ${strongest.value} days`,
        tickets_up_30d: "support up",
        pricing_interest: "pricing viewed",
      }[strongest.kind]
    : null;
  return suffix ? `${accountName}: ${label}, ${suffix}` : `${accountName}: ${label}`;
}

function rowToDecision(row) {
  return row ? { ...row, signals_eased: Number(row.signals_eased) === 1 } : null;
}

export function getDecision(db, id) {
  return rowToDecision(db.prepare("SELECT * FROM decision WHERE id = ?").get(id));
}

function openWithFingerprint(db, fingerprint) {
  return rowToDecision(
    db
      .prepare(`SELECT * FROM decision WHERE fingerprint = ? AND status NOT IN ('resolved','dismissed')`)
      .get(fingerprint),
  );
}

function recentlyDismissed(db, fingerprint, asOf, days) {
  const row = db
    .prepare(
      `SELECT * FROM decision WHERE fingerprint = ? AND status = 'dismissed'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(fingerprint);
  if (!row) return null;
  const age = daysBetween(row.updated_at, asOf);
  return age != null && age <= days ? row : null;
}

/** The last few decisions on this account, for the packet's `prior_decisions`. */
export function priorDecisionsFor(db, accountId, limitN = 3) {
  const rows = db
    .prepare(
      `SELECT d.kind, d.status, d.updated_at, d.dismissed_reason, o.result
       FROM decision d LEFT JOIN outcome o ON o.decision_id = d.id
       WHERE d.account_id = ? AND d.status IN ('resolved','dismissed')
       ORDER BY d.updated_at DESC LIMIT ?`,
    )
    .all(accountId, limitN);
  return rows.map((r) => ({
    kind: r.kind,
    status: r.status,
    when: r.updated_at,
    reason: r.dismissed_reason,
    outcome: r.result ?? null,
  }));
}

function writeEvidence(db, decId, signals) {
  db.prepare("DELETE FROM decision_evidence WHERE decision_id = ?").run(decId);
  const ins = db.prepare("INSERT INTO decision_evidence (decision_id, signal_id, rank, statement, kind) VALUES (?, ?, ?, ?, ?)");
  signals.forEach((s, i) => ins.run(decId, s.id, i, s.statement, s.kind));
}

function writeHypotheses(db, decId, hypotheses = []) {
  db.prepare("DELETE FROM decision_hypothesis WHERE decision_id = ?").run(decId);
  const ins = db.prepare("INSERT INTO decision_hypothesis (id, decision_id, rank, text, confidence, evidence_ids_json) VALUES (?, ?, ?, ?, ?, ?)");
  hypotheses.forEach((h, i) => ins.run(hypothesisId(), decId, i, h.text, h.confidence, JSON.stringify(h.evidence ?? [])));
}

/**
 * Create or update the decision for one reasoned situation.
 *
 * @returns {{action: "created"|"updated"|"unchanged"|"suppressed", decisionId?: string}}
 */
export function upsertFromSituation(db, { situation, account, brief, model, packetHash, runId, asOf, settings = {} }) {
  const now = new Date().toISOString();
  const existing = openWithFingerprint(db, situation.fingerprint);
  const accountName = account?.name ?? "Company-wide";
  const title = titleFor({ kind: situation.kind, accountName, signals: situation.signals, cohort: situation.cohort });
  const source = brief ? "model" : "rule_only";

  // A veto from the model. The situation is recorded on the run; no decision is
  // raised. If one is already open, it is left exactly as it is - the person may
  // be working on it.
  if (brief && brief.actionable === false && !existing) {
    return { action: "not_actionable", reason: brief.not_actionable_reason };
  }

  const recAction = brief?.recommended_action?.id ?? defaultActionFor(situation.kind);
  const fields = {
    title,
    severity: situation.severity,
    confidence: brief?.confidence ?? null,
    impact_amount: situation.impact.amount,
    impact_basis: situation.impact.basis,
    currency: situation.impact.currency,
    why_it_matters: brief?.why_it_matters ?? null,
    recommended_action_id: recAction,
    recommended_action_text: actionLabel(recAction),
    rationale: brief?.recommended_action?.rationale ?? null,
    reasoning_source: source,
    model: model ?? null,
    packet_hash: packetHash ?? null,
  };

  if (!existing) {
    const dismissed = recentlyDismissed(db, situation.fingerprint, asOf, limit("dismissedSuppressDays", settings));
    if (dismissed && severityRank(situation.severity) <= severityRank(dismissed.severity)) {
      // Dismissed recently and no worse than it was. Raising it again would be
      // the product arguing with a decision the person already made.
      return { action: "suppressed", becauseOf: dismissed.id, dismissedAt: dismissed.updated_at, reason: dismissed.dismissed_reason };
    }

    const id = decisionId();
    db.prepare(
      `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, confidence, status,
         impact_amount, impact_basis, currency, why_it_matters, recommended_action_id, recommended_action_text,
         rationale, reasoning_source, model, prompt_version, packet_hash, first_run_id, last_run_id,
         last_situation_id, created_at, updated_at, reasoning_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, situation.accountId, situation.fingerprint, situation.kind, fields.title, fields.severity, fields.confidence,
      fields.impact_amount, fields.impact_basis, fields.currency, fields.why_it_matters,
      fields.recommended_action_id, fields.recommended_action_text, fields.rationale, fields.reasoning_source,
      fields.model, 1, fields.packet_hash, runId, runId, situation.id, now, now,
      brief ? null : (situation.reasoningError ?? null),
    );
    writeEvidence(db, id, situation.signals);
    writeHypotheses(db, id, brief?.hypotheses);
    logEvent(db, id, "system", "created", {
      severity: fields.severity,
      score: situation.score,
      signals: situation.signals.map((s) => `${s.kind}:${s.band}`),
      source,
      dismissedBefore: dismissed ? { at: dismissed.updated_at, reason: dismissed.dismissed_reason } : null,
    });
    return { action: "created", decisionId: id, escalatedFromDismissed: !!dismissed };
  }

  // An open decision exists. Did anything actually change?
  const before = existing.severity;
  const unchanged = existing.packet_hash && packetHash && existing.packet_hash === packetHash;
  if (unchanged) {
    db.prepare("UPDATE decision SET last_run_id = ?, last_situation_id = ?, signals_eased = 0 WHERE id = ?").run(runId, situation.id, existing.id);
    return { action: "unchanged", decisionId: existing.id };
  }

  db.prepare(
    `UPDATE decision SET title = ?, severity = ?, confidence = ?, impact_amount = ?, impact_basis = ?, currency = ?,
       why_it_matters = COALESCE(?, why_it_matters), recommended_action_id = ?, recommended_action_text = ?,
       rationale = COALESCE(?, rationale), reasoning_source = ?, model = COALESCE(?, model), packet_hash = ?,
       last_run_id = ?, last_situation_id = ?, updated_at = ?, signals_eased = 0,
       reasoning_error = ?
     WHERE id = ?`,
  ).run(
    fields.title, fields.severity, fields.confidence, fields.impact_amount, fields.impact_basis, fields.currency,
    fields.why_it_matters, fields.recommended_action_id, fields.recommended_action_text, fields.rationale,
    fields.reasoning_source, fields.model, fields.packet_hash, runId, situation.id, now,
    brief ? null : (situation.reasoningError ?? existing.reasoning_error),
    existing.id,
  );
  writeEvidence(db, existing.id, situation.signals);
  if (brief) writeHypotheses(db, existing.id, brief.hypotheses);

  const worse = severityRank(situation.severity) > severityRank(before);
  logEvent(db, existing.id, "system", worse ? "escalated" : "updated", {
    from: before,
    to: situation.severity,
    signals: situation.signals.map((s) => `${s.kind}:${s.band}`),
  });

  // A snoozed decision that got WORSE wakes up. The person snoozed the problem
  // they were shown, not a bigger one.
  if (worse && existing.status === "snoozed") {
    db.prepare("UPDATE decision SET status = COALESCE(status_before_snooze, 'new'), snoozed_until = NULL, status_before_snooze = NULL WHERE id = ?").run(
      existing.id,
    );
    logEvent(db, existing.id, "system", "unsnoozed", { reason: "the situation got worse" });
  }

  return { action: "updated", decisionId: existing.id, escalated: worse };
}

function defaultActionFor(kind) {
  return { churn_risk: "technical_review", expansion: "expansion_call", payment_risk: "billing_contact", cohort_shift: "monitor" }[kind] ?? "monitor";
}

/**
 * Mark every open decision that the current run did NOT re-detect.
 * Flagged, never closed - see the note at the top of this file.
 */
export function flagEased(db, runId, seenFingerprints) {
  const open = db.prepare(`SELECT id, fingerprint, signals_eased FROM decision WHERE status NOT IN ('resolved','dismissed')`).all();
  let flagged = 0;
  for (const row of open) {
    if (seenFingerprints.has(row.fingerprint)) continue;
    if (Number(row.signals_eased) === 1) continue;
    db.prepare("UPDATE decision SET signals_eased = 1 WHERE id = ?").run(row.id);
    logEvent(db, row.id, "system", "note", { text: "The signals that raised this have eased. It stays open until you close it." });
    flagged++;
  }
  return flagged;
}

// --- the state machine ------------------------------------------------------

function refuse(status) {
  return { ok: false, error: `a decision that is "${STATUS_LABELS[status] ?? status}" cannot move there`, allowed: TRANSITIONS[status] ?? [] };
}

export function setStatus(db, id, next, { actor = "user", data = null } = {}) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  if (d.status === next) return { ok: true, decision: d, unchanged: true };
  if (!(TRANSITIONS[d.status] ?? []).includes(next)) return refuse(d.status);

  db.prepare("UPDATE decision SET status = ?, updated_at = ?, snoozed_until = NULL, status_before_snooze = NULL WHERE id = ?").run(
    next,
    new Date().toISOString(),
    id,
  );
  logEvent(db, id, actor, "status", { from: d.status, to: next, ...(data ?? {}) });
  return { ok: true, decision: getDecision(db, id) };
}

export function setOwner(db, id, owner) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  db.prepare("UPDATE decision SET owner = ?, updated_at = ? WHERE id = ?").run(owner || null, new Date().toISOString(), id);
  logEvent(db, id, "user", "owner", { from: d.owner, to: owner || null });
  return { ok: true, decision: getDecision(db, id) };
}

export function setDue(db, id, dueAt) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  db.prepare("UPDATE decision SET due_at = ?, updated_at = ? WHERE id = ?").run(dueAt || null, new Date().toISOString(), id);
  logEvent(db, id, "user", "due", { from: d.due_at, to: dueAt || null });
  return { ok: true, decision: getDecision(db, id) };
}

export function snooze(db, id, until) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  if (!until) return { ok: false, error: "a snooze needs a date to come back on" };
  if (!(TRANSITIONS[d.status] ?? []).includes("snoozed")) return refuse(d.status);
  db.prepare("UPDATE decision SET status = 'snoozed', status_before_snooze = ?, snoozed_until = ?, updated_at = ? WHERE id = ?").run(
    d.status,
    until,
    new Date().toISOString(),
    id,
  );
  logEvent(db, id, "user", "snoozed", { until, from: d.status });
  return { ok: true, decision: getDecision(db, id) };
}

export function dismiss(db, id, reason) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  const text = String(reason ?? "").trim();
  if (text.length < 3) return { ok: false, error: "say briefly why you are dismissing this, so it makes sense later" };
  if (!(TRANSITIONS[d.status] ?? []).includes("dismissed")) return refuse(d.status);
  db.prepare("UPDATE decision SET status = 'dismissed', dismissed_reason = ?, updated_at = ? WHERE id = ?").run(
    text,
    new Date().toISOString(),
    id,
  );
  logEvent(db, id, "user", "dismissed", { reason: text });
  return { ok: true, decision: getDecision(db, id) };
}

export const OUTCOMES = {
  renewed: "Renewed",
  churned: "Churned",
  expanded: "Expanded",
  payment_recovered: "Payment recovered",
  no_change: "No change",
  unknown: "Not known",
};

export function resolve(db, id, { result, note = null, arrAfter = null }) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  if (!Object.hasOwn(OUTCOMES, result)) {
    return { ok: false, error: "pick what happened", allowed: Object.keys(OUTCOMES) };
  }
  if (!(TRANSITIONS[d.status] ?? []).includes("resolved")) return refuse(d.status);
  const now = new Date().toISOString();
  // Status and outcome in ONE transaction: a resolved decision with no recorded
  // outcome is the exact hole this product exists to close.
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE decision SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    db.prepare(
      "INSERT INTO outcome (decision_id, result, note, recorded_at, arr_after) VALUES (?, ?, ?, ?, ?) ON CONFLICT(decision_id) DO UPDATE SET result = excluded.result, note = excluded.note, recorded_at = excluded.recorded_at, arr_after = excluded.arr_after",
    ).run(id, result, note || null, now, arrAfter == null ? null : Number(arrAfter));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  logEvent(db, id, "user", "resolved", { result, note: note || null });
  logEvent(db, id, "user", "outcome", { result, arrAfter });
  return { ok: true, decision: getDecision(db, id) };
}

export function reopen(db, id) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  if (!["resolved", "dismissed"].includes(d.status)) return { ok: false, error: "this decision is already open" };
  db.prepare("UPDATE decision SET status = 'accepted', resolved_at = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  logEvent(db, id, "user", "status", { from: d.status, to: "accepted", reopened: true });
  return { ok: true, decision: getDecision(db, id) };
}

export function addNote(db, id, text) {
  const d = getDecision(db, id);
  if (!d) return { ok: false, error: "no such decision" };
  const note = String(text ?? "").trim();
  if (!note) return { ok: false, error: "write something first" };
  logEvent(db, id, "user", "note", { text: note });
  db.prepare("UPDATE decision SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return { ok: true };
}

/** A one-line summary of the money, for cards. */
export function impactLine(d) {
  if (d.impact_amount == null) return d.impact_basis ?? "";
  return `${money(d.impact_amount, d.currency)} ${d.impact_basis}`;
}

/** Suggested due date when a decision is accepted, from its severity. */
export function suggestedDue(severity, asOf) {
  const days = { critical: 2, high: 5, medium: 10, low: 21 }[severity] ?? 7;
  return addDays(asOf, days);
}
