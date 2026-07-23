module.exports = async ({ github, context, core }) => {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { loadSpecContext, readWatermark, loadChangelog, alignmentTarget, alignmentRange } = require('../lib/spec-context');
  const { owner, repo } = context.repo;
  const specRepo = process.env.SPEC_REPO;
  const projectName = process.env.SPEC_PROJECT;
  if (!specRepo) { core.setFailed('SDD_SPEC_REPO is not configured.'); return; }
  if (!projectName) { core.setFailed('SDD_SPEC_PROJECT is not configured — a code repo must declare which project it implements.'); return; }
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set.'); return; }
  const [specOwner, specName] = specRepo.split('/');
  const project = loadSpecContext({ project: projectName });
  if (!project) { core.setFailed(`${specRepo} has no ${projectName}/spec — check SDD_SPEC_PROJECT.`); return; }

  // ---------- alignment state, reported alongside the semantic audit ----------
  // A repo that is simply behind is not drifting: it has work queued. Saying so
  // keeps the audit from re-reporting what the alignment task already covers.
  let behind = 0;
  let watermark = '0';
  try {
    watermark = readWatermark(process.env.OFFSET_FILE || 'code-repo/.sdd/spec-offset');
    const entries = loadChangelog({ project: projectName });
    const target = alignmentTarget({ project: projectName, entries });
    if (target && watermark !== target) behind = alignmentRange({ project: projectName, offset: watermark, target }).shas.length;
  } catch (error) {
    core.warning(`Could not read the watermark: ${error.message}`);
  }

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
      { role: 'user', content: [
        `PROJECT: ${project.name}`,
        `SPEC TREE: ${project.treeSha}`,
        behind
          ? `ALIGNMENT: this repository is ${behind} published spec change(s) behind. Work that an open alignment task already covers is NOT drift — do not report it.`
          : 'ALIGNMENT: this repository is up to date with the published spec, so any mismatch you find is real drift.',
        '',
        `AUTHORITATIVE SPEC:\n${project.spec}`,
        '',
        `CODE REPOSITORY ${owner}/${repo}:\n${code}`,
      ].join('\n') },
    ] }),
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  const content = (await response.json()).choices?.[0]?.message?.content || '';
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in drift response: ${content.slice(0, 500)}`);
  const result = JSON.parse(content.slice(start, end + 1));
  const findings = (result.findings || []).filter((finding) => ['code_bug', 'spec_gap'].includes(finding.kind) && finding.title && finding.description);

  // Findings are filed where the fix belongs. A code bug is code work and stays
  // here; only a gap in the contract is intake for the spec repo, which no
  // longer accepts code-* issue types at all.
  const ensureLabel = async (target, name, color, description) => {
    try { await github.rest.issues.createLabel({ ...target, name, color, description }); }
    catch (error) { if (error.status !== 422) throw error; }
  };
  const here = { owner, repo };
  const spec = { owner: specOwner, repo: specName };
  await ensureLabel(here, 'sdd:drift', 'b60205', 'Detected divergence between this code and the authoritative spec');
  await ensureLabel(spec, 'sdd:drift', 'b60205', 'Detected divergence between code and authoritative spec');

  const openHere = await github.paginate(github.rest.issues.listForRepo, { ...here, state: 'open', labels: 'sdd:drift', per_page: 100 }).catch(() => []);
  const openSpec = await github.paginate(github.rest.issues.listForRepo, { ...spec, state: 'open', labels: 'sdd:drift', per_page: 100 }).catch(() => []);

  const created = [];
  for (const finding of findings) {
    const canonical = JSON.stringify({ project: project.name, repo: `${owner}/${repo}`, ...finding });
    const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
    const marker = `<!-- sdd:drift ${fingerprint} -->`;
    const codeBug = finding.kind === 'code_bug';
    const target = codeBug ? here : spec;
    const pool = codeBug ? openHere : openSpec;
    if (pool.some((issue) => (issue.body || '').includes(marker))) continue;

    const body = [
      marker,
      ...(codeBug ? [] : ['### Project', '', project.name, '', '### Spec drafting', '', 'llm-spec — the automat drafts a proposal', '']),
      '### Description', '', finding.description, '',
      `Spec evidence: ${finding.spec_evidence || '(none cited)'}`, '',
      `Code evidence: ${finding.code_evidence || '(none cited)'}`, '',
      `Detected in: ${owner}/${repo}`,
      `Spec tree: ${project.treeSha}`,
      `Watermark at audit time: ${watermark}`,
    ].join('\n');
    const { data: issue } = await github.rest.issues.create({
      ...target,
      title: `[drift] ${finding.title}`,
      body,
      labels: codeBug ? ['sdd:drift'] : ['sdd:drift', 'spec-chore'],
    });
    created.push(issue.html_url);
  }

  await core.summary.addRaw([
    `# SDD drift audit — ${owner}/${repo}`, '', result.summary || '',
    '',
    behind ? `Alignment: **${behind} spec change(s) behind** — queued work, not drift.` : 'Alignment: up to date with the published spec.',
    '', `Findings: ${findings.length}; new issues: ${created.length}`,
    ...created.map((url) => `- ${url}`),
  ].join('\n')).write();
};
