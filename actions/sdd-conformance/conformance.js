module.exports = async ({ github, context, core }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {
    loadSpecContext, linkedIssueNumbers, readWatermark, loadChangelog,
    alignmentTarget, alignmentRange,
  } = require('../lib/spec-context');
  const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'conformance.md'), 'utf8').trim();
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) { core.setFailed('sdd-conformance must be called from a pull_request-triggered workflow.'); return; }
  const specRepo = process.env.SPEC_REPO;
  const [specOwner, specName] = specRepo.split('/');
  const projectName = process.env.SPEC_PROJECT;
  const clip = (s, max) => (s.length > max ? s.slice(0, max) + '\n… [truncated]' : s);

  if (!projectName) {
    core.setFailed('SDD_SPEC_PROJECT is not set — a code repo must declare which project it implements. The spec repo no longer holds that mapping.');
    return;
  }
  const project = loadSpecContext({ project: projectName });
  if (!project) {
    core.setFailed(`${specRepo} has no ${projectName}/spec — check SDD_SPEC_PROJECT.`);
    return;
  }
  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set in this repo.'); return; }

  // ---------- PR diff + files ----------
  const { data: diff } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: 'diff' } });
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  const fileList = files.map((f) => f.filename);

  // ---------- spec provenance (mechanical, context only) ----------
  const text = `${pr.title}\n${pr.body || ''}`;
  let provenance = new RegExp(`${specOwner}/${specName}(#\\d+|/pull/|/commit/)`, 'i').test(text) ? 'direct spec link in PR' : null;
  for (const n of linkedIssueNumbers(pr)) {
    if (provenance) break;
    try {
      const { data: task } = await github.rest.issues.get({ owner, repo, issue_number: n });
      const labels = (task.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
      if (labels.includes('sdd:align')) provenance = `alignment task #${n}`;
    } catch { /* dangling ref */ }
  }

  // ---------- drift advisory (non-blocking) ----------
  // How far this repository is from the published contract. Catching up is the
  // alignment task's job, never this PR's — so this can only ever be a note.
  let driftNote = null;
  try {
    const offsetFile = process.env.OFFSET_FILE || '.sdd/spec-offset';
    const offset = readWatermark(offsetFile);
    const entries = loadChangelog({ project: projectName });
    const target = alignmentTarget({ project: projectName, entries });
    if (offset === '0') {
      driftNote = 'this repository has never been aligned (watermark is `0`)';
    } else if (target && offset !== target) {
      const { shas } = alignmentRange({ project: projectName, offset, target });
      if (shas.length) driftNote = `this repository is ${shas.length} spec change(s) behind (\`${offset.slice(0, 12)}\` → \`${target.slice(0, 12)}\`)`;
    }
  } catch (error) {
    driftNote = `the watermark could not be read (${error.message}) — alignment cannot be tracked for this repo`;
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

  // ---------- decision ----------
  if (verdict.tech_spec_advisory) core.warning(`Tech-spec advisory (non-blocking): ${verdict.tech_spec_advisory}`);
  if (driftNote) core.warning(`Drift advisory (non-blocking): ${driftNote}.`);
  const lines = [
    `# SDD conformance — PR #${pr.number}`,
    '',
    `- verdict: **${verdict.verdict}**`,
    `- project: \`${specRepo}/${project.specDir}\` (tree \`${project.treeSha}\`)`,
    `- spec provenance (context only): **${provenance || 'none'}**`,
    '',
    verdict.explanation || '',
    verdict.tech_spec_advisory ? `\n> ⚠ Tech-spec advisory (non-blocking): ${verdict.tech_spec_advisory}` : '',
    driftNote ? `\n> ℹ Drift advisory (non-blocking): ${driftNote}. Catching up is the alignment task's job, not this PR's.` : '',
  ];
  await core.summary.addRaw(lines.join('\n')).write();

  if (verdict.verdict === 'beyond_spec') {
    core.setFailed(`This PR introduces externally-observable behavior the product spec does not describe. Route the contract change through ${specRepo} (issue → spec PR → merge), or drop the unspecified behavior. ${verdict.explanation || ''}`);
  } else if (verdict.verdict === 'against_spec') {
    core.setFailed(`This PR results in behavior contradicting the CURRENT product spec${provenance ? ` (provenance: ${provenance} — the spec may have moved on since)` : ''}. Check the latest spec state in ${specRepo}/${project.specDir}. ${verdict.explanation || ''}`);
  } else {
    core.notice(`Conformance OK${provenance ? ` (${provenance})` : ''}.`);
  }
};
