# Time-Gated Matching & Transcript Fencing

**Date:** 2026-03-02
**Problem:** Words turn green before the user has said them, primarily at the start of new lines.

## Root Cause

Two paths cause premature green highlighting:

1. **Stale transcript bleed:** `_collectMatches` starts scanning from `lineStartWordCount - 4`, so the last 4 words of the previous line's transcript can match against the new line's target words — especially common words like "I", "you", "the".

2. **No temporal awareness in general matching:** Unlike the hot-word system which has time windows, `_collectMatches` has zero time gating. It matches purely by sequential order against the accumulated transcript.

## Design

### 1. Time-Gated `_collectMatches`

Add a temporal gate to `_collectMatches`: only accept a match if `audio.currentTime >= wordTimings[wordIndex].windowStart`.

- Word timing data is already computed by `interpolateWordTimings()` and stored per-line.
- Pass the current line's word timings into `_collectMatches` and check the gate before accepting each match.
- If the playback hasn't reached the word's predicted window yet, skip it. The next poll cycle (100ms) or speech event will pick it up once the time arrives.
- The existing 300ms early buffer (`windowStart = estimatedTime - 0.3`) still allows slightly eager speakers to get instant feedback.

### 2. Transcript Fencing Per Line

Eliminate cross-line transcript bleed by fencing the spoken buffer per line.

- When `setActiveLine` fires, record the exact transcript length as `lineStartTranscriptPos`.
- In `_collectMatches`, start scanning from `lineStartTranscriptPos` (not `lineStartWordCount - 4`).
- In `_matchHotWord`, only search words from `lineStartTranscriptPos` onward (not the last 10 of the full transcript).
- Late-arriving finals for the previous line are handled by the existing `_lateScoreLine` mechanism (800ms delayed re-score).

### 3. Edge Cases

- **Variable BPM / slower bars:** Timing estimates are syllable-weighted within each LRC line's time span. Slow sections naturally stretch the windows. The 300ms early + 1500ms late buffer absorbs most tempo variation.
- **Repeated words within a line:** Sequential matching with `spokenIdx` advancement handles this correctly. Time gating doesn't interfere since repeated words get sequential time windows.
- **Very short lines:** 1-2 word lines get the full line duration, giving wide time windows. No special handling needed.
- **Sticky matching stays:** Once a word passes both gates (time + fence) and gets matched, it stays green permanently. We're only preventing premature entry.
- **Debug HUD:** Add `windowStart`/`windowEnd` to debug output for timing verification during testing.

## Summary of Changes

| File | Change |
|------|--------|
| `static/player.js` — `_collectMatches()` | Add time gate: check `audio.currentTime >= wt.windowStart` before accepting match |
| `static/player.js` — `setActiveLine()` | Record `lineStartTranscriptPos` from current transcript length |
| `static/player.js` — `_collectMatches()` | Use `lineStartTranscriptPos` as scan start instead of `lineStartWordCount - 4` |
| `static/player.js` — `_matchHotWord()` | Fence search to words from `lineStartTranscriptPos` onward |
| `static/player.js` — debug output | Add word timing window info to debug HUD |
