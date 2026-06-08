const assert = require('assert');
const P = require('../static/profanity.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

const hardR = 'nigga'.replace(/a$/, 'er');   // derive; avoid spelling the slur in source

check('isProfane: strong words + slurs, case/punctuation-insensitive', () => {
  assert.ok(P.isProfane('fuck'));
  assert.ok(P.isProfane('Shit,'));
  assert.ok(P.isProfane('bitches'));
  assert.ok(P.isProfane('nigga'));   // -a variant IS clean-mode profanity
  assert.ok(P.isProfane(hardR));     // hard-R is also profanity (censored in clean mode)
});

check('isProfane: mild words are NOT profane (strong + slurs only)', () => {
  assert.ok(!P.isProfane('damn'));
  assert.ok(!P.isProfane('hell'));
  assert.ok(!P.isProfane('ass'));
  assert.ok(!P.isProfane('hello'));
});

check('isNeverScore: hard-R only, not the -a variant', () => {
  assert.ok(P.isNeverScore(hardR));
  assert.ok(P.isNeverScore(hardR + 's'));
  assert.ok(!P.isNeverScore('nigga'));   // -a variant is scoreable in explicit mode
  assert.ok(!P.isNeverScore('fuck'));
});

check('censorWord: keep first letter, mask the rest, preserve punctuation', () => {
  assert.strictEqual(P.censorWord('fuck'), 'f***');
  assert.strictEqual(P.censorWord('Shit,'), 'S***,');
  assert.strictEqual(P.censorWord('a'), 'a');
});

check('censorLine: masks only profane tokens, preserves spacing & clean words', () => {
  assert.strictEqual(P.censorLine('you fuckin know'), 'you f***** know');
  assert.strictEqual(P.censorLine('damn that hello'), 'damn that hello');
});

console.log('profanity: ' + passed + ' checks passed');
