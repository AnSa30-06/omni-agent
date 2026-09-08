// Formatting shared by evidence statements, decision titles and the email
// template.
//
// It lives in one file because the SAME number must read identically in the
// signal statement the model is shown and in the card the person reads. Two
// formatters drift, and then the model is told "fell 45%" while the screen says
// "fell 45.2%", which makes the grounding check reject a correct answer.

/** Days between two ISO dates, positive when `to` is after `from`. */
export function daysBetween(from, to) {
  const a = Date.parse(dayOf(from));
  const b = Date.parse(dayOf(to));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** The YYYY-MM-DD part of any ISO timestamp. */
export function dayOf(iso) {
  return String(iso ?? "").slice(0, 10);
}

/** Today, or the pinned as_of date, as YYYY-MM-DD. */
export function today(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Add days to an ISO day, returning YYYY-MM-DD. */
export function addDays(isoDay, days) {
  const d = new Date(dayOf(isoDay) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Percentage change, rounded to a whole number.
 * Returns null when the baseline is zero - a change from nothing has no
 * percentage, and reporting one (or Infinity) would be a made-up number.
 */
export function pctChange(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return Math.round(((current - baseline) / Math.abs(baseline)) * 100);
}

/** A count or average, shown with at most one decimal and no trailing zero. */
export function num(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Whole money, with a thousands separator. Never invents a currency symbol. */
export function money(amount, currency = "USD") {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const symbol = { USD: "$", GBP: "£", EUR: "€", AED: "AED ", INR: "₹" }[currency] ?? `${currency} `;
  return symbol + Math.round(amount).toLocaleString("en-US");
}

/** "2026-10-19" -> "19 Oct 2026". Used in evidence statements. */
export function humanDate(iso) {
  const d = new Date(dayOf(iso) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Fill {placeholders} in a template from a values object. */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/** "3 days ago", "today", "in 4 days" - for ages and due dates. */
export function relativeDays(days) {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days > 0) return days === 1 ? "1 day ago" : `${days} days ago`;
  const ahead = Math.abs(days);
  return ahead === 1 ? "in 1 day" : `in ${ahead} days`;
}
