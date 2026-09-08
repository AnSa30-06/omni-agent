// The demo company: a synthetic SaaS business with planted situations.
//
// WHY GENERATED AND NOT HAND-WRITTEN. It is reproducible from a seed, it can be
// regenerated relative to today so the demo never looks stale, and it is
// written out as CSV and imported through the REAL importer - so the demo
// exercises the same path a customer's own export takes, rather than a
// shortcut that would hide a bug in the only code that matters.
//
// 🔴 THE FALSE-POSITIVE ACCOUNTS ARE THE POINT. Four accounts here each cross
// exactly one threshold while being otherwise healthy. If the system raises a
// decision about any of them, it is a threshold-flagger with a language model
// on top, not a decision system. `scenarios.json` records what each account is
// supposed to produce, and the evaluation harness scores against it.
import fs from "node:fs";
import path from "node:path";
import { toCsv } from "../tools/documents.mjs";
import { addDays, dayOf } from "./format.mjs";

/** mulberry32: tiny, seedable, and good enough for fake usage curves. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Acme", "Northwind", "Contoso", "Fabrikam", "Initech", "Umbrella", "Globex", "Soylent", "Hooli", "Vandelay", "Wonka", "Stark", "Cyberdyne", "Tyrell", "Gringotts", "Duff", "Wayne", "Oceanic", "Bluth", "Prestige", "Aperture", "Black Mesa", "Monarch", "Pied Piper", "Sterling", "Dunder", "Paper Street", "Nakatomi", "Weyland", "Massive Dynamic", "Virtucon", "Rekall", "Omni", "Zorg", "Encom", "Genco", "Klimpys", "Bushwood", "Ludlow", "Spacely", "Cogswell", "Gadget", "Yoyodyne", "Sirius", "Xanatos", "Ubik", "Krusty", "Slate Rock"];
const SUFFIX = ["Ltd", "Group", "Systems", "Digital", "Labs", "Partners", "Works", "Holdings"];
const INDUSTRIES = ["logistics", "healthcare", "retail", "fintech", "education", "media", "manufacturing", "travel"];
const SEGMENTS = ["enterprise", "mid-market", "small business"];
const PLANS = ["Starter", "Team", "Business"];
const ROLES = ["VP Operations", "Head of Support", "Director of Engineering", "COO", "Head of Product", "IT Manager"];
const OWNERS = ["Sam Rivera", "Jo Bennett", "Alex Chen", "Priya Nair"];

/**
 * Scenario mix. The counts add to 48 in the default `demo` dataset.
 * `expect` is what the evaluation harness scores the system against.
 */
const MIX = [
  { scenario: "healthy", count: 28, expect: { kind: null } },
  { scenario: "churn_clear", count: 4, expect: { kind: "churn_risk", minSeverity: "high" } },
  { scenario: "churn_subtle", count: 2, expect: { kind: "churn_risk", minSeverity: "medium" } },
  { scenario: "expansion", count: 3, expect: { kind: "expansion", minSeverity: "low" } },
  { scenario: "payment", count: 3, expect: { kind: "payment_risk", minSeverity: "medium" } },
  { scenario: "fp_ticket_spike", count: 1, expect: { kind: null } },
  { scenario: "fp_brief_dip", count: 1, expect: { kind: null } },
  { scenario: "fp_renewal_only", count: 1, expect: { kind: null } },
  { scenario: "fp_champion_quiet", count: 1, expect: { kind: null } },
  { scenario: "dismissed_unchanged", count: 1, expect: { kind: "churn_risk", suppressed: true } },
  { scenario: "dismissed_worse", count: 1, expect: { kind: "churn_risk", minSeverity: "high" } },
  { scenario: "stale_data", count: 1, expect: { kind: null } },
  { scenario: "healthy", count: 1, expect: { kind: null } },
];

/**
 * How the last 30 days compare with the 30 before them, per scenario.
 *
 * 🔴 THIS IS A RATIO OF WINDOW MEANS, NOT A SLOPE, and the difference is the
 * bug this table exists to prevent. The first version of this generator ramped
 * a decline across the whole 30-day window: "down 50%" by the last day, which
 * is only **-24% on the mean** - just under the -25% threshold. Every planted
 * churn account produced its renewal, ticket and champion signals and no usage
 * signal, so the churn rule (which requires usage) never fired and the demo
 * data quietly proved nothing. Measured 2026-09-09.
 *
 * Stating the ratio the SIGNAL will measure keeps the dataset honest about what
 * it is planting.
 */
const RATIO = {
  healthy: 1.14,
  churn_clear: 0.5, // -50%: band 2
  churn_subtle: 0.7, // -30%: band 1, and nothing else dramatic
  expansion: 1.85, // +85%: band 2
  payment: 0.82, // -18%: deliberately ABOVE the churn threshold, so payment_risk stands alone
  fp_ticket_spike: 1.05,
  fp_brief_dip: 1.0, // the dip is inserted below and has recovered
  fp_renewal_only: 1.1,
  fp_champion_quiet: 1.25,
  dismissed_unchanged: 0.62, // -38%, the same as when it was dismissed
  dismissed_worse: 0.36, // -64%: band 3, clearly worse than before
  stale_data: 1.0,
};

/**
 * The daily active-user curve for one scenario, ending at `asOf`.
 * Days 60-89 (the recent window) sit at `base * ratio`, with a short ramp at
 * the boundary so the line looks like a business rather than a step function.
 */
function usageCurve({ scenario, base, days, rand, cohort }) {
  let ratio = RATIO[scenario] ?? 1;
  // The company-wide variant: everyone's recent window drops by the same third,
  // healthy accounts included. Each account then shows the usage signal while
  // its own score stays below the churn threshold - which is the whole point:
  // one company-wide decision, not thirty individual ones.
  if (cohort) ratio *= 0.65;

  const out = [];
  const rampDays = 4;
  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    let level;
    const intoWindow = dayIndex - (days - 30);
    if (intoWindow < 0) {
      level = base; // the baseline window and everything older
    } else if (intoWindow < rampDays) {
      level = base * (1 + (ratio - 1) * ((intoWindow + 1) / rampDays));
    } else {
      level = base * ratio;
    }
    // A dip that RECOVERED: down hard a month ago, normal now. It sits in the
    // BASELINE window, so both 30-day means barely move and nothing fires.
    if (scenario === "fp_brief_dip" && dayIndex >= days - 52 && dayIndex <= days - 45) level = base * 0.45;

    const noise = 1 + (rand() - 0.5) * 0.1;
    out.push(Math.max(0, Math.round(level * noise)));
  }
  return out;
}

/**
 * Generate the dataset in memory.
 * @param {{seed?: number, accounts?: number, asOf?: string, cohort?: boolean, variant?: string}} opts
 */
export function generate(opts = {}) {
  const seed = opts.seed ?? 20260909;
  const rand = rng(seed);
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const days = 90;
  const cohort = opts.cohort === true;

  const mix = opts.variant === "edge" ? [
    { scenario: "healthy", count: 8, expect: { kind: null } },
    { scenario: "churn_subtle", count: 4, expect: { kind: "churn_risk", minSeverity: "medium" } },
    { scenario: "fp_ticket_spike", count: 2, expect: { kind: null } },
    { scenario: "fp_brief_dip", count: 2, expect: { kind: null } },
    { scenario: "fp_renewal_only", count: 2, expect: { kind: null } },
    { scenario: "fp_champion_quiet", count: 2, expect: { kind: null } },
  ] : MIX;

  const plan = [];
  for (const row of mix) for (let i = 0; i < row.count; i++) plan.push(row);

  const accounts = [];
  const usage = [];
  const contacts = [];
  const tickets = [];
  const invoices = [];
  const events = [];
  const scenarios = [];

  plan.forEach((entry, i) => {
    const id = `ACC-${String(i + 1).padStart(3, "0")}`;
    const name = `${FIRST[i % FIRST.length]} ${SUFFIX[Math.floor(rand() * SUFFIX.length)]}`;
    const { scenario } = entry;

    // ARR on a log-normal-ish spread: a few big accounts, many small ones.
    const arr = Math.round((6000 + Math.exp(rand() * 3.6) * 2600) / 500) * 500;
    const seats = Math.max(5, Math.round(arr / 1400));
    const planName = arr > 90000 ? "Business" : arr > 30000 ? "Team" : PLANS[0];
    const tenure = 120 + Math.floor(rand() * 900);
    const createdAt = addDays(asOf, -tenure);

    // Renewal timing carries the scenario: churn accounts renew soon, healthy
    // ones do not, and fp_renewal_only renews soon while being perfectly well.
    let renewalIn;
    if (scenario === "churn_clear") renewalIn = 20 + Math.floor(rand() * 30);
    else if (scenario === "churn_subtle") renewalIn = 60 + Math.floor(rand() * 25);
    else if (scenario === "fp_renewal_only") renewalIn = 18;
    else if (scenario === "dismissed_unchanged" || scenario === "dismissed_worse") renewalIn = 35 + Math.floor(rand() * 20);
    else renewalIn = 120 + Math.floor(rand() * 240);

    accounts.push({
      account_id: id,
      name,
      arr,
      plan: planName,
      seats_purchased: seats,
      renewal_date: addDays(asOf, renewalIn),
      owner: rand() < 0.6 ? OWNERS[Math.floor(rand() * OWNERS.length)] : "",
      segment: SEGMENTS[Math.floor(rand() * SEGMENTS.length)],
      industry: INDUSTRIES[Math.floor(rand() * INDUSTRIES.length)],
      created_at: createdAt,
    });

    // --- usage ---
    const base = Math.max(3, Math.round(seats * (0.45 + rand() * 0.3)));
    const curve = usageCurve({ scenario, base, days, rand, cohort: cohort && scenario === "healthy" });
    const stopAt = scenario === "stale_data" ? 15 : 0; // stop 15 days before asOf
    curve.forEach((v, k) => {
      const day = addDays(asOf, -(days - 1 - k));
      if (stopAt && day > addDays(asOf, -stopAt)) return;
      let seatsUsed = Math.min(seats, Math.round(v * 1.1));
      if (scenario === "expansion") seatsUsed = Math.min(Math.round(seats * 1.05), Math.round(v * 1.35));
      if (scenario === "churn_clear") seatsUsed = Math.round(seats * 0.32);
      usage.push({ account_id: id, day, active_users: v, sessions: Math.round(v * (2 + rand())), seats_used: seatsUsed });
    });

    // --- contacts ---
    const championQuietDays =
      scenario === "churn_clear" ? 15 + Math.floor(rand() * 25)
        : scenario === "fp_champion_quiet" ? 20
          : scenario === "dismissed_worse" ? 34
            : scenario === "payment" ? 16
              : Math.floor(rand() * 6);
    contacts.push({
      contact_id: `${id}-C1`,
      account_id: id,
      name: `Contact ${i + 1}`,
      role: ROLES[Math.floor(rand() * ROLES.length)],
      is_champion: "true",
      last_active_at: addDays(asOf, -championQuietDays),
    });
    contacts.push({
      contact_id: `${id}-C2`,
      account_id: id,
      name: `Contact ${i + 1}b`,
      role: "Billing",
      is_champion: "false",
      last_active_at: addDays(asOf, -Math.floor(rand() * 20)),
    });

    // --- tickets ---
    const priorCount = Math.max(1, Math.round(seats / 12));
    let currentCount = priorCount;
    if (scenario === "churn_clear") currentCount = priorCount * 2 + 3;
    if (scenario === "churn_subtle") currentCount = priorCount + Math.ceil(priorCount * 0.6) + 1;
    if (scenario === "fp_ticket_spike") currentCount = priorCount + 3;
    if (scenario === "dismissed_worse") currentCount = priorCount * 2 + 2;
    const push = (n, from, to, urgent = false) => {
      for (let k = 0; k < n; k++) {
        const at = addDays(asOf, -(from + Math.floor(rand() * (to - from))));
        tickets.push({
          ticket_id: `${id}-T${tickets.length}`,
          account_id: id,
          opened_at: at,
          closed_at: urgent && k === 0 ? "" : addDays(at, 1 + Math.floor(rand() * 5)),
          priority: urgent && k === 0 ? "urgent" : rand() < 0.25 ? "high" : "normal",
          subject: "Support request",
        });
      }
    };
    push(priorCount, 31, 60);
    push(currentCount, 0, 30, scenario === "churn_clear");

    // --- invoices ---
    // Billed on the 12th of the month, not exactly 30 days ago: an invoice due
    // on the window boundary lands one day OUTSIDE the 30-day payment window
    // and the failure is never seen. Measured 2026-09-09 - all three planted
    // payment accounts produced no payment signal at all.
    for (let m = 1; m <= 3; m++) {
      const due = addDays(asOf, -(m * 30 - 18));
      const failing = scenario === "payment" && m === 1;
      invoices.push({
        invoice_id: `${id}-I${m}`,
        account_id: id,
        due_at: due,
        amount: Math.round(arr / 12),
        status: failing ? "failed" : "paid",
        attempts: failing ? 2 + Math.floor(rand() * 2) : 0,
        paid_at: failing ? "" : addDays(due, 1),
      });
    }

    // --- events ---
    if (scenario === "expansion") {
      const n = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        events.push({ event_id: `${id}-E${k}`, account_id: id, at: addDays(asOf, -(1 + Math.floor(rand() * 13))), kind: "pricing_page_view", detail: "" });
      }
      events.push({ event_id: `${id}-EL`, account_id: id, at: addDays(asOf, -4), kind: "seat_limit_hit", detail: "" });
    }
    if (scenario === "dismissed_worse") {
      events.push({ event_id: `${id}-EC`, account_id: id, at: addDays(asOf, -12), kind: "champion_left", detail: "" });
    }

    scenarios.push({
      account_id: id,
      name,
      scenario,
      expect: entry.expect,
      arr,
      note:
        scenario.startsWith("fp_")
          ? "One metric moves; the account is otherwise healthy. NO decision should be raised."
          : scenario === "stale_data"
            ? "Usage data stops 15 days early. Usage signals must be marked unreliable and raise nothing."
            : scenario === "dismissed_unchanged"
              ? "A dismissed decision exists and nothing got worse. It must stay suppressed."
              : scenario === "dismissed_worse"
                ? "A dismissed decision exists and the account got worse. A new decision must be raised."
                : "",
    });
  });

  return {
    asOf,
    seed,
    cohort,
    files: {
      "accounts.csv": accounts,
      "usage_daily.csv": usage,
      "contacts.csv": contacts,
      "tickets.csv": tickets,
      "invoices.csv": invoices,
      "events.csv": events,
    },
    workspace: { name: cohort ? "Demo Company (company-wide event)" : "Demo Company", currency: "USD", seat_price_monthly: 25, as_of: asOf },
    scenarios,
  };
}

/** Column order per file, so an EMPTY table still writes a valid header row. */
const HEADERS = {
  "accounts.csv": ["account_id", "name", "arr", "plan", "seats_purchased", "renewal_date", "owner", "segment", "industry", "created_at"],
  "usage_daily.csv": ["account_id", "day", "active_users", "sessions", "seats_used"],
  "contacts.csv": ["contact_id", "account_id", "name", "role", "is_champion", "last_active_at"],
  "tickets.csv": ["ticket_id", "account_id", "opened_at", "closed_at", "priority", "subject"],
  "invoices.csv": ["invoice_id", "account_id", "due_at", "amount", "status", "attempts", "paid_at"],
  "events.csv": ["event_id", "account_id", "at", "kind", "detail"],
};

/**
 * ⚠️ A file with no rows still needs its HEADER. The first version returned an
 * empty string for an empty table, and the `edge` dataset - which plants no
 * events at all - then failed to import with "events.csv is missing the columns
 * event_id, account_id, at, kind". A valid file that happens to be empty is a
 * normal thing for a real customer to export, so the importer is right and the
 * writer was wrong.
 */
function recordsToCsv(name, records) {
  const headers = HEADERS[name] ?? [...new Set(records.flatMap((r) => Object.keys(r)))];
  return toCsv([headers, ...records.map((r) => headers.map((h) => r[h] ?? ""))]);
}

/** Write a generated dataset to a folder, ready for importFolder(). */
export function writeDataset(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, records] of Object.entries(data.files)) {
    fs.writeFileSync(path.join(dir, name), recordsToCsv(name, records), "utf8");
  }
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify(data.workspace, null, 2));
  fs.writeFileSync(path.join(dir, "scenarios.json"), JSON.stringify({ asOf: data.asOf, seed: data.seed, cohort: data.cohort, accounts: data.scenarios }, null, 2));
  return dir;
}

/** The three named variants, generated relative to `asOf`. */
export function variant(name, asOf) {
  if (name === "demo-cohort") return generate({ asOf, cohort: true, seed: 20260909 });
  if (name === "edge") return generate({ asOf, variant: "edge", seed: 771 });
  return generate({ asOf, seed: 20260909 });
}

export const VARIANTS = {
  demo: "48 customers with a mix of healthy, at-risk, expanding and false-positive accounts",
  "demo-cohort": "The same 48 customers, with a change that hits most of them at once",
  edge: "20 customers built only from the hard cases: subtle risk and near-misses",
};

/** The seeded decisions the two "dismissed" scenarios need to exist. */
export function seedPriorDecisions(db, data) {
  const rows = data.scenarios.filter((s) => s.scenario.startsWith("dismissed_"));
  const out = [];
  for (const s of rows) {
    out.push({
      accountId: s.account_id,
      kind: "churn_risk",
      reason: s.scenario === "dismissed_unchanged" ? "Seasonal dip, confirmed with the customer" : "Thought it was a seasonal dip",
      daysAgo: 10,
    });
  }
  return out;
}
