// The Decisions database: one SQLite file per workspace.
//
// WHY SQLITE AND NOT THE JSON FILES THE REST OF THIS APP USES. Decisions,
// events and signals are relational, they are queried with filters, and the
// history table is append-only and grows without bound. `node:sqlite` ships
// with the bundled Node 24 runtime, needs no dependency and no native module,
// and is already used elsewhere in this codebase (gatewayRepair in
// src/ui/api.mjs). A JSON file rewritten on every decision update would lose a
// write the first time two things happened at once.
//
// MIGRATIONS are an ordered array of SQL strings. `meta.schema_version` records
// how many have been applied; a start applies the rest inside one transaction.
// Never edit a migration that has shipped - append a new one.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/log.mjs";

const log = logger("decisions/db");

/**
 * Every migration, in order. Index 0 is schema version 1.
 *
 * The partial unique index on `decision(fingerprint)` is the dedupe rule
 * expressed in the schema rather than in code: a customer can have at most one
 * OPEN decision of a given kind, and any number of closed ones.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE account (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    arr REAL NOT NULL DEFAULT 0,
    plan TEXT,
    seats_purchased INTEGER,
    renewal_date TEXT,
    owner TEXT,
    segment TEXT,
    industry TEXT,
    created_at TEXT
  );

  CREATE TABLE contact (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    name TEXT,
    role TEXT,
    is_champion INTEGER NOT NULL DEFAULT 0,
    last_active_at TEXT
  );
  CREATE INDEX contact_account ON contact(account_id);

  CREATE TABLE metric_daily (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (account_id, day, metric)
  );

  CREATE TABLE ticket (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    priority TEXT,
    subject TEXT
  );
  CREATE INDEX ticket_account ON ticket(account_id, opened_at);

  CREATE TABLE invoice (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    due_at TEXT NOT NULL,
    amount REAL,
    status TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    paid_at TEXT
  );
  CREATE INDEX invoice_account ON invoice(account_id, due_at);

  CREATE TABLE event (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX event_account ON event(account_id, at);

  CREATE TABLE run (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    as_of TEXT NOT NULL,
    status TEXT NOT NULL,
    accounts INTEGER, signals INTEGER, candidates INTEGER, reasoned INTEGER, cached INTEGER,
    decisions_created INTEGER, decisions_updated INTEGER, dropped_not_actionable INTEGER,
    llm_calls INTEGER, llm_failures INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    model TEXT, error TEXT, progress_json TEXT
  );

  CREATE TABLE signal (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    band INTEGER NOT NULL,
    direction TEXT,
    value REAL, baseline REAL, change_pct REAL, window_days INTEGER,
    statement TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX signal_run_account ON signal(run_id, account_id);

  CREATE TABLE situation (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    account_id TEXT,
    kind TEXT NOT NULL,
    score REAL NOT NULL,
    priority REAL NOT NULL,
    signal_ids_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    packet_hash TEXT,
    outcome TEXT NOT NULL,
    decision_id TEXT
  );
  CREATE INDEX situation_run ON situation(run_id);

  CREATE TABLE watch (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    PRIMARY KEY (run_id, signal_id)
  );

  CREATE TABLE account_run_state (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    label TEXT NOT NULL,
    tenure_days INTEGER,
    PRIMARY KEY (run_id, account_id)
  );

  CREATE TABLE decision (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence TEXT,
    status TEXT NOT NULL,
    status_before_snooze TEXT,
    snoozed_until TEXT,
    owner TEXT,
    due_at TEXT,
    impact_amount REAL, impact_basis TEXT, currency TEXT,
    why_it_matters TEXT,
    recommended_action_id TEXT, recommended_action_text TEXT, rationale TEXT,
    reasoning_source TEXT NOT NULL,
    model TEXT, prompt_version INTEGER, packet_hash TEXT,
    first_run_id TEXT, last_run_id TEXT, last_situation_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    resolved_at TEXT, dismissed_reason TEXT, reasoning_error TEXT,
    signals_eased INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX decision_status ON decision(status);
  CREATE INDEX decision_account ON decision(account_id);
  CREATE UNIQUE INDEX decision_open_fp ON decision(fingerprint)
    WHERE status NOT IN ('resolved', 'dismissed');

  CREATE TABLE decision_evidence (
    decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
    signal_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    statement TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (decision_id, signal_id)
  );

  CREATE TABLE decision_hypothesis (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    text TEXT NOT NULL,
    confidence TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL
  );

  CREATE TABLE decision_event (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX decision_event_decision ON decision_event(decision_id, at);

  CREATE TABLE action (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
    account_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE INDEX action_decision ON action(decision_id);
  CREATE INDEX action_account ON action(account_id, created_at);

  CREATE TABLE outcome (
    decision_id TEXT PRIMARY KEY REFERENCES decision(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    note TEXT,
    recorded_at TEXT NOT NULL,
    arr_after REAL
  );

  CREATE TABLE llm_call (
    id TEXT PRIMARY KEY,
    run_id TEXT, situation_id TEXT, decision_id TEXT,
    purpose TEXT NOT NULL,
    model_requested TEXT, model_served TEXT,
    prompt_version INTEGER, packet_hash TEXT,
    input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER,
    attempt INTEGER NOT NULL, valid INTEGER NOT NULL,
    error TEXT, at TEXT NOT NULL
  );
  CREATE INDEX llm_call_run ON llm_call(run_id);
  `,
];

/**
 * Open (creating if needed) the database at `file` and bring it up to date.
 *
 * WAL is on because a headless `omni-agent decisions run` may write while the
 * app has the same file open for reading. Foreign keys are on because the
 * cascade deletes in the schema above are load-bearing: deleting a workspace's
 * accounts must not leave orphaned signals behind.
 *
 * @param {string} file
 * @returns {DatabaseSync}
 */
export function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** In-memory database, for tests. Same schema, no file. */
export function openMemory() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function currentVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch {
    // No meta table yet - this is a fresh database.
    return 0;
  }
}

export function migrate(db) {
  const from = currentVersion(db);
  if (from >= MIGRATIONS.length) return { from, to: from, applied: 0 };
  // One transaction for the whole upgrade: a half-applied schema is worse than
  // a failed start, because the failure is silent until a query hits the table
  // that was never created.
  db.exec("BEGIN");
  try {
    for (let i = from; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(MIGRATIONS.length),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  log.info("schema migrated", { from, to: MIGRATIONS.length });
  return { from, to: MIGRATIONS.length, applied: MIGRATIONS.length - from };
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * Not nestable, deliberately: SQLite has no nested transactions and a
 * savepoint-based emulation would hide the one case that matters, which is an
 * import failing half way and leaving a workspace with three of five tables
 * replaced.
 */
export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/** Read one value out of `meta`, or null. */
export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

/** Write one value into `meta`. Values are always strings on disk. */
export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value == null ? "" : String(value),
  );
}

/** Read the settings blob, with defaults filled in. */
export function getSettings(db) {
  let saved = {};
  try {
    saved = JSON.parse(getMeta(db, "settings_json") ?? "{}");
  } catch {}
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function setSettings(db, patch) {
  const next = { ...getSettings(db), ...patch };
  setMeta(db, "settings_json", JSON.stringify(next));
  return next;
}

export const DEFAULT_SETTINGS = {
  /** Names that can own a decision. Free text; the UI offers them in a select. */
  owners: [],
  /** Free-text note handed to the model with every decision. Never a source of numbers. */
  businessContext: "",
  /** Send pseudonymous refs (A-17) instead of customer names to the model. */
  pseudonymise: true,
  /** Hard cap on model calls per analysis run. */
  maxReasonedPerRun: 10,
  /** After this many model failures in one run, stop reasoning and report. */
  maxLlmFailuresPerRun: 5,
  /** A decision sitting in `waiting` this long gets a nudge. */
  waitingNudgeDays: 7,
  /** A dismissed decision is not re-raised for this long unless it gets worse. */
  dismissedSuppressDays: 14,
  /** At most one prepared outreach per account inside this window. */
  outreachCooldownDays: 14,
  /** Demo mode pins `as_of` so the clock can be advanced by hand. */
  demoMode: false,
  /** Threshold overrides, keyed by signal id. Empty means the shipped defaults. */
  thresholds: {},
  /** Currency symbol for display. Set from workspace.json at import. */
  currency: "USD",
  /** Monthly price of one seat, used for the expansion impact estimate. */
  seatPriceMonthly: null,
};
