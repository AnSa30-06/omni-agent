// Situations, the decision lifecycle, the packet, the validator, follow-up and
// a full run against a stub model.
//
// Hermetic: an in-memory database, no gateway, no network. The model is a
// function the test supplies, which is the only reason the run orchestrator
// takes one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-dec-test-"));

const { openMemory, getSettings, setSettings, setMeta, MIGRATIONS } = await import("../../src/decisions/db.mjs");
const { situationsFor, labelFor, severityFor, priorityFor, impactFor, cohortSituation } = await import("../../src/decisions/situations.mjs");
const { buildPacket, hashPacket, numbersIn, pseudonymMap } = await import("../../src/decisions/packet.mjs");
const { parseBriefText, validateBrief, validateDraft } = await import("../../src/decisions/schema.mjs");
const D = await import("../../src/decisions/decisions.mjs");
const { tick, overdueDays } = await import("../../src/decisions/followup.mjs");
const { runAnalysis } = await import("../../src/decisions/run.mjs");
const { generate, writeDataset } = await import("../../src/decisions/synthetic.mjs");
const { importFolder, writeTemplates } = await import("../../src/decisions/ingest.mjs");
const A = await import("../../src/decisions/actions.mjs");
const { addDays } = await import("../../src/decisions/format.mjs");

const AS_OF = "2026-09-09";
const sig = (kind, band, extra = {}) => ({ id: `sig_${kind}`, kind, band, statement: `${kind} at band ${band}`, changePct: -40, value: 10, detail: {}, ...extra });
const acct = (over = {}) => ({ id: "A1", name: "Acme", arr: 50000, seats_purchased: 40, renewal_date: addDays(AS_OF, 40), created_at: "2024-01-01", ...over });

/* ── database ───────────────────────────────────────────────────────────── */

test("the schema applies once and records its version", () => {
  const db = openMemory();
  const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(Number(v.value), MIGRATIONS.length);
  db.close();
});

test("only one OPEN decision can exist per customer and kind", () => {
  const db = openMemory();
  const ins = (id, status) =>
    db.prepare(
      "INSERT INTO decision (id, fingerprint, kind, title, severity, status, reasoning_source, created_at, updated_at) VALUES (?, 'A1:churn_risk', 'churn_risk', 't', 'high', ?, 'rule_only', '2026-01-01', '2026-01-01')",
    ).run(id, status);
  ins("d1", "new");
  assert.throws(() => ins("d2", "accepted"), /UNIQUE|constraint/i, "a second open decision must be refused by the database itself");
  // A closed one alongside an open one is fine - that is the history.
  ins("d3", "resolved");
  ins("d4", "dismissed");
  db.close();
});

/* ── situations ─────────────────────────────────────────────────────────── */

test("one signal on its own is never a decision", () => {
  const { situations, watches } = situationsFor({ account: acct(), signals: [sig("usage_drop_30d", 3)], asOf: AS_OF });
  assert.equal(situations.length, 0, "a lone usage drop must not raise anything");
  assert.equal(watches.length, 1, "it is watched instead");
});

test("churn risk needs usage plus one corroborating signal", () => {
  const withRenewal = situationsFor({
    account: acct(),
    signals: [sig("usage_drop_30d", 2), sig("renewal_near", 2)],
    asOf: AS_OF,
  });
  assert.equal(withRenewal.situations.length, 1);
  assert.equal(withRenewal.situations[0].kind, "churn_risk");
  assert.equal(withRenewal.situations[0].score, 4);

  // Corroboration without the usage drop is not churn risk.
  const noUsage = situationsFor({ account: acct(), signals: [sig("renewal_near", 3), sig("tickets_up_30d", 2)], asOf: AS_OF });
  assert.equal(noUsage.situations.length, 0);
});

test("a signal computed on stale data cannot justify a situation", () => {
  const { situations } = situationsFor({
    account: acct(),
    signals: [sig("usage_drop_30d", 3, { detail: { unreliable: true } }), sig("renewal_near", 2)],
    asOf: AS_OF,
  });
  assert.equal(situations.length, 0);
});

test("a company-wide change discounts each customer's own usage signal", () => {
  const signals = [sig("usage_drop_30d", 1), sig("renewal_near", 2)];
  assert.equal(situationsFor({ account: acct(), signals, asOf: AS_OF }).situations.length, 1);
  assert.equal(
    situationsFor({ account: acct(), signals, asOf: AS_OF, inCohort: true }).situations.length,
    0,
    "band 1 discounted to 0 means the churn rule no longer matches",
  );
  // A customer genuinely in trouble still raises one.
  const bad = [sig("usage_drop_30d", 3), sig("renewal_near", 2), sig("tickets_up_30d", 2)];
  assert.equal(situationsFor({ account: acct(), signals: bad, asOf: AS_OF, inCohort: true }).situations.length, 1);
});

test("three failed payments stand alone; one needs corroboration", () => {
  assert.equal(situationsFor({ account: acct(), signals: [sig("payment_failed", 3)], asOf: AS_OF }).situations.length, 1);
  assert.equal(situationsFor({ account: acct(), signals: [sig("payment_failed", 1)], asOf: AS_OF }).situations.length, 0);
});

test("severity comes from the score, and payment forces a floor", () => {
  assert.equal(severityFor("churn_risk", 9), "critical");
  assert.equal(severityFor("churn_risk", 6), "high");
  assert.equal(severityFor("churn_risk", 4), "medium");
  assert.equal(severityFor("churn_risk", 2), "low");
  assert.equal(severityFor("payment_risk", 2, { paymentBand: 3 }), "high", "money already not arriving is at least high");
});

test("priority puts severity first and money second", () => {
  const bigLow = priorityFor({ severity: "low", arr: 500000 });
  const smallHigh = priorityFor({ severity: "high", arr: 6000 });
  assert.ok(smallHigh > bigLow, "a serious problem at a small customer outranks a mild one at a big customer");
});

test("impact is never invented: no seat price means no expansion figure", () => {
  const withPrice = impactFor({ kind: "expansion", account: acct(), signals: [sig("seat_util_high", 2, { value: 44 })], settings: { seatPriceMonthly: 25 } });
  assert.ok(withPrice.amount > 0);
  const without = impactFor({ kind: "expansion", account: acct(), signals: [], settings: {} });
  assert.equal(without.amount, null);
  assert.match(without.basis, /not estimated/);
});

test("the lifecycle label follows the signals", () => {
  assert.equal(labelFor({ signals: [sig("payment_failed", 1)], situations: [], tenureDays: 500, sevenDayUsers: 9 }), "payment_issue");
  assert.equal(labelFor({ signals: [], situations: [{ kind: "churn_risk" }], tenureDays: 500, sevenDayUsers: 9 }), "at_risk");
  assert.equal(labelFor({ signals: [], situations: [{ kind: "expansion" }], tenureDays: 500, sevenDayUsers: 9 }), "expansion_ready");
  assert.equal(labelFor({ signals: [sig("usage_drop_30d", 2)], situations: [], tenureDays: 500, sevenDayUsers: 0 }), "dormant");
  assert.equal(labelFor({ signals: [], situations: [], tenureDays: 20, sevenDayUsers: 9 }), "new");
  assert.equal(labelFor({ signals: [sig("renewal_near", 1)], situations: [], tenureDays: 500, sevenDayUsers: 9 }), "watching");
  assert.equal(labelFor({ signals: [], situations: [], tenureDays: 500, sevenDayUsers: 9 }), "healthy");
});

/* ── the packet ─────────────────────────────────────────────────────────── */

function samplePacket(over = {}) {
  const situation = {
    kind: "churn_risk",
    accountId: "A1",
    score: 5,
    severity: "high",
    signals: [sig("usage_drop_30d", 2), sig("renewal_near", 2)],
    impact: { amount: 50000, basis: "annual contract value at risk", currency: "USD" },
    daysToRenewal: 40,
    ...over.situation,
  };
  // NOT `...over` here: spreading it back would replace the merged `situation`
  // above with the caller's partial one, which has no impact block.
  return buildPacket({
    situation,
    account: acct(),
    settings: over.settings ?? {},
    asOf: AS_OF,
    ref: "A-17",
    cohort: over.cohort ?? null,
    priorDecisions: over.priorDecisions ?? [],
  });
}

test("the packet hides the customer's name by default and shows it when asked", () => {
  assert.equal(samplePacket().account.ref, "A-17");
  assert.equal(samplePacket({ settings: { pseudonymise: false } }).account.ref, "Acme");
});

test("the packet hash ignores the date and changes when a band changes", () => {
  const a = samplePacket();
  const b = samplePacket();
  assert.equal(hashPacket(a), hashPacket(b));
  const worse = samplePacket({ situation: { signals: [sig("usage_drop_30d", 3), sig("renewal_near", 2)] } });
  assert.notEqual(hashPacket(a), hashPacket(worse));
});

test("business context reaches the model but its numbers are NOT grounded facts", () => {
  const p = samplePacket({ settings: { businessContext: "Our quiet season cost us 87% of usage last August." } });
  assert.match(p.business_context, /quiet season/);
  assert.equal(numbersIn(p).has("87"), false, "a number typed into Settings must not license a claim about a customer");
});

test("pseudonyms are stable for a given set of customers", () => {
  const m = pseudonymMap(["C", "A", "B"]);
  assert.equal(m.get("A"), "A-1");
  assert.equal(m.get("C"), "A-3");
});

/* ── the validator ──────────────────────────────────────────────────────── */

const goodBrief = {
  actionable: true,
  why_it_matters: "This customer is drifting and the renewal is close enough that waiting is a risk.",
  what_changed: ["S1", "S2"],
  hypotheses: [{ text: "They may have stopped using a workflow they relied on.", confidence: "medium", evidence: ["S1"] }],
  recommended_action: { id: "exec_outreach", rationale: "The quickest way to find out what is wrong." },
  severity: "high",
  confidence: "medium",
  not_actionable_reason: null,
};

test("JSON is found inside a code fence and inside prose", () => {
  assert.equal(parseBriefText('```json\n{"a":1}\n```').value.a, 1);
  assert.equal(parseBriefText('Here you go: {"a":2} hope that helps').value.a, 2);
  assert.equal(parseBriefText("not json at all").ok, false);
  assert.equal(parseBriefText("").ok, false);
});

test("a valid brief passes", () => {
  assert.equal(validateBrief(goodBrief, samplePacket()).ok, true);
});

test("a cited signal that does not exist is rejected", () => {
  const r = validateBrief({ ...goodBrief, what_changed: ["S9"] }, samplePacket());
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /S9/);
});

test("an action outside the catalogue is rejected", () => {
  const r = validateBrief({ ...goodBrief, recommended_action: { id: "fire_everyone", rationale: "why not" } }, samplePacket());
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /action catalogue/);
});

test("a number that is not in the fact sheet is rejected", () => {
  const r = validateBrief({ ...goodBrief, why_it_matters: "Usage fell 73% which is a serious problem for this customer." }, samplePacket());
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /73/);
});

test("a number that IS in the fact sheet is accepted", () => {
  const p = samplePacket();
  const stated = p.signals[0].statement.match(/\d+/)[0];
  const r = validateBrief({ ...goodBrief, why_it_matters: `The band ${stated} decline is what makes this urgent for the team right now.` }, p);
  assert.equal(r.ok, true, r.reasons?.join("; "));
});

test("an external cause and a certainty are both rejected", () => {
  assert.equal(validateBrief({ ...goodBrief, why_it_matters: "The recession is hurting this customer badly and it shows in the data." }, samplePacket()).ok, false);
  const certain = { ...goodBrief, hypotheses: [{ text: "This is definitely caused by the migration they ran.", confidence: "high", evidence: ["S1"] }] };
  assert.equal(validateBrief(certain, samplePacket()).ok, false);
});

test("a URL or an email address is rejected", () => {
  assert.equal(validateBrief({ ...goodBrief, why_it_matters: "See https://example.com/runbook for what to do about this customer." }, samplePacket()).ok, false);
});

test("a veto must say why", () => {
  assert.equal(validateBrief({ ...goodBrief, actionable: false, not_actionable_reason: "" }, samplePacket()).ok, false);
  assert.equal(validateBrief({ ...goodBrief, actionable: false, not_actionable_reason: "One weak signal on a healthy account." }, samplePacket()).ok, true);
});

test("a cohort packet must produce a hypothesis that mentions the cohort", () => {
  const p = samplePacket({ cohort: { direction: "down", share: 62, accountCount: 30 } });
  assert.equal(validateBrief(goodBrief, p).ok, false, "no hypothesis mentions the shared change");
  const withCohort = {
    ...goodBrief,
    hypotheses: [{ text: "Many other accounts changed at the same time, so this is probably not specific to them.", confidence: "medium", evidence: ["S1"] }],
  };
  assert.equal(validateBrief(withCohort, p).ok, true);
});

test("a draft email must have a subject and may not carry an internal figure", () => {
  const p = samplePacket();
  assert.equal(validateDraft("Subject: Checking in\n\nHello, I wanted to see how things are going with your team lately.", p).ok, true);
  assert.equal(validateDraft("Hello, no subject line here at all in this message body.", p).ok, false);
  assert.equal(validateDraft("Subject: Hi\n\nYour usage is down 73% which concerns us a great deal today.", p).ok, false);
});

/* ── the lifecycle ──────────────────────────────────────────────────────── */

function withDecision(fn) {
  const db = openMemory();
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('A1', 'Acme', 50000)").run();
  db.prepare(
    "INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, created_at, updated_at) VALUES ('d1','A1','A1:churn_risk','churn_risk','Acme: churn risk','high','new','model', ?, ?)",
  ).run(AS_OF, AS_OF);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test("an illegal status move is refused and says what is allowed", () => {
  withDecision((db) => {
    const r = D.setStatus(db, "d1", "in_progress");
    assert.equal(r.ok, false);
    assert.deepEqual(r.allowed, D.TRANSITIONS.new);
  });
});

test("the legal path runs all the way to resolved", () => {
  withDecision((db) => {
    assert.equal(D.setStatus(db, "d1", "accepted").ok, true);
    assert.equal(D.setStatus(db, "d1", "in_progress").ok, true);
    assert.equal(D.setStatus(db, "d1", "waiting").ok, true);
    assert.equal(D.resolve(db, "d1", { result: "renewed", note: "Fixed their integration." }).ok, true);
    assert.equal(D.getDecision(db, "d1").status, "resolved");
    assert.equal(db.prepare("SELECT result FROM outcome WHERE decision_id='d1'").get().result, "renewed");
  });
});

test("resolving requires a known outcome, and dismissing requires a reason", () => {
  withDecision((db) => {
    D.setStatus(db, "d1", "accepted");
    assert.equal(D.resolve(db, "d1", { result: "vanished" }).ok, false);
    assert.equal(D.dismiss(db, "d1", "ok").ok, false, "two characters is not a reason");
    assert.equal(D.dismiss(db, "d1", "Known migration, customer told us.").ok, true);
  });
});

test("every change writes to the history", () => {
  withDecision((db) => {
    D.setStatus(db, "d1", "accepted");
    D.setOwner(db, "d1", "Sam");
    D.setDue(db, "d1", addDays(AS_OF, 5));
    D.addNote(db, "d1", "Left them a voicemail.");
    const kinds = db.prepare("SELECT kind FROM decision_event WHERE decision_id='d1' ORDER BY at").all().map((e) => e.kind);
    for (const k of ["status", "owner", "due", "note"]) assert.ok(kinds.includes(k), `${k} must be recorded`);
  });
});

test("a resolved decision can be reopened", () => {
  withDecision((db) => {
    D.setStatus(db, "d1", "accepted");
    D.resolve(db, "d1", { result: "no_change" });
    assert.equal(D.reopen(db, "d1").ok, true);
    assert.equal(D.getDecision(db, "d1").status, "accepted");
  });
});

/* ── follow-up ──────────────────────────────────────────────────────────── */

test("a snooze that has expired comes back to where it was", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: true });
    setMeta(db, "as_of", AS_OF);
    D.setStatus(db, "d1", "accepted");
    D.snooze(db, "d1", addDays(AS_OF, 3));
    assert.equal(D.getDecision(db, "d1").status, "snoozed");

    assert.equal(tick(db).unsnoozed, 0, "not due yet");
    setMeta(db, "as_of", addDays(AS_OF, 4));
    assert.equal(tick(db).unsnoozed, 1);
    assert.equal(D.getDecision(db, "d1").status, "accepted", "it returns to the status it had before");
  });
});

test("an overdue decision is reminded once a day, not once a tick", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: true });
    setMeta(db, "as_of", AS_OF);
    D.setStatus(db, "d1", "accepted");
    D.setDue(db, "d1", addDays(AS_OF, -3));
    assert.equal(tick(db).overdue, 1);
    assert.equal(tick(db).overdue, 0, "a second tick the same day must not add a second reminder");
    assert.equal(overdueDays(D.getDecision(db, "d1"), AS_OF), 3);
  });
});

test("a decision left waiting is nudged after the configured number of days", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: true, waitingNudgeDays: 7 });
    setMeta(db, "as_of", AS_OF);
    D.setStatus(db, "d1", "accepted");
    D.setStatus(db, "d1", "waiting");
    assert.equal(tick(db).waiting, 0);
    setMeta(db, "as_of", addDays(AS_OF, 9));
    assert.equal(tick(db).waiting, 1);
  });
});

/* ── import ─────────────────────────────────────────────────────────────── */

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omni-imp-"));
}
function writeCsv(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, "utf8");
}

test("a missing required column is refused and the column is named", () => {
  const dir = tmpdir();
  writeCsv(dir, "accounts.csv", "account_id,arr\nA1,100\n");
  writeCsv(dir, "usage_daily.csv", "account_id,day,active_users\nA1,2026-09-01,5\n");
  const db = openMemory();
  const r = importFolder(db, dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /accounts\.csv is missing the column name/);
  db.close();
});

test("a required file that is absent is refused", () => {
  const dir = tmpdir();
  writeCsv(dir, "accounts.csv", "account_id,name\nA1,Acme\n");
  const db = openMemory();
  const r = importFolder(db, dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /usage_daily\.csv is required/);
  db.close();
});

test("bad rows are counted and reported, never coerced", () => {
  const dir = tmpdir();
  writeCsv(dir, "accounts.csv", "account_id,name,arr,renewal_date\nA1,Acme,50000,2026-12-01\nA2,Beta,not-a-number,2026-12-01\nA3,Gamma,1000,the 5th of never\n");
  writeCsv(dir, "usage_daily.csv", "account_id,day,active_users\nA1,2026-09-01,5\nA9,2026-09-01,5\nA1,yesterday,5\n");
  const db = openMemory();
  const r = importFolder(db, dir);
  assert.equal(r.ok, true);
  assert.equal(r.report.accounts, 1, "only the good account is imported");
  assert.equal(r.report.files["accounts.csv"].rejected, 2);
  assert.equal(r.report.files["usage_daily.csv"].rejected, 2);
  assert.match(Object.keys(r.report.files["usage_daily.csv"].reasons).join(" "), /not in accounts\.csv/);
  db.close();
});

test("a BOM from Excel does not break the header row", () => {
  const dir = tmpdir();
  writeCsv(dir, "accounts.csv", "﻿account_id,name\nA1,Acme\n");
  writeCsv(dir, "usage_daily.csv", "account_id,day,active_users\nA1,2026-09-01,5\n");
  const db = openMemory();
  assert.equal(importFolder(db, dir).ok, true);
  db.close();
});

test("re-importing replaces the data and keeps the decisions", () => {
  const dir = tmpdir();
  writeCsv(dir, "accounts.csv", "account_id,name\nA1,Acme\n");
  writeCsv(dir, "usage_daily.csv", "account_id,day,active_users\nA1,2026-09-01,5\n");
  const db = openMemory();
  importFolder(db, dir);
  db.prepare(
    "INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, created_at, updated_at) VALUES ('d1','A1','A1:churn_risk','churn_risk','t','high','new','model','x','x')",
  ).run();
  writeCsv(dir, "accounts.csv", "account_id,name\nA1,Acme Renamed\nA2,Beta\n");
  const r = importFolder(db, dir);
  assert.equal(r.ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 2);
  assert.equal(db.prepare("SELECT name FROM account WHERE id='A1'").get().name, "Acme Renamed");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM decision").get().n, 1, "the decision survives a re-import");
  db.close();
});

test("the blank templates it writes can be imported back", () => {
  const dir = tmpdir();
  writeTemplates(dir);
  const db = openMemory();
  const r = importFolder(db, dir);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.report.accounts, 1);
  db.close();
});

/* ── the whole run ──────────────────────────────────────────────────────── */

function stubModel({ fail = false, invalidFirst = false } = {}) {
  let n = 0;
  return async ({ messages }) => {
    n += 1;
    if (fail) throw new Error("upstream is unavailable");
    const packet = JSON.parse(messages[1].content);
    const ids = packet.signals.map((s) => s.id);
    const retrying = messages.some((m) => String(m.content).includes("failed validation"));
    if (invalidFirst && !retrying) return { content: "I cannot help with that.", servedBy: "stub", usage: {}, latencyMs: 1 };
    const hyp = [{ text: "They may have changed how the team works day to day.", confidence: "medium", evidence: [ids[0]] }];
    if (packet.cohort) hyp.push({ text: "Many other accounts moved at the same time, so this is not specific to them.", confidence: "low", evidence: [ids[0]] });
    return {
      content: JSON.stringify({
        actionable: true,
        why_it_matters: "This account needs a conversation before the renewal comes round again.",
        what_changed: ids.slice(0, 2),
        hypotheses: hyp,
        recommended_action: { id: packet.action_catalogue[0].id, rationale: "It is the fastest way to learn what is wrong." },
        severity: packet.situation.rule_severity,
        confidence: "medium",
        not_actionable_reason: null,
      }),
      servedBy: "stub/model",
      usage: { inputTokens: 500, outputTokens: 150 },
      latencyMs: 3,
    };
  };
}

function seededWorkspace() {
  const db = openMemory();
  const dir = tmpdir();
  const data = generate({ asOf: AS_OF, seed: 4242 });
  writeDataset(dir, data);
  const r = importFolder(db, dir);
  assert.equal(r.ok, true, r.error);
  setSettings(db, { demoMode: true, seatPriceMonthly: 25 });
  setMeta(db, "as_of", AS_OF);
  return { db, data };
}

test("a full run produces decisions with evidence and hypotheses", async () => {
  const { db } = seededWorkspace();
  const r = await runAnalysis({ db, complete: stubModel() });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.summary.created > 0, "some decisions are expected");
  const d = db.prepare("SELECT * FROM decision LIMIT 1").get();
  assert.ok(db.prepare("SELECT COUNT(*) n FROM decision_evidence WHERE decision_id = ?").get(d.id).n > 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM decision_hypothesis WHERE decision_id = ?").get(d.id).n > 0);
  assert.equal(d.reasoning_source, "model");
  db.close();
});

test("running twice changes nothing and spends nothing", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const second = await runAnalysis({ db, complete: stubModel() });
  assert.equal(second.summary.created, 0, "no duplicates");
  assert.equal(second.summary.reasoned, 0, "an unchanged packet is not sent to the model");
  assert.ok(second.summary.cached > 0);
  db.close();
});

test("a model that will not answer still produces decisions, marked as such", async () => {
  const { db } = seededWorkspace();
  const r = await runAnalysis({ db, complete: stubModel({ fail: true }) });
  assert.equal(r.ok, true, "the run itself must not fail");
  assert.ok(r.summary.created > 0, "the rules found the situations without the model");
  const ruleOnly = db.prepare("SELECT COUNT(*) n FROM decision WHERE reasoning_source = 'rule_only'").get().n;
  assert.ok(ruleOnly > 0);
  assert.ok(db.prepare("SELECT reasoning_error FROM decision WHERE reasoning_source='rule_only' LIMIT 1").get().reasoning_error);
  db.close();
});

test("the failure budget stops a broken model from being called forever", async () => {
  const { db } = seededWorkspace();
  setSettings(db, { maxLlmFailuresPerRun: 2 });
  const r = await runAnalysis({ db, complete: stubModel({ fail: true }) });
  assert.ok(r.summary.llmFailures <= 2, `expected at most 2 failures, saw ${r.summary.llmFailures}`);
  db.close();
});

test("an invalid answer is retried once and then accepted", async () => {
  const { db } = seededWorkspace();
  const r = await runAnalysis({ db, complete: stubModel({ invalidFirst: true }) });
  assert.equal(r.ok, true);
  const attempts = db.prepare("SELECT attempt, valid FROM llm_call ORDER BY at").all();
  assert.ok(attempts.some((a) => a.attempt === 1 && a.valid === 0), "the first attempt failed");
  assert.ok(attempts.some((a) => a.attempt === 2 && a.valid === 1), "the retry succeeded");
  db.close();
});

test("the reasoning cap is respected and the rest still become decisions", async () => {
  const { db } = seededWorkspace();
  setSettings(db, { maxReasonedPerRun: 2 });
  const r = await runAnalysis({ db, complete: stubModel() });
  assert.ok(r.summary.reasoned <= 2, `expected at most 2 model calls, saw ${r.summary.reasoned}`);
  assert.ok(r.summary.created > 2, "the rest are still raised from the rules");
  db.close();
});

test("a decision whose signals ease is flagged, never closed behind your back", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const before = db.prepare("SELECT id, account_id FROM decision WHERE status = 'new' LIMIT 1").get();
  // Wipe that customer's recent usage so the situation no longer matches.
  db.prepare("DELETE FROM metric_daily WHERE account_id = ?").run(before.account_id);
  db.prepare("DELETE FROM ticket WHERE account_id = ?").run(before.account_id);
  db.prepare("DELETE FROM invoice WHERE account_id = ?").run(before.account_id);
  await runAnalysis({ db, complete: stubModel() });
  const after = D.getDecision(db, before.id);
  assert.ok(["new", "accepted"].includes(after.status), "it must still be open");
  assert.equal(after.signals_eased, true, "and flagged for a person to close");
  db.close();
});

test("a decision dismissed recently is not raised again unchanged", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const d = db.prepare("SELECT * FROM decision WHERE status='new' LIMIT 1").get();
  D.dismiss(db, d.id, "Known issue, the customer told us about it.");
  await runAnalysis({ db, complete: stubModel() });
  const again = db.prepare("SELECT COUNT(*) n FROM decision WHERE fingerprint = ? AND status NOT IN ('dismissed')").get(d.fingerprint).n;
  assert.equal(again, 0, "the same decision must not come straight back");
  db.close();
});

/* ── actions ────────────────────────────────────────────────────────────── */

test("a second email to the same customer inside the window is refused", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const d = db.prepare("SELECT * FROM decision LIMIT 1").get();
  const first = await A.prepareDraftEmail(db, d.id, { complete: stubModel() });
  assert.equal(first.ok, true);
  const second = await A.prepareDraftEmail(db, d.id, { complete: stubModel() });
  assert.equal(second.ok, false);
  assert.equal(second.conflict, true);
  const forced = await A.prepareDraftEmail(db, d.id, { complete: stubModel(), force: true });
  assert.equal(forced.ok, true, "a deliberate override is still possible");
  db.close();
});

test("the draft falls back to a template when the model fails, and never invents a figure", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const d = db.prepare("SELECT * FROM decision LIMIT 1").get();
  const r = await A.prepareDraftEmail(db, d.id, { complete: async () => { throw new Error("no model"); } });
  assert.equal(r.ok, true);
  assert.equal(r.action.payload.source, "template");
  assert.ok(r.action.payload.subject.length > 0);
  db.close();
});

test("a task sets the owner and the date when they are empty, and not otherwise", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const d = db.prepare("SELECT * FROM decision WHERE owner IS NULL OR owner = '' LIMIT 1").get();
  A.prepareTask(db, d.id, { title: "Call them", owner: "Sam", dueAt: "2026-09-20" });
  const after = D.getDecision(db, d.id);
  assert.equal(after.owner, "Sam");
  assert.equal(after.due_at, "2026-09-20");
  A.prepareTask(db, d.id, { title: "Second task", owner: "Jo", dueAt: "2026-10-01" });
  assert.equal(D.getDecision(db, d.id).owner, "Sam", "an existing owner is not overwritten");
  db.close();
});

test("marking an action done moves the decision to in progress", async () => {
  const { db } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const d = db.prepare("SELECT * FROM decision WHERE status='new' LIMIT 1").get();
  const t = A.prepareTask(db, d.id, { title: "Call them" });
  A.updateAction(db, t.action.id, { status: "done" });
  assert.equal(D.getDecision(db, d.id).status, "in_progress");
  db.close();
});

/* ── the demo data ──────────────────────────────────────────────────────── */

test("the demo generator is deterministic for a seed", () => {
  const a = generate({ asOf: AS_OF, seed: 7 });
  const b = generate({ asOf: AS_OF, seed: 7 });
  assert.deepEqual(a.files["accounts.csv"], b.files["accounts.csv"]);
  assert.notDeepEqual(a.files["accounts.csv"], generate({ asOf: AS_OF, seed: 8 }).files["accounts.csv"]);
});

test("every planted false-positive customer raises nothing", async () => {
  const { db, data } = seededWorkspace();
  await runAnalysis({ db, complete: stubModel() });
  const raised = new Set(db.prepare("SELECT account_id FROM decision").all().map((r) => r.account_id));
  for (const s of data.scenarios.filter((x) => x.scenario.startsWith("fp_"))) {
    assert.equal(raised.has(s.account_id), false, `${s.account_id} (${s.scenario}) must not raise a decision`);
  }
  db.close();
});
