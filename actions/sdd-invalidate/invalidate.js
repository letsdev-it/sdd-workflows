function selectPullRequestRun(runs, pullNumber) {
  return runs
    .filter((run) => run.event === 'pull_request' && run.status === 'completed')
    .filter((run) => (run.pull_requests || []).some((pr) => pr.number === pullNumber))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0] || null;
}

module.exports = async ({ github, context, core }) => {
  const payload = context.payload.client_payload || {};
  if (context.eventName !== 'repository_dispatch' || context.payload.action !== 'sdd-spec-changed') {
    core.setFailed('sdd-invalidate must run for repository_dispatch type sdd-spec-changed.');
    return;
  }
  if (!process.env.EXPECTED_SPEC_REPO || payload.spec_repo !== process.env.EXPECTED_SPEC_REPO) {
    core.setFailed(`Rejected spec-change event from ${payload.spec_repo || '(missing)'}.`);
    return;
  }

  const { owner, repo } = context.repo;
  const prs = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', per_page: 100,
  });
  const failures = [];
  for (const pr of prs) {
    await github.rest.repos.createCommitStatus({
      owner, repo, sha: pr.head.sha, state: 'error', context: 'sdd-spec-freshness',
      description: `Spec changed to ${String(payload.spec_tree_sha || payload.spec_commit || '').slice(0, 12)}; automatic review queued`,
      target_url: payload.spec_commit_url || undefined,
    });

    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
      owner, repo, event: 'pull_request', head_sha: pr.head.sha, per_page: 100,
    });
    const previous = selectPullRequestRun(runs, pr.number);
    if (!previous) {
      failures.push(`#${pr.number}: no completed pull-request workflow run to rerun`);
      continue;
    }
    try {
      await github.rest.actions.reRunWorkflow({ owner, repo, run_id: previous.id });
      core.notice(`PR #${pr.number}: freshness invalidated; rerunning workflow ${previous.name} (${previous.id}).`);
    } catch (error) {
      failures.push(`#${pr.number}: cannot rerun ${previous.id} (${error.message})`);
    }
  }

  if (failures.length) {
    core.setFailed([
      `Freshness was invalidated, but automatic revalidation could not start for ${failures.length} PR(s):`,
      ...failures,
      'The affected PRs remain safely blocked and may be rerun manually after fixing workflow permissions/history.',
    ].join('\n'));
    return;
  }
  core.notice(`Invalidated and queued automatic revalidation for ${prs.length} open PR(s).`);
};

module.exports.selectPullRequestRun = selectPullRequestRun;
