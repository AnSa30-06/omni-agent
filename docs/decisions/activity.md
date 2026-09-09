# Activity

**What it does.** Everything that has happened, newest first: what the system
did and what you did.

**Why it exists.** Two reasons. You need to be able to answer "why did this
change?" about any decision. And a product that acts on your customer data should
keep a record of what it did that you can read.

## Filters

**Everything**, **What the system did**, **What I did**.

## What you will see

**Analysis runs**, with the numbers that matter:

> Analysis: 48 customers, 14 situations, 13 new decisions, 0 updated
> 10 explained by the AI · 4 model failures · 7,000 tokens · auto/smart

That line tells you the cost and the reliability of every run. If failures are
consistently high, see [Troubleshooting](troubleshooting.md).

**Decision events**, each linked to its decision:

| Entry | Means |
|---|---|
| Raised as high | A new decision |
| Got worse — severity medium to high | The situation deteriorated |
| Updated | Re-analysed, with changed evidence |
| Status: new to accepted | You picked it up |
| Reminder — 3 days overdue | It went past its date |
| Came back — the snooze ran out | A snooze expired |
| Came back — the situation got worse | A snooze woke up early |
| Dismissed: <your reason> | You dismissed it |
| Outcome recorded: renewed | You closed it |
| Email drafted / Task created | An action |

**Reminders appear here.** The nagging is visible and auditable, not hidden.

## What it does not contain

The text of any AI answer, and the fact sheets sent to the model. Those are not
stored. What is stored about each model call is the model name, token counts,
timing and whether the answer passed validation.

## Limits

The most recent 120 entries. There is no search, and no export from this screen.
