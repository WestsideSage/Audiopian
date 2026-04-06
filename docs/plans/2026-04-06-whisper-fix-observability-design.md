# Whisper End-to-End Fix + Observability Design

**Date:** 2026-04-06
**Status:** Approved

## Problem Statement

Session3 and Session4 telemetry show zero Whisper-sourced ASR events across all songs. Server logs confirm one `/transcribe` call that returned 503 on the first song, and zero `/transcribe` calls on songs 2–4. The confirmation system has been running on browser SR alone, which cannot reliably transcribe fast/rapped delivery. This means the provisional-to-confirmed gap cannot be properly diagnosed or fixed until Whisper is actually participating in live play.

**Root causes identified:**
1. `get_whisper_model()` lazy-loads on first request; if the model isn't cached, the first request can fail (503) and the bare `except Exception` hides the real error
2. `/transcribe` returns 503 for both "model not ready" and "transcription error" — indistinguishable
3. `_startWhisperTrack()` fails silently with only a `console.warn`; songs 2–4 sent zero chunks, reason unknown
4. `_sendChunkToWhisper()` drops non-ok responses silently; no retry, no circuit breaker, no counters
5. vad-confirmed promotions from the main browser SR merge path (line 631) and Whisper merge path (line 880) emit zero telemetry
6. `_lateScoreLine()` can upgrade matchedSet scores late but never adds confirmed words to `asrConfirmedSet`, so late Whisper confirmations are still scored as unconfirmed 0.25 VAD hits

## Scope

**In scope:**
- Server: eager model prewarming, proper error logging, tri-state status endpoint, strict readiness gate
- Client: `_whisperStatus` object (server state), `_whisperTrackStatus` object (client mic/worklet state), circuit breaker, chunk counters including network exceptions
- Telemetry: promotion logging in both merge paths, richer Whisper meta fields
- Correctness: `_lateScoreLine` VAD confirmation upgrade

**Out of scope (deferred until Whisper is confirmed live):**
- VAD threshold tuning
- Score formula changes
- Counter/perfect-line logic changes
- Score honesty UI changes

## Architecture

### Server (`app.py`)

**Module-level state:**
```python
_whisper_model = None
_whisper_state = 'idle'   # 'idle' | 'loading' | 'ready' | 'error'
_whisper_error = None     # string or None
_whisper_lock = threading.Lock()
```

**Startup prewarming:**
- On import (guarded by `os.environ.get('WERKZEUG_RUN_MAIN') == 'true'` to prevent double-init under the Flask debug reloader), launch a daemon thread that calls `_prewarm_whisper()`
- `_prewarm_whisper()` sets `_whisper_state = 'loading'`, calls `WhisperModel(...)`, on success sets `_whisper_state = 'ready'`, on exception sets `_whisper_state = 'error'` and `_whisper_error = traceback.format_exc()`, and logs the full traceback with `app.logger.exception(...)`

**`/whisper-status` GET endpoint:**
```json
{
  "status": "loading | ready | error",
  "error": "...full reason or null...",
  "model": "large-v3-turbo",
  "device": "cuda"
}
```

**`/transcribe` POST endpoint:**
- If `_whisper_state != 'ready'`: return `{"error": "model not ready", "status": _whisper_state}` with HTTP 503
- Never call `get_whisper_model()` inside the request path (strict readiness gate)
- If model ready but transcription throws: `app.logger.exception("transcribe error")` and return HTTP 500 (not 503)

### Client (`player.js`)

**Two separate state objects:**

```js
// Server model state — populated from /whisper-status at game start and after 503
this._whisperServerStatus = {
    state: 'unknown',   // 'unknown' | 'loading' | 'ready' | 'error'
    reason: null,
    checkedAt: null
};

// Client mic/worklet state — populated by _startWhisperTrack outcome
this._whisperTrackStatus = {
    state: 'idle',      // 'idle' | 'starting' | 'ready' | 'error'
    reason: null,
    startAttempts: 0,
    startFailures: 0
};
```

**`_startWhisperTrack()` changes:**
- Increment `_whisperTrackStatus.startAttempts` before attempting
- On success: set `_whisperTrackStatus.state = 'ready'`
- On catch: set `_whisperTrackStatus.state = 'error'`, `_whisperTrackStatus.reason = err.message`, increment `_whisperTrackStatus.startFailures`; still `console.warn` but also update the status object so the HUD and telemetry can surface it

**Chunk counters (on `this`):**
```js
_chunksDispatched: 0
_chunksSucceeded: 0
_chunksFailed503: 0
_chunksFailed500: 0
_chunksDroppedWhileLoading: 0
_chunksFailedNetwork: 0    // fetch threw an exception (no HTTP response)
```

**`_sendChunkToWhisper()` changes:**
- Increment `_chunksDispatched` before fetch
- On success (resp.ok): increment `_chunksSucceeded`, update `_whisperServerStatus.state = 'ready'`
- On 503: increment `_chunksFailed503`; enter circuit-breaker: set `_whisperServerStatus.state = 'loading'`; schedule a `/whisper-status` poll (e.g. after 5s); drop subsequent chunks as `_chunksDroppedWhileLoading` until status returns `ready`
- On 500: increment `_chunksFailed500`; log to console; continue sending
- On fetch exception (catch block): increment `_chunksFailedNetwork`; continue (fire-and-forget intent preserved)

**Debug HUD additions:**
- `Whisper Server: {state} | Track: {state}` row
- `Chunks: sent={dispatched} ok={succeeded} 503={failed503} 500={failed500} net={failedNetwork} drop={dropped}`

**Game start:**
- Fetch `/whisper-status` immediately and store in `_whisperServerStatus`
- Store result in `telemetry.meta.whisperStatusAtStart`

### Telemetry (`player.js`)

**Promotion logging — both merge paths:**

Browser SR merge path (~line 626–632):
```js
unionMap.forEach(function(score, i) {
    var existing = self.matchedSet.get(i);
    if (existing === undefined || score > existing) {
        self.matchedSet.set(i, score);
    }
    if (self.vadMatchedSet.has(i) && !self.asrConfirmedSet.has(i)) {
        self.asrConfirmedSet.add(i);
        self._logPromotion('browser_sr', i, score);   // NEW
    }
});
```

Whisper merge path (~line 875–882):
```js
result.forEach(function(score, i) {
    // ...existing upgrade logic...
    if (self.vadMatchedSet.has(i) && !self.asrConfirmedSet.has(i)) {
        self.asrConfirmedSet.add(i);
        self._logPromotion('whisper', i, score);      // NEW
    }
});
```

`_logPromotion(source, wordIndex, score)` — a lightweight dedicated method (not `_logMatch`) that appends to a `this._telemetry.promotions` array:
```json
{ "ts": 1.23, "lineIdx": 4, "wordIndex": 2, "source": "browser_sr|whisper", "score": 1.0 }
```
No dedup — promotion events are inherently non-redundant (guarded by `!asrConfirmedSet.has(i)`).

**`_logMatch` dedupe exemption:**
Add `&& method !== 'vad-confirmed'` to the dedup guard so the `_matchHotWord()` path also surfaces confirmations.

**`meta` additions (written at telemetry download time):**
```json
{
  "whisperStatusAtStart": { "state": "...", "reason": "..." },
  "whisperStatusFinal":   { "state": "...", "reason": "..." },
  "whisperTrackStatus":   { "state": "...", "reason": "...", "startAttempts": N, "startFailures": N },
  "whisperChunkCounters": {
    "dispatched": N, "succeeded": N,
    "failed503": N, "failed500": N,
    "failedNetwork": N, "droppedWhileLoading": N
  },
  "whisperResponses": N,
  "whisperResponsesWithWords": N,
  "whisperWordsTotal": N
}
```
`whisperAvailable` field is kept as-is (not mutated).

### Correctness Fix: `_lateScoreLine` VAD confirmation

`_lateScoreLine()` (~line 1328) runs 800ms after line advance to catch late ASR matches. When it finds a match for a word that is in `vadMatchedSet` but not yet in `asrConfirmedSet`, it should promote it:

```js
if (matchedSet.set) {
    matchedSet.set(li, result.score);
}
// NEW: promote VAD word if ASR just confirmed it late
if (vadMatchedSet && vadMatchedSet.has(li) && asrConfirmedSet && !asrConfirmedSet.has(li)) {
    asrConfirmedSet.add(li);
}
```

This ensures late Whisper transcriptions (which fire via `_collectMatchesWhisper` near the line boundary) are not scored as unconfirmed 0.25 VAD hits.

## Success Criteria

1. Server logs show `Whisper model loaded OK` at startup within ~10 seconds of app start
2. `/whisper-status` returns `{"status": "ready"}` before first song
3. Every song sends multiple chunks to `/transcribe` (visible in server logs)
4. Telemetry `whisperChunkCounters.succeeded > 0` for each song
5. `promotions` array in telemetry contains entries with `source: "whisper"` when Whisper transcribes correctly
6. No more ambiguous 503s hiding real errors — terminal shows full traceback on any transcription failure
7. Debug HUD shows real Whisper server + track state during gameplay
8. Same 4-song control panel (Praise The Lord, Big Amount, battlecry, Rubbin off the Paint) run fresh after these changes

## Files Modified

- `app.py` — prewarming, `/whisper-status`, `/transcribe` readiness gate + error split
- `static/player.js` — `_whisperServerStatus`, `_whisperTrackStatus`, circuit breaker, chunk counters, `_logPromotion`, both merge path promotions, `_lateScoreLine` upgrade, HUD row, telemetry meta
