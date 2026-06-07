/**
 * Pure helper functions for an adaptive, debounced voice-activity gate.
 * No DOM, AudioContext, wall-clock, or randomness — testable in Node.js.
 *
 * Replaces the legacy one-shot fixed-threshold RMS gate (single baseline over
 * the first 2s, then a frozen threshold + single-frame isSpeaking flip). This
 * gate continuously adapts a noise floor (EMA, frozen while speaking so speech
 * cannot inflate it) and uses dual-threshold hysteresis with consecutive-frame
 * debouncing so single-frame spikes/dips do not flip the latched state.
 */

/**
 * Create a fresh VAD state object.
 * @param {Object} [opts]
 * @param {number} [opts.floorAlpha=0.05] EMA factor for the adaptive noise floor.
 * @param {number} [opts.openMargin=0.02]  Margin above floor to OPEN the gate.
 * @param {number} [opts.closeMargin=0.01] Margin above floor to CLOSE the gate
 *                                         (must be < openMargin for hysteresis).
 * @param {number} [opts.openFrames=2]  Consecutive frames above openThreshold to switch ON.
 * @param {number} [opts.closeFrames=5] Consecutive frames below closeThreshold to switch OFF.
 * @returns {Object} state
 */
function createVadState(opts) {
    opts = opts || {};
    var floorAlpha = opts.floorAlpha != null ? opts.floorAlpha : 0.05;
    var openMargin = opts.openMargin != null ? opts.openMargin : 0.02;
    var closeMargin = opts.closeMargin != null ? opts.closeMargin : 0.01;
    var openFrames = opts.openFrames != null ? opts.openFrames : 2;
    var closeFrames = opts.closeFrames != null ? opts.closeFrames : 5;

    return {
        // config
        floorAlpha: floorAlpha,
        openMargin: openMargin,
        closeMargin: closeMargin,
        openFrames: openFrames,
        closeFrames: closeFrames,
        // runtime
        noiseFloor: 0,
        isSpeaking: false,
        openCounter: 0,
        closeCounter: 0,
        calibrated: false
    };
}

/**
 * Seed the noise floor from a pre-song quiet frame. Runs the EMA unconditionally
 * (no speaking guard), so call this only with known-quiet ambient frames.
 * @param {Object} state
 * @param {number} rms
 * @returns {number} the updated noiseFloor
 */
function calibrate(state, rms) {
    state.noiseFloor += state.floorAlpha * (rms - state.noiseFloor);
    state.calibrated = true;
    return state.noiseFloor;
}

/**
 * Process one audio frame. Mutates `state` and returns the current gate decision.
 * @param {Object} state
 * @param {number} rms - RMS energy of this frame (>= 0).
 * @returns {{ isSpeaking: boolean, noiseFloor: number }}
 */
function updateVad(state, rms) {
    // (1) Adapt the noise floor only while NOT speaking, so sustained speech
    //     energy cannot drag the floor upward. The opening frame still gets one
    //     final EMA update (it is decided silent at the top of this frame).
    if (!state.isSpeaking) {
        state.noiseFloor += state.floorAlpha * (rms - state.noiseFloor);
    }
    state.calibrated = true;

    // (2) Thresholds derived from the (post-EMA) floor.
    var openThreshold = state.noiseFloor + state.openMargin;
    var closeThreshold = state.noiseFloor + state.closeMargin;

    // (3) Debounced hysteresis on the latched state.
    if (!state.isSpeaking) {
        if (rms > openThreshold) {
            state.openCounter += 1;
            if (state.openCounter >= state.openFrames) {
                state.isSpeaking = true;
                state.openCounter = 0;
                state.closeCounter = 0;
            }
        } else {
            state.openCounter = 0;
        }
    } else {
        if (rms < closeThreshold) {
            state.closeCounter += 1;
            if (state.closeCounter >= state.closeFrames) {
                state.isSpeaking = false;
                state.openCounter = 0;
                state.closeCounter = 0;
            }
        } else {
            state.closeCounter = 0;
        }
    }

    return { isSpeaking: state.isSpeaking, noiseFloor: state.noiseFloor };
}

/**
 * Decide what to do with the neural VAD (Silero MicVAD) when the V2 flag is
 * toggled — or otherwise re-evaluated — mid-session. Neural-VAD init is a
 * one-shot at song-start (gated on KARAOKEE_V2 at that instant), so a later
 * flag flip never started or stopped it; this pure decision lets the controller
 * wire toggle -> start/stop without reloading. No DOM, no side effects.
 *
 * @param {Object} ctx
 * @param {boolean} ctx.v2Enabled    window.KARAOKEE_V2 (V2/arcade active).
 * @param {boolean} ctx.hasMicStream a live mic stream exists (game running);
 *                                   neural VAD has nothing to attach to without it.
 * @param {boolean} ctx.active       neural VAD currently initialized (_neuralVadActive).
 * @returns {('start'|'stop'|'none')}
 *   'start' — V2 on, mic live, not yet active (init it now).
 *   'stop'  — V2 off but still active (tear it down; the RMS gate takes over).
 *   'none'  — already in the desired state, or no mic to attach to.
 */
function neuralVadToggleAction(ctx) {
    ctx = ctx || {};
    if (ctx.v2Enabled && ctx.hasMicStream && !ctx.active) return 'start';
    if (!ctx.v2Enabled && ctx.active) return 'stop';
    return 'none';
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createVadState, updateVad, calibrate, neuralVadToggleAction };
}
