const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadSpecContext, linkedIssueNumbers, slugOf } = require('../actions/lib/spec-context');

test('normalizes HTTPS and SSH GitHub repository URLs', () => {
  assert.equal(slugOf('git@github.com:Org/Repo.git'), 'org/repo');
  assert.equal(slugOf('https://github.com/Org/Repo'), 'org/repo');
});

test('extracts unique linked issue numbers', () => {
  assert.deepEqual(linkedIssueNumbers({ title: 'Refs #12', body: 'Closes #8 and fixes #12' }).sort((a, b) => a - b), [8, 12]);
});

test('loads only spec/ from a structured project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-context-'));
  execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'demo', 'spec'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', 'zoltan.json'), JSON.stringify({
    name: 'demo', repos: [{ url: 'https://github.com/org/code' }],
  }));
  fs.writeFileSync(path.join(root, 'demo', 'spec', 'product.md'), 'BINDING');
  fs.writeFileSync(path.join(root, 'demo', 'context', 'notes.md'), 'NON_BINDING');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  const result = loadSpecContext({ owner: 'org', repo: 'code', checkout: root });
  assert.equal(result.specDir, 'demo/spec');
  assert.match(result.spec, /BINDING/);
  assert.doesNotMatch(result.spec, /NON_BINDING/);
  fs.rmSync(root, { recursive: true, force: true });
});
