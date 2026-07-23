const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  loadSpecContext, linkedIssueNumbers, readWatermark, loadChangelog,
  alignmentTarget, alignmentRange, alignMarker, parseAlignMarker,
} = require('../actions/lib/spec-context');

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const commit = (root, message) => {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD').trim();
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-context-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, 'demo', 'spec'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'changelog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', 'zoltan.json'), JSON.stringify({ name: 'demo', repo: 'org/code' }));
  fs.writeFileSync(path.join(root, 'demo', 'spec', 'product.md'), 'BINDING v1');
  fs.writeFileSync(path.join(root, 'demo', 'context', 'notes.md'), 'NON_BINDING');
  return { root, first: commit(root, 'fixture') };
}

const entryFile = (root, sha, { date = '2026-07-24', umbrella = null, title = 'change' } = {}) => {
  fs.writeFileSync(path.join(root, 'demo', 'changelog', `${date}-${sha.slice(0, 12)}.md`), [
    '---', `sha: ${sha}`, `date: ${date}`, 'pr: 7', `umbrella: ${umbrella ?? 'null'}`,
    'files:', '  - "demo/spec/product.md"', '---', '', `# ${title}`, '', 'why it changed', '',
  ].join('\n'));
};

test('loads only spec/ for the named project', () => {
  const { root } = fixture();
  const result = loadSpecContext({ project: 'demo', checkout: root });
  assert.equal(result.specDir, 'demo/spec');
  assert.match(result.spec, /BINDING/);
  assert.doesNotMatch(result.spec, /NON_BINDING/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('returns null for a project that does not exist, rather than guessing', () => {
  const { root } = fixture();
  assert.equal(loadSpecContext({ project: 'nope', checkout: root }), null);
  assert.equal(loadSpecContext({ project: '', checkout: root }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('reads the contract at a given ref, not only at HEAD', () => {
  const { root, first } = fixture();
  fs.writeFileSync(path.join(root, 'demo', 'spec', 'product.md'), 'BINDING v2');
  commit(root, 'second');
  assert.match(loadSpecContext({ project: 'demo', checkout: root, ref: first }).spec, /v1/);
  assert.match(loadSpecContext({ project: 'demo', checkout: root }).spec, /v2/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('watermark ignores comments and blank lines, and defaults to 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-wm-'));
  const file = path.join(dir, 'spec-offset');
  assert.equal(readWatermark(file), '0');
  fs.writeFileSync(file, '# explanation\n#\n\n  abc123def456  \n');
  assert.equal(readWatermark(file), 'abc123def456');
  fs.writeFileSync(file, '# only comments\n');
  assert.equal(readWatermark(file), '0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('target is the newest spec commit that already has a changelog entry', () => {
  const { root, first } = fixture();
  fs.writeFileSync(path.join(root, 'demo', 'spec', 'product.md'), 'BINDING v2');
  const second = commit(root, 'second');
  entryFile(root, first, { umbrella: 17 });
  commit(root, 'changelog for first');

  // The newer spec commit has no entry yet: it must not be consumed.
  let entries = loadChangelog({ project: 'demo', checkout: root });
  assert.equal(alignmentTarget({ checkout: root, project: 'demo', entries }), first);

  entryFile(root, second);
  commit(root, 'changelog for second');
  entries = loadChangelog({ project: 'demo', checkout: root });
  assert.equal(alignmentTarget({ checkout: root, project: 'demo', entries }), second);
  assert.equal(entries.get(first).umbrella, 17);
  assert.equal(entries.get(second).umbrella, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('range excludes the watermark and includes everything up to the target, oldest first', () => {
  const { root, first } = fixture();
  fs.writeFileSync(path.join(root, 'demo', 'spec', 'product.md'), 'v2');
  const second = commit(root, 'second');
  fs.writeFileSync(path.join(root, 'demo', 'spec', 'product.md'), 'v3');
  const third = commit(root, 'third');

  const behind = alignmentRange({ checkout: root, project: 'demo', offset: first, target: third });
  assert.equal(behind.fromValid, true);
  assert.deepEqual(behind.shas, [second, third]);

  const aligned = alignmentRange({ checkout: root, project: 'demo', offset: third, target: third });
  assert.deepEqual(aligned.shas, []);

  // A greenfield repo consumes the whole history and says so.
  const greenfield = alignmentRange({ checkout: root, project: 'demo', offset: '0', target: third });
  assert.equal(greenfield.fromValid, false);
  assert.deepEqual(greenfield.shas, [first, second, third]);

  // An unknown sha must not be treated as a valid frontier.
  const bogus = alignmentRange({ checkout: root, project: 'demo', offset: 'f'.repeat(40), target: third });
  assert.equal(bogus.fromValid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('align marker round-trips the state the closing job needs', () => {
  const body = `${alignMarker({ from: 'aaa', to: 'bbb', umbrellas: [3, 9] })}\nGoal text`;
  assert.deepEqual(parseAlignMarker(body), { from: 'aaa', to: 'bbb', umbrellas: [3, 9] });
  assert.deepEqual(parseAlignMarker(alignMarker({ to: 'bbb', umbrellas: [] })), { from: '0', to: 'bbb', umbrellas: [] });
  assert.equal(parseAlignMarker('no marker here'), null);
});

test('extracts unique linked issue numbers', () => {
  assert.deepEqual(linkedIssueNumbers({ title: 'Refs #12', body: 'Closes #8 and fixes #12' }).sort((a, b) => a - b), [8, 12]);
});
