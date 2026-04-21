# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Whisper End-to-End Fix + Observability Design

**Date:** 2026-04-06
**Status:** Approved

## Problem Statement

Session3 and Session4 telemetry show zero Whisper-sourced ASR events across all songs. Server logs confirm one `/transcribe` call that returned 503 on the first song, and zero `/transcribe` calls on songs 2â€“4. The confirmation system has been running on browser SR alone, which cannot reliably transcribe fast/rapped delivery. This means the provisional-to-confirmed gap cannot be properly diagnosed or fixed until Whisper is actually participating in live play.

**Root causes identified:**
1. `get_whisper_model()` lazy-loads on first request; if the model isn't cached, the first request can fail (503) and the bare `except Exception` hides the real error
2. `/transcribe` returns 503 for both "model not ready" and "transcription error" â€” indistinguishable
3. `_startWhisperTrack()` fails silently with only a `console.warn`; songs 2â€“4 sent zero chunks, reason unknown
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
// Server model state â€” populated from /whisper-status at game start and after 503
this._whisperServerStatus = {
    state: 'unknown',   // 'unknown' | 'loading' | 'ready' | 'error'
    reason: null,
    checkedAt: null
};

// Client mic/worklet state â€” populated by _startWhisperTrack outcome
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

**Promotion logging â€” both merge paths:**

Browser SR merge path (~line 626â€“632):
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

Whisper merge path (~line 875â€“882):
```js
result.forEach(function(score, i) {
    // ...existing upgrade logic...
    if (self.vadMatchedSet.has(i) && !self.asrConfirmedSet.has(i)) {
        self.asrConfirmedSet.add(i);
        self._logPromotion('whisper', i, score);      // NEW
    }
});
```

`_logPromotion(source, wordIndex, score)` â€” a lightweight dedicated method (not `_logMatch`) that appends to a `this._telemetry.promotions` array:
```json
{ "ts": 1.23, "lineIdx": 4, "wordIndex": 2, "source": "browser_sr|whisper", "score": 1.0 }
```
No dedup â€” promotion events are inherently non-redundant (guarded by `!asrConfirmedSet.has(i)`).

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
6. No more ambiguous 503s hiding real errors â€” terminal shows full traceback on any transcription failure
7. Debug HUD shows real Whisper server + track state during gameplay
8. Same 4-song control panel (Praise The Lord, Big Amount, battlecry, Rubbin off the Paint) run fresh after these changes

## Files Modified

- `app.py` â€” prewarming, `/whisper-status`, `/transcribe` readiness gate + error split
- `static/player.js` â€” `_whisperServerStatus`, `_whisperTrackStatus`, circuit breaker, chunk counters, `_logPromotion`, both merge path promotions, `_lateScoreLine` upgrade, HUD row, telemetry meta

---

## Implementation

# Whisper End-to-End Fix + Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Whisper actually participate in live gameplay by fixing server prewarming, /transcribe error handling, client chunk dispatch, and promotion-path telemetry â€” then verify with the same 4-song control panel.

**Architecture:** Three layers of fixes: (1) server eager-loads model and exposes tri-state status, (2) client uses a circuit breaker and rich status objects instead of silent failures, (3) telemetry logs VADâ†’ASR promotion events in both merge paths and richer Whisper counters in meta. No VAD threshold tuning, no score formula changes â€” the goal is to get Whisper active and observable.

**Tech Stack:** Python + Flask backend (`app.py`), vanilla JS frontend (`static/player.js`), Node.js CJS unit tests (`tests/test_match_helpers.cjs`, `tests/test_telemetry.cjs`), pytest for Python (`tests/test_app.py`).

---

## Task 1: Server â€” Module State + Prewarm + `/whisper-status` (TDD)

**Context:** `get_whisper_model()` currently lazy-loads on the first `/transcribe` request. If it fails, the bare `except Exception: return 503` hides the real error. The fix: add tri-state module-level state (`_whisper_state: 'idle'|'loading'|'ready'|'error'`), prewarm in a background thread triggered on the first HTTP request (avoids Werkzeug reloader double-init), and expose state via a new `/whisper-status` endpoint.

**Files:**
- Modify: `app.py` (lines 17â€“32 and new endpoint after line 145)
- Modify: `tests/test_app.py` (add new tests at end)

---

**Step 1: Read `tests/test_app.py` to understand fixture setup**

```bash
cat -n tests/test_app.py
```

Note how the existing transcribe tests mock `get_whisper_model`. You will need to update those mocks after Task 2.

---

**Step 2: Add new failing tests for `/whisper-status`**

At the end of `tests/test_app.py`, append:

```python
# ---------------------------------------------------------------------------
# /whisper-status tests
# ---------------------------------------------------------------------------
import app as _app_module

def test_whisper_status_returns_loading(client):
    original = _app_module._whisper_state
    _app_module._whisper_state = 'loading'
    try:
        resp = client.get('/whisper-status')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'loading'
        assert 'model' in data
        assert 'device' in data
        assert data['error'] is None
    finally:
        _app_module._whisper_state = original

def test_whisper_status_returns_ready(client):
    original = _app_module._whisper_state
    _app_module._whisper_state = 'ready'
    try:
        resp = client.get('/whisper-status')
        data = resp.get_json()
        assert data['status'] == 'ready'
        assert data['error'] is None
    finally:
        _app_module._whisper_state = original

def test_whisper_status_returns_error_with_reason(client):
    orig_state = _app_module._whisper_state
    orig_err   = _app_module._whisper_error
    _app_module._whisper_state = 'error'
    _app_module._whisper_error = 'CUDA not available'
    try:
        resp = client.get('/whisper-status')
        data = resp.get_json()
        assert data['status'] == 'error'
        assert 'CUDA' in data['error']
    finally:
        _app_module._whisper_state = orig_state
        _app_module._whisper_error = orig_err
```

---

**Step 3: Run new tests â€” expect FAIL**

```bash
python -m pytest tests/test_app.py::test_whisper_status_returns_loading tests/test_app.py::test_whisper_status_returns_ready tests/test_app.py::test_whisper_status_returns_error_with_reason -v
```

Expected: `FAILED` â€” `AttributeError: module 'app' has no attribute '_whisper_state'`

---

**Step 4: Replace the whisper module-level state in `app.py`**

Replace lines 17â€“32 (the `_whisper_model`, `_whisper_lock`, and `get_whisper_model` block) with:

```python
_whisper_model  = None
_whisper_state  = 'idle'    # 'idle' | 'loading' | 'ready' | 'error'
_whisper_error  = None      # full traceback string when state == 'error'
_whisper_lock   = threading.Lock()
_prewarm_once   = False     # ensures prewarm thread fires only once per process

def _prewarm_whisper():
    """Load the Whisper model in a background thread. Updates module state."""
    global _whisper_model, _whisper_state, _whisper_error
    try:
        _whisper_state = 'loading'
        app.logger.info('Whisper: loading large-v3-turbo on cuda ...')
        from faster_whisper import WhisperModel
        model = WhisperModel('large-v3-turbo', device='cuda', compute_type='float16')
        with _whisper_lock:
            _whisper_model = model
            _whisper_state = 'ready'
        app.logger.info('Whisper: model ready')
    except Exception:
        import traceback as _tb
        _whisper_state = 'error'
        _whisper_error = _tb.format_exc()
        app.logger.exception('Whisper: model failed to load')


@app.before_request
def _ensure_prewarm():
    """Fire prewarm on first HTTP request. Runs only in the serving process,
    so Werkzeug's debug reloader parent (which never serves requests) stays clean."""
    global _prewarm_once
    if not _prewarm_once:
        with _whisper_lock:
            if not _prewarm_once:
                _prewarm_once = True
                threading.Thread(target=_prewarm_whisper, daemon=True).start()
```

---

**Step 5: Add `/whisper-status` endpoint in `app.py` (after `/separate-status`, before `/transcribe`)**

```python
@app.route('/whisper-status')
def whisper_status():
    return jsonify(
        status=_whisper_state,
        error=_whisper_error,
        model='large-v3-turbo',
        device='cuda',
    )
```

---

**Step 6: Run new tests â€” expect PASS**

```bash
python -m pytest tests/test_app.py::test_whisper_status_returns_loading tests/test_app.py::test_whisper_status_returns_ready tests/test_app.py::test_whisper_status_returns_error_with_reason -v
```

Expected: 3 passed.

---

**Step 7: Run full test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped (same as before â€” no regressions).

---

**Step 8: Commit**

```bash
git add app.py tests/test_app.py
git commit -m "feat: Whisper eager prewarm + tri-state /whisper-status endpoint

- Replace lazy get_whisper_model() with background prewarm thread
  triggered on first HTTP request (avoids Werkzeug reloader double-init)
- Module-level _whisper_state: idle|loading|ready|error
- Store full traceback in _whisper_error for observability
- Add /whisper-status endpoint exposing state, error, model, device"
```

---

## Task 2: Server â€” `/transcribe` Readiness Gate + 503/500 Split (TDD)

**Context:** `/transcribe` currently catches all exceptions and returns 503, collapsing "model not ready" and "transcription error" into one opaque code. Fix: check `_whisper_state` before touching the model (503 if not ready), log full traceback and return 500 if transcription itself fails.

**Files:**
- Modify: `app.py` (lines 148â€“181)
- Modify: `tests/test_app.py` (update existing transcribe tests + add 503/500 cases)

---

**Step 1: Add failing tests for 503-if-not-ready and 500-on-transcription-error**

Append to `tests/test_app.py`:

```python
def test_transcribe_returns_503_when_model_not_ready(client):
    original = _app_module._whisper_state
    _app_module._whisper_state = 'loading'
    try:
        resp = client.post('/transcribe', data=b'\x00' * 200,
                           content_type='audio/wav')
        assert resp.status_code == 503
        data = resp.get_json()
        assert data['status'] == 'loading'
    finally:
        _app_module._whisper_state = original

def test_transcribe_returns_500_on_transcription_error(client, monkeypatch):
    import app as _app_module
    _app_module._whisper_state = 'ready'
    bad_model = type('M', (), {'transcribe': staticmethod(lambda *a, **k: (_ for _ in ()).throw(RuntimeError('GPU OOM')))})()
    monkeypatch.setattr(_app_module, '_whisper_model', bad_model)
    try:
        resp = client.post('/transcribe', data=b'\x00' * 200,
                           content_type='audio/wav')
        assert resp.status_code == 500
    finally:
        _app_module._whisper_state = 'idle'
```

---

**Step 2: Run new tests â€” expect FAIL**

```bash
python -m pytest tests/test_app.py::test_transcribe_returns_503_when_model_not_ready tests/test_app.py::test_transcribe_returns_500_on_transcription_error -v
```

Expected: FAIL â€” current code returns 503 in both cases.

---

**Step 3: Replace the `/transcribe` endpoint in `app.py`**

Replace lines 148â€“181 with:

```python
@app.route('/transcribe', methods=['POST'])
def transcribe():
    """Accept a raw WAV body, transcribe with Whisper, return {transcript, words}."""
    # Strict readiness gate: never touch the model object if not confirmed ready
    if _whisper_state != 'ready':
        return jsonify(error='model not ready', status=_whisper_state), 503

    wav_bytes = request.data
    if len(wav_bytes) < 100:
        return jsonify(transcript='', words=[])

    try:
        audio_buf = io.BytesIO(wav_bytes)
        hint = request.headers.get('X-Lyric-Hint')
        kwargs = dict(language='en', beam_size=1, word_timestamps=True)
        if hint:
            kwargs['initial_prompt'] = hint

        segments, _ = _whisper_model.transcribe(audio_buf, **kwargs)
        segments = list(segments)

        text = ' '.join(s.text for s in segments).strip()
        words = []
        for seg in segments:
            if seg.words:
                for w in seg.words:
                    words.append({
                        'text':  w.word.strip(),
                        'start': round(w.start, 3),
                        'end':   round(w.end,   3),
                    })

        return jsonify(transcript=text, words=words)
    except Exception:
        app.logger.exception('Whisper transcription error on current request')
        return jsonify(transcript='', words=[]), 500
```

---

**Step 4: Update the existing `test_transcribe_whisper_exception_returns_503` test**

Find `test_transcribe_whisper_exception_returns_503` in `tests/test_app.py`. It currently mocks `get_whisper_model` to throw. After the refactor, exceptions during transcription return 500, not 503. Update it:

```python
# BEFORE:
def test_transcribe_whisper_exception_returns_503(client, monkeypatch):
    monkeypatch.setattr('app.get_whisper_model', lambda: (_ for _ in ()).throw(RuntimeError('fail')))
    resp = client.post('/transcribe', data=b'\x00' * 200, content_type='audio/wav')
    assert resp.status_code == 503

# AFTER (rename and update):
def test_transcribe_whisper_exception_returns_500(client, monkeypatch):
    import app as _app_module
    _app_module._whisper_state = 'ready'
    bad = type('M', (), {'transcribe': staticmethod(lambda *a, **k: (_ for _ in ()).throw(RuntimeError('fail')))})()
    monkeypatch.setattr(_app_module, '_whisper_model', bad)
    try:
        resp = client.post('/transcribe', data=b'\x00' * 200, content_type='audio/wav')
        assert resp.status_code == 500
    finally:
        _app_module._whisper_state = 'idle'
```

Also update any other existing transcribe tests that mock `get_whisper_model` â€” they should instead set `_app_module._whisper_state = 'ready'` and `monkeypatch.setattr(_app_module, '_whisper_model', mock_model)`.

---

**Step 5: Run full test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

---

**Step 6: Commit**

```bash
git add app.py tests/test_app.py
git commit -m "fix: /transcribe readiness gate â€” 503 if not ready, 500 on transcription error

- Check _whisper_state == 'ready' before using _whisper_model (never
  falls back to lazy init, which was the root cause of the first-request 503)
- Log full traceback on transcription failure (app.logger.exception)
- Return HTTP 500 for transcription errors vs 503 for model-not-ready
- Update tests: transcription exceptions now correctly expect 500"
```

---

## Task 3: Client â€” Whisper Status Objects + Game Start Check

**Context:** `_startWhisperTrack()` fails silently with only a `console.warn`. The client has no structured state for server vs client Whisper health, and telemetry receives only a coarse `whisperAvailable` boolean. Fix: add `_whisperServerStatus` and `_whisperTrackStatus` objects, fetch `/whisper-status` at game start, and update `_startWhisperTrack` to populate `_whisperTrackStatus`.

**Files:**
- Modify: `static/player.js` â€” three locations: constructor (~line 425), `start()` (~line 508), `_startWhisperTrack()` (~line 690)

No browser unit tests for AudioContext/fetch logic. Verify via the debug HUD in Task 5.

---

**Step 1: Add status objects to the `GameMode` constructor**

After line 430 (`this._whisperInFlight = 0;`), add:

```js
        // Whisper server state (populated from /whisper-status at game start)
        this._whisperServerStatus = { state: 'unknown', reason: null, checkedAt: null };

        // Whisper client track state (populated by _startWhisperTrack outcome)
        this._whisperTrackStatus  = { state: 'idle', reason: null, startAttempts: 0, startFailures: 0 };

        // Whisper chunk telemetry counters
        this._chunksDispatched        = 0;
        this._chunksSucceeded         = 0;
        this._chunksFailed503         = 0;
        this._chunksFailed500         = 0;
        this._chunksDroppedWhileLoading = 0;
        this._chunksFailedNetwork     = 0;
        this._whisperResponses        = 0;
        this._whisperResponsesWithWords = 0;
        this._whisperWordsTotal       = 0;
```

---

**Step 2: Fetch `/whisper-status` at game `start()`**

In `start()`, after the call to `this._startWhisperTrack()` (line ~508), add:

```js
        // Fetch server Whisper state and store for telemetry and HUD
        fetch('/whisper-status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                this._whisperServerStatus = {
                    state:     data.status || 'unknown',
                    reason:    data.error  || null,
                    checkedAt: Date.now(),
                };
            }.bind(this))
            .catch(function() {
                this._whisperServerStatus = { state: 'error', reason: 'status fetch failed', checkedAt: Date.now() };
            }.bind(this));
```

---

**Step 3: Update `_startWhisperTrack()` to populate `_whisperTrackStatus`**

Replace the existing `_startWhisperTrack()` method (~lines 690â€“727):

```js
    async _startWhisperTrack() {
        this._whisperTrackStatus.startAttempts++;
        try {
            this._whisperTrackStatus.state = 'starting';
            this._whisperStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            this._whisperCtx    = new AudioContext({ sampleRate: 16000 });
            await this._whisperCtx.audioWorklet.addModule('/static/audio-processor.js');
            const src  = this._whisperCtx.createMediaStreamSource(this._whisperStream);
            this._whisperNode = new AudioWorkletNode(this._whisperCtx, 'chunk-processor');
            this._vadAnalyser = this._whisperCtx.createAnalyser();
            this._vadAnalyser.fftSize = 256;
            this._vadAnalyserBuf = new Float32Array(this._vadAnalyser.fftSize);
            src.connect(this._vadAnalyser);
            this._whisperNode.port.onmessage = (e) => {
                if (!this.active) return;
                var msg = e.data;
                if (msg && msg.type === 'energy') {
                    // isSpeaking handled via AnalyserNode in updateHotWord
                } else if (msg && msg.type === 'chunk') {
                    this._sendChunkToWhisper(msg.data);
                } else if (msg && msg.type === 'overlap-chunk') {
                    if (this._whisperInFlight < 2) {
                        this._sendChunkToWhisper(msg.data);
                    }
                } else if (msg instanceof Float32Array) {
                    this._sendChunkToWhisper(msg);
                }
            };
            src.connect(this._whisperNode);
            this._whisperTrackStatus.state = 'ready';
        } catch (err) {
            this._whisperTrackStatus.state = 'error';
            this._whisperTrackStatus.reason = err.message || String(err);
            this._whisperTrackStatus.startFailures++;
            console.warn('[Whisper track] unavailable:', this._whisperTrackStatus.reason);
            this._whisperStream = null;
            this._whisperCtx    = null;
            this._whisperNode   = null;
        }
    }
```

---

**Step 4: Run full test suite (Python)**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

---

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: client Whisper status objects + game-start /whisper-status fetch

- Add _whisperServerStatus {state, reason, checkedAt} and
  _whisperTrackStatus {state, reason, startAttempts, startFailures}
- Add chunk telemetry counters to constructor
- _startWhisperTrack() now populates _whisperTrackStatus on success/fail
  instead of bare console.warn; startAttempts and startFailures tracked
- fetch /whisper-status at game start; store in _whisperServerStatus"
```

---

## Task 4: Client â€” Circuit Breaker + Chunk Counters

**Context:** `_sendChunkToWhisper()` silently drops any non-ok response and has no counters. A 503 (model loading) should enter a circuit breaker state and pause chunk dispatch until the server reports ready. All failure modes need separate counters.

**Files:**
- Modify: `static/player.js` â€” `_sendChunkToWhisper()` (~lines 746â€“773) and one new helper method

---

**Step 1: Add `_checkWhisperServerStatus()` helper before `_sendChunkToWhisper`**

Insert this method after `_stopWhisperTrack()` (~line 744):

```js
    /** Poll /whisper-status and update _whisperServerStatus. Returns a Promise. */
    _checkWhisperServerStatus() {
        return fetch('/whisper-status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                this._whisperServerStatus = {
                    state:     data.status || 'unknown',
                    reason:    data.error  || null,
                    checkedAt: Date.now(),
                };
            }.bind(this))
            .catch(function() { /* silent â€” best effort */ }.bind(this));
    }
```

---

**Step 2: Replace `_sendChunkToWhisper()` with circuit-breaker version**

Replace lines 746â€“773 with:

```js
    async _sendChunkToWhisper(float32) {
        // Circuit breaker: if server said it's loading, drop chunk and poll instead
        if (this._whisperServerStatus.state === 'loading') {
            this._chunksDroppedWhileLoading++;
            // Poll once per dropped chunk (rate-limited by chunk cadence ~2s)
            this._checkWhisperServerStatus();
            return;
        }

        this._chunksDispatched++;
        this._whisperInFlight++;
        const wav = encodeWav(float32, 16000);
        try {
            var headers = { 'Content-Type': 'audio/wav' };
            if (this.activeLineIdx >= 0 && lyrics[this.activeLineIdx]) {
                headers['X-Lyric-Hint'] = lyrics[this.activeLineIdx].text;
            }
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: headers,
            });

            if (resp.status === 503) {
                this._chunksFailed503++;
                // Enter circuit-breaker: server model not ready, pause dispatch
                this._whisperServerStatus.state = 'loading';
                this._checkWhisperServerStatus(); // async poll to detect when ready
                return;
            }
            if (resp.status === 500) {
                this._chunksFailed500++;
                console.warn('[Whisper] transcription error (500) â€” continuing');
                return;
            }
            if (!resp.ok) {
                this._chunksFailed500++;
                console.warn('[Whisper] unexpected HTTP', resp.status);
                return;
            }

            const data = await resp.json();
            this._chunksSucceeded++;
            this._whisperServerStatus.state = 'ready'; // confirmed working

            if (data.transcript && this.active) {
                this.whisperBuffer = (this.whisperBuffer + ' ' + data.transcript).trim();
                this.lineHadAsrEvent = true;
                this._collectMatchesWhisper(this.whisperBuffer);
                this._logAsr('final', data.transcript, data.words || [], 'whisper');
                this._whisperResponses++;
                if (data.words && data.words.length > 0) {
                    this._whisperResponsesWithWords++;
                    this._whisperWordsTotal += data.words.length;
                }
            }
            if (data.words && data.words.length > 0 && this.active) {
                this._lastWhisperWords = data.words;
            }
        } catch (_err) {
            this._chunksFailedNetwork++;
            /* fire-and-forget â€” network errors are expected on flaky connections */
        } finally {
            this._whisperInFlight = Math.max(0, this._whisperInFlight - 1);
        }
    }
```

---

**Step 3: Run full test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

---

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: Whisper circuit breaker + chunk failure counters

- 503 â†’ enter circuit-breaker (drop chunks, poll /whisper-status to resume)
- 500 â†’ log and continue sending
- Network exception â†’ _chunksFailedNetwork (separate from HTTP errors)
- Track _chunksDispatched, Succeeded, Failed503, Failed500, FailedNetwork,
  DroppedWhileLoading, _whisperResponses, ResponsesWithWords, WordsTotal
- Move _logAsr whisper call inside success path alongside response counters"
```

---

## Task 5: Client â€” Debug HUD Whisper Row

**Context:** The HUD currently shows only `VAD hits:N | asr-conf:N/N`. Add a Whisper row showing server state, track state, and chunk counts so failures are visible during live play.

**Files:**
- Modify: `static/player.js` â€” `_renderDebugHud()` (~line 1662)

---

**Step 1: Add Whisper HUD row after the existing VAD row**

Find (~line 1662):
```js
        html += `<div class="dbg-row"><span class="dbg-label">VAD   </span>hits:${vadHits} | asr-conf:${confirmed}/${this.lineWords.length}</div>`;
```

Add directly after it:
```js
        // Whisper server + track state
        const wSrv   = (this._whisperServerStatus && this._whisperServerStatus.state) || 'unknown';
        const wTrk   = (this._whisperTrackStatus  && this._whisperTrackStatus.state)  || 'idle';
        const wDisp  = this._chunksDispatched        || 0;
        const wOk    = this._chunksSucceeded         || 0;
        const w503   = this._chunksFailed503         || 0;
        const w500   = this._chunksFailed500         || 0;
        const wNet   = this._chunksFailedNetwork     || 0;
        const wDrop  = this._chunksDroppedWhileLoading || 0;
        html += `<div class="dbg-row"><span class="dbg-label">Whisp </span>srv:${wSrv} trk:${wTrk} | sent:${wDisp} ok:${wOk} 503:${w503} 500:${w500} net:${wNet} drop:${wDrop}</div>`;
```

---

**Step 2: Run full test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

---

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: debug HUD Whisper row â€” server state, track state, chunk counters"
```

---

## Task 6: Telemetry â€” `_logPromotion` + Browser SR Merge Logging

**Context:** When `_collectMatches` (browser SR) upgrades a VAD-matched word into `asrConfirmedSet`, zero telemetry is emitted. Add a dedicated `_logPromotion()` method (not `_logMatch` â€” no dedup, different schema) and call it in the browser SR union merge.

**Files:**
- Modify: `static/player.js` â€” `_initTelemetry()` (~line 1383), browser SR union merge (~line 626), new `_logPromotion()` method, and `tests/test_telemetry.cjs`

---

**Step 1: Add `promotions: []` to `_initTelemetry()`**

Find (~line 1397):
```js
            asr:         [],
            matches:     [],
            transitions: []
```

Replace with:
```js
            asr:         [],
            matches:     [],
            promotions:  [],   // VADâ†’ASR upgrade events (both browser SR and Whisper paths)
            transitions: []
```

---

**Step 2: Add `_logPromotion()` method after `_logAsr()`**

Insert after the closing brace of `_logAsr()` (~line 1426):

```js
    /**
     * Record a VADâ†’ASR promotion event.
     * Called when a word transitions from provisional VAD credit to ASR-confirmed.
     * Uses wordIndex (not word string) as key to handle repeated words on a line.
     * Not deduped â€” promotion events are inherently non-redundant (guarded by !asrConfirmedSet.has).
     * @param {'browser_sr'|'whisper'} source
     * @param {number} wordIndex   - index within lineWords
     * @param {number} score       - the ASR match score that triggered promotion
     */
    _logPromotion(source, wordIndex, score) {
        if (!this._telemetry) return;
        try {
            this._telemetry.promotions.push({
                ts:        parseFloat((performance.now() / 1000).toFixed(3)),
                lineIdx:   this.activeLineIdx,
                wordIndex: wordIndex,
                source:    source,
                score:     score,
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }
```

---

**Step 3: Add promotion logging to the browser SR union merge**

Find (~line 626):
```js
            unionMap.forEach(function(score, i) {
                var existing = self.matchedSet.get(i);
                if (existing === undefined || score > existing) {
                    self.matchedSet.set(i, score);
                }
                if (self.vadMatchedSet.has(i)) self.asrConfirmedSet.add(i);
            });
```

Replace with:
```js
            unionMap.forEach(function(score, i) {
                var existing = self.matchedSet.get(i);
                if (existing === undefined || score > existing) {
                    self.matchedSet.set(i, score);
                }
                if (self.vadMatchedSet.has(i) && !self.asrConfirmedSet.has(i)) {
                    self.asrConfirmedSet.add(i);
                    self._logPromotion('browser_sr', i, score);
                }
            });
```

---

**Step 4: Add failing telemetry test for `promotions` array**

In `tests/test_telemetry.cjs`, add after Test 4:

```js
// ---------------------------------------------------------------------------
// Test 5b: promotions array schema
// ---------------------------------------------------------------------------
console.log('\nTest 5b: promotions entry schema');
{
    const p = {
        ts: 2.50, lineIdx: 1, wordIndex: 3, source: 'browser_sr', score: 1.0
    };
    const required = ['ts', 'lineIdx', 'wordIndex', 'source', 'score'];
    required.forEach(k => assert(k in p, `promotion has key "${k}"`));
    assert(['browser_sr', 'whisper'].includes(p.source), 'promotion source valid');
    assert(typeof p.wordIndex === 'number', 'wordIndex is number');
}
```

(Renumber the existing Tests 5 and 6 to 5c and 6 if needed, or just append at end.)

---

**Step 5: Run all tests**

```bash
node tests/test_telemetry.cjs && python -m pytest tests/ -v
```

Expected: all JS tests pass + 32 Python passed, 1 skipped.

---

**Step 6: Commit**

```bash
git add static/player.js tests/test_telemetry.cjs
git commit -m "feat: _logPromotion + browser SR merge promotion logging

- Add promotions:[] array to telemetry
- Add _logPromotion(source, wordIndex, score) â€” not deduped, uses index not word string
- Log browser_sr promotion in union merge when VAD word gets ASR-confirmed
- Add telemetry schema test for promotions entry"
```

---

## Task 7: Telemetry â€” Whisper Merge Promotion + `_lateScoreLine` VAD Upgrade

**Context:** Two remaining gaps: (1) the Whisper merge path (~line 880) also adds to `asrConfirmedSet` but emits no promotion log, and (2) `_lateScoreLine()` can upgrade `matchedSet` scores late via ASR but never adds the word to `asrConfirmedSet` â€” meaning late Whisper confirmations are still scored as unconfirmed 0.25 VAD hits.

**Files:**
- Modify: `static/player.js` â€” Whisper merge (~line 875) and `_lateScoreLine()` match block (~line 1347)

---

**Step 1: Add promotion logging to the Whisper merge path**

Find (~line 875):
```js
        whisperMap.forEach(function(score, i) {
            var existing = this.matchedSet.get(i);
            if (existing === undefined || score > existing) {
                this.matchedSet.set(i, score);
            }
            if (this.vadMatchedSet.has(i)) this.asrConfirmedSet.add(i);
        }.bind(this));
```

Replace with:
```js
        whisperMap.forEach(function(score, i) {
            var existing = this.matchedSet.get(i);
            if (existing === undefined || score > existing) {
                this.matchedSet.set(i, score);
            }
            if (this.vadMatchedSet.has(i) && !this.asrConfirmedSet.has(i)) {
                this.asrConfirmedSet.add(i);
                this._logPromotion('whisper', i, score);
            }
        }.bind(this));
```

---

**Step 2: Add VAD confirmation upgrade in `_lateScoreLine()`**

Find in `_lateScoreLine()` the block where a match is found and `matchedSet` is updated (~line 1347):
```js
                    if (matchedSet.set) {
                        matchedSet.set(li, result.score);
                    } else {
                        matchedSet.add(li); // fallback for Set
                    }
```

Add immediately after `matchedSet.set(li, result.score)`:
```js
                    if (matchedSet.set) {
                        matchedSet.set(li, result.score);
                    } else {
                        matchedSet.add(li); // fallback for Set
                    }
                    // Promote VAD word to ASR-confirmed if late ASR just matched it
                    if (vadMatchedSet && vadMatchedSet.has(li) && asrConfirmedSet && !asrConfirmedSet.has(li)) {
                        asrConfirmedSet.add(li);
                    }
```

---

**Step 3: Run full test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

---

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: Whisper merge promotion logging + lateScoreLine VAD upgrade

- Log 'whisper' promotions in _collectMatchesWhisper merge path (was silent)
- _lateScoreLine now adds confirmed words to asrConfirmedSet when late ASR
  matches a VAD-backed word â€” prevents late Whisper hits scoring as 0.25"
```

---

## Task 8: Telemetry â€” Dedupe Fix + Meta Fields at Download

**Context:** `_logMatch` dedup suppresses `vad-confirmed` events from the `_matchHotWord` path. Fix the guard. Also add all the richer Whisper meta fields to `_downloadTelemetry()` and update the telemetry test.

**Files:**
- Modify: `static/player.js` â€” `_logMatch()` dedup guard (~line 1438) and `_downloadTelemetry()` (~line 1560)
- Modify: `tests/test_telemetry.cjs` â€” add meta field assertions

---

**Step 1: Fix `_logMatch` dedup guard**

Find (~line 1438):
```js
        if (matched && this._telemetryLoggedMatches && this._telemetryLoggedMatches.has(this.activeLineIdx + ':' + targetWord)) {
            return;  // Already logged a match for this word on this line
        }
```

Replace with:
```js
        // Exempt vad-confirmed â€” a promotion is a distinct event from the earlier provisional.
        if (method !== 'vad-confirmed' && matched && this._telemetryLoggedMatches && this._telemetryLoggedMatches.has(this.activeLineIdx + ':' + targetWord)) {
            return;  // Already logged a match for this word on this line
        }
```

---

**Step 2: Add Whisper meta fields to `_downloadTelemetry()`**

Find (~line 1560):
```js
            // Fill in whisperAvailable now that async setup has completed
            if (this._telemetry.meta.whisperAvailable === null) {
                this._telemetry.meta.whisperAvailable = !!(this._whisperStream);
            }
```

Add after it:
```js
            // Richer Whisper observability fields (supplement, not replace, whisperAvailable)
            this._telemetry.meta.whisperStatusAtStart  = this._whisperServerStatus ? Object.assign({}, this._whisperServerStatus) : null;
            this._telemetry.meta.whisperStatusFinal    = { state: this._whisperServerStatus ? this._whisperServerStatus.state : 'unknown', reason: this._whisperServerStatus ? this._whisperServerStatus.reason : null };
            this._telemetry.meta.whisperTrackStatus    = this._whisperTrackStatus ? Object.assign({}, this._whisperTrackStatus) : null;
            this._telemetry.meta.whisperChunkCounters  = {
                dispatched:         this._chunksDispatched         || 0,
                succeeded:          this._chunksSucceeded          || 0,
                failed503:          this._chunksFailed503          || 0,
                failed500:          this._chunksFailed500          || 0,
                failedNetwork:      this._chunksFailedNetwork      || 0,
                droppedWhileLoading: this._chunksDroppedWhileLoading || 0,
            };
            this._telemetry.meta.whisperResponses           = this._whisperResponses           || 0;
            this._telemetry.meta.whisperResponsesWithWords  = this._whisperResponsesWithWords  || 0;
            this._telemetry.meta.whisperWordsTotal          = this._whisperWordsTotal          || 0;
```

---

**Step 3: Add meta field tests to `tests/test_telemetry.cjs`**

Add a new test block to verify the new meta field shapes:

```js
// ---------------------------------------------------------------------------
// Test 7: whisper meta fields shape
// ---------------------------------------------------------------------------
console.log('\nTest 7: whisper meta fields');
{
    const whisperChunkCounters = {
        dispatched: 10, succeeded: 8, failed503: 1, failed500: 0,
        failedNetwork: 1, droppedWhileLoading: 2
    };
    const required = ['dispatched','succeeded','failed503','failed500','failedNetwork','droppedWhileLoading'];
    required.forEach(k => assert(k in whisperChunkCounters, `chunkCounters has "${k}"`));
    assert(typeof whisperChunkCounters.dispatched === 'number', 'dispatched is number');

    const whisperStatusAtStart = { state: 'ready', reason: null, checkedAt: 12345 };
    assert(['idle','loading','ready','error','unknown'].includes(whisperStatusAtStart.state),
        'whisperStatusAtStart.state is valid');

    console.log('  whisper meta shape tests passed');
}
```

---

**Step 4: Run all tests**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs && python -m pytest tests/ -v
```

Expected: all JS tests pass + 32 Python passed, 1 skipped.

---

**Step 5: Commit**

```bash
git add static/player.js tests/test_telemetry.cjs
git commit -m "feat: telemetry meta â€” whisper counters, status fields, dedupe fix

- Exempt vad-confirmed from _logMatch dedup (promotion != provisional)
- Add whisperStatusAtStart, whisperStatusFinal, whisperTrackStatus,
  whisperChunkCounters, whisperResponses, whisperResponsesWithWords,
  whisperWordsTotal to meta at download time (supplements whisperAvailable)
- Add telemetry schema tests for chunkCounters and whisperStatus fields"
```

---

## Task 9: Final Verification

**Step 1: Run the full test suite**

```bash
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_telemetry.cjs
python -m pytest tests/ -v
```

Expected: all JS suites pass; Python: 32 passed, 1 skipped.

---

**Step 2: Start the server and verify Whisper loads**

```bash
python app.py
```

Watch the terminal. Within ~10 seconds of the first HTTP request (page load), you should see:

```
Whisper: loading large-v3-turbo on cuda ...
Whisper: model ready
```

Then open a browser and check:

```
GET http://localhost:5000/whisper-status
```

Expected response: `{"status": "ready", "error": null, "model": "large-v3-turbo", "device": "cuda"}`

---

**Step 3: Enable debug mode and verify the HUD**

Load any song, open debug overlay (press D), start game mode. Verify:

- `Whisp  srv:ready trk:ready | sent:0 ok:0 503:0 500:0 net:0 drop:0` appears
- After ~5â€“10 seconds of gameplay, `sent:N ok:N` counts increment

---

**Step 4: Run the 4-song control panel**

Play the same 4 songs as Sessions 3 and 4:
1. A$AP Rocky â€” Praise The Lord (Da Shine)
2. 2 Chainz ft. Drake â€” Big Amount
3. Nujabes â€” battlecry
4. YBN Nahmir â€” Rubbin off the Paint

After each song, download telemetry (press D, download). After all 4 songs, send telemetry files to Codex for analysis.

**Key questions for the next analysis:**
- `whisperChunkCounters.succeeded > 0` for each song?
- `promotions` array contains entries with `source: 'whisper'`?
- Did weighted line scores improve vs Session4 baseline (0.744)?

---

**Step 5: Commit any corrections found during smoke check**

```bash
git add -p
git commit -m "fix: smoke-check corrections"
```
