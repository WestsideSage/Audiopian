# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Lyrics Detection Improvements Design

**Date:** 2026-02-26
**Context:** Improve Game Mode transcription accuracy (slang, rap vocabulary, curse words), reduce matching latency for fast-paced songs, and upgrade the word-matching algorithm with phonetic and fuzzy comparison.

---

## Problem Statement

The current Game Mode uses Chrome's `webkitSpeechRecognition` (Web Speech API) exclusively. This has three compounding weaknesses:

1. **Content filtering:** Chrome censors or substitutes profanity. "fuck" becomes a phonetically-adjacent clean word or is silently dropped â€” common in rap.
2. **Slang blindness:** Rap-specific vocabulary, AAVE slang, and non-standard words are frequently misrecognized or skipped because they fall outside Chrome's language model.
3. **Fast-rap latency:** Chrome delays producing "final" results for dense lyrical passages, relying on interim text. The interim-anchoring fix (lineStartWordCount from transcript + latestInterim) helps, but doesn't solve fundamental ASR gaps.

---

## Architecture: Dual-Track Transcription

Two parallel transcription tracks run simultaneously while Game Mode is active:

```
Microphone
â”œâ”€â”€ Track 1 (Speed)    â†’ SpeechRecognition API â†’ onresult â†’ phonetic+fuzzy match â”€â”€â”
â”‚                                                                                    â”œâ”€â†’ union matchedSet â†’ word spans â†’ scoring
â””â”€â”€ Track 2 (Accuracy) â†’ getUserMedia â†’ AudioWorklet â†’ 2s WAV chunks               â”‚
                                                      â†’ POST /transcribe            â”‚
                                                      â†’ faster-whisper large-v3-turbo â”‚
                                                      â†’ phonetic+fuzzy match â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

**Key invariants:**
- Neither track blocks the other. Track 1 fires every ~300ms (interim); Track 2 returns every ~2s.
- Union semantics: a word is matched if either track matched it. Once matched, it stays matched.
- Phonetic+fuzzy matching runs on both tracks' output before merging into `matchedSet`.
- Scoring at line-end uses the final unioned `matchedSet`.
- Track 2 is lazy-started â€” AudioWorklet and mic stream only spin up when Game Mode activates; they stop when it deactivates.
- Track 2 bypasses Chrome's content filter. Whisper outputs uncensored text, so curse words match freely.

---

## Section 1: Backend â€” `/transcribe` Endpoint

### Dependency

```
faster-whisper  (add to requirements.txt)
```

Uses ctranslate2 under the hood. CUDA-accelerated on the NVIDIA 4070Ti. No conflict with existing Demucs/PyTorch stack (4070Ti has 12GB VRAM; Whisper large-v3-turbo uses ~800MB, Demucs uses ~2GB).

### Model Loading

Lazy initialization: `WhisperModel` is instantiated on the first `/transcribe` request, held in a module-level variable for the process lifetime. Protected by a `threading.Lock` to handle concurrent requests during the ~3s initial load.

Model config:
- Model: `large-v3-turbo`
- Device: `cuda`
- Compute type: `float16`
- Beam size: `1` (greedy decoding â€” ~80â€“120ms per 2s chunk on 4070Ti)

### Endpoint Contract

- **Route:** `POST /transcribe`
- **Body:** Raw WAV bytes (16kHz, mono, 16-bit PCM, standard 44-byte RIFF header)
- **Response:** `{"transcript": "some words here"}` â€” always 200; empty string on silence, error, or malformed input
- Frontend treats empty transcript as a no-op; Game Mode continues with Track 1 only on any failure

### Implementation

```python
# app.py additions
import io, threading
from faster_whisper import WhisperModel

_whisper_model = None
_whisper_lock = threading.Lock()

def get_whisper_model():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            _whisper_model = WhisperModel(
                "large-v3-turbo",
                device="cuda",
                compute_type="float16"
            )
    return _whisper_model

@app.route('/transcribe', methods=['POST'])
def transcribe():
    wav_bytes = request.data
    if len(wav_bytes) < 100:
        return jsonify(transcript='')
    try:
        model = get_whisper_model()
        audio_buf = io.BytesIO(wav_bytes)
        segments, _ = model.transcribe(audio_buf, language='en', beam_size=1)
        text = ' '.join(s.text for s in segments).strip()
        return jsonify(transcript=text)
    except Exception:
        return jsonify(transcript=''), 503
```

**No changes** to `lyrics.py`, `downloader.py`, `vocal_remover.py`, or the `/separate` flow.

---

## Section 2: Frontend â€” Dual-Track Audio Capture

### Audio Capture Pipeline

1. `GameMode.start()` calls `navigator.mediaDevices.getUserMedia({audio: true})` â€” a second, independent mic acquisition alongside what `SpeechRecognition` uses internally. Chrome shares the same physical device; the user sees one permission prompt for the session.

2. An `AudioContext` is created at **16000 Hz** (`new AudioContext({sampleRate: 16000})`). Whisper natively expects 16kHz â€” no resampling needed.

3. A minimal `AudioWorklet` processor (`static/audio-processor.js`) accumulates Float32 samples. Every **32000 samples** (exactly 2s at 16kHz), it `postMessage`s the buffer to the main thread and starts fresh.

4. The main thread encodes the buffer as a standard WAV (44-byte RIFF header + Int16 PCM body, ~20 lines of vanilla JS), then POSTs it to `/transcribe`.

5. The response transcript is fed into `GameMode._collectMatchesWhisper()`, which runs the same phonetic+fuzzy matching logic as Track 1 and unions results into `matchedSet`.

6. `GameMode.stop()` disconnects the worklet node, closes the `AudioContext`, and calls `.stop()` on all mic stream tracks.

### New File: `static/audio-processor.js`

Required by the AudioWorklet spec â€” must be a separate JS module loaded via `audioContext.audioWorklet.addModule('audio-processor.js')`.

```js
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // 2s at 16kHz
    }
    process(inputs) {
        const ch = inputs[0][0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
        if (this._buf.length >= this._target) {
            this.port.postMessage(new Float32Array(this._buf.splice(0, this._target)));
        }
        return true;
    }
}
registerProcessor('chunk-processor', ChunkProcessor);
```

### WAV Encoding (inline in player.js)

```js
function encodeWav(float32, sampleRate) {
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++)
        pcm[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buf);
    // RIFF header
    const w = (o, s) => { for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
    w(0,'RIFF'); view.setUint32(4, 36+pcm.byteLength, true); w(8,'WAVE');
    w(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true);
    view.setUint16(22,1,true); view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true);
    view.setUint16(34,16,true); w(36,'data');
    view.setUint32(40,pcm.byteLength,true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
}
```

### Chunk Timing

Chunks are fixed 2s non-overlapping windows. A word straddling a chunk boundary gets its trailing half in the next chunk â€” Whisper transcribes from context and typically recovers it. Track 1 interim covers the gap during the 2s window.

---

## Section 3: Phonetic + Fuzzy Matching Layer

### Double Metaphone

~180 lines of vanilla JS implementing the standard Double Metaphone algorithm, added to `player.js`. Function signature: `doubleMetaphone(word) â†’ [primary, secondary]`. Two words are phonetically equivalent if any of their codes intersect.

No npm dependency. No build step.

### Levenshtein â‰¤ 1

~15-line function `editDistance(a, b)` using a two-row DP array. Only applied when phonetic fails AND `Math.abs(a.length - b.length) <= 1` (short-circuits obvious mismatches).

### Censored Lyric Normalization

`normalizeWord()` gains one additional step: **strip `*` characters** after punctuation removal. This means LRC lyrics like `"f**k"` normalize to `"fk"`. Whisper outputs `"fuck"` which normalizes to `"fuck"`. Double Metaphone maps both to `"FK"` â€” they match phonetically with no manual profanity table required.

### Expanded `CONTRACTION_MAP`

Add ~40 entries for AAVE/rap slang that Web Speech API commonly misrecognizes:

```js
'finna':    'fixing to',
'bouta':    'about to',
'fasho':    'for sure',
'deadass':  'seriously',
'lowkey':   'low key',
'highkey':  'high key',
'bussin':   'very good',
'fr':       'for real',
'ong':      'on god',
'ngl':      'not gonna lie',
'bruh':     'bro',
'fam':      'family',
'lit':      'excellent',
'slay':     'do well',
'cap':      'lie',
'nocap':    'no lie',
// ... more entries
```

### Updated Word Comparison

Replaces the current `spoken[si] === target` equality check in `_collectMatches`:

```js
function wordsMatch(spoken, target) {
    if (spoken === target) return true;
    const [sp, ss] = doubleMetaphone(spoken);
    const [tp, ts] = doubleMetaphone(target);
    if (sp && tp && (sp===tp || sp===ts || ss===tp || ss===ts)) return true;
    if (Math.abs(spoken.length - target.length) <= 1 &&
        editDistance(spoken, target) <= 1) return true;
    return false;
}
```

The drift window (12-word window, `lineStartWordCount` anchoring) is unchanged. Only the word comparison predicate changes.

**Performance:** DM + Levenshtein run in microseconds per word pair. 20-word line Ã— 12-word window = 240 comparisons worst-case â€” imperceptible.

---

## Section 4: Error Handling

### Backend

| Failure | Behavior |
|---|---|
| `faster-whisper` not installed / CUDA init fails | `get_whisper_model()` raises; `/transcribe` returns `{"transcript":""}` with 503 |
| Malformed or too-short WAV body (< 100 bytes) | Returns `{"transcript":""}` immediately, no Whisper call |
| Concurrent model load requests | `threading.Lock` queues them safely |
| Whisper transcription exception | Caught, returns `{"transcript":""}` with 503 |

### Frontend

| Failure | Behavior |
|---|---|
| `getUserMedia` denied | Caught in `GameMode.start()`, console warning, Track 2 silently disabled, Track 1 continues |
| `audioWorklet.addModule()` failure | Caught, Track 2 silently disabled |
| `fetch('/transcribe')` network error or timeout | `.catch()` is no-op; next 2s chunk retries automatically |
| `AudioContext` at 16000Hz unsupported | Constructor throws, caught, Track 2 silently disabled |

---

## Section 5: Testing

### New Unit Tests â€” `tests/test_lyrics.py`

Phonetic+fuzzy matching cases (tested against the JS logic via equivalent Python stubs or described as manual JS unit tests):
- Exact match: `"gonna"` â†’ `"gonna"` âœ“
- Phonetic match: `"fk"` (censored) â†’ `"fuck"` âœ“ via DM both â†’ `"FK"`
- Fuzzy match: `"teh"` â†’ `"the"` âœ“ via edit-distance 1
- Contraction expansion: `"finna"` expands before matching
- Non-match: `"apple"` â†’ `"orange"` âœ—

### New Unit Tests â€” `tests/test_app.py`

- Valid WAV fixture â†’ returns non-empty transcript (mock `get_whisper_model`)
- Empty body â†’ returns `{"transcript": ""}` with 200
- Body < 100 bytes â†’ returns `{"transcript": ""}` with 200
- Whisper raises exception â†’ returns 503

### Manual Game Mode Verification

- Fast rap track: confirm Whisper track lights up words Web Speech API misses or censors
- Dual-track union: confirm no double-flashing or desync between tracks
- Stop/start Game Mode twice: confirm no AudioContext leak or duplicate worklet

### Regression

All existing tests (`test_lyrics.py`, `test_app.py`, `test_downloader.py`, `test_vocal_remover.py`) pass without modification.

---

## Files Changed

| File | Change |
|---|---|
| `app.py` | Add `get_whisper_model()`, `/transcribe` endpoint |
| `static/player.js` | `wordsMatch()`, `doubleMetaphone()`, `editDistance()`, `encodeWav()`, expanded `CONTRACTION_MAP`, `_collectMatchesWhisper()`, dual-track start/stop in `GameMode` |
| `static/audio-processor.js` | **New** â€” AudioWorklet `ChunkProcessor` |
| `tests/test_lyrics.py` | New phonetic+fuzzy unit tests |
| `tests/test_app.py` | New `/transcribe` endpoint tests |
| `requirements.txt` | Add `faster-whisper` |

---

## Implementation

# Lyrics Detection Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dual-track transcription (Web Speech API for speed + server-side Whisper for accuracy), phonetic+fuzzy word matching, and censored lyric normalization so Game Mode correctly handles rap slang, curse words, and fast lyrical flow.

**Architecture:** Two parallel audio tracks run during Game Mode. Track 1 (existing Web Speech API) fires near-instantly for interim feedback. Track 2 (new) captures raw mic audio via AudioWorklet, encodes 2s WAV chunks, POSTs them to a new `/transcribe` endpoint backed by faster-whisper large-v3-turbo on CUDA, and unions those results into the word match set. Both tracks' results pass through a new `wordsMatch()` function using Double Metaphone phonetic encoding and Levenshtein edit-distance â‰¤ 1.

**Tech Stack:** Python/Flask backend, faster-whisper (ctranslate2/CUDA), vanilla JS AudioWorklet, Double Metaphone, Levenshtein DP, Web Speech API.

---

## Task 1: Backend â€” `/transcribe` Endpoint

**Files:**
- Modify: `requirements.txt`
- Modify: `app.py`
- Modify: `tests/test_app.py`

### Step 1: Write the failing tests

Add to the bottom of `tests/test_app.py`:

```python
import struct
import wave
import io


def _make_wav(num_samples=32000, sample_rate=16000):
    """Create a minimal valid 16kHz mono WAV with silence."""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b'\x00\x00' * num_samples)
    return buf.getvalue()


def test_transcribe_returns_transcript(client):
    """Valid WAV body â†’ 200 with transcript key."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'hello world'
    mock_model.transcribe.return_value = ([mock_segment], None)

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data['transcript'] == 'hello world'


def test_transcribe_empty_body_returns_empty(client):
    """Body shorter than 100 bytes â†’ 200 with empty transcript, no model call."""
    with patch('app.get_whisper_model') as mock_get:
        resp = client.post('/transcribe', data=b'tooshort',
                           content_type='audio/wav')

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data['transcript'] == ''
    mock_get.assert_not_called()


def test_transcribe_whisper_exception_returns_503(client):
    """If the model raises, return 503 with empty transcript."""
    mock_model = MagicMock()
    mock_model.transcribe.side_effect = RuntimeError('CUDA OOM')

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')

    assert resp.status_code == 503
    data = json.loads(resp.data)
    assert data['transcript'] == ''
```

### Step 2: Run to verify they fail

```bash
cd /c/GPT5-Projects/Karaokee && python -m pytest tests/test_app.py::test_transcribe_returns_transcript tests/test_app.py::test_transcribe_empty_body_returns_empty tests/test_app.py::test_transcribe_whisper_exception_returns_503 -v
```

Expected: **3 FAILED** â€” `ImportError: cannot import name 'get_whisper_model'` or `404` on the route.

### Step 3: Add `faster-whisper` to requirements

In `requirements.txt`, add after `demucs`:

```
faster-whisper
```

Install it:

```bash
pip install faster-whisper
```

### Step 4: Implement `get_whisper_model` and `/transcribe` in `app.py`

Add these imports at the top of `app.py` (after existing imports):

```python
import io
import threading as _threading
```

Add these globals and functions after the existing `separation_state` block (before the routes):

```python
_whisper_model = None
_whisper_lock = _threading.Lock()


def get_whisper_model():
    """Lazy-load faster-whisper large-v3-turbo on CUDA. Thread-safe."""
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel
            _whisper_model = WhisperModel(
                "large-v3-turbo",
                device="cuda",
                compute_type="float16"
            )
    return _whisper_model
```

Add this route after the existing `/separate-status` route:

```python
@app.route('/transcribe', methods=['POST'])
def transcribe():
    """Accept a raw WAV body, transcribe with Whisper, return {transcript}."""
    wav_bytes = request.data
    if len(wav_bytes) < 100:
        return jsonify(transcript='')
    try:
        model = get_whisper_model()
        audio_buf = io.BytesIO(wav_bytes)
        segments, _ = model.transcribe(audio_buf, language='en', beam_size=1)
        text = ' '.join(s.text for s in segments).strip()
        return jsonify(transcript=text)
    except Exception:
        return jsonify(transcript=''), 503
```

### Step 5: Run tests to verify they pass

```bash
python -m pytest tests/test_app.py::test_transcribe_returns_transcript tests/test_app.py::test_transcribe_empty_body_returns_empty tests/test_app.py::test_transcribe_whisper_exception_returns_503 -v
```

Expected: **3 PASSED**

Also verify existing tests still pass:

```bash
python -m pytest tests/test_app.py -v
```

Expected: **all PASSED**

### Step 6: Commit

```bash
git add requirements.txt app.py tests/test_app.py
git commit -m "feat: add /transcribe endpoint backed by faster-whisper large-v3-turbo"
```

---

## Task 2: JS â€” `doubleMetaphone`, `editDistance`, `wordsMatch`

**Files:**
- Modify: `static/player.js`

These are pure JS functions with no framework. Verification is manual via browser console. Add them near the top of `player.js`, directly after the `CONTRACTION_MAP` block.

### Step 1: Add `editDistance(a, b)` â€” Levenshtein â‰¤ 1 check

Insert after the closing `};` of `CONTRACTION_MAP`:

```js
// --- Phonetic + fuzzy matching ---

/**
 * Levenshtein edit distance (two-row DP). Returns integer >= 0.
 */
function editDistance(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({length: n + 1}, (_, i) => i);
    let curr = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            curr[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1]
                : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}
```

### Step 2: Add `doubleMetaphone(word)`

Insert directly after `editDistance`:

```js
/**
 * Double Metaphone â€” returns [primary, secondary] phonetic codes (max 4 chars each).
 * Based on the Philips (2000) algorithm. Maps words to sound-alike codes so that
 * "night" and "knight" both produce ["NT","NT"], etc.
 */
function doubleMetaphone(word) {
    if (!word || typeof word !== 'string') return ['', ''];
    word = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (!word) return ['', ''];

    const len = word.length;
    let p = '', s = '';
    let i = 0;

    function add(a, b) { p += a || ''; s += (b !== undefined ? b : a) || ''; }
    function at(pos) { return (pos >= 0 && pos < len) ? word[pos] : ''; }
    function sub(pos, n) { return word.substring(pos, pos + n); }
    function isV(c) { return 'AEIOU'.indexOf(c) >= 0; }
    function slavo() { return word.indexOf('W') > -1 || word.indexOf('K') > -1 || sub(0,2) === 'CZ'; }

    // Initial fixups
    if (/^(GN|KN|PN|AE|WR)/.test(sub(0, 2))) i = 1;
    if (at(0) === 'X') { add('S'); i = 1; }

    while (i < len) {
        const c = at(i);
        switch (c) {
            case 'A': case 'E': case 'I': case 'O': case 'U': case 'Y':
                if (i === 0) add('A');
                i++; break;
            case 'B':
                add('P'); i += (at(i+1) === 'B') ? 2 : 1; break;
            case 'C':
                if (sub(i,2) === 'CIA') { add('X'); i += 3; break; }
                if (sub(i,2) === 'CH') {
                    if (i > 0 && sub(i-2,6).match(/ORCHES|ARCHIT|ORCHID/)) { add('K'); }
                    else if (at(i+2).match(/[IEY]/)) { add('S'); }
                    else if (slavo() || sub(0,4).match(/VAN |VON |SCH/)) { add('K'); }
                    else { add('X', 'K'); }
                    i += 2; break;
                }
                if (sub(i,2).match(/CE|CI/)) { add('S'); i += 2; break; }
                if (sub(i,2) === 'CK') { add('K'); i += 2; break; }
                add('K');
                i += (at(i+1) === 'C') ? 2 : 1; break;
            case 'D':
                if (sub(i,2) === 'DG' && at(i+2).match(/[IEY]/)) { add('J'); i += 3; break; }
                add('T'); i += (sub(i,2).match(/DT|DD/)) ? 2 : 1; break;
            case 'F':
                add('F'); i += (at(i+1) === 'F') ? 2 : 1; break;
            case 'G':
                if (at(i+1) === 'H') {
                    if (i > 0 && !isV(at(i-1))) { add('K'); i += 2; break; }
                    if (i === 0) { add(at(i+2) === 'I' ? 'J' : 'K'); i += 2; break; }
                    i += 2; break;
                }
                if (at(i+1) === 'N') {
                    if (i === 1 && isV(at(0)) && !slavo()) add('KN', 'N');
                    else add('N');
                    i += 2; break;
                }
                if ('EIY'.includes(at(i+1))) { add('J', 'K'); i += 2; break; }
                add('K'); i += (at(i+1) === 'G') ? 2 : 1; break;
            case 'H':
                if (isV(at(i+1)) && (i === 0 || isV(at(i-1)))) { add('H'); i++; }
                i++; break;
            case 'J':
                add('J', 'H'); i += (at(i+1) === 'J') ? 2 : 1; break;
            case 'K':
                add('K'); i += (at(i+1) === 'K') ? 2 : 1; break;
            case 'L':
                add('L'); i += (at(i+1) === 'L') ? 2 : 1; break;
            case 'M':
                add('M'); i += (at(i+1) === 'M') ? 2 : 1; break;
            case 'N':
                add('N'); i += (at(i+1) === 'N') ? 2 : 1; break;
            case 'P':
                if (at(i+1) === 'H') { add('F'); i += 2; break; }
                add('P'); i += (at(i+1) === 'P') ? 2 : 1; break;
            case 'Q':
                add('K'); i += (at(i+1) === 'Q') ? 2 : 1; break;
            case 'R':
                add('R'); i += (at(i+1) === 'R') ? 2 : 1; break;
            case 'S':
                if (sub(i,2) === 'SH') { add('X'); i += 2; break; }
                if (sub(i,3).match(/SIO|SIA/)) { add('X'); i += 3; break; }
                if (sub(i,2) === 'SC') {
                    if (at(i+2).match(/[IEY]/)) { add('S'); i += 3; }
                    else { add('SK'); i += 3; }
                    break;
                }
                add('S'); i += (sub(i,2) === 'SS') ? 2 : 1; break;
            case 'T':
                if (sub(i,4) === 'TION' || sub(i,3).match(/TIA|TCH/)) { add('X'); i += 3; break; }
                if (sub(i,2) === 'TH') { add('0', 'T'); i += 2; break; }
                add('T'); i += (sub(i,2).match(/TT|TD/)) ? 2 : 1; break;
            case 'V':
                add('F'); i += (at(i+1) === 'V') ? 2 : 1; break;
            case 'W':
                if (sub(i,2) === 'WR') { add('R'); i += 2; break; }
                if (i === 0 && isV(at(i+1))) { add('A'); }
                i++; break;
            case 'X':
                add('KS'); i += (at(i+1).match(/[CX]/)) ? 2 : 1; break;
            case 'Z':
                if (at(i+1) === 'H') { add('J'); i += 2; break; }
                add('S'); i += (at(i+1) === 'Z') ? 2 : 1; break;
            default:
                i++; break;
        }
    }
    return [p.substring(0, 4), s.substring(0, 4)];
}
```

### Step 3: Add `wordsMatch(spoken, target)`

Insert directly after `doubleMetaphone`:

```js
/**
 * Returns true if spoken word matches target word by:
 *  1. Exact equality (after normalizeWord has already been applied to both)
 *  2. Double Metaphone phonetic match (handles "fk" == "fuck", homophones, ASR substitutions)
 *  3. Levenshtein edit distance <= 1 (handles 1-char mishearings / typos in lyrics)
 */
function wordsMatch(spoken, target) {
    if (spoken === target) return true;
    const [sp, ss] = doubleMetaphone(spoken);
    const [tp, ts] = doubleMetaphone(target);
    if (sp && tp && (sp === tp || sp === ts || (ss && (ss === tp || ss === ts)))) return true;
    if (Math.abs(spoken.length - target.length) <= 1 && editDistance(spoken, target) <= 1) return true;
    return false;
}
```

### Step 4: Replace equality check in `_collectMatches`

Find this line inside `_collectMatches` (currently line ~219):

```js
                if (spoken[si] === target) {
```

Replace it with:

```js
                if (wordsMatch(spoken[si], target)) {
```

### Step 5: Manual browser console verification

Start the Flask server (`python app.py`), open any song in the player, then open DevTools console and paste:

```js
// Phonetic: censored lyric "fk" vs Whisper output "fuck"
console.assert(wordsMatch('fk', 'fuck'), 'fk should match fuck via phonetics');
// Phonetic: "night" vs "knight"
console.assert(wordsMatch('night', 'knight'), 'night should match knight');
// Fuzzy: 1-char edit
console.assert(wordsMatch('teh', 'the'), 'teh should match the via edit-distance');
// Exact
console.assert(wordsMatch('gonna', 'gonna'), 'exact match');
// Non-match
console.assert(!wordsMatch('apple', 'orange'), 'apple should not match orange');
console.log('All wordsMatch assertions passed');
```

Expected: `All wordsMatch assertions passed` (no assertion errors).

### Step 6: Commit

```bash
git add static/player.js
git commit -m "feat: add doubleMetaphone, editDistance, wordsMatch to player.js"
```

---

## Task 3: Censored Lyric Normalization + Expanded CONTRACTION_MAP

**Files:**
- Modify: `static/player.js`

### Step 1: Update `normalizeWord` to strip asterisks

Find the existing `normalizeWord` function:

```js
function normalizeWord(w) {
    return w.toLowerCase().replace(/[''`,.!?;:\-"]/g, '').trim();
}
```

Replace with:

```js
function normalizeWord(w) {
    return w.toLowerCase().replace(/[''`,.!?;:\-"*]/g, '').trim();
}
```

This ensures LRC lyrics like `"f**k"` normalize to `"fk"`, which phonetically matches Whisper's `"fuck"` â†’ `"fk"` via Double Metaphone (both â†’ `"FK"`).

### Step 2: Expand `CONTRACTION_MAP`

Find the existing `CONTRACTION_MAP` object and replace it entirely with this expanded version:

```js
const CONTRACTION_MAP = {
    // Original entries
    'gonna':   'going to',
    'wanna':   'want to',
    'gotta':   'got to',
    'kinda':   'kind of',
    'sorta':   'sort of',
    'coulda':  'could have',
    'shoulda': 'should have',
    'woulda':  'would have',
    'ima':     'i am going to',
    'tryna':   'trying to',
    'dunno':   'do not know',
    "ain't":   'is not',
    'ain':     'is not',
    "y'all":   'you all',
    'yall':    'you all',
    // Rap / AAVE slang additions
    'finna':   'fixing to',
    'bouta':   'about to',
    'outta':   'out of',
    'lotta':   'lot of',
    'cmon':    'come on',
    'nah':     'no',
    'bruh':    'brother',
    'bro':     'brother',
    'fam':     'family',
    'fasho':   'for sure',
    'fosho':   'for sure',
    'sho':     'sure',
    'deadass': 'seriously',
    'lowkey':  'low key',
    'highkey': 'high key',
    'ong':     'on god',
    'fr':      'for real',
    'ngl':     'not gonna lie',
    'rn':      'right now',
    'smh':     'shaking my head',
    'nah':     'no',
    'aight':   'alright',
    'ight':    'alright',
    'prolly':  'probably',
    'sumn':    'something',
    'sumthin': 'something',
    'nothin':  'nothing',
    'nuthin':  'nothing',
    'cuz':     'because',
    'cus':     'because',
    'wit':     'with',
    'da':      'the',
    'dem':     'them',
    'dey':     'they',
    'dat':     'that',
    'dis':     'this',
    'em':      'them',
    'til':     'until',
    'bout':    'about',
    'ops':     'opposition',
    'lil':     'little',
};
```

### Step 3: Manual verification

In the browser console (with the player open):

```js
// Strip asterisk from censored lyric
console.assert(normalizeWord("f**k") === "fk", 'f**k should normalize to fk');
console.assert(normalizeWord("s**t") === "st", 's**t should normalize to st');
// Contraction expansion
const expanded = expandContractions(normalizeWords('finna go outta here'));
console.assert(expanded.join(' ').includes('fixing'), 'finna should expand');
console.log('Normalization assertions passed');
```

### Step 4: Commit

```bash
git add static/player.js
git commit -m "feat: add asterisk normalization and expanded rap slang CONTRACTION_MAP"
```

---

## Task 4: AudioWorklet Processor

**Files:**
- Create: `static/audio-processor.js`

### Step 1: Create the file

```js
/**
 * AudioWorklet processor that accumulates Float32 mic samples and emits
 * a 2-second chunk (32000 samples at 16kHz) to the main thread each time
 * the buffer fills. The main thread encodes the chunk as WAV and POSTs it
 * to /transcribe.
 */
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // 2 seconds at 16 000 Hz
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this._buf.push(channel[i]);
        }

        if (this._buf.length >= this._target) {
            const chunk = new Float32Array(this._buf.splice(0, this._target));
            this.port.postMessage(chunk);
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
```

### Step 2: Verify Flask serves it

AudioWorklet modules must be fetched via HTTP (not `file://`). Flask serves `static/` at `/static/<filename>`. In the browser console (with server running):

```js
fetch('/static/audio-processor.js').then(r => r.text()).then(t => console.log(t.slice(0,50)));
```

Expected: First 50 chars of the file content (starts with `/**`).

### Step 3: Commit

```bash
git add static/audio-processor.js
git commit -m "feat: add AudioWorklet chunk-processor for 2s mic capture"
```

---

## Task 5: Whisper Dual-Track in GameMode

**Files:**
- Modify: `static/player.js`

This task wires Track 2 (Whisper) into `GameMode`: adding `encodeWav`, `_startWhisperTrack`, `_stopWhisperTrack`, `_sendChunkToWhisper`, and `_collectMatchesWhisper`, then calling them at the right lifecycle points.

### Step 1: Add `encodeWav` utility function

Insert after the `wordsMatch` function:

```js
/**
 * Encode a Float32Array of mono audio samples as a standard WAV buffer.
 * @param {Float32Array} float32 - Raw audio samples in [-1, 1]
 * @param {number} sampleRate - Sample rate (16000 for Whisper)
 * @returns {ArrayBuffer} - Valid WAV file bytes ready to POST
 */
function encodeWav(float32, sampleRate) {
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF');  v.setUint32(4, 36 + pcm.byteLength, true);
    w(8, 'WAVE');  w(12, 'fmt ');
    v.setUint32(16, 16, true);          // PCM chunk size
    v.setUint16(20, 1, true);           // PCM format
    v.setUint16(22, 1, true);           // 1 channel (mono)
    v.setUint32(24, sampleRate, true);  // sample rate
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);           // block align
    v.setUint16(34, 16, true);          // bits per sample
    w(36, 'data'); v.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
}
```

### Step 2: Add Whisper-track fields to `GameMode` constructor

Find the `constructor()` of `GameMode`. After `this.bestStreak = 0;` (the last field), add:

```js
        // Whisper Track 2 state
        this._whisperStream = null;
        this._whisperCtx    = null;
        this._whisperNode   = null;
        this.whisperBuffer  = '';
```

### Step 3: Reset `whisperBuffer` in `setActiveLine`

Find `setActiveLine(lineIdx)`. After `this.matchedSet = new Set();` (near the top of the method), add:

```js
        this.whisperBuffer = ''; // reset per-line Whisper accumulation
```

### Step 4: Add `_startWhisperTrack` to `GameMode`

Insert this method after `_setupRecognition`:

```js
    async _startWhisperTrack() {
        try {
            this._whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this._whisperCtx    = new AudioContext({ sampleRate: 16000 });
            await this._whisperCtx.audioWorklet.addModule('/static/audio-processor.js');
            const src  = this._whisperCtx.createMediaStreamSource(this._whisperStream);
            this._whisperNode = new AudioWorkletNode(this._whisperCtx, 'chunk-processor');
            this._whisperNode.port.onmessage = (e) => {
                if (this.active) this._sendChunkToWhisper(e.data);
            };
            src.connect(this._whisperNode);
        } catch (err) {
            console.warn('[Whisper track] unavailable â€” running on Track 1 only:', err.message);
            this._whisperStream = null;
            this._whisperCtx    = null;
            this._whisperNode   = null;
        }
    }
```

### Step 5: Add `_stopWhisperTrack` to `GameMode`

Insert after `_startWhisperTrack`:

```js
    _stopWhisperTrack() {
        if (this._whisperNode) {
            this._whisperNode.disconnect();
            this._whisperNode = null;
        }
        if (this._whisperCtx) {
            this._whisperCtx.close();
            this._whisperCtx = null;
        }
        if (this._whisperStream) {
            this._whisperStream.getTracks().forEach(t => t.stop());
            this._whisperStream = null;
        }
    }
```

### Step 6: Add `_sendChunkToWhisper` to `GameMode`

Insert after `_stopWhisperTrack`:

```js
    async _sendChunkToWhisper(float32) {
        const wav = encodeWav(float32, 16000);
        try {
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: { 'Content-Type': 'audio/wav' }
            });
            if (!resp.ok) return;
            const { transcript } = await resp.json();
            if (transcript && this.active) {
                this.whisperBuffer = (this.whisperBuffer + ' ' + transcript).trim();
                this._collectMatchesWhisper(this.whisperBuffer);
            }
        } catch (_) { /* fire-and-forget: ignore network errors */ }
    }
```

### Step 7: Add `_collectMatchesWhisper` to `GameMode`

Insert after `_sendChunkToWhisper`:

```js
    _collectMatchesWhisper(transcript) {
        if (this.lineWords.length === 0) return;
        const spoken = normalizeWords(transcript);
        const whisperSet = new Set();
        let spokenIdx = 0;
        for (let li = 0; li < this.lineWords.length; li++) {
            const target = this.lineWords[li];
            const driftWindow = 15; // slightly wider than Track 1 â€” Whisper gives complete phrases
            for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    whisperSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
        whisperSet.forEach(i => this.matchedSet.add(i));
        this._updateWordSpans();
    }
```

### Step 8: Wire `_startWhisperTrack` into `GameMode.start()`

Find the `start()` method. At the very end, after `this._setupRecognition();`, add:

```js
        this._startWhisperTrack(); // async â€” Track 2 starts in background
```

### Step 9: Wire `_stopWhisperTrack` into `GameMode.stop()`

Find the `stop()` method. After `this.recognition = null;` (end of the if-block), add:

```js
        this._stopWhisperTrack();
```

### Step 10: Manual integration test

Start the Flask server. Load a rap song. Enable Game Mode. Open DevTools â†’ Network tab, filter by `/transcribe`. Rap along with the instrumental.

Verify:
- Every ~2s a `POST /transcribe` request appears with status 200
- Response body contains `{"transcript": "..."}` with recognizable words
- Words that Web Speech API would censor or miss (curse words, slang) light up green when you say them correctly
- No console errors about AudioContext or MediaDevices

### Step 11: Commit

```bash
git add static/player.js
git commit -m "feat: wire Whisper dual-track audio capture into GameMode (Track 2)"
```

---

## Task 6: Regression Check

### Step 1: Run all existing tests

```bash
python -m pytest tests/ -v
```

Expected: **all PASSED** â€” no existing tests should be broken.

### Step 2: Smoke test the full app flow

1. Start server: `python app.py`
2. Load a YouTube URL from the index page
3. Confirm the loading overlay appears and counts elapsed time
4. Confirm vocal separation completes (or click Skip)
5. Confirm lyrics display and sync correctly during playback
6. Enable Game Mode â€” confirm both Track 1 (interim) and Track 2 (Whisper) fire

### Step 3: Final commit (if any cleanup needed)

```bash
git add -p  # stage only what changed
git commit -m "chore: post-integration cleanup for lyrics detection improvements"
```

---

## Summary of All Files Changed

| File | Change |
|---|---|
| `requirements.txt` | Add `faster-whisper` |
| `app.py` | Add `get_whisper_model()`, `/transcribe` endpoint |
| `tests/test_app.py` | Add 3 `/transcribe` tests + `_make_wav` helper |
| `static/player.js` | `editDistance`, `doubleMetaphone`, `wordsMatch`, `encodeWav`, updated `normalizeWord`, expanded `CONTRACTION_MAP`, updated `_collectMatches`, Whisper track methods in `GameMode`, updated `start()`/`stop()` |
| `static/audio-processor.js` | **New** â€” `ChunkProcessor` AudioWorklet |
