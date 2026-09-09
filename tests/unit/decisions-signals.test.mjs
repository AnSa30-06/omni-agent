// The signal engine, at its boundaries.
//
// Every assertion here is a number the product will put on a screen next to a
// customer's name. They are cheap; being wrong about one is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSignals, detectCohort, isUnreliable } from "../../src/decisions/signals.mjs";
import { pctChange, daysBetween, addDays } from "../../src/decisions/format.mjs";

const AS_OF = "2026-09-09";

function account(over = {}) {
  return { id: "A1", name: "Acme", arr: 50000, plan: "Team", seats_purchased: 40, renewal_date: null, created_at: "2024-01-01", ...over };
}

/** `days` days of one metric ending on `end`, at a constant value. */
function flat(metric, value, days, end = AS_OF) {
  const out = [];
  for (let i = 0; i < days; i++) out.push({ account_id: "A1", day: addDays(end, -i), metric, value });
  return out;
}

/** Recent window at `current`, the 30 before it at `baseline`. */
function twoWindows(current, baseline, { days = 30, metric = "active_users" } = {}) {
  return [...flat(metric, current, days), ...flat(metric, baseline, 30, addDays(AS_OF, -days))];
}

function run(over = {}) {
  return computeSignals({
    account: account(over.account),
    metrics: over.metrics ?? [],
    tickets: over.tickets ?? [],
    invoices: over.invoices ?? [],
    contacts: over.contacts ?? [],
    events: over.events ?? [],
    asOf: AS_OF,
    settings: over.settings ?? {},
  });
}
const find = (sigs, kind) => sigs.find((s) => s.kind === kind);

test("format: a zero baseline has no percentage, rather than Infinity", () => {
  assert.equal(pctChange(10, 0), null);
  assert.equal(pctChange(0, 10), -100);
  assert.equal(pctChange(5, 10), -50);
});

test("usage drop: the band boundary is exact", () => {
  // -24% must not fire; -25% must.
  const at24 = run({ metrics: twoWindows(76, 100) });
  assert.equal(find(at24, "usage_drop_30d"), undefined, "-24% is under the line and must not fire");
  const at25 = run({ metrics: twoWindows(75, 100) });
  assert.equal(find(at25, "usage_drop_30d").band, 1);
  const at40 = run({ metrics: twoWindows(60, 100) });
  assert.equal(find(at40, "usage_drop_30d").band, 2);
  const at60 = run({ metrics: twoWindows(40, 100) });
  assert.equal(find(at60, "usage_drop_30d").band, 3);
});

test("usage: a rise is a different signal, not a negative drop", () => {
  const s = run({ metrics: twoWindows(185, 100) });
  assert.equal(find(s, "usage_drop_30d"), undefined);
  assert.equal(find(s, "usage_rise_30d").band, 2);
  assert.match(find(s, "usage_rise_30d").statement, /rose 85%/);
});

test("usage: too few days is not a signal", () => {
  // 10 days in each window - below the 20-day minimum.
  const metrics = [...flat("active_users", 40, 10), ...flat("active_users", 100, 10, addDays(AS_OF, -30))];
  assert.equal(find(run({ metrics }), "usage_drop_30d"), undefined);
});

test("usage: a missing day is missing, not zero", () => {
  // 25 days present in the recent window, all at 100; the other 5 absent.
  // If absence counted as zero the mean would be 83 and this would look like a
  // 17% fall. It must look like no change at all.
  const metrics = [...flat("active_users", 100, 25), ...flat("active_users", 100, 30, addDays(AS_OF, -30))];
  const s = run({ metrics });
  assert.equal(find(s, "usage_drop_30d"), undefined);
  assert.equal(find(s, "usage_rise_30d"), undefined);
});

test("stale data marks the usage signals unreliable and says so", () => {
  // Data stops 8 days early: stale enough to flag, recent enough that the
  // 30-day window still holds the 20 days a usage signal needs. (At 15 days
  // stale there is no usage signal at all, which is also correct and is the
  // next test.)
  const metrics = [...flat("active_users", 50, 40, addDays(AS_OF, -8)), ...flat("active_users", 100, 30, addDays(AS_OF, -48))];
  const s = run({ metrics });
  const stale = find(s, "data_stale");
  assert.ok(stale, "a data_stale signal is expected");
  assert.equal(stale.band, 1);
  const drop = find(s, "usage_drop_30d");
  assert.ok(drop, "the usage signal is still computed");
  assert.ok(isUnreliable(drop), "but it must be flagged unreliable");
});

test("data so stale there are too few days produces no usage signal at all", () => {
  const metrics = twoWindows(50, 100).map((m) => ({ ...m, day: addDays(m.day, -15) }));
  const s = run({ metrics });
  assert.equal(find(s, "data_stale").band, 1);
  assert.equal(find(s, "usage_drop_30d"), undefined, "15 days stale leaves under 20 days in the window");
});

test("no usage data at all is reported, not silently skipped", () => {
  const s = run({ metrics: [] });
  assert.equal(find(s, "data_stale").detail.reason, "no_usage_rows");
});

test("renewal: smaller is worse, and a past renewal does not fire", () => {
  assert.equal(find(run({ account: { renewal_date: addDays(AS_OF, 91) } }), "renewal_near"), undefined);
  assert.equal(find(run({ account: { renewal_date: addDays(AS_OF, 90) } }), "renewal_near").band, 1);
  assert.equal(find(run({ account: { renewal_date: addDays(AS_OF, 45) } }), "renewal_near").band, 2);
  assert.equal(find(run({ account: { renewal_date: addDays(AS_OF, 21) } }), "renewal_near").band, 3);
  assert.equal(find(run({ account: { renewal_date: addDays(AS_OF, -5) } }), "renewal_near"), undefined);
});

test("tickets: a rise on a tiny base needs a minimum count too", () => {
  const t = (n, from, to, extra = {}) =>
    Array.from({ length: n }, (_, i) => ({
      id: `T${from}${i}`,
      account_id: "A1",
      opened_at: addDays(AS_OF, -(from + (i % Math.max(1, to - from)))),
      closed_at: addDays(AS_OF, -1),
      priority: "normal",
      ...extra,
    }));
  // 1 -> 2 is +100% but only 2 tickets: below the minimum of 3, so nothing.
  assert.equal(find(run({ tickets: [...t(1, 40, 50), ...t(2, 5, 20)] }), "tickets_up_30d"), undefined);
  // 4 -> 6 is +50% with 6 tickets: band 1.
  assert.equal(find(run({ tickets: [...t(4, 40, 55), ...t(6, 2, 25)] }), "tickets_up_30d").band, 1);
});

test("tickets: an urgent one still open pushes a band-2 rise to band 3", () => {
  const prior = Array.from({ length: 4 }, (_, i) => ({ id: `P${i}`, account_id: "A1", opened_at: addDays(AS_OF, -(35 + i)), closed_at: addDays(AS_OF, -30), priority: "normal" }));
  const now = Array.from({ length: 9 }, (_, i) => ({ id: `N${i}`, account_id: "A1", opened_at: addDays(AS_OF, -(2 + i)), closed_at: addDays(AS_OF, -1), priority: "normal" }));
  const withoutUrgent = find(run({ tickets: [...prior, ...now] }), "tickets_up_30d");
  assert.equal(withoutUrgent.band, 2);
  now[0].closed_at = null;
  now[0].priority = "urgent";
  const withUrgent = find(run({ tickets: [...prior, ...now] }), "tickets_up_30d");
  assert.equal(withUrgent.band, 3);
  assert.match(withUrgent.statement, /urgent/);
});

test("seat utilisation: zero seats purchased produces no signal and no division by zero", () => {
  const metrics = flat("seats_used", 5, 7);
  assert.equal(find(run({ account: { seats_purchased: 0 }, metrics }), "seat_util_low"), undefined);
  assert.equal(find(run({ account: { seats_purchased: null }, metrics }), "seat_util_low"), undefined);
});

test("seat utilisation: low and high are mutually exclusive", () => {
  const low = run({ account: { seats_purchased: 40 }, metrics: flat("seats_used", 12, 7) });
  assert.equal(find(low, "seat_util_low").band, 2);
  assert.equal(find(low, "seat_util_high"), undefined);
  const high = run({ account: { seats_purchased: 40 }, metrics: flat("seats_used", 38, 7) });
  assert.equal(find(high, "seat_util_high").band, 1);
  assert.equal(find(high, "seat_util_low"), undefined);
});

test("payment: attempts drive the band, and a big amount forces the top band", () => {
  const inv = (attempts, amount = 4000, at = -12) => [
    { id: "I1", account_id: "A1", due_at: addDays(AS_OF, at), amount, status: "failed", attempts },
  ];
  assert.equal(find(run({ invoices: inv(1) }), "payment_failed").band, 1);
  assert.equal(find(run({ invoices: inv(2) }), "payment_failed").band, 2);
  assert.equal(find(run({ invoices: inv(3) }), "payment_failed").band, 3);
  // One attempt, but the invoice is 20% of their ARR.
  assert.equal(find(run({ invoices: inv(1, 10000) }), "payment_failed").band, 3);
  // Paid invoices are not failures.
  assert.equal(find(run({ invoices: [{ id: "I2", account_id: "A1", due_at: addDays(AS_OF, -12), amount: 4000, status: "paid", attempts: 0 }] }), "payment_failed"), undefined);
});

test("payment: a failure older than the window is not raised", () => {
  const old = [{ id: "I9", account_id: "A1", due_at: addDays(AS_OF, -45), amount: 4000, status: "failed", attempts: 3 }];
  assert.equal(find(run({ invoices: old }), "payment_failed"), undefined);
});

test("champion: only champions count, and a departure is the top band", () => {
  const notChampion = [{ id: "C1", account_id: "A1", role: "Billing", is_champion: 0, last_active_at: addDays(AS_OF, -60) }];
  assert.equal(find(run({ contacts: notChampion }), "champion_inactive"), undefined);

  const quiet = [{ id: "C2", account_id: "A1", role: "COO", is_champion: 1, last_active_at: addDays(AS_OF, -20) }];
  assert.equal(find(run({ contacts: quiet }), "champion_inactive").band, 1);

  const gone = find(
    run({ contacts: quiet, events: [{ id: "E1", account_id: "A1", at: addDays(AS_OF, -3), kind: "champion_left" }] }),
    "champion_inactive",
  );
  assert.equal(gone.band, 3);
});

test("the statement always contains the numbers it claims", () => {
  const s = find(run({ metrics: twoWindows(55, 100) }), "usage_drop_30d");
  assert.match(s.statement, /45%/);
  assert.match(s.statement, /55/);
  assert.match(s.statement, /100/);
});

test("cohort: fires at 40% of accounts and not at 39%", () => {
  const make = (n, withDrop) => {
    const m = new Map();
    for (let i = 0; i < n; i++) {
      m.set(`A${i}`, i < withDrop ? [{ kind: "usage_drop_30d", band: 1, changePct: -30, detail: {} }] : []);
    }
    return m;
  };
  assert.equal(detectCohort(make(100, 39), 100), null);
  const hit = detectCohort(make(100, 40), 100);
  assert.equal(hit.kind, "usage_drop_30d");
  assert.equal(hit.direction, "down");
  assert.equal(hit.medianChange, -30);
});

test("cohort: needs a minimum number of accounts, not only a share", () => {
  const m = new Map([
    ["A1", [{ kind: "usage_drop_30d", band: 1, changePct: -30, detail: {} }]],
    ["A2", [{ kind: "usage_drop_30d", band: 1, changePct: -30, detail: {} }]],
  ]);
  // 100% share, but only 2 accounts: not a company-wide event, just a small
  // customer base with two unhappy customers.
  assert.equal(detectCohort(m, 2), null);
});

test("cohort ignores signals computed on stale data", () => {
  const m = new Map();
  for (let i = 0; i < 10; i++) {
    m.set(`A${i}`, [{ kind: "usage_drop_30d", band: 1, changePct: -30, detail: { unreliable: true } }]);
  }
  assert.equal(detectCohort(m, 10), null);
});
