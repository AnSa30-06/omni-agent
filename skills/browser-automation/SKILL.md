---
name: browser-automation
description: Drive a real browser: fill web forms, log in, navigate JavaScript applications, download files, extract data that only appears after interaction. Use whenever a task needs clicking or typing on a website rather than just reading it.
---

# Browser automation

## Snapshot, act, re-snapshot

The single most common failure is acting on a stale ref.

```
browser action=snapshot        -> every element gets [ref=eN]
browser action=type ref=e3 ... -> target by ref
browser action=snapshot        -> ALWAYS, after anything that changed the page
```

Navigation, submission, opening a modal, expanding a section — all invalidate refs. A ref that no longer exists gives you a clear error; a ref that now points at a *different* element does not. Re-snapshot.

## Filling a form

1. Snapshot. Read the field labels, types and `required` markers off the outline.
2. Fill fields one at a time.
3. **Snapshot again and read back the values.** The outline shows `value="..."` and `checked`. Confirm every field landed before going further. Date pickers, masked inputs and custom dropdowns silently reject `type` more often than plain text fields do.
4. Report the filled values to the user.
5. **Stop.** Do not submit.

## Submission

Filling and stopping is the correct default outcome.

Clicking a submit-shaped control returns `BLOCKED` unless you pass `confirmSubmit: true`. Only pass it after the user has authorised **that specific submission** in the conversation. Show them what will be sent first.

Never try to defeat a CAPTCHA, bot check, rate limit or access control. If one stops you, say so and hand back.

## When things go wrong

- **Element not found** — re-snapshot; the page moved.
- **Click did nothing** — the real control may be a parent or child of what you clicked. Look at the outline again.
- **Page looks empty** — content may load late. `action=wait` then snapshot.
- **A new tab opened** — `action=list_tabs`, then `select_tab`.

Close the browser when the task is finished.
