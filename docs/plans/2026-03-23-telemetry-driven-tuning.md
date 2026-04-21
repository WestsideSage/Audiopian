# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Telemetry-Driven Algorithm Tuning Design

**Date:** 2026-03-23
**Data source:** 16 telemetry sessions from 2026-03-23 (all hip-hop/rap)
**Score range observed:** 74.0% â€“ 93.1% (weighted)

## Problem Statement

Analysis of 16 gameplay telemetry sessions revealed systematic false positives (wrong words getting credit), false negatives (correct words not scoring), and structural scoring issues with short/slow lines. This design addresses all data-backed findings to improve both score accuracy and responsiveness.

---

## Section 1: Match Precision Tightening

### Edit-Distance-2 Reform

**Finding:** ~18% false positive rate on edit2 matches. Examples: "cant"â†’"and", "god"â†’"and", "for"â†’"you" all receive 0.5 score.

**Changes:**
- Raise minimum word length for edit2 matches to â‰¥6 characters. A 3-letter word with 2 edits is essentially a different word.
- Drop edit2 score from 0.5 â†’ 0.4.
- Keep edit1 unchanged (0.75, already gated by `maxEditDistance`).

### Phonetic Match Tightening

**Finding:** False positives like "die"â†’"the", "one"â†’"in", "get"â†’"caught", "pussy"â†’"boss" all get 0.9 score.

**Changes:**
- Require both words be â‰¥3 characters for phonetic matching.
- Require same first character OR same word length (Â±1).
- Drop phonetic score from 0.9 â†’ 0.8.

---

## Section 2: Expanding Valid Matches (Reducing False Negatives)

### -in'/-ing Suffix Normalization

**Finding:** Lyrics contain "livin", "smokin", "talkin" etc. but ASR produces "living", "smoking", "talking". Systematic gap for hip-hop/rap.

**Changes:**
- In `wordsMatchScore()`, after exact match but before contraction/slang: check if one word ends in "in"/"in'" and the other ends in "ing" with the same stem. Treat as exact match (score 1.0).

### Profanity â†” Censored Form Mappings

**Finding:** "fucking" appears 6 times across sessions, never matches. ASR censors profanity.

**Changes:**
- Expand SLANG_MAP with ASR censorship outputs: "f***ing"â†’"fucking", starred/bleeped forms.
- Add common ASR substitutions: "ducking"â†’"fucking", "shut"â†’"shit".

### Contraction Expansion

**Finding:** Only 24 contraction matches across 16 songs of rap â€” many missing.

**Changes:**
- Add: "bout"â†”"about", "em"â†”"them", "cause"â†”"because", "ima"â†”"i'm going to", "finna"â†”"fixing to", "aint"â†”"ain't"â†”"isn't".
- Review contraction map against telemetry missed-words lists for additional gaps.

---

## Section 3: LRC Parsing Cleanup

### Strip Parenthetical Markers

**Finding:** Words like "(he", "dead)", "(amen)", "(complex)" are scored as targets. Parentheses become part of the word string.

**Changes:**
- During LRC parsing/word timing generation, strip leading `(` and trailing `)` from words.
- If an entire phrase is parenthetical, classify those words as `adlib` weight (0.25).
- Ensure the existing `inParentheses` flag is set correctly and parens are stripped from the word text.

### Empty String Targets

**Finding:** 3 instances of `""` as a target word.

**Changes:**
- Filter out empty/whitespace-only tokens during LRC line parsing, before they enter `wordTimings`.

### Numeric Text

**Finding:** "20", "911", "6" in lyrics don't match ASR's "twenty", "nine one one", "six".

**Changes:**
- Add a small number-to-words lookup (0â€“100 plus common numbers from telemetry: 911, 38, 48).
- Apply during word normalization: if a target is numeric, also accept its spelled-out form, and vice versa.

---

## Section 4: Repeated Word Matching

**Finding:** Lines like "alright, alright, alright" score 33% because only the first occurrence gets matched.

**Changes:**
- When a spoken word matches a target word, only consume the first *unmatched* index of that word. If index 0 is already matched, the next spoken instance should match index 1, then index 2.
- The matching loop must skip already-matched indices when multiple target words are identical.
- Existing merge logic (only upgrade, never downgrade) already protects against regressions.

---

## Section 5: Slow-Tempo Line Fixes

**Finding:** 547 slow-tempo lines average 67.8% vs 94â€“95% for medium/fast. Biggest single score driver.

### Zero-ASR Line Fencing

Some lines get 0 ASR events but score 100% from stale accumulated transcript, or 0% when old text doesn't happen to match.

**Changes:**
- Track a per-line "ASR activity" flag. If zero ASR events fire during a line's active window, mark as "unscored" and exclude from running score calculation (neutral impact).
- Prevents both false 100%s and unfair 0%s.

### Extended Matching Window for Short Lines

Lines with 2â€“3 words and short durations (<1.5s) expire before ASR can process them.

**Changes:**
- For slow-tempo lines with â‰¤3 words, extend overlap duration by 50%.
- Extend pre-line window by ~200ms for short lines (player likely starts slightly early).

### Not Changing
- Not merging short lines with adjacent lines (too risky for display/transitions).
- Not changing tempo classification itself (correctly categorized per the data).

---

## Priority Order

| Priority | Change | Expected Impact | Risk |
|----------|--------|----------------|------|
| 1 | Strip parenthetical markers + empty string targets | Eliminates impossible-to-match targets | Very low |
| 2 | -in'/-ing suffix normalization | Recovers many missed words across all songs | Low |
| 3 | Tighten edit2 (min length 6, score 0.4) | Removes ~167 false positives | Low |
| 4 | Tighten phonetic (min length 3, same-first-char or same-length) | Removes many false positives | Low-medium |
| 5 | Repeated word matching | Fixes repeated-word pattern | Medium |
| 6 | Zero-ASR line fencing | Eliminates false scores on silent lines | Medium |
| 7 | Expand SLANG_MAP (profanity, contractions) | Recovers never-matched words | Low |
| 8 | Extended window for short slow lines | Addresses biggest score driver category | Medium |
| 9 | Numeric text normalization | Small impact, easy win | Low |

---

## Telemetry Key Metrics (Baseline)

For comparing before/after:
- **Mean weighted score:** 84.3%
- **Slow-tempo line avg:** 67.8%
- **Edit2 match count:** 945 (est. 167 false positives)
- **Phonetic match count:** 890 (high false positive rate on short words)
- **Contraction matches:** 24
- **Slang matches:** 14
- **Never-matched words:** "fucking" (6), "dropping" (5), "muh" (5), "broken" (4), "listening" (4)

---

## Implementation

# Telemetry-Driven Algorithm Tuning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve scoring accuracy and responsiveness by fixing false positives, reducing false negatives, cleaning up LRC parsing, and improving slow-tempo line handling â€” all driven by analysis of 16 gameplay telemetry sessions.

**Architecture:** Changes span three files: `match-helpers.js` (matching algorithms, dictionaries), `player.js` (word parsing, line scoring, matching loops), and `sync-helpers.js` (overlap/window timing). Each task is independent and can be committed separately.

**Tech Stack:** Plain JavaScript (no build system), loaded via `<script>` tags. Tests run via Node.js with `module.exports` at bottom of each helper file.

---

### Task 1: Strip Parenthetical Markers from LRC Targets

Parenthetical characters like `(` and `)` are currently baked into target words (e.g., `"(he"`, `"dead)"`, `"(amen)"`), making them unmatchable by ASR. The `normalizeWord` function strips most punctuation but not parentheses.

**Files:**
- Modify: `static/player.js:230-232` â€” `normalizeWord()` function

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
normalizeWord("(he")    â†’ "he"
normalizeWord("dead)")  â†’ "dead"
normalizeWord("(amen)") â†’ "amen"
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
- Modify: `static/player.js:919-920` â€” word list creation in `setActiveLine()`

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
- Modify: `static/player.js:175-200` â€” `wordsMatchScore()` function

**Step 1: Add suffix normalization check**

After the exact match check (line 177) and before the contraction check (line 180), add:

```javascript
function wordsMatchScore(spoken, target, targetPhonetic) {
    // 1. Exact
    if (spoken === target) return { score: 1.0, method: 'exact' };

    // 1b. -in'/-ing suffix normalization
    // "livin" â†” "living", "smokin" â†” "smoking", etc.
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

This handles all combinations: "livin"â†’"living", "living"â†’"livin", "smokin"â†’"smoking", etc.

**Step 2: Verify with test cases**

```
wordsMatchScore("livin", "living")   â†’ { score: 1.0, method: 'exact' }
wordsMatchScore("smoking", "smokin") â†’ { score: 1.0, method: 'exact' }
wordsMatchScore("talkin", "talking") â†’ { score: 1.0, method: 'exact' }
wordsMatchScore("in", "ing")         â†’ no match (length < 4, skipped)
wordsMatchScore("bin", "bing")       â†’ no match (length < 4, skipped)
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add -in/-ing suffix normalization for hip-hop lyric matching"
```

---

### Task 4: Tighten Edit-Distance-2 Matching

Edit2 has ~18% false positive rate with matches like "cant"â†’"and", "god"â†’"and", "for"â†’"you". The fix raises the minimum word length for edit2 and lowers its score.

**Files:**
- Modify: `static/player.js:192-197` â€” edit distance section of `wordsMatchScore()`
- Modify: `static/match-helpers.js:302-307` â€” `maxEditDistance()` function

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

New (raise edit2 threshold to â‰¥7 chars, cap at 2):
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
maxEditDistance(3) â†’ 1  (blocks "cant"â†’"and" which has dist=2)
maxEditDistance(5) â†’ 1  (blocks "for"â†’"you" which has dist=2)
maxEditDistance(7) â†’ 2  (allows "smoking"â†’"smoling" which has dist=1... wait, that's edit1)
maxEditDistance(8) â†’ 2  (allows "sentence"â†’"sentance" which is a legitimate edit2)
```

**Step 4: Commit**

```bash
git add static/player.js static/match-helpers.js
git commit -m "fix: tighten edit2 matching â€” require min 7 chars, lower score to 0.4"
```

---

### Task 5: Tighten Phonetic Matching

False positives like "die"â†’"the", "one"â†’"in", "get"â†’"caught", "pussy"â†’"boss" all receive 0.9 score. The fix adds length and first-character guards.

**Files:**
- Modify: `static/player.js:185-190` â€” phonetic section of `wordsMatchScore()`

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
    // 4. Phonetic match (guarded: both words â‰¥3 chars, same first letter or similar length)
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

**Note:** The `_spokenLRU` variable is declared at line 155 â€” it's now accessed only inside the `if` block, which is fine since the `var` still references the outer scope.

**Step 2: Verify false positives are blocked**

```
"die" (3) vs "the" (3): same length âœ“ BUT different first letter AND length diff=0 â‰¤1 âœ“ â€” STILL PASSES
```

Hmm, "die" and "the" have same length. Let's use a stricter gate: require same first letter OR length diff â‰¤1 AND length â‰¥4:

Actually, let me reconsider. The key false positives:
- "die"â†’"the": diff first letter, same length â†’ passes length gate. Need first-letter gate to be required for short words.
- "get"â†’"caught": diff first letter, length diff=2 â†’ blocked by length gate âœ“
- "pussy"â†’"boss": diff first letter, length diff=1 â†’ would pass length gate

Better approach â€” require **both** words â‰¥3 chars AND (same first letter OR both words â‰¥5 chars with length diff â‰¤2):

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
- "die"â†’"the": diff first letter, neither â‰¥5 â†’ BLOCKED âœ“
- "one"â†’"in": "in" is length 2 â†’ BLOCKED by outer â‰¥3 gate âœ“
- "get"â†’"caught": diff first letter, "get" is 3 (not â‰¥5) â†’ BLOCKED âœ“
- "pussy"â†’"boss": diff first letter, "boss" is 4 (not â‰¥5) â†’ BLOCKED âœ“
- "night"â†’"knight": same first letter="n"/"k" â€” diff first letter, both â‰¥5 âœ“ â†’ PASSES âœ“
- "fone"â†’"phone": diff first letter ("f"/"p"), both â‰¥4 but not â‰¥5 â†’ BLOCKED. Acceptable loss, edit1 catches it.
- "their"â†’"there": same first letter â†’ PASSES âœ“

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: tighten phonetic matching â€” require same first char or both words â‰¥5 chars"
```

---

### Task 6: Fix Repeated Word Matching

Lines like "alright, alright, alright" score 33% because the matching loop breaks after matching the first target occurrence, never reaching the second/third. The fix makes the loop skip already-matched indices for duplicate target words.

**Files:**
- Modify: `static/player.js:931-987` â€” `_collectMatches()` inner loop
- Modify: `static/player.js:740-792` â€” `_collectMatchesWhisper()` inner loop

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
2. Phrase match ("all right"â†’"alright") consumes spoken words and only matches once

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
                        // Don't advance spokenIdx â€” let next iteration re-match this spoken word
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
- Modify: `static/match-helpers.js:70-97` â€” SLANG_MAP pairs array

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
- Modify: `static/player.js` â€” `GameMode` constructor, ASR handler, `_scoreLine()`

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

Short slow-tempo lines (â‰¤3 words, <1.5s) expire before ASR can process. The fix extends overlap duration and adds a pre-line matching window.

**Files:**
- Modify: `static/sync-helpers.js:36-43` â€” `getOverlapDuration()`

**Step 1: Add a line-word-count-aware overlap extension**

Create a new function in `sync-helpers.js` after `getOverlapDuration()`:

```javascript
/**
 * Return adjusted overlap duration for short lines.
 * Short slow lines (â‰¤3 words) get 50% more overlap time.
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
- Modify: `static/match-helpers.js` â€” add number lookup and expand SLANG_MAP

**Step 1: Add number pairs to SLANG_MAP**

Add these pairs to the existing SLANG_MAP pairs array (after the existing number section at line 94-96):

```javascript
        // Number â†” word mappings
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
