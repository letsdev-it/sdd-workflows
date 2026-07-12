const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const slugOf = (url) => {
  const match = String(url).match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
};

function loadSpecContext({ owner, repo, checkout = 'spec-repo', max = 60000 }) {
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let project = null;
  for (const manifestPath of git('ls-files').split('\n').filter((file) => path.basename(file) === 'zoltan.json')) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(checkout, manifestPath), 'utf8'));
      if (!(manifest.repos || []).some((item) => slugOf(item.url) === `${owner}/${repo}`.toLowerCase())) continue;
      const dir = path.dirname(manifestPath);
      const roleSpecDir = dir === '.' ? 'spec' : `${dir}/spec`;
      const structured = fs.existsSync(path.join(checkout, roleSpecDir));
      project = { dir, specDir: structured ? roleSpecDir : dir, name: manifest.name || dir, structured };
      break;
    } catch { /* malformed or unrelated manifest */ }
  }
  if (!project) return null;

  let spec = '';
  for (const file of git('ls-files', '--', project.specDir).split('\n').filter(Boolean)) {
    if (path.basename(file).startsWith('.') || path.basename(file) === 'zoltan.json') continue;
    const content = fs.readFileSync(path.join(checkout, file));
    if (content.includes(0)) continue;
    if (spec.length >= max) { spec += '\n… [more files omitted]\n'; break; }
    const text = content.toString('utf8');
    spec += `\n===== ${file} =====\n${text.length > 20000 ? `${text.slice(0, 20000)}\n… [truncated]` : text}\n`;
  }
  const treeSha = git('rev-parse', `HEAD:${project.specDir}`).trim();
  return { ...project, spec: spec.slice(0, max), treeSha };
}

function linkedIssueNumbers(pr) {
  const text = `${pr.title || ''}\n${pr.body || ''}`;
  const numbers = new Set();
  for (const match of text.matchAll(/\b(?:ref|refs|close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[\s:]+#(\d+)/gi)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}

module.exports = { loadSpecContext, linkedIssueNumbers, slugOf };
