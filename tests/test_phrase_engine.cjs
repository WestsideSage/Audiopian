var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

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
var phraseEngine = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'phrase-engine.js'), {
    require: function(specifier) {
        if (specifier === './scoring.js') return scoring;
        if (specifier === './match-helpers.js') return matchHelpers;
        throw new Error('Unexpected require: ' + specifier);
    },
    globalThis: globalThis
});

var lyrics = [
    { time: 10, text: 'First bar hits hard with a final word' },
    { time: 14, text: 'Second bar starts fast' },
    { time: 18, text: 'yeah yeah' }
];

var plan = phraseEngine.buildPhrasePlan(lyrics, { difficulty: 'hard', audioDuration: 22 });

assert.ok(plan.phrases.length >= 3, 'builds phrases from lyric lines');
assert.strictEqual(plan.phrases[0].lineIdx, 0, 'preserves source line index');
assert.strictEqual(plan.phrases[0].startSec, 10, 'uses lyric timestamp as phrase start');
assert.strictEqual(plan.phrases[0].endSec, 14, 'uses next lyric timestamp as phrase end');
assert.ok(plan.phrases[0].anchors.some(function(anchor) { return anchor.word === 'final'; }), 'selects distinctive anchors');
// Filler-only lines ("yeah yeah", "uh uh") fall back to filler-marked anchors so the
// phrase can still be scored when Whisper transcribes them.
assert.ok(plan.phrases[2].anchors.some(function(anchor) { return anchor.word === 'yeah'; }), 'filler-only lines fall back to filler anchors');
assert.ok(plan.phrases[2].anchors.every(function(anchor) { return anchor.fillerOnly === true; }), 'fallback anchors are marked fillerOnly');
assert.ok(plan.phrases[0].anchors.every(function(anchor) { return !anchor.fillerOnly; }), 'normal anchors are not marked fillerOnly');
assert.ok(plan.difficulty.requiredAnchorRatio > 0.5, 'hard profile requires meaningful anchor coverage');

var settlementPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'alpha bravo final' },
    { time: 3, text: 'charlie delta start' }
], { difficulty: 'hard', audioDuration: 7 });
var session = phraseEngine.createPhraseSession(settlementPlan);

phraseEngine.addEvidence(session, {
    id: 'browser-1',
    source: 'browser_final',
    text: 'alpha bravo final charlie',
    words: [],
    receivedAtSec: 3.2,
    audioTimeSec: 3.2
});
phraseEngine.addEvidence(session, {
    id: 'vad-1',
    source: 'vad',
    text: '',
    words: [],
    receivedAtSec: 3.35,
    audioTimeSec: 3.35
});
phraseEngine.addEvidence(session, {
    id: 'whisper-1',
    source: 'whisper',
    text: 'delta start',
    words: [],
    receivedAtSec: 4.0,
    audioTimeSec: 3.8
});
phraseEngine.settlePhrases(session, 4.2);

var trace = phraseEngine.getPhraseTrace(session);
var phrase0 = trace.find(function(item) { return item.phraseId === 'p0'; });
var phrase1 = trace.find(function(item) { return item.phraseId === 'p1'; });

assert.ok(phrase0, 'phrase 0 trace exists');
assert.ok(phrase1, 'phrase 1 trace exists');
assert.strictEqual(phrase0.lyricStatus, 'confirmed', 'browser final confirms phrase 0 during settlement');
assert.strictEqual(phrase0.flowStatus, 'late', 'late-but-correct phrase 0 evidence is marked late');
assert.strictEqual(phrase0.accuracyStatus, 'confirmed', 'late-but-correct phrase 0 confirms accuracy');
assert.strictEqual(phrase0.cleared, true, 'confirmed phrase clears');
assert.ok(phrase0.evidence.some(function(item) { return item.source === 'browser_final'; }), 'browser final is normal settlement evidence');
assert.ok(phrase1.consumedTokens.some(function(token) { return token.word === 'charlie'; }), 'charlie credits phrase 1');
assert.ok(!phrase0.consumedTokens.some(function(token) { return token.word === 'charlie'; }), 'charlie is not consumed by phrase 0');
assert.ok(phrase1.flowEvents.some(function(item) { return item.source === 'vad'; }), 'vad increases flow coverage');
assert.ok(phrase1.anchorsHit > 0, 'vad does not clear anchors by itself');
assert.strictEqual(phrase1.rescuedByWhisper, true, 'whisper can rescue missed anchors');
assert.strictEqual(phrase1.liveClean, false, 'whisper rescue does not mark phrase live clean');
assert.ok(phrase1.rejectedCandidates.some(function(item) { return item.reason === 'weak_source' && item.source === 'vad'; }), 'vad-only lyric evidence is rejected as weak source');

// Filler-only line: phrase clears when Whisper transcribes the filler word
var fillerPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'alpha bravo final' },
    { time: 3, text: 'uh uh' }
], { difficulty: 'medium', audioDuration: 7 });
var fillerSession = phraseEngine.createPhraseSession(fillerPlan);
phraseEngine.addEvidence(fillerSession, {
    id: 'whisper-uh',
    source: 'whisper',
    text: 'uh',
    words: [],
    receivedAtSec: 4.0,
    audioTimeSec: 4.0
});
phraseEngine.settlePhrases(fillerSession, 5.5);
var fillerTrace = phraseEngine.getPhraseTrace(fillerSession);
var fillerPhrase = fillerTrace.find(function(item) { return item.lineIdx === 1; });
assert.ok(fillerPhrase, 'filler-only phrase trace exists');
assert.strictEqual(fillerPhrase.lyricStatus, 'confirmed', 'filler-only phrase confirms when whisper provides the filler word');
assert.ok(fillerPhrase.anchorsHit > 0, 'filler-only phrase records anchor hits');

var longLyrics = [];
for (var i = 0; i < 180; i++) {
    longLyrics.push({ time: i * 2, text: 'alpha bravo charlie delta echo foxtrot' });
}
var longPlan = phraseEngine.buildPhrasePlan(longLyrics, { difficulty: 'medium', audioDuration: 370 });
var longSession = phraseEngine.createPhraseSession(longPlan);
for (var ev = 0; ev < 90; ev++) {
    phraseEngine.addEvidence(longSession, {
        id: 'interim-' + ev,
        source: 'browser_interim',
        text: 'random interim words',
        words: [],
        receivedAtSec: 30,
        audioTimeSec: 30
    });
}
var longTrace = phraseEngine.getPhraseTrace(longSession);
var rejectedTotal = longTrace.reduce(function(total, item) {
    return total + (item.rejectedCandidates || []).length;
}, 0);
var traceJson = JSON.stringify(longTrace);

assert.ok(rejectedTotal <= 500, 'trace rejects stay bounded for long songs');
assert.ok(traceJson.length < 250000, 'trace export remains small enough for end-of-song telemetry');

console.log('Phrase engine tests passed.');
