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

// --- Task 2: Fix A — parenthetical content is not an anchor ---
check('parenthetical content word is excluded from anchors', () => {
  const plan = PE.buildPhrasePlan(
    [{ time: 0, text: 'shadows dancing (forever) tonight' }],
    { difficulty: 'expert' }
  );
  const words = plan.phrases[0].anchors.map(a => a.word).sort();
  assert.ok(!words.includes('forever'), '"forever" was in parens — must not be an anchor');
  assert.deepStrictEqual(words, ['dancing', 'shadows', 'tonight']);
});

// --- Task 3: Fix B — don't force ALL anchors on lines big enough to spare one ---
function planFor(text, difficulty) {
  return PE.buildPhrasePlan([{ time: 0, text: text }], { difficulty: difficulty }).phrases[0];
}
check('N=4 Expert: ceil(4*0.8)=4 force-all -> capped to 3', () => {
  const p = planFor('shadows dancing rivers mountains', 'expert');
  assert.strictEqual(p.anchors.length, 4);
  assert.strictEqual(p.anchorsRequired, 3);
});
check('N=4 Medium: ceil(4*0.45)=2 (not force-all) -> unchanged', () => {
  assert.strictEqual(planFor('shadows dancing rivers mountains', 'medium').anchorsRequired, 2);
});
check('N=2 Expert: short line not collapsed -> still 2', () => {
  const p = planFor('shadows dancing', 'expert');
  assert.strictEqual(p.anchors.length, 2);
  assert.strictEqual(p.anchorsRequired, 2);
});
check('N=5 Expert: ceil(5*0.8)=4 < 5 (has headroom) -> unchanged', () => {
  const p = planFor('shadows dancing rivers mountains thunder', 'expert');
  assert.strictEqual(p.anchors.length, 5);
  assert.strictEqual(p.anchorsRequired, 4);
});
check('Easy never force-all: N=4 -> 1', () => {
  assert.strictEqual(planFor('shadows dancing rivers mountains', 'easy').anchorsRequired, 1);
});

console.log('anchor-selection: ' + passed + ' checks passed');
