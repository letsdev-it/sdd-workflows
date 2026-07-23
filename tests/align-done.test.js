const test = require('node:test');
const assert = require('node:assert/strict');
const { watermarkReached } = require('../actions/sdd-align-done/align-done');

const never = () => false;
const always = () => true;

test('an unset watermark never completes an alignment', () => {
  assert.equal(watermarkReached({ offset: '0', target: 'abc', isAncestor: always }), false);
  assert.equal(watermarkReached({ offset: '', target: 'abc', isAncestor: always }), false);
});

test('the exact target completes it without asking git', () => {
  assert.equal(watermarkReached({ offset: 'abc', target: 'abc', isAncestor: never }), true);
});

test('a watermark past the target completes it — the executor may bump to a newer spec', () => {
  assert.equal(watermarkReached({ offset: 'newer', target: 'older', isAncestor: (a, b) => a === 'older' && b === 'newer' }), true);
});

test('a watermark behind the target leaves the task open', () => {
  assert.equal(watermarkReached({ offset: 'older', target: 'newer', isAncestor: never }), false);
});

test('a task with no target is never closed by accident', () => {
  assert.equal(watermarkReached({ offset: 'abc', target: null, isAncestor: always }), false);
});
