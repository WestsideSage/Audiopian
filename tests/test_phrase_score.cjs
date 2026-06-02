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

// --- Precondition: each fixture phrase yields exactly 3 anchors at easy/expert ---
// Grounds the denominators used in the lyrics/composite math below.
(function preconditions() {
    ['easy', 'expert'].forEach(function(difficulty) {
        var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: difficulty, audioDuration: 6 });
        assert.strictEqual(plan.phrases.length, 2, difficulty + ': two phrases');
        assert.strictEqual(plan.phrases[0].anchors.length, 3, difficulty + ': p0 has 3 anchors');
        assert.strictEqual(plan.phrases[1].anchors.length, 3, difficulty + ': p1 has 3 anchors');
    });
    var easy = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var expert = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'expert', audioDuration: 6 });
    // easy ratio 0.20 -> ceil(3*0.2)=1 ; expert ratio 0.80 -> ceil(3*0.8)=3
    assert.strictEqual(easy.phrases[0].anchorsRequired, 1, 'easy requires 1 anchor');
    assert.strictEqual(expert.phrases[0].anchorsRequired, 3, 'expert requires 3 anchors');
})();

// --- 1. lyrics == globalHitAnchors / globalRequiredAnchors -----------------
// easy: hit 2 anchors on p0 only (capped to required=1), p1 untargeted (0).
// sumHit = min(2,1) + min(0,1) = 1 ; sumReq = 1 + 1 = 2 -> lyrics = 0.5
(function lyricsExact() {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    phraseEngine.addEvidence(session, {
        id: 'final-1',
        source: 'browser_final',
        text: 'alpha bravo',
        words: [
            { word: 'alpha', start: 1.0, end: 1.3 },
            { word: 'bravo', start: 1.4, end: 1.7 }
        ],
        receivedAtSec: 1.7,
        audioTimeSec: 1.7
    });
    phraseEngine.settlePhrases(session, 9.0);

    var trace = phraseEngine.getPhraseTrace(session);
    var p0 = trace.find(function(t) { return t.phraseId === 'p0'; });
    var p1 = trace.find(function(t) { return t.phraseId === 'p1'; });
    assert.ok(p0.anchorsHit >= 2, 'p0 records at least 2 anchor hits, got ' + p0.anchorsHit);
    assert.strictEqual(p1.anchorsHit, 0, 'p1 untargeted has 0 hits');

    var score = phraseEngine.getLiveScore(session);
    inUnit(score.lyrics, 'lyrics');
    inUnit(score.timing, 'timing');
    inUnit(score.stability, 'stability');
    inUnit(score.composite, 'composite');

    var sumHit = Math.min(p0.anchorsHit, p0.anchorsRequired) + Math.min(p1.anchorsHit, p1.anchorsRequired);
    var sumReq = p0.anchorsRequired + p1.anchorsRequired;
    approx(score.lyrics, sumHit / sumReq, 'lyrics equals global hit/required');
    approx(score.lyrics, 0.5, 'lyrics is 0.5 for this scripted run');
    approx(score.composite,
        0.6 * score.lyrics + 0.25 * score.timing + 0.15 * score.stability,
        'composite is the weighted sum');
})();

// --- 2. A 'late' clear yields timing < 1.0 ---------------------------------
// browser_final lands after endSec but inside the settlement window -> phrase
// clears (cleared=true) but flowStatus='late', so cleanCount=0/clearedCount=1.
(function lateTiming() {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    // p0 ends at 3; easy settlement = 1.8s -> window end 4.8. t=3.4 is late but inside.
    phraseEngine.addEvidence(session, {
        id: 'late-1',
        source: 'browser_final',
        text: 'final',
        words: [{ word: 'final', start: 3.4, end: 3.7 }],
        receivedAtSec: 3.7,
        audioTimeSec: 3.7
    });
    phraseEngine.settlePhrases(session, 9.0);

    var trace = phraseEngine.getPhraseTrace(session);
    var p0 = trace.find(function(t) { return t.phraseId === 'p0'; });
    assert.strictEqual(p0.cleared, true, 'late-but-correct phrase still clears');
    assert.strictEqual(p0.flowStatus, 'late', 'evidence past endSec is marked late');

    var score = phraseEngine.getLiveScore(session);
    inUnit(score.timing, 'timing');
    assert.ok(score.timing < 1.0, 'a late clear drops timing below 1.0, got ' + score.timing);
    approx(score.timing, 0, 'one cleared phrase, none clean -> timing 0');
})();

// --- 3. A whisper-rescued clear yields stability < 1.0 ---------------------
(function whisperRescue() {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: 'easy', audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    // whisper credit in-window for p0 (t=1.5 inside [0,3]) -> clears + rescuedByWhisper.
    phraseEngine.addEvidence(session, {
        id: 'whisper-1',
        source: 'whisper',
        text: 'final',
        words: [{ word: 'final', start: 1.5, end: 1.8 }],
        receivedAtSec: 1.8,
        audioTimeSec: 1.8
    });
    phraseEngine.settlePhrases(session, 9.0);

    var trace = phraseEngine.getPhraseTrace(session);
    var p0 = trace.find(function(t) { return t.phraseId === 'p0'; });
    assert.strictEqual(p0.cleared, true, 'whisper credit clears the phrase');
    assert.strictEqual(p0.rescuedByWhisper, true, 'whisper-sourced credit flags rescue');

    var score = phraseEngine.getLiveScore(session);
    inUnit(score.stability, 'stability');
    assert.ok(score.stability < 1.0, 'a whisper rescue drops stability below 1.0, got ' + score.stability);
    approx(score.stability, 0, 'one cleared phrase, all rescued -> stability 0');
})();

// --- 4. expert composite <= easy composite for identical evidence ----------
// Clean, in-window, non-whisper evidence hitting 2 of 3 anchors on BOTH phrases
// keeps timing=1 and stability=1 in both difficulties, so only lyrics moves:
//   easy   (req 1 each): sumHit=min(2,1)+min(2,1)=2 / sumReq=2 -> lyrics 1.0  -> composite 1.0
//   expert (req 3 each): sumHit=min(2,3)+min(2,3)=4 / sumReq=6 -> lyrics 0.667 -> composite 0.8
function buildCleanSession(difficulty) {
    var plan = phraseEngine.buildPhrasePlan(FIXTURE, { difficulty: difficulty, audioDuration: 6 });
    var session = phraseEngine.createPhraseSession(plan);
    // p0: 2 anchors, in-window and before endSec=3 -> clean.
    phraseEngine.addEvidence(session, {
        id: difficulty + '-p0',
        source: 'browser_final',
        text: 'alpha bravo',
        words: [
            { word: 'alpha', start: 1.0, end: 1.3 },
            { word: 'bravo', start: 1.4, end: 1.7 }
        ],
        receivedAtSec: 1.7,
        audioTimeSec: 1.7
    });
    // p1: 2 anchors, in-window and before endSec=6 -> clean.
    phraseEngine.addEvidence(session, {
        id: difficulty + '-p1',
        source: 'browser_final',
        text: 'charlie delta',
        words: [
            { word: 'charlie', start: 4.0, end: 4.3 },
            { word: 'delta', start: 4.4, end: 4.7 }
        ],
        receivedAtSec: 4.7,
        audioTimeSec: 4.7
    });
    phraseEngine.settlePhrases(session, 9.0);
    return session;
}

(function difficultyOrdering() {
    var easySession = buildCleanSession('easy');
    var expertSession = buildCleanSession('expert');

    var easyScore = phraseEngine.getLiveScore(easySession);
    var expertScore = phraseEngine.getLiveScore(expertSession);

    [easyScore, expertScore].forEach(function(s, i) {
        var name = i === 0 ? 'easy' : 'expert';
        inUnit(s.lyrics, name + '.lyrics');
        inUnit(s.timing, name + '.timing');
        inUnit(s.stability, name + '.stability');
        inUnit(s.composite, name + '.composite');
    });

    // Isolation: clean non-whisper evidence keeps timing/stability pinned at 1 in both.
    approx(easyScore.timing, 1, 'easy timing pinned at 1 (clean)');
    approx(easyScore.stability, 1, 'easy stability pinned at 1 (no whisper)');
    approx(expertScore.timing, 1, 'expert timing pinned at 1 (clean)');
    approx(expertScore.stability, 1, 'expert stability pinned at 1 (no whisper)');

    assert.ok(expertScore.composite <= easyScore.composite + EPS,
        'expert composite <= easy for identical evidence, got expert ' +
        expertScore.composite + ' vs easy ' + easyScore.composite);
    // Stronger: harder difficulty's larger anchor denominator strictly lowers it here.
    assert.ok(expertScore.composite < easyScore.composite,
        'expert composite strictly below easy for partial hits');
    approx(easyScore.composite, 1.0, 'easy composite 1.0 (full clear at low ratio)');
    approx(expertScore.lyrics, 4 / 6, 'expert lyrics is global 4/6');
    approx(expertScore.composite, 0.6 * (4 / 6) + 0.25 + 0.15, 'expert composite 0.8');
})();

console.log('Phrase score tests passed.');
