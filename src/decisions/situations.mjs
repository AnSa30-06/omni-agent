// Signals -> situations, and everything the model is NOT allowed to decide:
// severity, priority, money at stake, and the lifecycle label.
//
// 🔴 THE FALSE-POSITIVE GUARD IS A RULE, NOT A JUDGEMENT. A single signal never
// becomes a decision. One metric moving is noise; several moving together is a
// situation. That is enforced here, in code, so it holds even when the model is
// unavailable, confused, or replaced.
import { rules, limit } from "./rules.mjs";
import { isUnreliable } from "./signals.mjs";
import { situationId } from "./ids.mjs";
import { daysBetween } from "./format.mjs";

/** Sum of the bands of the signals a rule actually used. */
function scoreOf(signals) {
  return signals.reduce((n, s) => n + s.band, 0);
}

/**
 * Severity from score. Deterministic, and the ONLY severity the product acts
 * on: the model states its own, which is recorded and shown when it disagrees,
 * but never used for ordering.
 */
export function severityFor(kind, score, extra = {}) {
  const S = rules().severity;
  let sev = "low";
  if (score >= S.critical) sev = "critical";
  else if (score >= S.high) sev = "high";
  else if (score >= S.medium) sev = "medium";

  // A payment that has failed three times is at least high however low the
  // combined score is: the money is already not arriving.
  if (kind === "payment_risk" && extra.paymentBand >= 3 && (sev === "low" || sev === "medium")) sev = "high";
  if (kind === "cohort_shift") sev = extra.high ? "high" : "medium";
  return sev;
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
export const severityRank = (s) => SEVERITY_RANK[s] ?? 0;

/**
 * Priority orders the LLM queue and the Today page.
 *
 * Severity dominates; money breaks ties on a log scale so a $240k account
 * outranks a $12k one without a $2.4m account outranking everything forever;
 * a nearer renewal breaks the remaining ties.
 */
export function priorityFor({ severity, arr = 0, daysToRenewal = null }) {
  const base = severityRank(severity) * 10;
  const moneyTerm = Math.log10(Math.max(Number(arr) || 0, 1000)) * 2;
  const urgency = daysToRenewal == null ? 0 : Math.max(0, (365 - Math.min(daysToRenewal, 365)) / 365);
  return Number((base + moneyTerm + urgency).toFixed(4));
}

/**
 * Money at stake. Computed here, never by the model, and always paired with a
 * basis sentence saying what the number IS. When it cannot be computed the
 * amount is null and the basis says why - an invented estimate on a screen
 * about money is the fastest way to lose a reader's trust.
 */
export function impactFor({ kind, account, signals, settings = {} }) {
  const currency = settings.currency ?? "USD";
  const arr = Number(account?.arr) || 0;

  if (kind === "churn_risk") {
    return { amount: arr, basis: "annual contract value at risk", currency };
  }
  if (kind === "payment_risk") {
    const pay = signals.find((s) => s.kind === "payment_failed");
    return { amount: pay ? Number(pay.value) || 0 : 0, basis: "unpaid invoice", currency };
  }
  if (kind === "expansion") {
    const seatPrice = Number(settings.seatPriceMonthly);
    const seats = Number(account?.seats_purchased) || 0;
    const util = signals.find((s) => s.kind === "seat_util_high");
    if (!Number.isFinite(seatPrice) || seatPrice <= 0) {
      return { amount: null, basis: "not estimated: no seat price is set for this workspace", currency };
    }
    const used = util ? Number(util.value) || seats : seats;
    const extraSeats = Math.max(Math.ceil(used - seats), 0) + 5;
    return {
      amount: extraSeats * seatPrice * 12,
      basis: `${extraSeats} more seats at ${currency} ${seatPrice} a month`,
      currency,
    };
  }
  if (kind === "cohort_shift") {
    return { amount: null, basis: "combined ARR of the affected customers", currency };
  }
  return { amount: null, basis: "not estimated", currency };
}

/**
 * Match the situation rules against one account's signals.
 *
 * @returns {{situations: Array, watches: Array}}
 */
export function situationsFor({ account, signals, asOf, settings = {}, inCohort = false }) {
  const R = rules();
  let usable = signals.filter((s) => !isUnreliable(s) && s.band >= 1);

  // 🔴 A CHANGE SHARED BY MOST CUSTOMERS IS WEAKER EVIDENCE ABOUT ANY ONE OF
  // THEM. When the same usage move is happening across the customer base, this
  // account's own usage signal is discounted by one band. A customer genuinely
  // in trouble (a severe drop plus other signals) still raises a decision; a
  // healthy customer riding a company-wide dip drops to band 0 and does not.
  //
  // Without this, a product outage or a seasonal lull produces one decision per
  // customer and buries the handful that are actually about that customer.
  // Measured 2026-09-09: a healthy account raised a churn decision on the
  // cohort dataset purely because everyone's usage moved together.
  if (inCohort) {
    usable = usable
      .map((s) => (s.kind.startsWith("usage_") ? { ...s, band: s.band - 1, detail: { ...s.detail, cohortDiscounted: true } } : s))
      .filter((s) => s.band >= 1);
  }

  const byKind = new Map(usable.map((s) => [s.kind, s]));
  const situations = [];

  for (const [kind, cfg] of Object.entries(R.situations)) {
    if (kind === "cohort_shift") continue;

    const all = (cfg.requiresAll ?? []).map((k) => byKind.get(k)).filter(Boolean);
    if (all.length !== (cfg.requiresAll ?? []).length) continue;

    const any = (cfg.requiresAny ?? []).map((k) => byKind.get(k)).filter(Boolean);
    // `minBandForAlone` lets one severe signal stand on its own where the rule
    // says so - three failed payments needs no corroboration to be real.
    const strongEnoughAlone = cfg.minBandForAlone != null && all.some((s) => s.band >= cfg.minBandForAlone);
    if (!any.length && !strongEnoughAlone) continue;

    const used = [...all, ...any];
    const score = scoreOf(used);
    if (score < (cfg.minScore ?? 0)) continue;

    const paymentBand = byKind.get("payment_failed")?.band ?? 0;
    const severity = severityFor(kind, score, { paymentBand });
    const renewal = byKind.get("renewal_near");
    const daysToRenewal = renewal ? Number(renewal.value) : account.renewal_date ? daysBetween(asOf, account.renewal_date) : null;

    situations.push({
      id: situationId(),
      kind,
      accountId: account.id,
      fingerprint: `${account.id}:${kind}`,
      signalIds: used.map((s) => s.id),
      signals: used,
      score,
      severity,
      priority: priorityFor({ severity, arr: account.arr, daysToRenewal }),
      impact: impactFor({ kind, account, signals: used, settings }),
      daysToRenewal,
    });
  }

  // A signal that fired but justified no situation is a WATCH: shown on the
  // customer page with "only one signal, so this is not a decision yet", never
  // sent to the model, never allowed to interrupt anyone.
  const usedIds = new Set(situations.flatMap((s) => s.signalIds));
  const watches = usable.filter((s) => !usedIds.has(s.id) && s.kind !== "data_stale");

  return { situations, watches };
}

/**
 * The lifecycle label for one account this run. Deterministic, from the signals
 * that already exist. First matching rule wins.
 */
export function labelFor({ signals, situations, tenureDays, sevenDayUsers }) {
  const has = (kind, band = 1) => signals.some((s) => s.kind === kind && s.band >= band);
  const hasSituation = (kind) => situations.some((s) => s.kind === kind);

  if (has("payment_failed")) return "payment_issue";
  if (hasSituation("churn_risk")) return "at_risk";
  if (hasSituation("expansion")) return "expansion_ready";
  if (has("usage_drop_30d", 2) && Number(sevenDayUsers) < 1) return "dormant";
  if (Number.isFinite(tenureDays) && tenureDays < 90) return "new";
  if (signals.some((s) => s.band >= 1 && s.kind !== "data_stale")) return "watching";
  return "healthy";
}

export const LABELS = {
  payment_issue: "Payment issue",
  at_risk: "At risk",
  expansion_ready: "Expansion ready",
  dormant: "Dormant",
  new: "New",
  watching: "Watching",
  healthy: "Healthy",
};

/**
 * The cohort situation, when one was detected.
 * It carries no account: it is a statement about the whole customer base.
 */
export function cohortSituation({ cohort, accounts, settings = {} }) {
  if (!cohort) return null;
  const affected = accounts.filter((a) => cohort.accountIds.includes(a.id));
  const totalArr = affected.reduce((n, a) => n + (Number(a.arr) || 0), 0);
  const severity = severityFor("cohort_shift", 0, { high: cohort.high });
  const share = Math.round(cohort.share * 100);
  return {
    id: situationId(),
    kind: "cohort_shift",
    accountId: null,
    fingerprint: `cohort:${cohort.kind}`,
    signalIds: [],
    signals: [],
    score: 0,
    severity,
    priority: priorityFor({ severity, arr: totalArr }),
    impact: { amount: totalArr, basis: "combined ARR of the affected customers", currency: settings.currency ?? "USD" },
    cohort: { ...cohort, share, accountCount: affected.length, totalArr },
    daysToRenewal: null,
  };
}

/** How many situations may be sent to the model this run. */
export function reasoningCap(settings) {
  return limit("maxReasonedPerRun", settings);
}
