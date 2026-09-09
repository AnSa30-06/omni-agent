# The demo company

Made-up customers with real-looking problems in them. Nothing of yours is used,
and no data leaves your computer.

**Why it exists.** So you can see what the product does in one click, and so the
product can be tested against data whose right answers are known.

Load it from **Settings > Data**, or:

```bash
vireo decisions seed demo
vireo decisions run
```

---

## Three versions

| Name | What it is |
|---|---|
| `demo` | 48 customers: healthy, at risk, expanding, payment problems, and the hard cases |
| `demo-cohort` | The same 48, but a change hits most of them in the same three weeks |
| `edge` | 20 customers built only from the hard cases |

---

## What is planted in `demo`

| How many | What they are | What should happen |
|---|---|---|
| 29 | Healthy: usage gently rising, renewal far off | **Nothing** |
| 4 | Clear churn risk: usage down 50%, renewal close, tickets up, champion quiet | Churn risk, high or critical |
| 2 | Subtle churn risk: usage down 30%, renewal in two months | Churn risk, medium |
| 3 | Expansion: usage up 85%, seats nearly full, pricing page viewed | Expansion |
| 3 | Payment problem: a failed invoice, a quiet champion | Payment problem |
| 4 | **False positives** | **Nothing** |
| 1 | Dismissed before, unchanged | **Nothing** — it stays suppressed |
| 1 | Dismissed before, now worse | A new decision |
| 1 | Stale data: usage stops 15 days early | **Nothing** — and a warning on their page |

### The four false positives are the point

Each of these crosses exactly one line while being otherwise fine:

- Tickets up 120%, but from 2 to 5, and everything else is healthy.
- A sharp dip in usage that already recovered.
- A renewal in 18 days with strong, rising usage.
- A main contact quiet for 20 days while usage climbs.

**If the product raises a decision about any of them, it is a threshold-flagger
with a language model on top, not a decision system.** They are why the demo data
proves something rather than just filling a screen.

### The `demo-cohort` version

The same customers, with a decline that hits most of them at once.

It should produce **one** company-wide decision, not thirty individual ones. Each
customer's own usage signal is discounted, because a change shared by most of
your customers is weaker evidence about any one of them.

Two of the subtle churn accounts stop being raised individually in this version.
That is correct: they are covered by the company-wide decision.

---

## Using it to see the whole loop

1. Load `demo` and run the analysis.
2. Open the most serious decision. Read the evidence and the hypotheses.
3. **Accept and assign** it. A date is set for you.
4. Draft an email. Look at it, then discard it.
5. **Settings > Demo mode > Advance 10 days.**
6. Go to Today. The Overdue tile is red and the card says you have not handled it.
7. Open it and **Record the outcome**.
8. Look at **Activity**. The whole story is there, with what the system did and
   what you did.

That is the product.

---

## Things to know

- **Regenerated relative to today**, so it never looks stale.
- **Deterministic**: the same seed always produces exactly the same customers.
- **Loading it replaces your customer data.** Use a separate workspace if you
  have real data in this one.
- **It turns demo mode on**, which freezes the date. Turn it off before importing
  real data.
- The scenario labels are in `scenarios.json` inside the generated folder, and
  are what `npm run test:eval` scores against.
