const test = require('node:test');
const assert = require('node:assert/strict');
const { targetUmbrella } = require('../actions/sdd-clarification/clarify');
const { alignMarker, parseAlignMarker } = require('../actions/lib/spec-context');

test('picks the newest umbrella, so one question yields one draft spec PR', () => {
  const marker = parseAlignMarker(alignMarker({ from: 'a', to: 'b', umbrellas: [4, 11, 27] }));
  assert.equal(targetUmbrella(marker), 27);
});

test('a range with no linked intake has nowhere to carry the question', () => {
  assert.equal(targetUmbrella(parseAlignMarker(alignMarker({ to: 'b', umbrellas: [] }))), null);
  assert.equal(targetUmbrella(null), null);
});
