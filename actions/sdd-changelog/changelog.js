// SDD changelog generator — the spec repo's ONLY outbound artifact (PLAN §8).
//
// For every first-parent commit of main touching <project>/spec/, write
// <project>/changelog/<date>-<short-sha>.md. The entry file IS the
// processed-marker: no commit comments, no scan window, no local state.
// Deterministic and LLM-free by design — the alignment consumer reads the
// full current spec anyway, so a generated summary would add interpretation
// without adding information.
//
// This script must never learn that code repositories exist (PLAN §1.8).

module.exports = async ({ github, context, core }) => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');

  const dryRun = process.env.DRY_RUN === 'true';
  const { owner, repo } = context.repo;
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const SHORT = 12;

  // ---------- project discovery ----------
  const inDir = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
  const projects = [];
  for (const manifestPath of git('ls-files').split('\n')
    .filter((f) => path.basename(f) === 'zoltan.json')
    .sort((a, b) => a.length - b.length)) {
    const dir = path.dirname(manifestPath);
    const parent = projects.find((p) => inDir(dir, p.dir));
    if (parent) {
      core.warning(`Nested zoltan.json ignored: ${manifestPath} (inside "${parent.name}")`);
      continue;
    }
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      core.warning(`Skipping unparsable ${manifestPath}: ${e.message}`);
      continue;
    }
    const specDir = dir === '.' ? 'spec' : `${dir}/spec`;
    if (!fs.existsSync(specDir)) {
      core.warning(`Project "${manifest.name || dir}" has no ${specDir}/ — nothing to publish.`);
      continue;
    }
    projects.push({
      dir,
      name: manifest.name || path.basename(path.resolve(dir)),
      specDir,
      changelogDir: dir === '.' ? 'changelog' : `${dir}/changelog`,
    });
  }
  if (!projects.length) {
    core.notice('No projects with a spec/ directory — nothing to do.');
    return;
  }

  // ---------- back-links ----------
  const prCache = new Map();
  async function pullRequestFor(sha) {
    if (prCache.has(sha)) return prCache.get(sha);
    let pr = null;
    try {
      const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
        owner, repo, commit_sha: sha,
      });
      pr = data.find((item) => item.merged_at) || data[0] || null;
    } catch (e) {
      core.warning(`Cannot resolve the PR for ${sha.slice(0, 7)}: ${e.message}`);
    }
    prCache.set(sha, pr);
    return pr;
  }

  // The umbrella is the issue the spec PR referenced with `Refs #N` (PLAN §7).
  // `Closes #N` is accepted too: GitHub has already closed that issue, and
  // recording it keeps the entry honest about its provenance.
  const umbrellaFrom = (text) => {
    const match = String(text || '')
      .match(/\b(?:refs?|closes?|closed|fix(?:e[sd])?|resolves?|resolved)[\s:]+#(\d+)/i);
    return match ? Number(match[1]) : null;
  };

  const yamlString = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

  // ---------- generate ----------
  const written = [];
  for (const project of projects) {
    fs.mkdirSync(project.changelogDir, { recursive: true });
    const existing = new Set(
      fs.readdirSync(project.changelogDir)
        .map((name) => (name.match(/-([0-9a-f]{7,40})\.md$/) || [])[1])
        .filter(Boolean),
    );

    const commits = git('log', '--first-parent', '--format=%H%x09%aI', 'HEAD', '--', project.specDir)
      .split('\n').filter(Boolean)
      .map((line) => {
        const [sha, iso] = line.split('\t');
        return { sha, date: iso.slice(0, 10) };
      })
      .reverse(); // oldest first, so a partial run still leaves a prefix

    for (const commit of commits) {
      const short = commit.sha.slice(0, SHORT);
      if (existing.has(short)) continue;

      const subject = git('log', '-1', '--format=%s', commit.sha).trim();
      const body = git('log', '-1', '--format=%b', commit.sha).trim();
      const files = git('show', '--first-parent', '--name-only', '--format=', commit.sha, '--', project.specDir)
        .split('\n').filter(Boolean);
      if (!files.length) continue; // merge commit with no net change in spec/

      const pr = await pullRequestFor(commit.sha);
      const umbrella = umbrellaFrom(`${pr ? `${pr.title}\n${pr.body || ''}` : ''}\n${subject}\n${body}`);

      const entry = [
        '---',
        `sha: ${commit.sha}`,
        `date: ${commit.date}`,
        `pr: ${pr ? pr.number : 'null'}`,
        `umbrella: ${umbrella ?? 'null'}`,
        'files:',
        ...files.map((f) => `  - ${yamlString(f)}`),
        '---',
        '',
        `# ${pr ? pr.title : subject}`,
        '',
        (pr ? (pr.body || '').trim() : body) || '_No description._',
        '',
      ].join('\n');

      const file = `${project.changelogDir}/${commit.date}-${short}.md`;
      if (!dryRun) fs.writeFileSync(file, entry);
      written.push({ project: project.name, file, sha: commit.sha, umbrella });
      core.info(`${dryRun ? '[dry-run] ' : ''}${file}  (umbrella: ${umbrella ?? 'none'})`);
    }
  }

  if (!written.length) {
    core.notice('Changelog is up to date.');
    return;
  }

  const summary = [
    `# Changelog — ${written.length} new entr${written.length === 1 ? 'y' : 'ies'}`,
    '',
    ...written.map((e) => `- \`${e.file}\`${e.umbrella ? ` → umbrella #${e.umbrella}` : ''}`),
  ].join('\n');
  await core.summary.addRaw(summary).write();

  if (dryRun) {
    core.notice(`[dry-run] ${written.length} entries would be written.`);
    return;
  }

  // ---------- commit ----------
  // The push-trigger path filter excludes changelog/, so this cannot loop.
  git('config', 'user.name', process.env.COMMIT_USER_NAME || 'ldit-sdd-engine[bot]');
  git('config', 'user.email', process.env.COMMIT_USER_EMAIL || 'ldit-sdd-engine[bot]@users.noreply.github.com');
  git('add', '--', ...written.map((e) => e.file));
  git('commit', '-m', `sdd: changelog for ${written.length} spec commit${written.length === 1 ? '' : 's'}`);

  for (let attempt = 1; ; attempt += 1) {
    try {
      git('push', 'origin', `HEAD:${process.env.TARGET_BRANCH || 'main'}`);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      core.warning(`Push rejected (attempt ${attempt}) — rebasing onto the new head.`);
      git('fetch', 'origin', process.env.TARGET_BRANCH || 'main');
      git('rebase', `origin/${process.env.TARGET_BRANCH || 'main'}`);
    }
  }
  core.notice(`Published ${written.length} changelog entr${written.length === 1 ? 'y' : 'ies'}.`);
};
