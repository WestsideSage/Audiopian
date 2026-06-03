var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Mirror the loader pattern from tests/test_phrase_engine.cjs: phrase-engine.js
// requires ./scoring.js and ./match-helpers.js, and scoring.js in turn requires
// ./match-helpers.js and ./sync-helpers.js — we inject all of them by hand so the
// browser CommonJS UMD modules resolve under Node without a build step.
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

var EPS = 1e-9;
function approx(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) < EPS,
        label + ': expected ' + expected + ', got ' + actual);
}
function inUnit(value, label) {
    assert.ok(typeof value === 'number' && isFinite(value), label + ' is a finite number');
    assert.ok(value >= 0 && value <= 1, label + ' in [0,1]: got ' + value);
}

var FIXTURE = [
    { time: 0, text: 'alpha bravo final' },
    { time: 3, text: 'charlie delta last' }
];

// getLiveScore returns { lyrics, conviction, composite }. Definitions (honest given
// lagged recognizer evidence and no true word onsets):
//   lyrics     = global anchorsHit / anchorsRequired (coverage of distinctive words)
//   conviction = of phrases you ENGAGED (hit >=1 anchor), the fraction you fully
//                cleared (lyricStatus 'confirmed' vs 'partial'). Source-independent —
//                Whisper-rescued clears count exactly like browser clears.
//   composite  = 0.75*lyrics + 0.25*conviction
// Timing is intentionally NOT scored: a phrase that clears did so in-window by
// definition, and "late" evidence is recognizer lag, not the singer's error — a fair
// timing axis needs real word onsets (forced alignment), a later stage.

// --- Precondition: each fixture phrase yields exactly 3 anchors at easy/expert ---
(function preconditions() {
    ['easy', 'expert'].forEach(function(difficulty) {
        var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: difficulty, audioDuration: 6 });
        assert.strictEqual(plan.phrases.length, 2, difficulty + ': two phrases');
        assert.strictEqual(plan.phrases[0].anchors.length, 3, difficulty + ': p0 has 3 anchors');
        assert.strictEqual(plan.phrases[1].anchors.length, 3, difficulty + ': p1 has 3 anchors');
    });
    var easy = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var expert = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'expert', audioDuration: 6 });
    assert.strictEqual(easy.phrases[0].anchorsRequired, 1, 'easy requires 1 anchor');
    assert.strictEqual(expert.phrases[0].anchorsRequired, 3, 'expert requires 3 anchors');
})();

// --- 1. lyrics == globalHit/globalRequired; conviction full when engaged==confirmed -
// easy: hit 2 anchors on p0 (capped to required=1 -> confirmed), p1 untargeted (missing).
// sumHit = min(2,1)+min(0,1) = 1 ; sumReq = 1+1 = 2 -> lyrics 0.5.
// engaged = {p0 confirmed} only -> conviction = 1/1 = 1.0.
(function lyricsAndConviction() {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    phraseEngine.addEvidence(session, {
        id: 'final-1', source: 'browser_final', text: 'alpha bravo',
        words: [{ word: 'alpha', start: 1.0, end: 1.3 }, { word: 'bravo', start: 1.4, end: 1.7 }],
        receivedAtSec: 1.7, audioTimeSec: 1.7
    });
    phraseEngine.settlePhrases(session, 9.0);

    var trace = phraseEngine.getPhraseTrace(session);
    var p0 = trace.find(function(t) { return t.phraseId === 'p0'; });
    var p1 = trace.find(function(t) { return t.phraseId === 'p1'; });
    assert.ok(p0.anchorsHit >= 2, 'p0 records at least 2 anchor hits, got ' + p0.anchorsHit);
    assert.strictEqual(p1.anchorsHit, 0, 'p1 untargeted has 0 hits');

    var score = phraseEngine.getLiveScore(session);
    inUnit(score.lyrics, 'lyrics');
    inUnit(score.conviction, 'conviction');
    inUnit(score.composite, 'composite');
    assert.ok(!('timing' in score), 'timing is not part of the score');
    assert.ok(!('stability' in score), 'stability is not part of the score');

    var sumHit = Math.min(p0.anchorsHit, p0.anchorsRequired) + Math.min(p1.anchorsHit, p1.anchorsRequired);
    var sumReq = p0.anchorsRequired + p1.anchorsRequired;
    approx(score.lyrics, sumHit / sumReq, 'lyrics equals global hit/required');
    approx(score.lyrics, 0.5, 'lyrics is 0.5 for this scripted run');
    approx(score.conviction, 1.0, 'engaged phrase was confirmed -> conviction 1.0');
    approx(score.composite, 0.75 * score.lyrics + 0.25 * score.conviction, 'composite is the weighted sum');
})();

// --- 2. A partial (engaged-but-not-cleared) phrase drops conviction ----------
// expert: required 3; feed only 2 anchors on p0 -> lyricStatus 'partial' (engaged,
// not confirmed) -> conviction = confirmed(0) / engaged(1) = 0.
(function partialDropsConviction() {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'expert', audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    phraseEngine.addEvidence(session, {
        id: 'partial-1', source: 'browser_final', text: 'alpha bravo',
        words: [{ word: 'alpha', start: 1.0, end: 1.3 }, { word: 'bravo', start: 1.4, end: 1.7 }],
        receivedAtSec: 1.7, audioTimeSec: 1.7
    });
    phraseEngine.settlePhrases(session, 9.0);

    var p0 = phraseEngine.getPhraseTrace(session).find(function(t) { return t.phraseId === 'p0'; });
    assert.strictEqual(p0.lyricStatus, 'partial', 'two of three required anchors -> partial');

    var score = phraseEngine.getLiveScore(session);
    inUnit(score.conviction, 'conviction');
    assert.ok(score.conviction < 1.0, 'a partial engaged phrase drops conviction below 1.0, got ' + score.conviction);
    approx(score.conviction, 0, 'one engaged phrase, none confirmed -> conviction 0');
})();

// --- 3. A Whisper-rescued clear does NOT penalize the score (the fix) --------
// whisper credit clears p0 (rescuedByWhisper=true); conviction must stay 1.0 because
// the phrase is confirmed — Whisper helping is not a defect.
(function whisperRescueNotPenalized() {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    phraseEngine.addEvidence(session, {
        id: 'whisper-1', source: 'whisper', text: 'final',
        words: [{ word: 'final', start: 1.5, end: 1.8 }],
        receivedAtSec: 1.8, audioTimeSec: 1.8
    });
    phraseEngine.settlePhrases(session, 9.0);

    var p0 = phraseEngine.getPhraseTrace(session).find(function(t) { return t.phraseId === 'p0'; });
    assert.strictEqual(p0.cleared, true, 'whisper credit clears the phrase');
    assert.strictEqual(p0.rescuedByWhisper, true, 'whisper-sourced credit flags rescue');

    var score = phraseEngine.getLiveScore(session);
    inUnit(score.conviction, 'conviction');
    approx(score.conviction, 1.0, 'whisper-rescued confirmed phrase keeps conviction 1.0 (no source penalty)');
})();

// --- 4. expert composite < easy composite for identical evidence ------------
// Clean, in-window evidence hitting 2 of 3 anchors on BOTH phrases:
//   easy   (req 1 each): both confirmed -> lyrics 1.0, conviction 1.0 -> composite 1.0
//   expert (req 3 each): both partial   -> lyrics 4/6, conviction 0   -> composite 0.5
function buildCleanSession(difficulty) {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: difficulty, audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    phraseEngine.addEvidence(session, {
        id: difficulty + '-p0', source: 'browser_final', text: 'alpha bravo',
        words: [{ word: 'alpha', start: 1.0, end: 1.3 }, { word: 'bravo', start: 1.4, end: 1.7 }],
        receivedAtSec: 1.7, audioTimeSec: 1.7
    });
    phraseEngine.addEvidence(session, {
        id: difficulty + '-p1', source: 'browser_final', text: 'charlie delta',
        words: [{ word: 'charlie', start: 4.0, end: 4.3 }, { word: 'delta', start: 4.4, end: 4.7 }],
        receivedAtSec: 4.7, audioTimeSec: 4.7
    });
    phraseEngine.settlePhrases(session, 9.0);
    return session;
}

(function difficultyOrdering() {
    var easyScore = phraseEngine.getLiveScore(buildCleanSession('easy'));
    var expertScore = phraseEngine.getLiveScore(buildCleanSession('expert'));

    [['easy', easyScore], ['expert', expertScore]].forEach(function(pair) {
        inUnit(pair[1].lyrics, pair[0] + '.lyrics');
        inUnit(pair[1].conviction, pair[0] + '.conviction');
        inUnit(pair[1].composite, pair[0] + '.composite');
    });

    approx(easyScore.lyrics, 1.0, 'easy lyrics 1.0 (2 hits >= 1 required, capped)');
    approx(easyScore.conviction, 1.0, 'easy: both engaged phrases confirmed -> conviction 1.0');
    approx(easyScore.composite, 1.0, 'easy composite 1.0');

    approx(expertScore.lyrics, 4 / 6, 'expert lyrics global 4/6');
    approx(expertScore.conviction, 0, 'expert: both engaged phrases only partial -> conviction 0');
    approx(expertScore.composite, 0.75 * (4 / 6), 'expert composite 0.5');

    assert.ok(expertScore.composite < easyScore.composite,
        'expert composite strictly below easy for partial hits, got expert ' +
        expertScore.composite + ' vs easy ' + easyScore.composite);
})();

console.log('Phrase score tests passed.');
