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
    var BENCHMARK_INTENTS = {
        '': true,
        good_expert_run: true,
        humming_cheese: true,
        silent_section_test: true,
        ui_test: true
    };
    var CHEESE_INTENTS = { humming_cheese: true, silent_section_test: true };
    var TELEMETRY_PROFILES = { compact: true, recognition: true, full: true };
    var ACTIONABLE_LATE_CREDIT_MS = 250;

    function normalizeBenchmarkIntent(value) {
        var intent = value == null ? '' : String(value).trim();
        return BENCHMARK_INTENTS[intent] ? intent : '';
    }

    function normalizeTelemetryProfile(value) {
        var profile = value == null ? '' : String(value).trim();
        return TELEMETRY_PROFILES[profile] ? profile : 'compact';
    }

    function selectDiagnostics(profile, inputs) {
        profile = normalizeTelemetryProfile(profile);
        inputs = inputs || {};
        if (profile === 'compact') return null;
        var diagnostics = {
            asr: inputs.asr || [],
            matches: inputs.matches || [],
            promotions: inputs.promotions || []
        };
        if (profile === 'full') {
            diagnostics.phrasePlan = inputs.phrasePlan || null;
            diagnostics.phraseTraces = inputs.phraseTraces || [];
        }
        return diagnostics;
    }

    // Corpus reports should ignore runs whose purpose was exercising UI controls,
    // while retaining old untagged payloads for backwards compatibility.
    function shouldAnalyzeRun(payload) {
        payload = payload || {};
        var summaryIntent = payload.summary && payload.summary.honesty
            ? payload.summary.honesty.benchmarkIntent : null;
        var benchmarkIntent = payload.phraseEngine && payload.phraseEngine.benchmark
            ? payload.phraseEngine.benchmark.intent : null;
        return normalizeBenchmarkIntent(summaryIntent != null ? summaryIntent : benchmarkIntent) !== 'ui_test';
    }

    // Source preference for breaking clearsBySource ties.
    var SOURCE_RANK = { whisper: 3, browser_sr: 2, vad: 1 };

    // Map a raw consumed-token source to one of the three canonical recognizer buckets.
    // Production emits browser_final / browser_interim (each gaining a '_reconciled' suffix
    // when credited by the post-line reconcile pass), plus whisper / vad — it never puts the
    // bare 'browser_sr' label on a consumed token (that string is only used on promotion
    // render events). Without this normalization every browser-sourced clear fell through
    // the fixed {whisper,browser_sr,vad} buckets and clearsBySource read all-zero.
    function normalizeSource(src) {
        if (!src) return null;
        var base = String(src).replace(/_(?:reconciled|lattice)$/, '');
        if (base === 'whisper') return 'whisper';
        if (base === 'vad') return 'vad';
        if (base === 'browser_final' || base === 'browser_interim' || base === 'browser_sr') return 'browser_sr';
        return null;
    }

    function increment(counts, key, amount) {
        if (!key) key = 'unknown';
        counts[key] = (counts[key] || 0) + (amount == null ? 1 : amount);
    }

    function roundedSec(value) {
        return value == null || !isFinite(value) ? null : parseFloat(Number(value).toFixed(3));
    }

    function compactPhraseTrace(trace) {
        trace = trace || {};
        var required = trace.anchorsRequired || 0;
        var outcome = required <= 0 ? 'neutral'
            : trace.lyricStatus === 'confirmed' ? 'clear'
            : trace.lyricStatus === 'partial' ? 'partial' : 'miss';
        var methodCounts = {};
        (trace.evidence || []).forEach(function (item) {
            increment(methodCounts, item && item.method);
        });
        var rejectionCounts = {};
        (trace.rejectedCandidates || []).forEach(function (item) {
            increment(rejectionCounts, item && item.reason);
        });
        var sourceCounts = {};
        var credits = (trace.consumedTokens || []).map(function (credit) {
            var source = normalizeSource(credit && credit.source) || 'unknown';
            increment(sourceCounts, source);
            var timeSec = roundedSec(credit && credit.timeSec);
            var lateMs = timeSec != null && trace.endSec != null && timeSec > trace.endSec
                ? Math.round((timeSec - trace.endSec) * 1000) : 0;
            return {
                word: credit && credit.word || '',
                anchor: credit && credit.anchor || '',
                source: credit && credit.source || '',
                timeSec: timeSec,
                lateMs: lateMs,
                score: credit && credit.score != null ? credit.score : null
            };
        });
        var flowEvents = trace.flowEvents || [];
        var overflow = {};
        Object.keys(trace.overflow || {}).forEach(function (key) {
            if (trace.overflow[key]) overflow[key] = trace.overflow[key];
        });
        var flags = [];
        if (required > 0 && flowEvents.length > 0 && outcome === 'miss') flags.push('voiced_miss');
        if (required > 0 && flowEvents.length > 0 && outcome === 'partial') flags.push('voiced_partial');
        if (credits.some(function (credit) { return credit.lateMs >= ACTIONABLE_LATE_CREDIT_MS; })) {
            flags.push('late_credit');
        }
        if (Object.keys(overflow).length) flags.push('trace_overflow');

        var row = {
            phraseId: trace.phraseId,
            lineIdx: trace.lineIdx,
            text: trace.text || '',
            startSec: roundedSec(trace.startSec),
            endSec: roundedSec(trace.endSec),
            outcome: outcome,
            lyricStatus: trace.lyricStatus || 'missing',
            anchors: {
                hit: trace.anchorsHit || 0,
                required: required,
                total: (trace.anchors || []).length
            },
            missedAnchors: (trace.anchors || []).filter(function (anchor) { return !anchor.hit; })
                .map(function (anchor) { return anchor.word; }),
            credits: credits,
            methodCounts: methodCounts,
            rejectionCounts: rejectionCounts,
            sourceCounts: sourceCounts,
            flow: {
                status: trace.flowStatus || 'silent',
                events: flowEvents.length,
                firstSec: flowEvents.length ? roundedSec(flowEvents[0].timeSec) : null,
                lastSec: flowEvents.length ? roundedSec(flowEvents[flowEvents.length - 1].timeSec) : null
            },
            flags: flags
        };
        if (Object.keys(overflow).length) row.overflow = overflow;
        return row;
    }

    function buildAnalysisDigest(traces) {
        var phrases = (traces || []).map(compactPhraseTrace);
        var digest = {
            phraseOutcomes: { clear: 0, partial: 0, miss: 0, neutral: 0 },
            methodCounts: {},
            rejectionCounts: {},
            sourceCounts: {},
            flagCounts: {},
            phrases: phrases
        };
        phrases.forEach(function (phrase) {
            increment(digest.phraseOutcomes, phrase.outcome);
            Object.keys(phrase.methodCounts).forEach(function (key) {
                increment(digest.methodCounts, key, phrase.methodCounts[key]);
            });
            Object.keys(phrase.rejectionCounts).forEach(function (key) {
                increment(digest.rejectionCounts, key, phrase.rejectionCounts[key]);
            });
            Object.keys(phrase.sourceCounts).forEach(function (key) {
                increment(digest.sourceCounts, key, phrase.sourceCounts[key]);
            });
            phrase.flags.forEach(function (flag) { increment(digest.flagCounts, flag); });
        });
        return digest;
    }

    function median(nums) {
        if (!nums || nums.length === 0) return null;
        var arr = nums.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    }

    function dominantSource(consumedTokens) {
        var counts = {};
        (consumedTokens || []).forEach(function (t) {
            var s = normalizeSource(t && t.source);
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

        // Real recognizer lag: how long after a phrase's window did its credited
        // tokens land? (The drift fields above only measure the lyric-poll's
        // scheduling jitter — they always look good and say nothing about the
        // recognizer.) Needs traces that carry endSec (getPhraseTrace).
        var lateLags = [];
        traces.forEach(function (tr) {
            if (tr == null || tr.endSec == null) return;
            (tr.consumedTokens || []).forEach(function (c) {
                if (c && c.timeSec != null && c.timeSec > tr.endSec) {
                    lateLags.push(Math.round((c.timeSec - tr.endSec) * 1000));
                }
            });
        });

        var pointsBuilt = (arc.points || 0) > 0;
        var maxMult = arc.maxMultiplier || 1;
        var intent = normalizeBenchmarkIntent(inputs.benchmarkIntent);
        var isCheeseIntent = !!CHEESE_INTENTS[intent];

        return {
            difficulty: inputs.difficulty || 'medium',
            scores: inputs.scores || { honestLyricPct: null, composite: null },
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
                linesLate: late,
                lateCreditMedianMs: median(lateLags),
                lateCreditMaxMs: lateLags.length ? Math.max.apply(null, lateLags) : null
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
        BENCHMARK_INTENTS: BENCHMARK_INTENTS,
        CHEESE_INTENTS: CHEESE_INTENTS,
        TELEMETRY_PROFILES: TELEMETRY_PROFILES,
        buildAnalysisDigest: buildAnalysisDigest,
        compactPhraseTrace: compactPhraseTrace,
        median: median,
        normalizeBenchmarkIntent: normalizeBenchmarkIntent,
        normalizeTelemetryProfile: normalizeTelemetryProfile,
        selectDiagnostics: selectDiagnostics,
        shouldAnalyzeRun: shouldAnalyzeRun,
        summarizeRun: summarizeRun
    };
});
