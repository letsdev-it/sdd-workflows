# sdd-workflows

Reusable GitHub workflows of the SDD machinery (spec-driven development,
see `letsdev-it/sdd-specs` → `SDD_PLAN.md` — private) — the three that
CODE repos call on their own events:

| Workflow | Called on | Does |
|---|---|---|
| `sdd-task-link.yml` | `pull_request` | stage-1 linkage: every PR must reference an open issue in the same repo |
| `sdd-conformance.yml` | `pull_request` | stage-2: LLM judges the diff against the CURRENT product spec (conforms / beyond_spec / against_spec) + non-blocking tech-spec advisory |
| `sdd-task-done.yml` | `issues: [closed]` | umbrella bookkeeping: comments on the spec-repo umbrella, closes it after the project's last open task, propagating the close reason |

## Why a separate public repo

GitHub does not let a **public** repo call reusable workflows hosted in a
**private** one (`access_level: organization` covers private repos only).
The rest of the machinery lives in the private spec repo and operates on
it directly; these three run in code repos — public ones included — so
they live here. They contain no secrets: callers pass credentials
(`secrets: inherit`), and the runtime reads the private spec repo via the
org GitHub App token, which works fine from a public caller.

## Wiring a code repo

`.github/workflows/sdd.yml`:

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

Plus per repo: `SDD_APP_ID` (variable), `SDD_APP_PRIVATE_KEY` and
`SDD_LLM_API_KEY` (secrets), the org App installed, labels via the spec
repo's `sdd-repo-setup.yml`. Full ops docs: `sdd-specs/.github/README.md`
(private).
