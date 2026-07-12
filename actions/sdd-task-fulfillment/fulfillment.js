module.exports = async ({ github, context, core }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadSpecContext, linkedIssueNumbers } = require('../lib/spec-context');
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) { core.setFailed('sdd-task-fulfillment requires a pull_request event.'); return; }
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set.'); return; }

  const specRepo = process.env.SPEC_REPO;
  const project = loadSpecContext({ owner, repo });
  if (!project) {
    core.notice(`${owner}/${repo} is not registered in ${specRepo}; task fulfillment does not apply.`);
    return;
  }

  const tasks = [];
  for (const number of linkedIssueNumbers(pr)) {
    try {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
      const labels = new Set((issue.labels || []).map((label) => typeof label === 'string' ? label : label.name));
      if (!issue.pull_request && issue.state === 'open' && labels.has('sdd:task')) {
        tasks.push({ number, title: issue.title, body: issue.body || '' });
      }
    } catch { /* rejected by the explicit check below */ }
  }
  if (!tasks.length) {
    core.setFailed('The PR must link at least one open issue labeled sdd:task; use `Closes #N`.');
    return;
  }

  const { data: diff } = await github.rest.pulls.get({
    owner, repo, pull_number: pr.number, mediaType: { format: 'diff' },
  });
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });
  const prompt = fs.readFileSync(path.join(__dirname, 'prompts', 'fulfillment.md'), 'utf8');
  const user = [
    `CURRENT PRODUCT SPEC (tree ${project.treeSha}):`, project.spec || '(empty)',
    '', `PR #${pr.number}: ${pr.title}`, pr.body || '',
    '', 'LINKED SDD TASKS:',
    ...tasks.map((task) => `#${task.number} ${task.title}\n${task.body}`),
    '', 'CHANGED FILES:', files.map((file) => `${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`).join('\n'),
    '', 'DIFF:', '```diff', String(diff).slice(0, 50000), '```',
  ].join('\n');
  const response = await fetch(`${(process.env.LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0, messages: [
      { role: 'system', content: prompt }, { role: 'user', content: user },
    ] }),
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  const content = (await response.json()).choices?.[0]?.message?.content || '';
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in fulfillment response: ${content.slice(0, 500)}`);
  const result = JSON.parse(content.slice(start, end + 1));
  const expected = new Set(tasks.map((task) => task.number));
  const assessed = new Set((result.tasks || []).map((task) => task.number));
  const malformed = !['complete', 'incomplete', 'wrong_scope'].includes(result.verdict)
    || [...expected].some((number) => !assessed.has(number));

  const lines = [
    `# SDD task fulfillment — PR #${pr.number}`,
    '', `- verdict: **${malformed ? 'invalid review' : result.verdict}**`,
    `- product spec tree: \`${project.treeSha}\``, '', result.summary || '', '',
    ...(result.tasks || []).map((task) => `- #${task.number}: **${task.verdict}** — ${task.explanation || ''}${task.missing?.length ? `\n  Missing: ${task.missing.join('; ')}` : ''}`),
  ];
  await core.summary.addRaw(lines.join('\n')).write();
  if (malformed || result.verdict !== 'complete' || (result.tasks || []).some((task) => task.verdict !== 'complete')) {
    core.setFailed(`Linked SDD task is not completely fulfilled. ${result.summary || ''}`);
  }
};
