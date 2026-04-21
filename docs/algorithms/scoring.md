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
- VAD-only provisional match contributes `0` to weighted scoring.
- Unmatched words contribute `0`.

This means VAD-only hits remain useful for UI feedback but do not count toward the final score.

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

## Regression Coverage

`tests/test_scoring.cjs` includes:

- a word-match method matrix
- line-arithmetic cases
- repeated-target regression coverage
