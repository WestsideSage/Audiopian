// Tests for the target-directional ASR-mishearing bridge.
// Spec: docs/superpowers/specs/2026-06-25-asr-mishearing-map-design.md
//
// A lyric word sung with non-standard stress can be transcribed as a
// phonetically-distant common word (drawn-out "Go-rilla" -> "really"). The
// bridge credits the real lyric word, but ONLY when the lyric target is a
// registered key — so it can never credit the reverse and never affects songs
// whose lyric is the (common) substitute word.

var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

global.audio = { duration: 12 };

function loadBrowserCommonJs(filePath, extraArgs) {
    var code = fs.readFileSync(filePath, 'utf8');
    var fakeModule = { exports: {} };
    var argNames = ['module', 'exports'].concat(Object.keys(extraArgs || {}));
    var argValues = [fakeModule, fakeModule.exports].concat(Object.values(extraArgs || {}));
    var fn = new Function(argNames.join(','), code);
    fn.apply(null, argValues);
    return fakeModule.exports;
}

var matchHelpers = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'match-helpers.js'));
var syncHelpers = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'sync-helpers.js'));
var profanity = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'profanity.js'));
var scoring = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'scoring.js'), {
    require: function(specifier) {
        if (specifier === './match-helpers.js') return matchHelpers;
        if (specifier === './sync-helpers.js') return syncHelpers;
        if (specifier === './profanity.js') return profanity;
        throw new Error('Unexpected require: ' + specifier);
    },
    globalThis: globalThis
});

var mishearingMatch = matchHelpers.mishearingMatch;
var ASR_MISHEARINGS = matchHelpers.ASR_MISHEARINGS;
var wordsMatchScore = scoring.wordsMatchScore;
var wordsMatch = scoring.wordsMatch;

// --- map shape ---
assert.ok(ASR_MISHEARINGS && typeof ASR_MISHEARINGS === 'object',
    'ASR_MISHEARINGS should be exported as an object');
assert.deepStrictEqual(ASR_MISHEARINGS['gorilla'], ['really'],
    'gorilla should register "really" as a known mishearing');

// --- 1. credits the registered mishearing ---
assert.strictEqual(mishearingMatch('really', 'gorilla'), true,
    '"really" should bridge to lyric target "gorilla"');
assert.deepStrictEqual(wordsMatchScore('really', 'gorilla'), { score: 0.9, method: 'mishearing' },
    'wordsMatchScore should credit the mishearing at 0.9 with method "mishearing"');
assert.strictEqual(wordsMatch('really', 'gorilla'), true,
    'wordsMatch (boolean) should also accept the mishearing');

// --- 2. directionality: the reverse must NOT be credited ---
assert.strictEqual(mishearingMatch('gorilla', 'really'), false,
    'singing "gorilla" must not credit a "really" lyric (one-directional)');
assert.strictEqual(wordsMatchScore('gorilla', 'really').method !== 'mishearing', true,
    'wordsMatchScore must not use the mishearing path in reverse');

// --- 3. honesty: an unregistered target is unaffected ---
assert.strictEqual(mishearingMatch('really', 'banana'), false,
    '"really" must not credit an unregistered target like "banana"');
assert.strictEqual(mishearingMatch('really', 'really'), false,
    'a non-key target ("really" is not a key) is never bridged — exact handles real hits');

// --- 4. regression: existing behavior unchanged ---
assert.deepStrictEqual(wordsMatchScore('really', 'really'), { score: 1.0, method: 'exact' },
    'exact match still wins for identical words');
assert.strictEqual(wordsMatchScore('really', 'xylophone').score, 0,
    'unrelated, unregistered pair still scores 0');

console.log('test_mishearing.cjs: all assertions passed');
