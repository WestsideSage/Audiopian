# Karaokee Algorithm Improvements Design

**Date:** 2026-03-17
**Goal:** Incremental improvements across lyric detection accuracy, real-time speech analysis, and matching performance — without regressing the current responsiveness feel.

**Core problems:**
- Contractions/slang in lyrics (e.g., "gonna") frequently missed because ASR normalizes to full form ("going to") and matching only works one direction
- Latency across all line positions at high tempo — first words, mid-line, line boundaries
- Missed matches on longer words where a single character difference exceeds the hard edit-distance cap of 1

## 1. Bidirectional Contraction Matching

### Problem
`CONTRACTION_MAP` maps contractions to full forms (gonna → going to) but:
- `expandContractions()` is defined but **never called** in the matching pipeline
- No reverse lookup exists — if lyrics say "gonna" and ASR returns "going to", no match
- Multi-word expansions (2 spoken words vs 1 lyric word) aren't handled

### Solution
A three-layer contraction matching system:

**Reverse contraction map** — auto-generated at load time. For every `{gonna: "going to"}`, create `{"going to": "gonna"}`. O(1) lookup in both directions.

**Multi-word target collapsing** — when building `lineWords`, scan for adjacent words that form a known expansion (e.g., lyrics "going" + "to" → could match "gonna"). Store as phrase groups alongside individual words.

**ASR expansion matching** — when ASR returns "going to" but the lyric word is "gonna", check if the spoken multi-word sequence maps to the target contraction via the reverse map. Consume multiple spoken words for one lyric word match.

**Integration point:** inject contraction awareness into `wordsMatch()` and `_collectMatches()` rather than pre-expanding, keeping the hot path efficient.

## 2. N-gram Phrase Matching

### Problem
Word-by-word sequential matching fails when:
- ASR regroups word boundaries ("alright" vs "all right")
- Phrases get misheard as similar-sounding phrases ("let it go" → "letter go")
- Filler words inserted by ASR ("I am gonna") consume drift window slots

### Solution

**Equivalent phrase map** — static lookup of word-boundary variants:
- `"alright" ↔ "all right"`, `"everyday" ↔ "every day"`, `"cannot" ↔ "can not"`, `"into" ↔ "in to"`, `"onto" ↔ "on to"`, etc.
- Distinct from contractions — these are word-boundary ambiguities, not slang.

**Sliding 2-3 word phrase check** — during `_collectMatches()`, when a single word doesn't match, try concatenating the next 2-3 spoken words and comparing against the target (and vice versa). Example:
- Spoken `["all", "right"]` → concat `"allright"` → matches target `"alright"`
- Spoken `["letter"]` → phonetic match against target phrase `"let her"`

**Filler word skipping** — small set of filler words ASR commonly inserts (`"uh"`, `"um"`, `"like"`, `"you know"`) that can be skipped without consuming drift window slots.

**Scoring:** phrase matches still count individual lyric words as matched. Spoken "alright" matching lyrics "all" + "right" lights both green.

## 3. Whisper Prompt Hinting & Word-Level Timestamps

### Problem
- Whisper transcribes without context — normalizes casual speech and picks generic homophones
- Word timing uses syllable-count interpolation, which misestimates and cascades into wrong time windows

### Solution

**Prompt hinting** — pass the current lyric line text as Whisper's `initial_prompt`:
```python
model.transcribe(audio_buf, language='en', beam_size=1,
                 initial_prompt=hint_text)
```
- Client sends current line text alongside WAV chunk
- Whisper biases toward expected vocabulary (returns "gonna" when lyrics say "gonna")
- Single highest-impact change for contraction/slang accuracy

**Word-level timestamps** — enable `word_timestamps=True` in faster-whisper:
```python
segments, _ = model.transcribe(audio_buf, language='en', beam_size=1,
                               word_timestamps=True)
```
- Returns per-word start/end times within each chunk
- Client uses these to validate/correct interpolated timing estimates
- Not a replacement for syllable interpolation (needed before audio plays), but a real-time correction layer
- Enables future "timing accuracy" scoring dimension

**API changes:**
- Request: adds `hint` field alongside WAV body
- Response: `{transcript, words: [{text, start, end}, ...]}`

## 4. Sliding Window ASR Buffer & Adaptive Edit Distance

### Problem
- Full transcript scan from `lineStartTranscriptPos` grows rapidly on fast songs — stale words accidentally fuzzy-match future lyrics
- Edit distance hard-capped at 1 regardless of word length — "everybody" misheard as "every body" (2 edits) fails, while "a" → "I" (1 edit) passes

### Solution

**Rolling spoken window** — scan only the most recent N spoken words (scaled by tempo):
- Slow: last 20 words
- Normal: last 15 words
- Fast: last 12 words
- Existing drift windows (`driftTrack1`/`driftTrack2`) operate within this tighter buffer

**Syllable-scaled edit distance:**
- Words 1-3 chars: edit distance ≤ 1
- Words 4-6 chars: edit distance ≤ 1
- Words 7-9 chars: edit distance ≤ 2
- Words 10+ chars: edit distance ≤ 3
- Catches longer misheard words without loosening short-word matching

**Minimum word length gate** — skip edit distance matching entirely for words ≤ 2 characters. Short words ("I", "a", "to") generate too many false positives via fuzzy match. Require exact or phonetic match only.

## 5. Pre-computed Phonetic Index

### Problem
Every `wordsMatch()` call computes Double Metaphone on both spoken and target words. Target words never change but are recomputed hundreds of times per second during fast sections.

### Solution

**Phonetic index at song load** — when `interpolateWordTimings()` runs, cache Double Metaphone codes for every lyric word:
```
phoneticIndex[lineIdx][wordIdx] = { primary: "KN", secondary: "N" }
```
One-time O(total words) cost at song load, stored alongside `allWordTimings`.

**Modified `wordsMatch()`** — accepts pre-computed target codes instead of calling `doubleMetaphone(target)` every time. Halves phonetic computation on the hot path.

**Spoken word LRU cache** — small Map (cap ~50 entries) caching `spokenWord → [primary, secondary]`. ASR repeats recent words in interim results, so this eliminates redundant computation. Evict oldest entries when full.

Pure performance optimization — no behavior change.

## 6. Smoother Adaptive Whisper Chunking

### Problem
Chunk size changes abruptly at line boundaries (2s → 0.75s → 2s). First chunk of a fast section contains stale slow-section audio. Transition back to slow creates a transcription gap.

### Solution

**Flush-on-transition** — when chunk size changes, immediately flush accumulated AudioWorklet buffer as a partial chunk:
- New message: `{type: 'flush'}` to AudioWorklet
- Emits current buffer if > 1600 samples (100ms minimum)
- Resets accumulator for fresh start at new chunk size

**Overlapping chunks for fast sections** — 50% overlap during `fast` tempo:
- Instead of [0-0.75s], [0.75-1.5s]: use [0-0.75s], [0.375-1.125s], [0.75-1.5s]
- AudioWorklet maintains secondary ring buffer offset by half chunk size
- New transcription arrives every ~0.375s instead of ~0.75s
- Only active for `fast` tempo class to avoid unnecessary GPU load

**Backend rate limiting** — in-flight counter prevents request queuing:
- If 2+ requests already in-flight, skip the overlapping chunk
- Non-overlapping chunks always go through

## Summary

| # | Change | Primary Benefit | Risk |
|---|--------|----------------|------|
| 1 | Bidirectional contraction matching | Fix gonna/going-to mismatches | Low — additive logic |
| 2 | N-gram phrase matching + filler skip | Handle word boundary ambiguities | Low — fallback layer |
| 3 | Whisper prompt hinting + word timestamps | Better ASR accuracy & real timing | Low — single param changes |
| 4 | Sliding window + adaptive edit distance | Fewer false matches, catch long-word typos | Medium — changes matching behavior |
| 5 | Pre-computed phonetic index | Less CPU during fast sections | Low — pure optimization |
| 6 | Smoother adaptive Whisper chunking | Faster transcription on tempo transitions | Medium — AudioWorklet changes |
