var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var filePath = path.join(__dirname, '..', 'static', 'match-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var contractionsMatch = fakeModule.exports.contractionsMatch;
var multiWordContractionMatch = fakeModule.exports.multiWordContractionMatch;

// --- contractionsMatch: spoken contraction vs full-form target ---
// Lyric says "going", ASR says "gonna" — should match via contraction expansion
assert.strictEqual(contractionsMatch('gonna', 'going'), true,
    'contraction "gonna" should match first word of expansion "going to"');
assert.strictEqual(contractionsMatch('hello', 'going'), false,
    'unrelated word should not match');

// --- contractionsMatch: spoken first-word-of-expansion vs contraction target ---
// Lyric says "gonna"/"wanna", ASR splits the sung contraction into "going to" /
// "want to" and the LEADING word arrives one interim before the rest. The leading
// word alone must credit the contraction target (symmetric with the forward case
// above) so it scores in-time instead of waiting for the full expansion.
assert.strictEqual(contractionsMatch('going', 'gonna'), true,
    'leading word "going" should match contraction target "gonna" (first word of "going to")');
assert.strictEqual(contractionsMatch('want', 'wanna'), true,
    'leading word "want" should match contraction target "wanna" (first word of "want to")');
assert.strictEqual(contractionsMatch('got', 'gotta'), true,
    'leading word "got" should match contraction target "gotta" (first word of "got to")');
// Honesty bound: only the EXPANSION's first word credits — not an arbitrary word,
// and not a first word belonging to a different contraction.
assert.strictEqual(contractionsMatch('want', 'gonna'), false,
    '"want" is not the first word of "gonna"\'s expansion — must not match');
assert.strictEqual(contractionsMatch('to', 'wanna'), false,
    'a non-first expansion word ("to") must not match the contraction target');
assert.strictEqual(contractionsMatch('hello', 'wanna'), false,
    'unrelated word must not match a contraction target');

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
assert.strictEqual(maxEditDistance(10), 2);
assert.strictEqual(maxEditDistance(15), 2);
assert.strictEqual(maxEditDistance(0), 1);

// --- skipFuzzyMatch ---
assert.strictEqual(skipFuzzyMatch('i'), true);
assert.strictEqual(skipFuzzyMatch('a'), true);
assert.strictEqual(skipFuzzyMatch('to'), true);
assert.strictEqual(skipFuzzyMatch('the'), false);
assert.strictEqual(skipFuzzyMatch('love'), false);

console.log('All edit distance tests passed.');

var MetaphoneLRU = fakeModule.exports.MetaphoneLRU;

var lru = new MetaphoneLRU(5);
var r = lru.get('night');
assert.ok(Array.isArray(r), 'should return array');
assert.strictEqual(r.length, 2, 'should have primary and secondary');

var r2 = lru.get('night');
assert.deepStrictEqual(r, r2, 'cached result should be identical');

// Fill beyond capacity
lru.get('a'); lru.get('b'); lru.get('c'); lru.get('d'); lru.get('e');
assert.strictEqual(lru._cache.has('night'), false, 'oldest should be evicted');
assert.strictEqual(lru._cache.size, 5, 'cache at capacity');

lru.reset();
assert.strictEqual(lru._cache.size, 0, 'reset clears cache');

console.log('All MetaphoneLRU tests passed.');

// --- isEdit2PrefixTruncation ---
var isEdit2PrefixTruncation = fakeModule.exports.isEdit2PrefixTruncation;

// Accept: spoken is prefix of target AND exactly 1 char missing
assert.strictEqual(isEdit2PrefixTruncation('rhyth',  'rhythm'),  true,  'rhyth→rhythm prefix diff=1');
assert.strictEqual(isEdit2PrefixTruncation('singin', 'singing'), true,  'singin→singing prefix diff=1');
assert.strictEqual(isEdit2PrefixTruncation('keepin', 'keeping'), true,  'keepin→keeping prefix diff=1');

// Reject: prefix but diff > 1 (2+ chars missing)
assert.strictEqual(isEdit2PrefixTruncation('fol',   'folks'),   false, 'fol→folks diff=2');
assert.strictEqual(isEdit2PrefixTruncation('less',  'lesson'),  false, 'less→lesson diff=2');
assert.strictEqual(isEdit2PrefixTruncation('cat',   'catch'),   false, 'cat→catch diff=2');

// Reject: not a prefix
assert.strictEqual(isEdit2PrefixTruncation('hat',   'cat'),     false, 'hat→cat not a prefix');
assert.strictEqual(isEdit2PrefixTruncation('work',  'words'),   false, 'work→words not a prefix');

// Reject: spoken longer than target
assert.strictEqual(isEdit2PrefixTruncation('rhythm', 'rhyth'),  false, 'rhythm→rhyth spoken longer');

console.log('isEdit2PrefixTruncation: 9 tests passed');

// === fix(detection): new contraction entries + buildLyricVocabulary ===
var CMAP = fakeModule.exports.CONTRACTION_MAP;
assert.strictEqual(CMAP['aint'], 'is not', 'aint (apostrophe-stripped) reachable');
assert.strictEqual(CMAP['lemme'], 'let me', 'lemme added');
assert.strictEqual(CMAP['gimme'], 'give me', 'gimme added');
assert.strictEqual(CMAP['imma'], 'i am going to', 'imma added');
assert.strictEqual(contractionsMatch('lemme', 'let'), true, "spoken 'lemme' matches target 'let'");
assert.strictEqual(contractionsMatch('aint', 'is'), true, "spoken 'aint' matches target 'is'");
console.log('New contraction entries: 6 tests passed');

var buildLyricVocabulary = fakeModule.exports.buildLyricVocabulary;
(function () {
    var lyrics = [
        { time: 0, text: 'Roughneck cutthroat roughneck' },
        { time: 2, text: 'the a I go to (swizz) beat!' },
        { time: 4, text: 'muzzle muzzle muzzle' }
    ];
    var words = buildLyricVocabulary(lyrics, 800).split(' ');
    assert.ok(words.indexOf('roughneck') >= 0 && words.indexOf('cutthroat') >= 0, 'includes uncommon words');
    assert.ok(words.indexOf('swizz') >= 0, 'punctuation stripped, swizz included');
    assert.strictEqual(words.filter(function (w) { return w === 'roughneck'; }).length, 1, 'roughneck deduped');
    assert.strictEqual(words.indexOf('the'), -1, 'short common word "the" dropped');
    assert.strictEqual(words.indexOf('go'), -1, 'short word "go" (<4) dropped');
    assert.strictEqual(buildLyricVocabulary(lyrics, 12), 'roughneck', 'cap trims to whole words');
    assert.strictEqual(buildLyricVocabulary([], 800), '', 'empty lyrics -> empty vocab');
    assert.strictEqual(buildLyricVocabulary(null, 800), '', 'null lyrics -> empty vocab');
})();
console.log('buildLyricVocabulary: tests passed');
