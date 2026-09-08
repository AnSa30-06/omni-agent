# Limitations

The honest list. Read it before you rely on this for anything that matters.

---

## The thresholds were chosen, not measured

Usage down 25% counts as a signal. A renewal within 90 days counts. Support
tickets up 50% counts. **These numbers were picked as sensible starting points.
They have not been calibrated against real churn data**, because no real churn
data was used to build this.

What that means for you: the product is internally consistent and its arithmetic
is correct, but whether *its* idea of "significant" matches *your* business is
something only you can find out. Run it on your real data, look at what it
raised, and adjust the three editable thresholds in Settings.

Do this before you trust the ordering.

## It has no live connections

No Stripe, no HubSpot, no Salesforce, no PostHog, no Intercom. You export CSV
files and import a folder. Every week, by hand.

## It only runs while the app is open

Reminders, snooze expiry and overdue checks happen while Omni Agent is running.
Close the app and nothing happens until you open it again.

There is no scheduled background run in this version, and no notification that
reaches you outside the app — no email, no phone, no desktop pop-up. Today is
where you find out.

## It cannot send anything

There is no code in this product that sends an email, posts to Slack, or writes
to your CRM. The "Draft an email" action writes a message and hands it to your
own mail program. You send it.

This is deliberate for a first version, not unfinished.

## Two actions only

Draft an email, and create a task. The task lives inside this product; it does
not appear in Jira, Asana or anywhere else.

## Four kinds of situation

Churn risk, expansion, payment problem, company-wide change. That is all it
looks for. It will not find a support quality problem, an onboarding failure, a
pricing objection or anything else you might care about.

## Eleven signals, and they are all quantitative

It reads numbers and dates. It does not read the words in your support tickets,
your emails, your call notes or your NPS comments. A customer who told you in
writing that they are leaving will not be flagged unless their usage moved.

## The AI can be wrong

The figures cannot — they are computed and checked. But the **interpretation**,
the **possible causes** and the **recommended action** are written by a language
model, and it can be plausible and wrong.

Three things help you catch that:

- Everything is labelled by kind. A hypothesis is labelled a hypothesis.
- The **Everything we looked at** panel shows every signal, including the ones
  the recommendation ignored. If the evidence does not support the story, you
  can see it.
- The AI may not use any number that is not in your data, so it cannot invent a
  figure to support a claim.

If a recommendation looks wrong, it probably is. Dismiss it and say why.

## Free models are slow, and sometimes silent

Omni Agent works with no API key using free models. Those models are slow (a run
can take a minute or two) and sometimes fail. When one fails, the decision is
still raised — from the rules, with its evidence and its money figure — and says
"the AI could not explain this one".

Adding one free provider key makes this much better. Omni Agent's **Free
capacity** page lists them.

## One person, one computer

No accounts, no sign-in, no sharing. The owner of a decision is a name you typed,
not a user. Two people cannot work in the same workspace.

## It does not predict anything

There is no model of whether a customer will churn. "Money at stake" is what
they currently pay you, not a forecast of what you will lose. Nothing here is a
probability.

## It knows nothing about the outside world

No news, no competitors, no market data. When something happens to most of your
customers at once, it will tell you that it happened, and it will say it cannot
explain it from your data. It will not guess at why, and the AI is explicitly
forbidden from blaming the economy.

## What has actually been tested

- 222 automated tests, covering the arithmetic at its boundaries, the import
  rules, the decision lifecycle, follow-up, and a full run against a scripted
  model.
- An evaluation against demo data with known answers planted in it: it finds the
  planted situations, leaves the healthy and near-miss customers alone, cites the
  strongest evidence, and produces no ungrounded numbers. Run it yourself with
  `npm run test:eval`.

**It has not been tested against a real company's data**, and no real customer
has used it. That is the next thing that should happen, and until it does,
treat the output as a starting point for your own judgement rather than an
answer.
