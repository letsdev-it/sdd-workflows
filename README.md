# sdd-workflows

Reusable GitHub workflows for spec-driven development.

| Workflow | Called on | Does |
|---|---|---|
| `sdd-task-link.yml` | `pull_request` | every PR must reference an open issue in the same repo |
| `sdd-conformance.yml` | `pull_request` | LLM judges the diff against the project's product spec: `conforms` / `beyond_spec` / `against_spec` (the last two fail), plus a non-blocking tech-spec advisory |
| `sdd-task-done.yml` | `issues: [closed]` | when a generated task closes, comments on its umbrella issue in the spec repo and closes the umbrella after the last open task, propagating the close reason |

## Usage

`.github/workflows/sdd.yml` in the calling repo:

```yaml
name: SDD
on:
  pull_request:
    types: [opened, edited, reopened, synchronize]
  issues:
    types: [closed]
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
  task-done:
    if: github.event_name == 'issues'
    uses: letsdev-it/sdd-workflows/.github/workflows/sdd-task-done.yml@main
    secrets: inherit
    permissions: { contents: read, issues: read }
```

Configuration in the calling repo:

| Kind | Name | Meaning |
|---|---|---|
| variable | `SDD_SPEC_REPO` | spec repo (`owner/name`) — used by conformance and task-done; can also be passed as the `spec_repo` input |
| variable | `SDD_APP_ID` | GitHub App id used to mint the cross-repo token (optional; falls back to `SDD_TASKS_TOKEN`) |
| secret | `SDD_APP_PRIVATE_KEY` | the App's private key |
| secret | `SDD_LLM_API_KEY` | key for the OpenAI-compatible endpoint used by conformance |

Conformance and task-done read the spec repo cross-repo, so the default
workflow token is not enough.
