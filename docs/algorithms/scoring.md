# Scoring

Scoring happens at the line level on top of per-word match states.

## Inputs

Each line score is computed from:

- `lineWords`
- interpolated `wordTimings`
- `matchedSet`
- `vadMatchedSet`
- `asrConfirmedSet`

## Word Weights

Word weights come from `classifyWord()` in `static/match-helpers.js`:

- `core`: `1.0`
- `function`: `0.5`
- `adlib`: `0.25`

## Effective Match Score

- ASR-confirmed match uses the stored slot score.
- VAD-only provisional match contributes capped partial flow credit up to `0.25`.
- Unmatched words contribute `0`.

This means VAD-only hits remain useful for UI feedback and avoid hard red misses when the performer is audibly in the pocket, but they still cannot produce a perfect line without ASR confirmation.

## Line Arithmetic

`computeLineScore()` in `static/scoring.js` returns:

- `totalWords`
- `matchedWords`
- `weightedTotal`
- `weightedMatched`
- `missedWords`
- `missedWordIndices`
- `perfect`

`perfect` currently means:

- `weightedTotal > 0`
- `weightedMatched >= weightedTotal * 0.9`

## Runtime Usage

- `_scoreLine()` uses `computeLineScore()` when a line closes.
- `_lateScoreLine()` can still add late ASR matches before final scoring.
- Running totals are stored on `GameMode`.

## Shadow Phrase Engine

The phrase engine is the next scoring architecture and currently runs in shadow mode. It does not replace line-level score totals until benchmark evidence shows it is fairer and more stable.

The phrase engine treats each song as timed phrases rather than closed lines. Each phrase has selected anchors, a difficulty profile, a settlement window, and source-specific evidence. Browser SR can provide provisional and final near-live evidence. Whisper can rescue or confirm recent phrases, but it should not control live timing. VAD can prove vocal presence and flow, but it cannot prove lyric correctness by itself.

The target behavior is lyric-flow scoring: presence unlocks scoring, flow determines timing quality, and lyric anchors determine whether the flow counts.

## Regression Coverage

`tests/test_scoring.cjs` includes:

- a word-match method matrix
- line-arithmetic cases
- repeated-target regression coverage
