# Intelligent Lyrics Matching - Design Document

**Date:** 2026-03-03
**Status:** Approved

## Problem Statement

The current lyrics matching algorithm has two classes of issues that cause false misses:

1. **Word boundary mismatches:** ASR engines (Web Speech API and Whisper) may split or merge words differently than the lyrics source. For example, lyrics contain "Alright" but ASR returns "all right" as two words. The current 1-to-1 `wordsMatch()` cannot bridge this gap — neither "all" nor "right" individually match "alright" via edit distance or phonetics.

2. **Timing/sync issues:** ASR latency is variable and unaccounted for. Words said on time get recognized after the time window has moved on, line transitions close before the last words are captured, and fast sections suffer disproportionately because ASR batches rapid speech into larger chunks with bursty delivery.

## Goals

- Reduce false misses (words shown red despite being said correctly)
- Maintain score integrity (avoid inflating scores with false greens)
- Self-tune to actual ASR performance characteristics
- Keep the system debuggable

## Design

### 1. Word Boundary Normalization (Hybrid Approach)

#### 1a. Equivalence Map + Canonicalization

A new `WORD_EQUIV_MAP` maps multi-word phrases to canonical single-word forms and vice versa. Applied to both lyrics and ASR transcript during normalization, before matching.

A new `canonicalizeWords(words)` function runs after `expandContractions()`. It scans the word array with a sliding window of up to 3 words, checking if a 3-word, 2-word, or 1-word sequence has a canonical form. Longest match wins.

**Initial equivalence entries:**

| Input | Canonical |
|-------|-----------|
| `all right` | `alright` |
| `every day` | `everyday` |
| `every one` | `everyone` |
| `any one` | `anyone` |
| `some one` | `someone` |
| `no one` | `noone` |
| `any time` | `anytime` |
| `some time` | `sometime` |
| `any way` | `anyway` |
| `every thing` | `everything` |
| `some thing` | `something` |
| `any thing` | `anything` |
| `no thing` | `nothing` |
| `in to` | `into` |
| `on to` | `onto` |
| `a lot` | `alot` |
| `ice cream` | `icecream` |
| `all ready` | `already` |
| `all ways` | `always` |
| `all though` | `although` |
| `all together` | `altogether` |

The map is bidirectional: single-word canonical forms also have entries so that if lyrics have the split form and ASR has the merged form (or vice versa), both sides canonicalize to the same result.

#### 1b. Concatenation Fallback

When `wordsMatch(spoken, target)` fails in `_collectMatches()`:

1. Try concatenating `spoken[si] + spoken[si+1]` and test against `target` using **phonetic matching only** (Double Metaphone). No edit-distance allowed for this fallback to prevent false greens.
2. If it matches, consume both spoken words and mark the target as hit.
3. Also try the reverse: if a single spoken word fails, check if `target[li] + target[li+1]` concatenated matches the spoken word phonetically. If so, mark both target words as hit and advance both indices.

### 2. Adaptive ASR Latency Compensation

#### 2a. Latency Tracker

When a word matches in `_collectMatches()` or `_matchHotWord()`, record the delta: `matchTime - wordTiming.expected` (where `expected` is the midpoint of the word's predicted window).

Maintain a sliding window of the last 20 match deltas. The median of recent deltas = `estimatedLatency`.

#### 2b. Window Shifting

Use `estimatedLatency` to adjust time windows:

- `effectiveWindowStart = wordTiming.windowStart - estimatedLatency`
- `effectiveWindowEnd = wordTiming.windowEnd + max(estimatedLatency, 0.3)`

If ASR consistently delivers results 400ms late, all windows open 400ms earlier and close 400ms later. Self-tuning.

#### 2c. Fast Section Grace Period

When `classifyTempo()` returns `'fast'`:

- Multiply overlap duration by 1.5
- Extend drift window by 30% (e.g., 25 -> 32 words)

This accounts for ASR batching fast speech into larger chunks with bursty delivery.

#### 2d. Calibration

- First 2 lines use default windows (no compensation) while collecting initial latency samples.
- After 8+ match observations, latency compensation activates.
- Sliding window naturally adapts if latency changes mid-song.

### 3. Post-hoc Reconciliation Pass

#### 3a. When It Runs

At line scoring time (inside `_scoreLine()` / `_finalizePrevLine()`), after normal matching has produced its `matchedSet`.

#### 3b. How It Works

1. Take the full transcript accumulated during the line's lifetime (from `lineStartTranscriptPos` to current transcript length).
2. For each unmatched target word, re-scan the entire transcript window using `wordsMatch()` three-tier matching + canonicalization.
3. Use a wider drift window (2x normal) since ordering matters less at reconciliation — we just want to confirm the word was said somewhere during the line.
4. Newly matched words are upgraded from miss to hit before score calculation.

#### 3c. False-Green Prevention

- Only runs on genuinely unmatched words.
- For short words (3 letters or fewer), the reconciliation pass disables edit-distance matching — only exact + phonetic. Prevents tiny words from false-matching everywhere.
- A word can only reconcile if it appears in the transcript after the previous matched word's position (maintains ordering with wider tolerance).

#### 3d. Visual Feedback

Words reconciled in the post-hoc pass turn green with a subtle pulse animation, visually distinct from normal real-time matches. This lets the user know it was a late catch.

## Updated Processing Pipeline

```
ASR Result / Whisper Transcript
        |
  normalizeWords()          <- existing: lowercase, strip punctuation
        |
  expandContractions()      <- existing: gonna->going to, etc.
        |
  canonicalizeWords()       <- NEW: all right->alright, every day->everyday
        |
+-----------------------------------------------+
|  _collectMatches() / _collectMatchesWhisper() |
|  +- Latency-adjusted time gate                | <- NEW
|  +- Adaptive drift window                     |
|  +- wordsMatch() [3-tier fuzzy]               |
|  +- Concatenation fallback (phonetic-gated)   | <- NEW
+-----------------------------------------------+
        |
  _matchHotWord()   (latency-adjusted window)    <- UPDATED
        |
  _matchPrevLine()  (extended fast-section overlap) <- UPDATED
        |
  _scoreLine() / _finalizePrevLine()
  +- Post-hoc reconciliation pass                <- NEW
  +- Reconciled words get subtle pulse animation <- NEW
  +- Calculate final score
```

## Files Modified

| File | Changes |
|------|---------|
| `static/player.js` | `canonicalizeWords()`, `WORD_EQUIV_MAP`, concatenation fallback in matching, latency tracker, reconciliation pass, reconciled-word animation |
| `static/sync-helpers.js` | Fast-section grace period multipliers, latency window helpers |

## Debug HUD Additions

- Current `estimatedLatency` value
- Reconciled word count per line (e.g., "+2 reconciled")
- When canonicalization triggered (which words were remapped)

## What Stays the Same

- Existing 3-tier `wordsMatch()` logic
- Existing contraction map (CONTRACTION_MAP)
- Scoring formula (matched/total)
- Whisper track architecture
- All existing debug HUD elements
