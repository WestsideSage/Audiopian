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

// --- benchmark run intent ---
assert.strictEqual(T.normalizeBenchmarkIntent('ui_test'), 'ui_test', 'ui_test is a supported run label');
assert.strictEqual(T.normalizeBenchmarkIntent('good_expert_run'), 'good_expert_run', 'expert benchmark label is supported');
assert.strictEqual(T.normalizeBenchmarkIntent('not-a-real-intent'), '', 'unknown labels cannot leak into telemetry');
assert.strictEqual(T.shouldAnalyzeRun({ summary: { honesty: { benchmarkIntent: 'ui_test' } } }), false,
    'UI-only runs are excluded from corpus analysis');
assert.strictEqual(T.shouldAnalyzeRun({ phraseEngine: { benchmark: { intent: 'good_expert_run' } } }), true,
    'benchmark runs remain eligible for corpus analysis');
assert.strictEqual(T.shouldAnalyzeRun({}), true, 'legacy untagged runs remain eligible');

// --- telemetry v3 capture profiles ---
assert.strictEqual(T.normalizeTelemetryProfile(), 'compact', 'compact analysis is the default');
assert.strictEqual(T.normalizeTelemetryProfile('recognition'), 'recognition', 'recognition diagnostics are supported');
assert.strictEqual(T.normalizeTelemetryProfile('full'), 'full', 'full engine diagnostics are supported');
assert.strictEqual(T.normalizeTelemetryProfile('unknown'), 'compact', 'unknown profiles fail closed to compact');
var diagnosticFixture = { asr: [{ text: 'hello' }], matches: [{ method: 'exact' }], promotions: [{ source: 'browser_sr' }],
    phrasePlan: { phrases: [{ phraseId: 'p0' }] }, phraseTraces: [{ phraseId: 'p0' }] };
assert.strictEqual(T.selectDiagnostics('compact', diagnosticFixture), null,
    'compact runs contain no forensic diagnostic arrays');
assert.deepStrictEqual(T.selectDiagnostics('recognition', diagnosticFixture), {
    asr: diagnosticFixture.asr, matches: diagnosticFixture.matches, promotions: diagnosticFixture.promotions
}, 'recognition profile keeps recognizer evidence without raw engine state');
assert.deepStrictEqual(T.selectDiagnostics('full', diagnosticFixture), diagnosticFixture,
    'full profile retains all forensic inputs');

// --- telemetry v3 analysis-first phrase digest ---
(function () {
    var digest = T.buildAnalysisDigest([
        {
            phraseId: 'p0', lineIdx: 4, text: 'shiny gold', startSec: 10, endSec: 12,
            lyricStatus: 'partial', flowStatus: 'clean', anchorsHit: 1, anchorsRequired: 2,
            anchors: [{ word: 'shiny', hit: true }, { word: 'gold', hit: false }],
            evidence: [
                { evidenceId: 'e1', method: 'exact', source: 'browser_final' },
                { evidenceId: 'e2', method: 'lattice', source: 'browser_final_lattice' }
            ],
            consumedTokens: [
                { word: 'shiny', anchor: 'shiny', source: 'browser_final', timeSec: 11, score: 1 },
                { word: 'goat', anchor: 'gold', source: 'browser_final_lattice', timeSec: 12.75, score: 0.85 }
            ],
            rejectedCandidates: [
                { reason: 'low_score', source: 'browser_final' },
                { reason: 'low_score', source: 'browser_final' },
                { reason: 'token_consumed', source: 'browser_final' }
            ],
            flowEvents: [{ timeSec: 10.2 }, { timeSec: 11.8 }],
            overflow: { evidence: 0, consumedTokens: 0, rejectedCandidates: 1, flowEvents: 0 }
        },
        {
            phraseId: 'p1', lineIdx: 5, text: 'uh uh', startSec: 12, endSec: 13,
            lyricStatus: 'missing', flowStatus: 'silent', anchorsHit: 0, anchorsRequired: 0,
            anchors: [], evidence: [], consumedTokens: [], rejectedCandidates: [], flowEvents: [],
            overflow: { evidence: 0, consumedTokens: 0, rejectedCandidates: 0, flowEvents: 0 }
        }
    ]);
    assert.deepStrictEqual(digest.phraseOutcomes, { clear: 0, partial: 1, miss: 0, neutral: 1 },
        'neutral phrases are not mislabeled as misses');
    assert.deepStrictEqual(digest.methodCounts, { exact: 1, lattice: 1 }, 'methods aggregate across compact rows');
    assert.deepStrictEqual(digest.rejectionCounts, { low_score: 2, token_consumed: 1 },
        'repeated rejection objects collapse to counts');
    assert.deepStrictEqual(digest.sourceCounts, { browser_sr: 2 }, 'lattice suffix normalizes to browser source');
    assert.deepStrictEqual(digest.flagCounts, { voiced_partial: 1, late_credit: 1, trace_overflow: 1 });
    assert.deepStrictEqual(digest.phrases[0].missedAnchors, ['gold'], 'missed anchors stay analyst-visible');
    assert.strictEqual(digest.phrases[0].credits[1].lateMs, 750, 'credit timing becomes direct recognizer lag');
    assert.deepStrictEqual(digest.phrases[0].flow, { status: 'clean', events: 2, firstSec: 10.2, lastSec: 11.8 });
    assert.deepStrictEqual(digest.phrases[0].overflow, { rejectedCandidates: 1 }, 'zero overflow counters are omitted');
    assert.strictEqual(digest.phrases[0].rejectedCandidates, undefined, 'raw rejection objects are absent from compact rows');
    var frameDrift = T.compactPhraseTrace({
        endSec: 4, anchorsRequired: 1, lyricStatus: 'confirmed',
        consumedTokens: [{ word: 'near', timeSec: 4.1 }]
    });
    assert.strictEqual(frameDrift.credits[0].lateMs, 100, 'small timing drift remains measurable');
    assert.ok(!frameDrift.flags.includes('late_credit'), 'sub-250ms drift is not an analyst attention flag');
})();

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
        // Real production source labels: browser_final / browser_interim (each gains a
        // '_reconciled' suffix when credited by the post-line reconcile pass), plus
        // whisper / vad. Production NEVER puts the bare 'browser_sr' label on a consumed
        // token (that string is only used on promotion render events), so clearsBySource
        // must normalize these into the three canonical recognizer buckets.
        trace('confirmed', ['whisper', 'whisper', 'browser_final']),         // whisper dominant (2 vs 1)
        trace('confirmed', ['browser_final', 'browser_interim_reconciled']), // both -> browser_sr
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
assert.deepStrictEqual(s.phraseOutcomes, { cleared: 2, partial: 1, missed: 1, neutral: 0, total: 4 }, 'outcome tally');

// --- neutral (0-anchor) phrases are excluded from the missed tally ---
// A filler-only line (all adlibs/vocables -> anchorsRequired 0) is excluded from
// scoring everywhere else (getHonestPct, arcade commit, analysis digest outcomes);
// the summary must not report it as a failed line. Observed: the 20syl — Voices
// morning run (2026-07-21) read missed=2 at 99% honest — both "misses" were
// neutral vocable lines ("yo yo yo yeah yo"). Traces without the field (legacy
// payload shapes) keep their old bucket.
var neutralRun = Object.assign({}, base, { phraseTraces: [
    Object.assign(trace('confirmed', ['browser_final']), { anchorsRequired: 2 }),
    Object.assign(trace('missing', []), { anchorsRequired: 0 }),   // vocable-only line
    Object.assign(trace('missing', []), { anchorsRequired: 3 })    // a real miss
] });
var ns = T.summarizeRun(neutralRun);
assert.deepStrictEqual(ns.phraseOutcomes, { cleared: 1, partial: 0, missed: 1, neutral: 1, total: 3 },
    'anchorsRequired<=0 phrases count as neutral, never missed');

// --- clearsBySource: dominant source per cleared phrase, normalized to canonical buckets ---
// phrase 1 -> whisper (2 whisper vs 1 browser); phrase 2 -> browser_sr (browser_final +
// browser_interim_reconciled both normalize to browser_sr). partial/missing excluded.
assert.deepStrictEqual(s.recognizer.clearsBySource, { whisper: 1, browser_sr: 1, vad: 0 }, 'dominant source per clear (normalized)');
assert.deepStrictEqual(s.recognizer.finalWordSourceCounts, base.finalWordSourceCounts, 'final word source counts passthrough');

// A clear credited entirely by the reconcile pass ('<src>_reconciled') still attributes
// to its base recognizer — the suffix must be stripped, not dropped (the real-world case:
// browser_interim_reconciled dominates most clears).
var reconciled = Object.assign({}, base, { phraseTraces: [trace('confirmed', ['browser_interim_reconciled', 'browser_final_reconciled'])] });
assert.deepStrictEqual(T.summarizeRun(reconciled).recognizer.clearsBySource, { whisper: 0, browser_sr: 1, vad: 0 }, 'reconciled browser clear attributes to browser_sr');

// --- clearsBySource tie-break: whisper > browser_sr > vad ---
var tie = Object.assign({}, base, { phraseTraces: [trace('confirmed', ['browser_final', 'whisper'])] });
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

// --- Review fix: real recognizer-lag stats. The legacy drift fields measure the
// 100ms lyric-poll's scheduling jitter (transition early/late vs expected line
// time), which says nothing about the singer or recognizer. lateCredit* derive
// from consumed tokens landing AFTER their phrase window (needs the trace
// startSec/endSec fields getPhraseTrace now exposes).
(function () {
    var lagBase = Object.assign({}, base, {
        phraseTraces: [
            Object.assign(trace('confirmed', []), { endSec: 10, consumedTokens: [
                { source: 'browser_interim_reconciled', timeSec: 10.5 },   // +500ms late
                { source: 'browser_interim_reconciled', timeSec: 9.0 }     // in-window: not late
            ] }),
            Object.assign(trace('confirmed', []), { endSec: 20, consumedTokens: [
                { source: 'browser_final', timeSec: 22.5 }                 // +2500ms late
            ] })
        ]
    });
    var lagSum = T.summarizeRun(lagBase);
    assert.strictEqual(lagSum.sync.lateCreditMedianMs, 1500, 'median of [500, 2500] late credits');
    assert.strictEqual(lagSum.sync.lateCreditMaxMs, 2500, 'max late credit');
    // Traces without window data (older payloads) -> null, schema-stable.
    var noLag = T.summarizeRun(base);
    assert.strictEqual(noLag.sync.lateCreditMedianMs, null, 'no endSec data -> null median');
    assert.strictEqual(noLag.sync.lateCreditMaxMs, null, 'no endSec data -> null max');
    console.log('late-credit sync stats: passed');
})();

console.log('test_telemetry_helpers.cjs: all assertions passed');
