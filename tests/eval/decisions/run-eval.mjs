// Decision-quality evaluation.
//
// "The UI works" is not a success criterion. This scores the thing the product
// actually claims: that it finds the situations that matter, leaves the healthy
// customers alone, cites real evidence, and does not invent anything.
//
//   node tests/eval/decisions/run-eval.mjs              recorded model, hermetic
//   node tests/eval/decisions/run-eval.mjs --live       the real gateway
//   node tests/eval/decisions/run-eval.mjs --runs 3     repeat for stability
//
// The recorded mode is what CI runs: it uses a scripted model so the DETECTION
// half of the product is scored without a network, which is the half the rules
// own. --live additionally scores the model's grounding and its recommendations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");

/** Targets from the plan. A run that misses one is reported, never rounded up. */
export const TARGETS = {
  recall: 0.85,
  falsePositivesPerDataset: 1,
  evidenceHitRate: 0.9,
  ungroundedNumbers: 0,
  certaintyLanguage: 0,
  acceptableActionRate: 0.8,
  cohortDecisions: 1,
  cohortChurnOnHealthy: 0,
};

/**
 * The recorded model. Deliberately a bit sloppy on the first attempt for one
 * situation in every run, so the retry path is exercised by CI rather than only
 * by a unit test.
 */
function recordedModel() {
  let n = 0;
  return async ({ messages }) => {
    const packet = JSON.parse(messages[messages.length - 1].content.startsWith("{") ? messages[messages.length - 1].content : messages[1].content);
    const ids = (packet.signals ?? []).map((s) => s.id);
    const retrying = messages.some((m) => String(m.content).includes("failed validation"));
    n += 1;

    // Every fifth first attempt returns prose around the JSON, which the parser
    // must survive, and one in seven cites a signal that does not exist, which
    // the validator must catch and the retry must fix.
    if (!retrying && n % 7 === 3) {
      return {
        content: JSON.stringify({
          actionable: true,
          why_it_matters: "This account needs attention because several things moved at once and the timing is bad.",
          what_changed: ["S99"],
          hypotheses: [{ text: "Something changed in how they work.", confidence: "low", evidence: ["S99"] }],
          recommended_action: { id: packet.action_catalogue[0].id, rationale: "Find out what is happening." },
          severity: packet.situation.rule_severity,
          confidence: "low",
          not_actionable_reason: null,
        }),
        servedBy: "recorded/model",
        usage: { inputTokens: 700, outputTokens: 180 },
        latencyMs: 5,
      };
    }

    const hyp = [
      { text: "The team may have changed how they work, or stopped using a part of the product they relied on.", confidence: "medium", evidence: [ids[0] ?? "S1"] },
    ];
    if (packet.cohort) {
      hyp.push({
        text: "Many other accounts moved at the same time, so this is probably not specific to this customer.",
        confidence: "medium",
        evidence: [ids[0] ?? "S1"],
      });
    }
    const body = {
      actionable: true,
      why_it_matters:
        packet.situation.kind === "expansion"
          ? "This customer is growing into their plan and there is a conversation worth having before they hit a wall."
          : packet.situation.kind === "payment_risk"
            ? "The money is not arriving and the account has gone quiet, which usually means a billing contact has changed."
            : "This customer is drifting and the timing means waiting is a real risk.",
      what_changed: ids.slice(0, 3),
      hypotheses: hyp,
      recommended_action: { id: packet.action_catalogue[0].id, rationale: "The fastest way to find out what is actually wrong." },
      severity: packet.situation.rule_severity,
      confidence: "medium",
      not_actionable_reason: null,
    };
    // A code fence around the JSON on some answers, because free models do it.
    const content = n % 4 === 0 ? "```json\n" + JSON.stringify(body) + "\n```" : JSON.stringify(body);
    return { content, servedBy: "recorded/model", usage: { inputTokens: 700, outputTokens: 200 }, latencyMs: 5 };
  };
}

const CERTAINTY = /\b(definitely|certainly|clearly|obviously|undoubtedly|is caused by|proves)\b/i;
const EXTERNAL = /\b(pandemic|covid|recession|the economy|competitor|market conditions|inflation)\b/i;

async function scoreDataset(variantName, { live, seed }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-eval-"));
  process.env.OMNI_AGENT_HOME = tmp;

  const { openMemory, setSettings, setMeta } = await import("../../../src/decisions/db.mjs");
  const { variant, writeDataset } = await import("../../../src/decisions/synthetic.mjs");
  const { importFolder } = await import("../../../src/decisions/ingest.mjs");
  const { runAnalysis } = await import("../../../src/decisions/run.mjs");
  const { logEvent } = await import("../../../src/decisions/decisions.mjs");
  const { numbersIn, normaliseNumber } = await import("../../../src/decisions/packet.mjs");

  const asOf = "2026-09-09";
  const data = variant(variantName, asOf);
  const dir = path.join(tmp, "ds");
  writeDataset(dir, data);

  const db = openMemory();
  const imp = importFolder(db, dir);
  if (!imp.ok) throw new Error(`import failed: ${imp.error}`);
  setSettings(db, { demoMode: true, seatPriceMonthly: 25, maxReasonedPerRun: 60 });
  setMeta(db, "as_of", asOf);

  // The two "previously dismissed" scenarios need their prior decision to exist.
  for (const s of data.scenarios.filter((x) => x.scenario.startsWith("dismissed_"))) {
    const id = `dec_seed_${s.account_id}`;
    const when = "2026-08-30T09:00:00.000Z";
    db.prepare(
      `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source,
        impact_basis, currency, created_at, updated_at, dismissed_reason)
       VALUES (?, ?, ?, 'churn_risk', ?, 'high', 'dismissed', 'rule_only', 'annual contract value at risk', 'USD', ?, ?, ?)`,
    ).run(id, s.account_id, `${s.account_id}:churn_risk`, `${s.name}: churn risk`, when, when, "Seasonal dip, confirmed with the customer");
    logEvent(db, id, "user", "dismissed", { reason: "seeded for the evaluation" });
  }

  const complete = live ? undefined : recordedModel();
  const started = Date.now();
  const run = await runAnalysis(complete ? { db, complete } : { db });
  const wallMs = Date.now() - started;
  if (!run.ok) throw new Error(`run failed: ${run.error}`);

  // --- score ----------------------------------------------------------------
  const decisions = db
    .prepare("SELECT * FROM decision WHERE status NOT IN ('dismissed') AND id NOT LIKE 'dec_seed_%'")
    .all();
  const byAccount = new Map();
  for (const d of decisions) {
    if (!d.account_id) continue;
    if (!byAccount.has(d.account_id)) byAccount.set(d.account_id, []);
    byAccount.get(d.account_id).push(d);
  }

  let planted = 0;
  let detected = 0;
  let falsePositives = 0;
  const misses = [];
  const fps = [];

  for (const s of data.scenarios) {
    const got = byAccount.get(s.account_id) ?? [];
    const want = s.expect.kind;

    if (s.expect.suppressed) {
      // The success condition is the OPPOSITE: no new decision.
      planted += 1;
      if (got.length === 0) detected += 1;
      else misses.push({ account: s.account_id, scenario: s.scenario, problem: "a dismissed decision was raised again unchanged" });
      continue;
    }
    if (!want) {
      if (got.length) {
        falsePositives += got.length;
        fps.push({ account: s.account_id, scenario: s.scenario, raised: got.map((d) => `${d.kind}/${d.severity}`) });
      }
      continue;
    }
    planted += 1;
    const match = got.find((d) => d.kind === want);
    if (match) detected += 1;
    else misses.push({ account: s.account_id, scenario: s.scenario, wanted: want, got: got.map((d) => d.kind) });
  }

  // Evidence: did the cited signals include the strongest one on the account?
  let evidenceChecked = 0;
  let evidenceGood = 0;
  for (const d of decisions) {
    if (!d.account_id) continue;
    const cited = db.prepare("SELECT signal_id FROM decision_evidence WHERE decision_id = ?").all(d.id).map((r) => r.signal_id);
    const strongest = db
      .prepare("SELECT id FROM signal WHERE run_id = ? AND account_id = ? ORDER BY band DESC LIMIT 1")
      .get(d.last_run_id, d.account_id);
    if (!strongest) continue;
    evidenceChecked += 1;
    if (cited.includes(strongest.id)) evidenceGood += 1;
  }

  // Grounding: numbers, certainty, external causes, in everything stored.
  let ungrounded = 0;
  let certainty = 0;
  let external = 0;
  const ALLOWED_BARE = new Set(["0","1","2","3","4","5","6","7","8","9","10","12","24","30","90","100"]);
  for (const d of decisions) {
    const texts = [d.why_it_matters, d.rationale].filter(Boolean);
    const hyps = db.prepare("SELECT text FROM decision_hypothesis WHERE decision_id = ?").all(d.id).map((h) => h.text);
    texts.push(...hyps);
    const statements = db.prepare("SELECT statement FROM decision_evidence WHERE decision_id = ?").all(d.id).map((e) => e.statement);
    const allowed = new Set();
    for (const st of statements) for (const m of st.matchAll(/-?\d[\d,]*\.?\d*/g)) allowed.add(normaliseNumber(m[0].replace(/,/g, "")));
    if (d.impact_amount != null) {
      allowed.add(normaliseNumber(d.impact_amount));
      allowed.add(normaliseNumber(Math.round(d.impact_amount / 1000)));
    }
    for (const t of texts) {
      for (const m of String(t).matchAll(/\d[\d,]*\.?\d*/g)) {
        const key = normaliseNumber(m[0].replace(/,/g, ""));
        if (!ALLOWED_BARE.has(key) && !allowed.has(key)) ungrounded += 1;
      }
      if (CERTAINTY.test(t)) certainty += 1;
      if (EXTERNAL.test(t)) external += 1;
    }
  }

  // Recommendations: is the chosen action one the rules offered for that kind?
  const { rules } = await import("../../../src/decisions/rules.mjs");
  const R = rules();
  let actionsChecked = 0;
  let actionsOk = 0;
  for (const d of decisions) {
    const allowed = R.situations[d.kind]?.actions ?? [];
    if (!allowed.length || !d.recommended_action_id) continue;
    actionsChecked += 1;
    if (allowed.includes(d.recommended_action_id)) actionsOk += 1;
  }

  // Cohort behaviour, only meaningful on the cohort dataset.
  const cohortDecisions = decisions.filter((d) => d.kind === "cohort_shift").length;
  const healthyAccounts = new Set(data.scenarios.filter((s) => s.scenario === "healthy").map((s) => s.account_id));
  const churnOnHealthy = decisions.filter((d) => d.kind === "churn_risk" && healthyAccounts.has(d.account_id)).length;

  const calls = db.prepare("SELECT COUNT(*) n, SUM(valid) v FROM llm_call").get();
  const firstAttemptValid = db.prepare("SELECT COUNT(*) n FROM llm_call WHERE attempt = 1 AND valid = 1").get().n;
  const firstAttempts = db.prepare("SELECT COUNT(*) n FROM llm_call WHERE attempt = 1").get().n;
  const ruleOnly = decisions.filter((d) => d.reasoning_source === "rule_only").length;

  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  return {
    dataset: variantName,
    accounts: data.scenarios.length,
    detection: {
      planted,
      detected,
      recall: planted ? Number((detected / planted).toFixed(3)) : null,
      falsePositives,
      misses,
      falsePositiveDetail: fps,
    },
    evidence: {
      checked: evidenceChecked,
      strongestCited: evidenceGood,
      hitRate: evidenceChecked ? Number((evidenceGood / evidenceChecked).toFixed(3)) : null,
    },
    grounding: { ungroundedNumbers: ungrounded, certaintyLanguage: certainty, externalCauseClaims: external },
    recommendations: {
      checked: actionsChecked,
      inCatalogue: actionsOk,
      rate: actionsChecked ? Number((actionsOk / actionsChecked).toFixed(3)) : null,
    },
    cohort: { decisions: cohortDecisions, churnOnHealthyMembers: churnOnHealthy },
    cost: {
      modelCalls: calls.n ?? 0,
      firstAttemptValidRate: firstAttempts ? Number((firstAttemptValid / firstAttempts).toFixed(3)) : null,
      ruleOnlyDecisions: ruleOnly,
      inputTokens: run.summary.inputTokens,
      outputTokens: run.summary.outputTokens,
      wallMs,
      model: run.summary.model,
    },
    summary: run.summary,
  };
}

function verdict(results) {
  const fails = [];
  for (const r of results) {
    if (r.detection.recall != null && r.detection.recall < TARGETS.recall) {
      fails.push(`${r.dataset}: recall ${r.detection.recall} is below ${TARGETS.recall}`);
    }
    if (r.detection.falsePositives > TARGETS.falsePositivesPerDataset) {
      fails.push(`${r.dataset}: ${r.detection.falsePositives} false positives, target is at most ${TARGETS.falsePositivesPerDataset}`);
    }
    if (r.evidence.hitRate != null && r.evidence.hitRate < TARGETS.evidenceHitRate) {
      fails.push(`${r.dataset}: evidence hit rate ${r.evidence.hitRate} is below ${TARGETS.evidenceHitRate}`);
    }
    if (r.grounding.ungroundedNumbers > TARGETS.ungroundedNumbers) {
      fails.push(`${r.dataset}: ${r.grounding.ungroundedNumbers} numbers appear that are not in the data`);
    }
    if (r.grounding.certaintyLanguage > TARGETS.certaintyLanguage) {
      fails.push(`${r.dataset}: ${r.grounding.certaintyLanguage} hypotheses are written as certainties`);
    }
    if (r.grounding.externalCauseClaims > 0) fails.push(`${r.dataset}: an external cause was claimed`);
    if (r.recommendations.rate != null && r.recommendations.rate < TARGETS.acceptableActionRate) {
      fails.push(`${r.dataset}: only ${r.recommendations.rate} of recommendations are in the catalogue`);
    }
    if (r.dataset === "demo-cohort") {
      if (r.cohort.decisions !== TARGETS.cohortDecisions) {
        fails.push(`demo-cohort: expected exactly ${TARGETS.cohortDecisions} company-wide decision, got ${r.cohort.decisions}`);
      }
      if (r.cohort.churnOnHealthyMembers > TARGETS.cohortChurnOnHealthy) {
        fails.push(`demo-cohort: ${r.cohort.churnOnHealthyMembers} healthy customers were each blamed individually`);
      }
    }
  }
  return fails;
}

export async function main(argv = process.argv.slice(2)) {
  const live = argv.includes("--live");
  const runs = Number(argv[argv.indexOf("--runs") + 1]) || 1;
  const datasets = ["demo", "demo-cohort", "edge"];
  const say = (s = "") => process.stdout.write(s + "\n");

  say("");
  say(`DECISION QUALITY EVALUATION  (${live ? "live model" : "recorded model"}, ${runs} run${runs === 1 ? "" : "s"})`);
  say("");

  const results = [];
  for (const d of datasets) {
    for (let i = 0; i < runs; i++) {
      const r = await scoreDataset(d, { live });
      results.push(r);
      say(`  ${d.padEnd(12)} recall ${String(r.detection.recall).padEnd(6)} (${r.detection.detected}/${r.detection.planted})   false positives ${String(r.detection.falsePositives).padEnd(3)} evidence ${String(r.evidence.hitRate).padEnd(6)} ungrounded ${r.grounding.ungroundedNumbers}`);
      for (const m of r.detection.misses) say(`      missed  ${m.account} ${m.scenario} ${m.problem ?? `wanted ${m.wanted}, got ${m.got?.join(",") || "nothing"}`}`);
      for (const f of r.detection.falsePositiveDetail) say(`      raised  ${f.account} ${f.scenario} -> ${f.raised.join(",")}`);
    }
  }

  const fails = verdict(results);
  const report = {
    at: new Date().toISOString(),
    mode: live ? "live" : "recorded",
    runs,
    targets: TARGETS,
    results,
    failures: fails,
    passed: fails.length === 0,
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, live ? "report-live.json" : "report.json"), JSON.stringify(report, null, 2));

  say("");
  const totals = results.reduce(
    (a, r) => ({
      calls: a.calls + r.cost.modelCalls,
      tokens: a.tokens + r.cost.inputTokens + r.cost.outputTokens,
      ms: a.ms + r.cost.wallMs,
    }),
    { calls: 0, tokens: 0, ms: 0 },
  );
  say(`  cost: ${totals.calls} model calls, ${totals.tokens} tokens, ${(totals.ms / 1000).toFixed(1)}s across ${results.length} dataset runs`);
  say("");
  if (fails.length) {
    say("  FAILED:");
    for (const f of fails) say(`    - ${f}`);
  } else {
    say("  Every target met.");
  }
  say(`  Report: ${path.join(RESULTS, live ? "report-live.json" : "report.json")}`);
  say("");
  return fails.length ? 1 : 0;
}

// Run directly? `pathToFileURL` rather than string surgery: on Windows a
// hand-built file:// URL differs from Node's own by an encoded character or a
// slash, the check silently never fires, and the script exits having printed
// nothing at all. Measured 2026-09-09 - the first version did exactly that.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
