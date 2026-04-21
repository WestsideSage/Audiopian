# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Design: Slow-Line VAD + Scoring Honesty

**Date:** 2026-04-06
**Status:** Approved
**Driven by:** Telemetry analysis of 10 runs (55.8 MB, 31.5 min audio) in `output_telemetry/2026-04-06`

---

## Problem Statement

Two confirmed failure clusters, both grounded in code and telemetry:

1. **Slow lines score badly** â€” mean weighted score 0.664 vs 0.945 (medium) and 0.903 (fast). 80 of 84 lines scoring below 50% are slow. Root cause: `lt.useVad = (relClass !== 'slow')` (player.js:486) means slow lines have no VAD fallback and are entirely ASR-dependent. With 98.4% of ASR events being unstable interim transcripts, short/isolated words ("Nigga", "Hot hot hot hot", "Call me the general") produce zero matches.

2. **Green does not mean correct** â€” `_updateWordSpans()` shows green for any word in `matchedSet` regardless of score. Edit2 (0.4), unconfirmed VAD (0.25), and exact matches (1.0) are visually identical. "Perfect line" counter uses a boolean check (`matched === total`) not a weighted score threshold, so a line where every word is edit2 (40% credit) incorrectly counts as perfect.

---

## Approach: Targeted Surgical Fixes

Fix each confirmed failure mode directly without architectural changes.

---

## Section 1 â€” Slow Line VAD Provisional Credit

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

This 1.3Ã— multiplier is applied only during `updateHotWord()` for slow-classified lines.

### Why this is safe
- Provisional score 0.25 is below the green threshold (0.75), so unconfirmed VAD hits display as amber â€” visible but not falsely confident
- The `_scoreLine` downgrade (from previous session) already applies the 0.25 weight to unconfirmed VAD hits in the final percentage score
- ASR confirmation is still required for green display and full score credit

---

## Section 2 â€” Two-Color Visual System

### CSS classes

| Score | Class | Color | Meaning |
|---|---|---|---|
| â‰¥ 0.75 | `matched` (existing) | Green | Correct â€” exact, slang, contraction, phonetic, edit1 |
| 0.25â€“0.74 | `matched-partial` (new) | Amber | Partial â€” edit2 truncation, unconfirmed VAD provisional |
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

A line only counts as perfect if â‰¥ 90% of its weighted credit was earned. Edit2-only lines no longer count as perfect.

### CSS addition (style.css)
```css
.word-span.matched-partial {
    color: #f5a623; /* amber */
    font-weight: 600;
}
```

---

## Section 3 â€” Edit2 Prefix-Only Tightening

### Current behavior
`wordsMatchScore()` accepts any edit distance 2 match (score 0.4) when both words â‰¥ 3 chars and length difference â‰¤ 3. Produces false matches like `less â†’ lesson`.

### Rule
Edit distance 2 accepted **only when**:
1. `spoken` is a strict prefix of `target` (the target starts with the spoken word), AND
2. `spoken.length >= target.length - 1` (at most one trailing char missing â€” pure ASR truncation)

All other edit2 cases â†’ `{ score: 0.0, method: 'none' }`.

### In `wordsMatchScore()` (match-helpers.js or player.js):
```js
// Edit distance 2 â€” prefix-truncation only
if (dist === 2) {
    var isPrefixTruncation = target.startsWith(spoken) &&
                             spoken.length >= target.length - 1;
    if (isPrefixTruncation) return { score: 0.4, method: 'edit2' };
    // else fall through to 'none'
}
```

### Impact
- Eliminates `fol â†’ folks`, `less â†’ lesson` class of false positives
- Legitimate single-char ASR truncations (`rhyth â†’ rhythm`) were already edit1 (0.75) and are unaffected
- Remaining edit2 matches will be defensible ASR artifacts, displayed as amber

---

## Section 4 â€” VAD Telemetry Logging

### Current blind spots
- VAD provisional hits produce zero match log entries â€” telemetry cannot explain why words go green on medium/fast lines
- 98.5% of match records are `method: "none"` â€” noise dominates, signal is buried
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
| `static/player.js` | Sections 1, 2, 4 â€” VAD mode assignment, `_updateWordSpans`, perfect counter, telemetry logging |
| `static/sync-helpers.js` | Section 1 â€” slow-line energy threshold (or inline in player.js) |
| `static/style.css` | Section 2 â€” `.matched-partial` amber CSS rule |
| `static/match-helpers.js` | Section 3 â€” edit2 prefix-only guard in `wordsMatchScore` |

---

## Success Criteria

1. Slow-line mean weighted score improves from 0.664 toward medium/fast range on the same songs
2. Short line (â‰¤3 words) failure rate drops from 40% below 50%
3. All-green lines with fractional score (like Cure For The Itch 96%) show amber on partial-credit words
4. "Perfect" lines in the end modal reflect actual â‰¥90% weighted accuracy
5. Telemetry `method: "none"` ratio drops below 50% (from 98.5%)
6. VAD hits appear as `vad-provisional` / `vad-confirmed` in match logs

---

## Deferred

- Whisper queue backpressure / bounded dispatch (performance, not correctness)
- AudioWorklet ring buffer (GC optimization)
- Unified confidence model / full state machine rewrite (Approach 3 â€” revisit after this proves out)

---

## Implementation

# Slow-Line VAD + Scoring Honesty Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix slow-line scoring failures (mean 0.664), make green/amber/red visuals reflect actual match quality, tighten edit2 to prefix-truncation only, and make VAD hits visible in telemetry.

**Architecture:** Six targeted changes to `player.js`, `match-helpers.js`, and `player.html`. No structural rewrite. The provisional VAD infrastructure (vadMatchedSet, asrConfirmedSet, _scoreLine downgrade) from a previous session is already in place â€” this plan extends it. Four pre-review bugs have been corrected from the original plan draft (test assertion wrong, `wordsMatch()` gap, `_matchHotWord` early-return kills ASR upgrade, `_logAsr` type semantics).

**Tech Stack:** Vanilla JS frontend (player.js, match-helpers.js, player.html), Node.js CJS for unit tests (tests/test_match_helpers.cjs)

---

## Task 1: Fix Pre-existing Test Failure + Edit2 Tightening (TDD)

**Context:** `tests/test_match_helpers.cjs` currently fails before any new code is written. `maxEditDistance(10)` asserts `3` but the function correctly returns `2` (max is intentionally capped at 2 for word matching). Fix the wrong test assertion first. Then add `isEdit2PrefixTruncation` and apply it to **both** `wordsMatch()` and `wordsMatchScore()` â€” the plan originally only targeted `wordsMatchScore()`, leaving the hot-word and overlap paths (which use `wordsMatch()`) still permissive.

**Files:**
- Modify: `tests/test_match_helpers.cjs` (fix wrong assertion, add new tests)
- Modify: `static/match-helpers.js` (add `isEdit2PrefixTruncation` + export)
- Modify: `static/player.js:188` (`wordsMatch` edit2 branch)
- Modify: `static/player.js:234` (`wordsMatchScore` edit2 branch)

---

**Step 1: Verify the pre-existing failure**

```bash
node tests/test_match_helpers.cjs
```

Expected: fails at `maxEditDistance(10)` â€” `2 !== 3`.

---

**Step 2: Fix the wrong assertion in `tests/test_match_helpers.cjs`**

Find the `maxEditDistance` test block (around line 97). The function implementation in `match-helpers.js` is:

```js
function maxEditDistance(len) {
    if (len <= 6) return 1;
    return 2;   // never returns 3 â€” the assertions for 10 and 15 are wrong
}
```

Change the two wrong assertions:

```js
// BEFORE (wrong â€” function never returns 3):
assert.strictEqual(maxEditDistance(10), 3);
assert.strictEqual(maxEditDistance(15), 3);

// AFTER (correct):
assert.strictEqual(maxEditDistance(10), 2);
assert.strictEqual(maxEditDistance(15), 2);
```

---

**Step 3: Run test suite â€” expect pass now**

```bash
node tests/test_match_helpers.cjs
```

Expected: all existing tests pass.

---

**Step 4: Append new failing tests for `isEdit2PrefixTruncation`**

Add to the end of `tests/test_match_helpers.cjs` (after all existing tests):

```js
// --- isEdit2PrefixTruncation ---
var isEdit2PrefixTruncation = fakeModule.exports.isEdit2PrefixTruncation;

// Accept: spoken is prefix of target AND exactly 1 char missing
assert.strictEqual(isEdit2PrefixTruncation('rhyth',  'rhythm'),  true,  'rhythâ†’rhythm prefix diff=1');
assert.strictEqual(isEdit2PrefixTruncation('singin', 'singing'), true,  'singinâ†’singing prefix diff=1');
assert.strictEqual(isEdit2PrefixTruncation('keepin', 'keeping'), true,  'keepinâ†’keeping prefix diff=1');

// Reject: prefix but diff > 1 (2+ chars missing)
assert.strictEqual(isEdit2PrefixTruncation('fol',   'folks'),   false, 'folâ†’folks diff=2');
assert.strictEqual(isEdit2PrefixTruncation('less',  'lesson'),  false, 'lessâ†’lesson diff=2');
assert.strictEqual(isEdit2PrefixTruncation('cat',   'catch'),   false, 'catâ†’catch diff=2');

// Reject: not a prefix
assert.strictEqual(isEdit2PrefixTruncation('hat',   'cat'),     false, 'hatâ†’cat not a prefix');
assert.strictEqual(isEdit2PrefixTruncation('work',  'words'),   false, 'workâ†’words not a prefix');

// Reject: spoken longer than target
assert.strictEqual(isEdit2PrefixTruncation('rhythm', 'rhyth'),  false, 'rhythmâ†’rhyth spoken longer');

console.log('isEdit2PrefixTruncation: 9 tests passed');
```

---

**Step 5: Run to verify new tests FAIL**

```bash
node tests/test_match_helpers.cjs
```

Expected: `TypeError: isEdit2PrefixTruncation is not a function` (or ReferenceError).

---

**Step 6: Add helper to `static/match-helpers.js`**

Find the end of `match-helpers.js` just before the `if (typeof module !== 'undefined' && module.exports)` block. Add:

```js
/**
 * Returns true only when the spoken word is a pure ASR trailing-truncation of the target:
 * target must start with spoken AND exactly 1 trailing character is missing.
 * Used to gate edit-distance-2 matches so false positives like "lessâ†’lesson" are rejected
 * while genuine truncations like "singinâ†’singing" are accepted.
 * @param {string} spoken
 * @param {string} target
 * @returns {boolean}
 */
function isEdit2PrefixTruncation(spoken, target) {
    if (spoken.length >= target.length) return false;       // spoken must be shorter
    if (target.length - spoken.length !== 1) return false; // exactly 1 char missing
    return target.startsWith(spoken);
}
```

Then add `isEdit2PrefixTruncation` to the existing export object at the bottom of the file. The export block looks like:

```js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // ... existing exports ...
        isEdit2PrefixTruncation,  // ADD THIS
    };
}
```

---

**Step 7: Run tests â€” expect 9 new tests pass**

```bash
node tests/test_match_helpers.cjs
```

Expected: all tests pass including `isEdit2PrefixTruncation: 9 tests passed`.

---

**Step 8: Apply the guard in `wordsMatchScore()` (`static/player.js` ~line 234)**

Find:
```js
if (dist === 1) return { score: 0.75, method: 'edit1' };
if (dist === 2) return { score: 0.4,  method: 'edit2' };
```

Replace the `dist === 2` line:
```js
if (dist === 1) return { score: 0.75, method: 'edit1' };
if (dist === 2 && isEdit2PrefixTruncation(spoken, target)) return { score: 0.4, method: 'edit2' };
```

---

**Step 9: Apply the guard in `wordsMatch()` (`static/player.js` ~line 186)**

`wordsMatch()` is the boolean variant used by `_matchPrevLine` (line 809) and `_matchHotWord` (line 1203). It currently accepts any edit-distance-2 match without restriction. Find:

```js
if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
    var maxDist = maxEditDistance(Math.min(spoken.length, target.length));
    if (Math.abs(spoken.length - target.length) <= maxDist && editDistance(spoken, target) <= maxDist) return true;
}
```

Replace:

```js
if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
    var maxDist = maxEditDistance(Math.min(spoken.length, target.length));
    var edDist  = (Math.abs(spoken.length - target.length) <= maxDist)
                  ? editDistance(spoken, target) : Infinity;
    if (edDist === 1) return true;
    if (edDist === 2 && isEdit2PrefixTruncation(spoken, target)) return true;
}
```

This makes the boolean path consistent with `wordsMatchScore()`.

---

**Step 10: Verify `isEdit2PrefixTruncation` is in scope**

In `player.html`, check that `match-helpers.js` is loaded via `<script>` before `player.js`. If not, move it earlier. `isEdit2PrefixTruncation` is a plain function in global scope after match-helpers.js loads.

---

**Step 11: Run full test suite**

```bash
node tests/test_match_helpers.cjs && python -m pytest tests/ -v
```

Expected: all JS tests pass + 32 Python passed, 1 skipped.

**Step 12: Commit**

```bash
git add static/match-helpers.js static/player.js tests/test_match_helpers.cjs
git commit -m "fix: tighten edit2 to prefix-truncation only across all match paths

- Fix wrong test assertion: maxEditDistance returns 2 (not 3) for long words
- Add isEdit2PrefixTruncation helper: accept edit2 only when spoken is a
  prefix of target with exactly 1 trailing char missing
- Apply guard to both wordsMatchScore() and wordsMatch() so hot-word,
  overlap, and scored paths all reject the same false positives"
```

---

## Task 2: Enable VAD for Slow Lines + Fix Three Correctness Gaps

**Context:** Three code issues must be fixed together â€” they are all part of making slow-line VAD actually work:

1. `lt.useVad = (relClass !== 'slow')` â€” slow lines have no VAD, root cause of 0.664 mean
2. VAD hits never set `lineHadAsrEvent = true` â€” `_scoreLine` line 1236 skips any line where this is false, so VAD-only slow lines are silently scored as 0 even with hits in `matchedSet`
3. `_matchHotWord()` line 1193 returns early if `matchedSet.has(hotWordIndex)` â€” once a word is provisionally VAD-matched (0.25 in matchedSet), ASR can never upgrade it to green because the function bails before doing any work

**Files:**
- Modify: `static/player.js` â€” three locations

No unit tests for browser AudioContext logic. Verify via manual smoke check and telemetry.

---

**Step 1: Change VAD mode assignment (~line 486)**

Find:
```js
lt.useVad = (relClass !== 'slow');
```

Replace:
```js
lt.useVad = true; // all tempo classes get provisional VAD; slow lines use stricter energy gate in updateHotWord
```

---

**Step 2: Add slow-line energy multiplier in `updateHotWord()` (~line 1136)**

Find the line that sets `isSpeaking`:
```js
this.isSpeaking = vadRms > this._energyThreshold;
```

Replace:
```js
var _vadMultiplier = (this.wordTimings && this.wordTimings.vadTempoClass === 'slow') ? 1.3 : 1.0;
this.isSpeaking = vadRms > (this._energyThreshold * _vadMultiplier);
```

---

**Step 3: Set `lineHadAsrEvent = true` on VAD hit**

In `updateHotWord()`, find the VAD optimistic scoring block:
```js
if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
    if (!this.matchedSet.has(newHot)) {
        this.matchedSet.set(newHot, 1.0);
        this.vadMatchedSet.set(newHot, 1.0);
        this._updateWordSpans();
    }
}
```

Replace the inner block only:
```js
if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
    if (!this.matchedSet.has(newHot)) {
        this.matchedSet.set(newHot, 0.25);       // provisional â€” shows amber; upgradeable by ASR
        this.vadMatchedSet.set(newHot, 0.25);
        this.lineHadAsrEvent = true;             // VAD activity counts as "user was trying"
        this._updateWordSpans();
    }
}
```

Note: the score is stored as `0.25` (not `1.0`) so `_updateWordSpans` will immediately show amber for the provisional hit. The existing `_scoreLine` downgrade guard (checking `vadMatchedSet && !asrConfirmedSet`) remains correct â€” an unconfirmed VAD hit stays at 0.25 in the score.

---

**Step 4: Fix `_matchHotWord()` early return so ASR can upgrade provisional VAD hits**

Find `_matchHotWord()` (~line 1191):
```js
_matchHotWord(transcript) {
    if (this.hotWordIndex < 0 || this.hotWordIndex >= this.lineWords.length) return false;
    if (this.matchedSet.has(this.hotWordIndex)) return false; // already matched
```

The second guard (`matchedSet.has`) prevents ASR from ever upgrading a VAD provisional hit â€” once 0.25 is in matchedSet, this bails immediately. Change it to only bail if already ASR-confirmed:

```js
_matchHotWord(transcript) {
    if (this.hotWordIndex < 0 || this.hotWordIndex >= this.lineWords.length) return false;
    if (this.asrConfirmedSet.has(this.hotWordIndex)) return false; // already fully confirmed by ASR
```

This allows the function to proceed and upgrade the matchedSet entry from 0.25 â†’ 1.0 when ASR produces a match. The existing line `this.matchedSet.set(this.hotWordIndex, 1.0)` already handles the upgrade.

---

**Step 5: Run test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

**Step 6: Commit**

```bash
git add static/player.js
git commit -m "fix: enable provisional VAD for slow lines â€” three correctness gaps

- Enable useVad=true for all lines; slow lines get 1.3x energy threshold
- VAD hits set lineHadAsrEvent=true so _scoreLine no longer skips lines
  where ASR produced nothing but user was audibly singing
- Store provisional VAD score as 0.25 (not 1.0) for immediate amber display
- Fix _matchHotWord early return: check asrConfirmedSet not matchedSet,
  so ASR can upgrade provisional 0.25 VAD hits to full green 1.0"
```

---

## Task 3: Two-Color Visual System (green / amber)

**Context:** All matched words show identical green. Add amber (`matched-partial`) for words with score 0.25â€“0.74. There are four places in player.js that set the `matched` class â€” all need updating. CSS lives in `player.html` (inline styles), not `style.css`.

**Files:**
- Modify: `static/player.html` (~line 123, inline `<style>`)
- Modify: `static/player.js` â€” four locations

---

**Step 1: Add amber CSS to `static/player.html`**

Find:
```css
.word-span.matched {
    color: #00e676;
}
```

Add directly after it:
```css
.word-span.matched-partial {
    color: #f5a623;
    font-weight: 600;
}
```

---

**Step 2: Update `_updateWordSpans()` â€” primary render path (~line 1102)**

Find:
```js
span.classList.remove('matched', 'missed');
if (this.matchedSet.has(wi)) {
    span.classList.add('matched');
    if (this.asrConfirmedSet.has(wi) && !span.classList.contains('asr-confirmed')) {
        span.classList.add('asr-confirmed');
    }
} else {
    span.classList.remove('asr-confirmed');
}
```

Replace:
```js
span.classList.remove('matched', 'matched-partial', 'missed');
var _wScore = this.matchedSet.get(wi);
if (_wScore !== undefined) {
    span.classList.add(_wScore >= 0.75 ? 'matched' : 'matched-partial');
    if (this.asrConfirmedSet.has(wi) && !span.classList.contains('asr-confirmed')) {
        span.classList.add('asr-confirmed');
    }
} else {
    span.classList.remove('asr-confirmed');
}
```

---

**Step 3: Update `_lateScoreLine()` span greening (~line 1344)**

Find (inside `_lateScoreLine`):
```js
if (span) { span.classList.remove('missed'); span.classList.add('matched'); }
```

Replace:
```js
if (span) {
    span.classList.remove('missed');
    span.classList.add(result.score >= 0.75 ? 'matched' : 'matched-partial');
}
```

---

**Step 4: Update the span reset in `renderLyricsGameMode()` / `stop()` (~line 1021)**

Find:
```js
s.classList.remove('matched', 'missed', 'asr-confirmed');
```

Replace:
```js
s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
```

Search for any other `.classList.remove` calls that reference `'matched'` and add `'matched-partial'` to them:
```bash
grep -n "classList.remove.*matched" static/player.js
```

---

**Step 5: Verify `_matchPrevLine` hardcoded `'matched'` is correct**

`_matchPrevLine` (~line 818) calls `prev.matchedSet.set(li, 1.0)` before `span.classList.add('matched')`. Since score is 1.0 â‰¥ 0.75, hardcoded `'matched'` is correct â€” leave it as-is.

---

**Step 6: Run test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

**Step 7: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat: two-color word feedback â€” green >=0.75, amber 0.25-0.74

Green = exact, slang, contraction, phonetic, edit1, ASR-confirmed VAD.
Amber = unconfirmed VAD provisional (0.25), edit2 prefix truncation (0.4).
Applied to all four span-update paths: _updateWordSpans, _lateScoreLine,
renderLyricsGameMode reset, and span removal guards."
```

---

## Task 4: Fix "Perfect Line" Counter

**Context:** `_scoreLine()` counts a line as "perfect" using `matched === total` (boolean count of any matchedSet entry). A line where every word is amber (edit2, 0.4 each) incorrectly counts as perfect at 40% weighted score. Fix to require â‰¥ 90% weighted credit.

**Files:**
- Modify: `static/player.js` (~line 1285)

---

**Step 1: Find and update the condition in `_scoreLine()`**

Find:
```js
if (matched === total) {
    this.perfectLines++;
    this.currentStreak++;
    if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
} else {
    this.currentStreak = 0;
}
```

Replace the condition only (`weightedMatched` and `weightedTotal` are already computed above this block):
```js
if (weightedTotal > 0 && weightedMatched >= weightedTotal * 0.9) {
    this.perfectLines++;
    this.currentStreak++;
    if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
} else {
    this.currentStreak = 0;
}
```

---

**Step 2: Run test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped.

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: perfect-line counter requires 90% weighted score

Previously counted any line as perfect if all words were in matchedSet,
regardless of match quality. A line of all amber (0.4) words no longer
counts as perfect. Consistent with what the percentage score reflects."
```

---

## Task 5: Telemetry Fixes

**Context:** Four telemetry issues:
1. VAD provisional hits produce zero match log entries
2. ASR confirmation of VAD hits can now log correctly (Task 2 fixed `_matchHotWord`)
3. `_logAsr` `type` field is overloaded â€” Whisper should be a `source` field, not a `type` value (`test_telemetry.cjs` asserts `type` is `'final'|'interim'`)
4. 98.5% of match records are `method:'none'` noise; replace per-record logging with a per-line `totalComparisons` counter in the transition log

**Files:**
- Modify: `static/player.js` â€” four locations
- Modify: `tests/test_telemetry.cjs` (add `source` field assertion)

---

**Step 1: Log VAD provisional hits in `updateHotWord()`**

In the VAD scoring block (just updated in Task 2), add a `_logMatch` call after the matchedSet update:

```js
if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
    if (!this.matchedSet.has(newHot)) {
        this.matchedSet.set(newHot, 0.25);
        this.vadMatchedSet.set(newHot, 0.25);
        this.lineHadAsrEvent = true;
        this._updateWordSpans();
        this._logMatch(                                    // ADD THIS
            this.wordTimings[newHot] ? this.wordTimings[newHot].word : '',
            this.lineWords[newHot] || '',
            'vad-provisional', -1, false, 0.25, true, newHot
        );
    }
}
```

---

**Step 2: Log VAD confirmation in `_matchHotWord()`**

Find (in `_matchHotWord`, now updated in Task 2):
```js
this.matchedSet.set(this.hotWordIndex, 1.0);
if (this.vadMatchedSet.has(this.hotWordIndex)) this.asrConfirmedSet.add(this.hotWordIndex);
return true;
```

Replace:
```js
this.matchedSet.set(this.hotWordIndex, 1.0);
if (this.vadMatchedSet.has(this.hotWordIndex)) {
    this.asrConfirmedSet.add(this.hotWordIndex);
    this._logMatch(                                        // ADD THIS
        spoken[i], target, 'vad-confirmed', -1, false, 1.0, true, this.hotWordIndex
    );
}
return true;
```

Note: `spoken` and `i` are in scope at this point in `_matchHotWord()` â€” `i` is the loop index from the `for` loop above.

---

**Step 3: Suppress `method:'none'` per-record logging; add `totalComparisons` to transition log**

Add an early return at the top of `_logMatch()` (~line 1407):
```js
_logMatch(spokenWord, targetWord, method, editDistance, phoneticMatch, score, matched, windowPosition) {
    if (score <= 0) return;   // suppress noise â€” log only successful matches
    // ... rest of existing body unchanged
```

This drops the 98.5% none-record ratio. To preserve a useful denominator, add a `totalComparisons` counter to the `GameMode` state:

In `start()` (where scoring state is initialized), add:
```js
this._lineComparisonCount = 0;   // total word comparisons attempted this line
```

In `setActiveLine()` where the new line is set up (around line 974 where `matchedSet` is reset), reset it:
```js
this._lineComparisonCount = 0;
```

In `_collectMatches()` (wherever the word-comparison loop runs), increment it each iteration:
```js
this._lineComparisonCount++;
```

In `_logTransition()`, add `totalComparisons` to the transition entry:
```js
this._telemetry.transitions.push({
    // ... existing fields ...
    totalComparisons: this._lineComparisonCount,   // ADD THIS
});
```

---

**Step 4: Add `source` field to `_logAsr()` and wire Whisper**

Change `_logAsr()` signature and body to include `source`:

```js
_logAsr(type, text, wordTimestamps, source) {   // add source param
    if (!this._telemetry) return;
    try {
        var tempoClass = 'medium';
        if (this.activeLineIdx >= 0 && this.allWordTimings[this.activeLineIdx]) {
            tempoClass = this.allWordTimings[this.activeLineIdx].vadTempoClass || 'medium';
        }
        this._telemetry.asr.push({
            ts:             parseFloat((performance.now() / 1000).toFixed(3)),
            lineIdx:        this.activeLineIdx,
            lineTempo:      tempoClass,
            type:           type,                           // still 'final' | 'interim'
            source:         source || 'browser_sr',        // ADD: 'browser_sr' | 'whisper'
            text:           text || '',
            wordTimestamps: wordTimestamps || []
        });
    } catch (e) { /* telemetry must never crash the game */ }
}
```

Update the browser SR call site (line 640) to explicitly pass source:
```js
self._logAsr(finalText ? 'final' : 'interim', finalText || interim, [], 'browser_sr');
```

In the Whisper response handler (around line 757 where `data.transcript` is used), add a `_logAsr` call:
```js
if (data.transcript && this.active) {
    this.whisperBuffer = (this.whisperBuffer + ' ' + data.transcript).trim();
    this.lineHadAsrEvent = true;
    this._collectMatchesWhisper(this.whisperBuffer);
    this._logAsr('final', data.transcript, data.words || [], 'whisper');  // ADD THIS
}
```

---

**Step 5: Update telemetry test to assert `source` field**

In `tests/test_telemetry.cjs`, find the ASR entry test (around line 90):
```js
const required = ['ts','lineIdx','lineTempo','type','text','wordTimestamps'];
required.forEach(k => assert(k in a, `asr has key "${k}"`));
assert(['final','interim'].includes(a.type), 'asr type is final or interim');
```

Update:
```js
const required = ['ts','lineIdx','lineTempo','type','source','text','wordTimestamps'];
required.forEach(k => assert(k in a, `asr has key "${k}"`));
assert(['final','interim'].includes(a.type), 'asr type is final or interim');
assert(['browser_sr','whisper'].includes(a.source), 'asr source is browser_sr or whisper');
```

Find the `makeAsr()` stub function that creates a test ASR entry and add `source: 'browser_sr'` to it.

---

**Step 6: Run all tests**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs && python -m pytest tests/ -v
```

Expected: all pass.

**Step 7: Commit**

```bash
git add static/player.js tests/test_telemetry.cjs
git commit -m "fix: telemetry â€” VAD events, source field, suppress none noise

- Log vad-provisional (0.25) and vad-confirmed (1.0) match events
- Add source:'browser_sr'|'whisper' field to ASR log entries; keep
  type:'final'|'interim' semantics unchanged (fixes schema violation)
- Suppress per-word method:none records; add totalComparisons counter
  to transition log for denominator without noise pollution
- Update telemetry schema test to assert source field"
```

---

## Task 6: Final Verification

**Step 1: Run the full test suite**

```bash
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_telemetry.cjs
python -m pytest tests/ -v
```

Expected: all JS suites pass, Python: 32 passed 1 skipped.

---

**Step 2: Manual smoke check**

Load a song with known slow lines and enter game mode. Verify:

- [ ] Slow lines show amber words when mic energy is detected (not all-white)
- [ ] Singing a word clearly on a slow line: word goes amber â†’ then green on ASR confirmation
- [ ] Mumbling or humming produces amber, not green
- [ ] Fast/medium lines behave as before
- [ ] At line end: words genuinely wrong go red, ambiguous go amber, correct go green
- [ ] "Perfect" count in end modal does not credit lines with all-amber words
- [ ] Edit2 false positives (`lessâ†’lesson` style) no longer go green or amber â€” stay white/red
- [ ] Telemetry download (D-key) contains `vad-provisional` and `vad-confirmed` entries
- [ ] Telemetry ASR entries have `source: 'browser_sr'` field
- [ ] Transition entries have `totalComparisons` field
- [ ] Telemetry has far fewer `method:'none'` entries

**Step 3: Commit any smoke-check corrections**

```bash
git add -p
git commit -m "fix: smoke-check corrections"
```

---

## Success Criteria

1. Slow-line mean weighted score improves from 0.664 toward 0.85+ on same songs
2. Short line (â‰¤ 3 words) failure rate drops from 40% below 50%
3. All-green lines with fractional score (Cure For The Itch 96%) show amber on partial-credit words
4. "Perfect" lines in end modal reflect actual â‰¥ 90% weighted accuracy
5. Telemetry `method:'none'` entries eliminated; `totalComparisons` field in transitions
6. VAD events appear as `vad-provisional`/`vad-confirmed` in match logs
7. ASR log entries have `source` field; `type` remains `'final'|'interim'`
8. All JS and Python tests pass with zero pre-existing failures
