# Slow Song Time Gate Fix

**Date:** 2026-03-03
**Status:** Approved

## Problem

On slow songs (< 2 WPS), the per-word time gate in `_collectMatches` rejects words spoken before their predicted time window opens. When a user speaks an entire line at normal cadence (~2s) but the line spans 10+ seconds, only the first 1-2 words pass the gate. The rest are rejected because `audio.currentTime < windowStart`. Once the user goes silent, ASR stops firing results, and the matcher never re-runs for those words.

**Observed:** "Your letter is the best gift" consistently scores only "Your letter" as green on a slow 83 BPM song.

## Root Cause

`interpolateWordTimings` distributes word timing proportionally by syllable count across the full line duration. For a 6-word line spanning 10s, later words get `windowStart` values 4-8 seconds into the line. The time gate in `_collectMatches` (line 826) skips any word where `now < windowStart`.

## Solution

For lines classified as `'slow'`, set ALL words' `windowStart` to `lineStart + params.windowStart` (lineStart - 0.3s) instead of `estimatedTime + params.windowStart`. This makes every word on a slow line matchable as soon as the line activates.

Keep `windowEnd` per-word so the hot word system still highlights the current word as the song progresses.

Normal and fast lines are unchanged.

## Why This Is Safe

- **Cross-line leakage:** Prevented by transcript fencing (fence resets at line transitions).
- **Hot word system:** Still works — `updateHotWord` uses both `windowStart` and `windowEnd`, and `windowEnd` remains per-word.
- **Normal/fast songs:** Unaffected (per-word time gates remain for >= 2 WPS).

## Scope

- **Files changed:** `static/player.js` — one conditional in `interpolateWordTimings`
- **No backend changes**
- **No new helper functions**
