/**
 * Pure presentation helpers for the "Neon Stage" front-end. No DOM access —
 * the caller passes raw values, so every function is testable in Node.js.
 * Browser pages also get window.KaraokeeStage.
 *
 * UMD pattern (var/plain functions), matching theme-helpers.js et al.
 */
(function (root) {

    /**
     * Fill percentage (0–100, clamped) for a range input's painted fill track.
     * The webkit/moz slider pseudo-elements can't read the input's live value,
     * so player.js mirrors it into a `--fill` CSS custom property and the
     * stylesheet paints the progress gradient from that. Guards the degenerate
     * cases (NaN, zero/negative max) to 0 so the bar never paints garbage.
     *
     * @param {number|string} value  current slider value
     * @param {number|string} max    slider maximum
     * @returns {number} 0–100 inclusive
     */
    function rangeFillPercent(value, max) {
        var v = Number(value);
        var m = Number(max);
        if (!isFinite(v) || !isFinite(m) || m <= 0) return 0;
        var pct = (v / m) * 100;
        return Math.max(0, Math.min(100, pct));
    }

    /**
     * Celebration tier for the results ceremony, derived from the letter grade.
     * Drives the confetti/spotlight treatment on #gameModal via a data attribute:
     * S and A get the full celebration; B/C/D stay quiet (a C should still make
     * you hit Play Again, not throw a party). Unknown/empty grades get ''.
     *
     * @param {string} grade  'S' | 'A' | 'B' | 'C' | 'D' (case-insensitive)
     * @returns {'s'|'a'|'b'|'c'|'d'|''}
     */
    function gradeTier(grade) {
        var g = String(grade == null ? '' : grade).trim().toLowerCase();
        return (g === 's' || g === 'a' || g === 'b' || g === 'c' || g === 'd') ? g : '';
    }

    var api = {
        rangeFillPercent: rangeFillPercent,
        gradeTier: gradeTier
    };
    if (root) root.KaraokeeStage = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
