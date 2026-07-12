module.exports = async ({ github, context, core }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadSpecContext, linkedIssueNumbers } = require('../lib/spec-context');
  const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'conformance.md'), 'utf8').trim();
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) { core.setFailed('sdd-conformance must be called from a pull_request-triggered workflow.'); return; }
  const specRepo = process.env.SPEC_REPO;
  const [specOwner, specName] = specRepo.split('/');
  const clip = (s, max) => (s.length > max ? s.slice(0, max) + '\n… [truncated]' : s);
  
  const project = loadSpecContext({ owner, repo });
  if (!project) {
    core.notice(`${owner}/${repo} is not listed in any zoltan.json of ${specRepo} — conformance check does not apply.`);
    return;
  }
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set in this repo.'); return; }
  
  // ---------- PR diff + files ----------
  const { data: diff } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: 'diff' } });
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  const fileList = files.map((f) => f.filename);
  
  // ---------- spec provenance (mechanical) ----------
  const text = `${pr.title}\n${pr.body || ''}`;
  const linked = [];
  linked.push(...linkedIssueNumbers(pr));
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
    body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0,
      response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        `PRODUCT SPEC (project: ${project.name}, tree: ${project.treeSha}):`, project.spec || '(empty)',
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

  await github.rest.repos.createCommitStatus({
    owner, repo, sha: pr.head.sha, state: 'success', context: 'sdd-spec-freshness',
    description: `Reviewed against spec tree ${project.treeSha.slice(0, 12)}`,
    target_url: pr.html_url,
  });
  
  // ---------- decision ----------
  if (verdict.tech_spec_advisory) core.warning(`Tech-spec advisory (non-blocking): ${verdict.tech_spec_advisory}`);
  const lines = [
    `# SDD conformance — PR #${pr.number}`,
    '',
    `- verdict: **${verdict.verdict}**`,
    `- product spec tree: \`${project.treeSha}\``,
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
