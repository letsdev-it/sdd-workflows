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

Configuration in the calling repo: `SDD_APP_ID` (variable),
`SDD_APP_PRIVATE_KEY` and `SDD_LLM_API_KEY` (secrets). Conformance and
task-done read the spec repo cross-repo, so the default workflow token is
not enough. The spec repo is set by the `spec_repo` input of conformance
and task-done.
