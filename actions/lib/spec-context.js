const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gitIn = (checkout) => (...args) => execFileSync('git', ['-C', checkout, ...args], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

/**
 * Load a project's binding contract from a spec-repo checkout.
 *
 * The project is named by the CALLER (vars.SDD_SPEC_PROJECT), never discovered
 * by searching the spec repo for a manifest that lists this code repository.
 * That search was the last place a code repo's identity had to be written down
 * inside the spec repo, and the spec repo may no longer know code repos exist.
 *
 * `ref` lets a consumer read the contract at a specific commit — alignment
 * judges against its target, not against whatever `main` happens to be when
 * the job runs.
 */
function loadSpecContext({ project, checkout = 'spec-repo', ref = 'HEAD', max = 60000 }) {
  if (!project) return null;
  const git = gitIn(checkout);
  const specDir = `${project}/spec`;
  let files;
  try {
    files = git('ls-tree', '-r', '--name-only', ref, '--', specDir).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (!files.length) return null;

  let spec = '';
  for (const file of files) {
    if (path.basename(file).startsWith('.')) continue;
    if (spec.length >= max) { spec += '\n… [more files omitted]\n'; break; }
    let text;
    try { text = git('show', `${ref}:${file}`); } catch { continue; }
    if (text.includes('\0')) continue;
    spec += `\n===== ${file} =====\n${text.length > 20000 ? `${text.slice(0, 20000)}\n… [truncated]` : text}\n`;
  }
  return {
    name: project,
    dir: project,
    specDir,
    spec: spec.slice(0, max),
    treeSha: git('rev-parse', `${ref}:${specDir}`).trim(),
  };
}

/**
 * The watermark: the spec-repo commit a code repo is aligned to. `0` means
 * nothing consumed. Comments and blank lines are ignored so the file can
 * explain itself to whoever opens it.
 */
function readWatermark(file) {
  if (!fs.existsSync(file)) return '0';
  const line = fs.readFileSync(file, 'utf8').split('\n')
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith('#'));
  return line || '0';
}

/** Index the published changelog by the spec commit each entry records. */
function loadChangelog({ project, checkout = 'spec-repo' }) {
  const dir = path.join(checkout, project, 'changelog');
  const entries = new Map();
  if (!fs.existsSync(dir)) return entries;
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const sha = (text.match(/^sha:\s*([0-9a-f]{7,40})\s*$/m) || [])[1];
    if (!sha) continue;
    const umbrella = (text.match(/^umbrella:\s*(\d+)\s*$/m) || [])[1];
    entries.set(sha, {
      sha,
      file: `${project}/changelog/${name}`,
      umbrella: umbrella ? Number(umbrella) : null,
      date: (text.match(/^date:\s*(\S+)\s*$/m) || [])[1] || '',
      title: (text.match(/^#\s+(.+)$/m) || [])[1] || name,
      body: text.split(/^---\s*$/m).slice(2).join('---').trim(),
    });
  }
  return entries;
}

function isCommit({ checkout = 'spec-repo', rev }) {
  if (!rev || rev === '0') return false;
  try { gitIn(checkout)('cat-file', '-e', `${rev}^{commit}`); return true; } catch { return false; }
}

/**
 * The newest spec commit that ALREADY HAS a changelog entry.
 *
 * Taking the entry rather than the commit as the frontier removes the race
 * between a spec merge and the commit that records it: a merge whose entry has
 * not landed yet is simply not consumed on this pass.
 */
function alignmentTarget({ checkout = 'spec-repo', project, entries, ref = 'HEAD' }) {
  const git = gitIn(checkout);
  const log = git('log', '--first-parent', '--format=%H', ref, '--', `${project}/spec`)
    .split('\n').filter(Boolean);
  return log.find((sha) => entries.has(sha)) || null;
}

/**
 * Spec commits between the watermark and the target, oldest first so the
 * result reads as a story. Walks --first-parent, which is why a watermark must
 * sit ON that path: a seed on the branch side of a merge is reachable but not
 * on the path, and the project would read as one change behind forever.
 */
function alignmentRange({ checkout = 'spec-repo', project, offset, target }) {
  const git = gitIn(checkout);
  const specDir = `${project}/spec`;
  const fromValid = isCommit({ checkout, rev: offset });
  const revs = fromValid
    ? git('rev-list', '--first-parent', `${offset}..${target}`, '--', specDir)
    : git('rev-list', '--first-parent', target, '--', specDir);
  return { fromValid, shas: revs.split('\n').filter(Boolean).reverse() };
}

function linkedIssueNumbers(pr) {
  const text = `${pr.title || ''}\n${pr.body || ''}`;
  const numbers = new Set();
  for (const match of text.matchAll(/\b(?:ref|refs|close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[\s:]+#(\d+)/gi)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}

/** Machine-readable state carried by an alignment task issue. */
const ALIGN_MARKER_RE = /<!--\s*sdd:align\s+from=(\S+)\s+to=(\S+)\s+umbrellas=(\S*)\s*-->/;

function alignMarker({ from, to, umbrellas }) {
  return `<!-- sdd:align from=${from || '0'} to=${to} umbrellas=${(umbrellas || []).join(',')} -->`;
}

function parseAlignMarker(body) {
  const match = String(body || '').match(ALIGN_MARKER_RE);
  if (!match) return null;
  return {
    from: match[1],
    to: match[2],
    umbrellas: (match[3] || '').split(',').map((value) => parseInt(value, 10)).filter(Boolean),
  };
}

module.exports = {
  gitIn,
  loadSpecContext,
  readWatermark,
  loadChangelog,
  alignmentTarget,
  alignmentRange,
  isCommit,
  linkedIssueNumbers,
  alignMarker,
  parseAlignMarker,
  ALIGN_MARKER_RE,
};
