// Parsing and validating what the model returned.
//
// 🔴 THE GATEWAY DOES NOT ENFORCE JSON. GatewayClient.chat() sends no
// `response_format`, and the free model pool this product ships with is a set
// of proxies that would ignore it anyway. So structure is enforced HERE, and a
// failure is a normal, handled outcome rather than a crash.
//
// Two layers:
//   1. SHAPE. zod checks the keys, the types and the enums.
//   2. GROUNDING. Four checks zod cannot express, and they are the reason this
//      product can put a model's sentence on screen next to a number:
//        - every cited signal id exists in the packet
//        - the recommended action is one the rules offered
//        - EVERY NUMBER in the prose appears in the packet
//        - no URLs, no email addresses, no external causes
import { z } from "zod";
import { numbersIn, normaliseNumber } from "./packet.mjs";

export const BriefSchema = z.object({
  actionable: z.boolean(),
  why_it_matters: z.string().min(20).max(900),
  what_changed: z.array(z.string()).min(1).max(8),
  hypotheses: z
    .array(
      z.object({
        text: z.string().min(10).max(400),
        confidence: z.enum(["high", "medium", "low"]),
        evidence: z.array(z.string()).min(1).max(6),
      }),
    )
    .min(1)
    .max(3),
  recommended_action: z.object({ id: z.string(), rationale: z.string().min(5).max(400) }),
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]),
  not_actionable_reason: z.string().max(400).nullable().optional(),
});

/**
 * Pull a JSON object out of whatever the model actually said.
 *
 * Free models routinely wrap JSON in a code fence, or introduce it with a
 * sentence. Refusing those answers would throw away work that is otherwise
 * correct, so the first { to the last } is taken.
 */
export function parseBriefText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, reason: "the model returned nothing" };
  let body = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last <= first) return { ok: false, reason: "no JSON object in the answer" };
  body = body.slice(first, last + 1);
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (err) {
    return { ok: false, reason: `the answer was not valid JSON: ${err.message}` };
  }
}

/** Numbers a model may use freely without them appearing in the packet. */
const ALLOWED_BARE = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "12", "24", "30", "90", "100"]);

/** Words that would assert a cause the packet cannot support. */
const EXTERNAL_CAUSE = /\b(pandemic|covid|recession|the economy|economic downturn|competitor|competitors|market conditions|the news|inflation|war|election)\b/i;
/** Words that turn a guess into a finding. */
const CERTAINTY = /\b(definitely|certainly|clearly|obviously|undoubtedly|without doubt|is caused by|proves that|guarantees)\b/i;

/**
 * Check a parsed brief against the packet it was written from.
 * @returns {{ok: true, brief} | {ok: false, reasons: string[]}}
 */
export function validateBrief(parsed, packet) {
  const shape = BriefSchema.safeParse(parsed);
  if (!shape.success) {
    const reasons = shape.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, reasons };
  }
  const brief = shape.data;
  const reasons = [];

  const validIds = new Set((packet.signals ?? []).map((s) => s.id));
  const validActions = new Set((packet.action_catalogue ?? []).map((a) => a.id));

  // A brief that vetoes is allowed to be thin, but must say why.
  if (brief.actionable === false && !String(brief.not_actionable_reason ?? "").trim()) {
    reasons.push("actionable is false but not_actionable_reason is empty");
  }

  for (const sid of brief.what_changed) {
    if (!validIds.has(sid)) reasons.push(`what_changed cites "${sid}", which is not a signal in the fact sheet`);
  }
  brief.hypotheses.forEach((h, i) => {
    for (const sid of h.evidence) {
      if (!validIds.has(sid)) reasons.push(`hypotheses[${i}] cites "${sid}", which is not a signal in the fact sheet`);
    }
  });
  if (!validActions.has(brief.recommended_action.id)) {
    reasons.push(
      `recommended_action "${brief.recommended_action.id}" is not in the action catalogue (${[...validActions].join(", ")})`,
    );
  }

  const prose = [brief.why_it_matters, brief.recommended_action.rationale, ...brief.hypotheses.map((h) => h.text)];
  const allowed = numbersIn(packet);

  for (const text of prose) {
    for (const m of String(text).matchAll(/\d[\d,]*\.?\d*/g)) {
      const bare = m[0].replace(/,/g, "");
      const key = normaliseNumber(bare);
      if (ALLOWED_BARE.has(key)) continue;
      if (allowed.has(key)) continue;
      // "50K" and "$50k" for 50000.
      const thousands = normaliseNumber(Number(bare) * 1000);
      if (/k\b/i.test(String(text).slice(m.index + m[0].length, m.index + m[0].length + 2)) && allowed.has(thousands)) continue;
      reasons.push(`the number "${m[0]}" does not appear anywhere in the fact sheet`);
    }
    if (/https?:\/\/|www\.|@[\w.-]+\.\w{2,}/.test(text)) reasons.push("the answer contains a URL or an email address");
    if (EXTERNAL_CAUSE.test(text)) reasons.push("the answer claims an external cause, which the fact sheet cannot support");
  }
  for (const h of brief.hypotheses) {
    if (CERTAINTY.test(h.text)) reasons.push("a hypothesis is written as a certainty; hypotheses must be written as guesses");
  }

  // A cohort packet must produce a hypothesis that says so, or the per-account
  // decision will read as though this one customer is uniquely in trouble.
  if (packet.cohort && !brief.hypotheses.some((h) => /many|other (accounts|customers)|across|wide|shared|not specific/i.test(h.text))) {
    reasons.push("the fact sheet says many accounts changed together, but no hypothesis mentions that");
  }

  const unique = [...new Set(reasons)];
  return unique.length ? { ok: false, reasons: unique } : { ok: true, brief };
}

/**
 * Check a drafted email is grounded. Looser than the brief: prose to a customer
 * legitimately contains no figures at all, so only numbers are policed.
 */
export function validateDraft(text, packet) {
  const reasons = [];
  const body = String(text ?? "");
  if (body.trim().length < 40) reasons.push("the draft is too short to send");
  if (!/^subject:/im.test(body)) reasons.push("the draft has no Subject line");
  const allowed = numbersIn(packet);
  for (const m of body.matchAll(/\d[\d,]*\.?\d*/g)) {
    const key = normaliseNumber(m[0].replace(/,/g, ""));
    if (ALLOWED_BARE.has(key) || allowed.has(key)) continue;
    reasons.push(`the draft contains "${m[0]}", which is not a figure from this account's data`);
  }
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true, text: body.trim() };
}
