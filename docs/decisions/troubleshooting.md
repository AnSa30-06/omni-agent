# Troubleshooting

---

## "No decisions after a run"

That is often the right answer. The rules need several things to move together,
so a set of customers where nothing much changed produces nothing.

Check, in order:

1. **Customers page.** Does everyone show a state? If everyone is "Healthy",
   nothing is wrong — nothing changed.
2. **Look at one customer.** The "Signals in the last analysis" panel shows what
   was found. If it is empty, the problem is the data, not the rules.
3. **Is there enough usage data?** Signals compare the last 30 days with the 30
   before, and need 20 days of rows in each. With 30 days of data in total, no
   usage signal can be produced.
4. **Is your data current?** If the customer page says "the usage data is out of
   date", your export stopped early. The usage signals are deliberately not acted
   on in that state.
5. **Lower a threshold.** Settings > Analysis. Try usage down 15% instead of 25%
   and run again.

## "The AI could not explain this one"

The decision is still real. The evidence and the money were computed by the
software; only the written explanation is missing.

Causes, most likely first:

- **The free model was busy.** Click **Try the AI again** on the decision.
- **No provider key.** Vireo's free model pool is small and slow. Adding one
  free key fixes most of this: open Vireo, go to **Free capacity**, pick a
  provider, paste a key.
- **The model kept producing invalid answers.** It gets one retry with the
  problem explained, then the product stops rather than spending your allowance
  in a loop.

Activity shows how many model calls failed on each run.

## "The analysis is stuck"

Free models can take a minute or more per decision. The progress line tells you
which part it is on.

If it has been more than five minutes:

- Check the gateway is running: `vireo doctor`.
- Run without the AI to confirm everything else works:
  ```bash
  vireo decisions run --no-model
  ```
  If that finishes quickly, the problem is the model, not the data.
- A run that crashed leaves a lock that clears itself after ten minutes.

## "The import was refused"

The message names the file and the column. The most common causes:

| Message | What to do |
|---|---|
| `... is missing the column X` | Your export does not have that column, or it is spelled differently. Column names are matched exactly, lower-case. |
| `usage_daily.csv is required` | Both `accounts.csv` and `usage_daily.csv` must exist. |
| `... is not a folder` | Point at the folder containing the files, not at a file. |

## "It read 12,000 rows and used 400"

Open the report and read the rejection reasons. Almost always one of:

- **`account_id is not in accounts.csv`** — your usage file covers customers your
  accounts file does not. Export them together.
- **`day is not a date`** — dates must be `2026-09-01`. `01/09/2026` is rejected
  because nobody can tell if that is January or September.
- **`arr is not a number`** — a column with text in it, or a merged cell.

## "The same decision keeps coming back"

It should not. One open decision per customer per kind, enforced by the database.

- If you **dismissed** it and it came back, the situation got **worse** than when
  you dismissed it. That is deliberate.
- If you **resolved** it and it came back, the situation is genuinely new since
  you closed it.
- A decision that is still open is updated in place, never duplicated.

## "The numbers look wrong"

Every number traces to a row you imported.

1. Open the decision and read **Everything we looked at**. Each line says what
   was measured and what the rule's threshold is.
2. Open the customer page and check **The data behind this**: how many usage
   rows, and the last day of data.
3. If the last day is old, you are looking at old numbers. In demo mode, "today"
   is a frozen date shown in the top bar.

## "Today is the wrong date"

You are in demo mode. Settings > Demo mode, and turn it off.

## "It is slow"

The rules are fast — 48 customers takes well under a second. All the time is the
AI.

- Lower **how many decisions the AI explains per run** in Settings.
- Add a provider key.
- Run with `--no-model` when you only want the detection.

## "I deleted the wrong workspace"

There is no recovery. Deleting a workspace deletes its data.

Your imported spreadsheets are still wherever you exported them from, so you can
re-import. The decisions and outcomes are gone.

## Where to look next

- **Activity** shows every run: how many customers, how many model calls, how
  many failed, and which model answered.
- Logs are in `%LOCALAPPDATA%\Vireo\logs\`.
- `vireo doctor` checks the gateway, the models and the network with real
  requests.
- `vireo diagnostics` writes a report with secrets stripped, for a bug
  report.
