var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var filePath = path.join(__dirname, '..', 'static', 'match-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var REVERSE_CONTRACTION_MAP = fakeModule.exports.REVERSE_CONTRACTION_MAP;
var contractionsMatch = fakeModule.exports.contractionsMatch;
var multiWordContractionMatch = fakeModule.exports.multiWordContractionMatch;

// --- REVERSE_CONTRACTION_MAP ---
// "going to" should reverse-map to "gonna"
assert.strictEqual(REVERSE_CONTRACTION_MAP['going to'], 'gonna');
assert.strictEqual(REVERSE_CONTRACTION_MAP['want to'], 'wanna');
assert.strictEqual(REVERSE_CONTRACTION_MAP['got to'], 'gotta');
assert.strictEqual(REVERSE_CONTRACTION_MAP['kind of'], 'kinda');
assert.strictEqual(REVERSE_CONTRACTION_MAP['about to'], 'bouta');

// --- contractionsMatch: spoken contraction vs full-form target ---
// Lyric says "going", ASR says "gonna" — should match via contraction expansion
assert.strictEqual(contractionsMatch('gonna', 'going'), true,
    'contraction "gonna" should match first word of expansion "going to"');
assert.strictEqual(contractionsMatch('hello', 'going'), false,
    'unrelated word should not match');

// --- contractionsMatch: spoken full-form vs contraction target ---
// Lyric says "gonna", ASR says "going" — need reverse lookup
assert.strictEqual(contractionsMatch('going', 'gonna'), false,
    'single word "going" does not match "gonna" (need multi-word "going to")');

// --- multiWordContractionMatch ---
// ASR returns ["going", "to"] and target is "gonna"
// Returns number of spoken words consumed (2) or 0 if no match
assert.strictEqual(multiWordContractionMatch(['going', 'to', 'the'], 0, 'gonna'), 2,
    '"going to" at index 0 should match "gonna", consuming 2 words');
assert.strictEqual(multiWordContractionMatch(['going', 'to', 'the'], 0, 'hello'), 0,
    '"going to" should not match unrelated target');
assert.strictEqual(multiWordContractionMatch(['i', 'am', 'going', 'to'], 2, 'gonna'), 2,
    '"going to" at index 2 should match "gonna"');

// Edge: spoken array too short
assert.strictEqual(multiWordContractionMatch(['going'], 0, 'gonna'), 0,
    'not enough spoken words to form "going to"');

// 3-word expansion: "i am going to" → "ima"
assert.strictEqual(multiWordContractionMatch(['i', 'am', 'going', 'to'], 0, 'ima'), 4,
    '"i am going to" should match "ima", consuming 4 words');

// "do not know" → "dunno"
assert.strictEqual(multiWordContractionMatch(['do', 'not', 'know', 'why'], 0, 'dunno'), 3,
    '"do not know" should match "dunno", consuming 3 words');

console.log('All contraction matching tests passed.');

var PHRASE_EQUIV_MAP = fakeModule.exports.PHRASE_EQUIV_MAP;
var phraseMatch = fakeModule.exports.phraseMatch;
var FILLER_WORDS = fakeModule.exports.FILLER_WORDS;

// --- PHRASE_EQUIV_MAP ---
assert.strictEqual(PHRASE_EQUIV_MAP['all right'], 'alright');
assert.strictEqual(PHRASE_EQUIV_MAP['alright'], 'all right');
assert.strictEqual(PHRASE_EQUIV_MAP['every day'], 'everyday');
assert.strictEqual(PHRASE_EQUIV_MAP['everyday'], 'every day');

// --- phraseMatch: spoken multi-word matches single target ---
var r1 = phraseMatch(['all', 'right', 'now'], 0, ['alright', 'now'], 0);
assert.deepStrictEqual(r1, { spokenConsumed: 2, targetConsumed: 1 },
    '"all right" should match "alright"');

// --- phraseMatch: spoken single matches multi-word target ---
var r2 = phraseMatch(['alright', 'now'], 0, ['all', 'right', 'now'], 0);
assert.deepStrictEqual(r2, { spokenConsumed: 1, targetConsumed: 2 },
    '"alright" should match "all right"');

// --- phraseMatch: no match ---
var r3 = phraseMatch(['hello'], 0, ['world'], 0);
assert.strictEqual(r3, null, 'unrelated words should return null');

// --- phraseMatch: "cannot" vs "can not" ---
var r4 = phraseMatch(['cannot'], 0, ['can', 'not'], 0);
assert.deepStrictEqual(r4, { spokenConsumed: 1, targetConsumed: 2 });

// --- FILLER_WORDS ---
assert.strictEqual(FILLER_WORDS.has('uh'), true);
assert.strictEqual(FILLER_WORDS.has('um'), true);
assert.strictEqual(FILLER_WORDS.has('hello'), false);

console.log('All phrase matching tests passed.');

var maxEditDistance = fakeModule.exports.maxEditDistance;
var skipFuzzyMatch = fakeModule.exports.skipFuzzyMatch;

// --- maxEditDistance ---
assert.strictEqual(maxEditDistance(1), 1);
assert.strictEqual(maxEditDistance(3), 1);
assert.strictEqual(maxEditDistance(6), 1);
assert.strictEqual(maxEditDistance(7), 2);
assert.strictEqual(maxEditDistance(9), 2);
assert.strictEqual(maxEditDistance(10), 3);
assert.strictEqual(maxEditDistance(15), 3);
assert.strictEqual(maxEditDistance(0), 1);

// --- skipFuzzyMatch ---
assert.strictEqual(skipFuzzyMatch('i'), true);
assert.strictEqual(skipFuzzyMatch('a'), true);
assert.strictEqual(skipFuzzyMatch('to'), true);
assert.strictEqual(skipFuzzyMatch('the'), false);
assert.strictEqual(skipFuzzyMatch('love'), false);

console.log('All edit distance tests passed.');
