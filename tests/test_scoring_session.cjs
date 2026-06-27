var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// scoring.interpolateWordTimings / phrase.buildPhrasePlan read root.audio.duration
// for end-of-line/phrase-end timing. Provide a realistic duration so fixtures get
// non-degenerate windows (mirrors production where audio.duration is the song length).
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
var S = path.join(__dirname, '..', 'static');
function load(name, deps) {
    return loadBrowserCommonJs(path.join(S, name), Object.assign({
        require: function (spec) {
            var m = { './match-helpers.js': mh, './sync-helpers.js': sh,
                      './scoring.js': scoring, './phrase-engine.js': phrase,
                      './scoring-arcade.js': arcade }[spec];
            if (!m) throw new Error('Unexpected require: ' + spec);
            return m;
        }, globalThis: globalThis
    }, deps || {}));
}
var mh = loadBrowserCommonJs(path.join(S, 'match-helpers.js'));
var sh = loadBrowserCommonJs(path.join(S, 'sync-helpers.js'));
var scoring = load('scoring.js');
var phrase = load('phrase-engine.js');
var arcade = loadBrowserCommonJs(path.join(S, 'scoring-arcade.js'));
var session = load('scoring-session.js');

// Minimal one-line song; a single matching final should score the line.
function lyric(time, text) { return { time: time, text: text }; }

// Build the per-line interpolated word timings the session consumes, mirroring
// production: player.js start() runs interpolateWordTimings, then for each line
// sets `useVad = true` / `vadTempoClass` (player.js:200-205). The VAD flag is what
// gates the live vad-evidence feed (player.js:1423) that records the flowEvents the
// interim reconciliation gate (phrase-engine hasInWindowFlow) checks. Fixtures that
// omit it would never feed vad evidence -> energy-gated case (B) could not clear.
function buildAllWordTimings(L) {
    var awt = scoring.interpolateWordTimings(L);
    for (var li = 0; li < awt.length; li++) {
        if (!awt[li]) continue;
        awt[li].useVad = true;
        awt[li].vadTempoClass = awt[li].vadTempoClass || 'normal';
    }
    return awt;
}

// Build a real phrase plan exactly as production does at game start.
function buildPhrasePlanFromLyrics(L) {
    return phrase.buildPhrasePlan(L, { difficulty: 'medium', audioDuration: 8 });
}

// Two-line fixture used across the energy-gate / reconciliation tests.
function twoLineCfg() {
    var L = [lyric(0, 'first line words'), lyric(2, 'second line words')];
    return { lyrics: L, allWordTimings: buildAllWordTimings(L),
             phrasePlan: buildPhrasePlanFromLyrics(L), difficulty: 'medium' };
}

// Three-line fixture: lines spaced so the first two end (and leave the active
// window) well before the song end, giving room to drive a batched reconcile of
// both ended lines while they remain within the 18s reconcile look-back.
function threeLineCfg() {
    var L = [lyric(0, 'first line words'), lyric(3, 'second line words'), lyric(6, 'third line words')];
    return { lyrics: L, allWordTimings: scoring.interpolateWordTimings(L).map(function (wt) {
                 if (wt) { wt.useVad = true; wt.vadTempoClass = wt.vadTempoClass || 'normal'; }
                 return wt;
             }),
             phrasePlan: phrase.buildPhrasePlan(L, { difficulty: 'medium', audioDuration: 12 }),
             difficulty: 'medium' };
}
// ===========================================================================
// PER-TASK CHARACTERIZATION TESTS (Phase 1)
// Ordering rule: a not-yet-implemented characterization test must sit BELOW the
// tests for the task being greened, because a .cjs aborts at the first failing
// assertion. New task tests are appended here, above the forward-declared
// Phase-0 contract / energy-gate cases near the bottom.
// ===========================================================================

// --- Task 1.1: line/session reset + honest % ---
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    assert.strictEqual(s.activeLineIdx, 0, 'setActiveLine records the active line index');
    assert.deepStrictEqual(s.lineWords, ['first', 'line', 'words'],
        'setActiveLine builds normalized lineWords from the lyric line');
    assert.strictEqual(s.matchedSet.size, 0, 'new line starts with empty matchedSet');
    assert.strictEqual(s.hotWordIndex, -1, 'reset clears the hot-word index');
    assert.strictEqual(s._lineStartAudioTime, 0.0, 'reset records the line start media time');
    assert.strictEqual(session.getHonestPct(s), null, 'no ended phrases yet -> null honest %');
})();

// --- Task 1.2: hot-word match emits wordMatched, energy-gated on edit distance ---
// Target 'candle'; spoken 'cendle' is an edit-1 match that is NOT phonetic
// (doubleMetaphone KNTL vs SNTL, verified). While silent the matchHotWord energy
// gate must reject edit-distance-only matches; while singing it must accept.
// Behavior is exercised through tick (never a private).
function matchHotWordForTest(s, text, now) {
    session.ingestInterim(s, text);
    return session.tick(s, now);
}
(function () {
    var L = [lyric(0, 'candle bright tonight')];
    var cfg = { lyrics: L, allWordTimings: buildAllWordTimings(L),
                phrasePlan: buildPhrasePlanFromLyrics(L), difficulty: 'medium' };
    // (silent) edit-distance-only match must be rejected by the HOT-WORD VAD path.
    // Note: the collectMatches path (non-energy-gated) may still credit an edit-distance
    // match via transcript+interim — that is correct production behavior (player.js:431).
    // This test specifically checks the vad-confirmed branch is NOT triggered when silent.
    var s = session.createSession(cfg);
    session.setActiveLine(s, 0, 0.0);     // now=0.5 below lands the hot word on idx 0 (candle)
    session.setEnergy(s, false);
    var out = matchHotWordForTest(s, 'cendle', 0.5);
    assert.strictEqual(out.filter(function (e) { return e.type === 'wordMatched' && e.method === 'vad-confirmed'; }).length, 0,
        'vad-confirmed match must be rejected while silent (energy gate on hot-word path)');
    // (singing) the same edit-distance match is accepted.
    var s2 = session.createSession(cfg);
    session.setActiveLine(s2, 0, 0.0);
    session.setEnergy(s2, true);
    var out2 = matchHotWordForTest(s2, 'cendle', 0.5);
    assert.ok(out2.some(function (e) { return e.type === 'wordMatched' && e.wordIndex === 0; }),
        'edit-distance match accepted while singing');
    assert.ok(out2.some(function (e) { return e.type === 'wordMatched' && e.method === 'vad-confirmed' && e.wordIndex === 0; }),
        'singing path confirms the hot word via the vad-confirmed branch');
    assert.ok(s2.matchedSet.has(0), 'matched word recorded in matchedSet while singing');
})();

// --- Task 1.3: collectMatches + ingestFinal accumulation ---
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    // A clean browser_sr final covering the whole active line.
    session.ingestFinal(s, 'first line words', 'browser_sr');
    // ingestFinal accumulates into transcript (with a trailing space so the no-space
    // concat in the hot-word path still tokenizes) and marks ASR activity.
    assert.ok(/first line words/.test(s.transcript), 'browser_sr final accumulates into transcript');
    assert.strictEqual(s.lineHadAsrEvent, true, 'a final marks the line as having had ASR');
    var out = session.tick(s, 1.0);
    // collectMatches fills the matched set for the present words.
    assert.strictEqual(s.matchedSet.size, 3, 'all three present words matched into matchedSet');
    var matched = out.filter(function (e) { return e.type === 'wordMatched' && e.matched === true; });
    assert.ok(matched.length >= 3, 'emits a wordMatched for each present word');
})();

// Whisper final path: accumulates into whisperBuffer and matches via collectMatchesWhisper.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'whisper');
    assert.ok(/first line words/.test(s.whisperBuffer), 'whisper final accumulates into whisperBuffer');
    session.tick(s, 1.0);
    assert.strictEqual(s.matchedSet.size, 3, 'whisper path matches all three present words');
})();

// CREDITING ASSERTION (was TRIPWIRE): a browser_sr final arriving just before a line
// change is now credited to the OUTGOING line by the Phase-3 setActiveLine outgoing
// collectMatches pass (player.js:1110-1122), which runs BEFORE resetLineState and
// snapshots the matched words into prevLine.matchedSet. The Phase-1 tripwire
// (`s.prevLine === null`) has been replaced here with Phase-3 crediting assertions.
// NOTE: lineScored itself is emitted by finalizePrevLine (Task 3.2) — not here.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'browser_sr'); // line 0's words, line 0 active
    session.setActiveLine(s, 1, 2.0);                         // outgoing pass credits line 0 BEFORE reset
    // The transcript was accumulated by ingestFinal.
    assert.ok(/first line words/.test(s.transcript), 'transcript accumulates the final regardless');
    // Phase 3: prevLine overlay is created (not null).
    assert.ok(s.prevLine !== null, 'Phase 3: prevLine overlay exists after setActiveLine');
    assert.strictEqual(s.prevLine.lineIdx, 0, 'prevLine.lineIdx is 0');
    // The outgoing collectMatches pass (BEFORE resetLineState) credited line 0's words
    // into the matchedSet that was then snapshot-copied into prevLine.matchedSet.
    assert.strictEqual(s.prevLine.matchedSet.size, 3,
        'pre-boundary final words are credited into prevLine.matchedSet by the outgoing pass');
})();

// --- Task 1.4 (+ folded-in Task 0.3): energy-gated interim reconciliation ---
// Encodes the 06dfde5 invariant: an ended line whose words appear only in the
// interim with NO in-window vocal energy must NOT be reconciled/cleared; with
// energy it must. The energy gate is internal to phrase-engine (hasInWindowFlow
// over flowEvents); the session reproduces the live isSpeaking-gated vad feed.

// (A) No energy while line 0 is active+ended -> interim words do NOT clear it.
// Drive a tick INSIDE line 0's window while SILENT (the real cheese case: the words
// appear in the interim via boundary-bleed from an adjacent line, but the singer
// produced no in-window energy), so this exercises the energy gate itself rather
// than merely the absence of any in-window tick.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, false);                  // silent
    session.tick(s, 0.5);                         // in-window tick, but silent -> NO vad flowEvent
    session.ingestInterim(s, 'first line words'); // words present but no energy
    session.setActiveLine(s, 1, 2.0);             // line 0 ends
    var out = session.tick(s, 2.1);
    var cleared = out.filter(function (e) { return e.type === 'phraseCleared'; });
    assert.strictEqual(cleared.length, 0, 'silent interim must NOT reconcile/clear the ended line');
})();

// (B) With energy, the same words DO clear line 0. For the engine to clear, a
// flowEvent must exist in p0's window: energize, then drive a tick INTO line 0's
// window (now=0.5) so the vad feed records the flowEvent, THEN ingest the interim
// words and end the line. (The plan's verbatim 0.3 snippet had no in-window tick
// and could not clear even with a correct impl; corrected per execution notes.)
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);                   // singing
    session.tick(s, 0.5);                         // energized tick in line 0's window -> vad flowEvent
    session.ingestInterim(s, 'first line words');
    session.setActiveLine(s, 1, 2.0);             // line 0 ends; latestInterim survives
    var out = session.tick(s, 2.1);
    var cleared = out.filter(function (e) { return e.type === 'phraseCleared'; });
    assert.ok(cleared.length >= 1, 'energized interim SHOULD reconcile/clear the ended line');
    assert.ok(cleared.some(function (e) { return e.phraseId === 'p0'; }),
        'the cleared phrase is line 0 (p0)');
})();

// (C) A converged interim batching BOTH ended lines reconciles each to its own
// line (two distinct phraseCleared). Both lines must be ended and out of the active
// window (so the live addEvidence path doesn't directly credit them) yet within the
// 18s reconcile look-back; each needs an in-window flowEvent (singing) to pass the
// energy gate. Mirrors test_phrase_engine's batched/interim reconciliation cases.
(function () {
    var s = session.createSession(threeLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);
    session.tick(s, 1.0);                         // flowEvent inside p0 [0,3]
    session.setActiveLine(s, 1, 3.0);
    session.tick(s, 4.0);                         // flowEvent inside p1 [3,6]
    session.setActiveLine(s, 2, 6.0);            // lines 0 & 1 now ended
    session.ingestInterim(s, 'first line words second line words');
    var out = session.tick(s, 8.5);              // both ended + out of active window, within look-back
    var clearedIds = out.filter(function (e) { return e.type === 'phraseCleared'; })
                        .map(function (e) { return e.phraseId; });
    assert.ok(clearedIds.indexOf('p0') >= 0, 'batched interim reconciles line 0');
    assert.ok(clearedIds.indexOf('p1') >= 0, 'batched interim reconciles line 1');
    assert.notStrictEqual(clearedIds.indexOf('p0'), clearedIds.indexOf('p1'),
        'line 0 and line 1 are cleared as two distinct phrases');
})();

// (D) Monotonic: once a line is cleared, a later reconcile pass with the same
// converged interim does not re-credit / double-clear it.
(function () {
    var s = session.createSession(threeLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);
    session.tick(s, 1.0);
    session.setActiveLine(s, 1, 3.0);
    session.tick(s, 4.0);
    session.setActiveLine(s, 2, 6.0);
    session.ingestInterim(s, 'first line words second line words');
    var out1 = session.tick(s, 8.5);
    assert.ok(out1.some(function (e) { return e.type === 'phraseCleared' && e.phraseId === 'p0'; }),
        'line 0 clears on the first reconcile pass');
    // Same interim, later tick: already-consumed words are fenced -> no re-clear.
    var out2 = session.tick(s, 9.0);
    var again = out2.filter(function (e) { return e.type === 'phraseCleared'; }).length;
    assert.strictEqual(again, 0, 'already-cleared lines are not cleared again (monotonic)');
})();

// ===========================================================================
// PER-TASK CHARACTERIZATION TESTS (Phase 2)
// ===========================================================================

// --- Task 2.1: scoreLine emits lineScored (no DOM) ---
// A line with present words, scored after a final + tick populates the matched
// set, emits exactly one lineScored with the right matched/scoredTotal/perfect and
// bumps getScores().linesScored. The scoring building block is exercised directly
// (it has no public trigger until Phase 3 wires setActiveLine/finalizePrevLine).
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);                          // collect -> matchedSet has all 3
    assert.strictEqual(s.matchedSet.size, 3, 'precondition: all three words matched');
    var events = [];
    session.scoreLine(s, 0, s.lineWords, s.matchedSet, s.lineHadAsrEvent,
                      s.vadMatchedSet, s.asrConfirmedSet, events);
    var scored = events.filter(function (e) { return e.type === 'lineScored'; });
    assert.strictEqual(scored.length, 1, 'a scored line emits exactly one lineScored');
    assert.strictEqual(scored[0].lineIdx, 0, 'lineScored carries the line index');
    assert.strictEqual(scored[0].matched, 3, 'all three present words counted as matched');
    assert.strictEqual(scored[0].scoredTotal, 3, 'scoredTotal is the weighted word count');
    assert.strictEqual(scored[0].perfect, true, 'a fully matched line is perfect');
    assert.deepStrictEqual(scored[0].missedWordIndices, [], 'no missed indices on a perfect line');
    assert.strictEqual(session.getScores(s).linesScored, 1, 'linesScored incremented to 1');
    assert.strictEqual(session.getScores(s).matchedWords, 3, 'matchedWords tally updated');
    assert.strictEqual(session.getScores(s).perfectLines, 1, 'perfectLines tally updated');
    assert.strictEqual(session.getScores(s).currentStreak, 1, 'a perfect line extends the streak');
    // scoreLine also signals a running-score repaint (controller reads getScores).
    assert.ok(events.some(function (e) { return e.type === 'runningScore'; }),
        'scoreLine emits a runningScore repaint signal');
})();

// An all-filler line (every word weight 0 -> weightedTotal === 0) must emit NO
// lineScored, must not count toward linesScored, and must NOT break the streak.
(function () {
    var L = [lyric(0, 'real words here'), lyric(2, '(la la la)')];
    var cfg = { lyrics: L, allWordTimings: buildAllWordTimings(L),
                phrasePlan: buildPhrasePlanFromLyrics(L), difficulty: 'medium' };
    var s = session.createSession(cfg);
    // Score a perfect real line first so there is a live streak to (not) break.
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'real words here', 'browser_sr');
    session.tick(s, 1.0);
    var ev0 = [];
    session.scoreLine(s, 0, s.lineWords, s.matchedSet, s.lineHadAsrEvent,
                      s.vadMatchedSet, s.asrConfirmedSet, ev0);
    assert.strictEqual(session.getScores(s).currentStreak, 1, 'precondition: streak is 1 after a perfect line');
    // Now the all-filler line: words inside parens classify as adlib (weight 0).
    session.setActiveLine(s, 1, 2.0);
    var allFiller = s.lineWords;                   // ['la','la','la']
    assert.deepStrictEqual(allFiller, ['la', 'la', 'la'], 'precondition: parenthetical line normalizes to fillers');
    var ev1 = [];
    session.scoreLine(s, 1, allFiller, s.matchedSet, true /* had ASR */,
                      s.vadMatchedSet, s.asrConfirmedSet, ev1);
    assert.strictEqual(ev1.filter(function (e) { return e.type === 'lineScored'; }).length, 0,
        'an all-filler (weightedTotal===0) line emits no lineScored');
    assert.strictEqual(session.getScores(s).linesScored, 1, 'all-filler line does not increment linesScored');
    assert.strictEqual(session.getScores(s).currentStreak, 1, 'all-filler line does NOT break the streak');
})();

// Zero-ASR fence: a line with lineHadAsrEvent === false is skipped entirely
// (no lineScored, no tally change) even when words are present in the matched set.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);
    var events = [];
    session.scoreLine(s, 0, s.lineWords, s.matchedSet, false /* no ASR event */,
                      s.vadMatchedSet, s.asrConfirmedSet, events);
    assert.strictEqual(events.filter(function (e) { return e.type === 'lineScored'; }).length, 0,
        'zero-ASR fence: no lineScored when lineHadAsrEvent === false');
    assert.strictEqual(session.getScores(s).linesScored, 0, 'zero-ASR fence: linesScored untouched');
})();

// --- Task 2.2: lateScoreLine (late-arriving final still scores the line) ---
// A final that lands after the line ended is matched against the rolling
// transcriptWords (with the -4 boundary lookback) and then scored. The credited
// words land in the passed snapshot matchedSet and the line emits a lineScored
// for the correct lineIdx. DRY: lateScoreLine delegates to scoreLine to tally.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    // Words arrive into the rolling transcript (as a browser_sr final would) but we
    // do NOT run the in-line collect — simulating recognition that lands only after
    // the line boundary, which is exactly what the 800ms late pass is for.
    session.ingestFinal(s, 'first line words', 'browser_sr');
    var snapshot = new Map();                       // nothing matched in-line
    var events = [];
    session.lateScoreLine(s, 0, ['first', 'line', 'words'], snapshot,
                          0 /* lineStartWordCount */, true /* lineHadAsrEvent */,
                          new Map(), new Set(), events);
    var scored = events.filter(function (e) { return e.type === 'lineScored'; });
    assert.strictEqual(scored.length, 1, 'a late final produces one lineScored');
    assert.strictEqual(scored[0].lineIdx, 0, 'lineScored is attributed to the correct (late) line');
    assert.strictEqual(scored[0].matched, 3, 'all three late-arriving words are credited');
    assert.strictEqual(snapshot.size, 3, 'late-credited words land in the snapshot matchedSet');
    assert.strictEqual(session.getScores(s).linesScored, 1, 'late scoring increments linesScored');
})();

// lateScoreLine inherits the zero-ASR fence via its delegation to scoreLine: a late
// pass with lineHadAsrEvent === false credits nothing-scoring (no lineScored).
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'browser_sr');
    var events = [];
    session.lateScoreLine(s, 0, ['first', 'line', 'words'], new Map(),
                          0, false /* no ASR */, new Map(), new Set(), events);
    assert.strictEqual(events.filter(function (e) { return e.type === 'lineScored'; }).length, 0,
        'late pass respects the zero-ASR fence (delegated to scoreLine)');
})();

// --- Task 2.3: commitNewlySettled emits arcade/arcadeRecord/phrase events ---
// A cleared+settled phrase commits exactly once: one arcade event, one arcadeRecord
// (also appended to s.arcadeEvents for endRun/telemetry), and a phraseCleared. A
// second commit pass at a later `now` does NOT re-commit (commit-once via
// s.committedPhrases). Drives the clear through the same energy-gated reconcile the
// reconciliation tests use, then settles p0 past its settlement window.
(function () {
    var s = session.createSession(threeLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);
    session.tick(s, 1.0);                          // flowEvent inside p0 [0,3]
    session.setActiveLine(s, 1, 3.0);              // p0 ends
    session.ingestInterim(s, 'first line words');
    // Reconcile-clear p0 at a pre-settlement tick (4.0 < 3+1.4=4.4) so p0 is cleared
    // but only 'settling' — tick's own commit (Task 2.4) skips it. Then settle p0
    // explicitly so the unit under test here, commitNewlySettled, performs the commit.
    session.tick(s, 4.0);                          // reconciles p0 (cleared); p0 'settling', uncommitted
    phrase.settlePhrases(s.phraseSession, 4.5);    // p0 now 'settled'
    var events = [];
    session.commitNewlySettled(s, 4.5, true, events);
    var arcadeEv = events.filter(function (e) { return e.type === 'arcade'; });
    var recEv = events.filter(function (e) { return e.type === 'arcadeRecord'; });
    var clearedEv = events.filter(function (e) { return e.type === 'phraseCleared'; });
    assert.strictEqual(arcadeEv.length, 1, 'commit emits exactly one arcade event');
    assert.strictEqual(recEv.length, 1, 'commit emits exactly one arcadeRecord event');
    assert.strictEqual(arcadeEv[0].evt.phraseId, 'p0', 'arcade event carries the committed phrase id');
    assert.strictEqual(arcadeEv[0].evt.outcome, 'clear', 'a confirmed phrase commits as a clear');
    assert.strictEqual(recEv[0].record.phraseId, 'p0', 'arcadeRecord is for the committed phrase');
    assert.ok(clearedEv.some(function (e) { return e.phraseId === 'p0'; }),
        'a confirmed phrase emits phraseCleared at commit');
    assert.strictEqual(events.filter(function (e) { return e.type === 'phraseMissed'; }).length, 0,
        'a confirmed phrase does NOT emit phraseMissed');
    assert.strictEqual(s.committedPhrases['p0'], true, 'commit-once flag is set on s.committedPhrases');
    assert.strictEqual(s.arcadeEvents.length, 1, 'the per-phrase record is also pushed to s.arcadeEvents');
    // Commit-once: a later pass must not re-commit p0.
    var events2 = [];
    session.commitNewlySettled(s, 6.0, true, events2);
    assert.strictEqual(events2.filter(function (e) { return e.type === 'arcade' && e.evt.phraseId === 'p0'; }).length, 0,
        'a second commit pass does NOT re-commit the same phrase (commit-once)');
    assert.strictEqual(s.arcadeEvents.length, 1, 's.arcadeEvents is not double-appended on re-commit');
})();

// A settled phrase that was never cleared (no anchors hit) commits as a miss and
// emits phraseMissed (the V2 else-branch paint), not phraseCleared.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);              // silence: no evidence, no anchor hits
    phrase.settlePhrases(s.phraseSession, 3.5);    // p0 ends at 2, settled at >=3.4 -> 'missing'
    var events = [];
    session.commitNewlySettled(s, 3.5, true, events);
    assert.ok(events.some(function (e) { return e.type === 'arcade' && e.evt.phraseId === 'p0'; }),
        'a missed phrase still commits an arcade event');
    assert.strictEqual(events.filter(function (e) { return e.type === 'arcade'; })[0].evt.outcome, 'miss',
        'a zero-hit phrase commits as a miss');
    assert.ok(events.some(function (e) { return e.type === 'phraseMissed' && e.phraseId === 'p0'; }),
        'a missed phrase emits phraseMissed');
    assert.strictEqual(events.filter(function (e) { return e.type === 'phraseCleared'; }).length, 0,
        'a missed phrase does NOT emit phraseCleared');
})();

// A settled phrase with SOME anchors hit but not confirmed commits as a PARTIAL and emits
// phrasePartial (amber), NOT phraseMissed (red): the lenient streak survives a partial, so
// the paint must match it rather than read as a total failure.
(function () {
    var s = session.createSession(threeLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);
    session.tick(s, 1.0);                          // flowEvent inside p0 [0,3]
    session.setActiveLine(s, 1, 3.0);              // p0 ends
    session.ingestInterim(s, 'first');             // only ONE anchor word -> partial (medium needs >=2)
    session.tick(s, 4.0);                          // reconcile: p0 gets one anchor, stays partial
    phrase.settlePhrases(s.phraseSession, 4.5);    // p0 settled
    var p0 = s.phraseSession.states['p0'];
    assert.ok(Object.keys(p0.anchorHits).length > 0, 'precondition: p0 has at least one anchor hit');
    assert.notStrictEqual(p0.lyricStatus, 'confirmed', 'precondition: p0 is NOT confirmed (partial)');
    var events = [];
    session.commitNewlySettled(s, 4.5, true, events);
    assert.ok(events.some(function (e) { return e.type === 'phrasePartial' && e.phraseId === 'p0'; }),
        'a partial phrase (some anchors hit) emits phrasePartial (amber)');
    assert.strictEqual(events.filter(function (e) { return e.type === 'phraseMissed'; }).length, 0,
        'a partial phrase does NOT emit phraseMissed (full red)');
    assert.strictEqual(events.filter(function (e) { return e.type === 'phraseCleared'; }).length, 0,
        'a partial phrase does NOT emit phraseCleared (green)');
})();

// routeEvents=false (the end-screen flush) suppresses the HUD arcade event but still
// commits (arcadeRecord pushed) and still paints the phrase result.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    phrase.settlePhrases(s.phraseSession, 3.5);
    var events = [];
    session.commitNewlySettled(s, 3.5, false /* routeEvents */, events);
    assert.strictEqual(events.filter(function (e) { return e.type === 'arcade'; }).length, 0,
        'routeEvents=false suppresses the HUD arcade event');
    assert.strictEqual(s.arcadeEvents.length, 1, 'routeEvents=false still records the commit for telemetry');
    assert.ok(events.some(function (e) { return e.type === 'phraseMissed' && e.phraseId === 'p0'; }),
        'routeEvents=false still paints the phrase result');
})();

// --- Task 2.4: tick orchestration + honestPct event ---
// tick runs the arcade block in _tickArcade order: reconcile (phraseCleared) ->
// commit (arcade / phraseMissed) -> honestPct (last). A single tick that both
// reconciles and commits p0 must emit the reconcile phraseCleared BEFORE the commit
// arcade event, the arcade BEFORE honestPct, and honestPct must be the final event.
(function () {
    var s = session.createSession(threeLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);
    session.tick(s, 1.0);                          // flowEvent inside p0 [0,3]
    session.setActiveLine(s, 1, 3.0);              // p0 ends
    session.ingestInterim(s, 'first line words');
    var out = session.tick(s, 4.5);               // reconcile (clear) + settle + commit + honest
    function idx(pred) { for (var i = 0; i < out.length; i++) if (pred(out[i])) return i; return -1; }
    var iCleared = idx(function (e) { return e.type === 'phraseCleared'; });
    var iArcade = idx(function (e) { return e.type === 'arcade'; });
    var iHonest = idx(function (e) { return e.type === 'honestPct'; });
    assert.ok(iCleared >= 0, 'tick emits a reconcile phraseCleared for p0');
    assert.ok(iArcade >= 0, 'tick emits a commit arcade event for p0');
    assert.ok(iHonest >= 0, 'tick emits a honestPct event');
    assert.ok(iCleared < iArcade, 'reconcile (phraseCleared) precedes commit (arcade)');
    assert.ok(iArcade < iHonest, 'commit (arcade) precedes honestPct');
    assert.strictEqual(iHonest, out.length - 1, 'honestPct is the last event of the tick');
    // honestPct payload equals getHonestPct(s) computed after the tick settled state.
    assert.strictEqual(out[iHonest].pct, session.getHonestPct(s),
        'the honestPct event value equals getHonestPct(s)');
})();

// Commit ordering for a missed phrase: reconcile emits nothing, commit emits the
// arcade + phraseMissed, then honestPct closes the tick.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);              // silence -> p0 will settle as missed
    var out = session.tick(s, 3.5);               // p0 settled at >=3.4
    function idx(pred) { for (var i = 0; i < out.length; i++) if (pred(out[i])) return i; return -1; }
    var iArcade = idx(function (e) { return e.type === 'arcade'; });
    var iMissed = idx(function (e) { return e.type === 'phraseMissed' && e.phraseId === 'p0'; });
    var iHonest = idx(function (e) { return e.type === 'honestPct'; });
    assert.ok(iArcade >= 0 && iMissed >= 0, 'a missed phrase commits arcade + phraseMissed in tick');
    assert.ok(iHonest >= 0 && iHonest === out.length - 1, 'honestPct closes the tick');
})();

// ===========================================================================
// PER-TASK CHARACTERIZATION TESTS (Phase 3)
// ===========================================================================

// --- Task 3.1: setActiveLine transition → prevLine overlay + transition event ---
// Advancing from line 0 (with matches) to line 1 must:
//   - build a prevLine overlay (lineIdx=0, matchedSet snapshot, overlapEnd in media sec)
//   - emit a transition event (fromIdx=0, toIdx=1)
//   - set up the new active line (activeLineIdx=1, lineWords=line-1 words)
//   - emit resetSpans for the incoming line
// The lineScored for line 0 is emitted by finalizePrevLine (Task 3.2) when
// tick sees now >= prevLine.overlapEnd — not directly by setActiveLine itself.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    // Populate matchedSet so outgoing pass has something to snapshot.
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);
    assert.strictEqual(s.matchedSet.size, 3, 'precondition: all three words matched on line 0');

    // Advance to line 1 — this triggers the full setActiveLine transition.
    var out = session.setActiveLine(s, 1, 2.0);

    // prevLine overlay must capture the outgoing line's state.
    assert.ok(s.prevLine !== null, 'prevLine overlay is created for the outgoing line');
    assert.strictEqual(s.prevLine.lineIdx, 0, 'prevLine.lineIdx is 0');
    assert.strictEqual(s.prevLine.matchedSet.size, 3,
        'prevLine.matchedSet is a snapshot of the outgoing matchedSet');

    // prevLine.overlapEnd must be in media seconds (>= now=2.0), not wall-ms.
    assert.ok(s.prevLine.overlapEnd > 2.0, 'prevLine.overlapEnd is > now (2.0) — stored as media seconds');
    assert.ok(s.prevLine.overlapEnd < 30.0, 'prevLine.overlapEnd is < 30 — not a wall-clock ms value');

    // Must emit a transition event.
    var trans = out.filter(function (e) { return e.type === 'transition'; });
    assert.strictEqual(trans.length, 1, 'setActiveLine emits exactly one transition event');
    assert.strictEqual(trans[0].fromIdx, 0, 'transition.fromIdx is 0');
    assert.strictEqual(trans[0].toIdx, 1, 'transition.toIdx is 1');

    // New active line is set up correctly.
    assert.strictEqual(s.activeLineIdx, 1, 's.activeLineIdx is 1 after setActiveLine(1)');
    assert.deepStrictEqual(s.lineWords, ['second', 'line', 'words'],
        's.lineWords is the normalized words of line 1');

    // Must emit resetSpans for the incoming line.
    var reset = out.filter(function (e) { return e.type === 'resetSpans'; });
    assert.ok(reset.length >= 1, 'setActiveLine emits resetSpans for the new line');
    assert.strictEqual(reset[0].lineIdx, 1, 'resetSpans.lineIdx is 1');
})();

// setActiveLine from -1 (not yet started) to line 0: no outgoing line, so
// no prevLine overlay, no transition event; new line is set up correctly.
(function () {
    var s = session.createSession(twoLineCfg());
    var out = session.setActiveLine(s, 0, 0.0);
    assert.strictEqual(s.prevLine, null, 'no prevLine when advancing from the initial -1 state');
    assert.strictEqual(s.activeLineIdx, 0, 's.activeLineIdx is 0');
    assert.deepStrictEqual(s.lineWords, ['first', 'line', 'words'], 'line 0 words set up correctly');
    var trans = out.filter(function (e) { return e.type === 'transition'; });
    assert.strictEqual(trans.length, 0, 'no transition event when advancing from initial -1 state');
})();

// --- Task 3.2: tick-driven prevLine finalize (media clock, not wall clock) ---
// Set up a prevLine with overlapEnd=5.0; tick at 4.9 must NOT finalize it;
// tick at 5.0 must finalize it and emit the prevLine's lineScored.
// This is the wall-clock→media-clock conversion guard (gotcha #4 in spec).
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    // Populate line 0 with matches so there is something to score at finalize.
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);
    assert.strictEqual(s.matchedSet.size, 3, 'precondition: all three words matched');

    // Advance to line 1 (now=2.0) — builds prevLine with overlapEnd > 2.0.
    session.setActiveLine(s, 1, 2.0);
    assert.ok(s.prevLine !== null, 'precondition: prevLine overlay exists');
    var overlapEnd = s.prevLine.overlapEnd;
    assert.ok(overlapEnd > 2.0, 'precondition: overlapEnd is in media seconds');

    // Force overlapEnd to 5.0 so we can test at exact boundary.
    s.prevLine.overlapEnd = 5.0;

    // tick at 4.9 — still inside the overlap window — must NOT finalize.
    var out49 = session.tick(s, 4.9);
    assert.ok(s.prevLine !== null, 'prevLine still exists at now=4.9 (before overlapEnd=5.0)');
    var scored49 = out49.filter(function (e) { return e.type === 'lineScored' && e.lineIdx === 0; });
    assert.strictEqual(scored49.length, 0, 'no lineScored for prevLine at now=4.9 (too early)');

    // tick at 5.0 — at the boundary — must finalize.
    var out50 = session.tick(s, 5.0);
    assert.strictEqual(s.prevLine, null, 'prevLine is nulled after finalization at now=5.0');
    var scored50 = out50.filter(function (e) { return e.type === 'lineScored' && e.lineIdx === 0; });
    assert.strictEqual(scored50.length, 1, 'exactly one lineScored for prevLine emitted at now=5.0');
    assert.strictEqual(scored50[0].matched, 3, 'finalized prevLine scores all three matched words');
})();

// finalizePrevLine must also null s.prevLine so a second tick does not score it again.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);
    session.setActiveLine(s, 1, 2.0);
    s.prevLine.overlapEnd = 5.0;
    session.tick(s, 5.0);                              // finalizes
    assert.strictEqual(s.prevLine, null, 'prevLine null after finalization');
    var out2 = session.tick(s, 6.0);                   // second tick
    var scored2 = out2.filter(function (e) { return e.type === 'lineScored' && e.lineIdx === 0; });
    assert.strictEqual(scored2.length, 0, 'second tick does not double-score the prevLine');
})();

// --- Task 3.3: ingestInterim marks collect-dirty (deferral-closure #2) ---
// Production runs _collectMatches on every onresult (incl. interims, player.js:431).
// The session must reproduce this: a multi-word interim without a final must credit
// ALL its in-window words via the dirty collect path (not just the single hot word
// that the hot-word match handles). This verifies runDirtyCollect runs on interim.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);                        // energized — VAD feed active
    session.ingestInterim(s, 'first line words');      // interim only, no final
    session.tick(s, 1.0);
    // The dirty collect must credit all three words (not just the hot word at index 0).
    // If only the hot-word path ran, matchedSet.size would be 1 (plus vad provisional).
    // The full collect path credits all three.
    assert.ok(s.matchedSet.size >= 3,
        'all three interim words are credited via runDirtyCollect (not just the hot word)');
})();

// Without energy, the collect path (exact/phrase/contraction) is NOT energy-gated and
// must still run when dirty. All three exact-match words must be credited.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, false);                       // silent
    session.ingestInterim(s, 'first line words');      // exact words in interim
    session.tick(s, 1.0);
    // collectMatches is NOT energy-gated — all three words should be credited.
    assert.ok(s.matchedSet.size >= 3, 'silent interim still credits all exact matches via collect path');
})();

// --- Task 3.3: endRun flush + idempotency ---
// endRun must: collect the active line, score it, settle phrases, commit newly
// settled (routeEvents=false). A second endRun must not double-score or re-commit.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);                              // collect + match
    assert.strictEqual(s.matchedSet.size, 3, 'precondition: all words matched');

    var out = session.endRun(s, 2.0);
    // endRun must emit a lineScored for the active line.
    var scored = out.filter(function (e) { return e.type === 'lineScored'; });
    assert.strictEqual(scored.length, 1, 'endRun emits exactly one lineScored for the active line');
    assert.strictEqual(scored[0].lineIdx, 0, 'lineScored is for line 0');
    assert.strictEqual(scored[0].matched, 3, 'all three words are credited');
    assert.strictEqual(session.getScores(s).linesScored, 1, 'linesScored incremented by endRun');

    // Idempotency: a second endRun must not double-score.
    var out2 = session.endRun(s, 3.0);
    var scored2 = out2.filter(function (e) { return e.type === 'lineScored'; });
    assert.strictEqual(scored2.length, 0, 'second endRun is idempotent — no duplicate lineScored');
    assert.strictEqual(session.getScores(s).linesScored, 1, 'linesScored not incremented on second endRun');
})();

// endRun also commits any newly-settled phrases (routeEvents=false: no arcade HUD
// events, but arcadeRecord is still pushed and phraseMissed/phraseCleared is still
// emitted for the end-screen paint).
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    // Settle p0 past its window (2+1.4=3.4s) without any evidence (-> miss).
    var out = session.endRun(s, 4.0);
    // routeEvents=false: no arcade HUD event.
    var arcadeHud = out.filter(function (e) { return e.type === 'arcade'; });
    assert.strictEqual(arcadeHud.length, 0, 'endRun (routeEvents=false) does not emit arcade HUD events');
    // arcadeRecord is still pushed for telemetry.
    assert.ok(s.arcadeEvents.length >= 1, 'endRun still pushes arcadeRecord to s.arcadeEvents');
    // phraseMissed emitted for the end-screen paint.
    var missed = out.filter(function (e) { return e.type === 'phraseMissed'; });
    assert.ok(missed.length >= 1, 'endRun emits phraseMissed for the end-screen paint');
    // Second call is idempotent (commit-once guard).
    var out2 = session.endRun(s, 5.0);
    var ar2 = out2.filter(function (e) { return e.type === 'arcadeRecord'; });
    assert.strictEqual(ar2.length, 0, 'second endRun does not re-commit (commit-once guard)');
})();

// ===========================================================================
// FORWARD-DECLARED CHARACTERIZATION TESTS (green progressively through Phase 1)
// ===========================================================================

// Phase-0 contract: a single matching browser_sr final scores the line via the
// collectMatches path in tick. Greens at Task 1.3 (collectMatches + ingestFinal).
(function () {
    var cfg = {
        lyrics: [lyric(0, 'hello world')],
        allWordTimings: scoring.interpolateWordTimings([lyric(0, 'hello world')]),
        phrasePlan: null, difficulty: 'medium'
    };
    var s = session.createSession(cfg);
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'hello world', 'browser_sr');
    var out = session.tick(s, 1.0);
    var scored = out.filter(function (e) { return e.type === 'wordMatched'; });
    assert.ok(scored.length >= 1, 'expected at least one wordMatched event for "hello world"');
})();

// --- #3 fix: live overlap crediting (matchPrevLine wired into tick) ---
// A final carrying the OUTGOING line's words that arrives AFTER the line boundary must
// credit the prevLine LIVE during its overlap window (not only at finalize via
// lateScoreLine). Before the fix, matchPrevLine was defined but never called, so the
// outgoing line's late words greened only at finalize. tick now re-matches prevLine while
// it is still inside its overlap window.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setActiveLine(s, 1, 2.0);                 // line 0 -> prevLine; boundary collect saw empty transcript
    assert.ok(s.prevLine && s.prevLine.lineIdx === 0, 'precondition: prevLine is line 0 in overlap');
    assert.strictEqual(s.prevLine.matchedSet.size, 0, 'precondition: nothing credited to prevLine at the boundary');
    // line 0's words arrive LATE (after the boundary), then a tick fires during overlap
    session.ingestFinal(s, 'first line words', 'browser_sr');
    var out = session.tick(s, 2.05);                  // 2.05 < overlapEnd, still in overlap window
    assert.ok(s.prevLine, 'still in overlap window after the tick');
    assert.strictEqual(s.prevLine.matchedSet.size, 3,
        '#3: late boundary words are credited to the OUTGOING line LIVE during overlap (matchPrevLine wired)');
    assert.ok(out.some(function (e) { return e.type === 'wordSpans'; }),
        '#3: live overlap crediting emits a wordSpans repaint');
})();

// --- Seek-reset primitive: resetActiveLine discards the current line + re-fences ---
// After ingesting line-0 words, a "seek" (resetActiveLine) must clear the matched set,
// clear lineHadAsrEvent (so the seeked-away line won't score), realign the transcript
// fence to now, drop any prevLine, and prevent the pre-seek transcript from crediting
// the post-seek line.
(function () {
    var s = session.createSession(threeLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);
    session.ingestFinal(s, 'first line words', 'browser_sr');
    session.tick(s, 1.0);
    assert.ok(s.matchedSet.size > 0, 'precondition: line 0 accumulated matches');
    // SEEK away from line 0.
    session.resetActiveLine(s, 5.0);
    assert.strictEqual(s.matchedSet.size, 0, 'resetActiveLine clears the matched set');
    assert.strictEqual(s.lineHadAsrEvent, false, 'resetActiveLine clears lineHadAsrEvent (seeked-away line wont score)');
    assert.strictEqual(s.lineStartTranscriptPos, s.transcriptWords.length, 'transcript fence realigned to now');
    assert.strictEqual(s.prevLine, null, 'resetActiveLine does not snapshot a prevLine');
    // Land on line 2; the pre-seek 'first line words' must not credit it ('third line words').
    session.setActiveLine(s, 2, 5.0);
    session.tick(s, 5.1);
    assert.strictEqual(s.matchedSet.size, 0, 'pre-seek transcript does not credit the post-seek line');
})();

// --- R15: getHonestPct counts ONLY settled phrases (settling + open excluded) ---
// The live on-screen Honest % (scoring-session.js honestPct event -> player.js #score-pct)
// was computed over every non-'open' phrase, so a 'settling' phrase counted its partial
// anchorHits before its late/reconcile evidence had landed -> the headline dipped then
// recovered (jitter). Excluding 'settling' makes a phrase enter the headline only once
// 'settled', so the number stops sagging mid-judgment and re-climbing.
(function () {
    // p0 fully cleared + settled (2/2); p1 mid-'settling' with no hits yet (0/2);
    // p2 still 'open'. Only p0 should count: 2/2 = 100% (not 2/4 = 50%).
    var s = { phraseSession: { states: {
        p0: { status: 'settled',  phrase: { anchorsRequired: 2 }, anchorHits: { 0: 1, 1: 1 } },
        p1: { status: 'settling', phrase: { anchorsRequired: 2 }, anchorHits: {} },
        p2: { status: 'open',     phrase: { anchorsRequired: 2 }, anchorHits: {} }
    } } };
    assert.strictEqual(session.getHonestPct(s), 100,
        'getHonestPct counts only settled phrases: 2/2 = 100% (settling p1 + open p2 excluded)');
    // A lone 'settling' phrase (nothing settled yet) contributes nothing -> null, not 0%.
    var sSettlingOnly = { phraseSession: { states: {
        p0: { status: 'settling', phrase: { anchorsRequired: 2 }, anchorHits: {} }
    } } };
    assert.strictEqual(session.getHonestPct(sSettlingOnly), null,
        'a session with only settling/open phrases has no settled denominator -> null');
})();

console.log('Scoring session tests passed.');
