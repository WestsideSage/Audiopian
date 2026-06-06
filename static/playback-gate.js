/**
 * Pure decision: given the current playback state, should scoring be credited, and
 * should the embed-disabled fallback UI be shown? Buffering/ads/unstarted FREEZE the
 * song clock while the mic keeps advancing, so scoring must be OFF unless 'playing'.
 */
function playbackGateDecision(state, opts) {
    opts = opts || {};
    if (opts.embedDisabled) {
        return { scoringActive: false, fallback: true, reason: 'embed-disabled' };
    }
    if (state === 'playing') {
        return { scoringActive: true, fallback: false, reason: 'playing' };
    }
    return { scoringActive: false, fallback: false, reason: state || 'unknown' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { playbackGateDecision };
}
