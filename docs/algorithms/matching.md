# Matching (is this word a match?)

When you sing a word, Karaokee has to decide: does it match the lyric? It runs a series of tests, strictest to loosest, and stops at the first one that passes. This lives in `wordsMatchScore` (`scoring.js:311`). Each test gives a confidence score (1.0 = certain):

| # | Test | What it catches | Score |
|---|---|---|---|
| 1 | **Exact** | the same word | 1.0 |
| 2 | **`-in` / `-ing`** | "singin'" = "singing" | 1.0 |
| 3 | **Contraction** | "gonna" = "going to" | 1.0 |
| 4 | **Slang** | known slang swaps | 0.9 |
| 5 | **Sound-alike** — *Double Metaphone*, a code for how a word *sounds* | "night" = "knight" | 0.8 |
| 6 | **Almost-spelled-right** — *edit distance*, how many letter changes apart | 1 letter off | 0.75 |
| 7 | same, but 2 letters off, only when it's a clipped prefix | "remember" → "remem" | 0.4 |
| — | **No match** | | 0.0 |

(Order and scores: `scoring.js:311-347`.)

## Where the rules live

- `match-helpers.js` — the contraction list, the slang list, multi-word phrase equivalences, filler-word skipping, and the word-importance weights (see [`scoring.md`](scoring.md)).
- `scoring.js` — `doubleMetaphone` (the sound-alike codes), `wordsMatch` (a yes/no), and `wordsMatchScore` (the scored version above).

## Rules that keep it honest

- Words are matched **in order** — Karaokee walks forward through what you sang; it can't jump backward to grab a word.
- **One spoken word can't be reused** for two different lyric slots — important when a lyric repeats the same word.
- A word picked up only by the **voice detector** (not yet confirmed as text) shows on screen but doesn't count until the recognizer confirms it.

## Before matching: cleanup

Words are lowercased, stripped of punctuation, and the transcript is split on spaces — so "Night," and "night" compare equal.

## Tests

`tests/test_scoring.cjs` carries the main word-match regression matrix.
