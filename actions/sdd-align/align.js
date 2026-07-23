module.exports = async ({ github, context, core }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {
    loadSpecContext, readWatermark, loadChangelog, alignmentTarget,
    alignmentRange, isCommit, alignMarker, parseAlignMarker,
  } = require('../lib/spec-context');

  const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'align.md'), 'utf8').trim();
  const { owner, repo } = context.repo;
  const dryRun = process.env.DRY_RUN === 'true';
  const specRepo = process.env.SPEC_REPO;
  const project = process.env.SPEC_PROJECT;
  const offsetFile = process.env.OFFSET_FILE || '.sdd/spec-offset';
  const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}\n… [truncated]` : value);

  if (!specRepo) { core.setFailed('SDD_SPEC_REPO is not configured.'); return; }
  if (!project) { core.setFailed('SDD_SPEC_PROJECT is not configured — a code repo must declare which project it implements.'); return; }

  // ---------- where we are ----------
  const offset = readWatermark(offsetFile);
  const offsetValid = isCommit({ rev: offset });
  if (offset !== '0' && !offsetValid) {
    core.warning(`Watermark ${offset} is not a commit in ${specRepo} — treating this repo as never aligned.`);
  }

  const entries = loadChangelog({ project });
  const target = alignmentTarget({ project, entries });
  if (!target) {
    core.notice(`No changelog entries for ${project} yet — nothing to align against.`);
    return;
  }
  if (offset === target) {
    core.notice(`Aligned: ${offset.slice(0, 12)} is the published head of ${project}'s spec.`);
    await core.summary.addRaw(`# SDD align\n\n\`${owner}/${repo}\` is aligned with \`${specRepo}/${project}\` @ \`${target.slice(0, 12)}\`.`).write();
    return;
  }

  const { shas } = alignmentRange({ project, offset, target });
  if (!shas.length) {
    core.notice(`Watermark ${offset.slice(0, 12)} is not behind ${target.slice(0, 12)} — nothing to do.`);
    return;
  }
  const consumed = shas.map((sha) => entries.get(sha) || { sha, title: null, body: null, umbrella: null, date: '' });
  const umbrellas = [...new Set(consumed.map((entry) => entry.umbrella).filter(Boolean))];

  // ---------- the contract AT THE TARGET ----------
  // Not at HEAD: the task promises a specific end state, and align-done closes
  // it by comparing the watermark with exactly this sha.
  const spec = loadSpecContext({ project, ref: target });
  if (!spec) {
    core.setFailed(`${specRepo} has no ${project}/spec at ${target.slice(0, 12)} — check SDD_SPEC_PROJECT (currently "${project}").`);
    return;
  }

  const openAlign = (await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, labels: 'sdd:align', state: 'open', per_page: 100,
  })).filter((issue) => !issue.pull_request);
  const existing = openAlign[0] || null;
  if (openAlign.length > 1) {
    core.warning(`${openAlign.length} open sdd:align tasks — refreshing #${existing.number} and leaving the rest. There should only ever be one.`);
  }

  if (!process.env.LLM_API_KEY) { core.setFailed('secrets.SDD_LLM_API_KEY is not set in this repo.'); return; }

  // ---------- the goal ----------
  const changes = consumed.map((entry, index) => [
    `### ${index + 1}. ${entry.title || entry.sha.slice(0, 12)}${entry.date ? ` (${entry.date})` : ''}`,
    entry.body ? clip(entry.body, 2000) : '_No changelog entry recorded for this commit._',
  ].join('\n')).join('\n\n');

  const response = await fetch(`${(process.env.LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          `REPOSITORY: ${owner}/${repo}`,
          `PROJECT: ${project} (spec: ${specRepo}/${spec.specDir}, tree ${spec.treeSha})`,
          `ALIGNING: ${offsetValid ? offset.slice(0, 12) : '(never aligned)'} → ${target.slice(0, 12)}`,
          '',
          'CURRENT PRODUCT SPEC — the contract and the target state:',
          spec.spec || '(empty)',
          '',
          `WHAT MOVED (${consumed.length} spec change${consumed.length === 1 ? '' : 's'}, oldest first):`,
          clip(changes, 20000),
        ].join('\n') },
      ],
    }),
  });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${clip(await response.text(), 2000)}`);
  const content = (await response.json()).choices?.[0]?.message?.content || '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in align response: ${clip(content, 500)}`);
  const out = JSON.parse(content.slice(start, end + 1));

  const title = `[align] ${out.headline || `spec @ ${target.slice(0, 12)}`}`;
  const body = [
    alignMarker({ from: offsetValid ? offset : '0', to: target, umbrellas }),
    `**Goal — bring this repository up to [\`${project}\`'s product spec](https://github.com/${specRepo}/tree/${target}/${spec.specDir}).**`,
    '',
    out.goal || '',
    '',
    '---',
    '',
    `### Spec changes in this range (${consumed.length})`,
    '',
    ...consumed.map((entry) => `- [\`${entry.sha.slice(0, 12)}\`](https://github.com/${specRepo}/commit/${entry.sha})${entry.title ? ` — ${entry.title}` : ''}${entry.umbrella ? ` (${specRepo}#${entry.umbrella})` : ''}`),
    '',
    '### How this task is done',
    '',
    'This is a **goal, not a work breakdown** — split it however the code suggests. Sub-issues you open for yourself are yours; they carry no SDD labels and the pipeline ignores them.',
    '',
    `Done means the watermark moves: set \`${offsetFile}\` to \`${target}\` in the final PR. That closes this task automatically${umbrellas.length ? `, along with the umbrella issue${umbrellas.length === 1 ? '' : 's'} in ${specRepo} (${umbrellas.map((n) => `#${n}`).join(', ')})` : ''}.`,
    '',
    'Every PR here is judged against the **current** spec, which may move again while you work. If it does, this task\'s target is advanced in place — there is never a second alignment task.',
  ].join('\n');

  await core.summary.addRaw([
    `# SDD align — ${consumed.length} spec change${consumed.length === 1 ? '' : 's'} to consume`,
    '', `\`${offsetValid ? offset.slice(0, 12) : '(never aligned)'}\` → \`${target.slice(0, 12)}\``,
    '', out.goal || '',
  ].join('\n')).write();

  if (dryRun) {
    core.notice(`[dry-run] would ${existing ? `refresh #${existing.number}` : 'file an alignment task'}: ${title}`);
    return;
  }

  try {
    await github.rest.issues.createLabel({
      owner, repo, name: 'sdd:align', color: '1d76db',
      description: 'Goal-shaped alignment task: bring this repo up to the current spec (SDD)',
    });
  } catch (error) { if (error.status !== 422) throw error; }

  if (!existing) {
    const { data: issue } = await github.rest.issues.create({ owner, repo, title, body, labels: ['sdd:align'] });
    core.notice(`Filed alignment task ${issue.html_url}`);
    return;
  }

  const previous = parseAlignMarker(existing.body);
  await github.rest.issues.update({ owner, repo, issue_number: existing.number, title, body });
  if (!previous || previous.to !== target) {
    const fresh = previous
      ? consumed.filter((entry) => !isCommit({ rev: entry.sha }) || !ancestorOf(entry.sha, previous.to))
      : consumed;
    await github.rest.issues.createComment({
      owner, repo, issue_number: existing.number,
      body: [
        `The spec moved on: target advanced to [\`${target.slice(0, 12)}\`](https://github.com/${specRepo}/commit/${target}).`,
        '',
        fresh.length ? `New since the last refresh:\n${fresh.map((entry) => `- ${entry.title || entry.sha.slice(0, 12)}`).join('\n')}` : '',
        '',
        'The goal above was rewritten against the current spec — keep working, and set the watermark to the new target when you are done.',
      ].filter(Boolean).join('\n'),
    });
  }
  core.notice(`Refreshed alignment task #${existing.number} → ${target.slice(0, 12)}`);

  function ancestorOf(sha, descendant) {
    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['-C', 'spec-repo', 'merge-base', '--is-ancestor', sha, descendant], { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }
};
