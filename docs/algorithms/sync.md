# Sync (keeping the lyrics lined up with the music)

Karaokee needs to know *when* each lyric word is expected, so it can check whether you sang it at the right time. It works this out per line, and adapts to how fast the line is.

## Fast vs. slow lines

`classifyTempo` (`sync-helpers.js:11`) measures a line's speed in **words per second (wps)** and buckets it:

- **fast** — more than 5 words/second (rapid-fire rap verses)
- **normal** — 2 to 5 words/second
- **slow** — under 2 words/second (ballads)

There's also a *song-relative* version (`classifyLineTempoRelative`) that compares each line to the rest of *this* song (using its median and 80th-percentile speeds), so a "fast" line inside a slow song is judged in context.

## How wide is the "in time?" window

`getWindowParams` (`sync-helpers.js:22`) sets, per tempo, how early or late a word can be sung and still count — plus how much the window may drift to track the timing. Faster lines get a more forgiving window:

| Tempo | Window (seconds around the expected time) |
|---|---|
| slow | −0.3 → +1.5 |
| normal | −0.3 → +1.5 |
| fast | −0.5 → +2.5 |

Other sync helpers handle: how long two lines overlap at a boundary, a short-line adjustment, the delay before a line is scored (to let late text arrive), the audio chunk size sent to local Whisper, and how far back to search the transcript for a word.

## Guessing each word's timing

The lyrics file (LRC) timestamps each *line*, not each *word*. `interpolateWordTimings` (`scoring.js`) fills in the gaps:

1. splits the line into words,
2. estimates each word's syllable count,
3. spreads the line's total time across the words by syllables (longer words get more time),
4. tags each word with its expected start/end time, its kind (core / function / ad-lib), and its weight,
5. pre-computes the word's sound-alike code so matching stays fast.

## Design notes

- Keep the simple "one LRC line = one line" model.
- Prefer small, testable timing tweaks over re-architecting how lines are grouped.

## Tests

`tests/test_sync_helpers.cjs` covers tempo classification and the window parameters.
