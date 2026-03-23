# Telemetry-Driven Algorithm Tuning Design

**Date:** 2026-03-23
**Data source:** 16 telemetry sessions from 2026-03-23 (all hip-hop/rap)
**Score range observed:** 74.0% – 93.1% (weighted)

## Problem Statement

Analysis of 16 gameplay telemetry sessions revealed systematic false positives (wrong words getting credit), false negatives (correct words not scoring), and structural scoring issues with short/slow lines. This design addresses all data-backed findings to improve both score accuracy and responsiveness.

---

## Section 1: Match Precision Tightening

### Edit-Distance-2 Reform

**Finding:** ~18% false positive rate on edit2 matches. Examples: "cant"→"and", "god"→"and", "for"→"you" all receive 0.5 score.

**Changes:**
- Raise minimum word length for edit2 matches to ≥6 characters. A 3-letter word with 2 edits is essentially a different word.
- Drop edit2 score from 0.5 → 0.4.
- Keep edit1 unchanged (0.75, already gated by `maxEditDistance`).

### Phonetic Match Tightening

**Finding:** False positives like "die"→"the", "one"→"in", "get"→"caught", "pussy"→"boss" all get 0.9 score.

**Changes:**
- Require both words be ≥3 characters for phonetic matching.
- Require same first character OR same word length (±1).
- Drop phonetic score from 0.9 → 0.8.

---

## Section 2: Expanding Valid Matches (Reducing False Negatives)

### -in'/-ing Suffix Normalization

**Finding:** Lyrics contain "livin", "smokin", "talkin" etc. but ASR produces "living", "smoking", "talking". Systematic gap for hip-hop/rap.

**Changes:**
- In `wordsMatchScore()`, after exact match but before contraction/slang: check if one word ends in "in"/"in'" and the other ends in "ing" with the same stem. Treat as exact match (score 1.0).

### Profanity ↔ Censored Form Mappings

**Finding:** "fucking" appears 6 times across sessions, never matches. ASR censors profanity.

**Changes:**
- Expand SLANG_MAP with ASR censorship outputs: "f***ing"→"fucking", starred/bleeped forms.
- Add common ASR substitutions: "ducking"→"fucking", "shut"→"shit".

### Contraction Expansion

**Finding:** Only 24 contraction matches across 16 songs of rap — many missing.

**Changes:**
- Add: "bout"↔"about", "em"↔"them", "cause"↔"because", "ima"↔"i'm going to", "finna"↔"fixing to", "aint"↔"ain't"↔"isn't".
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
- Add a small number-to-words lookup (0–100 plus common numbers from telemetry: 911, 38, 48).
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

**Finding:** 547 slow-tempo lines average 67.8% vs 94–95% for medium/fast. Biggest single score driver.

### Zero-ASR Line Fencing

Some lines get 0 ASR events but score 100% from stale accumulated transcript, or 0% when old text doesn't happen to match.

**Changes:**
- Track a per-line "ASR activity" flag. If zero ASR events fire during a line's active window, mark as "unscored" and exclude from running score calculation (neutral impact).
- Prevents both false 100%s and unfair 0%s.

### Extended Matching Window for Short Lines

Lines with 2–3 words and short durations (<1.5s) expire before ASR can process them.

**Changes:**
- For slow-tempo lines with ≤3 words, extend overlap duration by 50%.
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
