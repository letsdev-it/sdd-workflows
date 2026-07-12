# sdd-workflows

Public reusable GitHub workflows for the code-repository side of SDD.
Executable logic and prompts travel in versioned composite actions under
`actions/`; reusable YAML remains declarative.

| Workflow | Event in caller | Result |
|---|---|---|
| `sdd-task-link.yml` | `pull_request` | requires an open local issue link |
| `sdd-conformance.yml` | `pull_request` | runs separate conformance and task-fulfillment checks; writes freshness success |
| `sdd-invalidate.yml` | `repository_dispatch: sdd-spec-changed` | marks freshness error and automatically reruns each open PR's latest pull-request workflow |
| `sdd-clarification.yml` | `issue_comment` | forwards `/sdd clarify ...` and blocks the task |
| `sdd-task-done.yml` | `issues: closed` | accepts only a validated merged PR or approved supersede; reopens unauthorized closure |
| `sdd-drift-audit.yml` | schedule/manual | audits code vs binding `spec/` and creates deduplicated intake |

Conformance, task fulfillment, and drift load only the matched project's
binding `spec/`. Supporting `context/`, `backlog/`, and `decisions/` are not
authorization. A temporary flat-project fallback supports migration.

## Caller

Install this as `.github/workflows/sdd.yml` in each code repository:

```yaml
name: SDD
on:
  pull_request:
    types: [opened, edited, reopened, synchronize]
  issues:
    types: [closed]
  issue_comment:
    types: [created]
  repository_dispatch:
    types: [sdd-spec-changed]
  schedule:
    - cron: '23 3 * * 1'
  workflow_dispatch:

jobs:
  task-link:
    if: github.event_name == 'pull_request'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-task-link.yml@main
    permissions: { contents: read, issues: read, pull-requests: read }
  code-review:
    if: github.event_name == 'pull_request'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-conformance.yml@main
    secrets: inherit
    permissions: { contents: read, issues: read, pull-requests: read, statuses: write }
  invalidate:
    if: github.event_name == 'repository_dispatch'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-invalidate.yml@main
    permissions: { actions: write, pull-requests: read, statuses: write }
  clarification:
    if: github.event_name == 'issue_comment'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-clarification.yml@main
    secrets: inherit
    permissions: { contents: read, issues: write }
  task-done:
    if: github.event_name == 'issues'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-task-done.yml@main
    secrets: inherit
    permissions: { checks: read, contents: read, issues: write, pull-requests: read, statuses: read }
  drift-audit:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-drift-audit.yml@main
    secrets: inherit
    permissions: { contents: read, issues: read }
```

## Configuration

| Kind | Name | Meaning |
|---|---|---|
| variable | `SDD_SPEC_REPO` | authoritative spec repository, `owner/name` |
| variable | `SDD_APP_ID` | GitHub App id for cross-repository access |
| optional variable | `SDD_LLM_BASE_URL` | OpenAI-compatible endpoint |
| optional variable | `SDD_LLM_MODEL` | semantic model |
| secret | `SDD_APP_PRIVATE_KEY` | App private key |
| secret | `SDD_LLM_API_KEY` | conformance, fulfillment, and drift |
| optional secret | `SDD_TASKS_TOKEN` | PAT fallback |

Require `sdd-task-link`, `sdd-conformance`, `sdd-task-fulfillment`, and
`sdd-spec-freshness` on the protected branch. A spec change makes freshness
red for existing PRs and immediately queues a rerun of their latest completed
pull-request workflow. Successful review against current `spec/` restores it;
if no prior run can be rerun, the PR stays red and the invalidation job fails
closed with an actionable message.

Board fields, labels, and manual issue closure are not completion authority. An
`sdd:task` is terminal only when GitHub records a merged PR linking it and all
four required checks were successful, or when an accepted spec impact plan
contains the matching `supersede` operation. Any other closure is automatically
reopened and cannot close the umbrella.

The implementation executor is deliberately outside this repository. These
workflows consume and produce only GitHub-native tasks, comments, PR checks,
and intake issues; they do not generate code.
