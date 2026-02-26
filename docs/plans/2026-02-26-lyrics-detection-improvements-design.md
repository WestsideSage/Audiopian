# Lyrics Detection Improvements Design

**Date:** 2026-02-26
**Context:** Improve Game Mode transcription accuracy (slang, rap vocabulary, curse words), reduce matching latency for fast-paced songs, and upgrade the word-matching algorithm with phonetic and fuzzy comparison.

---

## Problem Statement

The current Game Mode uses Chrome's `webkitSpeechRecognition` (Web Speech API) exclusively. This has three compounding weaknesses:

1. **Content filtering:** Chrome censors or substitutes profanity. "fuck" becomes a phonetically-adjacent clean word or is silently dropped — common in rap.
2. **Slang blindness:** Rap-specific vocabulary, AAVE slang, and non-standard words are frequently misrecognized or skipped because they fall outside Chrome's language model.
3. **Fast-rap latency:** Chrome delays producing "final" results for dense lyrical passages, relying on interim text. The interim-anchoring fix (lineStartWordCount from transcript + latestInterim) helps, but doesn't solve fundamental ASR gaps.

---

## Architecture: Dual-Track Transcription

Two parallel transcription tracks run simultaneously while Game Mode is active:

```
Microphone
├── Track 1 (Speed)    → SpeechRecognition API → onresult → phonetic+fuzzy match ──┐
│                                                                                    ├─→ union matchedSet → word spans → scoring
└── Track 2 (Accuracy) → getUserMedia → AudioWorklet → 2s WAV chunks               │
                                                      → POST /transcribe            │
                                                      → faster-whisper large-v3-turbo │
                                                      → phonetic+fuzzy match ────────┘
```

**Key invariants:**
- Neither track blocks the other. Track 1 fires every ~300ms (interim); Track 2 returns every ~2s.
- Union semantics: a word is matched if either track matched it. Once matched, it stays matched.
- Phonetic+fuzzy matching runs on both tracks' output before merging into `matchedSet`.
- Scoring at line-end uses the final unioned `matchedSet`.
- Track 2 is lazy-started — AudioWorklet and mic stream only spin up when Game Mode activates; they stop when it deactivates.
- Track 2 bypasses Chrome's content filter. Whisper outputs uncensored text, so curse words match freely.

---

## Section 1: Backend — `/transcribe` Endpoint

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
- Beam size: `1` (greedy decoding — ~80–120ms per 2s chunk on 4070Ti)

### Endpoint Contract

- **Route:** `POST /transcribe`
- **Body:** Raw WAV bytes (16kHz, mono, 16-bit PCM, standard 44-byte RIFF header)
- **Response:** `{"transcript": "some words here"}` — always 200; empty string on silence, error, or malformed input
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

## Section 2: Frontend — Dual-Track Audio Capture

### Audio Capture Pipeline

1. `GameMode.start()` calls `navigator.mediaDevices.getUserMedia({audio: true})` — a second, independent mic acquisition alongside what `SpeechRecognition` uses internally. Chrome shares the same physical device; the user sees one permission prompt for the session.

2. An `AudioContext` is created at **16000 Hz** (`new AudioContext({sampleRate: 16000})`). Whisper natively expects 16kHz — no resampling needed.

3. A minimal `AudioWorklet` processor (`static/audio-processor.js`) accumulates Float32 samples. Every **32000 samples** (exactly 2s at 16kHz), it `postMessage`s the buffer to the main thread and starts fresh.

4. The main thread encodes the buffer as a standard WAV (44-byte RIFF header + Int16 PCM body, ~20 lines of vanilla JS), then POSTs it to `/transcribe`.

5. The response transcript is fed into `GameMode._collectMatchesWhisper()`, which runs the same phonetic+fuzzy matching logic as Track 1 and unions results into `matchedSet`.

6. `GameMode.stop()` disconnects the worklet node, closes the `AudioContext`, and calls `.stop()` on all mic stream tracks.

### New File: `static/audio-processor.js`

Required by the AudioWorklet spec — must be a separate JS module loaded via `audioContext.audioWorklet.addModule('audio-processor.js')`.

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

Chunks are fixed 2s non-overlapping windows. A word straddling a chunk boundary gets its trailing half in the next chunk — Whisper transcribes from context and typically recovers it. Track 1 interim covers the gap during the 2s window.

---

## Section 3: Phonetic + Fuzzy Matching Layer

### Double Metaphone

~180 lines of vanilla JS implementing the standard Double Metaphone algorithm, added to `player.js`. Function signature: `doubleMetaphone(word) → [primary, secondary]`. Two words are phonetically equivalent if any of their codes intersect.

No npm dependency. No build step.

### Levenshtein ≤ 1

~15-line function `editDistance(a, b)` using a two-row DP array. Only applied when phonetic fails AND `Math.abs(a.length - b.length) <= 1` (short-circuits obvious mismatches).

### Censored Lyric Normalization

`normalizeWord()` gains one additional step: **strip `*` characters** after punctuation removal. This means LRC lyrics like `"f**k"` normalize to `"fk"`. Whisper outputs `"fuck"` which normalizes to `"fuck"`. Double Metaphone maps both to `"FK"` — they match phonetically with no manual profanity table required.

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

**Performance:** DM + Levenshtein run in microseconds per word pair. 20-word line × 12-word window = 240 comparisons worst-case — imperceptible.

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

### New Unit Tests — `tests/test_lyrics.py`

Phonetic+fuzzy matching cases (tested against the JS logic via equivalent Python stubs or described as manual JS unit tests):
- Exact match: `"gonna"` → `"gonna"` ✓
- Phonetic match: `"fk"` (censored) → `"fuck"` ✓ via DM both → `"FK"`
- Fuzzy match: `"teh"` → `"the"` ✓ via edit-distance 1
- Contraction expansion: `"finna"` expands before matching
- Non-match: `"apple"` → `"orange"` ✗

### New Unit Tests — `tests/test_app.py`

- Valid WAV fixture → returns non-empty transcript (mock `get_whisper_model`)
- Empty body → returns `{"transcript": ""}` with 200
- Body < 100 bytes → returns `{"transcript": ""}` with 200
- Whisper raises exception → returns 503

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
| `static/audio-processor.js` | **New** — AudioWorklet `ChunkProcessor` |
| `tests/test_lyrics.py` | New phonetic+fuzzy unit tests |
| `tests/test_app.py` | New `/transcribe` endpoint tests |
| `requirements.txt` | Add `faster-whisper` |
