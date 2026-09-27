# Issue tracker

Issues and specs live in this repo's GitHub Issues. Use `gh` from this checkout so it selects the repository from `origin`.

## Issue operations

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue and its comments with `gh issue view <number> --comments`. Fetch labels when triaging.
- List issues with `gh issue list --state open`; add state and label filters as needed.
- Comment with `gh issue comment <number> --body "..."`.
- Change labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue with `gh issue close <number> --comment "..."`.

When a skill says "publish to the issue tracker," create a GitHub issue. When it says "fetch the relevant ticket," read the corresponding issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If changed to `yes`, triage external PRs with `gh pr` commands and inspect their diffs. GitHub shares issue and PR numbers; check the item type before acting on a bare `#<number>`.

## Wayfinding

Use one issue as the map and link its tickets as GitHub sub-issues. If sub-issues are unavailable, list tickets in the map and put `Part of #<map>` in each ticket. Use native issue dependencies for blockers; if unavailable, put `Blocked by: #<number>` at the top of each blocked issue. Claim a ready ticket with `gh issue edit <number> --add-assignee @me`. Record the decision in the ticket and link it from the map before closing it.
