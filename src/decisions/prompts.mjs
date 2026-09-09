// The prompts, and the version stamp that invalidates the cache when they change.
//
// ⚠️ BUMP PROMPT_VERSION WHENEVER A PROMPT BELOW CHANGES. It is stored on every
// decision and compared with the cache: without the bump, decisions written by
// the old prompt would never be re-reasoned and the change would appear to have
// done nothing.
export const PROMPT_VERSION = 1;

/**
 * The decision brief.
 *
 * Every constraint here corresponds to a way this specific product goes wrong:
 *   - "must not add facts, numbers, dates, names or causes" -> the validator
 *     enforces it, but a model told the rule breaks it far less often.
 *   - "cite its signal id" -> makes evidence checkable rather than plausible.
 *   - "write them as guesses" -> the difference between a hypothesis and a
 *     finding is the whole trust design (see docs/decisions/how-it-works.md).
 *   - "actionable: false" -> the model is allowed to VETO. Without a veto it
 *     will justify whatever it is handed, which is how a rules engine with a
 *     language model on top produces confident noise.
 */
export const BRIEF_SYSTEM = `You are a customer-success analyst. You are given a fact sheet about one customer account of a software company, and you write a short decision brief for a busy manager.

The fact sheet is the only thing you know. Every fact in it was computed by software from the company's own data. You must not add facts, numbers, dates, names or causes that are not in the fact sheet. If you refer to a fact, cite its signal id (S1, S2, ...). The business_context field is written by the company; use it to interpret the signals (for example a known seasonal dip), never as a source of numbers. Use tenure_days to tell an account that never got going (under 90 days) from a mature account that has changed; these need different actions.

Write four things:
1. why_it_matters: two or three sentences a manager can act on. Interpretation, not a restatement of the signals. No new numbers.
2. what_changed: the signal ids, most important first.
3. hypotheses: one to three possible explanations, each with a confidence (high, medium, low) and the signal ids that support it. These are guesses; write them as guesses. If the fact sheet has a "cohort" entry, one hypothesis must say the change is shared by many accounts and is probably not specific to this one.
4. recommended_action: exactly one id from action_catalogue, with a one-sentence rationale.

Also return severity (critical, high, medium, low) and confidence (high, medium, low) for the brief as a whole, and actionable: false with a not_actionable_reason if the fact sheet does not justify a decision (for example, one weak signal, or a prior decision already covers it and nothing has changed).

Never claim an external cause (the economy, a competitor, the news, a pandemic) - you have no information about the outside world.

Return only a JSON object with these keys and nothing else:
{"actionable": true, "why_it_matters": "...", "what_changed": ["S1"], "hypotheses": [{"text": "...", "confidence": "medium", "evidence": ["S1"]}], "recommended_action": {"id": "...", "rationale": "..."}, "severity": "high", "confidence": "medium", "not_actionable_reason": null}`;

/**
 * The outreach draft.
 *
 * Plain text rather than JSON, because the output is prose a human will edit.
 * The "no numbers the customer would not already know" rule keeps an internal
 * health metric out of a message to the customer, which is a mistake a person
 * would find embarrassing and would not easily forgive.
 */
export const DRAFT_SYSTEM = `You write short, plain business emails for a customer-success manager.

Rules:
- Start with a line "Subject: ..." then a blank line, then the body.
- Under 150 words. No jargon, no marketing language, no exclamation marks.
- Do not state any internal metric, score or percentage. Do not mention monitoring, risk scores, or that software flagged this account.
- Do not invent facts about the customer. Only use what you are given.
- The aim is to open a conversation, not to close a deal.
- Sign off with the sender's name only.

Return only the email. No preamble, no explanation.`;

/** The user turn for a draft. Kept here so the two prompts stay side by side. */
export function draftUser({ accountName, senderName, actionLabel, whyItMatters, evidence = [] }) {
  return [
    `Customer: ${accountName}`,
    `From: ${senderName || "the account manager"}`,
    `Purpose: ${actionLabel}`,
    `Internal note (do not quote): ${whyItMatters ?? "the account needs attention"}`,
    evidence.length ? `Internal observations (do not quote figures): ${evidence.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The template used when the model cannot be reached, per situation kind.
 * A product that goes silent when a free model is rate-limited is a product
 * people stop trusting, so every action has a no-model path.
 */
export const DRAFT_TEMPLATES = {
  churn_risk: ({ accountName, senderName }) =>
    `Subject: Checking in on ${accountName}\n\nHello,\n\nI wanted to check in and see how things are going with the team's use of the platform. If there is anything that is not working as well as it should be, I would like to hear about it.\n\nWould a short call this week or next suit you?\n\nBest wishes,\n${senderName || "the account team"}`,
  expansion: ({ accountName, senderName }) =>
    `Subject: A quick question about your team's setup\n\nHello,\n\nIt looks like more of your team has been getting value from the platform recently. I wanted to check whether your current plan still fits, and whether there is anything you need from us as usage grows.\n\nWould a short call this week suit you?\n\nBest wishes,\n${senderName || "the account team"}`,
  payment_risk: ({ accountName, senderName }) =>
    `Subject: A payment issue on your account\n\nHello,\n\nA recent payment on the account did not go through. This is usually a card that has expired or a billing detail that needs updating, and it is quick to fix.\n\nCould you let me know the best person to speak to about it?\n\nBest wishes,\n${senderName || "the account team"}`,
  cohort_shift: ({ senderName }) =>
    `Subject: Checking in\n\nHello,\n\nI wanted to check in and see how things are going, and whether there is anything you need from us at the moment.\n\nWould a short call this week suit you?\n\nBest wishes,\n${senderName || "the account team"}`,
};

export function templateDraft(kind, vars) {
  const fn = DRAFT_TEMPLATES[kind] ?? DRAFT_TEMPLATES.cohort_shift;
  return fn(vars);
}
