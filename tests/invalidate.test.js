const test = require('node:test');
const assert = require('node:assert/strict');
const invalidate = require('../actions/sdd-invalidate/invalidate');
const { selectPullRequestRun, selectSddPullRequestRun } = invalidate;

test('selects the newest completed pull-request run for the exact PR', () => {
  const selected = selectPullRequestRun([
    { id: 1, event: 'pull_request', status: 'completed', updated_at: '2026-01-01', pull_requests: [{ number: 7 }] },
    { id: 2, event: 'pull_request', status: 'in_progress', updated_at: '2026-01-03', pull_requests: [{ number: 7 }] },
    { id: 3, event: 'pull_request', status: 'completed', updated_at: '2026-01-02', pull_requests: [{ number: 7 }] },
    { id: 4, event: 'pull_request', status: 'completed', updated_at: '2026-01-04', pull_requests: [{ number: 8 }] },
  ], 7);
  assert.equal(selected.id, 3);
});

test('returns null when no completed PR run can be rerun', () => {
  assert.equal(selectPullRequestRun([
    { id: 1, event: 'push', status: 'completed', pull_requests: [{ number: 7 }] },
  ], 7), null);
});

test('selects only a workflow run containing both semantic SDD jobs', async () => {
  const github = {
    paginate: async (method, args) => method(args),
    rest: { actions: { listJobsForWorkflowRun: async ({ run_id: id }) => id === 2
      ? [{ name: 'code-review / sdd-conformance' }, { name: 'code-review / sdd-task-fulfillment' }]
      : [{ name: 'lint' }] } },
  };
  const runs = [
    { id: 1, event: 'pull_request', status: 'completed', updated_at: '2026-01-02', pull_requests: [{ number: 7 }] },
    { id: 2, event: 'pull_request', status: 'completed', updated_at: '2026-01-01', pull_requests: [{ number: 7 }] },
  ];
  assert.equal((await selectSddPullRequestRun(github, 'org', 'repo', runs, 7)).id, 2);
});

test('invalidates first and queues the original pull-request workflow', async () => {
  const calls = [];
  const github = {
    paginate: async (method) => method(),
    rest: {
      pulls: { list: async () => [{ number: 7, head: { sha: 'abc' } }] },
      repos: { createCommitStatus: async (args) => calls.push(['status', args.state, args.sha]) },
      actions: {
        listWorkflowRunsForRepo: async () => [{
          id: 42, event: 'pull_request', status: 'completed', updated_at: '2026-01-01',
          pull_requests: [{ number: 7 }],
        }],
        listJobsForWorkflowRun: async () => [
          { name: 'code-review / sdd-conformance' },
          { name: 'code-review / sdd-task-fulfillment' },
        ],
        reRunWorkflow: async (args) => calls.push(['rerun', args.run_id]),
      },
    },
  };
  const previous = process.env.EXPECTED_SPEC_REPO;
  process.env.EXPECTED_SPEC_REPO = 'org/specs';
  try {
    await invalidate({
      github,
      context: {
        eventName: 'repository_dispatch', repo: { owner: 'org', repo: 'code' },
        payload: { action: 'sdd-spec-changed', client_payload: { spec_repo: 'org/specs', spec_commit: 'def' } },
      },
      core: { notice() {}, setFailed(message) { throw new Error(message); } },
    });
  } finally {
    process.env.EXPECTED_SPEC_REPO = previous;
  }
  assert.deepEqual(calls, [['status', 'error', 'abc'], ['rerun', 42]]);
});
