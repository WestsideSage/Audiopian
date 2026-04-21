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

var matchCases = [
    { spoken: 'living', target: 'living', method: 'exact', score: 1.0 },
    { spoken: 'livin', target: 'living', method: 'exact', score: 1.0 },
    { spoken: 'smokin', target: 'smoking', method: 'exact', score: 1.0 },
    { spoken: 'rollin', target: 'rolling', method: 'exact', score: 1.0 },
    { spoken: 'gonna', target: 'going', method: 'contraction', score: 1.0 },
    { spoken: 'bouta', target: 'about', method: 'contraction', score: 1.0 },
    { spoken: 'kinda', target: 'kind', method: 'contraction', score: 1.0 },
    { spoken: 'tryna', target: 'trying', method: 'contraction', score: 1.0 },
    { spoken: 'duck', target: 'fuck', method: 'slang', score: 0.9 },
    { spoken: 'beach', target: 'bitch', method: 'slang', score: 0.9 },
    { spoken: 'neighbor', target: 'nigga', method: 'slang', score: 0.9 },
    { spoken: 'yo', target: 'you', method: 'slang', score: 0.9 },
    { spoken: 'with', target: 'wit', method: 'slang', score: 0.9 },
    { spoken: 'ducked', target: 'fucked', method: 'slang', score: 0.9 },
    { spoken: 'cereal', target: 'serial', method: 'phonetic', score: 0.8 },
    { spoken: 'cellar', target: 'seller', method: 'phonetic', score: 0.8 },
    { spoken: 'flower', target: 'flour', method: 'phonetic', score: 0.8 },
    { spoken: 'their', target: 'there', method: 'phonetic', score: 0.8 },
    { spoken: 'night', target: 'nite', method: 'phonetic', score: 0.8 },
    { spoken: 'knight', target: 'night', method: 'phonetic', score: 0.8 },
    { spoken: 'write', target: 'right', method: 'phonetic', score: 0.8 },
    { spoken: 'cent', target: 'sent', method: 'edit1', score: 0.75 },
    { spoken: 'cite', target: 'site', method: 'edit1', score: 0.75 },
    { spoken: 'minde', target: 'minds', method: 'edit1', score: 0.75 },
    { spoken: 'worlf', target: 'world', method: 'edit1', score: 0.75 },
    { spoken: 'cat', target: 'dog', method: 'none', score: 0.0 },
    { spoken: 'alpha', target: 'omega', method: 'none', score: 0.0 },
    { spoken: 'going', target: 'gonna', method: 'none', score: 0.0 },
    { spoken: 'tree', target: 'sky', method: 'none', score: 0.0 },
    { spoken: 'phase', target: 'faze', method: 'none', score: 0.0 }
];

matchCases.forEach(function(testCase) {
    var result = scoring.wordsMatchScore(
        testCase.spoken,
        testCase.target,
        scoring.doubleMetaphone(testCase.target)
    );
    assert.strictEqual(result.method, testCase.method, testCase.spoken + ' -> ' + testCase.target + ' method');
    assert.strictEqual(result.score, testCase.score, testCase.spoken + ' -> ' + testCase.target + ' score');
});

var lyrics = [
    { time: 0, text: 'My boy' },
    { time: 2, text: 'let it fly' }
];
var allTimings = scoring.interpolateWordTimings(lyrics);
assert.strictEqual(allTimings.length, 2);
assert.strictEqual(allTimings[0].length, 2);
assert.strictEqual(allTimings[0].tempoClass, 'slow');
assert.ok(allTimings[0][0].windowStart <= 0, 'short slow lines open slightly early');

function assertClose(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) < 1e-9, label + ': expected ' + expected + ', got ' + actual);
}

var lineCases = [
    {
        label: 'empty line',
        args: [[], [], new Map(), new Map(), new Set()],
        expected: { totalWords: 0, matchedWords: 0, weightedTotal: 0, weightedMatched: 0, missedWordIndices: [], missedWords: [], perfect: false }
    },
    {
        label: 'all exact',
        args: [['my', 'boy'], [{ weight: 1.0 }, { weight: 1.0 }], new Map([[0, 1.0], [1, 1.0]]), new Map(), new Set()],
        expected: { totalWords: 2, matchedWords: 2, weightedTotal: 2.0, weightedMatched: 2.0, missedWordIndices: [], missedWords: [], perfect: true }
    },
    {
        label: 'exactly ninety percent threshold',
        args: [['free', 'mind'], [{ weight: 1.0 }, { weight: 1.0 }], new Map([[0, 0.8], [1, 1.0]]), new Map(), new Set()],
        expected: { totalWords: 2, matchedWords: 2, weightedTotal: 2.0, weightedMatched: 1.8, missedWordIndices: [], missedWords: [], perfect: true }
    },
    {
        label: 'below threshold',
        args: [['free', 'mind'], [{ weight: 1.0 }, { weight: 1.0 }], new Map([[0, 0.79], [1, 1.0]]), new Map(), new Set()],
        expected: { totalWords: 2, matchedWords: 2, weightedTotal: 2.0, weightedMatched: 1.79, missedWordIndices: [], missedWords: [], perfect: false }
    },
    {
        label: 'vad only downgraded',
        args: [['hey'], [{ weight: 1.0 }], new Map([[0, 1.0]]), new Map([[0, 1.0]]), new Set()],
        expected: { totalWords: 1, matchedWords: 1, weightedTotal: 1.0, weightedMatched: 0.0, missedWordIndices: [0], missedWords: ['hey'], perfect: false }
    },
    {
        label: 'vad confirmed by asr keeps full credit',
        args: [['hey'], [{ weight: 1.0 }], new Map([[0, 1.0]]), new Map([[0, 1.0]]), new Set([0])],
        expected: { totalWords: 1, matchedWords: 1, weightedTotal: 1.0, weightedMatched: 1.0, missedWordIndices: [], missedWords: [], perfect: true }
    },
    {
        label: 'mixed weights with adlib',
        args: [['my', 'boy', 'yeah'], [{ weight: 1.0 }, { weight: 1.0 }, { weight: 0.25 }], new Map([[0, 1.0], [1, 0.8], [2, 1.0]]), new Map([[2, 1.0]]), new Set([0, 1])],
        expected: { totalWords: 3, matchedWords: 3, weightedTotal: 2.25, weightedMatched: 1.8, missedWordIndices: [2], missedWords: ['yeah'], perfect: false }
    },
    {
        label: 'missed words tracked',
        args: [['free', 'your', 'mind'], [{ weight: 1.0 }, { weight: 0.5 }, { weight: 1.0 }], new Map([[1, 1.0]]), new Map(), new Set()],
        expected: { totalWords: 3, matchedWords: 1, weightedTotal: 2.5, weightedMatched: 0.5, missedWordIndices: [0, 2], missedWords: ['free', 'mind'], perfect: false }
    },
    {
        label: 'set fallback works',
        args: [['a', 'b', 'c'], [{ weight: 1.0 }, { weight: 1.0 }, { weight: 1.0 }], new Set([0, 2]), new Map(), new Set()],
        expected: { totalWords: 3, matchedWords: 2, weightedTotal: 3.0, weightedMatched: 2.0, missedWordIndices: [1], missedWords: ['b'], perfect: false }
    },
    {
        label: 'null matches means all missed',
        args: [['free', 'mind'], [{ weight: 1.0 }, { weight: 1.0 }], null, new Map(), new Set()],
        expected: { totalWords: 2, matchedWords: 0, weightedTotal: 2.0, weightedMatched: 0.0, missedWordIndices: [0, 1], missedWords: ['free', 'mind'], perfect: false }
    },
    {
        label: 'zero score entry ignored',
        args: [['free', 'mind'], [{ weight: 1.0 }, { weight: 1.0 }], new Map([[0, 0], [1, 1.0]]), new Map(), new Set([1])],
        expected: { totalWords: 2, matchedWords: 1, weightedTotal: 2.0, weightedMatched: 1.0, missedWordIndices: [0], missedWords: ['free'], perfect: false }
    },
    {
        label: 'confirmed and unconfirmed vad mix',
        args: [['one', 'two'], [{ weight: 1.0 }, { weight: 1.0 }], new Map([[0, 1.0], [1, 1.0]]), new Map([[0, 1.0], [1, 1.0]]), new Set([1])],
        expected: { totalWords: 2, matchedWords: 2, weightedTotal: 2.0, weightedMatched: 1.0, missedWordIndices: [0], missedWords: ['one'], perfect: false }
    },
    {
        label: 'low weight miss still fails threshold',
        args: [['free', 'your', 'mind'], [{ weight: 1.0 }, { weight: 1.0 }, { weight: 0.25 }], new Map([[0, 1.0], [1, 1.0]]), new Map(), new Set([0, 1])],
        expected: { totalWords: 3, matchedWords: 2, weightedTotal: 2.25, weightedMatched: 2.0, missedWordIndices: [2], missedWords: ['mind'], perfect: false }
    },
    {
        label: 'adlib only can still be perfect',
        args: [['yeah'], [{ weight: 0.25 }], new Map([[0, 1.0]]), new Map(), new Set([0])],
        expected: { totalWords: 1, matchedWords: 1, weightedTotal: 0.25, weightedMatched: 0.25, missedWordIndices: [], missedWords: [], perfect: true }
    },
    {
        label: 'partial exact mix remains perfect on weighted total',
        args: [['free', 'your', 'mind'], [{ weight: 1.0 }, { weight: 0.5 }, { weight: 1.0 }], new Map([[0, 1.0], [1, 0.8], [2, 1.0]]), new Map(), new Set([0, 1, 2])],
        expected: { totalWords: 3, matchedWords: 3, weightedTotal: 2.5, weightedMatched: 2.4, missedWordIndices: [], missedWords: [], perfect: true }
    }
];

lineCases.forEach(function(testCase) {
    var actual = scoring.computeLineScore.apply(null, testCase.args);
    assert.strictEqual(actual.totalWords, testCase.expected.totalWords, testCase.label + ' totalWords');
    assert.strictEqual(actual.matchedWords, testCase.expected.matchedWords, testCase.label + ' matchedWords');
    assertClose(actual.weightedTotal, testCase.expected.weightedTotal, testCase.label + ' weightedTotal');
    assertClose(actual.weightedMatched, testCase.expected.weightedMatched, testCase.label + ' weightedMatched');
    assert.deepStrictEqual(actual.missedWordIndices, testCase.expected.missedWordIndices, testCase.label + ' missedWordIndices');
    assert.deepStrictEqual(actual.missedWords, testCase.expected.missedWords, testCase.label + ' missedWords');
    assert.strictEqual(actual.perfect, testCase.expected.perfect, testCase.label + ' perfect');
});

var repeatedTargets = scoring.collectSequentialWordMatches(
    ['la'],
    ['la', 'la', 'la'],
    [{ phonetic: scoring.doubleMetaphone('la') }, { phonetic: scoring.doubleMetaphone('la') }, { phonetic: scoring.doubleMetaphone('la') }]
);
assert.deepStrictEqual(Array.from(repeatedTargets.keys()), [0], 'one spoken token should only credit one repeated target slot');

console.log('All scoring tests passed.');
