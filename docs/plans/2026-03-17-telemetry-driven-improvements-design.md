# Telemetry-Driven Scoring & ASR Improvements

**Date**: 2026-03-17
**Based on**: Analysis of 10 real-play telemetry sessions (620 lines, 5303 words, 78.1% overall match rate)

## Problem Statement

Telemetry analysis revealed several systemic issues degrading match accuracy:

1. **Binary matching** — all matches are score=1.0 or 0.0, no fuzzy tolerance. ASR garbling a single character = total miss.
2. **ASR buffer bloat** — Web Speech API accumulates 200+ word un-finalized transcripts, strongly correlating with worse match quality.
3. **Function words swallowed** — "a", "the", "I", "it", "me" etc. are consistently missed (14-21x each) in fast speech, unfairly penalizing scores.
4. **Ad-libs unrecognizable** — "ooh" (24x missed), "wow" (18x), "yeah" (11x). Non-lexical vocalizations fail ASR.
5. **Slang/profanity filtered** — "nigga" (12x missed), "em" (12x), "bout" (8x). ASR sanitizes or misrecognizes common hip-hop vocabulary.
6. **Telemetry cap** — 9/10 songs hit the 5000 match event cap, losing diagnostic data for 49-93% of each song.

## Design

### 1. Expanded Match Pipeline

Current pipeline: `exact → contraction → phrase → miss`

New pipeline: `exact → contraction → phrase → slang dictionary → phonetic fuzzy → edit distance fuzzy → miss`

**Slang dictionary**: A lookup table mapping common ASR mishearings and slang variants to their target words:
- `"gonna" → "going to"`, `"em" → "them"`, `"bout" → "about"`, `"ya" → "you"`, `"wanna" → "want to"`, `"gotta" → "got to"`, `"kinda" → "kind of"`, `"tryna" → "trying to"`
- Ad-lib recognition: explicit entries for `"ooh"`, `"yeah"`, `"huh"`, `"uh"`, `"ah"` so ASR output maps to lyric text
- Profanity mappings for common ASR sanitizations

**Phonetic fuzzy**: If Double Metaphone codes match but spelling doesn't, award 0.9 credit. The phonetic engine already exists (`doubleMetaphone()`) but is only used as a boolean gate inside `wordsMatch()`. This change makes it a scored fallback.

**Edit distance fuzzy**: For words >= 3 characters:
- Edit distance 1 → 0.75 credit
- Edit distance 2 → 0.5 credit
- Edit distance 3+ → 0.0

Each match method records its `method` and `score` in telemetry for future tuning.

### 2. ASR Buffer Management

**Line-transition reset**: When the game advances to a new line, run one final `_collectMatches` against the outgoing line, then reset `lineStartTranscriptPos` to the current transcript length. This prevents old text from polluting the new line's matching window.

**Sliding window truncation**: Within a line, cap the spoken word scan to the last `N` words, where `N = lineWords.length * 3`. This keeps matching fast and focused, especially for rap verses where the ASR buffer grows rapidly between finals.

These two changes work together: the reset prevents cross-line drift, the sliding window prevents within-line drift.

### 3. Smart Word Classification

Pre-process lyrics at load time to classify words:

- **Core words**: Regular lyrics — weight 1.0
- **Function words**: Articles, pronouns, prepositions ("a", "the", "I", "it", "me", "with", "in", "on", "to", "of", "is", "and", "or", "but", "at", "for") — weight 0.5
- **Ad-lib words**: Anything inside parentheses, plus known interjections ("ooh", "yeah", "huh", "uh", "ah", "wow") — weight 0.25

Score calculation changes from `matchedWords / totalWords` to `weightedMatched / weightedTotal`. This means a song heavy in ad-libs and function words won't be artificially harder than one with clean lyrics.

### 4. Telemetry Improvements

- **Remove the 5000 cap** but only log first-time matches and misses (skip redundant re-checks for already-matched words). Full song coverage without massive files.
- **Log new match methods and scores** — the existing `method` and `score` fields in telemetry match entries will capture the new fuzzy/slang/phonetic methods automatically.
- No changes to `transitions` telemetry — already comprehensive and uncapped.

## Key Data Points from Analysis

| Song | Lines | Words | Match% | Notes |
|------|-------|-------|--------|-------|
| Cure For The Itch (Linkin Park) | 8 | 39 | 97.4% | Spoken word, best performer |
| Silkk da Shocka (Isaiah Rashad) | 52 | 365 | 92.9% | Laid-back flow |
| Love Is All I Got (Feed Me) | 64 | 456 | 92.3% | Melodic/repetitive |
| FLOW (Jay Prince) | 49 | 347 | 90.2% | |
| Black Panther (Kendrick) | 35 | 333 | 83.5% | |
| WAV Files (Lupe Fiasco) | 149 | 1138 | 77.5% | Long, proper nouns fail |
| euphoria (Kendrick) | 129 | 1428 | 74.3% | Dense, 11.1 words/line avg |
| Rich Interlude (Kendrick) | 43 | 322 | 73.6% | Only 2 ASR finals |
| 9-3 Freestyle (Isaiah Rashad) | 42 | 369 | 66.4% | Freestyle delivery |
| Rubbin Off The Paint (YBN Nahmir) | 49 | 506 | 64.8% | Heavy slang, 2 ASR finals |

**Tempo performance**: Slow 71.0%, Medium 87.4%, Fast 78.1% — slow lines underperform due to ASR drift accumulation.

**Top missed words**: ooh (24), a (21), the (19), wow (18), I (17), with/me/it (14 each), that (13), nigga/em (12 each).
