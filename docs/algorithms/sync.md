# Sync

Sync behavior is tempo-aware.

## Tempo Classes

`static/sync-helpers.js` classifies line tempo by words per second:

- `slow`
- `normal`
- `fast`

The helper module also computes song-relative tempo classes for VAD behavior:

- `slow`
- `medium`
- `fast`

## Window Controls

`getWindowParams()` defines:

- `windowStart`
- `windowEnd`
- `driftTrack1`
- `driftTrack2`

Other sync helpers define:

- overlap duration
- short-line overlap adjustment
- late-score delay
- Whisper chunk sizing
- spoken search window size

## Timing Interpolation

`interpolateWordTimings()` in `static/scoring.js`:

1. splits each LRC line into words
2. estimates syllable counts
3. spreads line duration across the words
4. assigns `windowStart`, `windowEnd`, `wordClass`, and `weight`
5. caches the target-side phonetic code

## Current Direction

- Keep the raw-line identity model.
- Prefer narrow, testable sync changes over grouped-line architecture changes.
- Treat short-line handling and SR backlog as separate problems.
