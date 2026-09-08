# Privacy

## Where your data lives

On your computer, in one file per workspace:

```
%LOCALAPPDATA%\OmniAgent\decisions\<workspace>\decisions.sqlite
```

Beside it, in `imports/`, is a copy of every spreadsheet you imported and the
report for each import. The exact path is shown in **Settings**.

Nothing is uploaded. There is no account, no sign-in and no server belonging to
this product.

---

## What leaves your computer, and when

Only one thing: a short **fact sheet** about one customer, sent to an AI model,
and only when you run an analysis or ask for an email draft.

Here is a real one:

```json
{
  "as_of": "2026-09-09",
  "account": {
    "ref": "A-17", "arr": 50000, "currency": "USD", "plan": "Team",
    "seats_purchased": 40, "renewal_date": "2026-10-19", "days_to_renewal": 40,
    "owner": "unassigned", "segment": "mid-market", "industry": "logistics",
    "tenure_days": 412
  },
  "situation": { "kind": "churn_risk", "score": 7, "rule_severity": "high" },
  "signals": [
    { "id": "S1", "statement": "Average daily active users fell 45% over the last 30 days (11 vs 20)." },
    { "id": "S2", "statement": "Renewal is in 40 days (2026-10-19)." },
    { "id": "S3", "statement": "The champion (VP Operations) has not been active for 17 days." }
  ],
  "impact": { "amount": 50000, "basis": "annual contract value at risk" },
  "prior_decisions": [{ "kind": "churn_risk", "status": "dismissed", "when": "2026-07-30" }]
}
```

Note what is **not** in it:

- **No customer name.** `A-17` is a code, and it changes nothing about the
  reasoning.
- **No person's name.** `VP Operations` is a job title.
- **No email addresses, no phone numbers.**
- **No rows from your spreadsheets.** Only the sentences the software wrote.
- **No ticket subjects, no notes, no free text about your customers.**

One fact sheet is sent per situation, up to ten per run by default.

---

## Who receives it

Whichever AI model Omni Agent is configured to use. By default that is a free
model served through the bundled gateway, which means **a third-party company you
have not signed an agreement with**.

That is why names are hidden by default.

If that is not acceptable for your data, you have three options:

1. **Add your own provider key** (Anthropic, OpenAI, Google, Mistral, DeepSeek)
   in Omni Agent's **Free capacity** page. Then the fact sheet goes to that
   provider under your own agreement with them.
2. **Run the analysis with no AI at all.** From a terminal:
   ```bash
   omni-agent decisions run --no-model
   ```
   Every decision is still raised, with its evidence and its money figure. Only
   the written explanation is missing. Nothing leaves your computer.
3. Point Omni Agent at a locally-hosted model. Anything the gateway can reach
   works.

---

## The one setting

**Settings > Privacy > Hide customer names from the AI.** On by default.

Turn it off and real customer names go in the fact sheet instead of `A-17`. The
explanations read slightly better. That is the whole benefit, and it is not worth
much.

**One exception, and the app tells you about it:** when you click *Draft an
email*, the customer's real name is sent, because "Dear A-17" is not a draft
anyone can use.

---

## What is written to logs

Ids, counts, durations and error messages. Never a fact sheet, never a customer
name, never the text of an AI answer.

The record of AI calls kept in the database stores the model name, token counts,
timing, and a hash — not the prompt and not the answer.

Omni Agent's own logging strips anything that looks like a secret before writing
it. See [security.md](../security.md).

---

## Deleting

**Settings > Delete this workspace**, and type the workspace name to confirm.

That removes the database, every decision, the history, the outcomes and the
copies of your imported files. It cannot be undone and there is no bin.

To remove one customer, delete their rows from your spreadsheets and import
again. Their decisions remain in the history, because a record of a decision you
made is not the same as their data.
