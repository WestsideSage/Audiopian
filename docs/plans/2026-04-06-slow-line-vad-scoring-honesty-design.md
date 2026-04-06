# Design: Slow-Line VAD + Scoring Honesty

**Date:** 2026-04-06
**Status:** Approved
**Driven by:** Telemetry analysis of 10 runs (55.8 MB, 31.5 min audio) in `output_telemetry/2026-04-06`

---

## Problem Statement

Two confirmed failure clusters, both grounded in code and telemetry:

1. **Slow lines score badly** — mean weighted score 0.664 vs 0.945 (medium) and 0.903 (fast). 80 of 84 lines scoring below 50% are slow. Root cause: `lt.useVad = (relClass !== 'slow')` (player.js:486) means slow lines have no VAD fallback and are entirely ASR-dependent. With 98.4% of ASR events being unstable interim transcripts, short/isolated words ("Nigga", "Hot hot hot hot", "Call me the general") produce zero matches.

2. **Green does not mean correct** — `_updateWordSpans()` shows green for any word in `matchedSet` regardless of score. Edit2 (0.4), unconfirmed VAD (0.25), and exact matches (1.0) are visually identical. "Perfect line" counter uses a boolean check (`matched === total`) not a weighted score threshold, so a line where every word is edit2 (40% credit) incorrectly counts as perfect.

---

## Approach: Targeted Surgical Fixes

Fix each confirmed failure mode directly without architectural changes.

---

## Section 1 — Slow Line VAD Provisional Credit

### Change
Remove the `'slow'` exclusion from VAD mode assignment:

```js
// Before
lt.useVad = (relClass !== 'slow');

// After
lt.useVad = true; // all tempo classes get provisional VAD
```

All lines now run the same provisional VAD path: when `isSpeaking` is true and the hot word window is open, the word receives provisional score 0.25 (stored in `vadMatchedSet`). Browser SR or Whisper confirmation upgrades it to full ASR-match score and moves it to `asrConfirmedSet`.

### Slow-line energy guard
Slow lines apply a stricter VAD threshold to reduce noise inflation on lines with long inter-word pauses:

```js
var effectiveThreshold = this._energyThreshold *
    (this.wordTimings.vadTempoClass === 'slow' ? 1.3 : 1.0);
this.isSpeaking = vadRms > effectiveThreshold;
```

This 1.3× multiplier is applied only during `updateHotWord()` for slow-classified lines.

### Why this is safe
- Provisional score 0.25 is below the green threshold (0.75), so unconfirmed VAD hits display as amber — visible but not falsely confident
- The `_scoreLine` downgrade (from previous session) already applies the 0.25 weight to unconfirmed VAD hits in the final percentage score
- ASR confirmation is still required for green display and full score credit

---

## Section 2 — Two-Color Visual System

### CSS classes

| Score | Class | Color | Meaning |
|---|---|---|---|
| ≥ 0.75 | `matched` (existing) | Green | Correct — exact, slang, contraction, phonetic, edit1 |
| 0.25–0.74 | `matched-partial` (new) | Amber | Partial — edit2 truncation, unconfirmed VAD provisional |
| 0 | *(none)* | White | Unmatched |
| Post-score miss | `missed` (existing) | Red | Scored wrong |

### `_updateWordSpans()` change
Read score from `matchedSet.get(wi)` (already a float Map) and branch on threshold:

```js
const score = this.matchedSet.get(wi);
if (score !== undefined) {
    span.classList.remove('matched', 'matched-partial', 'missed');
    if (score >= 0.75) {
        span.classList.add('matched');
    } else {
        span.classList.add('matched-partial');
    }
    // asr-confirmed layers on top as before
    if (this.asrConfirmedSet.has(wi)) span.classList.add('asr-confirmed');
} else {
    span.classList.remove('matched', 'matched-partial', 'asr-confirmed');
}
```

### "Perfect line" counter fix
Change the boolean check to a weighted score threshold:

```js
// Before
if (matched === total) {

// After
if (weightedTotal > 0 && weightedMatched >= weightedTotal * 0.9) {
```

A line only counts as perfect if ≥ 90% of its weighted credit was earned. Edit2-only lines no longer count as perfect.

### CSS addition (style.css)
```css
.word-span.matched-partial {
    color: #f5a623; /* amber */
    font-weight: 600;
}
```

---

## Section 3 — Edit2 Prefix-Only Tightening

### Current behavior
`wordsMatchScore()` accepts any edit distance 2 match (score 0.4) when both words ≥ 3 chars and length difference ≤ 3. Produces false matches like `less → lesson`.

### Rule
Edit distance 2 accepted **only when**:
1. `spoken` is a strict prefix of `target` (the target starts with the spoken word), AND
2. `spoken.length >= target.length - 1` (at most one trailing char missing — pure ASR truncation)

All other edit2 cases → `{ score: 0.0, method: 'none' }`.

### In `wordsMatchScore()` (match-helpers.js or player.js):
```js
// Edit distance 2 — prefix-truncation only
if (dist === 2) {
    var isPrefixTruncation = target.startsWith(spoken) &&
                             spoken.length >= target.length - 1;
    if (isPrefixTruncation) return { score: 0.4, method: 'edit2' };
    // else fall through to 'none'
}
```

### Impact
- Eliminates `fol → folks`, `less → lesson` class of false positives
- Legitimate single-char ASR truncations (`rhyth → rhythm`) were already edit1 (0.75) and are unaffected
- Remaining edit2 matches will be defensible ASR artifacts, displayed as amber

---

## Section 4 — VAD Telemetry Logging

### Current blind spots
- VAD provisional hits produce zero match log entries — telemetry cannot explain why words go green on medium/fast lines
- 98.5% of match records are `method: "none"` — noise dominates, signal is buried
- `_logAsr()` always called with empty `wordTimestamps` array for browser SR events

### Changes

**1. Log VAD provisional hits:**
In `updateHotWord()`, when a word is credited via VAD:
```js
this._logMatch(newHot, this.lineWords[newHot], 'vad-provisional', 0.25, true);
```

**2. Log VAD confirmation upgrades:**
In `_matchHotWord()`, when a VAD hit is ASR-confirmed:
```js
this._logMatch(this.hotWordIndex, target, 'vad-confirmed', result.score, true);
```

**3. Suppress `method: "none"` log entries:**
In `_logMatch()` (or wherever match logging is called), filter to only log when `score > 0`:
```js
if (score <= 0) return; // don't log misses
```

**4. Log Whisper word timestamps:**
When `/transcribe` returns `words` array, pass it to `_logAsr()` instead of `[]`. This allows future telemetry to distinguish Whisper contribution from browser SR.

---

## Files Affected

| File | Change |
|---|---|
| `static/player.js` | Sections 1, 2, 4 — VAD mode assignment, `_updateWordSpans`, perfect counter, telemetry logging |
| `static/sync-helpers.js` | Section 1 — slow-line energy threshold (or inline in player.js) |
| `static/style.css` | Section 2 — `.matched-partial` amber CSS rule |
| `static/match-helpers.js` | Section 3 — edit2 prefix-only guard in `wordsMatchScore` |

---

## Success Criteria

1. Slow-line mean weighted score improves from 0.664 toward medium/fast range on the same songs
2. Short line (≤3 words) failure rate drops from 40% below 50%
3. All-green lines with fractional score (like Cure For The Itch 96%) show amber on partial-credit words
4. "Perfect" lines in the end modal reflect actual ≥90% weighted accuracy
5. Telemetry `method: "none"` ratio drops below 50% (from 98.5%)
6. VAD hits appear as `vad-provisional` / `vad-confirmed` in match logs

---

## Deferred

- Whisper queue backpressure / bounded dispatch (performance, not correctness)
- AudioWorklet ring buffer (GC optimization)
- Unified confidence model / full state machine rewrite (Approach 3 — revisit after this proves out)
