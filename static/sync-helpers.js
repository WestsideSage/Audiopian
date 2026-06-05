/**
 * Pure helper functions for adaptive sync timing.
 * No DOM or AudioContext dependencies — testable in Node.js.
 */

/**
 * Classify a line's tempo based on words-per-second.
 * @param {number} wps - words per second for the line
 * @returns {'slow'|'normal'|'fast'}
 */
function classifyTempo(wps) {
    if (wps > 5.0) return 'fast';
    if (wps >= 2.0) return 'normal';
    return 'slow';
}

/**
 * Return adaptive matching window constants for a tempo class.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {{ windowStart: number, windowEnd: number, driftTrack1: number, driftTrack2: number }}
 */
function getWindowParams(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return { windowStart: -0.3, windowEnd: 1.5, driftTrack1: 14, driftTrack2: 12 };
        case 'fast':   return { windowStart: -0.5, windowEnd: 2.5, driftTrack1: 25, driftTrack2: 20 };
        case 'normal': // fall through
        default:       return { windowStart: -0.3, windowEnd: 1.5, driftTrack1: 18, driftTrack2: 15 };
    }
}

/**
 * Return overlap duration (seconds) for soft line boundaries.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getOverlapDuration(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 1.0;
        case 'fast':   return 0.5;
        case 'normal': // fall through
        default:       return 0.8;
    }
}

/**
 * Return adjusted overlap duration for short lines.
 * Short slow lines (≤3 words) get 50% more overlap time.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @param {number} wordCount - number of words on the line
 * @returns {number}
 */
function getAdjustedOverlapDuration(tempoClass, wordCount) {
    var base = getOverlapDuration(tempoClass);
    if (tempoClass === 'slow' && wordCount <= 3) {
        return base * 1.5;
    }
    return base;
}

/**
 * Return late-score delay (seconds) measured from end of overlap zone.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getScoreDelay(tempoClass) {
    // Delay (seconds) before a line is finalized/scored, measured from the end of
    // the overlap zone. Lengthened for fast/normal so the recognizer (browser SR
    // or realtime Whisper, both ~0.7-2s latency) has time to return a line's LAST
    // words before it is scored — fixes the "last word goes red even though I said
    // it" line-boundary race. Paired with prevLine.overlapEnd extended to the full
    // overlap+scoreDelay window in setActiveLine.
    switch (tempoClass) {
        case 'slow':   return 1.2;
        case 'fast':   return 1.0;
        case 'normal': // fall through
        default:       return 1.0;
    }
}

/**
 * Return AudioWorklet chunk target (samples at 16kHz) for a tempo class.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getChunkSamples(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 32000; // 2.0s
        case 'fast':   return 10000; // 0.625s — smaller chunk on fast tempo so the realtime recognizer commits sooner (less of the "catching up" lag on dense verses); realtime keeps context server-side
        case 'normal': // fall through
        default:       return 24000; // 1.5s
    }
}

/**
 * Compute per-song tempo distribution from all interpolated line timings.
 * Returns percentile thresholds for slow/medium/fast classification.
 * @param {Array} allWordTimings - array of line timing arrays, each with .wps property
 * @returns {{ p50: number, p80: number }}
 */
function computeSongTempoProfile(allWordTimings) {
    var wpsList = allWordTimings
        .map(function(lt) { return lt.wps || 0; })
        .filter(function(wps) { return wps > 0; })
        .sort(function(a, b) { return a - b; });
    if (wpsList.length === 0) return { p50: 2.0, p80: 5.0 };

    function percentile(arr, p) {
        var idx = (p / 100) * (arr.length - 1);
        var lo = Math.floor(idx);
        var hi = Math.ceil(idx);
        if (lo === hi) return arr[lo];
        return arr[lo] + (idx - lo) * (arr[hi] - arr[lo]);
    }

    return {
        p50: percentile(wpsList, 50),
        p80: percentile(wpsList, 80)
    };
}

/**
 * Classify a line's tempo relative to its song's tempo profile.
 * @param {number} wps - words per second for this line
 * @param {{ p50: number, p80: number }} profile - song tempo profile
 * @returns {'slow'|'medium'|'fast'}
 */
function classifyLineTempoRelative(wps, profile) {
    if (wps >= profile.p80) return 'fast';
    if (wps >= profile.p50) return 'medium';
    return 'slow';
}

function getSpokenWindowSize(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 20;
        case 'fast':   return 12;
        case 'normal':
        default:       return 15;
    }
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getAdjustedOverlapDuration, getScoreDelay, getChunkSamples, computeSongTempoProfile, classifyLineTempoRelative, getSpokenWindowSize };
}
