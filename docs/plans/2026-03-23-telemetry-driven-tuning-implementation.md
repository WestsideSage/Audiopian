# Telemetry-Driven Algorithm Tuning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve scoring accuracy and responsiveness by fixing false positives, reducing false negatives, cleaning up LRC parsing, and improving slow-tempo line handling — all driven by analysis of 16 gameplay telemetry sessions.

**Architecture:** Changes span three files: `match-helpers.js` (matching algorithms, dictionaries), `player.js` (word parsing, line scoring, matching loops), and `sync-helpers.js` (overlap/window timing). Each task is independent and can be committed separately.

**Tech Stack:** Plain JavaScript (no build system), loaded via `<script>` tags. Tests run via Node.js with `module.exports` at bottom of each helper file.

---

### Task 1: Strip Parenthetical Markers from LRC Targets

Parenthetical characters like `(` and `)` are currently baked into target words (e.g., `"(he"`, `"dead)"`, `"(amen)"`), making them unmatchable by ASR. The `normalizeWord` function strips most punctuation but not parentheses.

**Files:**
- Modify: `static/player.js:230-232` — `normalizeWord()` function

**Step 1: Update `normalizeWord` to strip parentheses**

In `static/player.js`, the current `normalizeWord` function at line 230:
```javascript
function normalizeWord(w) {
    return w.toLowerCase().replace(/[''`,.!?;:\-"*]/g, '').trim();
}
```

Add `()` to the character class:
```javascript
function normalizeWord(w) {
    return w.toLowerCase().replace(/[''`,.!?;:\-"*()]/g, '').trim();
}
```

**Step 2: Verify parentheses are stripped**

Test manually by adding a quick console check:
```
normalizeWord("(he")    → "he"
normalizeWord("dead)")  → "dead"
normalizeWord("(amen)") → "amen"
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: strip parentheses from normalizeWord to fix unmatchable LRC targets"
```

---

### Task 2: Filter Empty String Targets

The telemetry shows 3 instances of `""` appearing as target words. These come from LRC lines that produce empty tokens after splitting and normalizing.

**Files:**
- Modify: `static/player.js:919-920` — word list creation in `setActiveLine()`

**Step 1: Add empty-word filter**

At line 919-920 in `setActiveLine()`, the current code:
```javascript
var rawWords = lineText.split(' ');
this.lineWords = rawWords.map(function(w) { return normalizeWord(w); });
```

Add a filter to remove empty results:
```javascript
var rawWords = lineText.split(' ');
this.lineWords = rawWords.map(function(w) { return normalizeWord(w); }).filter(function(w) { return w.length > 0; });
```

**Step 2: Verify no empty words survive**

The filter ensures that any word that normalizes to `""` (e.g., standalone punctuation, stray parentheses) is dropped from scoring.

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: filter empty strings from lineWords after normalization"
```

---

### Task 3: Add -in'/-ing Suffix Normalization

Lyrics contain "livin", "smokin", "talkin" etc. but ASR produces "living", "smoking", "talking". This is a systematic mismatch in hip-hop/rap. The fix goes in `wordsMatchScore()` early in the matching pipeline.

**Files:**
- Modify: `static/player.js:175-200` — `wordsMatchScore()` function

**Step 1: Add suffix normalization check**

After the exact match check (line 177) and before the contraction check (line 180), add:

```javascript
function wordsMatchScore(spoken, target, targetPhonetic) {
    // 1. Exact
    if (spoken === target) return { score: 1.0, method: 'exact' };

    // 1b. -in'/-ing suffix normalization
    // "livin" ↔ "living", "smokin" ↔ "smoking", etc.
    if (spoken.length >= 4 && target.length >= 4) {
        var sBase = spoken.endsWith('ing') ? spoken.slice(0, -3) :
                    (spoken.endsWith('in') ? spoken.slice(0, -2) : null);
        var tBase = target.endsWith('ing') ? target.slice(0, -3) :
                    (target.endsWith('in') ? target.slice(0, -2) : null);
        if (sBase && tBase && sBase === tBase) return { score: 1.0, method: 'exact' };
    }

    // 2. Contraction (single-word)
    if (contractionsMatch(spoken, target)) return { score: 1.0, method: 'contraction' };
    // ... rest unchanged
```

This handles all combinations: "livin"→"living", "living"→"livin", "smokin"→"smoking", etc.

**Step 2: Verify with test cases**

```
wordsMatchScore("livin", "living")   → { score: 1.0, method: 'exact' }
wordsMatchScore("smoking", "smokin") → { score: 1.0, method: 'exact' }
wordsMatchScore("talkin", "talking") → { score: 1.0, method: 'exact' }
wordsMatchScore("in", "ing")         → no match (length < 4, skipped)
wordsMatchScore("bin", "bing")       → no match (length < 4, skipped)
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add -in/-ing suffix normalization for hip-hop lyric matching"
```

---

### Task 4: Tighten Edit-Distance-2 Matching

Edit2 has ~18% false positive rate with matches like "cant"→"and", "god"→"and", "for"→"you". The fix raises the minimum word length for edit2 and lowers its score.

**Files:**
- Modify: `static/player.js:192-197` — edit distance section of `wordsMatchScore()`
- Modify: `static/match-helpers.js:302-307` — `maxEditDistance()` function

**Step 1: Restrict edit2 to longer words**

In `match-helpers.js`, update `maxEditDistance()` at line 302:

Current:
```javascript
function maxEditDistance(len) {
    if (len <= 0) return 1;
    if (len <= 6) return 1;
    if (len <= 9) return 2;
    return 3;
}
```

New (raise edit2 threshold to ≥7 chars, cap at 2):
```javascript
function maxEditDistance(len) {
    if (len <= 6) return 1;
    return 2;
}
```

**Step 2: Lower edit2 score from 0.5 to 0.4**

In `player.js` at line 196, change:
```javascript
if (dist === 2) return { score: 0.5, method: 'edit2' };
```
to:
```javascript
if (dist === 2) return { score: 0.4, method: 'edit2' };
```

**Step 3: Verify false positives are blocked**

```
maxEditDistance(3) → 1  (blocks "cant"→"and" which has dist=2)
maxEditDistance(5) → 1  (blocks "for"→"you" which has dist=2)
maxEditDistance(7) → 2  (allows "smoking"→"smoling" which has dist=1... wait, that's edit1)
maxEditDistance(8) → 2  (allows "sentence"→"sentance" which is a legitimate edit2)
```

**Step 4: Commit**

```bash
git add static/player.js static/match-helpers.js
git commit -m "fix: tighten edit2 matching — require min 7 chars, lower score to 0.4"
```

---

### Task 5: Tighten Phonetic Matching

False positives like "die"→"the", "one"→"in", "get"→"caught", "pussy"→"boss" all receive 0.9 score. The fix adds length and first-character guards.

**Files:**
- Modify: `static/player.js:185-190` — phonetic section of `wordsMatchScore()`

**Step 1: Add guards to phonetic matching**

Replace lines 185-190:

Current:
```javascript
    // 4. Phonetic match
    var sp = _spokenLRU.get(spoken);
    var tp = targetPhonetic || doubleMetaphone(target);
    if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
        return { score: 0.9, method: 'phonetic' };
    }
```

New:
```javascript
    // 4. Phonetic match (guarded: both words ≥3 chars, same first letter or similar length)
    if (spoken.length >= 3 && target.length >= 3) {
        var sp = _spokenLRU.get(spoken);
        var tp = targetPhonetic || doubleMetaphone(target);
        if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
            if (spoken[0] === target[0] || Math.abs(spoken.length - target.length) <= 1) {
                return { score: 0.8, method: 'phonetic' };
            }
        }
    }
```

**Note:** The `_spokenLRU` variable is declared at line 155 — it's now accessed only inside the `if` block, which is fine since the `var` still references the outer scope.

**Step 2: Verify false positives are blocked**

```
"die" (3) vs "the" (3): same length ✓ BUT different first letter AND length diff=0 ≤1 ✓ — STILL PASSES
```

Hmm, "die" and "the" have same length. Let's use a stricter gate: require same first letter OR length diff ≤1 AND length ≥4:

Actually, let me reconsider. The key false positives:
- "die"→"the": diff first letter, same length → passes length gate. Need first-letter gate to be required for short words.
- "get"→"caught": diff first letter, length diff=2 → blocked by length gate ✓
- "pussy"→"boss": diff first letter, length diff=1 → would pass length gate

Better approach — require **both** words ≥3 chars AND (same first letter OR both words ≥5 chars with length diff ≤2):

```javascript
    // 4. Phonetic match (guarded)
    if (spoken.length >= 3 && target.length >= 3) {
        var sp = _spokenLRU.get(spoken);
        var tp = targetPhonetic || doubleMetaphone(target);
        if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
            var sameFirst = spoken[0] === target[0];
            var bothLong = spoken.length >= 5 && target.length >= 5 && Math.abs(spoken.length - target.length) <= 2;
            if (sameFirst || bothLong) {
                return { score: 0.8, method: 'phonetic' };
            }
        }
    }
```

Verification:
- "die"→"the": diff first letter, neither ≥5 → BLOCKED ✓
- "one"→"in": "in" is length 2 → BLOCKED by outer ≥3 gate ✓
- "get"→"caught": diff first letter, "get" is 3 (not ≥5) → BLOCKED ✓
- "pussy"→"boss": diff first letter, "boss" is 4 (not ≥5) → BLOCKED ✓
- "night"→"knight": same first letter="n"/"k" — diff first letter, both ≥5 ✓ → PASSES ✓
- "fone"→"phone": diff first letter ("f"/"p"), both ≥4 but not ≥5 → BLOCKED. Acceptable loss, edit1 catches it.
- "their"→"there": same first letter → PASSES ✓

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: tighten phonetic matching — require same first char or both words ≥5 chars"
```

---

### Task 6: Fix Repeated Word Matching

Lines like "alright, alright, alright" score 33% because the matching loop breaks after matching the first target occurrence, never reaching the second/third. The fix makes the loop skip already-matched indices for duplicate target words.

**Files:**
- Modify: `static/player.js:931-987` — `_collectMatches()` inner loop
- Modify: `static/player.js:740-792` — `_collectMatchesWhisper()` inner loop

**Step 1: Update `_collectMatches` to skip matched indices**

The current outer loop (line 940):
```javascript
for (var li = 0; li < this.lineWords.length; li++) {
    if (li < this.wordTimings.length) {
        if (now < this.wordTimings[li].windowStart) continue;
    }
    var target = this.lineWords[li];
    // ... inner loop that breaks on match
```

The issue is that once a spoken word matches target index 0 ("alright"), the loop moves to index 1 ("alright") but spokenIdx has advanced past that same spoken word, so it can't match it. But the real problem is the inner loop: when spoken "alright" is at position si, it matches li=0 and breaks, advancing spokenIdx to si+1. For li=1 with the same target "alright", the next spoken "alright" may be at si+1.

Actually, re-reading the code more carefully: the matching is outer=target words, inner=spoken words. When target[0]="alright" matches spoken[3]="alright", spokenIdx advances to 4. Then target[1]="alright" starts scanning from spoken[4]. If the player said "alright" three times, spoken[4]="alright" matches target[1], and spoken[5]="alright" matches target[2]. This should already work IF the ASR produces three separate "alright" tokens.

The real issue from telemetry is likely that ASR produces "all right" (two words), which `phraseMatch` catches for the first occurrence but not subsequent ones because phrase matching also advances past those spoken words. Or the ASR only produces "alright" once even though it was said three times (ASR deduplication).

Let me reconsider. The fix should ensure that when the same spoken word at the same position would match multiple target indices, we handle it. Actually, the current code already handles multiple spoken words matching multiple target indices sequentially. The problem is:

1. ASR might produce only one "alright" even though the player said it 3 times
2. Phrase match ("all right"→"alright") consumes spoken words and only matches once

For case 1, a single spoken "alright" at position si should be allowed to match multiple target indices of "alright". Currently it can't because after matching li=0, spokenIdx advances to si+1, skipping past that spoken word for li=1.

**Fix:** When a match is found AND the next target word is the same word, don't advance spokenIdx:

In `_collectMatches()`, after the scored single-word match block (line 969-981), replace:
```javascript
                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    // Only upgrade, never downgrade a previously matched word
                    var prev = resultMap.get(li);
                    if (prev === undefined || result.score > prev) {
                        resultMap.set(li, result.score);
                    }
                    this._logMatch(spoken[si], target, result.method,
                        result.method === 'edit1' ? 1 : result.method === 'edit2' ? 2 : 0,
                        result.method === 'phonetic', result.score, true, si);
                    spokenIdx = si + 1;
                    break;
                }
```

With:
```javascript
                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    var prev = resultMap.get(li);
                    if (prev === undefined || result.score > prev) {
                        resultMap.set(li, result.score);
                    }
                    this._logMatch(spoken[si], target, result.method,
                        result.method === 'edit1' ? 1 : result.method === 'edit2' ? 2 : 0,
                        result.method === 'phonetic', result.score, true, si);
                    // If the next target word is the same, allow reusing this spoken position
                    var nextTarget = (li + 1 < this.lineWords.length) ? this.lineWords[li + 1] : null;
                    if (nextTarget === target) {
                        // Don't advance spokenIdx — let next iteration re-match this spoken word
                    } else {
                        spokenIdx = si + 1;
                    }
                    break;
                }
```

**Step 2: Apply the same fix to `_collectMatchesWhisper()`**

In the scored match block around lines 771-776, apply the same repeated-word logic:

```javascript
                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    whisperMap.set(li, result.score);
                    var nextTarget = (li + 1 < this.lineWords.length) ? this.lineWords[li + 1] : null;
                    if (nextTarget === target) {
                        // Don't advance spokenIdx for repeated words
                    } else {
                        spokenIdx = si + 1;
                    }
                    break;
                }
```

**Step 3: Apply the same fix to `_lateScoreLine()`**

In `_lateScoreLine()` at line 1226, apply the same logic:
```javascript
                    var nextTarget = (li + 1 < lineWords.length) ? lineWords[li + 1] : null;
                    if (nextTarget === target) {
                        // Don't advance for repeated words
                    } else {
                        spokenIdx = si + 1;
                    }
```

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "fix: allow single spoken word to match repeated target words on same line"
```

---

### Task 7: Expand SLANG_MAP for Profanity and ASR Censorship

"fucking" is never matched across 6 appearances because ASR censors it. Add common ASR censorship patterns and substitutions.

**Files:**
- Modify: `static/match-helpers.js:70-97` — SLANG_MAP pairs array

**Step 1: Add new pairs to the SLANG_MAP pairs array**

After the existing profanity section (line 76), add these additional pairs:

```javascript
        // Extended profanity ASR censorship patterns
        ['fucking', 'ducking'], ['fucking', 'f***ing'], ['fucking', 'fing'],
        ['fucked', 'ducked'], ['fucked', 'f***ed'],
        ['fuck', 'duck'], ['fuck', 'f***'],
        ['shit', 'sht'], ['shit', 's***'], ['shit', 'sit'],
        ['bitch', 'b***h'], ['bitch', 'witch'],
        ['ass', 'a**'], ['nigga', 'neighbor'],
        ['niggas', 'neighbors'],
        ['hoe', 'ho'], ['hoes', 'hos'],
        ['dick', 'rick'], ['dick', 'd***'],
```

**Step 2: Also add missing contraction/slang entries spotted in telemetry**

Review the telemetry "never matched" words and add any that should map. The existing SLANG_MAP and CONTRACTION_MAP already cover most cases. Key additions:

Add to CONTRACTION_MAP:
```javascript
    'whatchu':  'what you',
    'getchu':   'get you',
    'gotchu':   'got you',
    'letchu':   'let you',
```

**Step 3: Commit**

```bash
git add static/match-helpers.js
git commit -m "feat: expand SLANG_MAP with ASR censorship patterns and add -chu contractions"
```

---

### Task 8: Zero-ASR Line Fencing

Lines with 0 ASR events during their window can score 100% from stale accumulated transcript or 0% unfairly. The fix tracks whether ASR fired during a line and excludes silent lines from scoring.

**Files:**
- Modify: `static/player.js` — `GameMode` constructor, ASR handler, `_scoreLine()`

**Step 1: Add ASR activity tracking**

In the `GameMode` constructor (around line 357), add a new property:
```javascript
this.lineHadAsrEvent = false;  // true if any ASR event fired during this line
```

**Step 2: Set the flag when ASR fires**

Find the ASR result handler (search for where `_logAsr` is called with `'interim'` or `'final'`). When an ASR result arrives for the current line, set:
```javascript
this.lineHadAsrEvent = true;
```

**Step 3: Reset the flag on line transition**

In `setActiveLine()` around line 877 (where `matchedSet` is reset), add:
```javascript
this.lineHadAsrEvent = false;
```

**Step 4: Pass the flag to the overlap overlay**

In `setActiveLine()` where `this.prevLine` is created (line 809), add the flag:
```javascript
this.prevLine = {
    // ... existing properties ...
    lineHadAsrEvent:        this.lineHadAsrEvent,
};
```

**Step 5: Skip scoring for silent lines**

In `_scoreLine()` (around line 1131), add an early return:
```javascript
_scoreLine(lineIdx, lineWords, matchedSet, lineHadAsrEvent) {
    const total = lineWords.length;
    if (total === 0) return;

    // If no ASR events fired during this line, skip scoring entirely (neutral)
    if (lineHadAsrEvent === false) return;
```

Update all callers of `_scoreLine` to pass the flag:
- `_finalizePrevLine()` at line 696: `this._scoreLine(prev.lineIdx, prev.lineWords, prev.matchedSet, prev.lineHadAsrEvent);`
- `_lateScoreLine()` at line 1239: the flag should be passed through from the overlap

**Step 6: Commit**

```bash
git add static/player.js
git commit -m "feat: track ASR activity per line, skip scoring for lines with zero ASR events"
```

---

### Task 9: Extended Window for Short Slow Lines

Short slow-tempo lines (≤3 words, <1.5s) expire before ASR can process. The fix extends overlap duration and adds a pre-line matching window.

**Files:**
- Modify: `static/sync-helpers.js:36-43` — `getOverlapDuration()`

**Step 1: Add a line-word-count-aware overlap extension**

Create a new function in `sync-helpers.js` after `getOverlapDuration()`:

```javascript
/**
 * Return adjusted overlap duration for short lines.
 * Short slow lines (≤3 words) get 50% more overlap time.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @param {number} wordCount - number of words on the line
 * @returns {number}
 */
function getAdjustedOverlapDuration(tempoClass, wordCount) {
    var base = getOverlapDuration(tempoClass);
    if (tempoClass === 'slow' && wordCount <= 3) {
        return base * 1.5;
    }
    return base;
}
```

**Step 2: Use the adjusted function in `setActiveLine()`**

In `player.js` at line 806, change:
```javascript
var overlapDuration = getOverlapDuration(outgoingTempoClass);
```
to:
```javascript
var overlapDuration = getAdjustedOverlapDuration(outgoingTempoClass, this.lineWords.length);
```

**Step 3: Extend pre-line window for short slow lines**

In `interpolateWordTimings()` at line 324, the slow-tempo windowStart is already set to `lineStart + params.windowStart` which is `lineStart - 0.3s`. For short lines, extend this to `-0.5s`:

```javascript
            var wStart = tempoClass === 'slow'
                ? lineStart + (words.length <= 3 ? -0.5 : params.windowStart)
                : estimatedTime + params.windowStart;
```

**Step 4: Export new function**

In `sync-helpers.js` at line 123, add `getAdjustedOverlapDuration` to the exports:
```javascript
module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getAdjustedOverlapDuration, getScoreDelay, getChunkSamples, computeSongTempoProfile, classifyLineTempoRelative, getSpokenWindowSize };
```

**Step 5: Commit**

```bash
git add static/sync-helpers.js static/player.js
git commit -m "feat: extend overlap duration and pre-line window for short slow-tempo lines"
```

---

### Task 10: Add Numeric Text Normalization

Words like "20", "911", "6" in lyrics don't match ASR's "twenty", "nine one one", "six".

**Files:**
- Modify: `static/match-helpers.js` — add number lookup and expand SLANG_MAP

**Step 1: Add number pairs to SLANG_MAP**

Add these pairs to the existing SLANG_MAP pairs array (after the existing number section at line 94-96):

```javascript
        // Number ↔ word mappings
        ['0', 'zero'], ['1', 'one'], ['2', 'two'], ['3', 'three'],
        ['4', 'four'], ['5', 'five'], ['6', 'six'], ['7', 'seven'],
        ['8', 'eight'], ['9', 'nine'], ['10', 'ten'],
        ['11', 'eleven'], ['12', 'twelve'], ['13', 'thirteen'],
        ['14', 'fourteen'], ['15', 'fifteen'], ['16', 'sixteen'],
        ['17', 'seventeen'], ['18', 'eighteen'], ['19', 'nineteen'],
        ['20', 'twenty'], ['21', 'twentyone'],
        ['30', 'thirty'], ['38', 'thirtyeight'],
        ['40', 'forty'], ['48', 'fortyeight'],
        ['50', 'fifty'], ['100', 'hundred'],
        ['911', 'nine eleven'], ['911', 'nineoneone'],
```

Note: These will only match if the number appears as a standalone word in the LRC. The SLANG_MAP bidirectional lookup handles both directions automatically.

**Step 2: Commit**

```bash
git add static/match-helpers.js
git commit -m "feat: add number-to-word mappings in SLANG_MAP for numeric LRC targets"
```

---

### Summary of Changes by File

| File | Tasks |
|------|-------|
| `static/player.js` | 1 (normalizeWord), 2 (empty filter), 3 (-in/-ing), 4 (edit2 score), 5 (phonetic guards), 6 (repeated words), 8 (zero-ASR fencing), 9 (overlap adjustment) |
| `static/match-helpers.js` | 4 (maxEditDistance), 7 (SLANG_MAP expansion), 10 (number mappings) |
| `static/sync-helpers.js` | 9 (adjusted overlap function) |
