# Today

**What it does.** Shows what needs your attention right now, in the order it
matters.

**Why it exists.** Because the question a customer-success lead has on a Monday
morning is not "what are my metrics", it is "what do I have to deal with". A
dashboard answers the first. This answers the second.

**How to use it.** Read down the page. Handle the first card. Repeat until the
top section is empty.

---

## The six tiles

| Tile | What it counts |
|---|---|
| **Need a decision** | New, never looked at. Start here. |
| **Overdue** | You said you would handle it by a date that has passed. Red when it is not zero. |
| **Being handled** | Accepted, in progress or waiting. |
| **Snoozed** | Coming back on a date you chose. |
| **Resolved this month** | Closed with an outcome recorded. |
| **Revenue under review** | The combined annual value of the customers with an open churn risk. |

Each tile is a button that filters the Decisions list.

**"Revenue under review" is not a forecast.** It is the sum of what those
customers currently pay you. It is not what you will lose.

## The sections

Cards are grouped, most serious first inside each group:

1. **Needs a decision** — new.
2. **Overdue** — past their date. These carry *"You have not handled this yet —
   N days overdue"*.
3. **Being handled** — you have picked these up.
4. **Snoozed** — with the date they return.
5. **Resolved this month** — the last five, so you can see the loop closing.

## A card

Everything on a card except the "Recommended" line is a fact computed from your
data.

- **The coloured word** on the left is how serious it is: critical, high, medium
  or low. It comes from adding up the signal levels, not from the AI.
- **The title** names the customer and what is happening.
- **The money** on the right, with what the figure actually is underneath it.
- **Up to three bullet points**: the strongest evidence.
- **Recommended**: one action, from a fixed list.
- **The footer**: how old it is, who owns it, and any warnings.

Three things you may see in the footer:

- **"no AI explanation"** — the model was unavailable. The decision is still
  real; open it and click *Try the AI again*.
- **"signals eased"** — the situation that raised this has gone away. It is left
  open on purpose, so you can close it and record what happened.
- **"You have not handled this yet"** — it is overdue.

## The three buttons

**Handle** opens the decision. **Snooze** and **Dismiss** are here so you can
clear the noise without opening anything.

## Run analysis

Top right, and in the sidebar. It reads your data again and updates the list.

Running it twice with nothing changed costs nothing: unchanged situations are not
sent to the AI at all.

## What you should expect

On a first run over 48 customers you might see ten to fifteen decisions. On a
weekly run after that, one or two new ones, because everything else is already on
your list and is updated in place rather than raised again.

## Empty states

| What it says | What it means |
|---|---|
| "No analysis yet" | You have imported data but not run it. Click Run analysis. |
| "Nothing needs a decision" | It ran and found nothing over the line. It tells you how many customers it checked. Single signals being watched are on the Customers page. |
| "This workspace has no customer data yet" | Import a folder, or load the demo company. |

## Common problems

**Everything is critical.** Your thresholds are too low for your business, or
your data has a systematic problem (a reporting gap that looks like a usage
collapse). Check one customer's page before changing anything.

**Nothing ever appears.** See [Troubleshooting](troubleshooting.md).

**The date at the top is wrong.** You are in demo mode. Settings > Demo mode.
