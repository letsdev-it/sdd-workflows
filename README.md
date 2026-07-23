# sdd-workflows

Public reusable GitHub workflows for spec-driven development — both sides of
the system. Executable logic and prompts travel in versioned composite actions
under `actions/`; reusable YAML remains declarative.

The spec repository **publishes**; each code repository **pulls**. Merging a
spec change appends a changelog entry, and that is the whole of the spec
repo's outbound behavior. Nothing in it names, reads or writes a code
repository. Each code repo holds a watermark, compares it with the published
changelog on its own schedule, and files its own work.

## Code-repository side

| Workflow | Event in caller | Result |
|---|---|---|
| `sdd-task-link.yml` | `pull_request` | requires an open local issue link |
| `sdd-conformance.yml` | `pull_request` | judges the diff against the current binding `spec/`: `conforms` / `beyond_spec` / `against_spec`. Non-blocking advisories: stale tech spec, watermark drift |
| `sdd-align.yml` | `schedule` / manual | watermark behind the published spec → file or refresh **one** goal-shaped `sdd:align` task. Exits before the model when aligned |
| `sdd-align-done.yml` | `push` on the watermark path | the watermark reached the task's target → close the task and the umbrella issues of the consumed range |
| `sdd-clarification.yml` | `issue_comment` | `/sdd clarify …` on an alignment task → blocks it and forwards the question to its umbrella |
| `sdd-drift-audit.yml` | schedule / manual | audits code against binding `spec/`; code bugs stay here, contract gaps become spec intake |

## Spec-repository side

| Workflow | Event in caller | Result |
|---|---|---|
| `sdd-triage.yml` | `issues`, `schedule` | `spec-feature` / `spec-chore` → branch `spec/<N>` + PR `Refs #N` |
| `sdd-spec-review.yml` | `pull_request` | blocking quality gate on the proposed contract |
| `sdd-changelog.yml` | `push` on `**/spec/**` | append `<project>/changelog/<date>-<sha>.md` and push it back |
| `sdd-clarification-draft.yml` | `issue_comment` | a marked clarification request → focused draft spec PR |

Conformance, alignment and drift load only the named project's binding
`spec/`. `context/`, `backlog/` and `decisions/` are not authorization.

## Alignment in one paragraph

`.sdd/spec-offset` in a code repo holds the spec-repo commit it is aligned to;
`0` means nothing consumed. Align compares it with the newest spec commit that
already has a changelog entry — taking the *entry* as the frontier removes the
race between a spec merge and the commit recording it. When they match the job
exits without calling the model. Otherwise it feeds the entries in range (the
index of what moved) plus the **full current spec** (the source of truth) to
the model and files one goal-shaped task. The task never decomposes the work:
whoever picks it up reads the code, which every component producing the task is
blind to. Done is the watermark moving, so an alignment may span any number of
PRs with no `Closes` bookkeeping.

Both the range and the target walk `--first-parent`, so a watermark must sit on
that path. Seed it with the **merge commit** of the spec PR; a sha from the
branch side of a merge is reachable but not on the path, and the repository
would read as one change behind forever.

## Caller — code repository

`.github/workflows/sdd.yml`:

```yaml
name: SDD
on:
  pull_request:
    types: [opened, edited, reopened, synchronize]
  push:
    branches: [main]
    paths: ['.sdd/spec-offset']
  issue_comment:
    types: [created]
  schedule:
    - cron: '11 6 * * *'      # stagger per repo
  workflow_dispatch:

jobs:
  task-link:
    if: github.event_name == 'pull_request'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-task-link.yml@main
    permissions: { contents: read, issues: read, pull-requests: read }
  conformance:
    if: github.event_name == 'pull_request'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-conformance.yml@main
    secrets: inherit
    permissions: { contents: read, issues: read, pull-requests: read }
  align:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-align.yml@main
    secrets: inherit
    permissions: { contents: read, issues: write }
  align-done:
    if: github.event_name == 'push'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-align-done.yml@main
    secrets: inherit
    permissions: { contents: read, issues: write }
  clarification:
    if: github.event_name == 'issue_comment'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-clarification.yml@main
    secrets: inherit
    permissions: { contents: read, issues: write }
```

Add `sdd-drift-audit.yml` on a slower schedule when you want the safety net.

## Configuration

| Kind | Name | Meaning | Needed by |
|---|---|---|---|
| variable | `SDD_SPEC_REPO` | authoritative spec repository, `owner/name` | code repos |
| variable | `SDD_SPEC_PROJECT` | project directory inside it | code repos |
| variable | `SDD_APP_ID` | GitHub App id for cross-repository access | both |
| optional variable | `SDD_LLM_BASE_URL` | OpenAI-compatible endpoint | both |
| optional variable | `SDD_LLM_MODEL` | semantic model | both |
| secret | `SDD_APP_PRIVATE_KEY` | App private key | both |
| secret | `SDD_LLM_API_KEY` | conformance, alignment, review, drift | both |
| optional secret | `SDD_TASKS_TOKEN` | PAT fallback | both |

`SDD_SPEC_PROJECT` is what makes a code repo identifiable to the pipeline. The
spec repo holds no mapping back to it — that lookup used to be the last place a
code repo's identity was written down inside the spec repo.

Spec-side workflows mint a token scoped to the spec repository alone; they have
no reason to reach outside it. Code repos need read on the spec repo, write on
themselves, and issue-write on the spec repo for umbrella closing and intake.

Require `sdd-task-link` and `sdd-conformance` on the protected branch.

## What alignment is *not*

Conformance never asks whether the work is finished — partial implementation
conforms, because a repository catches up over many PRs. Completeness is the
watermark's business, and only the watermark's. Board fields, labels and manual
issue closure carry no authority either: closing an alignment task by hand
achieves nothing, because the next align run reopens the question while the
watermark still disagrees.

Silence is not alignment. GitHub disables scheduled workflows in repositories
with no activity for 60 days — exactly the quiet repo where drift goes
unnoticed — so a repo that stops reporting looks identical to one that is up to
date. Only watermark surveillance from outside can tell them apart.

## Tests

```sh
node --test tests/*.test.js
```

The implementation executor is deliberately outside this repository. These
workflows consume and produce only GitHub-native issues, comments, PR checks
and intake; they do not generate code.
