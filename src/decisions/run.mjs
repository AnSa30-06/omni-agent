// One analysis run, end to end.
//
//   raw tables -> signals -> situations -> cohort -> priority order -> packet
//   -> (cache? model? rule-only) -> decision upsert -> run summary
//
// THE COST DISCIPLINE IS HERE, and it is the reason this can run daily on a
// free model pool:
//   - signals and situations for every account cost ZERO tokens;
//   - only situations that survived the rules are candidates;
//   - only the top N by priority are sent, N is a setting (default 10);
//   - a situation whose packet hash is unchanged is not sent at all;
//   - after `maxLlmFailuresPerRun` failures the run stops calling the model and
//     finishes on rules alone, so a broken upstream costs a minute, not an hour.
import { complete as defaultComplete } from "../routing/execute.mjs";
import { computeSignals, detectCohort, isUnreliable } from "./signals.mjs";
import { situationsFor, cohortSituation, labelFor, reasoningCap } from "./situations.mjs";
import { buildPacket, hashPacket, pseudonymMap } from "./packet.mjs";
import { reasonSituation } from "./reason.mjs";
import { upsertFromSituation, priorDecisionsFor, flagEased } from "./decisions.mjs";
import { getSettings, getMeta, setMeta } from "./db.mjs";
import { limit } from "./rules.mjs";
import { runId as newRunId, signalId } from "./ids.mjs";
import { daysBetween, addDays } from "./format.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/run");

/** The date signals are computed against: pinned in demo mode, else today. */
export function asOfFor(db) {
  const s = getSettings(db);
  const pinned = getMeta(db, "as_of");
  if (s.demoMode && pinned) return pinned;
  return new Date().toISOString().slice(0, 10);
}

function loadAll(db) {
  const accounts = db.prepare("SELECT * FROM account ORDER BY id").all();
  const group = (rows, key = "account_id") => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r[key])) m.set(r[key], []);
      m.get(r[key]).push(r);
    }
    return m;
  };
  return {
    accounts,
    metrics: group(db.prepare("SELECT * FROM metric_daily").all()),
    tickets: group(db.prepare("SELECT * FROM ticket").all()),
    invoices: group(db.prepare("SELECT * FROM invoice").all()),
    contacts: group(db.prepare("SELECT * FROM contact").all()),
    events: group(db.prepare("SELECT * FROM event").all()),
  };
}

/** Is another run already in flight in this workspace? */
function claimLock(db) {
  const held = getMeta(db, "run_lock");
  if (held) {
    const age = Date.now() - Number(held);
    // Ten minutes: longer than any real run, short enough that a crashed run
    // does not wedge the workspace until someone finds this comment.
    if (Number.isFinite(age) && age < 10 * 60 * 1000) return false;
  }
  setMeta(db, "run_lock", String(Date.now()));
  return true;
}
function releaseLock(db) {
  setMeta(db, "run_lock", "");
}

/**
 * Run the analysis.
 *
 * @param {object} args
 * @param {DatabaseSync} args.db
 * @param {Function} [args.complete]   injected for tests / eval
 * @param {Function} [args.onProgress] called with a progress object
 * @param {boolean}  [args.noModel]    skip reasoning entirely (rules only)
 */
export async function runAnalysis({ db, complete = defaultComplete, onProgress = () => {}, noModel = false } = {}) {
  if (!claimLock(db)) return { ok: false, error: "an analysis is already running in this workspace" };

  const settings = getSettings(db);
  const asOf = asOfFor(db);
  const id = newRunId();
  const started = new Date().toISOString();
  const progress = { phase: "reading", accounts: 0, signals: 0, candidates: 0, reasoned: 0, cached: 0, of: 0, tokens: 0 };
  const emit = (patch = {}) => {
    Object.assign(progress, patch);
    db.prepare("UPDATE run SET progress_json = ? WHERE id = ?").run(JSON.stringify(progress), id);
    onProgress({ ...progress });
  };

  db.prepare("INSERT INTO run (id, started_at, as_of, status, progress_json) VALUES (?, ?, ?, 'running', ?)").run(
    id,
    started,
    asOf,
    JSON.stringify(progress),
  );

  try {
    const data = loadAll(db);
    emit({ phase: "signals", accounts: data.accounts.length });

    // --- signals, for every account, deterministically -----------------------
    const signalsByAccount = new Map();
    const insSignal = db.prepare(
      `INSERT INTO signal (id, run_id, account_id, kind, band, direction, value, baseline, change_pct, window_days, statement, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let signalCount = 0;
    for (const account of data.accounts) {
      const signals = computeSignals({
        account,
        metrics: data.metrics.get(account.id) ?? [],
        tickets: data.tickets.get(account.id) ?? [],
        invoices: data.invoices.get(account.id) ?? [],
        contacts: data.contacts.get(account.id) ?? [],
        events: data.events.get(account.id) ?? [],
        asOf,
        settings,
      });
      signalsByAccount.set(account.id, signals);
      for (const s of signals) {
        insSignal.run(s.id, id, account.id, s.kind, s.band, s.direction, s.value, s.baseline, s.changePct, s.windowDays, s.statement, JSON.stringify(s.detail ?? {}));
        signalCount++;
      }
    }
    emit({ signals: signalCount, phase: "situations" });

    // --- situations, cohort, labels ------------------------------------------
    const cohort = detectCohort(signalsByAccount, data.accounts.length, settings);
    const allSituations = [];
    const insWatch = db.prepare("INSERT OR IGNORE INTO watch (run_id, account_id, signal_id) VALUES (?, ?, ?)");
    const insLabel = db.prepare("INSERT OR REPLACE INTO account_run_state (run_id, account_id, label, tenure_days) VALUES (?, ?, ?, ?)");

    const cohortMembers = new Set(cohort?.accountIds ?? []);
    for (const account of data.accounts) {
      const signals = signalsByAccount.get(account.id) ?? [];
      const { situations, watches } = situationsFor({
        account,
        signals,
        asOf,
        settings,
        inCohort: cohortMembers.has(account.id),
      });
      allSituations.push(...situations);
      for (const w of watches) insWatch.run(id, account.id, w.id);

      const sevenDay = (data.metrics.get(account.id) ?? [])
        .filter((m) => m.metric === "active_users" && m.day > addDays(asOf, -7))
        .map((m) => m.value);
      const mean7 = sevenDay.length ? sevenDay.reduce((a, b) => a + b, 0) / sevenDay.length : 0;
      const tenure = account.created_at ? daysBetween(account.created_at, asOf) : null;
      insLabel.run(id, account.id, labelFor({ signals, situations, tenureDays: tenure, sevenDayUsers: mean7 }), tenure);
    }

    const cohortSit = cohortSituation({ cohort, accounts: data.accounts, settings });
    if (cohortSit) allSituations.push(cohortSit);

    // Highest priority first: what the model gets is what matters most.
    allSituations.sort((a, b) => b.priority - a.priority);
    emit({ candidates: allSituations.length, of: Math.min(allSituations.length, reasoningCap(settings)), phase: "reasoning" });

    const insSit = db.prepare(
      `INSERT INTO situation (id, run_id, account_id, kind, score, priority, signal_ids_json, fingerprint, packet_hash, outcome, decision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const accountsById = new Map(data.accounts.map((a) => [a.id, a]));
    const pseudo = pseudonymMap(data.accounts.map((a) => a.id));
    const cap = reasoningCap(settings);
    const failureBudget = limit("maxLlmFailuresPerRun", settings);

    let reasoned = 0;
    let cachedCount = 0;
    let created = 0;
    let updated = 0;
    let notActionable = 0;
    let failures = 0;
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = null;
    const seenFingerprints = new Set();

    for (const sit of allSituations) {
      seenFingerprints.add(sit.fingerprint);
      const account = sit.accountId ? accountsById.get(sit.accountId) : null;
      const priors = sit.accountId ? priorDecisionsFor(db, sit.accountId) : [];
      const memberCohort = cohort && sit.accountId && cohort.accountIds.includes(sit.accountId) && sit.kind !== "cohort_shift"
        ? { direction: cohort.direction, share: Math.round(cohort.share * 100), accountCount: cohort.accountIds.length }
        : null;

      const packet = buildPacket({
        situation: sit,
        account,
        priorDecisions: priors,
        settings,
        asOf,
        ref: sit.accountId ? pseudo.get(sit.accountId) : null,
        cohort: memberCohort,
      });
      const packetHash = hashPacket(packet);
      sit.packetHash = packetHash;

      // Is there an open decision whose packet is identical, and recent?
      const open = db
        .prepare("SELECT id, packet_hash, updated_at FROM decision WHERE fingerprint = ? AND status NOT IN ('resolved','dismissed')")
        .get(sit.fingerprint);
      const ageDays = open ? daysBetween(open.updated_at, asOf) : null;
      const fresh = open && open.packet_hash === packetHash && ageDays != null && ageDays < 7;

      let brief = null;
      let model = null;
      let outcome = "rule_only";

      if (fresh) {
        outcome = "cached";
        cachedCount++;
      } else if (noModel) {
        outcome = "rule_only";
      } else if (reasoned >= cap) {
        outcome = "skipped_cap";
      } else if (failures >= failureBudget) {
        outcome = "skipped_cap";
      } else {
        emit({ reasoned: reasoned + 1 });
        const r = await reasonSituation({ packet, complete, db, runId: id, situationId: sit.id });
        calls += r.attempts;
        inputTokens += r.tokens.input;
        outputTokens += r.tokens.output;
        if (r.model) modelUsed = r.model;
        reasoned++;
        if (r.ok) {
          brief = r.brief;
          model = r.model;
          outcome = "reasoned";
        } else {
          failures++;
          sit.reasoningError = r.error;
          outcome = "failed";
        }
        emit({ tokens: inputTokens + outputTokens });
      }

      const res = upsertFromSituation(db, { situation: sit, account, brief, model, packetHash, runId: id, asOf, settings });
      if (res.action === "created") created++;
      if (res.action === "updated") updated++;
      if (res.action === "not_actionable") {
        notActionable++;
        outcome = "not_actionable";
      }
      if (res.action === "suppressed") outcome = "suppressed_dismissed";

      insSit.run(sit.id, id, sit.accountId, sit.kind, sit.score, sit.priority, JSON.stringify(sit.signalIds), sit.fingerprint, packetHash, outcome, res.decisionId ?? null);
    }

    const eased = flagEased(db, id, seenFingerprints);

    db.prepare(
      `UPDATE run SET finished_at = ?, status = 'done', accounts = ?, signals = ?, candidates = ?, reasoned = ?, cached = ?,
        decisions_created = ?, decisions_updated = ?, dropped_not_actionable = ?, llm_calls = ?, llm_failures = ?,
        input_tokens = ?, output_tokens = ?, model = ? WHERE id = ?`,
    ).run(
      new Date().toISOString(), data.accounts.length, signalCount, allSituations.length, reasoned, cachedCount,
      created, updated, notActionable, calls, failures, inputTokens, outputTokens, modelUsed, id,
    );
    emit({ phase: "done" });
    log.info("run finished", { id, accounts: data.accounts.length, candidates: allSituations.length, created, updated });

    return {
      ok: true,
      runId: id,
      summary: {
        accounts: data.accounts.length,
        signals: signalCount,
        candidates: allSituations.length,
        reasoned,
        cached: cachedCount,
        created,
        updated,
        notActionable,
        eased,
        llmCalls: calls,
        llmFailures: failures,
        inputTokens,
        outputTokens,
        model: modelUsed,
        cohort: cohort ? { direction: cohort.direction, share: Math.round(cohort.share * 100) } : null,
        asOf,
      },
    };
  } catch (err) {
    db.prepare("UPDATE run SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(err?.message ?? err).slice(0, 500),
      id,
    );
    log.error("run failed", { id, error: String(err?.message ?? err) });
    return { ok: false, error: String(err?.message ?? err), runId: id };
  } finally {
    releaseLock(db);
  }
}

/** Re-reason ONE decision, for the "Try again" button. */
export async function rereason({ db, decisionId, complete = defaultComplete }) {
  const d = db.prepare("SELECT * FROM decision WHERE id = ?").get(decisionId);
  if (!d) return { ok: false, error: "no such decision" };
  const settings = getSettings(db);
  const asOf = asOfFor(db);
  const account = d.account_id ? db.prepare("SELECT * FROM account WHERE id = ?").get(d.account_id) : null;

  const evidence = db.prepare("SELECT * FROM decision_evidence WHERE decision_id = ? ORDER BY rank").all(decisionId);
  if (!evidence.length) return { ok: false, error: "this decision has no evidence to reason about; run the analysis again" };

  const situation = {
    id: d.last_situation_id ?? signalId(),
    kind: d.kind,
    accountId: d.account_id,
    fingerprint: d.fingerprint,
    signals: evidence.map((e, i) => ({ id: e.signal_id, kind: e.kind, band: 1, statement: e.statement })),
    signalIds: evidence.map((e) => e.signal_id),
    score: 0,
    severity: d.severity,
    priority: 0,
    impact: { amount: d.impact_amount, basis: d.impact_basis, currency: d.currency },
    daysToRenewal: account?.renewal_date ? daysBetween(asOf, account.renewal_date) : null,
  };
  const pseudo = pseudonymMap(db.prepare("SELECT id FROM account").all().map((a) => a.id));
  const packet = buildPacket({
    situation,
    account,
    priorDecisions: d.account_id ? priorDecisionsFor(db, d.account_id) : [],
    settings,
    asOf,
    ref: d.account_id ? pseudo.get(d.account_id) : null,
  });

  const r = await reasonSituation({ packet, complete, db, decisionId });
  if (!r.ok) {
    db.prepare("UPDATE decision SET reasoning_error = ? WHERE id = ?").run(r.error, decisionId);
    return { ok: false, error: r.error };
  }
  situation.severity = d.severity;
  upsertFromSituation(db, {
    situation: { ...situation, signals: situation.signals },
    account,
    brief: r.brief,
    model: r.model,
    packetHash: r.packetHash,
    runId: d.last_run_id,
    asOf,
    settings,
  });
  return { ok: true, model: r.model };
}
