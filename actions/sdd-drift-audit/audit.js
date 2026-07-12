module.exports = async ({ github, context, core }) => {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { loadSpecContext } = require('../lib/spec-context');
  const { owner, repo } = context.repo;
  const specRepo = process.env.SPEC_REPO;
  if (!specRepo) { core.setFailed('SDD_SPEC_REPO is not configured.'); return; }
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set.'); return; }
  const [specOwner, specName] = specRepo.split('/');
  const project = loadSpecContext({ owner, repo });
  if (!project) { core.notice(`${owner}/${repo} is not registered in ${specRepo}; audit does not apply.`); return; }

  const git = (...args) => execFileSync('git', ['-C', 'code-repo', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const excluded = /(^|\/)(\.git|node_modules|vendor|dist|build|coverage|\.next|target)(\/|$)/;
  let code = '';
  for (const file of git('ls-files').split('\n').filter(Boolean)) {
    if (excluded.test(file) || /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|lock)$/i.test(file)) continue;
    const content = fs.readFileSync(path.join('code-repo', file));
    if (content.includes(0)) continue;
    if (code.length >= 100000) { code += '\n… [more files omitted]\n'; break; }
    const text = content.toString('utf8');
    code += `\n===== ${file} =====\n${text.slice(0, 12000)}\n`;
  }

  const prompt = fs.readFileSync(path.join(__dirname, 'prompts', 'audit.md'), 'utf8');
  const response = await fetch(`${(process.env.LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0,
      response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `PROJECT: ${project.name}\nSPEC TREE: ${project.treeSha}\n\nAUTHORITATIVE SPEC:\n${project.spec}\n\nCODE REPOSITORY ${owner}/${repo}:\n${code}` },
    ] }),
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  const content = (await response.json()).choices?.[0]?.message?.content || '';
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in drift response: ${content.slice(0, 500)}`);
  const result = JSON.parse(content.slice(start, end + 1));
  const findings = (result.findings || []).filter((finding) => ['code_bug', 'spec_gap'].includes(finding.kind) && finding.title && finding.description);

  const existing = await github.paginate(github.rest.issues.listForRepo, {
    owner: specOwner, repo: specName, state: 'open', labels: 'sdd:drift', per_page: 100,
  }).catch(() => []);
  try {
    await github.rest.issues.createLabel({ owner: specOwner, repo: specName, name: 'sdd:drift', color: 'b60205', description: 'Detected divergence between code and authoritative spec' });
  } catch (error) { if (error.status !== 422) throw error; }

  const created = [];
  for (const finding of findings) {
    const canonical = JSON.stringify({ project: project.name, repo: `${owner}/${repo}`, ...finding });
    const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
    const marker = `<!-- sdd:drift ${fingerprint} -->`;
    if (existing.some((issue) => (issue.body || '').includes(marker))) continue;
    const type = finding.kind === 'code_bug' ? 'code-bug' : 'spec-chore';
    const body = [
      marker,
      '### Project', '', project.name, '',
      ...(type === 'spec-chore' ? ['### Spec drafting', '', 'llm-spec — the automat drafts a proposal', ''] : []),
      '### Description', '', finding.description, '',
      `Spec evidence: ${finding.spec_evidence || '(none cited)'}`, '',
      `Code evidence: ${finding.code_evidence || '(none cited)'}`, '',
      `Detected in: ${owner}/${repo}`, `Spec tree: ${project.treeSha}`,
    ].join('\n');
    const { data: issue } = await github.rest.issues.create({
      owner: specOwner, repo: specName,
      title: `[drift] ${finding.title}`,
      body, labels: ['sdd:drift', type],
    });
    created.push(issue.html_url);
  }
  await core.summary.addRaw([
    `# SDD drift audit — ${owner}/${repo}`, '', result.summary || '',
    '', `Findings: ${findings.length}; new intake issues: ${created.length}`,
    ...created.map((url) => `- ${url}`),
  ].join('\n')).write();
};
