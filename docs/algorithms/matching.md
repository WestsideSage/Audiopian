# Matching

The matching pipeline is intentionally layered from strict to loose.

## Word Normalization

- Lowercase all words.
- Strip punctuation.
- Split transcripts on whitespace.

## Match Order

`wordsMatchScore()` evaluates in this order:

1. Exact match
2. `-in` / `-ing` normalization
3. Contraction match
4. Slang normalization
5. Phonetic match via Double Metaphone
6. Edit-distance match
7. No match

## Helper Sources

- `static/match-helpers.js`
  - contraction maps
  - slang maps
  - phrase equivalence
  - filler-word skipping
  - word classification and weights
- `static/scoring.js`
  - `doubleMetaphone()`
  - `wordsMatch()`
  - `wordsMatchScore()`

## Important Invariants

- Spoken token use is monotonic during sequential matching.
- Repeated target words must not reuse a single spoken token across multiple lyric slots.
- VAD-only provisional hits are visual until ASR confirms them.
- Phrase and contraction helpers may consume multiple spoken tokens, but single-word scoring still operates slot-by-slot.

## Regression Coverage

`tests/test_scoring.cjs` now carries the main word-match regression matrix.
