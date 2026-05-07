var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

global.audio = { duration: 8 };

function loadBrowserCommonJs(filePath, extraArgs) {
    var code = fs.readFileSync(filePath, 'utf8');
    var fakeModule = { exports: {} };
    var argNames = ['module', 'exports'].concat(Object.keys(extraArgs || {}));
    var argValues = [fakeModule, fakeModule.exports].concat(Object.values(extraArgs || {}));
    var fn = new Function(argNames.join(','), code);
    fn.apply(null, argValues);
    return fakeModule.exports;
}

function toScoreMap(scores) {
    var map = new Map();
    scores.forEach(function(score, idx) {
        if (score > 0) map.set(idx, score);
    });
    return map;
}

function toSet(indices) {
    return new Set(indices || []);
}

function assertClose(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) < 1e-9, label + ': expected ' + expected + ', got ' + actual);
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

var fixturePath = path.join(__dirname, 'fixtures', 'telemetry-replay', 'minimal-session.json');
var telemetry = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

assert.ok(telemetry.replay, 'fixture must include replay inputs');
assert.strictEqual(telemetry.replay.version, 1, 'unsupported replay fixture version');

var lyrics = telemetry.replay.lines.map(function(line, idx) {
    return {
        time: idx * 4,
        text: line.fromText
    };
});
var wordTimings = scoring.interpolateWordTimings(lyrics);

telemetry.replay.lines.forEach(function(line) {
    var lineWords = scoring.normalizeWords(line.fromText);
    var actual = scoring.computeLineScore(
        lineWords,
        wordTimings[line.lineIdx],
        toScoreMap(line.matchedScores || []),
        toSet(line.vadMatchedIndices),
        toSet(line.asrConfirmedIndices)
    );
    var expected = line.expected;
    var transition = telemetry.transitions.find(function(item) {
        return item.fromIdx === line.lineIdx;
    });

    assert.ok(transition, 'missing transition for line ' + line.lineIdx);
    assert.strictEqual(actual.totalWords, expected.totalWords, line.fromText + ' totalWords');
    assert.strictEqual(actual.matchedWords, expected.matchedWords, line.fromText + ' matchedWords');
    assertClose(actual.weightedMatched, expected.weightedMatched, line.fromText + ' expected weightedMatched');
    assertClose(actual.weightedTotal, expected.weightedTotal, line.fromText + ' expected weightedTotal');
    assert.deepStrictEqual(actual.missedWords, expected.missedWords, line.fromText + ' missedWords');
    assert.strictEqual(actual.perfect, expected.perfect, line.fromText + ' perfect');

    assert.strictEqual(actual.totalWords, transition.totalWords, line.fromText + ' transition totalWords');
    assert.strictEqual(actual.matchedWords, transition.matchedWords, line.fromText + ' transition matchedWords');
    assertClose(actual.weightedMatched, transition.weightedMatched, line.fromText + ' transition weightedMatched');
    assertClose(actual.weightedTotal, transition.weightedTotal, line.fromText + ' transition weightedTotal');
    assert.deepStrictEqual(actual.missedWords, transition.missedWords, line.fromText + ' transition missedWords');
});

if (telemetry.phraseEngine) {
    var traces = telemetry.phraseEngine.traces || [];
    var confirmed = traces.find(function(trace) { return trace.phraseId === 'p0'; });
    var vadOnly = traces.find(function(trace) { return trace.phraseId === 'p1'; });

    assert.ok(confirmed, 'missing confirmed phrase trace');
    assert.strictEqual(confirmed.cleared, true, 'confirmed phrase should clear');
    assert.strictEqual(confirmed.lyricStatus, 'confirmed', 'confirmed phrase lyric status');

    assert.ok(vadOnly, 'missing vad-only phrase trace');
    assert.strictEqual(vadOnly.cleared, false, 'vad-only phrase should not clear');
    assert.ok(
        (vadOnly.rejectedCandidates || []).some(function(candidate) { return candidate.reason === 'weak_source'; }),
        'vad-only trace should explain rejected lyric evidence'
    );
}

console.log('Telemetry replay fixture passed.');
