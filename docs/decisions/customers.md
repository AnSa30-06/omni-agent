# Customers

**What it does.** Shows every customer you imported, what state each is in, and
everything the product knows about one of them.

**Why it exists.** Two questions: "what is going on with this account?" before a
call, and "why has nothing been raised about them?" when you expected something.

---

## The list

| Column | What it is |
|---|---|
| **State** | One label, worked out from the signals. See below. |
| **Customer** | Their name. A "stale data" tag means their usage data stops early. |
| **ARR** | What they pay you a year. |
| **Plan, Renewal, Owner** | From your accounts file. |
| **Open** | How many open decisions. |
| **Watching** | Single signals that fired but did not add up to a decision. |

Search by name, filter by state, sort by ARR or by renewal date.

### The states

| Label | Means |
|---|---|
| **Payment issue** | A payment has failed. |
| **At risk** | An open churn risk. |
| **Expansion ready** | An open expansion opportunity. |
| **Dormant** | Usage has fallen a long way and is now near zero. |
| **New** | A customer for less than 90 days. |
| **Watching** | Something moved, but not enough to be a decision. |
| **Healthy** | Nothing moved. |

The first match wins, so a customer with a failed payment is "Payment issue" even
if other things are also true. The label is a summary; the signals underneath it
are the truth.

**States only appear after an analysis has run.**

---

## One customer

**The facts** — what you imported: ARR, plan, seats, renewal, owner, segment,
industry, how long they have been a customer.

**People** — your contacts, their job titles, and how long each has been quiet.
The main contact is marked. Only main contacts are watched.

**Signals in the last analysis** — every signal, with how strong it is.

Two notes you may see:

- **"watching only — one signal on its own is never a decision"**. This is the
  answer to "why was nothing raised?". One thing moving is not enough. It is
  deliberate: it is what stops the product crying wolf.
- **"the usage data is out of date, so this is not being acted on"**. Their usage
  rows stop too long ago to trust.

**Decisions** — open and past, most recent first.

**The data behind this** — when their usage data ends, and how many rows of each
kind you imported. Start here when a number looks wrong.

---

## What to expect

On the demo company, roughly half the customers are Healthy, a handful are At
risk or Expansion ready, and the rest are Watching. If **everything** is Healthy
or **everything** is At risk, something is wrong with the data or the thresholds.

## Empty state

"No customers" means nothing has been imported. Go to Settings > Data.
