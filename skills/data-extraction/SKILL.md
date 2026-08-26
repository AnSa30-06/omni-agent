---
name: data-extraction
description: Pull structured records out of unstructured pages or documents — tables of items, lists of entries, fields from many sources — and validate them before they are used. Use when the output is a table, list or dataset rather than prose.
---

# Structured extraction

## Define the schema first

Name the fields, their types, and which are required, before you extract anything. Extracting first and imposing structure later produces records with fields that were never actually on the page.

## Extract per source, not in bulk

Take one source at a time and fill the schema from *that* source. Filling a field from a different page than the rest of the record is how a record ends up internally inconsistent and unciteable.

Every record carries the URL it came from.

## Validate before reporting

Run these checks and act on them:

- **Required fields present.** A missing required field is `null` plus a note, never a guess.
- **Types plausible.** Dates parse. Numbers are numbers. URLs are absolute and were actually fetched.
- **Duplicates collapsed.** Match on the underlying entity, not the URL.
- **Row count matches** what you claimed to have found.

Say explicitly how many records were complete and how many had gaps. A validated table of 8 beats an unvalidated table of 15.

## Output

`document_write` to `.csv` or `.xlsx` with one column per schema field plus `source_url`. Keep a `notes` column for anything uncertain rather than dropping the uncertainty.
