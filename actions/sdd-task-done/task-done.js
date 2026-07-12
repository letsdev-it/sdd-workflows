const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TERMINAL_MARKER = '<!-- sdd:authorized-terminal ';

function issueReference(text, owner, repo, number) {
  const escaped = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[\\s:]+(?:#${number}(?!\\d)|https://github\\.com/${escaped}/issues/${number}(?!\\d))`, 'i').test(text || '');
}

function extractPlan(body) {
  const match = String(body || '').match(/<!-- sdd:spec-review-plan -->[\s\S]*?```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function latestCheckSucceeded(checks, token) {
  const matching = checks.filter((check) => check.name.toLowerCase().includes(token));
  matching.sort((a, b) => {
    const right = new Date(b.completed_at || b.started_at || 0).getTime();
    const left = new Date(a.completed_at || a.started_at || 0).getTime();
    return right - left || Number(b.id || 0) - Number(a.id || 0);
  });
  return matching[0]?.conclusion === 'success';
}

function latestStatusSucceeded(statuses, context) {
  const matching = statuses.filter((status) => status.context === context);
  matching.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return matching[0]?.state === 'success';
}

async function approvedSupersede({ github, specOwner, specRepo, codeOwner, codeRepo, task }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: codeOwner, repo: codeRepo, issue_number: task.number, per_page: 100,
  });
  for (const comment of comments) {
    const marker = (comment.body || '').match(new RegExp(`<!-- sdd:operation ${specOwner}/${specRepo}@([0-9a-f]{40})/([^\\s]+) -->`, 'i'));
    if (!marker) continue;
    const [, mergeSha, operationId] = marker;
    const { data: prs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: specOwner, repo: specRepo, commit_sha: mergeSha,
    });
    for (const pr of prs.filter((item) => item.merged_at && item.merge_commit_sha === mergeSha)) {
      const planComments = await github.paginate(github.rest.issues.listComments, {
        owner: specOwner, repo: specRepo, issue_number: pr.number, per_page: 100,
      });
      const plan = planComments.map((item) => extractPlan(item.body)).find(Boolean);
      if (!plan || plan.verdict !== 'pass' || plan.reviewed_head_sha !== pr.head.sha) continue;
      const operation = (plan.operations || []).find((item) => item.id === operationId);
      if (operation?.action === 'supersede'
        && String(operation.repo).toLowerCase() === `${codeOwner}/${codeRepo}`.toLowerCase()
        && operation.number === task.number) {
        return { kind: 'superseded', evidence: `${pr.html_url} / ${mergeSha} / ${operationId}` };
      }
    }
  }
  return null;
}

async function validatedMergedPullRequest({ github, owner, repo, task }) {
  const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
    owner, repo, issue_number: task.number, per_page: 100,
  });
  const closure = [...events].reverse().find((event) => event.event === 'closed');
  if (!closure) return null;
  const candidates = events.filter((event) => event.event === 'cross-referenced' && event.source?.issue?.pull_request);
  for (const event of candidates) {
    const number = Number(String(event.source.issue.html_url || '').match(/\/pull\/(\d+)$/)?.[1]);
    if (!number) continue;
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    const mergeDistance = pr.merged_at
      ? new Date(closure.created_at).getTime() - new Date(pr.merged_at).getTime()
      : Number.POSITIVE_INFINITY;
    if (mergeDistance < 0 || mergeDistance > 5 * 60 * 1000
      || !issueReference(`${pr.title}\n${pr.body || ''}`, owner, repo, task.number)) continue;
    const { data: checks } = await github.rest.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 100 });
    const { data: statuses } = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha });
    const fresh = latestStatusSucceeded(statuses.statuses, 'sdd-spec-freshness');
    if (latestCheckSucceeded(checks.check_runs, 'sdd-task-link')
      && latestCheckSucceeded(checks.check_runs, 'sdd-conformance')
      && latestCheckSucceeded(checks.check_runs, 'sdd-task-fulfillment')
      && fresh) {
      return { kind: 'completed', evidence: `${pr.html_url} / ${pr.head.sha}` };
    }
  }
  return null;
}

async function authorizeTerminal(args) {
  const supersede = args.task.state_reason === 'not_planned'
    ? await approvedSupersede({
      github: args.github, specOwner: args.specOwner, specRepo: args.specRepo,
      codeOwner: args.owner, codeRepo: args.repo, task: args.task,
    })
    : null;
  return supersede || validatedMergedPullRequest(args);
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const task = context.payload.issue;
  if (!task || context.payload.action !== 'closed') return;
  const [specOwner, specRepo] = process.env.SPEC_REPO.split('/');
  const ref = (task.body || '').match(new RegExp(`(?:Spec|Intake):\\s*${specOwner}/${specRepo}#(\\d+)`, 'i'));
  if (!ref) {
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner, repo, issue_number: task.number, per_page: 100,
    });
    const wasSddTask = (task.labels || []).some((label) => label.name === 'sdd:task')
      || events.some((event) => event.event === 'labeled' && event.label?.name === 'sdd:task');
    if (wasSddTask) {
      await github.rest.issues.update({ owner, repo, issue_number: task.number, state: 'open' });
      core.setFailed(`Reopened SDD task #${task.number}: its required umbrella backlink is missing.`);
    } else {
      core.info(`#${task.number} has no SDD identity; it is outside this lifecycle.`);
    }
    return;
  }

  let localAuthorization = null;
  try { localAuthorization = JSON.parse(process.env.LOCAL_AUTHORIZATION || 'null'); } catch { /* fail below */ }
  const authorization = localAuthorization
    || await authorizeTerminal({ github, owner, repo, task, specOwner, specRepo });
  if (!authorization) {
    await github.rest.issues.update({ owner, repo, issue_number: task.number, state: 'open' });
    await github.rest.issues.createComment({ owner, repo, issue_number: task.number, body: [
      '<!-- sdd:unauthorized-terminal -->',
      'This SDD task was reopened because its closure had no authorized terminal evidence.', '',
      'A task may finish only through:',
      '- a merged PR linking this task, with successful task-link, conformance, fulfillment, and spec-freshness checks; or',
      '- an approved `supersede` operation from a merged spec impact plan.', '',
      'Board status, a manual issue close, labels, or an implementation agent declaration are not completion authority.',
    ].join('\n') });
    core.setFailed(`Reopened unauthorized closure of ${owner}/${repo}#${task.number}.`);
    return;
  }

  const terminalBody = `${TERMINAL_MARKER}${authorization.kind} -->\nAuthorized terminal evidence: ${authorization.evidence}`;
  const currentComments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: task.number, per_page: 100,
  });
  if (!currentComments.some((comment) => (comment.body || '').includes(`${TERMINAL_MARKER}${authorization.kind}`))) {
    await github.rest.issues.createComment({ owner, repo, issue_number: task.number, body: terminalBody });
  }

  const umbrellaNumber = Number(ref[1]);
  const refRe = new RegExp(`(?:Spec|Intake):\\s*${specOwner}/${specRepo}#${umbrellaNumber}(?!\\d)`, 'i');
  const git = (...args) => execFileSync('git', ['-C', 'spec-repo', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const slugOf = (url) => {
    const match = String(url).match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  };
  let siblings = [`${owner}/${repo}`];
  for (const manifestPath of git('ls-files').split('\n').filter((file) => path.basename(file) === 'zoltan.json')) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join('spec-repo', manifestPath), 'utf8'));
      const slugs = (manifest.repos || []).map((item) => slugOf(item.url)).filter(Boolean);
      if (slugs.some((slug) => slug.toLowerCase() === `${owner}/${repo}`.toLowerCase())) { siblings = slugs; break; }
    } catch { /* invalid unrelated manifest */ }
  }

  const remaining = [];
  for (const slug of siblings) {
    const [siblingOwner, siblingRepo] = slug.split('/');
    try {
      const issues = await github.paginate(github.rest.issues.listForRepo, {
        owner: siblingOwner, repo: siblingRepo, state: 'all', per_page: 100,
      });
      for (const sibling of issues.filter((item) => !item.pull_request && refRe.test(item.body || ''))) {
        if (sibling.state === 'open') { remaining.push(sibling.html_url); continue; }
        const siblingAuthorization = siblingOwner === owner && siblingRepo === repo && sibling.number === task.number
          ? authorization
          : await authorizeTerminal({
            github, owner: siblingOwner, repo: siblingRepo, task: sibling, specOwner, specRepo,
          });
        if (!siblingAuthorization) {
          remaining.push(`${sibling.html_url} (closed, terminal authorization pending)`);
        }
      }
    } catch (error) {
      core.warning(`Cannot validate tasks in ${slug} (${error.message}); umbrella remains open.`);
      remaining.push(`(unreadable: ${slug})`);
    }
  }

  const { data: umbrella } = await github.rest.issues.get({ owner: specOwner, repo: specRepo, issue_number: umbrellaNumber });
  if (umbrella.state !== 'open') return;
  const done = `Task ${task.html_url} reached authorized **${authorization.kind}** state (${authorization.evidence}).`;
  if (remaining.length) {
    await github.rest.issues.createComment({ owner: specOwner, repo: specRepo, issue_number: umbrellaNumber,
      body: `${done}\nRemaining or unverified tasks: ${remaining.length}\n${remaining.map((item) => `- ${item}`).join('\n')}` });
    return;
  }
  const notPlanned = authorization.kind === 'superseded';
  await github.rest.issues.createComment({ owner: specOwner, repo: specRepo, issue_number: umbrellaNumber,
    body: `${done}\nAll generated tasks have authorized terminal evidence — closing as ${notPlanned ? '**not planned**' : '**completed**'}.` });
  await github.rest.issues.update({ owner: specOwner, repo: specRepo, issue_number: umbrellaNumber,
    state: 'closed', state_reason: notPlanned ? 'not_planned' : 'completed' });
};

module.exports.issueReference = issueReference;
module.exports.extractPlan = extractPlan;
module.exports.authorizeTerminal = authorizeTerminal;
module.exports.latestCheckSucceeded = latestCheckSucceeded;
module.exports.latestStatusSucceeded = latestStatusSucceeded;
module.exports.validatedMergedPullRequest = validatedMergedPullRequest;
