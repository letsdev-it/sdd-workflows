const { parseAlignMarker } = require('../lib/spec-context');

/**
 * Which umbrella should carry the question?
 *
 * An alignment range can span several contract changes, but the spec-side
 * drafter opens one PR per marked request — so fan-out here would produce
 * competing draft PRs for one question. The newest umbrella is chosen: it is
 * the most recent contract decision and the one a clarification most often
 * concerns.
 */
function targetUmbrella(marker) {
  if (!marker || !marker.umbrellas.length) return null;
  return marker.umbrellas[marker.umbrellas.length - 1];
}

module.exports = async ({ github, context, core }) => {
  if (context.eventName !== 'issue_comment' || context.payload.action !== 'created') return;
  const issue = context.payload.issue;
  const comment = context.payload.comment;
  if (!issue || issue.pull_request || !comment) return;
  const match = (comment.body || '').match(/^\/sdd\s+clarify\s+([\s\S]+)/i);
  if (!match) return;

  const { owner, repo } = context.repo;
  const labels = new Set((issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)));
  if (issue.state !== 'open' || !labels.has('sdd:align')) {
    core.setFailed('/sdd clarify applies only to an open sdd:align task.');
    return;
  }
  const specRepo = process.env.SPEC_REPO;
  if (!specRepo) { core.setFailed('SDD_SPEC_REPO is not configured.'); return; }
  const [specOwner, specName] = specRepo.split('/');

  const marker = parseAlignMarker(issue.body);
  const umbrella = targetUmbrella(marker);
  if (!umbrella) {
    core.setFailed(`This alignment task has no umbrella issue to carry the question — the spec changes it consumes were merged without a linked intake issue. File a spec-chore issue in ${specRepo} directly.`);
    return;
  }

  try {
    await github.rest.issues.createLabel({
      owner, repo, name: 'sdd:blocked-product', color: 'd93f0b',
      description: 'Blocked on an accepted product-spec decision',
    });
  } catch (error) { if (error.status !== 422) throw error; }
  await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: ['sdd:blocked-product'] });

  const question = match[1].trim();
  await github.rest.issues.createComment({
    owner: specOwner, repo: specName, issue_number: umbrella,
    body: [
      '<!-- sdd:clarification-request -->',
      `## Product clarification requested from ${owner}/${repo}#${issue.number}`,
      '', question, '',
      `Alignment target: \`${marker.to}\``,
      `Source comment: ${comment.html_url}`,
      `Requested by: @${comment.user.login}`,
    ].join('\n'),
  });
  await github.rest.issues.createComment({
    owner, repo, issue_number: issue.number,
    body: `Marked \`sdd:blocked-product\` and forwarded the question to ${specOwner}/${specName}#${umbrella}. Work stays on the existing branch — once the clarification merges it is simply part of the spec you are aligning to, and this task's target advances on the next align run.`,
  });
  core.notice(`Forwarded clarification to ${specRepo}#${umbrella}.`);
};

module.exports.targetUmbrella = targetUmbrella;
