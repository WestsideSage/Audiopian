(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeArcade = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // --- Tunables (spec section 5/10). Calibrate by feel during validation. ---
    var BASE_PER_ANCHOR = 100;   // base points per required anchor
    var RAMP_PER_TIER = 4;       // ramp units to advance one multiplier tier
    var PERFECT_BONUS = 0.5;     // +50% base on a perfect phrase
    var PERFECT_BONUS_RAMP = 2;  // ramp units a perfect adds (a bare clear adds 1)

    // Perfect-phrase threshold (spec section 12). Default "all" is the most resistant
    // to recognizer-completeness inflation; calibrate against real honest-run telemetry.
    var PERFECT_THRESHOLD = 'all';     // 'all' | 'requiredPlusOne' | 'ratio'
    var ANCHOR_PERFECT_RATIO = 0.8;    // used only when PERFECT_THRESHOLD === 'ratio'

    var ARCADE_TUNING = {
        easy:   { baseScale: 1.0,  maxMultiplier: 4 },
        medium: { baseScale: 1.25, maxMultiplier: 4 },
        hard:   { baseScale: 1.5,  maxMultiplier: 6 },
        expert: { baseScale: 2.0,  maxMultiplier: 8 }
    };

    function tuningFor(difficulty) {
        return ARCADE_TUNING[difficulty] || ARCADE_TUNING.medium;
    }

    function createArcadeState(difficulty) {
        return {
            difficulty: difficulty || 'medium',
            tuning: tuningFor(difficulty),
            points: 0,
            multiplier: 1,
            ramp: 0,
            streak: 0,
            longestStreak: 0,
            maxMultiplier: 1,
            perfects: 0,
            clears: 0,
            onFire: false,
            committed: {}
        };
    }

    // hit/required/total are anchor counts (hit is UNCAPPED).
    function isPerfect(hit, required, total) {
        if (!total || total <= 0) return false;
        if (PERFECT_THRESHOLD === 'ratio') return hit >= Math.ceil(total * ANCHOR_PERFECT_RATIO);
        if (PERFECT_THRESHOLD === 'requiredPlusOne') return hit >= Math.min(total, (required || 0) + 1);
        return hit >= total; // 'all'
    }

    // Commit a phrase exactly once at its settled boundary. `o` =
    // {phraseId, anchorsRequired, anchorsTotal, anchorsHit, rescuedByWhisper?}.
    // Returns the event for the HUD, or null if already committed / invalid.
    function commitPhrase(state, o) {
        if (!state || !o || o.phraseId == null) return null;
        if (state.committed[o.phraseId]) return null;
        state.committed[o.phraseId] = true;

        var required = o.anchorsRequired || 0;
        var total = o.anchorsTotal || 0;
        var hit = o.anchorsHit || 0;
        var tuning = state.tuning;

        var outcome, pointsAwarded = 0, perfect = false;

        if (required > 0 && hit >= required) {
            outcome = 'clear';
            perfect = isPerfect(hit, required, total);
            var mult = state.multiplier; // award with current multiplier, THEN advance
            var base = BASE_PER_ANCHOR * required * tuning.baseScale;
            pointsAwarded = Math.round(base * (perfect ? 1 + PERFECT_BONUS : 1) * mult);
            state.points += pointsAwarded;
            state.clears += 1;
            if (perfect) state.perfects += 1;
            state.streak += 1;
            if (state.streak > state.longestStreak) state.longestStreak = state.streak;
            state.ramp += perfect ? PERFECT_BONUS_RAMP : 1;
            while (state.ramp >= RAMP_PER_TIER && state.multiplier < tuning.maxMultiplier) {
                state.multiplier += 1;
                state.ramp -= RAMP_PER_TIER;
            }
            if (state.multiplier >= tuning.maxMultiplier) {
                state.multiplier = tuning.maxMultiplier;
                state.ramp = RAMP_PER_TIER; // show a full bar at max
            }
            if (state.multiplier > state.maxMultiplier) state.maxMultiplier = state.multiplier;
        } else if (hit === 0) {
            outcome = 'miss';
            state.multiplier = 1;
            state.ramp = 0;
            state.streak = 0;
        } else {
            outcome = 'partial'; // hold — no points, no ramp, no reset
        }

        state.onFire = state.multiplier === tuning.maxMultiplier;

        return {
            phraseId: o.phraseId,
            outcome: outcome,
            perfect: perfect,
            pointsAwarded: pointsAwarded,
            points: state.points,
            multiplier: state.multiplier,
            ramp: state.ramp,
            rampPerTier: RAMP_PER_TIER,
            streak: state.streak,
            onFire: state.onFire
        };
    }

    function rampProgress(state) {
        if (!state) return 0;
        if (state.multiplier >= state.tuning.maxMultiplier) return 1;
        var p = state.ramp / RAMP_PER_TIER;
        if (p < 0) return 0;
        if (p > 1) return 1;
        return p;
    }

    function gradeFor(pct) {
        if (pct >= 95) return 'S';
        if (pct >= 85) return 'A';
        if (pct >= 72) return 'B';
        if (pct >= 58) return 'C';
        return 'D';
    }

    function getArcadeSummary(state) {
        return {
            points: state.points,
            maxMultiplier: state.maxMultiplier,
            longestStreak: state.longestStreak,
            perfects: state.perfects,
            clears: state.clears
        };
    }

    return {
        ARCADE_TUNING: ARCADE_TUNING,
        createArcadeState: createArcadeState,
        commitPhrase: commitPhrase,
        isPerfect: isPerfect,
        rampProgress: rampProgress,
        gradeFor: gradeFor,
        getArcadeSummary: getArcadeSummary
    };
});
