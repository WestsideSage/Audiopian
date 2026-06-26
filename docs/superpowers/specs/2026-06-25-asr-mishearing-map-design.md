# ASR-Mishearing Map (target-directional) — design

**Date:** 2026-06-25
**Status:** approved

## Problem

A lyric word sung with non-standard stress can be transcribed by the recognizer
as a phonetically-distant common word. The sung word is *correct*; the ASR
mangled it, and none of the existing match paths (exact, contraction, slang,
double-metaphone, edit-distance, affix) can bridge the gap.

Concrete case (telemetry `karaokee-telemetry-2026-06-25T03-54-50.json`, *Class of
3000 — Banana Zoo*, expert): the outro repeats `gorilla go gorilla go go` four
times. Sung as a drawn-out 2-beat **"Go-rilla"**, Web Speech transcribes the
repetitions as **"really"** (`"gorilla go go really go go go really ..."`). The
double metaphones differ (`gorilla → KRL`, `really → RL`), edit distance is far
> 1, and no slang/homophone entry bridges them, so every "really" token is
dropped. Result: lines 24/25/26 settle `miss 0/2` — three consecutive misses
that reset a 25-phrase streak.

## Goal

A reusable, honesty-bounded mechanism — extendable per song — that lets a curated
recognizer-mishearing credit the real lyric word. Gorilla is the first entry.

## Non-goals

- The secondary "stranded literal matches" seam (correctly-heard `gorilla`
  tokens arrived at a stale `windowPosition` and were never promoted). The alias
  makes it moot for this case because fresh "really" tokens land in-window at
  each repetition. Left untouched to avoid timing-regression risk.
- Multi-word targets/substitutions. v1 is single token → single token.

## Design

### `ASR_MISHEARINGS` (new — `static/match-helpers.js`)

A **target-keyed, one-directional** map (lyric word → known ASR substitutions):

```js
var ASR_MISHEARINGS = {
    gorilla: ['really'],   // drawn-out "Go-rilla" → Web Speech hears "really"
};

function mishearingMatch(spoken, target) {
    var subs = ASR_MISHEARINGS[target];
    return !!(subs && subs.indexOf(spoken) !== -1);
}
```

Honesty bound (chosen: **target-directional only**): the bridge fires *only* when
the lyric target is a registered key. Singing "really" against a "really" lyric
is untouched (exact match). "really" can credit `gorilla`, never the reverse, and
only on lines whose lyric is literally `gorilla`. No global bidirectional
pollution (unlike `SLANG_MAP`). Cross-song cheese surface is negligible: the only
way to abuse it is to utter the *easier* substitute on a line whose lyric is the
rare keyed word.

Both `ASR_MISHEARINGS` and `mishearingMatch` are exported from the module so the
`.cjs` tests can require them and the browser can use them as globals.

### Wiring (`static/scoring.js`)

Mirror the existing `slangMatch` placement:

- `wordsMatch`, after the `slangMatch` line:
  `if (mishearingMatch(spoken, target)) return true;`
- `wordsMatchScore`, after the `slang` line:
  `if (mishearingMatch(spoken, target)) return { score: 0.9, method: 'mishearing' };`

Score `0.9` mirrors `slang`: high enough to credit an anchor (phrase clears), with
a small discount marking a recovered mishearing rather than a clean hit.

## Testing

New `tests/test_mishearing.cjs` (UMD `require`, like the other helper tests):

1. `mishearingMatch('really','gorilla')` → true;
   `wordsMatchScore('really','gorilla')` → `{score:0.9, method:'mishearing'}`.
2. Directionality: `mishearingMatch('gorilla','really')` → false.
3. Honesty: unregistered target (`mishearingMatch('really','banana')`) → false.
4. Regression: `wordsMatchScore('really','really')` still `exact`; an unrelated
   pair still `none`.

Run the existing JS suites to confirm no regression.

## Docs

Update the `match-helpers.js` bullet in `CLAUDE.md` to mention `ASR_MISHEARINGS` /
`mishearingMatch` (target-directional recognizer-mishearing bridge) and the new
test file.
