# The decision page

**What it does.** Shows why a decision was raised, what the evidence is, what
might be causing it, what to do, and everything that has happened to it.

**Why it exists.** This is the page that decides whether you trust the product.
An AI that tells you a customer is at risk without showing its working is a
guess with good grammar.

---

## The four kinds of statement

Every block on this page carries a coloured label. **Always read the label
first.**

| Label | What it means | Where it comes from |
|---|---|---|
| **Observed fact** | Something measured from your data | Computed in code. Cannot be wrong unless your data is. |
| **AI interpretation** | What a model thinks it means | A language model. Can be plausible and wrong. |
| **Hypothesis** | A possible cause | A guess, and labelled as one. |
| **Recommendation** | What to do next | Chosen by the model from a fixed list. |

This is the whole trust design. The product will never let an AI interpretation
appear where a fact should be.

---

## The blocks, in order

### Why this matters — *AI interpretation*

Two or three sentences. It may not contain any number that is not in your data.

If it says **"The AI could not explain this one"**, the model failed or was
unavailable. The decision is still real: the signals and the money were computed.
Click **Try the AI again**.

### What changed — *observed fact*

The signals the recommendation is built on.

### Everything we looked at — *observed fact*

**Every** signal on this customer in the last run, including the ones the
recommendation ignored, each with the threshold the rule uses.

This is the honest panel. If the recommendation tells a story the other signals
do not support, this is where you will see it.

### What might be causing it — *hypothesis*

One to three possible explanations, each with a confidence and the evidence it
came from.

These are guesses. The model is required to write them as guesses, and an answer
that states one as a certainty is rejected before you see it. So is one that
blames the economy, a competitor or the news: the product has no information
about the outside world and is not allowed to pretend otherwise.

### Recommended action — *recommendation*

One action from a fixed list, with a reason. The two buttons here are covered in
[Actions](actions.md).

If you wrote anything under Settings > Business context, it is shown here under
"Context you gave the model", so you can see what influenced the answer.

### Business impact — *observed fact*

The money, and what the figure actually is. Plus their ARR, plan, renewal, seats
and how long they have been a customer.

When it cannot work out a figure it says so. It never estimates one.

### History

Everything that has happened, oldest first: raised, updated, escalated, status
changes, owner and date changes, snoozes, reminders, notes, actions.

Add a note at the bottom. Notes are permanent.

### Actions taken

Emails drafted and tasks created, with their status.

### Outcome

Empty until you resolve it. Then: what happened, your note, and the date.

---

## The panel on the right

**This decision** — the moves you can make from where it is now. Only legal moves
are offered:

```
new → accepted → in progress → waiting → resolved
 └──────── snoozed ────────┘
 └──────── dismissed ──────┘   (from any open status)
```

- **Accept and assign** — you are taking this on. If it has no date, one is set
  from how serious it is: 2 days for critical, 5 for high, 10 for medium, 21 for
  low.
- **Snooze** — pick a date. It comes back then, and comes back **early if the
  customer gets worse**.
- **Dismiss** — needs a reason. Not raised again for two weeks unless things get
  worse, and your reason is shown to the AI next time.
- **Record the outcome** — resolve it. Covered below.

**Owner and date** — who is doing it and by when. Names come from Settings.

**Customer** — a link to everything known about them.

**How this was made** — whether the words came from the AI or the decision is
rules-only, which model answered, and the model's own confidence. Plus **Ask the
AI again**.

---

## Recording the outcome

Pick what happened: renewed, churned, expanded, payment recovered, no change, or
not known. Add a note. Optionally their ARR now.

**This is the most valuable thing you will type into this product.** It is shown
to the AI next time something happens on that customer, and it is the only way to
answer "did any of this work?" in three months.

A decision cannot be resolved without an outcome. That is on purpose.

---

## Things worth knowing

**"The signals have eased"** means the situation that raised this no longer
matches. It is **flagged, not closed**. Closing it is your call, because closing
it is where the outcome gets recorded.

**Reopening.** A resolved or dismissed decision can be reopened. It goes back to
accepted.

**Running the analysis again** updates this decision in place. Its status, owner,
date, notes and history all survive. If it got worse, the history says so, and a
snoozed decision wakes up.
