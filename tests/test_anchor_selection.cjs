const assert = require('assert');
const PE = require('../static/phrase-engine.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

// --- Task 1: splitLyricWordsWithParens ---
check('splits and tags single-token parens as inParen', () => {
  assert.deepStrictEqual(
    PE.splitLyricWordsWithParens('shadows dancing (forever) tonight'),
    [ {word:'shadows', inParen:false},
      {word:'dancing', inParen:false},
      {word:'forever', inParen:true},
      {word:'tonight', inParen:false} ]
  );
});

check('tracks parens across multiple tokens', () => {
  assert.deepStrictEqual(
    PE.splitLyricWordsWithParens('hold (on my) love').map(o => o.inParen),
    [false, true, true, false]
  );
});

check('handles spaced parens (bare ( and ) tokens drop out)', () => {
  const r = PE.splitLyricWordsWithParens('a ( yeah ) b');
  assert.deepStrictEqual(r.map(o => o.word), ['a', 'yeah', 'b']);
  assert.deepStrictEqual(r.map(o => o.inParen), [false, true, false]);
});

check('empty / whitespace input yields empty array', () => {
  assert.deepStrictEqual(PE.splitLyricWordsWithParens('   '), []);
  assert.deepStrictEqual(PE.splitLyricWordsWithParens(''), []);
});

console.log('anchor-selection: ' + passed + ' checks passed');
