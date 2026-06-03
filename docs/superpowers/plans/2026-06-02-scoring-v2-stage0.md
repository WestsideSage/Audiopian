# Scoring V2 — Stage 0 ("Stop the Bleeding") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three highest-severity over-credit/cheese vectors from the scoring path so the displayed score reflects words actually sung — with zero new dependencies and full unit-test coverage.

**Architecture:** Three independent, unconditional changes (no feature flag — these are bug fixes): (0.1) stop priming Whisper with the target lyric and reject non-vocal chunks server-side; (0.2) make energy-only (VAD) words earn no lyric credit; (0.3) make the overlap re-match award graded scores instead of a flat 1.0. Each is TDD'd against the existing `tests/test_scoring.cjs` golden harness and `pytest`.

**Tech Stack:** Python/Flask + faster-whisper (server), plain browser JS (no build step), Node `.cjs` golden tests, pytest.

**Spec:** `docs/superpowers/specs/2026-06-02-scoring-v2-design.md` · **Teardown:** `docs/audits/2026-06-02-voice-detection-scoring-teardown.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app.py` | `/transcribe` server path | Drop lyric prompt; add `vad_filter`/`no_speech_threshold`/`condition_on_previous_text=False` |
| `static/player.js` | client mic→whisper + overlap match | Stop sending `X-Lyric-Hint`; route overlap match through graded helper |
| `static/scoring.js` | pure scoring/match helpers | `effectiveMatchScore`→0 for VAD-only; `computeLineScore` matched-count honesty; new `findMatchInWindow` |
| `tests/test_app.py` | server tests | Replace the two hint tests with no-prompt + speech-guard assertions |
| `tests/test_scoring.cjs` | pure-helper golden tests | Update 3 VAD cases to new semantics; add `effectiveMatchScore` + `findMatchInWindow` cases |

---

## Task 1: Remove the answer-key prompt; add speech guards (0.1)

**Files:**
- Modify: `app.py` (`_transcribe_with_model`, `_transcribe_with_openai`, `transcribe` route + CUDA-fallback call)
- Modify: `static/player.js` (`_sendChunkToWhisper`, ~lines 1248-1256)
- Modify: `tests/test_app.py` (replace `test_transcribe_with_hint` and `test_transcribe_without_hint`, ~lines 159-199)

- [ ] **Step 1: Update the server tests to the new behavior (these will fail first)**

In `tests/test_app.py`, replace the whole `test_transcribe_with_hint` function (lines 159-178) with:

```python
def test_transcribe_ignores_lyric_hint(client, monkeypatch):
    """A lyric hint header must NOT be passed to the model (no answer-key prompt)."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'gonna be alright'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav',
                           headers={'X-Lyric-Hint': 'gonna be alright'})
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 200
    call_kwargs = mock_model.transcribe.call_args[1]
    assert 'initial_prompt' not in call_kwargs
    assert call_kwargs.get('vad_filter') is True
    assert call_kwargs.get('condition_on_previous_text') is False
```

And replace the whole `test_transcribe_without_hint` function (lines 181-199) with:

```python
def test_transcribe_sets_no_speech_guards(client, monkeypatch):
    """Transcription enables vad_filter / no_speech_threshold and disables cross-chunk conditioning."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'going to be all right'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(), content_type='audio/wav')
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 200
    call_kwargs = mock_model.transcribe.call_args[1]
    assert 'initial_prompt' not in call_kwargs
    assert call_kwargs.get('vad_filter') is True
    assert call_kwargs.get('no_speech_threshold') == 0.6
    assert call_kwargs.get('condition_on_previous_text') is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_app.py::test_transcribe_ignores_lyric_hint tests/test_app.py::test_transcribe_sets_no_speech_guards -v`
Expected: FAIL — current code passes `initial_prompt='gonna be alright'` and does not set `vad_filter`.

- [ ] **Step 3: Change `_transcribe_with_model` in `app.py`**

Replace (lines 79-85):

```python
def _transcribe_with_model(model, wav_bytes, hint):
    audio_buf = io.BytesIO(wav_bytes)
    kwargs = dict(language='en', beam_size=1, word_timestamps=True)
    if hint:
        kwargs['initial_prompt'] = hint

    segments, _ = model.transcribe(audio_buf, **kwargs)
```

with:

```python
def _transcribe_with_model(model, wav_bytes):
    audio_buf = io.BytesIO(wav_bytes)
    # No lyric prompt: priming the decoder with the target line makes it emit
    # that line on hum/music/silence (answer-key injection). vad_filter +
    # no_speech_threshold reject non-vocal chunks; condition_on_previous_text=False
    # stops hallucinated text carrying across chunks.
    kwargs = dict(
        language='en',
        beam_size=1,
        word_timestamps=True,
        vad_filter=True,
        no_speech_threshold=0.6,
        condition_on_previous_text=False,
    )

    segments, _ = model.transcribe(audio_buf, **kwargs)
```

- [ ] **Step 4: Change `_transcribe_with_openai` in `app.py`**

Replace its signature and prompt block (lines 102-112):

```python
def _transcribe_with_openai(wav_bytes, hint):
    if not OPENAI_API_KEY:
        raise RuntimeError('OPENAI_API_KEY is required when WHISPER_PROVIDER=openai')

    data = {
        'model': OPENAI_TRANSCRIBE_MODEL,
        'response_format': 'json',
    }
    if hint:
        data['prompt'] = hint
```

with:

```python
def _transcribe_with_openai(wav_bytes):
    if not OPENAI_API_KEY:
        raise RuntimeError('OPENAI_API_KEY is required when WHISPER_PROVIDER=openai')

    data = {
        'model': OPENAI_TRANSCRIBE_MODEL,
        'response_format': 'json',
    }
```

- [ ] **Step 5: Update the `transcribe` route call sites in `app.py`**

In the `transcribe()` route, delete the line `hint = request.headers.get('X-Lyric-Hint')` (line 375) and update the three call sites to drop the `hint` argument:
- Line 381: `text, words = _transcribe_with_openai(wav_bytes, hint)` → `text, words = _transcribe_with_openai(wav_bytes)`
- Line 383: `text, words = _transcribe_with_model(_whisper_model, wav_bytes, hint)` → `text, words = _transcribe_with_model(_whisper_model, wav_bytes)`
- Line 391 (CUDA fallback): `text, words = _transcribe_with_model(model, wav_bytes, hint)` → `text, words = _transcribe_with_model(model, wav_bytes)`

- [ ] **Step 6: Run the two new tests to verify they pass**

Run: `python -m pytest tests/test_app.py::test_transcribe_ignores_lyric_hint tests/test_app.py::test_transcribe_sets_no_speech_guards -v`
Expected: PASS (2 passed).

- [ ] **Step 7: Remove the `X-Lyric-Hint` header from the client**

In `static/player.js` `_sendChunkToWhisper` (lines 1248-1256), replace:

```javascript
            var headers = { 'Content-Type': 'audio/wav' };
            if (dispatchedLineIdx >= 0 && lyrics[dispatchedLineIdx]) {
                headers['X-Lyric-Hint'] = lyrics[dispatchedLineIdx].text;
            }
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: headers,
            });
```

with:

```javascript
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: { 'Content-Type': 'audio/wav' },
            });
```

(Leave `const dispatchedLineIdx = this.activeLineIdx;` — it is still used by `_handleWhisperTranscript`.)

- [ ] **Step 8: Syntax-check the client and run the full server suite**

Run: `node --check static/player.js`
Expected: no output (valid).
Run: `python -m pytest tests/test_app.py -v`
Expected: all pass (the two renamed tests pass; all others unaffected).

- [ ] **Step 9: Commit**

```bash
git add app.py static/player.js tests/test_app.py
git commit -m "fix(scoring): stop priming Whisper with the target lyric; add vad_filter/no_speech guards"
```

---

## Task 2: VAD-only words earn no lyric credit (0.2)

**Files:**
- Modify: `static/scoring.js` (`effectiveMatchScore` ~457-463; `computeLineScore` matched-count ~476-484)
- Modify: `tests/test_scoring.cjs` (update 3 VAD line-score cases ~117-155; add direct `effectiveMatchScore` cases)

- [ ] **Step 1: Update the failing golden cases in `tests/test_scoring.cjs`**

Replace the case object labelled `'vad only keeps partial flow credit'` (lines 116-120) with:

```javascript
    {
        label: 'vad only earns no lyric credit',
        args: [['hey'], [{ weight: 1.0 }], new Map([[0, 1.0]]), new Map([[0, 1.0]]), new Set()],
        expected: { totalWords: 1, matchedWords: 0, weightedTotal: 1.0, weightedMatched: 0.0, missedWordIndices: [0], missedWords: ['hey'], perfect: false }
    },
```

Replace the case object labelled `'mixed weights with adlib'` (lines 126-130) with:

```javascript
    {
        label: 'mixed weights with unconfirmed vad adlib',
        args: [['my', 'boy', 'yeah'], [{ weight: 1.0 }, { weight: 1.0 }, { weight: 0.25 }], new Map([[0, 1.0], [1, 0.8], [2, 1.0]]), new Map([[2, 1.0]]), new Set([0, 1])],
        expected: { totalWords: 3, matchedWords: 2, weightedTotal: 2.25, weightedMatched: 1.8, missedWordIndices: [2], missedWords: ['yeah'], perfect: false }
    },
```

Replace the case object labelled `'confirmed and unconfirmed vad mix'` (lines 151-155) with:

```javascript
    {
        label: 'confirmed and unconfirmed vad mix',
        args: [['one', 'two'], [{ weight: 1.0 }, { weight: 1.0 }], new Map([[0, 1.0], [1, 1.0]]), new Map([[0, 1.0], [1, 1.0]]), new Set([1])],
        expected: { totalWords: 2, matchedWords: 1, weightedTotal: 2.0, weightedMatched: 1.0, missedWordIndices: [0], missedWords: ['one'], perfect: false }
    },
```

Add these direct assertions immediately after the `matchCases.forEach(...)` block (after line 79):

```javascript
// effectiveMatchScore: VAD-only words earn no lyric credit; ASR-confirmed earns full
assert.strictEqual(scoring.effectiveMatchScore(1.0, 0, new Map([[0, 1.0]]), new Set()), 0, 'vad-only word scores 0');
assert.strictEqual(scoring.effectiveMatchScore(1.0, 0, new Map([[0, 1.0]]), new Set([0])), 1.0, 'asr-confirmed vad word scores full');
assert.strictEqual(scoring.effectiveMatchScore(0.8, 0, new Map(), new Set()), 0.8, 'non-vad word scores its raw value');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_scoring.cjs`
Expected: FAIL — e.g. `vad-only word scores 0` (current code returns `Math.min(1.0, 0.25)` = 0.25) and the updated line-score cases mismatch.

- [ ] **Step 3: Change `effectiveMatchScore` in `static/scoring.js`**

Replace (lines 457-463):

```javascript
    function effectiveMatchScore(rawScore, idx, vadMatchedSet, asrConfirmedSet) {
        if (rawScore > 0 && vadMatchedSet && vadMatchedSet.has && vadMatchedSet.has(idx) &&
            !(asrConfirmedSet && asrConfirmedSet.has && asrConfirmedSet.has(idx))) {
            return Math.min(rawScore, 0.25);
        }
        return rawScore;
    }
```

with:

```javascript
    function effectiveMatchScore(rawScore, idx, vadMatchedSet, asrConfirmedSet) {
        // VAD energy proves sound was made, not that the right word was sung.
        // A word matched only by VAD (not yet ASR-confirmed) earns NO lyric credit;
        // its "engagement" value is accounted separately by the phrase-engine flow score.
        if (rawScore > 0 && vadMatchedSet && vadMatchedSet.has && vadMatchedSet.has(idx) &&
            !(asrConfirmedSet && asrConfirmedSet.has && asrConfirmedSet.has(idx))) {
            return 0;
        }
        return rawScore;
    }
```

- [ ] **Step 4: Make `computeLineScore`'s matched count honest in `static/scoring.js`**

Replace (lines 476-484):

```javascript
            var rawScore = rawMatchScore(matchedSet, i);
            if (rawScore > 0) matchedWords++;

            var effectiveScore = effectiveMatchScore(rawScore, i, vadMatchedSet, asrConfirmedSet);
            if (effectiveScore > 0) weightedMatched += weight * effectiveScore;
            else {
                missedWordIndices.push(i);
                missedWords.push(lineWords[i]);
            }
```

with:

```javascript
            var rawScore = rawMatchScore(matchedSet, i);
            var effectiveScore = effectiveMatchScore(rawScore, i, vadMatchedSet, asrConfirmedSet);
            if (effectiveScore > 0) {
                matchedWords++;
                weightedMatched += weight * effectiveScore;
            } else {
                missedWordIndices.push(i);
                missedWords.push(lineWords[i]);
            }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/test_scoring.cjs`
Expected: `All scoring tests passed.`

- [ ] **Step 6: Commit**

```bash
git add static/scoring.js tests/test_scoring.cjs
git commit -m "fix(scoring): VAD-only words earn no lyric credit (energy != right word)"
```

---

## Task 3: Overlap re-match awards graded scores (0.3)

**Files:**
- Modify: `static/scoring.js` (add pure `findMatchInWindow` + export)
- Modify: `tests/test_scoring.cjs` (add `findMatchInWindow` cases)
- Modify: `static/player.js` (`_matchPrevLine` inner loop ~1331-1354; helper import ~402)

- [ ] **Step 1: Add `findMatchInWindow` golden tests to `tests/test_scoring.cjs`**

Add immediately before the final `console.log('All scoring tests passed.');` line:

```javascript
// findMatchInWindow: returns the first graded match within a bounded window, else null
var fm1 = scoring.findMatchInWindow(['the', 'sky', 'is', 'blue'], 0, 4, 'sky', scoring.doubleMetaphone('sky'));
assert.deepStrictEqual([fm1.spokenIdx, fm1.score], [1, 1.0], 'findMatchInWindow exact match');
var fm2 = scoring.findMatchInWindow(['knight'], 0, 4, 'night', scoring.doubleMetaphone('night'));
assert.strictEqual(fm2.score, 0.8, 'findMatchInWindow phonetic scores 0.8, not flat 1.0');
assert.strictEqual(scoring.findMatchInWindow(['cat', 'dog'], 0, 2, 'sky', scoring.doubleMetaphone('sky')), null, 'findMatchInWindow no match returns null');
assert.strictEqual(scoring.findMatchInWindow(['a', 'b', 'sky'], 0, 2, 'sky', scoring.doubleMetaphone('sky')), null, 'findMatchInWindow respects window bound');
var fm3 = scoring.findMatchInWindow(['sky', 'sky'], 0, 2, 'sky', scoring.doubleMetaphone('sky'));
assert.strictEqual(fm3.spokenIdx, 0, 'findMatchInWindow returns the first match');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_scoring.cjs`
Expected: FAIL — `scoring.findMatchInWindow is not a function`.

- [ ] **Step 3: Add `findMatchInWindow` to `static/scoring.js`**

Insert this function immediately after `collectSequentialWordMatches` (after line 517, before `mergeConfirmedMatches`):

```javascript
    function findMatchInWindow(spokenWords, startIdx, windowSize, target, targetPhonetic) {
        var end = Math.min(startIdx + windowSize, spokenWords.length);
        for (var si = startIdx; si < end; si++) {
            var r = wordsMatchScore(spokenWords[si], target, targetPhonetic);
            if (r.score > 0) return { spokenIdx: si, score: r.score, method: r.method };
        }
        return null;
    }
```

Add it to the exported object (after the `collectSequentialWordMatches: collectSequentialWordMatches,` line ~546):

```javascript
        findMatchInWindow: findMatchInWindow,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_scoring.cjs`
Expected: `All scoring tests passed.`

- [ ] **Step 5: Import the helper into `static/player.js`**

After the line `var mergeConfirmedMatches = scoringHelpers.mergeConfirmedMatches;` (line 402), add:

```javascript
var findMatchInWindow = scoringHelpers.findMatchInWindow;
```

- [ ] **Step 6: Rewrite the `_matchPrevLine` inner match in `static/player.js`**

Replace the per-target loop (lines 1331-1354):

```javascript
        for (var li = 0; li < prev.lineWords.length; li++) {
            if (prev.matchedSet.has(li)) { cursor++; continue; }
            var target = prev.lineWords[li];
            var targetPhonetic = prev.wordTimings && prev.wordTimings[li] ? prev.wordTimings[li].phonetic : undefined;
            for (var si = cursor; si < Math.min(cursor + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target, targetPhonetic)) {
                    prev.matchedSet.set(li, 1.0);
                    if (prev.wordSourceMap) prev.wordSourceMap.set(li, track === 'track2' ? 'whisper' : 'browser_sr');
                    if (prev.vadMatchedSet && prev.vadMatchedSet.has(li) && prev.asrConfirmedSet && !prev.asrConfirmedSet.has(li)) {
                        prev.asrConfirmedSet.add(li);
                    }
                    cursor = si + 1;
                    anyMatched = true;
                    // Light the span green on the previous line
                    var allLines = lyricsScroll.querySelectorAll('.lyric-line');
                    var lineEl = allLines[prev.lineIdx];
                    if (lineEl) {
                        var span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) { span.classList.remove('missed'); span.classList.add('matched'); }
                    }
                    break;
                }
            }
        }
```

with:

```javascript
        for (var li = 0; li < prev.lineWords.length; li++) {
            if (prev.matchedSet.has(li)) { cursor++; continue; }
            var target = prev.lineWords[li];
            var targetPhonetic = prev.wordTimings && prev.wordTimings[li] ? prev.wordTimings[li].phonetic : undefined;
            var m = findMatchInWindow(spoken, cursor, driftWindow, target, targetPhonetic);
            if (m) {
                prev.matchedSet.set(li, m.score);
                if (prev.wordSourceMap) prev.wordSourceMap.set(li, track === 'track2' ? 'whisper' : 'browser_sr');
                if (prev.vadMatchedSet && prev.vadMatchedSet.has(li) && prev.asrConfirmedSet && !prev.asrConfirmedSet.has(li)) {
                    prev.asrConfirmedSet.add(li);
                }
                cursor = m.spokenIdx + 1;
                anyMatched = true;
                // Light the span on the previous line — green for strong, amber for weak
                var allLines = lyricsScroll.querySelectorAll('.lyric-line');
                var lineEl = allLines[prev.lineIdx];
                if (lineEl) {
                    var span = lineEl.querySelectorAll('.word-span')[li];
                    if (span) { span.classList.remove('missed'); span.classList.add(m.score >= 0.75 ? 'matched' : 'matched-partial'); }
                }
            }
        }
```

- [ ] **Step 7: Syntax-check the client**

Run: `node --check static/player.js`
Expected: no output (valid).

- [ ] **Step 8: Commit**

```bash
git add static/scoring.js static/player.js tests/test_scoring.cjs
git commit -m "fix(scoring): overlap re-match awards graded scores, not a flat 1.0"
```

---

## Task 4: Full-suite verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run every JS golden test**

Run:
```bash
node tests/test_scoring.cjs
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_phrase_engine.cjs
node tests/test_telemetry_replay.cjs
node tests/test_realtime_whisper_helpers.cjs
```
Expected: each prints its "tests passed" line; no assertion errors.

- [ ] **Step 2: Run the Python suite**

Run: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -v`
Expected: all pass.

- [ ] **Step 3: Syntax-check edited JS**

Run: `node --check static/player.js && node --check static/scoring.js`
Expected: no output.

- [ ] **Step 4: Confirm clean tree**

Run: `git status`
Expected: nothing to commit (all changes committed in Tasks 1-3).

---

## Self-Review

**Spec coverage (Stage 0):**
- 0.1 prompt removal + speech guards → Task 1 ✓
- 0.2 VAD-only → 0 lyric credit (+ honest matched count) → Task 2 ✓
- 0.3 graded overlap match → Task 3 ✓
- "amber UI span retained": the VAD provisional still writes `vadMatchedSet`/`matchedSet` and `_updateWordSpans` still paints amber live; only the *scored* contribution is 0 — ✓ (no change to `updateHotWord`/`_updateWordSpans`).
- "flash counts confirmed only": `computeLineScore.matchedWords` now counts `effectiveScore>0`, and `_scoreLine` flash reads that value — ✓.

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type/name consistency:** `findMatchInWindow(spokenWords, startIdx, windowSize, target, targetPhonetic) → {spokenIdx, score, method}|null` is used identically in the test (Step 3.1), the implementation (Step 3.3), the export (Step 3.3), the player import (Step 3.5), and the call site (Step 3.6). `effectiveMatchScore`/`computeLineScore` signatures are unchanged.

**Out of scope (deferred to later stages):** the `karaokee_v2` flag, the bounded aligner, adaptive VAD, and the phrase-engine live promotion are NOT in this plan.
