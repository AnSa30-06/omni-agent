---
name: spreadsheet-analysis
description: Analyse CSV, TSV, XLSX and JSON data files: summary statistics, column profiling, finding patterns, answering questions about a dataset, and producing derived tables. Use whenever the user points at tabular data.
---

# Spreadsheet and data analysis

## Start with data_analyze, always

`data_analyze` is deterministic, runs locally, and **costs no model tokens**. It gives you row and column counts, per-column type, missing-value counts, distinct counts, min/max/mean/median/stdev for numeric columns and top values for text columns.

Reading a whole spreadsheet into the conversation to compute a mean is the single most wasteful thing you can do with a data file.

## Read the profile before trusting the data

The profile tells you what is wrong with the file:

- **Missing values** — decide explicitly whether to drop or keep those rows, and say which.
- **A "numeric" column typed as text** — currency symbols, thousands separators or stray units. Say so before averaging it.
- **`distinct` equal to row count** on a column you expected to repeat — probably an id, not a category.
- **`distinct` of 1** — a constant column, carrying no information.

## Computation

For anything beyond the profile, write a small script (Python or Node) and run it. Do not do arithmetic over many rows in your head — it is slower and it is wrong more often.

Show the script. The user should be able to re-run it.

## Output

Save derived tables with `document_write`. State the row count of every table you produce, and whether rows were dropped and why.
