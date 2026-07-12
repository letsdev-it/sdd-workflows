module.exports = async ({ github, context, core }) => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'conformance.md'), 'utf8').trim();
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) { core.setFailed('sdd-conformance must be called from a pull_request-triggered workflow.'); return; }
  const specRepo = process.env.SPEC_REPO;
  const [specOwner, specName] = specRepo.split('/');
  const clip = (s, max) => (s.length > max ? s.slice(0, max) + '\n… [truncated]' : s);
  
  // ---------- locate this repo's project in the spec repo ----------
  const git = (...a) => execFileSync('git', ['-C', 'spec-repo', ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const slugOf = (url) => {
    const m = String(url).match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  };
  let project = null;
  for (const mp of git('ls-files').split('\n').filter((f) => path.basename(f) === 'zoltan.json')) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join('spec-repo', mp), 'utf8'));
      if ((manifest.repos || []).some((r) => slugOf(r.url) === `${owner}/${repo}`.toLowerCase())) {
        const projectDir = path.dirname(mp);
        const roleSpecDir = projectDir === '.' ? 'spec' : `${projectDir}/spec`;
        const structured = fs.existsSync(path.join('spec-repo', roleSpecDir));
        project = {
          dir: projectDir,
          specDir: structured ? roleSpecDir : projectDir,
          name: manifest.name || projectDir,
          structured,
        };
        break;
      }
    } catch { /* ignore */ }
  }
  if (!project) {
    core.notice(`${owner}/${repo} is not listed in any zoltan.json of ${specRepo} — conformance check does not apply.`);
    return;
  }
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set in this repo.'); return; }
  
  // ---------- authoritative product spec content ----------
  // Structured projects authorize code from spec/ only. The root
  // fallback keeps legacy flat projects working until migration.
  let spec = '';
  for (const f of git('ls-files', '--', project.specDir).split('\n').filter(Boolean)) {
    if (path.basename(f).startsWith('.') || path.basename(f) === 'zoltan.json') continue;
    const content = fs.readFileSync(path.join('spec-repo', f));
    if (content.includes(0)) continue;
    if (spec.length > 60000) { spec += '\n… [more files omitted]\n'; break; }
    spec += `\n===== ${f} =====\n${clip(content.toString('utf8'), 20000)}\n`;
  }
  
  // ---------- PR diff + files ----------
  const { data: diff } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: 'diff' } });
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  const fileList = files.map((f) => f.filename);
  
  // ---------- spec provenance (mechanical) ----------
  const text = `${pr.title}\n${pr.body || ''}`;
  const linked = [];
  for (const m of text.matchAll(/\b(?:ref|refs|close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[\s:]+#(\d+)/gi)) linked.push(+m[1]);
  let provenance = new RegExp(`${specOwner}/${specName}(#\\d+|/pull/|/commit/)`, 'i').test(text) ? 'direct spec link in PR' : null;
  for (const n of linked) {
    if (provenance) break;
    try {
      const { data: task } = await github.rest.issues.get({ owner, repo, issue_number: n });
      if (new RegExp(`Spec:\\s*${specOwner}/${specName}#\\d+`, 'i').test(task.body || '')) provenance = `linked task #${n} (from a merged spec change)`;
    } catch { /* dangling ref */ }
  }
  
  // ---------- LLM verdict ----------
  const res = await fetch(`${(process.env.LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0, messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        `PRODUCT SPEC (project: ${project.name}):`, spec || '(empty)',
        '', `PULL REQUEST #${pr.number}: ${pr.title}`, clip(pr.body || '', 3000),
        '', 'CHANGED FILES:', fileList.join('\n'),
        '', 'DIFF:', '```diff', clip(String(diff), 50000), '```',
      ].join('\n') },
    ] }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${clip(await res.text(), 2000)}`);
  const content = (await res.json()).choices?.[0]?.message?.content || '';
  const s = content.indexOf('{'), e = content.lastIndexOf('}');
  const verdict = JSON.parse(content.slice(s, e + 1));
  
  // ---------- decision ----------
  if (verdict.tech_spec_advisory) core.warning(`Tech-spec advisory (non-blocking): ${verdict.tech_spec_advisory}`);
  const lines = [
    `# SDD conformance — PR #${pr.number}`,
    '',
    `- verdict: **${verdict.verdict}**`,
    `- spec provenance (context only): **${provenance || 'none'}**`,
    '',
    verdict.explanation || '',
    verdict.tech_spec_advisory ? `\n> ⚠ Tech-spec advisory (non-blocking): ${verdict.tech_spec_advisory}` : '',
  ];
  await core.summary.addRaw(lines.join('\n')).write();
  
  if (verdict.verdict === 'beyond_spec') {
    core.setFailed(`This PR introduces externally-observable behavior the product spec does not describe. Route the contract change through ${specRepo} (issue → spec PR → merge → generated task), or drop the unspecified behavior. ${verdict.explanation || ''}`);
  } else if (verdict.verdict === 'against_spec') {
    core.setFailed(`This PR results in behavior contradicting the CURRENT product spec${provenance ? ` (provenance: ${provenance} — the spec may have moved on since)` : ''}. Check the latest spec state in ${specRepo}/${project.specDir}. ${verdict.explanation || ''}`);
  } else {
    core.notice(`Conformance OK${provenance ? ` (${provenance})` : ''}.`);
  }
  
};
