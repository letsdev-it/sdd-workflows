const test = require('node:test');
const assert = require('node:assert/strict');
const {
  issueReference, extractPlan, latestCheckSucceeded, latestStatusSucceeded,
} = require('../actions/sdd-task-done/task-done');

test('recognizes only closing keywords, never a non-closing reference', () => {
  assert.equal(issueReference('Closes #12', 'org', 'repo', 12), true);
  assert.equal(issueReference('Fixes: https://github.com/org/repo/issues/12', 'org', 'repo', 12), true);
  assert.equal(issueReference('Closes #123', 'org', 'repo', 12), false);
  assert.equal(issueReference('Refs #12', 'org', 'repo', 12), false);
});

test('extracts an approved impact plan and rejects malformed JSON', () => {
  const plan = { verdict: 'pass', operations: [{ id: 'OP1', action: 'supersede' }] };
  assert.deepEqual(extractPlan(`<!-- sdd:spec-review-plan -->\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``), plan);
  assert.equal(extractPlan('<!-- sdd:spec-review-plan -->\n```json\n{bad}\n```'), null);
});

test('uses the newest matching check, so an old green cannot hide a new failure', () => {
  const checks = [
    { id: 1, name: 'code-review / sdd-conformance', conclusion: 'success', completed_at: '2026-01-01T10:00:00Z' },
    { id: 2, name: 'code-review / sdd-conformance', conclusion: 'failure', completed_at: '2026-01-01T11:00:00Z' },
  ];
  assert.equal(latestCheckSucceeded(checks, 'sdd-conformance'), false);
});

test('uses the newest freshness status, so invalidation overrides old green', () => {
  const statuses = [
    { context: 'sdd-spec-freshness', state: 'success', created_at: '2026-01-01T10:00:00Z' },
    { context: 'sdd-spec-freshness', state: 'error', created_at: '2026-01-01T11:00:00Z' },
  ];
  assert.equal(latestStatusSucceeded(statuses, 'sdd-spec-freshness'), false);
});
