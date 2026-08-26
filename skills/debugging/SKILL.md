---
name: debugging
description: Diagnose why code, a script or a tool is failing. Use when something errors, produces the wrong result, or behaves inconsistently.
---

# Debugging

## Reproduce first

You cannot fix what you have not seen fail. Get the actual error text and the actual command. A described symptom is a hypothesis; a reproduction is evidence.

## Read the whole error

The first line names the symptom. The stack trace names the location. The lines *above* the error often name the cause. People skip those.

## Narrow before theorising

Bisect: what is the smallest input that still fails? What is the last version that worked? Which half of the pipeline still produces the right value?

Print the actual values at the boundary. Assumptions about what a variable contains are the usual culprit — especially "it returned an object" when it returned a promise, or "it's a number" when it's a numeric string.

## Beware the check that passes on a broken system

A test that passes because it never ran, a health check that returns 200 from a cached page, a mock that answers the question the real thing would fail. When a result seems to clear something you expected to be broken, verify the check itself actually exercised the thing.

## Fix the cause

A fix that makes the symptom disappear without explaining it is a fix you will pay for again. If you genuinely cannot find the cause and must work around it, say so and mark it in the code.

Then re-run the reproduction and show it passing.
