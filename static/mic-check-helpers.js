/**
 * Pure verdict state-machine for the pre-game Mic Check.
 * Given the loudest mic level seen so far, whatever the active recognizer has
 * transcribed, and how long the check has run, decide what to tell the player.
 * DOM-free + clock-free (elapsedMs injected) so it's unit-testable.
 *
 * status: 'no-recognizer' | 'listening' | 'silent' | 'capturing' | 'recognized'
 *   - no-recognizer: the active recognizer isn't usable at all
 *   - listening:     just started, nothing heard yet (within the grace window)
 *   - silent:        grace elapsed and the mic never rose above the floor (mic/permission problem)
 *   - capturing:     mic is clearly picking up sound, but no words transcribed yet
 *   - recognized:    the recognizer produced text — the whole pipeline works (ok = true)
 */
var MIC_CHECK_DEFAULT_FLOOR = 0.02;   // RMS amplitude that counts as "the mic hears you"
var MIC_CHECK_SILENCE_MS = 4000;      // how long to wait before declaring silence

function micCheckVerdict(state) {
    state = state || {};
    var floor = (state.levelFloor != null) ? state.levelFloor : MIC_CHECK_DEFAULT_FLOOR;

    if (state.recognizerAvailable === false) {
        return { status: 'no-recognizer', ok: false,
                 message: "Voice recognition isn't available here — use desktop Chrome or Edge." };
    }
    var heard = state.transcript != null && String(state.transcript).trim().length > 0;
    if (heard) {
        return { status: 'recognized', ok: true, message: "You're good to go!" };
    }
    if ((state.peakLevel || 0) >= floor) {
        return { status: 'capturing', ok: false, message: "Mic's picking you up — say the line…" };
    }
    if ((state.elapsedMs || 0) >= MIC_CHECK_SILENCE_MS) {
        return { status: 'silent', ok: false,
                 message: "We're not hearing your mic. Check it's connected and that you allowed mic access." };
    }
    return { status: 'listening', ok: false, message: 'Listening…' };
}

var KaraokeeMicCheck = { micCheckVerdict: micCheckVerdict, MIC_CHECK_DEFAULT_FLOOR: MIC_CHECK_DEFAULT_FLOOR, MIC_CHECK_SILENCE_MS: MIC_CHECK_SILENCE_MS };
if (typeof window !== 'undefined') window.KaraokeeMicCheck = KaraokeeMicCheck;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeMicCheck;
