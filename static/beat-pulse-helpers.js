/**
 * Pure beat-pulse timing helpers for the on-fire "C, beat-synced" treatment.
 *
 * No DOM, no AudioContext, no clock of its own — every input (now, period,
 * anchor) is passed in, so the whole module is testable in Node.js. The visual
 * pulse itself is CSS; player.js (a later phase) drives these numbers into a
 * CSS variable and gates the animation behind
 * matchMedia('(prefers-reduced-motion: reduce)'). None of that lives here.
 *
 * Tempo classes are the same vocabulary sync-helpers.js produces
 * ('slow' | 'normal' | 'fast'); the caller passes the class string — this
 * module does not import sync-helpers.js.
 */
(function (root) {
    // Beat period (ms) for an unknown/empty tempo class. Also the 'normal' value.
    var DEFAULT_PERIOD_MS = 480;

    /**
     * Map a tempo class to a beat period in milliseconds.
     * @param {'slow'|'normal'|'fast'|*} tempoClass
     * @returns {number} period in ms (700 slow, 480 normal, 350 fast, 480 default)
     */
    function pulsePeriodMs(tempoClass) {
        switch (tempoClass) {
            case 'slow':   return 700;
            case 'normal': return 480;
            case 'fast':   return 350;
            default:       return DEFAULT_PERIOD_MS;
        }
    }

    /**
     * Fraction (0..1) through the current beat at time `nowMs`, given a beat
     * `periodMs` and a known beat instant `anchorMs` (e.g. a sung word onset).
     *
     * phase = ((nowMs - anchorMs) mod periodMs) / periodMs, normalized to [0, 1).
     *
     * - periodMs <= 0 (or non-finite) -> 0 (degenerate; no pulse).
     * - anchorMs missing/null/undefined (or non-finite) -> treated as 0.
     * - nowMs many periods after (or before) the anchor wraps correctly into
     *   [0, 1): JS `%` keeps the sign of the dividend, so a negative remainder is
     *   shifted up by one period before dividing.
     * - exactly on a beat boundary -> 0 (start of the next beat).
     *
     * @param {number} nowMs
     * @param {number} periodMs
     * @param {number} [anchorMs=0]
     * @returns {number} phase in [0, 1)
     */
    function beatPhase(nowMs, periodMs, anchorMs) {
        if (!(periodMs > 0)) return 0; // 0, negative, NaN, undefined -> no pulse
        var anchor = (typeof anchorMs === 'number' && isFinite(anchorMs)) ? anchorMs : 0;
        var rem = (nowMs - anchor) % periodMs;
        if (rem < 0) rem += periodMs; // JS % keeps dividend sign; lift into [0, periodMs)
        return rem / periodMs;
    }

    var api = {
        DEFAULT_PERIOD_MS: DEFAULT_PERIOD_MS,
        pulsePeriodMs: pulsePeriodMs,
        beatPhase: beatPhase
    };
    if (root) root.KaraokeeBeatPulse = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
