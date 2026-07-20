/**
 * Vad-health: pure verdict for the in-game "is the energy sensor alive?" warning.
 *
 * Real incident (2026-07-20): the game's VAD produced no energy for an entire run
 * (a per-origin mic permission/device/AudioContext issue) while Web Speech — which
 * captures independently — transcribed the singer fine. The scoring engine now
 * fails open on a dead sensor (phrase-engine `_vadFlowSeen`), and this helper
 * drives the HUD chip that tells the SINGER so the run can be fixed instead of
 * silently degraded.
 *
 * The discriminating signal: the recognizer is producing text (someone is audibly
 * vocalizing) while the energy sensor has never fired this run. Silence alone is
 * never flagged — a quiet singer is not a broken sensor. Once the sensor fires at
 * all it is proven alive and the verdict is a sticky 'ok' (the caller keeps the
 * vadEverFired flag; a mid-run stream death after a successful start is out of
 * scope — the incident mode is dead-from-the-start).
 *
 * Pure and DOM-free (UMD: browser global + Node require) per CLAUDE.md.
 */

// Seconds of recognizer-text activity to tolerate before declaring the sensor
// dead — covers VAD attack latency and slow starts.
var VAD_HEALTH_GRACE_SEC = 5;

/**
 * @param {{gameActive: boolean, vadEverFired: boolean, asrActive: boolean,
 *          secsSinceFirstAsrText: (number|null)}} input
 * @param {{graceSec: number}} [opts]
 * @returns {'ok'|'pending'|'sensor-dead'}
 */
function vadHealthVerdict(input, opts) {
    input = input || {};
    var grace = (opts && isFinite(opts.graceSec)) ? opts.graceSec : VAD_HEALTH_GRACE_SEC;
    if (!input.gameActive) return 'pending';
    if (input.vadEverFired) return 'ok';
    if (!input.asrActive) return 'pending';
    var since = Number(input.secsSinceFirstAsrText);   // null -> 0, undefined -> NaN
    if (isNaN(since)) return 'pending';
    return since >= grace ? 'sensor-dead' : 'pending';
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VAD_HEALTH_GRACE_SEC: VAD_HEALTH_GRACE_SEC,
        vadHealthVerdict: vadHealthVerdict
    };
}

// Browser global (mirrors the other helper modules).
if (typeof window !== 'undefined') {
    window.KaraokeeVadHealth = {
        VAD_HEALTH_GRACE_SEC: VAD_HEALTH_GRACE_SEC,
        vadHealthVerdict: vadHealthVerdict
    };
}
