# Actions

Two, and both need you.

**Why only two, and why human-in-the-loop.** An agent that emails your customers
by itself is a different product with a different risk. This one prepares the
work and hands it to you.

---

## Draft an email

**What it does.** Writes a short message to the customer, based on the decision.

**What it produces.** A subject and a body you can edit, with three buttons:
**Copy**, **Open in my mail app**, and **Mark as sent**.

**🔴 Nothing here sends an email.** There is no code in this product that can.
"Open in my mail app" hands the text to your own mail program, exactly as
clicking an email link on a web page does. You send it.

### What the AI is doing

It is given the customer's name, your name, what the decision recommends, and the
top three pieces of evidence. It is told:

- under 150 words, plain, no jargon;
- **do not state any internal metric, score or percentage**;
- do not mention monitoring, risk scores, or that software flagged this;
- do not invent facts about the customer;
- the aim is to open a conversation, not to close a deal.

The draft is checked before you see it. If it contains a number that is not in
that customer's data, it is thrown away and the standard wording is used instead.

**The customer's real name is used here**, even though it is hidden from the AI
everywhere else, because "Dear A-17" is not a draft anyone can use.

### When the AI is unavailable

You get standard wording for that kind of decision, and it says so. It is short
and neutral, and you should edit it.

### One email per customer per two weeks

If an email was already prepared for that customer in the last 14 days, a second
one is refused and names the first. Two decisions on one account would otherwise
each produce their own note, and the customer would get two unrelated emails from
you in the same week.

You can override it. The button says **Write one anyway**.

### Common problems

| Problem | Why |
|---|---|
| "There is already an email for this customer" | The rule above. Open the other one, or override. |
| The draft is generic | The AI was unavailable and you have the standard wording. Try again later. |
| The draft mentions something wrong | Edit it. It is a draft. If it invented a fact, that is worth reporting. |

---

## Create a task

**What it does.** Records what needs doing, who is doing it, and by when.

**What it needs.** A title (prefilled from the recommendation), an owner from
your Settings list, and a date.

**What it produces.** An entry under "Actions taken", and — if the decision had
no owner or date — it sets them.

**Where it goes.** Nowhere. It lives inside this product, in the decision's
history. There is no Jira, Asana or Linear connection in this version.

**Marking a task done** also moves the decision to "In progress", because doing
something about a decision means it is in progress.

---

## Both

- An action can be **cancelled** with no consequence.
- Every action appears in the decision's history and in Activity.
- Actions never change a customer's data.
