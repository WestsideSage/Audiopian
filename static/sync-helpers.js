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
 * Return late-score delay (seconds) measured from end of overlap zone.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getScoreDelay(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 1.2;
        case 'fast':   return 0.5;
        case 'normal': // fall through
        default:       return 0.8;
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
        case 'fast':   return 12000; // 0.75s
        case 'normal': // fall through
        default:       return 24000; // 1.5s
    }
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getScoreDelay, getChunkSamples };
}
