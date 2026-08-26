---
name: github
description: Git and GitHub workflows: inspecting history, branching, committing, pull requests and issues. Use when the user mentions git, GitHub, commits, branches, PRs or issues.
---

# Git and GitHub

## Look before you act

`git status` and `git diff` before anything that changes state. Know what is staged, what is not, and what branch you are on.

Never commit or push unless the user asked. If you are on the default branch and about to commit, branch first.

## Commits

One logical change per commit. A message that says *why*, not a restatement of the diff.

Do not commit build output, dependency directories, local config, or anything under a data or cache directory. Check `.gitignore` covers them.

## Before any push

**Scan for secrets.** API keys, tokens, `.env` files, credential stores. A pushed secret is a rotated secret, not a deleted one — removing the file does not remove it from history.

## Destructive operations

`push --force`, `reset --hard` and `clean -fd` destroy work that may not exist anywhere else. Confirm with the user, and prefer the safer form (`--force-with-lease`) where one exists.

## GitHub

Use the `gh` CLI. For a PR: state what changed and why, and what you tested. Link the issue it closes.
