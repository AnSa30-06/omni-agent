---
name: coding
description: Write, extend or refactor code in any language. Use when the user asks for a program, a script, a feature, or changes to existing code.
---

# Coding

## Read before writing

Look at the surrounding code first. Match its style, its naming, its error handling and its comment density, even where you would personally do it differently. Consistency is worth more than your preference.

## The smallest change that works

- No features that were not asked for.
- No abstraction for a single call site.
- No configurability nobody requested.
- No error handling for conditions that cannot occur.

If the implementation is much longer than the problem, rewrite it shorter.

## Verify, then claim

Run it. Run the tests. Report the actual output, including failures — a failing test reported honestly is worth far more than a passing claim that is not true.

If you cannot run it, say exactly that: "I could not execute this; here is what I would check."

## Cleaning up

Remove imports and variables that *your* change orphaned. Leave pre-existing dead code alone — mention it instead.

## For a non-technical user

Explain in the answer what the program does and how to run it. Keep the technical detail in the code and its comments.
