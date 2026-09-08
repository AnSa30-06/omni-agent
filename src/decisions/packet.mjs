// The situation packet: the ONLY thing the model is ever shown.
//
// It contains sentences and labels, never tables and never raw rows. Three
// properties matter:
//
//  1. PSEUDONYMOUS BY DEFAULT. Customer names become "A-17" and contacts become
//     their role. The free model pool this product ships with is a set of
//     third-party proxies; sending a real customer list through one by default
//     would be a decision made on the user's behalf.
//  2. HASHED. The hash is the cache key. An unchanged packet means an unchanged
//     situation, which means no model call and no spend.
//  3. NUMBER-BOUNDED. numbersIn() extracts every number the packet contains, and
//     the validator refuses any answer containing a number that is not in that
//     set. This is what makes "the AI invented a figure" impossible rather than
//     unlikely.
import crypto from "node:crypto";
import { actionLabel, rules } from "./rules.mjs";
import { dayOf, daysBetween } from "./format.mjs";

export const PACKET_VERSION = 1;

/** A stable pseudonym for one account: A-1, A-2, ... in account-id order. */
export function pseudonymMap(accountIds) {
  const sorted = [...accountIds].sort();
  const map = new Map();
  sorted.forEach((id, i) => map.set(id, `A-${i + 1}`));
  return map;
}

/**
 * Build the packet for one situation.
 *
 * @param {object} args
 * @param {object} args.situation
 * @param {object} args.account
 * @param {Array}  args.priorDecisions  [{kind, status, when, reason, outcome}]
 * @param {object} args.settings
 * @param {string} args.asOf
 * @param {string} [args.ref]           pseudonym, when pseudonymising
 * @param {object} [args.cohort]        cohort context to attach to a member
 */
export function buildPacket({ situation, account, priorDecisions = [], settings = {}, asOf, ref = null, cohort = null }) {
  const R = rules();
  const pseudo = settings.pseudonymise !== false;
  const name = pseudo ? (ref ?? "A-?") : account?.name;

  const catalogue = (R.situations[situation.kind]?.actions ?? ["monitor"]).map((id) => ({ id, label: actionLabel(id) }));

  const packet = {
    packet_version: PACKET_VERSION,
    as_of: asOf,
    situation: { kind: situation.kind, score: situation.score, rule_severity: situation.severity },
    signals: situation.signals.map((s, i) => ({
      id: `S${i + 1}`,
      kind: s.kind,
      band: s.band,
      statement: s.statement,
    })),
    action_catalogue: catalogue,
  };

  if (situation.kind === "cohort_shift") {
    packet.cohort_summary = {
      direction: situation.cohort?.direction ?? null,
      share_percent: situation.cohort?.share ?? null,
      accounts_affected: situation.cohort?.accountCount ?? null,
      median_change_percent: situation.cohort?.medianChange ?? null,
    };
    packet.impact = { amount: situation.impact.amount, basis: situation.impact.basis, currency: situation.impact.currency };
  } else {
    packet.account = {
      ref: name,
      arr: Number(account?.arr) || 0,
      currency: situation.impact.currency,
      plan: account?.plan ?? null,
      seats_purchased: account?.seats_purchased ?? null,
      renewal_date: account?.renewal_date ? dayOf(account.renewal_date) : null,
      days_to_renewal: situation.daysToRenewal,
      owner: account?.owner || "unassigned",
      segment: account?.segment ?? null,
      industry: account?.industry ?? null,
      tenure_days: account?.created_at ? daysBetween(account.created_at, asOf) : null,
    };
    packet.impact = { amount: situation.impact.amount, basis: situation.impact.basis, currency: situation.impact.currency };
    packet.cohort = cohort
      ? { direction: cohort.direction, share_percent: cohort.share, accounts_affected: cohort.accountCount }
      : null;
  }

  // Context the person typed. Interpretation only: numbers in it are
  // deliberately NOT added to the grounding set (see numbersIn), so a figure
  // typed here cannot be laundered into a claim about the data.
  const ctx = String(settings.businessContext ?? "").trim();
  if (ctx) packet.business_context = ctx.slice(0, rules().limits.businessContextMaxChars ?? 1000);

  packet.prior_decisions = priorDecisions.slice(0, 3).map((d) => ({
    kind: d.kind,
    status: d.status,
    when: dayOf(d.when),
    reason: d.reason ?? null,
    outcome: d.outcome ?? null,
  }));

  return packet;
}

/**
 * Every number the packet asserts, normalised, as strings.
 *
 * ⚠️ `business_context` is EXCLUDED on purpose. It is prose a person typed; if
 * its numbers counted as grounded, writing "we lost 40% of users last year" in
 * Settings would license the model to say "usage fell 40%" about an account
 * where it did not.
 */
export function numbersIn(packet) {
  const set = new Set();
  const add = (v) => {
    if (v == null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    set.add(normaliseNumber(n));
    // A rounded form, so "45.2%" in a statement also licenses "45%".
    set.add(normaliseNumber(Math.round(n)));
    set.add(normaliseNumber(Math.abs(n)));
    set.add(normaliseNumber(Math.abs(Math.round(n))));
  };

  const scan = (text) => {
    for (const m of String(text ?? "").matchAll(/-?\d[\d,]*\.?\d*/g)) {
      add(m[0].replace(/,/g, ""));
    }
  };

  for (const s of packet.signals ?? []) scan(s.statement);
  const a = packet.account;
  if (a) {
    add(a.arr);
    add(a.seats_purchased);
    add(a.days_to_renewal);
    add(a.tenure_days);
    scan(a.renewal_date);
  }
  if (packet.impact) {
    add(packet.impact.amount);
    // A money figure is also commonly written in thousands: 50000 -> "50K".
    const amt = Number(packet.impact.amount);
    if (Number.isFinite(amt) && amt >= 1000) add(Math.round(amt / 1000));
  }
  for (const c of [packet.cohort, packet.cohort_summary]) {
    if (!c) continue;
    add(c.share_percent);
    add(c.accounts_affected);
    add(c.median_change_percent);
  }
  for (const d of packet.prior_decisions ?? []) scan(d.when);
  add(packet.situation?.score);
  return set;
}

/** "45.0" and "45" and "+45" all become "45". */
export function normaliseNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return String(Number(num.toFixed(2)));
}

/**
 * The cache key. Two packets that describe the same situation hash the same,
 * so nothing is re-reasoned for free.
 *
 * Deliberately excludes as_of: the date moves every day and would defeat the
 * cache entirely while the underlying situation was unchanged. Age-based
 * re-reasoning is handled separately, on a 7-day timer.
 */
export function hashPacket(packet) {
  const stable = {
    v: packet.packet_version,
    kind: packet.situation?.kind,
    score: packet.situation?.score,
    severity: packet.situation?.rule_severity,
    signals: (packet.signals ?? []).map((s) => `${s.kind}:${s.band}`).sort(),
    context: packet.business_context ?? "",
    cohort: packet.cohort?.share_percent ?? packet.cohort_summary?.share_percent ?? null,
    priors: (packet.prior_decisions ?? []).map((d) => `${d.kind}:${d.status}`).sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32);
}
