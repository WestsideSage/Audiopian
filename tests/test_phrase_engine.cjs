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
// Filler-only lines ("yeah yeah", "uh uh") fall back to filler-marked anchors so the
// phrase can still be scored when Whisper transcribes them.
assert.ok(plan.phrases[2].anchors.some(function(anchor) { return anchor.word === 'yeah'; }), 'filler-only lines fall back to filler anchors');
assert.ok(plan.phrases[2].anchors.every(function(anchor) { return anchor.fillerOnly === true; }), 'fallback anchors are marked fillerOnly');
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
// High-WPS lines the recognizer can't fully transcribe get a LOWER anchorsRequired,
// floored at 2 genuinely-recognized anchors (cheese with 0-1 recognized still fails);
// normal-tempo lines keep the full bar. The buff is fast-tempo only.
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
    var fastBar = Math.max(2, Math.ceil(p.anchors.length * 0.5));
    assert.ok(p.anchorsRequired <= fastBar, 'fast chunk: bar lowered to <= max(2, ceil(anchors*0.5))');
    assert.ok(p.anchorsRequired >= 2, 'cheese floor: fast bar is never below 2 recognized anchors');
});
var normP = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'slow measured steady careful chosen words' }          // very low wps -> normal
], { difficulty: 'expert', audioDuration: 30 });
assert.ok(normP.phrases[0].anchorsRequired > 2,
    'a normal-tempo expert line keeps its full (higher) bar (buff is fast-only)');
console.log('Fast-tempo cheese-floored bar: passed.');

console.log('Phrase engine tests passed.');
