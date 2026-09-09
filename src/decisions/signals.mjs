// The deterministic signal engine.
//
// 🔴 THE CENTRAL RULE OF THIS PRODUCT LIVES HERE: code computes every number,
// the model only reads sentences. A signal is a pure function of the raw tables,
// a window and an `asOf` date. Its output is a band (0-3), the numbers that
// produced it, and ONE evidence sentence written from a template.
//
// The model is never shown a row, never shown a table, and never asked to
// compute a percentage. That is what makes the arithmetic auditable and makes
// "the AI made up a number" impossible rather than unlikely.
//
// Two rules that are easy to get wrong and are tested:
//   - A day with NO row is MISSING, not zero. Treating it as zero turns a
//     reporting gap into a usage collapse.
//   - A zero baseline has no percentage. It yields band 0 with a reason, never
//     Infinity and never 100%.
import { rules, bandsFor } from "./rules.mjs";
import { signalId } from "./ids.mjs";
import { daysBetween, dayOf, addDays, pctChange, num, money, humanDate, fill } from "./format.mjs";

/**
 * Which band a value falls into, for an ascending threshold list.
 * `bands` may contain null for "this band is not reachable for this signal".
 */
function bandAscending(value, bands) {
  let band = 0;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i] == null) continue;
    if (value >= bands[i]) band = i + 1;
  }
  return band;
}

/** Same, for thresholds that are negative and descend (a usage DROP). */
function bandDescending(value, bands) {
  let band = 0;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i] == null) continue;
    if (value <= bands[i]) band = i + 1;
  }
  return band;
}

/** Same, for thresholds where SMALLER is worse (days to renewal, seat share). */
function bandSmallerIsWorse(value, bands) {
  let band = 0;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i] == null) continue;
    if (value <= bands[i]) band = i + 1;
  }
  return band;
}

/**
 * Mean of a metric over the `days` days ENDING on `end` (inclusive).
 * Returns {mean, days} where `days` is how many days actually had a row.
 */
function meanOver(rows, metric, end, days) {
  const start = addDays(end, -(days - 1));
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (r.metric !== metric) continue;
    const d = dayOf(r.day);
    if (d >= start && d <= end) {
      sum += r.value;
      n += 1;
    }
  }
  return { mean: n ? sum / n : null, days: n };
}

function make(kind, band, statement, extra = {}) {
  return {
    id: signalId(),
    kind,
    band,
    statement,
    direction: extra.direction ?? null,
    value: extra.value ?? null,
    baseline: extra.baseline ?? null,
    changePct: extra.changePct ?? null,
    windowDays: extra.windowDays ?? null,
    detail: extra.detail ?? {},
  };
}

/**
 * Compute every signal for one account.
 *
 * @param {object} ctx
 * @param {object} ctx.account       row from `account`
 * @param {Array}  ctx.metrics       rows from `metric_daily` for this account
 * @param {Array}  ctx.tickets       rows from `ticket`
 * @param {Array}  ctx.invoices      rows from `invoice`
 * @param {Array}  ctx.contacts      rows from `contact`
 * @param {Array}  ctx.events        rows from `event`
 * @param {string} ctx.asOf          YYYY-MM-DD
 * @param {object} ctx.settings
 * @returns {Array} signals with band >= 1, plus any band-0 signal carrying a reason
 */
export function computeSignals(ctx) {
  const { account, metrics = [], tickets = [], invoices = [], contacts = [], events = [], asOf, settings = {} } = ctx;
  const R = rules();
  const out = [];
  const currency = settings.currency ?? "USD";

  // --- data freshness, computed FIRST because it gates the usage signals -----
  const usageDays = metrics.filter((m) => m.metric === "active_users").map((m) => dayOf(m.day)).sort();
  const lastDay = usageDays.length ? usageDays[usageDays.length - 1] : null;
  const staleDays = lastDay ? daysBetween(lastDay, asOf) : null;
  let usageUnreliable = false;
  if (lastDay && staleDays != null) {
    const band = bandAscending(staleDays, bandsFor("data_stale", settings));
    if (band > 0) {
      usageUnreliable = true;
      out.push(
        make("data_stale", band, fill(R.signals.data_stale.template, { lastDay: humanDate(lastDay), days: staleDays }), {
          value: staleDays,
          detail: { lastDay },
        }),
      );
    }
  } else if (!lastDay) {
    usageUnreliable = true;
    out.push(make("data_stale", 1, "There is no usage data for this customer at all.", { detail: { reason: "no_usage_rows" } }));
  }

  // --- usage over 30 days ---------------------------------------------------
  const cfg30 = R.signals.usage_drop_30d;
  const cur30 = meanOver(metrics, "active_users", asOf, cfg30.window);
  const base30 = meanOver(metrics, "active_users", addDays(asOf, -cfg30.window), cfg30.baselineWindow);
  if (cur30.days >= cfg30.minDays && base30.days >= cfg30.minDays) {
    const change = pctChange(cur30.mean, base30.mean);
    if (change == null) {
      // A zero baseline. Not a 100% rise, not an error - simply no percentage.
    } else if (change < 0) {
      const band = bandDescending(change, bandsFor("usage_drop_30d", settings));
      if (band > 0) {
        out.push(
          make(
            "usage_drop_30d",
            band,
            fill(cfg30.template, { absChangePct: Math.abs(change), current: num(cur30.mean), baseline: num(base30.mean) }),
            { direction: "down", value: cur30.mean, baseline: base30.mean, changePct: change, windowDays: 30, detail: { unreliable: usageUnreliable } },
          ),
        );
      }
    } else {
      const band = bandAscending(change, bandsFor("usage_rise_30d", settings));
      if (band > 0) {
        out.push(
          make(
            "usage_rise_30d",
            band,
            fill(R.signals.usage_rise_30d.template, { changePct: change, current: num(cur30.mean), baseline: num(base30.mean) }),
            { direction: "up", value: cur30.mean, baseline: base30.mean, changePct: change, windowDays: 30, detail: { unreliable: usageUnreliable } },
          ),
        );
      }
    }
  }

  // --- usage over 7 days ----------------------------------------------------
  const cfg7 = R.signals.usage_drop_7d;
  const cur7 = meanOver(metrics, "active_users", asOf, cfg7.window);
  const base7 = meanOver(metrics, "active_users", addDays(asOf, -cfg7.window), cfg7.baselineWindow);
  if (cur7.days >= cfg7.minDays && base7.days >= cfg7.minDays) {
    const change = pctChange(cur7.mean, base7.mean);
    if (change != null && change < 0) {
      const band = bandDescending(change, bandsFor("usage_drop_7d", settings));
      if (band > 0) {
        out.push(
          make("usage_drop_7d", band, fill(cfg7.template, { absChangePct: Math.abs(change), current: num(cur7.mean), baseline: num(base7.mean) }), {
            direction: "down",
            value: cur7.mean,
            baseline: base7.mean,
            changePct: change,
            windowDays: 7,
            detail: { unreliable: usageUnreliable },
          }),
        );
      }
    }
  }

  // --- renewal --------------------------------------------------------------
  if (account.renewal_date) {
    const days = daysBetween(asOf, account.renewal_date);
    if (days != null && days >= 0) {
      const band = bandSmallerIsWorse(days, bandsFor("renewal_near", settings));
      if (band > 0) {
        out.push(
          make("renewal_near", band, fill(R.signals.renewal_near.template, { days, date: humanDate(account.renewal_date) }), {
            value: days,
            detail: { renewalDate: dayOf(account.renewal_date) },
          }),
        );
      }
    }
  }

  // --- support tickets ------------------------------------------------------
  const tCfg = R.signals.tickets_up_30d;
  const windowStart = addDays(asOf, -(tCfg.window - 1));
  const priorStart = addDays(asOf, -(tCfg.window * 2 - 1));
  const current = tickets.filter((t) => dayOf(t.opened_at) >= windowStart && dayOf(t.opened_at) <= asOf).length;
  const prior = tickets.filter((t) => dayOf(t.opened_at) >= priorStart && dayOf(t.opened_at) < windowStart).length;
  const urgentOpen = tickets.some(
    (t) => !t.closed_at && String(t.priority).toLowerCase() === "urgent" && dayOf(t.opened_at) >= priorStart,
  );
  if (prior > 0 && current > prior) {
    const rise = pctChange(current, prior);
    const thresholds = bandsFor("tickets_up_30d", settings);
    let band = 0;
    for (let i = 0; i < thresholds.length; i++) {
      if (thresholds[i] == null) continue;
      const minCurrent = tCfg.minCurrent?.[i];
      if (rise >= thresholds[i] && (minCurrent == null || current >= minCurrent)) band = i + 1;
    }
    // An urgent ticket still open pushes a band-2 rise to band 3: the customer
    // is not merely asking more questions, something is broken for them now.
    if (band >= 2 && urgentOpen) band = 3;
    if (band > 0) {
      out.push(
        make("tickets_up_30d", band, fill(tCfg.template, { baseline: prior, current, urgentClause: urgentOpen ? "; 1 open ticket is marked urgent" : "" }), {
          direction: "up",
          value: current,
          baseline: prior,
          changePct: rise,
          windowDays: tCfg.window,
          detail: { urgentOpen },
        }),
      );
    }
  }

  // --- seat utilisation -----------------------------------------------------
  const seats = Number(account.seats_purchased);
  if (Number.isFinite(seats) && seats > 0) {
    const used = meanOver(metrics, "seats_used", asOf, 7);
    if (used.days > 0 && used.mean != null) {
      const pct = Math.round((used.mean / seats) * 100);
      const lowBand = bandSmallerIsWorse(pct, bandsFor("seat_util_low", settings));
      const seatLimitHit = events.some(
        (e) => e.kind === "seat_limit_hit" && daysBetween(e.at, asOf) != null && daysBetween(e.at, asOf) <= 14,
      );
      const highThresholds = bandsFor("seat_util_high", settings);
      let highBand = bandAscending(pct, highThresholds);
      if (highBand === 1 && seatLimitHit) highBand = 2;
      if (lowBand > 0) {
        out.push(
          make("seat_util_low", lowBand, fill(R.signals.seat_util_low.template, { used: num(used.mean), purchased: seats, pct }), {
            value: used.mean,
            baseline: seats,
            detail: { pct },
          }),
        );
      } else if (highBand > 0) {
        out.push(
          make("seat_util_high", highBand, fill(R.signals.seat_util_high.template, { used: num(used.mean), purchased: seats, pct }), {
            value: used.mean,
            baseline: seats,
            detail: { pct, seatLimitHit },
          }),
        );
      }
    }
  }

  // --- payments -------------------------------------------------------------
  const pCfg = R.signals.payment_failed;
  const failWindow = addDays(asOf, -(pCfg.window - 1));
  const failed = invoices
    .filter((i) => String(i.status).toLowerCase() === "failed" && dayOf(i.due_at) >= failWindow && dayOf(i.due_at) <= asOf)
    .sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0));
  if (failed.length) {
    const worst = failed[0];
    const attempts = Number(worst.attempts ?? 1);
    let band = bandAscending(attempts, bandsFor("payment_failed", settings));
    const arr = Number(account.arr) || 0;
    if (arr > 0 && Number(worst.amount) >= arr * (pCfg.arrShareForTopBand ?? 0.1)) band = Math.max(band, 3);
    if (band > 0) {
      out.push(
        make("payment_failed", band, fill(pCfg.template, { amount: money(worst.amount, currency), date: humanDate(worst.due_at), attempts }), {
          value: Number(worst.amount) || 0,
          detail: { attempts, invoiceId: worst.id },
        }),
      );
    }
  }

  // --- champion -------------------------------------------------------------
  const champions = contacts.filter((c) => Number(c.is_champion) === 1);
  const left = events.some((e) => e.kind === "champion_left" && daysBetween(e.at, asOf) != null && daysBetween(e.at, asOf) <= 60);
  if (champions.length) {
    const quietest = champions
      .map((c) => ({ c, days: c.last_active_at ? daysBetween(c.last_active_at, asOf) : null }))
      .filter((x) => x.days != null)
      .sort((a, b) => b.days - a.days)[0];
    if (quietest) {
      let band = bandAscending(quietest.days, bandsFor("champion_inactive", settings));
      if (left) band = 3;
      if (band > 0) {
        out.push(
          make("champion_inactive", band, fill(R.signals.champion_inactive.template, { role: quietest.c.role ?? "primary contact", days: quietest.days }), {
            value: quietest.days,
            detail: { championLeft: left },
          }),
        );
      }
    }
  }

  // --- pricing interest -----------------------------------------------------
  const piCfg = R.signals.pricing_interest;
  const piStart = addDays(asOf, -(piCfg.window - 1));
  const views = events.filter((e) => e.kind === "pricing_page_view" && dayOf(e.at) >= piStart && dayOf(e.at) <= asOf).length;
  if (views > 0) {
    const band = bandAscending(views, bandsFor("pricing_interest", settings));
    if (band > 0) {
      out.push(make("pricing_interest", band, fill(piCfg.template, { n: views }), { value: views, windowDays: piCfg.window }));
    }
  }

  // Usage signals computed on stale data are marked so the situation rules can
  // ignore them. They are still SHOWN, with the warning, because hiding them
  // would leave the customer page looking like nothing is happening.
  if (usageUnreliable) {
    for (const s of out) {
      if (s.kind.startsWith("usage_")) s.detail = { ...s.detail, unreliable: true };
    }
  }

  return out;
}

/** True when this signal must not be used to justify a situation. */
export function isUnreliable(signal) {
  return signal?.detail?.unreliable === true;
}

/**
 * Cohort detection across the whole run.
 *
 * A company-wide change is the case where blaming an individual account is
 * WRONG. Without this, a product outage or a seasonal dip produces thirty
 * churn-risk decisions and buries the one that matters.
 *
 * @param {Map<string, Array>} byAccount accountId -> signals
 * @param {number} totalAccounts
 * @returns {object|null} {direction, kind, share, accountIds, medianChange}
 */
export function detectCohort(byAccount, totalAccounts, settings = {}) {
  const cfg = rules().situations.cohort_shift;
  if (totalAccounts < (cfg.minAccounts ?? 5)) return null;

  for (const [kind, direction] of [
    ["usage_drop_30d", "down"],
    ["usage_rise_30d", "up"],
  ]) {
    const hits = [];
    for (const [accountId, signals] of byAccount) {
      const s = signals.find((x) => x.kind === kind && x.band >= 1 && !isUnreliable(x));
      if (s) hits.push({ accountId, changePct: s.changePct });
    }
    const share = hits.length / totalAccounts;
    if (hits.length >= (cfg.minAccounts ?? 5) && share >= (cfg.minShare ?? 0.4)) {
      const changes = hits.map((h) => h.changePct).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      return {
        kind,
        direction,
        share,
        accountIds: hits.map((h) => h.accountId),
        medianChange: changes.length ? changes[Math.floor(changes.length / 2)] : null,
        high: share >= (cfg.highShare ?? 0.6),
      };
    }
  }
  return null;
}
