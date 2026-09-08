# How it works

Six steps. The software does five of them. The AI does one.

```
your spreadsheets
      ↓  1. import          checked, rejected rows reported
   customer data
      ↓  2. signals         every number, computed by code
   what changed
      ↓  3. situations      several signals together, by rule
 things worth a decision
      ↓  4. reasoning       the AI explains and recommends
     a decision
      ↓  5. you             accept, snooze or dismiss
      ↓  6. follow-up       reminders until you close it
     an outcome
```

---

## 1. Import

You point it at a folder of spreadsheets. It checks every row.

A row with a date it cannot read, or a customer id that is not in your accounts
file, is **rejected and counted**, never guessed at. The import report tells you
how many rows each file had, how many were used, and why the rest were not.

Importing again replaces the customer data. Your decisions, notes and outcomes
are kept.

---

## 2. Signals: what changed

For every customer, the software works out eleven things. All of them are
arithmetic, done in code, with no AI involved:

| Signal | What it measures |
|---|---|
| Usage down (30 days) | Average daily active users, last 30 days against the 30 before |
| Usage up (30 days) | The same, upward |
| Usage down this week | Last 7 days against the previous four weeks |
| Renewal approaching | Days until the renewal date |
| Support tickets up | Tickets opened in 30 days against the 30 before |
| Seats under-used | Seats actually used against seats bought |
| Seats nearly full | The same, at the other end |
| Payment failed | Failed invoices, how many attempts, how big |
| Champion inactive | Days since your main contact was last active |
| Pricing interest | Pricing page views in the last two weeks |
| Data is stale | How long ago your usage data stops |

Each one gets a level from 0 to 3, and one sentence of plain English:

> Average daily active users fell 45% over the last 30 days (11 vs 20).

**That sentence is the only thing the AI ever sees about that number.** It never
sees your spreadsheet.

Two rules worth knowing:

- **A day with no row is missing, not zero.** A gap in your reporting is not a
  collapse in usage.
- **If your usage data is out of date**, the usage signals are marked unreliable
  and are not acted on. The customer page says so.

---

## 3. Situations: what is worth a decision

**One signal on its own is never a decision.** Support tickets going up at one
customer is watched, not raised. It takes a combination:

| Situation | Needs |
|---|---|
| **Churn risk** | Usage down, plus one of: renewal near, tickets up, champion quiet, seats under-used |
| **Expansion** | Usage up, plus one of: seats nearly full, pricing page viewed |
| **Payment problem** | A failed payment, plus usage down or a quiet champion. Three failed attempts stands alone. |
| **Company-wide change** | The same change at 40% or more of your customers at once |

That last one matters. If usage drops for most of your customers in the same
week, that is one thing that happened to your product or your market, not thirty
customers each deciding to leave. It raises **one** decision, and each
customer's own usage signal is discounted so they do not each get blamed
individually.

**How serious** a decision is comes from adding up the signal levels. It is
arithmetic, not judgement, so the ordering on your screen is always explainable.

**How much money** is at stake is also computed: their annual value for a churn
risk, the unpaid amount for a payment problem, the extra seats for an expansion.
If it cannot work out a figure it says so rather than estimating one.

---

## 4. Reasoning: what the AI does

Only the situations that survived step 3 go to the AI, and only the most serious
ones — ten per run by default, which you can change in Settings.

The AI is given a **fact sheet**: the sentences from step 2, the customer's plan,
their renewal date, how long they have been a customer, what you wrote in
Business context, and any decision you dismissed or resolved on them before. By
default the customer's name is replaced with a code like `A-17` and people are
described by their job title.

It is asked for four things:

1. Why this matters, in two or three sentences.
2. Which signals changed, most important first.
3. One to three possible causes, each with a confidence.
4. One action, chosen from a fixed list.

It may also say **"this is not worth a decision"**, and it is asked to.

### What is checked before you see it

The answer is thrown away and asked for again if:

- it cites a signal that does not exist;
- it recommends an action that is not on the list;
- **it contains any number that is not in the fact sheet**;
- it contains a web address or an email address;
- it blames the economy, a competitor or the news — it has no information about
  the outside world;
- it writes a guess as a certainty.

It gets one retry, with the problem explained. If it fails twice, or the AI is
unavailable, **the decision is still raised** from the rules alone. It has the
evidence and the money, and says "the AI could not explain this one". You can ask
it to try again from the page.

The AI never decides how serious something is, how much money is involved, or
what order things appear in. Those all come from step 3.

---

## 5. and 6. The decision, and not forgetting it

A decision has a life: **new → accepted → in progress → waiting → resolved**, or
dismissed at any point. Every change is written to its history with who did it.

While it is open:

- If you set a date and it passes, Today says so.
- If you snooze it, it comes back — and comes back early if the customer gets
  worse.
- If it is waiting for a week, it nudges you.
- If the signals ease off, it is **flagged, not closed**. Closing it is your
  decision, because closing it is where the outcome gets recorded.

Running the analysis again does not raise the same decision twice. If nothing
changed, it is not even sent to the AI, so it costs nothing.

---

## What this costs to run

On the demo company (48 customers), one run:

| | |
|---|---|
| Customers read | 48 |
| Signals computed | ~65 |
| Situations found | ~14 |
| Sent to the AI | up to 10 |
| Model calls | 10 to 14 (a retry costs one more) |

Steps 1 to 3 cost nothing at all. Only step 4 uses the AI, and only for
situations that already passed the rules.

Running it a second time with nothing changed costs **zero**: every packet is
unchanged, so nothing is sent.

---

## How well does it work?

There is a test that measures it, against demo data with known answers planted
in it:

```bash
npm run test:eval
```

It scores whether the planted situations were found, whether healthy customers
were left alone, whether the right evidence was cited, and whether any number
appeared that was not in the data. The report is written to
`tests/eval/decisions/results/report.json`.

**The thresholds in this product were chosen, not measured against real churn.**
That is the honest position. See [Limitations](limitations.md).
