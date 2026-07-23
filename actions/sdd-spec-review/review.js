// SDD spec review — the quality gate on spec PRs (PLAN §7).
//
// Reviews the PROPOSED target state: ambiguity, contradiction, missing
// decisions, unverifiable requirements, decisions accepted outside spec/ but
// not reflected in it. Blocking findings fail the check; the owner merges.
//
// v2 also made this workflow produce a machine-readable "impact plan" — a set
// of per-repo task operations that the push trigger later executed. That half
// is gone with the push trigger (PLAN §16): reviewing a contract and planning
// its delivery are different jobs, and the second one required this workflow
// to read code repos, which §1.8 now forbids.

module.exports = async ({ github, context, core }) => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');

  const pr = context.payload.pull_request;
  if (!pr) {
    core.setFailed('sdd-spec-review must run for a pull_request event.');
    return;
  }
  if (!process.env.LLM_API_KEY) {
    core.setFailed('secrets.SDD_LLM_API_KEY is not set.');
    return;
  }

  const { owner, repo } = context.repo;
  const MARKER = '<!-- sdd:spec-review -->';
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}\n… [truncated]` : value);
  const inDir = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
  const tracked = (root) => git('ls-files', '--', root).split('\n').filter(Boolean)
    .filter((file) => !path.basename(file).startsWith('.') && path.basename(file) !== 'zoltan.json');
  const readFiles = (root, max = 60000) => {
    let result = '';
    for (const file of tracked(root)) {
      const value = fs.readFileSync(file);
      if (value.includes(0)) continue;
      if (result.length >= max) return `${result}\n… [more files omitted]`;
      result += `\n===== ${file} =====\n${clip(value.toString('utf8'), 20000)}\n`;
    }
    return clip(result, max);
  };

  const projects = [];
  for (const manifestPath of git('ls-files').split('\n')
    .filter((file) => path.basename(file) === 'zoltan.json')
    .sort((a, b) => a.length - b.length)) {
    const dir = path.dirname(manifestPath);
    if (projects.some((project) => inDir(dir, project.dir))) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const role = (name) => (dir === '.' ? name : `${dir}/${name}`);
    projects.push({
      dir,
      name: manifest.name || path.basename(path.resolve(dir)),
      description: manifest.description || '',
      specDir: role('spec'),
      contextDir: role('context'),
      backlogDir: role('backlog'),
      decisionsDir: role('decisions'),
    });
  }

  const changed = git('diff', '--name-only', pr.base.sha, pr.head.sha).split('\n').filter(Boolean);
  const touched = projects.filter((project) => changed.some((file) => inDir(file, project.dir)));

  async function upsert(body) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: pr.number, per_page: 100,
    });
    const previous = comments.find((comment) => (comment.body || '').includes(MARKER));
    if (previous) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body });
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
    }
  }

  if (!touched.length) {
    await upsert(`${MARKER}\n## SDD spec review\n\nNot applicable: this PR changes no SDD project directory.`);
    core.notice('No SDD project changes; spec review is not applicable.');
    return;
  }
  // One PR per contract change (PLAN §7): merge is the confirmation of *that*
  // change, and batching two projects into one merge destroys the granularity.
  if (touched.length !== 1) {
    await upsert(`${MARKER}\n## SDD spec review — failed\n\nA PR may change the contract of exactly one project. Touched: ${touched.map((p) => `\`${p.name}\``).join(', ')}.`);
    core.setFailed('A spec PR may change exactly one project contract.');
    return;
  }

  const project = touched[0];
  const specChanged = changed.some((file) => inDir(file, project.specDir));
  const fullDiff = git('diff', '--find-renames', '--unified=3', pr.base.sha, pr.head.sha, '--', project.dir);

  const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'spec-review.md'), 'utf8');
  const userPrompt = [
    `PROJECT: ${project.name}`,
    project.description ? `DESCRIPTION: ${project.description}` : '',
    `AUTHORITATIVE ROOT: ${project.specDir}`,
    '',
    `PR #${pr.number}: ${pr.title}`,
    clip(pr.body || '', 4000),
    '',
    `AUTHORITATIVE SPEC AT PROPOSED HEAD:\n${readFiles(project.specDir) || '(empty)'}`,
    '',
    `SUPPORTING CONTEXT (NON-BINDING):\n${readFiles(project.contextDir, 12000) || '(empty)'}`,
    `BACKLOG (NON-BINDING):\n${readFiles(project.backlogDir, 8000) || '(empty)'}`,
    `DECISION RECORDS (NON-BINDING):\n${readFiles(project.decisionsDir, 12000) || '(empty)'}`,
    '',
    `THE SPEC ITSELF ${specChanged ? 'IS' : 'IS NOT'} CHANGED BY THIS PR.`,
    'FULL PROJECT DIFF:',
    '```diff', clip(fullDiff, 50000), '```',
  ].filter(Boolean).join('\n');

  const response = await fetch(`${(process.env.LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    }),
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${clip(await response.text(), 2000)}`);
  const content = (await response.json()).choices?.[0]?.message?.content || '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in review response: ${clip(content, 500)}`);
  const review = JSON.parse(content.slice(start, end + 1));

  const findings = Array.isArray(review.findings) ? review.findings : [];
  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  const passed = review.verdict === 'pass' && !blocking.length;

  const findingsText = findings.length
    ? findings.map((finding) => `- **${finding.severity || 'advisory'} / ${finding.category || 'review'}** ${finding.location || ''}: ${finding.explanation || ''}${finding.question ? `\n  - Decision needed: ${finding.question}` : ''}`).join('\n')
    : '_No findings._';
  const body = [
    MARKER,
    `## SDD spec review — ${passed ? 'pass ✅' : 'needs revision ❌'}`,
    '', review.summary || '', '',
    '### Findings', findingsText,
    '',
    specChanged
      ? '_Merging this PR appends a changelog entry for this project; the code repo picks it up on its next alignment run._'
      : '_This PR does not change `spec/`, so it produces no changelog entry and no alignment work._',
  ].filter((part) => part !== '').join('\n');
  await upsert(body);
  await core.summary.addRaw(body.replace(MARKER, '')).write();

  if (!passed) {
    core.setFailed(`Spec review requires revision. ${review.summary || ''}`);
  }
};
