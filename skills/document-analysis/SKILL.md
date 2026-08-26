---
name: document-analysis
description: Read and analyse PDFs, Word documents, text and Markdown files: extract specific information, summarise, compare documents, or pull fields out for reuse. Use when the user points at a document on disk.
---

# Document analysis

## Read it before answering

`document_read` handles PDF, DOCX, TXT and Markdown. For a long PDF, pass `maxPages` and read the section you need rather than the whole thing.

Output is truncated when large, and says so. If you see the truncation marker and the answer might be past it, read further — do not answer from the prefix and hope.

## Extracting specific fields

Quote the document for anything you report as its content. If a field is absent, say it is absent; documents routinely omit what you were asked to find, and inventing a plausible value is worse than reporting the gap.

Note the page number for anything important, so the user can check it.

## Scanned PDFs

If a PDF returns little or no text, it is probably a scan with no text layer. Say so — do not report an empty extraction as an empty document.

## Feeding a form

When filling a web form from a document: read the document first, list the field-to-value mapping, show the user that mapping, then fill. Do not read and type in the same step — that is where values end up in the wrong boxes.
