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
var phraseEngine = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'phrase-engine.js'), {
    require: function(specifier) {
        if (specifier === './scoring.js') return scoring;
        if (specifier === './match-helpers.js') return matchHelpers;
        if (specifier === './profanity.js') return profanity;
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
// Filler-only lines ("yeah yeah", "uh uh") are NOT scoreable: no anchors are
// selected, so anchorsRequired is 0 and the line is excluded from scoring. Adlibs
// are structurally unwinnable (recognizers don't return them) -- they must neither
// help nor hurt the score.
assert.strictEqual(plan.phrases[2].anchors.length, 0, 'filler-only lines get no anchors');
assert.strictEqual(plan.phrases[2].anchorsRequired, 0, 'filler-only lines require no anchors');
assert.ok(plan.phrases[0].anchors.every(function(anchor) { return !anchor.fillerOnly; }), 'normal anchors are not marked fillerOnly');
assert.ok(plan.difficulty.requiredAnchorRatio > 0.5, 'hard profile requires meaningful anchor coverage');

// Insane difficulty: a 5th tier strictly harder than expert.
(function () {
    var ins = phraseEngine.getDifficultyProfile('insane');
    var exp = phraseEngine.getDifficultyProfile('expert');
    assert.ok(ins.requiredAnchorRatio > exp.requiredAnchorRatio, 'insane requires more anchors than expert');
    assert.ok(ins.timingToleranceMs < exp.timingToleranceMs, 'insane timing tighter than expert');
    assert.ok(ins.settlementMs < exp.settlementMs, 'insane settles faster than expert');
    console.log('  ok - insane difficulty profile is harder than expert');
})();

// ---------------------------------------------------------------------------
// Clean mode: profanity excluded from key words; hard-R never an anchor
// ---------------------------------------------------------------------------
(function () {
    var lyr = [{ time: 0, text: 'bitch I run this fucking city' }];
    var exp = phraseEngine.buildPhrasePlan(lyr, { difficulty: 'expert' }).phrases[0];
    var cln = phraseEngine.buildPhrasePlan(lyr, { difficulty: 'expert', clean: true }).phrases[0];
    var clnWords = cln.anchors.map(function (a) { return a.word; });
    assert.ok(clnWords.indexOf('bitch') === -1 && clnWords.indexOf('fucking') === -1, 'clean mode drops profane anchors');
    assert.ok(clnWords.indexOf('run') !== -1 || clnWords.indexOf('city') !== -1, 'clean mode keeps clean key words');
    assert.ok(exp.anchors.map(function (a) { return a.word; }).indexOf('bitch') !== -1, 'explicit mode keeps profanity as an anchor');
})();
(function () {
    var hardR = 'nigga'.replace(/a$/, 'er');   // derived; avoid the literal slur in source
    var lyr = [{ time: 0, text: hardR + ' please listen closely' }];
    var exp = phraseEngine.buildPhrasePlan(lyr, { difficulty: 'expert' }).phrases[0];
    assert.ok(exp.anchors.map(function (a) { return a.word; }).indexOf(hardR) === -1, 'hard-R never an anchor even in explicit mode');
})();
(function () {
    var lyr = [{ time: 0, text: 'fuck shit bitch' }];
    var cln = phraseEngine.buildPhrasePlan(lyr, { difficulty: 'expert', clean: true }).phrases[0];
    assert.strictEqual(cln.anchorsRequired, 0, 'profanity-only line is non-scoring in clean mode');
})();

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

// Filler-only line ("uh uh"): NOT scoreable. No anchors are selected, so even when
// Whisper transcribes the filler word it credits nothing and the line is excluded
// from the score (neither helps nor hurts the singer).
var fillerPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'alpha bravo final' },
    { time: 3, text: 'uh uh' }
], { difficulty: 'medium', audioDuration: 7 });
var fillerLinePhrase = fillerPlan.phrases.find(function(p) { return p.lineIdx === 1; });
assert.ok(fillerLinePhrase, 'filler-only phrase exists in the plan');
assert.strictEqual(fillerLinePhrase.anchors.length, 0, 'filler-only line gets no anchors');
assert.strictEqual(fillerLinePhrase.anchorsRequired, 0, 'filler-only line requires no anchors');
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
var fillerState = fillerSession.states[fillerLinePhrase.phraseId];
assert.strictEqual(Object.keys(fillerState.anchorHits).length, 0, 'filler-only line records no anchor hits even when the filler word is transcribed');
assert.notStrictEqual(fillerState.lyricStatus, 'confirmed', 'filler-only line never confirms (nothing scoreable)');

// Compound-word split: a lyric token "throwdown" that the recognizer emits as two
// tokens ("throw down") is still credited by merging adjacent ASR tokens.
// (Real case: Class of 3000 - Throwdown.)
var compPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'we throwdown hey' },
    { time: 4, text: 'mountain river stone' }
], { difficulty: 'easy', audioDuration: 8 });
var compPhrase = compPlan.phrases.find(function (p) { return p.lineIdx === 0; });
var throwdownAnchor = compPhrase.anchors.find(function (a) { return a.word === 'throwdown'; });
assert.ok(throwdownAnchor, 'precondition: throwdown is selected as an anchor');
var compSession = phraseEngine.createPhraseSession(compPlan);
phraseEngine.addEvidence(compSession, {
    id: 'final-td', source: 'browser_final', text: 'we throw down',
    words: [], receivedAtSec: 1.0, audioTimeSec: 1.0
});
assert.ok(compSession.states[compPhrase.phraseId].anchorHits[throwdownAnchor.anchorIdx],
    'compound anchor "throwdown" credited from the split "throw down" (addEvidence)');

// Same via the late-evidence reconcile path.
var compSession2 = phraseEngine.createPhraseSession(compPlan);
phraseEngine.reconcileLateEvidence(compSession2, {
    id: 'late-td', source: 'browser_final', text: 'we throw down',
    words: [], receivedAtSec: 5.0, audioTimeSec: 3.5
}, 5.0);
assert.ok(compSession2.states[compPhrase.phraseId].anchorHits[throwdownAnchor.anchorIdx],
    'compound anchor "throwdown" credited from the split "throw down" (reconcile)');

// Honesty guard: unrelated adjacent words must NOT merge into a false credit.
var negSession = phraseEngine.createPhraseSession(compPlan);
phraseEngine.addEvidence(negSession, {
    id: 'neg-td', source: 'browser_final', text: 'mountain river',
    words: [], receivedAtSec: 1.0, audioTimeSec: 1.0
});
assert.ok(!negSession.states[compPhrase.phraseId].anchorHits[throwdownAnchor.anchorIdx],
    'unrelated adjacent words do not merge into a false compound credit');

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

// ---------------------------------------------------------------------------
// Late-evidence reconciliation
// ---------------------------------------------------------------------------

// Catch-up: a missed early phrase whose anchor word arrives in much-later
// evidence (within the look-back) gets credited and returned as newly confirmed.
var catchupPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var catchupSession = phraseEngine.createPhraseSession(catchupPlan);
var catchupConfirmed = phraseEngine.reconcileLateEvidence(catchupSession, {
    id: 'late-1', source: 'browser_final', text: 'mountain', words: [],
    receivedAtSec: 20, audioTimeSec: 20
}, 20);
assert.deepStrictEqual(catchupConfirmed, ['p0'], 'catch-up returns the newly-confirmed phrase id');
assert.strictEqual(catchupSession.states['p0'].lyricStatus, 'confirmed', 'catch-up flips a missed phrase to confirmed');
assert.strictEqual(catchupSession.states['p0'].cleared, true, 'catch-up clears the phrase');
assert.ok(
    catchupSession.states['p0'].consumedTokens.some(function(t) { return t.source === 'browser_final_reconciled'; }),
    'reconciled credit is tagged *_reconciled for telemetry audit'
);

// No distant cross-match: the same anchor word outside the look-back window
// does NOT credit the old phrase.
var distantPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'mountain river stone' },
    { time: 4, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 8 });
var distantSession = phraseEngine.createPhraseSession(distantPlan);
var distantConfirmed = phraseEngine.reconcileLateEvidence(distantSession, {
    id: 'late-2', source: 'browser_final', text: 'mountain', words: [],
    receivedAtSec: 30, audioTimeSec: 30
}, 30);
assert.deepStrictEqual(distantConfirmed, [], 'no phrase confirmed when evidence is outside the look-back');
assert.strictEqual(distantSession.states['p0'].lyricStatus, 'missing', 'distant evidence leaves the old phrase missing');
assert.strictEqual(Object.keys(distantSession.states['p0'].anchorHits).length, 0, 'distant evidence credits no anchors');

// Inflation guard (first-class): several un-cleared phrases share an anchor
// word ("fly"). Feeding one line's words must credit ONLY that line — the
// shared word must not light up the others.
var sharedPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'birds can fly' },   // p0: anchors birds, fly
    { time: 4, text: 'watch me fly' },    // p1: anchors watch, fly
    { time: 8, text: 'geese will fly' }   // p2: anchors geese, fly
], { difficulty: 'easy', audioDuration: 12 });
// nowSec=13 is past every phrase's endSec (4, 8, 12) so ALL THREE are genuine
// in-window candidates — the look-back must NOT be what spares p0/p2; monotonic
// attribution + one-credit-per-token must.
var sharedSession = phraseEngine.createPhraseSession(sharedPlan);
var sharedConfirmed = phraseEngine.reconcileLateEvidence(sharedSession, {
    id: 'late-3', source: 'browser_final', text: 'watch me fly', words: [],
    receivedAtSec: 13, audioTimeSec: 13
}, 13);
assert.deepStrictEqual(sharedConfirmed, ['p1'], 'one line\'s batch confirms only that line');
assert.strictEqual(sharedSession.states['p1'].lyricStatus, 'confirmed', 'the sung line is confirmed');
assert.strictEqual(sharedSession.states['p0'].lyricStatus, 'missing', 'the shared "fly" does NOT confirm the earlier line');
assert.strictEqual(sharedSession.states['p2'].lyricStatus, 'missing', 'the shared "fly" does NOT confirm the later line');
assert.strictEqual(Object.keys(sharedSession.states['p0'].anchorHits).length, 0, 'no spurious anchor credit on p0');
assert.strictEqual(Object.keys(sharedSession.states['p2'].anchorHits).length, 0, 'no spurious anchor credit on p2');

// Forward-bleed guard (pre-green): adjacent IDENTICAL hook lines. While line N is
// active the recognizer keeps re-emitting the hook; the live path must NOT spill
// that credit forward onto the next identical phrase before the audio reaches it,
// or that line pre-greens (and inflates) the instant it becomes active.
var hookPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'gorilla go gorilla go go' },
    { time: 2, text: 'gorilla go gorilla go go' },
    { time: 4, text: 'tail end here' }
], { difficulty: 'expert', audioDuration: 6 });
var hookSession = phraseEngine.createPhraseSession(hookPlan);
// Mid line 0 (audio 1.0): credits p0.
phraseEngine.addEvidence(hookSession, {
    id: 'hook-1', source: 'browser_final', text: 'gorilla go gorilla go go', words: [],
    receivedAtSec: 1.0, audioTimeSec: 1.0
});
assert.strictEqual(hookSession.states['p0'].lyricStatus, 'confirmed', 'the active hook line confirms');
// Still inside line 0 (audio 1.9 < p1.start 2.0): the re-recognized hook must NOT credit p1.
phraseEngine.addEvidence(hookSession, {
    id: 'hook-2', source: 'browser_final', text: 'gorilla go gorilla go go', words: [],
    receivedAtSec: 1.9, audioTimeSec: 1.9
});
assert.strictEqual(Object.keys(hookSession.states['p1'].anchorHits).length, 0,
    'next identical hook is NOT pre-credited before the audio reaches it');
assert.notStrictEqual(hookSession.states['p1'].lyricStatus, 'confirmed',
    'next hook line does not pre-green/confirm before its window opens');
// Once the audio is inside line 1 and the singer repeats it, p1 credits normally.
phraseEngine.addEvidence(hookSession, {
    id: 'hook-3', source: 'browser_final', text: 'gorilla go gorilla go go', words: [],
    receivedAtSec: 2.5, audioTimeSec: 2.5
});
assert.strictEqual(hookSession.states['p1'].lyricStatus, 'confirmed',
    'p1 confirms normally once the audio reaches its window');

// Inflation guard, worst ordering: a bare repeated anchor word, fed once,
// credits AT MOST one phrase (cannot inflate every line that holds it).
var bareSession = phraseEngine.createPhraseSession(sharedPlan);
var bareConfirmed = phraseEngine.reconcileLateEvidence(bareSession, {
    id: 'late-4', source: 'browser_final', text: 'fly', words: [],
    receivedAtSec: 13, audioTimeSec: 13
}, 13);
assert.strictEqual(bareConfirmed.length, 1, 'a single shared token credits exactly one phrase, never all of them (all three in-window)');

// Dedup: tokens consumed by a first reconcile pass are not re-credited if the
// same evidence is reconciled again.
var dedupPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var dedupSession = phraseEngine.createPhraseSession(dedupPlan);
var dedupEvidence = {
    id: 'dup-1', source: 'browser_final', text: 'mountain river stone', words: [],
    receivedAtSec: 16, audioTimeSec: 16
};
phraseEngine.reconcileLateEvidence(dedupSession, dedupEvidence, 16);
var dedupHitsAfterFirst = Object.keys(dedupSession.states['p0'].anchorHits).length;
var dedupSecondPass = phraseEngine.reconcileLateEvidence(dedupSession, dedupEvidence, 16);
assert.deepStrictEqual(dedupSecondPass, [], 'a second reconcile of the same evidence confirms nothing new');
assert.strictEqual(
    Object.keys(dedupSession.states['p0'].anchorHits).length, dedupHitsAfterFirst,
    'already-consumed tokens are not re-credited'
);

// Partial -> clear: a phrase needing 2 anchors stays partial after one late
// word and clears when a second late word supplies the missing anchor.
var partialPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'medium', audioDuration: 18 });
assert.ok(partialPlan.phrases[0].anchorsRequired >= 2, 'medium requires >=2 anchors for a 3-anchor line');
var partialSession = phraseEngine.createPhraseSession(partialPlan);
var partialFirst = phraseEngine.reconcileLateEvidence(partialSession, {
    id: 'part-1', source: 'whisper', text: 'mountain', words: [],
    receivedAtSec: 16, audioTimeSec: 16
}, 16);
assert.deepStrictEqual(partialFirst, [], 'one anchor is not enough to confirm a 2-anchor phrase');
assert.strictEqual(partialSession.states['p0'].lyricStatus, 'partial', 'phrase is partial after one anchor');
var partialSecond = phraseEngine.reconcileLateEvidence(partialSession, {
    id: 'part-2', source: 'whisper', text: 'river', words: [],
    receivedAtSec: 17, audioTimeSec: 17
}, 17);
assert.deepStrictEqual(partialSecond, ['p0'], 'the second late anchor clears the phrase');
assert.strictEqual(partialSession.states['p0'].lyricStatus, 'confirmed', 'phrase confirms once both anchors are supplied');

// Cheese safety: filler-only and non-matching words credit nothing.
var cheesePlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var cheeseSession = phraseEngine.createPhraseSession(cheesePlan);
var cheeseFiller = phraseEngine.reconcileLateEvidence(cheeseSession, {
    id: 'cheese-1', source: 'browser_final', text: 'yeah yeah uh oh na', words: [],
    receivedAtSec: 16, audioTimeSec: 16
}, 16);
assert.deepStrictEqual(cheeseFiller, [], 'filler words confirm nothing');
var cheeseWrong = phraseEngine.reconcileLateEvidence(cheeseSession, {
    id: 'cheese-2', source: 'browser_final', text: 'banana orange purple', words: [],
    receivedAtSec: 16, audioTimeSec: 16
}, 16);
assert.deepStrictEqual(cheeseWrong, [], 'non-matching real words confirm nothing');
assert.strictEqual(Object.keys(cheeseSession.states['p0'].anchorHits).length, 0, 'cheese credits no anchors');

// ---------------------------------------------------------------------------
// Interim-snapshot reconciliation: synthesize the per-line "final" that Chrome's
// endpointer won't emit during continuous singing. The browser_sr hypothesis is
// CUMULATIVE (one growing string spanning lines), so the engine must fence words
// it has already consumed — otherwise a shared anchor re-presented in every
// snapshot would inflate lines the singer never reached.
// ---------------------------------------------------------------------------

// (A) A converged interim for a sung, already-ended line credits and clears it,
// the same way a real browser_final would.
var snapPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var snapSession = phraseEngine.createPhraseSession(snapPlan);
// The singer vocalized during the line (energy in [10,14]); recognition just came
// late via the interim. Interim credit now requires that in-window energy.
phraseEngine.addEvidence(snapSession, { id: 'vad-snap0', source: 'vad', text: '', words: [], receivedAtSec: 12, audioTimeSec: 12 });
var snapConfirmed = phraseEngine.reconcileInterimSnapshot(snapSession, 'mountain river stone', 16);
assert.deepStrictEqual(snapConfirmed, ['p0'], 'converged interim snapshot credits the sung, ended line');
assert.strictEqual(snapSession.states['p0'].cleared, true, 'interim snapshot clears the line');
assert.ok(
    snapSession.states['p0'].consumedTokens.some(function(t) { return /_reconciled$/.test(t.source); }),
    'interim-snapshot credits are tagged *_reconciled for telemetry audit'
);

// (C) Re-feeding the SAME (unchanged) snapshot adds no new words -> no-op.
var snapAgain = phraseEngine.reconcileInterimSnapshot(snapSession, 'mountain river stone', 17);
assert.deepStrictEqual(snapAgain, [], 'an unchanged interim snapshot confirms nothing new');

// (B) Inflation guard for cumulative re-submission: singer reaches p1 then p2.
// The interim grows "watch me fly" -> "watch me fly geese will fly". The repeated
// "watch me fly" (and its "fly") must NOT, on the second snapshot, credit the
// un-sung p0 "birds can fly" that shares the "fly" anchor.
var inflPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'birds can fly' },   // p0 (never sung)
    { time: 4, text: 'watch me fly' },    // p1
    { time: 8, text: 'geese will fly' }   // p2
], { difficulty: 'easy', audioDuration: 12 });
var inflSession = phraseEngine.createPhraseSession(inflPlan);
// Energy for the two SUNG lines only (p1 @6s in [4,8]; p2 @10s in [8,12]); the
// never-sung p0 [0,4] stays silent, so the gate blocks it even before the floor does.
phraseEngine.addEvidence(inflSession, { id: 'vad-infl1', source: 'vad', text: '', words: [], receivedAtSec: 6, audioTimeSec: 6 });
phraseEngine.addEvidence(inflSession, { id: 'vad-infl2', source: 'vad', text: '', words: [], receivedAtSec: 10, audioTimeSec: 10 });
phraseEngine.reconcileInterimSnapshot(inflSession, 'watch me fly', 9);
phraseEngine.reconcileInterimSnapshot(inflSession, 'watch me fly geese will fly', 13);
assert.strictEqual(inflSession.states['p1'].lyricStatus, 'confirmed', 'sung line p1 confirmed from interim');
assert.strictEqual(inflSession.states['p2'].lyricStatus, 'confirmed', 'sung line p2 confirmed from its new interim words');
assert.strictEqual(inflSession.states['p0'].lyricStatus, 'missing', 'cumulative re-submission does NOT inflate the un-sung shared-anchor line');
assert.strictEqual(Object.keys(inflSession.states['p0'].anchorHits).length, 0, 'no spurious anchor credit on the un-sung line');

// (D) Reset robustness: Chrome's interim is NOT one monotonic string for the whole
// song — it resets to short segments (observed in real telemetry: a long verse
// hypothesis, then a bare " ya ya " outro). A reset (a new hypothesis that no longer
// extends the prior one) must NOT desync the fence: the post-reset segment's words
// must still credit their line, even though the new string is shorter than what was
// already consumed.
var resetPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'alpha bravo charlie' },   // p0 (long early segment)
    { time: 4, text: 'delta echo foxtrot' }     // p1 (after the interim resets)
], { difficulty: 'easy', audioDuration: 8 });
var resetSession = phraseEngine.createPhraseSession(resetPlan);
// Both lines were sung (energy in each window) — the reset robustness is about the
// fence, not skipping, so both need in-window flow under the new gate.
phraseEngine.addEvidence(resetSession, { id: 'vad-reset0', source: 'vad', text: '', words: [], receivedAtSec: 2, audioTimeSec: 2 });
phraseEngine.addEvidence(resetSession, { id: 'vad-reset1', source: 'vad', text: '', words: [], receivedAtSec: 6, audioTimeSec: 6 });
phraseEngine.reconcileInterimSnapshot(resetSession, 'alpha bravo charlie', 5);
assert.strictEqual(resetSession.states['p0'].lyricStatus, 'confirmed', 'long early segment credits its line');
// Interim resets to a shorter, divergent string (segment finalized/aborted).
var resetConfirmed = phraseEngine.reconcileInterimSnapshot(resetSession, 'delta echo', 9);
assert.deepStrictEqual(resetConfirmed, ['p1'], 'post-reset shorter segment still credits its line (fence does not desync)');
assert.strictEqual(resetSession.states['p1'].lyricStatus, 'confirmed', 'reset line confirmed');

// (E) Revision guard: the singer SKIPS p0, sings p1; Chrome then REVISES the
// segment's first word (watch -> switch) so the snapshot no longer prefix-extends,
// forcing a new segment id that re-exposes the already-credited "fly". A forward-only
// floor (interim crediting never reaches back before the latest line it confirmed)
// must keep the skipped earlier line from being credited by the re-presented anchor.
var revPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'birds can fly' },   // p0 (skipped)
    { time: 4, text: 'watch me fly' },    // p1 (sung)
    { time: 8, text: 'geese will fly' }   // p2
], { difficulty: 'easy', audioDuration: 12 });
var revSession = phraseEngine.createPhraseSession(revPlan);
// Only p1 [4,8] was sung (energy @6s); the skipped p0 [0,4] stays silent. Both the
// forward-only floor AND the in-window-flow gate now keep p0 from being re-credited.
phraseEngine.addEvidence(revSession, { id: 'vad-rev1', source: 'vad', text: '', words: [], receivedAtSec: 6, audioTimeSec: 6 });
phraseEngine.reconcileInterimSnapshot(revSession, 'watch me fly', 9);
phraseEngine.reconcileInterimSnapshot(revSession, 'switch me fly', 10); // revision -> new segment id
assert.strictEqual(revSession.states['p1'].lyricStatus, 'confirmed', 'sung line p1 confirmed');
assert.strictEqual(revSession.states['p0'].lyricStatus, 'missing', 'a browser-SR revision must NOT re-credit the skipped earlier line via the re-exposed shared anchor');

// (F) Middle-skip leak (the "sing every other line" exploit): the forward-only floor
// only protects lines BEFORE the last confirmed line. A skipped line sandwiched
// BETWEEN two sung lines is unprotected, and on rap the next sung line repeats a hook
// whose shared anchor bleeds back onto the skipped line while that next line is still
// mid-flight (not yet an ended candidate). The fix gates interim credit on in-window
// vocal energy: the skipped line had NONE (singer was silent during it), so it must
// stay missing — and the sung line must reclaim its own words.
var hookPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'alpha bravo charlie' },     // p0 SUNG
    { time: 4, text: 'dragon phoenix glory' },    // p1 SKIPPED (identical hook -> shares every anchor with p2)
    { time: 8, text: 'dragon phoenix glory' }     // p2 SUNG (the repeated hook)
], { difficulty: 'expert', audioDuration: 12 });
var hookSession = phraseEngine.createPhraseSession(hookPlan);
// Real-time vocal energy ONLY for the lines actually sung (p0 @2s in [0,4]; p2 @10s in [8,12]).
// The skipped p1 [4,8] gets none — exactly what "skip a line" produces.
phraseEngine.addEvidence(hookSession, { id: 'vad-h0', source: 'vad', text: '', words: [], receivedAtSec: 2, audioTimeSec: 2 });
phraseEngine.addEvidence(hookSession, { id: 'vad-h2', source: 'vad', text: '', words: [], receivedAtSec: 10, audioTimeSec: 10 });
phraseEngine.reconcileInterimSnapshot(hookSession, 'alpha bravo charlie', 5);                        // sing p0
phraseEngine.reconcileInterimSnapshot(hookSession, 'alpha bravo charlie dragon phoenix glory', 10);  // mid-p2: p1 is the only ended candidate
phraseEngine.reconcileInterimSnapshot(hookSession, 'alpha bravo charlie dragon phoenix glory', 13);  // p2 has now ended
assert.strictEqual(hookSession.states['p0'].lyricStatus, 'confirmed', 'sung p0 confirmed');
assert.strictEqual(hookSession.states['p1'].lyricStatus, 'missing', 'SKIPPED middle line (no in-window energy) must NOT be credited by the next line\'s repeated-hook anchor');
assert.strictEqual(hookSession.states['p2'].lyricStatus, 'confirmed', 'the actually-sung repeated hook (p2) reclaims its own words');

// === Class-2 fix: a UNIQUE anchor recognized out-of-order / after a later line confirmed
// (so the forward-only floor advanced past it) is still credited — WITHOUT enabling
// shared-word cheese. A unique anchor word belongs to exactly one candidate line, so it
// cannot mis-credit another; the repeated-hook cheese case is non-unique by construction
// and stays guarded (see the shared-anchor + skipped-hook tests above). ===
var uniqPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'roughneck alpha zero' },    // p0 [0,4]: distinctive 'roughneck'
    { time: 4, text: 'bravo charlie delta' }       // p1 [4,8]: later line, recognized first
], { difficulty: 'easy', audioDuration: 8 });
var uniqSession = phraseEngine.createPhraseSession(uniqPlan);
// Both lines actually sung -> in-window vocal energy (flow) for each.
phraseEngine.addEvidence(uniqSession, { id: 'vad-u0', source: 'vad', text: '', words: [], receivedAtSec: 1, audioTimeSec: 1 });
phraseEngine.addEvidence(uniqSession, { id: 'vad-u1', source: 'vad', text: '', words: [], receivedAtSec: 5, audioTimeSec: 5 });
// Step 1: the interim carries the LATER line first -> confirms p1, advancing the
// forward-only floor PAST p0 (the recognizer caught p1's words before p0's).
phraseEngine.reconcileInterimSnapshot(uniqSession, 'bravo charlie delta', 9);
assert.strictEqual(uniqSession.states['p1'].lyricStatus, 'confirmed', 'p1 confirmed first (advances the floor past p0)');
// Step 2: a later snapshot now also carries p0's distinctive 'roughneck' (late/out of order).
phraseEngine.reconcileInterimSnapshot(uniqSession, 'bravo charlie delta roughneck alpha zero', 10);
assert.ok(Object.keys(uniqSession.states['p0'].anchorHits).length > 0,
    'CLASS-2 FIX: a unique anchor below the advanced floor is still credited (was silently skipped)');
console.log('Class-2 unique-anchor reconcile: passed.');

// === Fast-tempo recognition allowance (cheese-floored bar) ===
// On dense/fast lines the browser recognizer drops most words (verified in real
// telemetry: ~3 of 4 dropped on back-to-back bars), so the bar drops toward a
// SINGLE genuinely-recognized anchor -- 1 confirmed word + VAD engagement is enough.
// Cheese with 0 recognized still fails. Normal-tempo lines keep the full bar.
var fastP = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'alpha bravo charlie delta echo foxtrot golf hotel' }, // ~5 wps -> fast
    { time: 1.6, text: 'tail line words here now' }
], { difficulty: 'expert', audioDuration: 12 });
var fastChunks = fastP.phrases.filter(function (p) {
    return p.lineIdx === 0 &&
        (p.words.length / Math.max(0.001, p.endSec - p.startSec)) >= 4.0 && p.anchors.length >= 3;
});
assert.ok(fastChunks.length > 0, 'precondition: a fast chunk with >=3 anchors exists');
fastChunks.forEach(function (p) {
    var fastBar = Math.max(1, Math.ceil(p.anchors.length * 0.25));
    assert.ok(p.anchorsRequired <= fastBar, 'fast chunk: bar lowered to <= max(1, ceil(anchors*0.25))');
    assert.ok(p.anchorsRequired >= 1, 'cheese floor: fast bar is never below 1 recognized anchor');
});
// A dense line with just a few anchors drops all the way to ONE recognized anchor
// (the recognizer-drops case from the Roots telemetry).
var fastFew = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'darkness preach gospel' },        // 3 words in 0.7s -> very fast
    { time: 0.7, text: 'tail words here now please' }
], { difficulty: 'expert', audioDuration: 8 });
var ff = fastFew.phrases.find(function (p) { return p.lineIdx === 0; });
assert.ok(ff.anchors.length >= 2 && ff.anchors.length <= 4, 'precondition: a dense line with a few anchors');
assert.strictEqual(ff.anchorsRequired, 1, 'a dense few-anchor line requires just 1 recognized anchor');
// Short back-to-back lines (minimal pausing) get the allowance even at moderate
// WPS -- the recognizer can't emit a final inside a sub-1.2s window.
var shortP = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'preach gospel' },                  // 2 words in 0.8s -> WPS ~2.5, tiny window
    { time: 0.8, text: 'tail words here now please' }
], { difficulty: 'expert', audioDuration: 8 });
var sp = shortP.phrases.find(function (p) { return p.lineIdx === 0; });
assert.ok((sp.words.length / (sp.endSec - sp.startSec)) < 4.0, 'precondition: short line is below the WPS threshold');
assert.strictEqual(sp.anchorsRequired, 1, 'a short back-to-back line requires just 1 anchor even at moderate WPS');
var normP = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'slow measured steady careful chosen words' }          // very low wps -> normal
], { difficulty: 'expert', audioDuration: 30 });
assert.ok(normP.phrases[0].anchorsRequired > 2,
    'a normal-tempo expert line keeps its full (higher) bar (buff is fast-only)');
console.log('Fast-tempo cheese-floored bar: passed.');

// --- Review fix: interim reconcile look-back is capped (cross-repeat steal guard) ---
// Repeated-hook songs: a word first surfacing in the interim ~10s+ after a line
// ended is almost certainly a LATER repeat's performance (interims track speech
// within a second or two). Uncapped, the monotonic pass pulled such tokens back to
// the earliest unhit repeat: real telemetry credited line 3's "watch" from line
// 10's singing (+10.2s) and line 14's "choppa" from line 18's (+10.8s). The
// interim path now looks back only a short horizon; late FINALS keep the full 18s
// (realtime-provider finals legitimately batch 13-17s of lines).
(function () {
    var hookLyrics = [
        { time: 0,  text: 'hello world tonight' },     // p0: old hook repeat, ends at 2
        { time: 2,  text: 'instrumental gap noise' },  // p1: long silent gap, ends at 12
        { time: 12, text: 'hello world tonight' },     // p2: fresh hook repeat, ends at 14
        { time: 14, text: 'closing words differ' }     // p3: still open at test time
    ];
    function freshSession() {
        var p = phraseEngine.buildPhrasePlan(hookLyrics, { difficulty: 'medium', audioDuration: 20 });
        var s = phraseEngine.createPhraseSession(p);
        // The singer vocalized during BOTH hook repeats (flow gate passes for both).
        [0.5, 1.0, 12.5, 13.0].forEach(function (t) {
            phraseEngine.addEvidence(s, { source: 'vad', text: '', words: [], receivedAtSec: t, audioTimeSec: t });
        });
        return s;
    }
    // Interim at t=14.5: the fresh repeat (p2) just ended; the old repeat (p0)
    // ended 12.5s ago. The tokens are p2's performance and must credit p2.
    var s1 = freshSession();
    phraseEngine.reconcileInterimSnapshot(s1, 'hello world tonight', 14.5);
    var t1 = phraseEngine.getPhraseTrace(s1);
    assert.strictEqual(t1[2].cleared, true, 'the just-sung hook repeat gets its own credit');
    assert.strictEqual(t1[0].anchorsHit, 0, 'a hook repeat 12.5s in the past cannot steal the fresh tokens');
    // A late FINAL keeps the full look-back: the same words as a browser_final
    // still reach the older line (rt finals batch many lines legitimately).
    var s2 = freshSession();
    phraseEngine.reconcileLateEvidence(s2, {
        id: 'f1', source: 'browser_final', text: 'hello world tonight', words: [],
        receivedAtSec: 14.5, audioTimeSec: 14.5
    }, 14.5, { requireInWindowFlow: true });
    var t2 = phraseEngine.getPhraseTrace(s2);
    assert.ok(t2[0].anchorsHit > 0, 'a late final still reaches the older line (full look-back for finals)');
    console.log('Interim look-back cap: passed.');
})();

// --- Review fix: flowStatus classifies by ONSET, not by the latest event ---
// The old rule ("latest event past endSec -> late") marked 39/40 lines of a real
// continuously-sung run 'late', because singing always trails into the next line.
// Flow now reads when the singer STARTED vocalizing relative to the line start
// (within timing tolerance = clean).
(function () {
    function planOneLine() {
        return phraseEngine.buildPhrasePlan([{ time: 10, text: 'steady vocal line' }],
            { difficulty: 'medium', audioDuration: 12 });
    }
    // Continuous singing from the line start, trailing past its end (the normal case).
    var s1 = phraseEngine.createPhraseSession(planOneLine());
    [10.2, 10.6, 11.0, 11.4, 11.8, 12.2, 12.4].forEach(function (t) {
        phraseEngine.addEvidence(s1, { source: 'vad', text: '', words: [], receivedAtSec: t, audioTimeSec: t });
    });
    var t1 = phraseEngine.getPhraseTrace(s1)[0];
    assert.strictEqual(t1.flowStatus, 'clean',
        'singing from the start that trails past the end is clean flow, got ' + t1.flowStatus);
    // Joining the line well after its start (past the timing tolerance) is late.
    var s2 = phraseEngine.createPhraseSession(planOneLine());
    [11.5, 11.8].forEach(function (t) {
        phraseEngine.addEvidence(s2, { source: 'vad', text: '', words: [], receivedAtSec: t, audioTimeSec: t });
    });
    var t2 = phraseEngine.getPhraseTrace(s2)[0];
    assert.strictEqual(t2.flowStatus, 'late',
        'first vocalizing 1.5s into the line (tolerance 1.0s) is late, got ' + t2.flowStatus);
    console.log('Onset-based flowStatus: passed.');
})();

// getPhraseTrace exposes the phrase window (startSec/endSec) so telemetry can
// derive real recognizer-lag stats (consumed-token time vs line end).
(function () {
    var p = phraseEngine.buildPhrasePlan([{ time: 3, text: 'window check line' }],
        { difficulty: 'medium', audioDuration: 9 });
    var s = phraseEngine.createPhraseSession(p);
    var tr = phraseEngine.getPhraseTrace(s)[0];
    assert.strictEqual(tr.startSec, 3, 'trace exposes startSec');
    assert.strictEqual(tr.endSec, 9, 'trace exposes endSec');
    console.log('trace window fields: passed.');
})();

// --- Review fix: the flow gate fails OPEN when the VAD sensor is dead ---
// Real incident (2026-07-20 22:01 run): the game's mic/VAD path produced no energy
// all session (new-origin mic permission/device issue) while Web Speech transcribed
// fine. Both reconcile paths hard-required per-line VAD flow, so an honest singer
// with a 92% baseline scored 31%. The gate now enforces only when the session has
// seen VAD fire at all (_vadFlowSeen). Honesty holds because a cheeser's spoken
// burst itself trips a LIVE sensor — you cannot produce ASR content silently — so
// by the time burst evidence reconciles, the gate is armed and the skipped lines
// (no in-window flow) stay blocked. A dead sensor degrades to ungated reconcile
// instead of zeroing the run.
(function () {
    var L = [
        { time: 0, text: 'crimson tide rises' },
        { time: 3, text: 'velvet morning glow' },
        { time: 6, text: 'quiet outro segment' }
    ];
    // (A) DEAD sensor: no vad evidence ever -> a late final still credits.
    var dead = phraseEngine.createPhraseSession(phraseEngine.buildPhrasePlan(L, { difficulty: 'medium', audioDuration: 12 }));
    phraseEngine.reconcileLateEvidence(dead, {
        id: 'df1', source: 'browser_final', text: 'crimson tide rises velvet morning glow',
        words: [], receivedAtSec: 9, audioTimeSec: 9
    }, 9, { requireInWindowFlow: true });
    var deadTr = phraseEngine.getPhraseTrace(dead);
    assert.ok(deadTr[0].anchorsHit > 0 && deadTr[1].anchorsHit > 0,
        'dead VAD sensor -> flow gate fails open, late final credits the sung lines');
    // (B) ALIVE sensor (vad fired during line 1 only): silent line 0 stays blocked.
    var alive = phraseEngine.createPhraseSession(phraseEngine.buildPhrasePlan(L, { difficulty: 'medium', audioDuration: 12 }));
    phraseEngine.addEvidence(alive, { source: 'vad', text: '', words: [], receivedAtSec: 4, audioTimeSec: 4 });
    phraseEngine.reconcileLateEvidence(alive, {
        id: 'af1', source: 'browser_final', text: 'crimson tide rises velvet morning glow',
        words: [], receivedAtSec: 9, audioTimeSec: 9
    }, 9, { requireInWindowFlow: true });
    var aliveTr = phraseEngine.getPhraseTrace(alive);
    assert.strictEqual(aliveTr[0].anchorsHit, 0,
        'alive sensor + silent line 0 -> per-line flow gate still blocks');
    assert.ok(aliveTr[1].anchorsHit > 0, 'the vocalized line 1 still credits');
    console.log('Sensor-health fail-open: passed.');
})();

console.log('Phrase engine tests passed.');
