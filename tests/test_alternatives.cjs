const assert = require('assert');
const H = require('../static/alternatives.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

const exact = (a, b) => a === b;

// Degenerate inputs
check('no alternatives -> empty string', () => {
  assert.strictEqual(H.pickBestTranscript([], ['hello'], exact), '');
  assert.strictEqual(H.pickBestTranscript(undefined, ['hello'], exact), '');
});

check('single alternative -> returns it unchanged', () => {
  assert.strictEqual(H.pickBestTranscript(['only one'], ['nope'], exact), 'only one');
});

check('accepts {transcript} objects (the Web Speech shape)', () => {
  const alts = [{ transcript: 'the cat sat' }, { transcript: 'distasteful antics' }];
  assert.strictEqual(H.pickBestTranscript(alts, ['distasteful', 'antics'], exact), 'distasteful antics');
});

// Safety / honesty guarantees
check('no expected words -> keep the recognizer top pick (alt[0])', () => {
  assert.strictEqual(H.pickBestTranscript(['top guess', 'second guess'], [], exact), 'top guess');
  assert.strictEqual(H.pickBestTranscript(['top guess', 'second guess'], ['x'], null), 'top guess');
});

check('no alternative matches any expected word -> keep alt[0] (no bias)', () => {
  assert.strictEqual(H.pickBestTranscript(['foo bar', 'baz qux'], ['hello'], exact), 'foo bar');
});

check('tie on expected-word matches -> keep alt[0] (do not switch on a tie)', () => {
  assert.strictEqual(H.pickBestTranscript(['hello world', 'hello there'], ['hello'], exact), 'hello world');
});

// The core recovery: a later alternative that matches strictly more expected words wins
check('alt[1] matching more expected words than alt[0] is chosen', () => {
  const alts = ['the cat sat', 'distasteful antics'];
  assert.strictEqual(H.pickBestTranscript(alts, ['distasteful', 'antics'], exact), 'distasteful antics');
});

// The injected matcher drives scoring (phonetic/fuzzy recovery), not just equality
check('uses the injected matchFn for fuzzy matches', () => {
  const prefix = (a, b) => a === b || (b.length >= 4 && b.indexOf(a) === 0);
  const alts = ['walking talking', 'singin loud'];
  assert.strictEqual(H.pickBestTranscript(alts, ['singing'], prefix), 'singin loud');
});

// Scoring normalizes case/punctuation, but the ORIGINAL transcript is returned verbatim
check('normalizes case/punctuation for scoring; returns original text', () => {
  const alts = ['the cat', 'Distasteful, antics!'];
  assert.strictEqual(H.pickBestTranscript(alts, ['distasteful'], exact), 'Distasteful, antics!');
});

// --- Integration: the REAL scorer must recover the real telemetry symptom ---
// In the 2026-06-08 batch the recognizer's top guess for "distasteful" was "tasteful";
// with the real wordsMatch the helper must switch to the alternative that actually has it.
const scoring = require('../static/scoring.js');
const realMatch = (sp, tg) => scoring.wordsMatch(sp, tg);

check('[integration] real scorer recovers "distasteful" from alt[1]', () => {
  const alts = ['tasteful antics is feelin', 'distasteful antics is feelin'];
  assert.strictEqual(H.pickBestTranscript(alts, ['distasteful', 'antic', 'feelin'], realMatch),
    'distasteful antics is feelin');
});

check('[integration] real scorer keeps alt[0] when nothing matches the line (no bias)', () => {
  const alts = ['totally different words', 'some other phrase entirely'];
  assert.strictEqual(H.pickBestTranscript(alts, ['distasteful', 'degenerate'], realMatch),
    'totally different words');
});

console.log('alternatives: ' + passed + ' checks passed');
