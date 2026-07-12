const { validatedMergedPullRequest } = require('./task-done');

module.exports = async ({ github, context, core }) => {
  const task = context.payload.issue;
  if (!task || context.payload.action !== 'closed' || task.state_reason === 'not_planned') return;
  const { owner, repo } = context.repo;
  const [specOwner, specRepo] = String(process.env.SPEC_REPO || '').split('/');
  const backlink = specOwner && specRepo
    && new RegExp(`(?:Spec|Intake):\\s*${specOwner}/${specRepo}#\\d+`, 'i').test(task.body || '');
  if (!backlink) return;
  const authorization = await validatedMergedPullRequest({ github, owner, repo, task });
  if (!authorization) {
    await github.rest.issues.update({ owner, repo, issue_number: task.number, state: 'open' });
    await github.rest.issues.createComment({
      owner, repo, issue_number: task.number,
      body: '<!-- sdd:unauthorized-terminal -->\nThis task was reopened: its closing PR does not have current successful task-link, conformance, fulfillment, and spec-freshness evidence.',
    });
    core.setFailed(`Reopened unauthorized closure of ${owner}/${repo}#${task.number}.`);
    return;
  }
  core.setOutput('authorization', JSON.stringify(authorization));
};
