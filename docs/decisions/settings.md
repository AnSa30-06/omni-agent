# Settings

Every setting, its default, and what changes when you change it.

---

## Workspace

The company name, and where your data is on disk. Open that folder to find the
copies of everything you have imported, under `imports/`.

## Data

**Import a folder** — replaces the customer data, keeps your decisions. See
[Importing your data](importing-data.md).

**Download blank templates** — writes six CSV files with the right column names
into your Downloads folder.

**Load a demo company** — replaces the customer data with made-up customers.
Three to choose from; see [The demo company](demo-company.md).

## Who can own a decision

A list of names. They are the choices in the Owner box on a decision, and the
signature on a drafted email.

These are names, not user accounts. There is no sign-in in this version.

## Business context

**Default: empty. Up to 1,000 characters.**

Free text handed to the AI with every decision. Say what your data cannot:

> Contracts are annual and auto-renew. August is quiet for our logistics
> customers. We migrated everyone to a new login in July, which caused a dip.

**Do not put numbers in it.** Numbers here are deliberately not treated as facts
about a customer: a figure typed here can never be used by the AI to make a claim
about an account. This is a guard against laundering an assumption into evidence.

You can see what influenced any decision: it is shown on the decision page under
"Context you gave the model".

## Analysis

**How many decisions the AI explains per run.** Default 10, range 1 to 50.

Everything is still found by the rules. This only limits how many get a written
explanation. Anything over the limit becomes a decision with its evidence and its
money, marked "no AI explanation". Higher costs more and takes longer.

**Price of one seat per month.** Default empty. Used to estimate what an
expansion is worth. Empty, and expansion decisions say "not estimated" rather
than guessing.

## Thresholds

Three lines you can move:

| Threshold | Default | What it does |
|---|---|---|
| Usage down | 25% | How far usage must fall to count as a signal |
| Renewal approaching | 90 days | How close a renewal must be to count |
| Support tickets up | 50% | How far ticket volume must rise to count |

**These were chosen, not measured against real churn data.** Moving them is
expected once you have seen a run on your own customers.

Only the first level of each is editable. The more serious levels keep their
shipped values so that "severe" means the same thing on every screen.

Lowering a threshold raises more decisions. Raising it raises fewer. Neither
changes anything about how the AI reasons.

## Privacy

**Hide customer names from the AI. Default: on.**

On, customers are sent as `A-17` and people as their job titles. Off, real names
are sent.

The models this app uses by default are run by other companies. See
[Privacy](privacy.md) for exactly what is sent, and for how to run with no AI at
all.

## Demo mode

**Default: off, and on after you load a demo company.**

Freezes "today" at a fixed date and lets you move it forward with **Advance**.
That is how you see a reminder appear without waiting a week.

**Turn it off before using real data.** With it on, every signal is computed
against the frozen date, so a real import will look stale. The frozen date is
always shown in the top bar.

## Delete this workspace

Removes the data, every decision, the history and the outcomes. You type the
workspace name to confirm. It cannot be undone and there is no bin.

---

## Where the model settings are

There are none here. Decisions uses whatever model Vireo is set to use, and
inherits its routing, fallback and provider keys. To change the model, or add a
free provider key to make runs faster, use Vireo's own **Free capacity** and
**Settings** pages.
