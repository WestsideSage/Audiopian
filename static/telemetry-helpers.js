(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeTelemetry = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Benchmark intent labels that mean "this run was deliberate cheese" — used to
    // flag runs where the arcade nonetheless built credit (a validation failure).
    var CHEESE_INTENTS = { humming_cheese: true, silent_section_test: true };

    // Source preference for breaking clearsBySource ties.
    var SOURCE_RANK = { whisper: 3, browser_sr: 2, vad: 1 };

    function median(nums) {
        if (!nums || nums.length === 0) return null;
        var arr = nums.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    }

    function dominantSource(consumedTokens) {
        var counts = {};
        (consumedTokens || []).forEach(function (t) {
            var s = t && t.source;
            if (!s) return;
            counts[s] = (counts[s] || 0) + 1;
        });
        var best = null, bestN = -1;
        Object.keys(counts).forEach(function (s) {
            var n = counts[s];
            if (n > bestN || (n === bestN && (SOURCE_RANK[s] || 0) > (SOURCE_RANK[best] || 0))) {
                best = s; bestN = n;
            }
        });
        return best;
    }

    // inputs documented in the spec section 4.1. Pure: only derives.
    function summarizeRun(inputs) {
        inputs = inputs || {};
        var arc = inputs.arcadeSummary || { points: 0, maxMultiplier: 1, longestStreak: 0, perfects: 0, clears: 0 };
        var traces = inputs.phraseTraces || [];
        var transitions = inputs.transitions || [];

        var outcomes = { cleared: 0, partial: 0, missed: 0, total: traces.length };
        var clearsBySource = { whisper: 0, browser_sr: 0, vad: 0 };
        traces.forEach(function (tr) {
            if (tr.lyricStatus === 'confirmed') {
                outcomes.cleared++;
                var src = dominantSource(tr.consumedTokens);
                if (src && clearsBySource[src] != null) clearsBySource[src]++;
            } else if (tr.lyricStatus === 'partial') {
                outcomes.partial++;
            } else {
                outcomes.missed++;
            }
        });

        var drifts = [], early = 0, late = 0;
        transitions.forEach(function (t) {
            if (t.earlyMs != null) { drifts.push(Math.abs(t.earlyMs)); early++; }
            else if (t.lateMs != null) { drifts.push(Math.abs(t.lateMs)); late++; }
        });

        var pointsBuilt = (arc.points || 0) > 0;
        var maxMult = arc.maxMultiplier || 1;
        var intent = inputs.benchmarkIntent || '';
        var isCheeseIntent = !!CHEESE_INTENTS[intent];

        return {
            difficulty: inputs.difficulty || 'medium',
            karaokeeV2: !!inputs.karaokeeV2,
            scores: inputs.scores || { v1Pct: null, honestLyricPct: null, composite: null },
            arcade: {
                points: arc.points || 0,
                grade: inputs.grade || null,
                maxMultiplier: maxMult,
                longestStreak: arc.longestStreak || 0,
                perfects: arc.perfects || 0,
                clears: arc.clears || 0
            },
            phraseOutcomes: outcomes,
            recognizer: {
                clearsBySource: clearsBySource,
                finalWordSourceCounts: inputs.finalWordSourceCounts || {}
            },
            sync: {
                medianLineDriftMs: median(drifts),
                linesEarly: early,
                linesLate: late
            },
            honesty: {
                benchmarkIntent: intent,
                pointsBuilt: pointsBuilt,
                maxMultiplier: maxMult,
                suspectedCheeseInflation: isCheeseIntent && (pointsBuilt || maxMult > 1)
            },
            counts: inputs.counts || {}
        };
    }

    return {
        CHEESE_INTENTS: CHEESE_INTENTS,
        median: median,
        summarizeRun: summarizeRun
    };
});
