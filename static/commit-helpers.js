/**
 * Pure commit-cadence state machine for the realtime-whisper path.
 * No DOM / AudioContext / wall-clock / randomness — testable in Node.js.
 *
 * Decides WHEN to send input_audio_buffer.commit so gpt-realtime-whisper
 * transcribes coherent phrases instead of blind 700ms slices:
 *   - commit on speech-end (a breath/phrase boundary), and
 *   - a tempo-aware safety cap so breathless passages still flush.
 * The empty-buffer guard (no commit without speech since the last commit)
 * prevents spurious empty transcriptions, and a min-inter-commit guard
 * avoids a tiny fragment when a cap commit is immediately followed by a
 * speech-end.
 */
(function (root) {
    function capMsForTempo(tempoClass) {
        switch (tempoClass) {
            case 'fast': return 1500;
            case 'slow': return 2500;
            default:     return 2000; // normal / medium / unknown
        }
    }

    var DEFAULT_MIN_INTER_COMMIT_MS = 350;

    function createCommitState(opts) {
        opts = opts || {};
        return {
            speaking: false,          // mirror of MicVAD speech state
            speechSinceCommit: false, // was there speech since the last commit?
            capAnchorMs: 0,           // when the current cap window started
            lastCommitMs: 0,          // when we last actually committed (min-gap guard)
            // smallest gap between commits — stops a tiny fragment when a cap commit is
            // immediately followed by speech-end (the exact thing we are eliminating).
            minInterCommitMs: opts.minInterCommitMs != null ? opts.minInterCommitMs : DEFAULT_MIN_INTER_COMMIT_MS
        };
    }

    function noteSpeechStart(state, nowMs) {
        state.speaking = true;
        state.speechSinceCommit = true;
        state.capAnchorMs = nowMs;
    }

    function noteSpeechEnd(state, nowMs) {
        state.speaking = false;
        var commit = state.speechSinceCommit &&
            (nowMs - state.lastCommitMs >= state.minInterCommitMs);
        return { commit: commit };
    }

    function checkCap(state, nowMs, tempoClass) {
        if (!state.speaking || !state.speechSinceCommit) return { commit: false };
        if (nowMs - state.lastCommitMs < state.minInterCommitMs) return { commit: false };
        if (nowMs - state.capAnchorMs >= capMsForTempo(tempoClass)) return { commit: true };
        return { commit: false };
    }

    function noteCommitted(state, nowMs) {
        state.lastCommitMs = nowMs;
        state.capAnchorMs = nowMs;
        // keep the flag set if still mid-speech (so the cap keeps firing periodically);
        // clear it if speech already ended (no empty commit until the next speech-start).
        state.speechSinceCommit = state.speaking;
    }

    var api = {
        capMsForTempo: capMsForTempo,
        createCommitState: createCommitState,
        noteSpeechStart: noteSpeechStart,
        noteSpeechEnd: noteSpeechEnd,
        checkCap: checkCap,
        noteCommitted: noteCommitted
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KaraokeeCommitHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
