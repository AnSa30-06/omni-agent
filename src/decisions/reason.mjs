// Calling the model, and surviving it not working.
//
// Every call goes through `complete()` in src/routing/execute.mjs - the one
// place in this product that talks to a model - so provider choice, the routing
// preset, model pinning and the fallback chain are all inherited and none of
// them are reimplemented here.
//
// WHAT THIS LAYER ADDS:
//   retry once with the validator's complaint attached, then GIVE UP CLEANLY.
//   A model that will not produce valid JSON must not stop a decision being
//   raised: the rules already found the situation and computed the money, and
//   the decision exists without the prose. `reasoning_source: "rule_only"` is a
//   first-class outcome, not an error state.
import { complete as defaultComplete } from "../routing/execute.mjs";
import { BRIEF_SYSTEM, DRAFT_SYSTEM, PROMPT_VERSION, draftUser, templateDraft } from "./prompts.mjs";
import { parseBriefText, validateBrief, validateDraft } from "./schema.mjs";
import { hashPacket } from "./packet.mjs";
import { callId } from "./ids.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/reason");

/** Record one model attempt. Text is never stored - only ids, counts and errors. */
function recordCall(db, row) {
  if (!db) return;
  db.prepare(
    `INSERT INTO llm_call (id, run_id, situation_id, decision_id, purpose, model_requested, model_served,
       prompt_version, packet_hash, input_tokens, output_tokens, latency_ms, attempt, valid, error, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    callId(),
    row.runId ?? null,
    row.situationId ?? null,
    row.decisionId ?? null,
    row.purpose,
    row.modelRequested ?? null,
    row.modelServed ?? null,
    PROMPT_VERSION,
    row.packetHash ?? null,
    row.inputTokens ?? null,
    row.outputTokens ?? null,
    row.latencyMs ?? null,
    row.attempt,
    row.valid ? 1 : 0,
    row.error ?? null,
    new Date().toISOString(),
  );
}

/**
 * Reason about one situation.
 *
 * @param {object} args
 * @param {object} args.packet
 * @param {Function} [args.complete]  injected for tests and the eval harness
 * @param {object} [args.db]
 * @returns {Promise<{brief?: object, ok: boolean, error?: string, model?: string, attempts: number, tokens: object}>}
 */
export async function reasonSituation({ packet, complete = defaultComplete, db = null, runId = null, situationId = null }) {
  const packetHash = hashPacket(packet);
  const messages = [
    { role: "system", content: BRIEF_SYSTEM },
    { role: "user", content: JSON.stringify(packet, null, 1) },
  ];
  const tokens = { input: 0, output: 0 };
  let lastError = null;
  let model = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await complete({
        task: "decision-brief",
        messages,
        maxTokens: 900,
        temperature: 0,
        timeoutMs: 90_000,
      });
    } catch (err) {
      lastError = String(err?.message ?? err).slice(0, 400);
      recordCall(db, { runId, situationId, purpose: "brief", packetHash, attempt, valid: false, error: lastError });
      log.warn("model call failed", { attempt, error: lastError });
      // A thrown error means the whole fallback chain in execute.mjs was
      // already walked. Trying again here would just walk it a second time.
      break;
    }

    model = res.servedBy ?? res.requested ?? null;
    tokens.input += res.usage?.inputTokens ?? 0;
    tokens.output += res.usage?.outputTokens ?? 0;

    const parsed = parseBriefText(res.content);
    if (!parsed.ok) {
      lastError = parsed.reason;
      recordCall(db, {
        runId, situationId, purpose: "brief", packetHash, attempt, valid: false, error: lastError,
        modelRequested: res.requested, modelServed: res.servedBy,
        inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
      });
    } else {
      const checked = validateBrief(parsed.value, packet);
      if (checked.ok) {
        recordCall(db, {
          runId, situationId, purpose: "brief", packetHash, attempt, valid: true,
          modelRequested: res.requested, modelServed: res.servedBy,
          inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
        });
        return { ok: true, brief: checked.brief, model, attempts: attempt, tokens, packetHash };
      }
      lastError = checked.reasons.join("; ").slice(0, 400);
      recordCall(db, {
        runId, situationId, purpose: "brief", packetHash, attempt, valid: false, error: lastError,
        modelRequested: res.requested, modelServed: res.servedBy,
        inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
      });
    }

    if (attempt === 1) {
      // Tell it exactly what was wrong. A bare "try again" gets the same answer.
      messages.push({ role: "assistant", content: String(res.content ?? "").slice(0, 2000) });
      messages.push({
        role: "user",
        content: `Your previous answer failed validation: ${lastError}. Return corrected JSON only, with no other text.`,
      });
    }
  }

  return { ok: false, error: lastError ?? "the model did not produce a usable answer", model, attempts: 2, tokens, packetHash };
}

/**
 * Draft an outreach email. Falls back to a template, so this never fails.
 *
 * The account's REAL name is used here even when packets are pseudonymised:
 * the person is about to send this to that customer, and "Dear A-17" is not a
 * draft anyone can use. The UI says so before the call is made.
 */
export async function draftEmail({ packet, accountName, senderName, actionLabel, whyItMatters, evidence, complete = defaultComplete, db = null, decisionId = null, kind = "churn_risk" }) {
  const fallback = () => ({
    ok: true,
    source: "template",
    text: templateDraft(kind, { accountName, senderName }),
  });

  let res;
  try {
    res = await complete({
      task: "decision-draft",
      messages: [
        { role: "system", content: DRAFT_SYSTEM },
        { role: "user", content: draftUser({ accountName, senderName, actionLabel, whyItMatters, evidence }) },
      ],
      maxTokens: 500,
      temperature: 0.2,
      timeoutMs: 60_000,
    });
  } catch (err) {
    recordCall(db, { decisionId, purpose: "draft_email", attempt: 1, valid: false, error: String(err?.message ?? err).slice(0, 300) });
    return fallback();
  }

  const checked = validateDraft(res.content, packet);
  recordCall(db, {
    decisionId, purpose: "draft_email", attempt: 1, valid: checked.ok,
    error: checked.ok ? null : checked.reasons.join("; ").slice(0, 300),
    modelRequested: res.requested, modelServed: res.servedBy,
    inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
  });
  if (!checked.ok) return fallback();

  return { ok: true, source: "model", text: checked.text, model: res.servedBy ?? res.requested ?? null };
}

/** Split "Subject: x\n\nbody" into its parts, for the UI's two fields. */
export function splitEmail(text) {
  const body = String(text ?? "");
  const m = body.match(/^\s*subject:\s*(.+)$/im);
  const subject = m ? m[1].trim() : "Checking in";
  const rest = m ? body.slice(body.indexOf(m[0]) + m[0].length).trim() : body.trim();
  return { subject, body: rest };
}
