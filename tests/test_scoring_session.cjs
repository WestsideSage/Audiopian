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
             phrasePlan: buildPhrasePlanFromLyrics(L), difficulty: 'medium',
             flags: { KARAOKEE_V2: true } };
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
                phrasePlan: buildPhrasePlanFromLyrics(L), difficulty: 'medium',
                flags: { KARAOKEE_V2: true } };
    // (silent) edit-distance-only match must be rejected.
    var s = session.createSession(cfg);
    session.setActiveLine(s, 0, 0.0);     // now=0.5 below lands the hot word on idx 0 (candle)
    session.setEnergy(s, false);
    var out = matchHotWordForTest(s, 'cendle', 0.5);
    assert.strictEqual(out.filter(function (e) { return e.type === 'wordMatched'; }).length, 0,
        'edit-distance match must be rejected while silent');
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

// ===========================================================================
// FORWARD-DECLARED CHARACTERIZATION TESTS (green progressively through Phase 1)
// ===========================================================================

// Phase-0 contract: a single matching browser_sr final scores the line via the
// collectMatches path in tick. Greens at Task 1.3 (collectMatches + ingestFinal).
(function () {
    var cfg = {
        lyrics: [lyric(0, 'hello world')],
        allWordTimings: scoring.interpolateWordTimings([lyric(0, 'hello world')]),
        phrasePlan: null, difficulty: 'medium', flags: { KARAOKEE_V2: true }
    };
    var s = session.createSession(cfg);
    session.setActiveLine(s, 0, 0.0);
    session.ingestFinal(s, 'hello world', 'browser_sr');
    var out = session.tick(s, 1.0);
    var scored = out.filter(function (e) { return e.type === 'wordMatched'; });
    assert.ok(scored.length >= 1, 'expected at least one wordMatched event for "hello world"');
})();

console.log('Scoring session tests passed.');
