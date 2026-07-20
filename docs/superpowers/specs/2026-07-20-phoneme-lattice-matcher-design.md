# Phoneme-Lattice Matcher — Design Spec

**Date:** 2026-07-20  
**Source:** Fable adversarial review outstanding item 2  
**Status:** Approved by implementation request; thresholds preregistered below

## 1. Problem

The word matcher cannot recover honest recognition when the ASR changes word
boundaries or returns a different word sequence with similar sound. Confirmed
examples from the telemetry corpus include:

- `choppa let it eat` → `chocolate lady`
- `watch me do my` → `want me to my`
- `I skrrt` → `Oscar`
- `shiny gold` → `shiny goat`

Per-word exceptions cannot generalize across this class. The fallback must compare
the sound of the lyric phrase and ASR window while retaining two honesty guards:
the whole phrase must align, and each credited anchor must have aligned support of
its own.

## 2. Pure module contract

Add `static/lattice-align.js` as a UMD module exporting:

```js
doubleMetaphoneFull(word) -> [primary, secondary]

alignPhonemeLattice({
  lyricWords: string[],
  spokenWords: string[],
  anchors: [{ anchorIdx, wordIdx, word }],
  lineFloor?, lineCoverageFloor?, anchorFloor?, anchorCoverageFloor?
}) -> {
  accepted: boolean,
  lineScore: number,
  lineCoverage: number,
  credits: [{ anchorIdx, wordIdx, score, coverage, tokenIndices }]
}
```

`doubleMetaphoneFull` follows the existing `scoring.js` encoder but does not apply
its four-character truncation. The existing `doubleMetaphone` API and behavior stay
unchanged.

The aligner is deterministic, side-effect free, and has no DOM, clock, media, or
session dependencies.

## 3. Alignment

`doubleMetaphoneFull` remains available for untruncated diagnostic/fast-path parity.
For lattice alignment, each normalized word becomes a compact phoneme stream that
retains vowels (to prevent short-word consonant collisions) while folding consonants
into the same broad acoustic families. Empty codes are ignored. Codes are
concatenated while retaining character-to-word maps for lyric and ASR positions.

Run Smith-Waterman local alignment over the two phoneme strings:

- exact phoneme: `+2`
- same phoneme class: `+1`
- substitution: `-1`
- gap: `-0.5`
- floor each cell at `0`

Near-equivalence classes are symmetric:

- `T D`
- `P B`
- `S X Z`
- `K G Q`
- `F V`
- `J X`
- `M N`

Trace back the maximum-scoring cell. For each lyric phoneme, retain whether it was
aligned exact/near and which ASR token supplied its counterpart.

## 4. Preregistered acceptance guards

Defaults are fixed before corpus replay:

- whole-line Dice-normalized score `>= 0.70`; `>= 0.60` only when the aligned
  ASR span uses at most half as many tokens as the lyric (the explicit fusion class)
- whole-line shorter-string phoneme coverage `>= 0.60`
- anchor normalized score `>= 0.50`
- anchor phoneme coverage `>= 0.50`

Line normalization divides positive aligned quality by the sum of lyric and ASR
phoneme lengths (a Dice-style score); this avoids punishing a fused ASR token twice.
Anchor normalization uses its own maximum exact-match score. An anchor receives no
credit from an alignment supported only by other words.
Accepted anchor credits use scoring method `lattice` and score `0.85` in the phrase
engine, leaving exact matches preferable.

If recovery tests fail, thresholds may move only with the complete recovery and
cheese suite visible in the same change. A cheese regression blocks shipping.

## 5. Phrase-engine integration

Invoke the lattice only from `reconcileLateEvidence`, after the existing fast word,
compound, and unique-anchor passes, and only for candidate phrases that:

- still have unhit anchors;
- are inside the existing reconcile lookback;
- pass the existing in-window-flow gate when that gate is armed.

The alignment may inspect the complete evidence window for line context. A credit
is emitted only when its aligned ASR token span contains an unconsumed token. All
unconsumed tokens in that credited span are then added to `consumedTokenIds`, so one
acoustic span cannot inflate multiple anchors or phrases.

Each hit records:

- `method: 'lattice'`
- `score: 0.85`
- source suffix `_lattice`
- the underlying evidence token indices in `consumedTokens`

Browser load order is `scoring.js` → `lattice-align.js` → `phrase-engine.js`.

## 6. Validation gates

Pure golden tests:

- all four known segmentation/misrecognition examples produce the intended anchor
  credit;
- one matching word inside an otherwise unrelated line fails the whole-line guard;
- an anchor with no aligned phoneme support is not credited;
- returned token indices identify the ASR tokens that supported the anchor;
- the full Metaphone code is longer than four characters where expected, while
  `scoring.doubleMetaphone` remains truncated.

Phrase-engine integration tests:

- an in-window-flow phrase can gain a `lattice` anchor during reconciliation;
- silence plus a later matching burst gains no lattice credit;
- hum/flow in a later line plus a later burst gains no credit for a line with no
  in-window flow;
- consumed lattice tokens cannot credit a second phrase.

Corpus replay:

- report recoveries for Bands, Klick Clack, Nas — Who Killed It, and Roots;
- zero new clears in the scripted silent and hum+burst cheese scenarios;
- all existing phrase/scoring/replay tests remain green.

## 7. Non-goals

- no change to the existing four-character `doubleMetaphone` fast path;
- no neural grapheme-to-phoneme model or server dependency;
- no pitch, rhythm, or vocal-quality inference;
- no credit without the phrase engine's existing flow/reconcile eligibility.
