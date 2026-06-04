# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `WestsideSage/Vocalz`
(https://github.com/WestsideSage/Vocalz). Use the `gh` CLI for all operations.

> **Prerequisite:** `gh` must be installed (https://cli.github.com) and authenticated
> (`gh auth login`). At setup time it was not yet installed on this machine — install it
> before the issue skills (`to-issues`, `triage`, `to-prd`) can file or read issues.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
