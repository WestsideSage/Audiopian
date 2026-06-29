/**
 * Pure scoring-feedback math for the Phase 2 reward layer. DOM-free, clock-free,
 * deterministic — the render layer (player.js) drives animation frames and feeds
 * t / deltas in; this module only computes. Browser pages also get
 * window.KaraokeeScoreFeedback. Mirrors data scoring-arcade.js already produces
 * (points / pointsAwarded / multiplier / streak); does NOT touch scoring logic.
 *
 * Contract (see docs/superpowers/specs/2026-06-28-ux-redesign-design.md §3.4):
 *   formatPointsGain(pointsAwarded)        -> '+1,250' | ''
 *   countUpValue(from, to, t)              -> ease-out integer; t in [0,1]
 *   countUpDurationMs(delta)               -> clamp(round(300 + |delta|*0.4), 300, 1200)
 *   lineVerdict(score, maxScore)           -> 'perfect' | 'nice' | 'partial' | 'miss'
 *   milestoneForStreak(streak)             -> '10 STREAK' | '25 STREAK' | '50 STREAK' | null
 *   tierUpLabel(prevMultiplier, multiplier)-> '2x' | null
 */
(function (root) {
    var COUNT_UP_MIN_MS = 300;
    var COUNT_UP_MAX_MS = 1200;
    var COUNT_UP_PER_DELTA = 0.4;
    var STREAK_MILESTONES = [10, 25, 50];

    function clamp(n, lo, hi) {
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    /**
     * Format an awarded-points gain as a "+N" badge with thousands grouping.
     * Non-positive or non-finite input yields '' (nothing to celebrate).
     * @param {number} pointsAwarded
     * @returns {string}
     */
    function formatPointsGain(pointsAwarded) {
        var n = Number(pointsAwarded);
        if (!isFinite(n) || n <= 0) return '';
        var whole = Math.floor(n);
        return '+' + whole.toLocaleString('en-US');
    }

    /**
     * Ease-out interpolated INTEGER from `from` to `to` for t in [0,1].
     * t is clamped to [0,1]; t=0 -> from, t=1 -> to exactly.
     * @param {number} from
     * @param {number} to
     * @param {number} t
     * @returns {number}
     */
    function countUpValue(from, to, t) {
        var clamped = clamp(Number(t) || 0, 0, 1);
        // ease-out cubic: fast start, settling finish. eased(0)=0, eased(1)=1.
        var eased = 1 - Math.pow(1 - clamped, 3);
        return Math.round(from + (to - from) * eased);
    }

    /**
     * Animation duration for a count-up of magnitude `delta` (points jumped).
     * clamp(round(300 + |delta|*0.4), 300, 1200).
     * @param {number} delta
     * @returns {number}
     */
    function countUpDurationMs(delta) {
        var d = Math.abs(Number(delta) || 0);
        return clamp(Math.round(COUNT_UP_MIN_MS + d * COUNT_UP_PER_DELTA), COUNT_UP_MIN_MS, COUNT_UP_MAX_MS);
    }

    /**
     * Per-line verdict from a line's score vs its max possible score.
     * r = maxScore>0 ? score/maxScore : 0.
     *   r>=1 -> 'perfect'; r>=0.75 -> 'nice'; r>0 -> 'partial'; else 'miss'.
     * @param {number} score
     * @param {number} maxScore
     * @returns {'perfect'|'nice'|'partial'|'miss'}
     */
    function lineVerdict(score, maxScore) {
        var r = (maxScore > 0) ? (score / maxScore) : 0;
        if (r >= 1) return 'perfect';
        if (r >= 0.75) return 'nice';
        if (r > 0) return 'partial';
        return 'miss';
    }

    /**
     * Streak callout label for the milestone streak lengths (10/25/50), else null.
     * @param {number} streak
     * @returns {string|null}
     */
    function milestoneForStreak(streak) {
        return STREAK_MILESTONES.indexOf(streak) !== -1 ? (String(streak) + ' STREAK') : null;
    }

    /**
     * One-shot tier-up label when the multiplier rises; null when flat/falling.
     * @param {number} prevMultiplier
     * @param {number} multiplier
     * @returns {string|null}
     */
    function tierUpLabel(prevMultiplier, multiplier) {
        return (multiplier > prevMultiplier) ? (String(multiplier) + 'x') : null;
    }

    var api = {
        formatPointsGain: formatPointsGain,
        countUpValue: countUpValue,
        countUpDurationMs: countUpDurationMs,
        lineVerdict: lineVerdict,
        milestoneForStreak: milestoneForStreak,
        tierUpLabel: tierUpLabel
    };
    if (root) root.KaraokeeScoreFeedback = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
