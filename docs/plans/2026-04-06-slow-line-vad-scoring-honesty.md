# Slow-Line VAD + Scoring Honesty Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix slow-line scoring failures (mean 0.664), make green/amber/red visuals reflect actual match quality, tighten edit2 to prefix-truncation only, and make VAD hits visible in telemetry.

**Architecture:** Four independent, targeted changes to `player.js`, `match-helpers.js`, and `player.html`. No structural rewrite. Each task is independently testable and committable. The provisional VAD infrastructure (vadMatchedSet, asrConfirmedSet, _scoreLine downgrade) from the previous session is already in place — we're extending it, not replacing it.

**Tech Stack:** Vanilla JS frontend (player.js, match-helpers.js, player.html), Node.js CJS for unit tests (tests/test_match_helpers.cjs)

---

## Task 1: Edit2 Prefix-Truncation Helper + Test (TDD)

**Context:** `wordsMatchScore()` in `static/player.js:234` currently accepts any edit-distance-2 match. We need to restrict it to cases where the spoken word is a prefix of the target AND at most 1 char is missing (pure ASR truncation). We extract this as a helper in `match-helpers.js` so it can be unit tested in Node.js.

**Files:**
- Modify: `static/match-helpers.js` (add helper + export)
- Modify: `tests/test_match_helpers.cjs` (add tests)
- Modify: `static/player.js:234` (use helper)

---

**Step 1: Write the failing tests in `tests/test_match_helpers.cjs`**

Append to the end of the file (before any `console.log('All ... passed')` line):

```js
// --- isEdit2PrefixTruncation tests ---
var isEdit2PrefixTruncation = fakeModule.exports.isEdit2PrefixTruncation;

// Should accept: spoken is prefix, only 1 char missing
assert.strictEqual(isEdit2PrefixTruncation('rhyth', 'rhythm'), true,  'rhyth→rhythm: prefix, diff=1');
assert.strictEqual(isEdit2PrefixTruncation('singin', 'singing'), true, 'singin→singing: prefix, diff=1');

// Should reject: diff > 1 (2+ chars missing)
assert.strictEqual(isEdit2PrefixTruncation('fol',  'folks'),  false, 'fol→folks: prefix but diff=2');
assert.strictEqual(isEdit2PrefixTruncation('less', 'lesson'), false, 'less→lesson: prefix but diff=2');

// Should reject: not a prefix at all
assert.strictEqual(isEdit2PrefixTruncation('cat',  'catch'),  false, 'cat→catch: NOT a prefix (c-a-t vs c-a-t-c-h, diff=2 but target.startsWith(spoken) is true... wait)');
```

Wait — `catch`.startsWith(`cat`) is true, and diff is 2 (`cat`=3, `catch`=5). So `cat→catch` should be rejected by the diff=2 > 1 rule. Let fix the test comment:

```js
// --- isEdit2PrefixTruncation tests ---
var isEdit2PrefixTruncation = fakeModule.exports.isEdit2PrefixTruncation;

// Accept: prefix AND diff === 1
assert.strictEqual(isEdit2PrefixTruncation('rhyth',  'rhythm'),  true,  'rhyth→rhythm prefix diff=1');
assert.strictEqual(isEdit2PrefixTruncation('singin', 'singing'), true,  'singin→singing prefix diff=1');
assert.strictEqual(isEdit2PrefixTruncation('keepin', 'keeping'), true,  'keepin→keeping prefix diff=1');

// Reject: prefix but diff > 1
assert.strictEqual(isEdit2PrefixTruncation('fol',   'folks'),   false, 'fol→folks prefix diff=2');
assert.strictEqual(isEdit2PrefixTruncation('less',  'lesson'),  false, 'less→lesson prefix diff=2');
assert.strictEqual(isEdit2PrefixTruncation('cat',   'catch'),   false, 'cat→catch prefix diff=2');

// Reject: not a prefix
assert.strictEqual(isEdit2PrefixTruncation('hat',   'cat'),     false, 'hat→cat not a prefix');
assert.strictEqual(isEdit2PrefixTruncation('work',  'words'),   false, 'work→words not a prefix');

// Reject: spoken longer than target (no truncation)
assert.strictEqual(isEdit2PrefixTruncation('rhythm', 'rhyth'),  false, 'rhythm→rhyth spoken longer');

console.log('isEdit2PrefixTruncation: 9 tests passed');
```

**Step 2: Run to verify tests FAIL**

```bash
node tests/test_match_helpers.cjs
```

Expected: `ReferenceError: isEdit2PrefixTruncation is not a function` or `TypeError`

---

**Step 3: Add the helper to `static/match-helpers.js`**

Find the end of the file just before the `if (typeof module !== 'undefined' && module.exports)` block and add:

```js
/**
 * Returns true if spoken is a pure prefix-truncation of target:
 * the target starts with the spoken word AND only 1 trailing char is missing.
 * Used to gate edit-distance-2 matches to genuine ASR truncation artifacts.
 * @param {string} spoken - normalized spoken word
 * @param {string} target - normalized target lyric word
 * @returns {boolean}
 */
function isEdit2PrefixTruncation(spoken, target) {
    if (spoken.length >= target.length) return false;          // spoken not shorter
    if (target.length - spoken.length !== 1) return false;    // must be exactly 1 char missing
    return target.startsWith(spoken);
}
```

Then add it to the exports object at the bottom:

```js
// Find:
module.exports = { classifyTempo ... };
// Add isEdit2PrefixTruncation to the export object
```

The existing export block is in `sync-helpers.js`, not `match-helpers.js`. In `match-helpers.js` find the export block (the `if (typeof module !== 'undefined' && module.exports)` section) and add `isEdit2PrefixTruncation` to it. If there is no export block, add:

```js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CONTRACTION_MAP, REVERSE_CONTRACTION_MAP,
        contractionsMatch, multiWordContractionMatch,
        PHRASE_EQUIV_MAP, phraseMatch,
        FILLER_WORDS, WORD_WEIGHTS,
        slangMatch, classifyWord,
        maxEditDistance, skipFuzzyMatch,
        MetaphoneLRU,
        isEdit2PrefixTruncation,
    };
}
```

Check the actual export block in match-helpers.js first — add `isEdit2PrefixTruncation` to whatever is already there.

**Step 4: Run tests — expect pass**

```bash
node tests/test_match_helpers.cjs
```

Expected: `isEdit2PrefixTruncation: 9 tests passed` (plus all prior tests passing)

---

**Step 5: Use the helper in `static/player.js:234`**

Find the edit-distance block in `wordsMatchScore()` (around line 231–235):

```js
// BEFORE:
if (dist === 1) return { score: 0.75, method: 'edit1' };
if (dist === 2) return { score: 0.4,  method: 'edit2' };
```

Replace the `dist === 2` line only:

```js
if (dist === 1) return { score: 0.75, method: 'edit1' };
if (dist === 2 && isEdit2PrefixTruncation(spoken, target)) return { score: 0.4, method: 'edit2' };
```

`isEdit2PrefixTruncation` is already in scope because `match-helpers.js` is loaded before `player.js` in `player.html`. Verify the `<script>` load order in player.html — `match-helpers.js` must come first.

**Step 6: Run full test suite**

```bash
node tests/test_match_helpers.cjs && python -m pytest tests/ -v
```

Expected: all pass, 1 skipped

**Step 7: Commit**

```bash
git add static/match-helpers.js static/player.js tests/test_match_helpers.cjs
git commit -m "fix: tighten edit2 matching to prefix-truncation only

Restricts edit-distance-2 matches to cases where the spoken word
is a strict prefix of the target with exactly 1 trailing char missing.
Eliminates false positives like less->lesson while preserving genuine
ASR truncation artifacts like singin->singing."
```

---

## Task 2: Enable Provisional VAD for Slow Lines

**Context:** `static/player.js:486` sets `lt.useVad = (relClass !== 'slow')`, which disables all VAD credit for slow lines. This is the root cause of the 0.664 mean slow-line score. We remove the exclusion and add a 1.3× energy multiplier for slow lines to compensate for the greater noise risk on lines with long inter-word pauses.

**Files:**
- Modify: `static/player.js:486` (useVad assignment)
- Modify: `static/player.js` in `updateHotWord()` (energy threshold guard)

No unit tests possible (browser AudioContext dependency). Verify via telemetry after implementation.

---

**Step 1: Change VAD mode assignment at player.js:486**

Find:
```js
lt.useVad = (relClass !== 'slow');
```

Replace with:
```js
lt.useVad = true; // all tempo classes get provisional VAD; slow lines use stricter energy gate below
```

---

**Step 2: Add slow-line energy multiplier in `updateHotWord()`**

Find `updateHotWord()` (around line 1133). Find the line that reads:
```js
this.isSpeaking = vadRms > this._energyThreshold;
```

Replace it with:

```js
var _slowMultiplier = (this.wordTimings && this.wordTimings.vadTempoClass === 'slow') ? 1.3 : 1.0;
this.isSpeaking = vadRms > (this._energyThreshold * _slowMultiplier);
```

This means slow lines require 30% more mic energy before a word is credited, reducing noise-triggered false positives on quiet sections.

---

**Step 3: Run test suite (sanity check — no JS tests for this, but Python must still pass)**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "fix: enable provisional VAD for slow lines with stricter energy gate

Slow lines previously had useVad=false, leaving them entirely dependent
on ASR interim transcripts. 80/84 sub-50% lines in telemetry were slow.
Now all lines get provisional VAD credit (0.25, shown as amber after
next task). Slow lines apply a 1.3x energy multiplier to compensate for
noise risk on lines with long inter-word pauses."
```

---

## Task 3: Two-Color Visual System (green / amber)

**Context:** All matched words currently show identical green. We add amber (`matched-partial`) for words with score 0.25–0.74, so edit2 truncations and unconfirmed VAD hits are visually distinguished from fully correct matches.

There are **four** places in player.js that set the `matched` class on word spans. All four need updating.

**Files:**
- Modify: `static/player.html` (add `.word-span.matched-partial` CSS, around line 123–139)
- Modify: `static/player.js` — four locations

---

**Step 1: Add amber CSS to `static/player.html`**

Find the `.word-span.matched` block (around line 123):

```css
.word-span.matched {
    color: #00e676;
}
```

Add the new rule directly after it:

```css
.word-span.matched-partial {
    color: #f5a623;
    font-weight: 600;
}
```

---

**Step 2: Update `_updateWordSpans()` — the primary render path (player.js ~line 1100)**

Find the block:
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

Replace with:

```js
span.classList.remove('matched', 'matched-partial', 'missed');
var _score = this.matchedSet.get(wi);
if (_score !== undefined) {
    if (_score >= 0.75) {
        span.classList.add('matched');
    } else {
        span.classList.add('matched-partial');
    }
    if (this.asrConfirmedSet.has(wi) && !span.classList.contains('asr-confirmed')) {
        span.classList.add('asr-confirmed');
    }
} else {
    span.classList.remove('asr-confirmed');
}
```

---

**Step 3: Update `_lateScoreLine()` — late-arriving word spans (player.js ~line 1344)**

Find the block inside `_lateScoreLine` that lights spans green:
```js
if (span) { span.classList.remove('missed'); span.classList.add('matched'); }
```

Replace with:

```js
if (span) {
    span.classList.remove('missed');
    span.classList.add(result.score >= 0.75 ? 'matched' : 'matched-partial');
}
```

---

**Step 4: Update the reset path in `stop()` / `renderLyricsGameMode()` (player.js ~line 1021)**

Find the span reset loop (likely has `.remove('matched', 'missed', 'asr-confirmed')`):
```js
s.classList.remove('matched', 'missed', 'asr-confirmed');
```

Add `matched-partial` to the remove list:
```js
s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
```

Search for all other `.classList.remove` calls referencing `'matched'` in player.js to ensure none are missed:
```bash
grep -n "classList.remove.*matched\|classList.add.*matched" static/player.js
```
For any remaining hardcoded `.add('matched')` that come from ASR-confirmed paths (like `_matchPrevLine` at line 818 which sets score 1.0 before adding the class), leave as `'matched'` — those are always full-credit.

---

**Step 5: Run test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped

**Step 6: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat: two-color word feedback — green >=0.75, amber 0.25-0.74

Green (matched) = exact, slang, contraction, phonetic, edit1, ASR-confirmed.
Amber (matched-partial) = unconfirmed VAD provisional (0.25), edit2 prefix
truncation (0.4). Users can now see the difference between a strong match
and a marginal one without the score feeling arbitrary."
```

---

## Task 4: Fix "Perfect Line" Counter

**Context:** `_scoreLine()` at player.js line 1285 counts a line as "perfect" when `matched === total`, where `matched` is a boolean count of any word in `matchedSet`. A line where every word is edit2 (0.4 weighted) shows as "perfect" at 40% weighted score. Fix: require ≥ 90% of weighted credit.

**Files:**
- Modify: `static/player.js:1285`

---

**Step 1: Find and update the perfect-line check**

Find (around line 1285):
```js
if (matched === total) {
    this.perfectLines++;
    this.currentStreak++;
    if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
} else {
    this.currentStreak = 0;
}
```

Replace the condition only:

```js
if (weightedTotal > 0 && weightedMatched >= weightedTotal * 0.9) {
    this.perfectLines++;
    this.currentStreak++;
    if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
} else {
    this.currentStreak = 0;
}
```

Note: `weightedMatched` and `weightedTotal` are already computed in the lines above this block in `_scoreLine`. They are in scope. No new variables needed.

---

**Step 2: Run test suite**

```bash
python -m pytest tests/ -v
```

Expected: 32 passed, 1 skipped

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: perfect-line counter requires 90% weighted score

Previously counted any line as perfect if all words were in matchedSet,
regardless of score. A line of all edit2 matches (0.4 each) would show
as perfect at 40% weighted credit. Now requires weightedMatched >= 90%
of weightedTotal — consistent with what the percentage score reflects."
```

---

## Task 5: VAD Telemetry Logging

**Context:** Three telemetry blind spots confirmed by Codex:
1. VAD provisional hits produce zero match log entries (98.5% of logs are method:'none' noise)
2. `_logMatch` is called with method:'none' for every failed comparison — pure noise
3. Browser SR always logs empty `wordTimestamps: []` — can't distinguish Whisper contribution

**Files:**
- Modify: `static/player.js` — three locations

---

**Step 1: Suppress `method:'none'` entries inside `_logMatch`**

Find `_logMatch` (around line 1407). It has this signature:
```js
_logMatch(spokenWord, targetWord, method, editDistance, phoneticMatch, score, matched, windowPosition) {
```

At the very top of the function body, add an early return for non-matches:

```js
_logMatch(spokenWord, targetWord, method, editDistance, phoneticMatch, score, matched, windowPosition) {
    if (score <= 0) return;  // suppress noise — only log actual matches
    // ... rest of existing body unchanged
```

This alone drops the 98.5% method:'none' ratio to near-zero.

---

**Step 2: Log VAD provisional hits in `updateHotWord()`**

Find the VAD optimistic scoring block (around line 1174):
```js
if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
    if (!this.matchedSet.has(newHot)) {
        this.matchedSet.set(newHot, 1.0);
        this.vadMatchedSet.set(newHot, 1.0);
        this._updateWordSpans();
    }
}
```

Note: this block still sets score 1.0 in `matchedSet` — the `_scoreLine` downgrade to 0.25 for unconfirmed VAD happens at scoring time. For visual consistency with the new two-color system, the provisional hit should be stored as 0.25 so `_updateWordSpans()` shows amber immediately.

Replace the block:

```js
if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
    if (!this.matchedSet.has(newHot)) {
        this.matchedSet.set(newHot, 0.25);          // provisional — shows amber
        this.vadMatchedSet.set(newHot, 0.25);
        this._updateWordSpans();
        this._logMatch(
            this.wordTimings[newHot] ? this.wordTimings[newHot].word : '',
            this.lineWords[newHot] || '',
            'vad-provisional', -1, false, 0.25, true,
            newHot
        );
    }
}
```

**Important:** The `_scoreLine` downgrade for unconfirmed VAD was previously written to check `vadMatchedSet.has(i)` and set score to 0.25. With the provisional value now stored as 0.25 rather than 1.0, the downgrade logic in `_scoreLine` still works correctly — unconfirmed VAD hits will have score 0.25 in both `matchedSet` and `vadMatchedSet`, so the downgrade is a no-op (0.25 stays 0.25). Verify by re-reading the `_scoreLine` downgrade block added in the previous session:

```js
// In _scoreLine (previously added):
if (matchScore > 0 && vadMatchedSet && vadMatchedSet.has(i) && !asrConfirmedSet.has(i)) {
    matchScore = 0.25;
}
```

This is still correct and consistent.

---

**Step 3: Log VAD confirmation in `_matchHotWord()`**

Find `_matchHotWord()` (around line 1215). Find the ASR confirmation block:
```js
this.matchedSet.set(this.hotWordIndex, 1.0);
if (this.vadMatchedSet.has(this.hotWordIndex)) this.asrConfirmedSet.add(this.hotWordIndex);
return true;
```

Replace with:

```js
this.matchedSet.set(this.hotWordIndex, 1.0);
if (this.vadMatchedSet.has(this.hotWordIndex)) {
    this.asrConfirmedSet.add(this.hotWordIndex);
    this._logMatch(
        spoken[i],
        target,
        'vad-confirmed', -1, false, 1.0, true,
        this.hotWordIndex
    );
}
return true;
```

---

**Step 4: Pass Whisper word timestamps to `_logAsr`**

Find the Whisper response handler in `_startWhisperTrack()`. Search for the fetch('/transcribe') response handler. It will parse `{transcript, words}` from the JSON response. Find where `_logAsr` is called from the Whisper path (it may not be called at all — look for where `this.whisperBuffer` is updated after a Whisper response).

If `_logAsr` is not currently called from the Whisper path, add a call passing the `words` array from the response:

```js
// After parsing Whisper response as data = {transcript, words}:
this._logAsr('whisper', data.transcript || '', data.words || []);
```

If `_logAsr` IS already called from the Whisper path with `[]`, replace the `[]` with `data.words || []`.

---

**Step 5: Run test suite**

```bash
python -m pytest tests/ -v && node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs
```

Expected: 32 passed, 1 skipped + all JS tests pass

**Step 6: Commit**

```bash
git add static/player.js
git commit -m "fix: telemetry logging — VAD events, suppress noise, Whisper timestamps

- Log vad-provisional (0.25) and vad-confirmed (1.0) as match events
  so telemetry can show what fraction of scores come from VAD vs ASR
- Store provisional VAD hits at 0.25 in matchedSet immediately so
  _updateWordSpans shows amber (consistent with two-color system)
- Suppress method:none entries in _logMatch (was 98.5% of all logs)
- Pass Whisper word timestamps to _logAsr (was always empty array)"
```

---

## Task 6: Final Verification

**Step 1: Run the full test suite one last time**

```bash
python -m pytest tests/ -v
```

Expected output:
```
32 passed, 1 skipped
```

**Step 2: Run all JS tests**

```bash
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_telemetry.cjs
```

Expected: all pass

**Step 3: Manual smoke check checklist**

Load a song and enter game mode. Verify:

- [ ] Slow lines now show amber words when mic energy is detected (not all-white)
- [ ] Fast/medium lines still go green as before
- [ ] A word mumbled into the mic on a slow line shows amber (not green)
- [ ] Singing a word clearly on a slow line — amber → green on ASR confirmation
- [ ] Lyric words at the end of a line that ASR truncates show amber, not green
- [ ] Completely wrong word stays white, then goes red at line end
- [ ] "Perfect" count at end modal does not credit lines with all-amber words
- [ ] Telemetry downloaded via D-key + button has `vad-provisional` and `vad-confirmed` entries
- [ ] Telemetry has far fewer `method: "none"` entries than before

**Step 4: Commit if anything was tweaked during smoke check**

```bash
git add -p  # stage only intentional changes
git commit -m "fix: smoke-check corrections from manual testing"
```

---

## Success Criteria (from design doc)

1. Slow-line mean weighted score improves from 0.664 toward 0.85+ on the same songs
2. Short line (≤ 3 words) failure rate drops from 40% below 50%
3. All-green lines with fractional score (Cure For The Itch 96%) now show amber on partial-credit words
4. "Perfect" lines in end modal reflect actual ≥ 90% weighted accuracy
5. Telemetry `method: "none"` ratio drops below 10% (from 98.5%)
6. VAD hits appear as `vad-provisional` / `vad-confirmed` in match logs
