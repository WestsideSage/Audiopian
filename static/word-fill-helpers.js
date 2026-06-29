/**
 * Pure per-word fill-progress helpers for the progressive word-by-word lyric
 * sweep (Phase 3 of the UX redesign). DOM-free and clock-free: the caller
 * injects nowSec, so the timing math is testable in Node.js. Browser pages
 * also get window.KaraokeeWordFill.
 *
 * Contract — words are { start: seconds, end: seconds }:
 *   wordFillProgress(word, nowSec):
 *     nowSec <= start          -> 0
 *     nowSec >= end            -> 1
 *     between                  -> linear (nowSec - start) / (end - start)
 *     end <= start (0/neg dur) -> step (nowSec < start ? 0 : 1)
 *     missing/NaN/Infinity timing or clock, or null word -> 0 (never NaN/throw)
 *     result clamped to [0, 1]
 *   lineFillProgress(words, nowSec):
 *     Array<0..1> mapping each word through wordFillProgress; [] -> [].
 *     null/undefined words -> []; a degenerate element -> 0 in that slot.
 *
 * The live consumer (player.js, Phase 3) maps scoring.js interpolateWordTimings
 * word objects onto { start, end } in SECONDS before calling these; the helper
 * itself knows nothing about scoring and never touches the scoring path.
 */
(function (root) {
    'use strict';

    /**
     * @param {{start:number,end:number}} word  timing window in seconds.
     * @param {number} nowSec                    current playhead in seconds.
     * @returns {number} fill fraction in [0, 1].
     */
    function wordFillProgress(word, nowSec) {
        if (!word) return 0;
        var start = +word.start;
        var end = +word.end;
        var now = +nowSec;
        // Missing / NaN / Infinity timing or clock: no sane sweep to compute.
        // Return 0 (no fill) rather than letting NaN reach the caller, which would
        // write the string "NaN" into the --fill CSS var and silently break the
        // word's sweep (player.js _paintWordFill). Graceful degradation.
        if (!isFinite(start) || !isFinite(end) || !isFinite(now)) return 0;
        // Zero or negative duration: no ramp to interpolate -> step at start.
        // MUST run before the <= start guard so now === start steps to 1 (per contract).
        if (end <= start) return now < start ? 0 : 1;
        if (now <= start) return 0;
        if (now >= end) return 1;
        var p = (now - start) / (end - start);
        if (p < 0) return 0;
        if (p > 1) return 1;
        return p;
    }

    /**
     * @param {Array<{start:number,end:number}>} words  per-word timing windows.
     * @param {number} nowSec                            current playhead in seconds.
     * @returns {Array<number>} per-word fill fractions in [0, 1]; [] for [].
     */
    function lineFillProgress(words, nowSec) {
        if (!words || words.length === 0) return [];
        var out = [];
        for (var i = 0; i < words.length; i++) {
            out.push(wordFillProgress(words[i], nowSec));
        }
        return out;
    }

    var api = {
        wordFillProgress: wordFillProgress,
        lineFillProgress: lineFillProgress
    };
    if (root) root.KaraokeeWordFill = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
