# Getting started

From opening the app to closing your first decision. About 15 minutes, and you
do not need to know anything about AI.

---

## Step 1. Open Decisions

Open **Omni Agent**, then click **Decisions** in the list on the left.

Or, from a terminal:

```bash
omni-agent decisions
```

The first time, it asks you three questions. That is the whole setup.

---

## Step 2. Name your workspace

A workspace is one company's data. Type the name of your company and click
**Continue**.

You can have more than one workspace later. They never share data.

---

## Step 3. Choose your data

Two buttons.

**Load the demo company** gives you 48 made-up customers with real-looking
problems in them. Nothing of yours is used. **Do this first**, even if you have
your own data: it takes one click and it shows you what the product does before
you spend time on file formats.

**Import my own data** wants a folder with six spreadsheet files in it. Click
**Download blank templates** to get them with the right column names already
filled in. See [Importing your data](importing-data.md).

---

## Step 4. Run the first analysis

Click **Run the analysis**.

It reads every customer, works out what changed, and asks the AI about the ones
that matter. A progress line tells you which part it is on.

**It can take a minute.** Omni Agent works with free AI models by default, and
free models are slow. If you have added a provider key, it is much faster. See
[Troubleshooting](troubleshooting.md) if it seems stuck.

When it finishes you land on **Today**.

---

## Step 5. Read one decision

Today shows a card for each decision. The most serious are first.

A card tells you five things:

- **How serious it is** — the coloured word on the left.
- **Which customer, and what is happening** — the title.
- **How much money is involved** — on the right.
- **What changed** — the bullet points. Every one of these is a fact computed
  from your data.
- **What to do** — the "Recommended" line.

Click the title to open it.

The detail page answers "why should I believe this?". Read these three parts:

1. **Why this matters** — the AI's interpretation, in two or three sentences.
2. **Everything we looked at** — every signal on that customer, including the
   ones the recommendation did not use. This is the honest version.
3. **What might be causing it** — guesses, labelled as guesses, each with a
   confidence and the evidence it came from.

Each block has a coloured label saying what kind of statement it is: **observed
fact**, **AI interpretation**, **hypothesis** or **recommendation**. That
labelling is the point. You should always know which one you are reading.

---

## Step 6. Handle it

On the right of the detail page:

- **Accept and assign** — you are taking this on. A date is set for you.
- **Snooze** — not now. It comes back on the date you pick, and it wakes up early
  if the customer gets worse.
- **Dismiss** — this is not a real problem. You have to say why. It will not be
  raised again for two weeks unless things get worse, and the AI is shown your
  reason next time so it does not repeat itself.

Click **Accept and assign**.

Then, under **Recommended action**, click **Draft an email**. The AI writes a
short message from this decision. Edit it, then **Copy** it or **Open in my mail
app**.

**Nothing is sent by this app.** There is no code in it that can send an email.
You send it yourself, from your own mail program. When you have, click **Mark as
sent**.

---

## Step 7. See the reminder

A decision you have accepted has a date on it. If that date passes and you have
not finished, Today says so.

You do not have to wait a week to see this. Go to **Settings**, find **Demo
mode**, and click **Advance** to move the clock forward 7 days.

Go back to **Today**. The **Overdue** tile is now red, and the card says *"You
have not handled this yet — 7 days overdue"*.

That is the part that makes this different from a dashboard. It does not forget.

---

## Step 8. Record what happened

Open the decision again and click **Record the outcome**.

Pick what happened — renewed, churned, expanded, payment recovered, no change —
and add a note.

This is the most valuable thing you will type into this product. It is what the
AI is shown the next time something happens on that customer, and it is the only
way to find out later whether any of this worked.

---

## What next

- Turn off demo mode in Settings when you are done exploring.
- Add the names of your team under **Settings > Who can own a decision**, so
  decisions can be assigned.
- Write a few lines under **Settings > Business context**. Tell it things your
  data cannot say: when your quiet season is, how your contracts work.
- Import your own data. [Importing your data](importing-data.md) has the
  columns.

Before you trust it with real work, read [Limitations](limitations.md). It is
short and it is honest about what this version does not do.
