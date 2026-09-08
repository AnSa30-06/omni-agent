# Importing your data

Decisions reads a **folder** containing up to six spreadsheet files, saved as
CSV. Only the first two are required.

The quickest way to start: **Settings > Data > Download blank templates**. That
writes all six files, with the right column names and one example row, into your
Downloads folder. Fill them in and import that folder.

---

## The files

### `accounts.csv` — required

One row per customer.

| Column | Required | What it is |
|---|---|---|
| `account_id` | yes | Your own id for the customer. Anything, as long as it is the same everywhere. |
| `name` | yes | What you call them. |
| `arr` | no | What they pay you a year, as a plain number. |
| `plan` | no | Starter, Team, Business, whatever you call them. |
| `seats_purchased` | no | How many seats they bought. |
| `renewal_date` | no | `2026-12-01`. |
| `owner` | no | Who looks after them. |
| `segment` | no | enterprise, mid-market, small business. |
| `industry` | no | Free text. |
| `created_at` | no | When they became a customer. Used to tell a new customer from a mature one. |

### `usage_daily.csv` — required

One row per customer per day. This is the file that matters most: almost every
signal is built from it.

| Column | Required | What it is |
|---|---|---|
| `account_id` | yes | Must match `accounts.csv`. |
| `day` | yes | `2026-09-01`. |
| `active_users` | no | How many of their people used the product that day. |
| `sessions` | no | How many sessions. |
| `seats_used` | no | How many distinct seats were used. |

**Send at least 60 days.** The signals compare the last 30 days with the 30
before, and need 20 days of data in each. Less than that and no usage signal is
produced at all, which is correct but not useful.

### `contacts.csv` — optional

| Column | Required | What it is |
|---|---|---|
| `contact_id` | yes | Your id for the person. |
| `account_id` | yes | Which customer. |
| `name` | no | Their name. Never sent to the AI. |
| `role` | no | Their job title. This IS sent to the AI, instead of their name. |
| `is_champion` | no | `true` for your main contact. Only champions are watched. |
| `last_active_at` | no | When they last did anything. |

### `tickets.csv` — optional

| Column | Required | What it is |
|---|---|---|
| `ticket_id` | yes | Your id. |
| `account_id` | yes | Which customer. |
| `opened_at` | yes | `2026-08-14`. |
| `closed_at` | no | Leave empty if it is still open. |
| `priority` | no | low, normal, high, urgent. An open urgent ticket makes a rise more serious. |
| `subject` | no | Only counted, never read or sent to the AI. |

### `invoices.csv` — optional

| Column | Required | What it is |
|---|---|---|
| `invoice_id` | yes | Your id. |
| `account_id` | yes | Which customer. |
| `due_at` | yes | When it was due. |
| `status` | yes | `paid`, `open` or `failed`. |
| `amount` | no | A plain number. |
| `attempts` | no | How many times the payment was tried. |
| `paid_at` | no | When it was paid. |

### `events.csv` — optional

| Column | Required | What it is |
|---|---|---|
| `event_id` | yes | Your id. |
| `account_id` | yes | Which customer. |
| `at` | yes | When. |
| `kind` | yes | One of `pricing_page_view`, `seat_limit_hit`, `champion_left`, `exec_meeting`. |
| `detail` | no | Free text. |

### `workspace.json` — optional

```json
{ "name": "My company", "currency": "USD", "seat_price_monthly": 25 }
```

`seat_price_monthly` is what lets it estimate what an expansion is worth.
Without it, expansion decisions say "not estimated" rather than guessing.

---

## Where to get each file

| File | Where it usually comes from |
|---|---|
| accounts | Your CRM (HubSpot, Salesforce), or your billing system. Export deals or companies with the renewal date and the annual value. |
| usage_daily | Your product database, or a product analytics tool (PostHog, Amplitude, Mixpanel). A daily rollup per account, not raw events. |
| contacts | Your CRM's contacts, with the last activity date. |
| tickets | Zendesk, Intercom, Freshdesk. Export the ticket list with dates. |
| invoices | Stripe. The invoices export has due date, status, amount and attempt count. |
| events | Whatever you have. This one is genuinely optional. |

There is no live connection to any of these in this version. You export, you
import. See [Limitations](limitations.md).

---

## Rules the importer follows

- **Dates are `YYYY-MM-DD`.** `2026-09-01`, or a full timestamp. `01/09/2026` is
  rejected because it is ambiguous.
- **Numbers are plain.** `50000`, not `$50,000` — though currency symbols and
  commas are stripped where they appear.
- **`true`/`false`** for yes-or-no columns. `yes` and `1` also work.
- **Extra columns are ignored.** Export more than you need; nothing else is
  stored.
- **A missing required column stops the import** and names the column.
- **A bad row is rejected and counted**, and the reason is shown. It is never
  guessed at or turned into a zero.
- **A row whose `account_id` is not in `accounts.csv` is rejected.** Import the
  accounts file that goes with your other files.
- **A duplicate id keeps the last row**, and says how many there were.
- **A byte-order mark** (what Excel puts at the start of a CSV) is handled.

---

## The import report

After every import you get a table: rows read, rows used, rows rejected, and the
reason for each rejection with a count.

**Read it.** An import that says "12,000 read, 400 used" is telling you something
important about your export, not about this product.

A copy of every file you imported, and the report, is kept in your workspace
folder under `imports/`. The path is shown in Settings.

---

## Importing again

Importing replaces all the customer data. Your decisions, their history, your
notes and your recorded outcomes are kept.

That is what you want: import fresh data every week, run the analysis, and the
decisions you were already working on carry on.
