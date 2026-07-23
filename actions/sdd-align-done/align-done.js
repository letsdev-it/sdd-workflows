const { readWatermark, parseAlignMarker, isCommit, gitIn } = require('../lib/spec-context');

/**
 * Has the watermark reached this task's target?
 *
 * "Reached" means at or past: the executor may have merged the watermark bump
 * together with a spec state newer than the one the task promised, and that
 * still satisfies the goal.
 */
function watermarkReached({ offset, target, isAncestor }) {
  if (!offset || offset === '0' || !target) return false;
  if (offset === target) return true;
  return isAncestor(target, offset);
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const specRepo = process.env.SPEC_REPO;
  const offsetFile = process.env.OFFSET_FILE || '.sdd/spec-offset';
  if (!specRepo) { core.setFailed('SDD_SPEC_REPO is not configured.'); return; }
  const [specOwner, specName] = specRepo.split('/');

  const offset = readWatermark(offsetFile);
  if (offset === '0') {
    core.notice('Watermark is 0 — this repository has consumed nothing yet.');
    return;
  }
  if (!isCommit({ rev: offset })) {
    core.setFailed(`Watermark ${offset} is not a commit in ${specRepo}. Fix ${offsetFile}: it must hold a spec-repo commit sha.`);
    return;
  }

  const git = gitIn('spec-repo');
  const isAncestor = (ancestor, descendant) => {
    try { git('merge-base', '--is-ancestor', ancestor, descendant); return true; } catch { return false; }
  };

  const tasks = (await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, labels: 'sdd:align', state: 'open', per_page: 100,
  })).filter((issue) => !issue.pull_request);
  if (!tasks.length) {
    core.notice('No open alignment task — the watermark moved on its own.');
    return;
  }

  const summary = ['# SDD align-done', '', `Watermark: \`${offset.slice(0, 12)}\``, ''];
  for (const task of tasks) {
    const marker = parseAlignMarker(task.body);
    if (!marker) {
      core.warning(`#${task.number} carries no sdd:align marker — leaving it open.`);
      summary.push(`- #${task.number} left open (no marker)`);
      continue;
    }
    if (!watermarkReached({ offset, target: marker.to, isAncestor })) {
      core.notice(`#${task.number} targets ${marker.to.slice(0, 12)}, which the watermark has not reached yet.`);
      summary.push(`- #${task.number} still open (target \`${marker.to.slice(0, 12)}\`)`);
      continue;
    }

    await github.rest.issues.createComment({
      owner, repo, issue_number: task.number,
      body: `Watermark reached [\`${offset.slice(0, 12)}\`](https://github.com/${specRepo}/commit/${offset}) — this repository is aligned with its product spec. Closing.`,
    });
    await github.rest.issues.update({ owner, repo, issue_number: task.number, state: 'closed', state_reason: 'completed' });
    core.notice(`Closed alignment task #${task.number}.`);
    summary.push(`- #${task.number} closed`);

    for (const number of marker.umbrellas) {
      try {
        const { data: umbrella } = await github.rest.issues.get({ owner: specOwner, repo: specName, issue_number: number });
        if (umbrella.state !== 'open') { core.info(`${specRepo}#${number} is already closed.`); continue; }
        await github.rest.issues.createComment({
          owner: specOwner, repo: specName, issue_number: number,
          body: `\`${owner}/${repo}\` is now aligned with the spec state containing this change (watermark [\`${offset.slice(0, 12)}\`](https://github.com/${specRepo}/commit/${offset}), via ${task.html_url}). Closing — the contract is live in the code.`,
        });
        await github.rest.issues.update({ owner: specOwner, repo: specName, issue_number: number, state: 'closed', state_reason: 'completed' });
        core.notice(`Closed umbrella ${specRepo}#${number}.`);
        summary.push(`  - umbrella ${specRepo}#${number} closed`);
      } catch (error) {
        core.warning(`Cannot close umbrella ${specRepo}#${number}: ${error.message}`);
        summary.push(`  - umbrella ${specRepo}#${number} FAILED: ${error.message}`);
      }
    }
  }
  await core.summary.addRaw(summary.join('\n')).write();
};

module.exports.watermarkReached = watermarkReached;
