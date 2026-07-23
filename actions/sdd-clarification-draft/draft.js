module.exports = async ({ github, context, core }) => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const { owner, repo } = context.repo;
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set.'); return; }
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clip = (value, max) => value.length > max ? `${value.slice(0, max)}\n… [truncated]` : value;

  const umbrellaNumber = context.eventName === 'workflow_dispatch'
    ? Number(process.env.UMBRELLA_INPUT) : context.payload.issue.number;
  const commentId = context.eventName === 'workflow_dispatch'
    ? Number(process.env.COMMENT_ID_INPUT) : context.payload.comment.id;
  if (!Number.isInteger(umbrellaNumber) || !Number.isInteger(commentId)) {
    core.setFailed('A valid umbrella and clarification comment id are required.'); return;
  }
  const { data: umbrella } = await github.rest.issues.get({ owner, repo, issue_number: umbrellaNumber });
  if (umbrella.state !== 'open' || umbrella.pull_request) {
    core.setFailed(`Umbrella #${umbrellaNumber} must be an open issue.`); return;
  }
  const { data: request } = await github.rest.issues.getComment({ owner, repo, comment_id: commentId });
  if (!(request.body || '').includes('<!-- sdd:clarification-request -->')) {
    core.setFailed(`Comment ${commentId} is not an SDD clarification request.`); return;
  }
  const projectMatch = (umbrella.body || '').match(/###\s*Project\s*[\r\n]+\s*([^\r\n]+)/i);
  if (!projectMatch) { core.setFailed(`Umbrella #${umbrellaNumber} has no Project field.`); return; }

  const projects = [];
  for (const manifestPath of git('ls-files').split('\n').filter((file) => path.basename(file) === 'zoltan.json')) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const dir = path.dirname(manifestPath);
    const specDir = fs.existsSync(dir === '.' ? 'spec' : `${dir}/spec`) ? (dir === '.' ? 'spec' : `${dir}/spec`) : dir;
    projects.push({ name: manifest.name || path.basename(dir), dir, specDir });
  }
  const project = projects.find((item) => item.name === projectMatch[1].trim());
  if (!project) { core.setFailed(`Unknown project ${projectMatch[1].trim()}.`); return; }

  const branch = `spec/${umbrellaNumber}-clarify-${commentId}`;
  const { data: existing } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'all' });
  if (existing.length) { core.notice(`Clarification PR already exists: ${existing[0].html_url}`); return; }

  const readFiles = (root, max) => {
    let value = '';
    for (const file of git('ls-files', '--', root).split('\n').filter(Boolean)) {
      if (path.basename(file).startsWith('.')) continue;
      const content = fs.readFileSync(file);
      if (content.includes(0)) continue;
      value += `\n===== ${file} =====\n${clip(content.toString('utf8'), 20000)}\n`;
      if (value.length >= max) break;
    }
    return clip(value, max);
  };
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: umbrellaNumber, per_page: 100,
  });
  const prompt = fs.readFileSync(path.join(__dirname, 'prompts', 'clarification-draft.md'), 'utf8');
  const user = [
    `PROJECT: ${project.name}`,
    '', `UMBRELLA #${umbrellaNumber}: ${umbrella.title}`, umbrella.body || '',
    '', 'DISCUSSION:', comments.slice(-30).map((comment) => `@${comment.user.login}: ${clip(comment.body || '', 2000)}`).join('\n---\n'),
    '', 'AUTHORITATIVE SPEC:', readFiles(project.specDir, 60000) || '(empty)',
  ].join('\n');
  const response = await fetch(`${(process.env.LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0,
      response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: prompt }, { role: 'user', content: user },
    ] }),
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${clip(await response.text(), 2000)}`);
  const content = (await response.json()).choices?.[0]?.message?.content || '';
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in clarification response: ${clip(content, 500)}`);
  const proposal = JSON.parse(content.slice(start, end + 1));
  const files = (proposal.files || []).filter((file) => file.path && typeof file.content === 'string');
  if (!files.length) {
    await github.rest.issues.createComment({ owner, repo, issue_number: umbrellaNumber,
      body: `Clarification request ${commentId} needs an explicit product decision before a spec PR can be drafted.\n\n${proposal.summary || ''}` });
    core.setFailed('Clarification cannot be drafted without an explicit product decision.');
    return;
  }
  for (const file of files) {
    if (!(file.path === project.specDir || file.path.startsWith(`${project.specDir}/`)) || file.path.split('/').includes('..')) {
      throw new Error(`Clarification output outside authoritative spec root: ${file.path}`);
    }
  }

  const base = context.payload.repository.default_branch || 'main';
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('checkout', '-B', branch, `origin/${base}`);
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content);
  }
  git('add', '--', project.specDir);
  git('commit', '-m', `spec: clarify #${umbrellaNumber}\n\nRefs #${umbrellaNumber}`);
  git('push', 'origin', `HEAD:${branch}`);
  const { data: pr } = await github.rest.pulls.create({
    owner, repo, head: branch, base, draft: true,
    title: `spec: clarify ${umbrella.title}`,
    body: [
      `Refs #${umbrellaNumber}`, '',
      '<!-- sdd:clarification-pr -->',
      `Clarification request comment: ${request.html_url}`, '',
      proposal.summary || '', '',
      'Merging this appends a changelog entry; the code repo picks the clarified contract up on its next alignment run, so any work already in flight should be finished against the clarified spec rather than restarted.',
    ].join('\n'),
  });
  await github.rest.issues.createComment({ owner, repo, issue_number: umbrellaNumber,
    body: `Drafted clarification PR: ${pr.html_url}` });
  core.notice(`Created ${pr.html_url}`);
};
