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
var scoring = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'scoring.js'), {
    require: function(specifier) {
        if (specifier === './match-helpers.js') return matchHelpers;
        if (specifier === './sync-helpers.js') return syncHelpers;
        throw new Error('Unexpected require: ' + specifier);
    },
    globalThis: globalThis
});

assert.strictEqual(scoring.normalizeWord("Don't,"), 'dont');
assert.deepStrictEqual(scoring.normalizeWords('  My   boy  '), ['my', 'boy']);

var exact = scoring.wordsMatchScore('living', 'living');
assert.deepStrictEqual(exact, { score: 1.0, method: 'exact' });

var suffix = scoring.wordsMatchScore('livin', 'living');
assert.deepStrictEqual(suffix, { score: 1.0, method: 'exact' });

var slang = scoring.wordsMatchScore('duck', 'fuck');
assert.strictEqual(slang.method, 'slang');
assert.strictEqual(slang.score, 0.9);

var lyrics = [
    { time: 0, text: 'My boy' },
    { time: 2, text: 'let it fly' }
];
var allTimings = scoring.interpolateWordTimings(lyrics);
assert.strictEqual(allTimings.length, 2);
assert.strictEqual(allTimings[0].length, 2);
assert.strictEqual(allTimings[0].tempoClass, 'slow');
assert.ok(allTimings[0][0].windowStart <= 0, 'short slow lines open slightly early');

var lineWords = ['my', 'boy', 'yeah'];
var wordTimings = [
    { weight: 1.0 },
    { weight: 1.0 },
    { weight: 0.25 }
];
var matchedSet = new Map([[0, 1.0], [1, 0.8], [2, 1.0]]);
var vadMatchedSet = new Map([[2, 1.0]]);
var asrConfirmedSet = new Set([0, 1]);
var summary = scoring.computeLineScore(lineWords, wordTimings, matchedSet, vadMatchedSet, asrConfirmedSet);

assert.strictEqual(summary.totalWords, 3);
assert.strictEqual(summary.matchedWords, 3);
assert.strictEqual(summary.weightedTotal, 2.25);
assert.strictEqual(summary.weightedMatched, 1.8625);
assert.deepStrictEqual(summary.missedWordIndices, []);
assert.strictEqual(summary.perfect, false);

var missed = scoring.computeLineScore(['free', 'mind'], [{ weight: 1.0 }, { weight: 1.0 }], new Map(), new Map(), new Set());
assert.deepStrictEqual(missed.missedWords, ['free', 'mind']);
assert.deepStrictEqual(missed.missedWordIndices, [0, 1]);

console.log('All scoring tests passed.');
