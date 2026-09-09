// Importing a folder of CSV files.
//
// This is the connector. Every one of these five files is a straight export
// from a system the reader already has - Stripe invoices, a CRM's contacts, a
// product events table, a help desk - so a real company can produce them
// without any integration existing, and a future connector writes into the same
// tables through the same validation.
//
// 🔴 A REJECTED ROW IS REPORTED, NEVER GUESSED. A date that will not parse or a
// number with a stray currency symbol becomes a counted rejection with the row
// quoted, not a zero. Silent coercion is how a dataset that looks imported
// produces decisions about numbers nobody wrote.
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "../tools/documents.mjs";
import { tx, setMeta, setSettings, getSettings } from "./db.mjs";
import { dayOf } from "./format.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/ingest");

/** The import contract. `req` columns must exist; anything else is ignored. */
export const CONTRACT = {
  "accounts.csv": {
    required: true,
    req: ["account_id", "name"],
    opt: ["arr", "plan", "seats_purchased", "renewal_date", "owner", "segment", "industry", "created_at"],
  },
  "usage_daily.csv": { required: true, req: ["account_id", "day"], opt: ["active_users", "sessions", "seats_used"] },
  "contacts.csv": { required: false, req: ["contact_id", "account_id"], opt: ["name", "role", "is_champion", "last_active_at"] },
  "tickets.csv": { required: false, req: ["ticket_id", "account_id", "opened_at"], opt: ["closed_at", "priority", "subject"] },
  "invoices.csv": { required: false, req: ["invoice_id", "account_id", "due_at", "status"], opt: ["amount", "attempts", "paid_at"] },
  "events.csv": { required: false, req: ["event_id", "account_id", "at", "kind"], opt: ["detail"] },
};

const isDate = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v ?? "").trim());
const numOrNull = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/[$,£€\s]/g, ""));
  return Number.isFinite(n) ? n : undefined; // undefined means "unparseable"
};

function readCsvFile(file) {
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a BOM from Excel
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
  return { headers, records };
}

function fileReport(name) {
  return { file: name, present: false, read: 0, accepted: 0, rejected: 0, reasons: {}, examples: [] };
}

function reject(rep, reason, row) {
  rep.rejected += 1;
  rep.reasons[reason] = (rep.reasons[reason] ?? 0) + 1;
  if (rep.examples.length < 3) rep.examples.push({ reason, row: JSON.stringify(row).slice(0, 240) });
}

/**
 * Import a folder into a workspace database.
 *
 * Everything happens in ONE transaction. A half-replaced set of tables - new
 * accounts, last week's usage - would produce confident decisions from data
 * that never existed together.
 *
 * @param {DatabaseSync} db
 * @param {string} folder
 * @param {{workspaceDir?: string}} [opts] where to keep a copy of the files
 */
export function importFolder(db, folder, opts = {}) {
  const dir = path.resolve(folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: `${dir} is not a folder` };
  }

  const report = { at: new Date().toISOString(), folder: dir, files: {}, accounts: 0, ok: false, warnings: [] };
  const parsed = {};

  for (const [name, spec] of Object.entries(CONTRACT)) {
    const rep = fileReport(name);
    report.files[name] = rep;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      if (spec.required) {
        return { ok: false, error: `${name} is required and was not found in ${dir}`, report };
      }
      continue;
    }
    rep.present = true;
    let read;
    try {
      read = readCsvFile(file);
    } catch (err) {
      return { ok: false, error: `${name} could not be read: ${err.message}`, report };
    }
    const missing = spec.req.filter((c) => !read.headers.includes(c));
    if (missing.length) {
      return { ok: false, error: `${name} is missing the column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`, report };
    }
    rep.read = read.records.length;
    parsed[name] = read.records;
  }

  // Accounts first: every other file is checked against these ids.
  const accounts = new Map();
  const accRep = report.files["accounts.csv"];
  for (const r of parsed["accounts.csv"] ?? []) {
    const id = String(r.account_id ?? "").trim();
    const name = String(r.name ?? "").trim();
    if (!id || !name) {
      reject(accRep, "account_id and name are both required", r);
      continue;
    }
    const arr = numOrNull(r.arr);
    if (arr === undefined) {
      reject(accRep, "arr is not a number", r);
      continue;
    }
    const seats = numOrNull(r.seats_purchased);
    if (seats === undefined) {
      reject(accRep, "seats_purchased is not a number", r);
      continue;
    }
    if (r.renewal_date && !isDate(r.renewal_date)) {
      reject(accRep, "renewal_date is not a date (use YYYY-MM-DD)", r);
      continue;
    }
    if (r.created_at && !isDate(r.created_at)) {
      reject(accRep, "created_at is not a date (use YYYY-MM-DD)", r);
      continue;
    }
    // Last row wins on a duplicate id, and it is counted so the reader knows.
    if (accounts.has(id)) accRep.reasons["duplicate account_id (the last row was kept)"] = (accRep.reasons["duplicate account_id (the last row was kept)"] ?? 0) + 1;
    accounts.set(id, {
      id,
      name,
      arr: arr ?? 0,
      plan: String(r.plan ?? "").trim() || null,
      seats_purchased: seats == null ? null : Math.round(seats),
      renewal_date: r.renewal_date ? dayOf(r.renewal_date) : null,
      owner: String(r.owner ?? "").trim() || null,
      segment: String(r.segment ?? "").trim() || null,
      industry: String(r.industry ?? "").trim() || null,
      created_at: r.created_at ? dayOf(r.created_at) : null,
    });
  }
  accRep.accepted = accounts.size;
  if (!accounts.size) return { ok: false, error: "accounts.csv contained no usable rows", report };

  const known = (id) => accounts.has(String(id ?? "").trim());

  // usage_daily -> metric_daily, one row per metric.
  const metrics = [];
  const useRep = report.files["usage_daily.csv"];
  for (const r of parsed["usage_daily.csv"] ?? []) {
    const acc = String(r.account_id ?? "").trim();
    if (!known(acc)) {
      reject(useRep, "account_id is not in accounts.csv", r);
      continue;
    }
    if (!isDate(r.day)) {
      reject(useRep, "day is not a date (use YYYY-MM-DD)", r);
      continue;
    }
    let bad = false;
    const day = dayOf(r.day);
    for (const metric of ["active_users", "sessions", "seats_used"]) {
      if (!(metric in r) || String(r[metric]).trim() === "") continue;
      const v = numOrNull(r[metric]);
      if (v === undefined) {
        reject(useRep, `${metric} is not a number`, r);
        bad = true;
        break;
      }
      metrics.push({ account_id: acc, day, metric, value: v });
    }
    if (!bad) useRep.accepted += 1;
  }

  const contacts = [];
  const cRep = report.files["contacts.csv"];
  for (const r of parsed["contacts.csv"] ?? []) {
    const acc = String(r.account_id ?? "").trim();
    if (!known(acc)) {
      reject(cRep, "account_id is not in accounts.csv", r);
      continue;
    }
    if (r.last_active_at && !isDate(r.last_active_at)) {
      reject(cRep, "last_active_at is not a date", r);
      continue;
    }
    contacts.push({
      id: String(r.contact_id).trim(),
      account_id: acc,
      name: String(r.name ?? "").trim() || null,
      role: String(r.role ?? "").trim() || null,
      is_champion: /^(1|true|yes)$/i.test(String(r.is_champion ?? "").trim()) ? 1 : 0,
      last_active_at: r.last_active_at ? dayOf(r.last_active_at) : null,
    });
    cRep.accepted += 1;
  }

  const tickets = [];
  const tRep = report.files["tickets.csv"];
  for (const r of parsed["tickets.csv"] ?? []) {
    const acc = String(r.account_id ?? "").trim();
    if (!known(acc)) {
      reject(tRep, "account_id is not in accounts.csv", r);
      continue;
    }
    if (!isDate(r.opened_at)) {
      reject(tRep, "opened_at is not a date", r);
      continue;
    }
    tickets.push({
      id: String(r.ticket_id).trim(),
      account_id: acc,
      opened_at: dayOf(r.opened_at),
      closed_at: r.closed_at && isDate(r.closed_at) ? dayOf(r.closed_at) : null,
      priority: String(r.priority ?? "").trim().toLowerCase() || null,
      subject: String(r.subject ?? "").trim() || null,
    });
    tRep.accepted += 1;
  }

  const invoices = [];
  const iRep = report.files["invoices.csv"];
  for (const r of parsed["invoices.csv"] ?? []) {
    const acc = String(r.account_id ?? "").trim();
    if (!known(acc)) {
      reject(iRep, "account_id is not in accounts.csv", r);
      continue;
    }
    if (!isDate(r.due_at)) {
      reject(iRep, "due_at is not a date", r);
      continue;
    }
    const amount = numOrNull(r.amount);
    if (amount === undefined) {
      reject(iRep, "amount is not a number", r);
      continue;
    }
    invoices.push({
      id: String(r.invoice_id).trim(),
      account_id: acc,
      due_at: dayOf(r.due_at),
      amount: amount ?? 0,
      status: String(r.status ?? "").trim().toLowerCase() || "open",
      attempts: Math.round(numOrNull(r.attempts) ?? 0),
      paid_at: r.paid_at && isDate(r.paid_at) ? dayOf(r.paid_at) : null,
    });
    iRep.accepted += 1;
  }

  const events = [];
  const eRep = report.files["events.csv"];
  for (const r of parsed["events.csv"] ?? []) {
    const acc = String(r.account_id ?? "").trim();
    if (!known(acc)) {
      reject(eRep, "account_id is not in accounts.csv", r);
      continue;
    }
    if (!isDate(r.at)) {
      reject(eRep, "at is not a date", r);
      continue;
    }
    events.push({
      id: String(r.event_id).trim(),
      account_id: acc,
      at: dayOf(r.at),
      kind: String(r.kind ?? "").trim(),
      detail: String(r.detail ?? "").trim() || null,
    });
    eRep.accepted += 1;
  }

  // --- write, all or nothing ------------------------------------------------
  tx(db, () => {
    // Raw tables are replaced; decisions, events and outcomes are untouched.
    for (const t of ["metric_daily", "contact", "ticket", "invoice", "event", "account"]) db.exec(`DELETE FROM ${t}`);

    const insAcc = db.prepare(
      "INSERT INTO account (id, name, arr, plan, seats_purchased, renewal_date, owner, segment, industry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const a of accounts.values())
      insAcc.run(a.id, a.name, a.arr, a.plan, a.seats_purchased, a.renewal_date, a.owner, a.segment, a.industry, a.created_at);

    const insM = db.prepare("INSERT OR REPLACE INTO metric_daily (account_id, day, metric, value) VALUES (?, ?, ?, ?)");
    for (const m of metrics) insM.run(m.account_id, m.day, m.metric, m.value);

    const insC = db.prepare("INSERT OR REPLACE INTO contact (id, account_id, name, role, is_champion, last_active_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const c of contacts) insC.run(c.id, c.account_id, c.name, c.role, c.is_champion, c.last_active_at);

    const insT = db.prepare("INSERT OR REPLACE INTO ticket (id, account_id, opened_at, closed_at, priority, subject) VALUES (?, ?, ?, ?, ?, ?)");
    for (const t of tickets) insT.run(t.id, t.account_id, t.opened_at, t.closed_at, t.priority, t.subject);

    const insI = db.prepare("INSERT OR REPLACE INTO invoice (id, account_id, due_at, amount, status, attempts, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const i of invoices) insI.run(i.id, i.account_id, i.due_at, i.amount, i.status, i.attempts, i.paid_at);

    const insE = db.prepare("INSERT OR REPLACE INTO event (id, account_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)");
    for (const e of events) insE.run(e.id, e.account_id, e.at, e.kind, e.detail);
  });

  // workspace.json, if the folder carries one.
  const wsFile = path.join(dir, "workspace.json");
  if (fs.existsSync(wsFile)) {
    try {
      const w = JSON.parse(fs.readFileSync(wsFile, "utf8"));
      const patch = {};
      if (w.currency) patch.currency = String(w.currency);
      if (Number.isFinite(Number(w.seat_price_monthly))) patch.seatPriceMonthly = Number(w.seat_price_monthly);
      if (Object.keys(patch).length) setSettings(db, patch);
      if (w.name) setMeta(db, "workspace_name", String(w.name));
      if (w.as_of) setMeta(db, "as_of", dayOf(w.as_of));
    } catch {
      report.warnings.push("workspace.json could not be read and was ignored");
    }
  }
  if (!getSettings(db).seatPriceMonthly) {
    report.warnings.push("No seat price is set, so the money at stake for an expansion cannot be estimated. Add seat_price_monthly to workspace.json, or set it in Settings.");
  }

  report.accounts = accounts.size;
  report.ok = true;
  setMeta(db, "last_import_json", JSON.stringify(report));

  // Keep a byte copy of what was imported, so a question about a number can
  // always be traced back to the file it came from.
  if (opts.workspaceDir) {
    try {
      const stamp = report.at.replace(/[:.]/g, "-").slice(0, 19);
      const dest = path.join(opts.workspaceDir, "imports", stamp);
      fs.mkdirSync(dest, { recursive: true });
      for (const name of Object.keys(CONTRACT)) {
        const src = path.join(dir, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, name));
      }
      if (fs.existsSync(wsFile)) fs.copyFileSync(wsFile, path.join(dest, "workspace.json"));
      fs.writeFileSync(path.join(dest, "report.json"), JSON.stringify(report, null, 2));
      report.copiedTo = dest;
    } catch (err) {
      report.warnings.push(`the files could not be copied into the workspace: ${err.message}`);
    }
  }

  log.info("imported", { accounts: accounts.size, metrics: metrics.length, tickets: tickets.length });
  return { ok: true, report };
}

/** Write the blank CSV templates a person can fill in. */
export function writeTemplates(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const [name, spec] of Object.entries(CONTRACT)) {
    const cols = [...spec.req, ...spec.opt];
    const example = {
      "accounts.csv": ["ACC-1", "Acme Ltd", "50000", "Team", "40", "2026-12-01", "Sam", "mid-market", "logistics", "2024-06-01"],
      "usage_daily.csv": ["ACC-1", "2026-09-01", "18", "42", "16"],
      "contacts.csv": ["CON-1", "ACC-1", "Alex Smith", "VP Operations", "true", "2026-08-20"],
      "tickets.csv": ["TIC-1", "ACC-1", "2026-08-14", "", "high", "Export is slow"],
      "invoices.csv": ["INV-1", "ACC-1", "2026-08-01", "failed", "4200", "2", ""],
      "events.csv": ["EVT-1", "ACC-1", "2026-08-22", "pricing_page_view", ""],
    }[name];
    const file = path.join(destDir, name);
    fs.writeFileSync(file, `${cols.join(",")}\r\n${example.join(",")}\r\n`, "utf8");
    written.push(file);
  }
  fs.writeFileSync(
    path.join(destDir, "workspace.json"),
    JSON.stringify({ name: "My company", currency: "USD", seat_price_monthly: 25 }, null, 2),
  );
  written.push(path.join(destDir, "workspace.json"));
  return written;
}
