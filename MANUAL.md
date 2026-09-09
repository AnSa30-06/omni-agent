# Vireo — the manual

Everything you need, in one page. No jargon. If you only read one section, read
**[Your first five minutes](#your-first-five-minutes)**.

---

## Contents

1. [What Vireo is](#what-vireo-is)
2. [Install it](#install-it)
3. [Your first five minutes](#your-first-five-minutes)
4. [Part one: the assistant](#part-one-the-assistant)
5. [Part two: Decisions](#part-two-decisions)
6. [Making it faster](#making-it-faster)
7. [Your data and your privacy](#your-data-and-your-privacy)
8. [When something goes wrong](#when-something-goes-wrong)
9. [Everything else](#everything-else)

---

## What Vireo is

Two things in one window.

**An assistant that can actually do things.** It writes and runs code, opens a
real web browser and clicks through websites, searches and reads the web, and
reads your PDFs, Word files and spreadsheets. You talk to it in plain English.

**Decisions.** You give it spreadsheets about your customers. It tells you which
ones need your attention this week, why, and what to do about it.

You do not need an account. You do not need to pay for anything. You do not need
an API key, though one makes it much faster.

Everything runs on your own computer.

---

## Install it

### 1. Download

Get `VireoSetup-1.2.0.exe` from the
[releases page](https://github.com/AnSa30-06/omni-agent/releases).

### 2. Windows will warn you. This is expected.

You will see a blue box saying **"Windows protected your PC"**.

Click **More info**, then **Run anyway**.

That warning means *"nobody has paid a certificate authority to vouch for this
file"*. It does not mean the file is known to be bad. Code-signing certificates
cost several hundred pounds a year and this project does not have one.

### 3. Run it

No administrator password is needed. It installs just for you.

### 4. Wait for the first-run setup

When the installer finishes it opens a setup window. **This part takes ten to
thirty minutes and downloads about 4 GB.** It only ever happens once.

It is fetching the three big pieces that are too large to put in a download: the
model gateway, the agent engine, and a web browser for it to drive.

Leave it running. Make a cup of tea.

### What you need

| | |
|---|---|
| Windows | 10 or 11, 64-bit |
| Disk space | About 6 GB once it has finished |
| Internet | Needed for setup, and for anything that uses the web |
| Administrator | Not needed |

---

## Your first five minutes

Open **Vireo** from your Desktop or Start Menu.

### Try the assistant

Type this into the box at the bottom:

> Search the web and tell me three things that happened in AI this week, with links.

Watch it work. It will search, open the pages it found, read them, and answer
with links it actually visited.

Then try:

> Look at the files in my workspace and tell me what is there.

### Try Decisions

Click **Decisions** in the list on the left.

1. Give your workspace a name. Anything.
2. Click **Load the demo company** — 48 made-up customers with realistic problems
   hidden in them. None of your data is used.
3. Click **Run the analysis**. It takes a minute.

You now have a list of customers who need attention, most serious first. Click
one open and read it.

That is the whole product, in about three minutes.

---

## Part one: the assistant

### Chat or Code

There are two modes, chosen at the top left.

**Chat** reads, searches and explains. **It never changes your files.** Use it
for questions.

**Code** does things: writes files, runs commands, drives the browser. Use it for
work.

### What it can do

| | |
|---|---|
| Write and run code | Any language. It reads your project first, then edits, runs and tests. |
| Use a real browser | It clicks, types, fills forms, switches tabs, downloads files. Real Chromium, not a simulation. |
| Search and read the web | It fetches the actual page before quoting it, and cites the address it really loaded. |
| Read documents | PDF, Word, Excel, CSV, JSON, text, Markdown. |
| Write documents | Spreadsheets, CSV, JSON, Markdown. |
| Analyse data | Profiles a spreadsheet — types, gaps, statistics — without spending anything. |
| Git and GitHub | Branches, commits, pull requests, issues. |

### It stops before doing anything it cannot undo

**Filling in a form and stopping is the normal, correct outcome.**

Before it submits anything, sends anything, buys anything, publishes anything or
deletes anything, it stops and asks you about that exact action. Saying "go
ahead" earlier in the conversation does not count.

This is enforced in the code itself. No setting turns it off.

It will also not defeat CAPTCHAs or bot checks, and will tell you when one has
stopped it.

### The working folder

The button next to the message box shows which folder it is working in. Click it
to change it.

A conversation's folder is fixed when the conversation starts. Changing it sets
where your **next** conversation will work.

### Attaching files

The **+** button. Small text files are sent with your message. Anything bigger,
or a PDF or spreadsheet, is handed over as a file for it to open itself. The chip
on screen tells you which is happening.

### Routines

A saved instruction on a schedule. *"Every weekday at 9, check my inbox folder
and summarise what changed."*

Two kinds: while the app is open, or even when it is closed. The screen tells you
which one you picked, because a routine that only runs when you happen to have
the app open is worse than no routine.

---

## Part two: Decisions

### The idea

Your customer data already contains the answer. Your billing system knows about
the failed payment. Your product knows usage is down. Your help desk knows
tickets are up. Your CRM knows the renewal is in six weeks.

Nobody reads all four for every customer every week, so problems get noticed at
the renewal call.

Decisions reads all four for every customer, every time you run it, and hands you
only the ones worth your time.

### Getting your own data in

Six spreadsheet files in one folder. Only the first two are required.

| File | What it holds |
|---|---|
| `accounts.csv` | One row per customer: id, name, what they pay, plan, seats, renewal date |
| `usage_daily.csv` | One row per customer per day: active users, sessions, seats used |
| `contacts.csv` | Your contacts, their job titles, when they were last active |
| `tickets.csv` | Support tickets, opened and closed dates, priority |
| `invoices.csv` | Invoices, whether they were paid, how many attempts |
| `events.csv` | Notable moments: pricing page viewed, seat limit hit |

**Settings > Data > Download blank templates** writes all six with the right
column names and an example row. Fill them in and import that folder.

Send at least 60 days of usage. It compares the last 30 days with the 30 before.

### Two rules it will not break

**Every number on the screen was computed from your data, not written by an AI.**
The software does all the arithmetic. The AI only reads sentences the software
wrote, and only writes the explanation. If the AI produces a number that is not
in your data, the answer is thrown away and it is asked again.

**One thing changing is never a decision.** A customer whose tickets went up is
watched, not raised. It takes several things moving together. That rule is in the
code, not in the AI's judgement, so it holds even when the AI is unavailable.

### Reading a decision

Every block on the page has a coloured label. **Read the label first.**

| Label | What it means |
|---|---|
| **Observed fact** | Measured from your data. Cannot be wrong unless your data is. |
| **AI interpretation** | What a model thinks it means. Can be plausible and wrong. |
| **Hypothesis** | A guess, and labelled as one. |
| **Recommendation** | What to do next. |

The panel called **Everything we looked at** shows every signal on that customer,
including the ones the recommendation ignored. That is the honest one. If the
story does not match the evidence, you will see it there.

### Handling one

- **Accept and assign** — you are taking it on. A date is set for you.
- **Snooze** — not now. It comes back on the date you choose, and comes back
  early if the customer gets worse.
- **Dismiss** — not a real problem. You say why. It will not be raised again for
  two weeks unless things worsen, and the AI is shown your reason next time.

Then **Draft an email** writes a short message you can edit. **Nothing is sent by
this app.** There is no code in it that can send an email. You send it from your
own mail program.

### It does not forget

If you say you will handle something by Friday and Friday passes, Today says
*"You have not handled this yet"*.

When you finish, click **Record the outcome** and say what actually happened.
That is the most valuable thing you will type into this product: it is shown to
the AI next time something happens on that customer, and it is the only way to
find out in three months whether any of this worked.

---

## Making it faster

Vireo works with no account at all, but only a handful of free models still
answer and they are slow. A run that takes a minute can take five seconds.

**One free key fixes this.** Click **Free capacity** in the sidebar, pick a
provider, and follow the steps. They all have a genuinely free tier that needs no
card. Mistral has by far the largest.

If someone gave you this app with a key already inside it, models work
immediately and you can skip this.

Already paying for Claude, ChatGPT, Copilot, Cursor or Gemini? Sign in on the
same page and Vireo uses that. Nothing is charged twice.

---

## Your data and your privacy

**Everything runs on your computer.** There is no account, no sign-in, and no
server belonging to this product. Your files are never uploaded.

**Your API keys are encrypted** using Windows' own mechanism, tied to your
Windows account. Another account on the same machine cannot read them.

**Nothing that looks like a secret is written to a log.**

**What does leave your machine:** what you actually send to a model. When you
chat, your message goes to whichever AI model is serving you. In Decisions, the
only thing sent is a short fact sheet about one customer — and by default the
customer's name is replaced with a code like `A-17` and people are described by
their job title, not their name.

`docs/decisions/privacy.md` shows a real example of exactly what that fact sheet
looks like.

**To use Decisions with no AI at all**, open a terminal and run
`vireo decisions run --no-model`. Every decision is still found. Only the written
explanation is missing.

**To delete everything**, uninstall Vireo and delete the folder
`%LOCALAPPDATA%\Vireo`.

---

## When something goes wrong

**"Windows protected your PC"** — expected. More info, then Run anyway. See
[Install it](#install-it).

**Setup is taking forever** — it downloads about 4 GB on first run. Ten to thirty
minutes is normal. It only happens once.

**The window does not open** — Vireo falls back to your normal browser and tells
you why. The usual cause is a missing **Microsoft Visual C++ Redistributable
(x64)**. Installing that fixes it.

**It says a model failed** — free models are busy and sometimes refuse. Try
again, or add a free key from **Free capacity**. In Decisions, a failed model
never loses you a decision: it is still raised from the rules and says "the AI
could not explain this one".

**Decisions found nothing** — often the right answer. Check the Customers page.
If everyone is "Healthy", nothing changed. If you have less than 60 days of usage
data, no usage signal can be produced at all.

**The date at the top of Decisions is wrong** — you are in demo mode, which
freezes the date so you can move it forward. Settings > Demo mode.

**Check everything at once:**

```bash
vireo doctor
```

That runs real checks, not guesses. It tries an actual model request, an actual
search, an actual page fetch and an actual browser launch, and tells you which
one failed.

---

## Everything else

### Useful commands

```bash
vireo                      Start the assistant in a terminal
vireo ui                   Open the app window
vireo decisions            Open Decisions
vireo decisions seed demo  Load the demo company
vireo decisions run        Analyse now, without opening a window
vireo doctor               Check everything works
vireo usage                What model you are on and what it is costing
vireo provider             Free providers you can add
```

### Deeper reading

| | |
|---|---|
| [Decisions, in full](docs/decisions/) | 15 pages: every screen, importing data, privacy, limits |
| [Getting started with Decisions](docs/decisions/getting-started.md) | Install to first handled decision |
| [What Decisions cannot do](docs/decisions/limitations.md) | The honest list. Read it before relying on it. |
| [The app window](docs/desktop-app.md) | Chat, Code, routines, transcripts, models |
| [Security](docs/security.md) | What is enforced, and what is not protected |
| [Sending it to someone](docs/sharing.md) | Building a copy with a key already inside |

### The honest bit

Decisions has never been run against a real company's data, and its thresholds
for "significant" were chosen sensibly rather than measured against real
outcomes. It is internally consistent and its arithmetic is correct. Whether its
idea of *important* matches your business is something only you can find out.

Treat what it raises as a good place to start looking, not as an answer.

---

Built on [OpenCode](https://opencode.ai) and
[OmniRoute](https://github.com/diegosouzapw/OmniRoute), both used unmodified.
Browser automation by [Playwright](https://playwright.dev). MIT licensed.
