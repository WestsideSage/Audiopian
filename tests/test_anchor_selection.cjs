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

// --- Task 4: per-anchor trace detail (§3C) ---
check('getPhraseTrace exposes per-anchor word/wordClass/weight/hit', () => {
  const plan = PE.buildPhrasePlan(
    [{ time: 0, text: 'shadows dancing (forever) tonight' }],
    { difficulty: 'expert' }
  );
  const phrase = plan.phrases[0];
  const state = {
    anchorHits: {}, status: 'open', lyricStatus: 'partial', accuracyStatus: 'missing',
    flowStatus: 'silent', cleared: false, rescuedByWhisper: false, liveClean: false,
    evidence: [], consumedTokens: [], rejectedCandidates: [], flowEvents: [], overflow: {}
  };
  state.anchorHits[phrase.anchors[0].anchorIdx] = { word: phrase.anchors[0].word };
  const session = { plan: plan, states: {} };
  session.states[phrase.phraseId] = state;

  const trace = PE.getPhraseTrace(session)[0];
  assert.strictEqual(trace.anchors.length, phrase.anchors.length);
  assert.ok(trace.anchors.every(a =>
    typeof a.word === 'string' && typeof a.wordClass === 'string' &&
    typeof a.weight === 'number' && typeof a.hit === 'boolean'));
  assert.strictEqual(trace.anchors.filter(a => a.hit).length, 1);
  assert.strictEqual(trace.anchors.find(a => a.word === phrase.anchors[0].word).hit, true);
  assert.ok(trace.anchors.every(a => a.wordClass !== 'adlib'));
});

// --- Task 5: non-lexical interjections must not gate a phrase ---
// "Uh-oh" normalizes (hyphen stripped) to the single token "uhoh". Speech
// recognizers essentially never surface it, so making it a required anchor is an
// honestly-unwinnable gate. It must classify as adlib (weight 0) and never anchor,
// while the real lexical words on the line still do.
check('interjection "uh-oh" is not selected as an anchor', () => {
  const plan = PE.buildPhrasePlan(
    [{ time: 0, text: 'just dont tap the glass uh-oh gorilla go gorilla go go' }],
    { difficulty: 'expert' }
  );
  const anchorWords = plan.phrases.flatMap(p => p.anchors.map(a => a.word));
  assert.ok(!anchorWords.includes('uhoh'),
    '"uh-oh" -> "uhoh" is a non-lexical interjection and must not be an anchor');
  assert.ok(anchorWords.includes('gorilla'),
    'lexical "gorilla" should still anchor the phrase');
});

console.log('anchor-selection: ' + passed + ' checks passed');
