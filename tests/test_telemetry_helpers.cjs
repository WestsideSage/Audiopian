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

var T = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'telemetry-helpers.js'));

// --- median ---
assert.strictEqual(T.median([]), null, 'empty median is null');
assert.strictEqual(T.median([5]), 5, 'single');
assert.strictEqual(T.median([3, 1, 2]), 2, 'odd median (sorted middle)');
assert.strictEqual(T.median([4, 1, 2, 3]), 2.5, 'even median (avg of middle two)');

// Trace helper: a phrase trace with given lyricStatus and per-token sources.
function trace(lyricStatus, sources) {
    return { lyricStatus: lyricStatus, consumedTokens: (sources || []).map(function (s) { return { source: s }; }) };
}

// --- phraseOutcomes tally ---
var base = {
    difficulty: 'hard',
    scores: { honestLyricPct: 68, composite: 72 },
    arcadeSummary: { points: 8400, maxMultiplier: 6, longestStreak: 9, perfects: 4, clears: 2 },
    grade: 'B',
    phraseTraces: [
        trace('confirmed', ['whisper', 'whisper', 'browser_sr']),
        trace('confirmed', ['browser_sr', 'browser_sr']),
        trace('partial', ['vad']),
        trace('missing', [])
    ],
    arcadeEvents: [{ outcome: 'clear' }, { outcome: 'clear' }, { outcome: 'partial' }, { outcome: 'miss' }],
    transitions: [{ earlyMs: 100, lateMs: null }, { earlyMs: null, lateMs: 300 }, { earlyMs: null, lateMs: 200 }],
    finalWordSourceCounts: { vad: 1, browser_sr: 3, whisper: 2, unknown: 0 },
    benchmarkIntent: 'good_expert_run',
    counts: { asr: 0, matches: 0, promotions: 0, transitions: 3, arcadeEvents: 4 }
};
var s = T.summarizeRun(base);
assert.deepStrictEqual(s.phraseOutcomes, { cleared: 2, partial: 1, missed: 1, total: 4 }, 'outcome tally');

// --- clearsBySource: dominant source per cleared phrase ---
// phrase 1 -> whisper (2 vs 1); phrase 2 -> browser_sr (2). partial/missing excluded.
assert.deepStrictEqual(s.recognizer.clearsBySource, { whisper: 1, browser_sr: 1, vad: 0 }, 'dominant source per clear');
assert.deepStrictEqual(s.recognizer.finalWordSourceCounts, base.finalWordSourceCounts, 'final word source counts passthrough');

// --- clearsBySource tie-break: whisper > browser_sr > vad ---
var tie = Object.assign({}, base, { phraseTraces: [trace('confirmed', ['browser_sr', 'whisper'])] });
assert.strictEqual(T.summarizeRun(tie).recognizer.clearsBySource.whisper, 1, 'tie breaks to whisper');

// --- sync ---
assert.strictEqual(s.sync.linesEarly, 1, 'one early line');
assert.strictEqual(s.sync.linesLate, 2, 'two late lines');
assert.strictEqual(s.sync.medianLineDriftMs, 200, 'median drift of [100,300,200] = 200');

// --- scores / arcade passthrough (single path: no v1Pct, no karaokeeV2) ---
assert.deepStrictEqual(s.scores, base.scores);
assert.ok(!('karaokeeV2' in s), 'summary no longer carries the V1/V2 distinction');
assert.ok(!('v1Pct' in s.scores), 'scores no longer carries v1Pct');
assert.strictEqual(s.arcade.points, 8400);
assert.strictEqual(s.arcade.grade, 'B');
assert.strictEqual(s.arcade.maxMultiplier, 6);

// --- honesty: honest intent + points -> not flagged ---
assert.strictEqual(s.honesty.pointsBuilt, true);
assert.strictEqual(s.honesty.suspectedCheeseInflation, false, 'good_expert_run is never cheese');

// --- honesty: cheese intent + points built -> FLAGGED ---
var cheese = Object.assign({}, base, { benchmarkIntent: 'humming_cheese' });
var cs = T.summarizeRun(cheese);
assert.strictEqual(cs.honesty.suspectedCheeseInflation, true, 'humming_cheese that scored points is flagged');

// --- honesty: cheese intent + zero points + 1x -> not flagged ---
var cleanCheese = Object.assign({}, base, {
    benchmarkIntent: 'humming_cheese',
    arcadeSummary: { points: 0, maxMultiplier: 1, longestStreak: 0, perfects: 0, clears: 0 }
});
var cc = T.summarizeRun(cleanCheese);
assert.strictEqual(cc.honesty.pointsBuilt, false);
assert.strictEqual(cc.honesty.suspectedCheeseInflation, false, 'cheese that built nothing is the PASS case');

// --- degenerate run (no arcade state) -> arcade zeros, pointsBuilt false ---
var noArc = Object.assign({}, base, { arcadeSummary: null });
var noArcS = T.summarizeRun(noArc);
assert.strictEqual(noArcS.arcade.points, 0, 'null arcade summary -> 0 points');
assert.strictEqual(noArcS.honesty.pointsBuilt, false);
assert.strictEqual(noArcS.counts.transitions, 3, 'counts passthrough');

console.log('test_telemetry_helpers.cjs: all assertions passed');
