# Decisions

**Decisions turns your customer data into a short list of things that need a decision.**

You give it a folder of spreadsheets about your customers. It works out what has
changed for each one, finds the customers where several things have changed at
once, and asks an AI to explain what it means and what to do. You get a list.
Each item says what happened, why it matters, what to do, and how much money is
involved.

It then remembers. A decision stays on your list until you close it. If you say
you will handle it by Friday and Friday passes, it says so. When you finish, you
record what actually happened.

Everything runs on your own computer.

---

## Start here

| | |
|---|---|
| **[Getting started](getting-started.md)** | Install to your first handled decision. About 15 minutes. |
| [How it works](how-it-works.md) | What the software works out, and what the AI does. |
| [Importing your data](importing-data.md) | The six files, every column, and where to get them. |
| [The demo company](demo-company.md) | The made-up customers, and what is planted in them. |

## The screens

| | |
|---|---|
| [Today](today.md) | What needs your attention now. |
| [Decisions](decisions.md) | Every decision, with filters. |
| [Decision detail](decision-detail.md) | Why a decision was raised, and what to do about it. |
| [Customers](customers.md) | What it knows about each customer. |
| [Activity](activity.md) | What the system did, and what you did. |
| [Settings](settings.md) | Owners, business context, thresholds, privacy, demo mode. |
| [Actions](actions.md) | Drafting an email and creating a task. |

## Before you rely on it

| | |
|---|---|
| [Privacy](privacy.md) | What leaves your computer, and what never does. |
| [Limitations](limitations.md) | What this version cannot do. Read this one. |
| [Troubleshooting](troubleshooting.md) | When something does not work. |

---

## The idea in one paragraph

Your customer data already contains the answer. Stripe knows about the failed
payment, your product database knows usage is down, your help desk knows tickets
are up, your CRM knows the renewal is in six weeks. Nobody reads all four for
every customer every week, so problems get noticed at the renewal call. This
reads all four for every customer, every time you run it, and hands you only the
ones where enough has changed to be worth your time.

## Two rules it will not break

**Every number on the screen was computed from your data, not written by an AI.**
The software calculates the percentages, the dates, the counts and the money. The
AI only reads sentences the software wrote, and only writes the explanation. If
the AI produces a number that is not in your data, the answer is thrown away.

**One thing changing is never a decision.** A customer whose support tickets went
up is watched, not raised. It takes several things moving together. That rule is
in the code, not in the AI's judgement, so it holds even when the AI is
unavailable.
