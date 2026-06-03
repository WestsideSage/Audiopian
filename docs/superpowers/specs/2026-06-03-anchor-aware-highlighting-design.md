# Anchor-Aware In-Game Highlighting — Design Spec

**Date:** 2026-06-03
**Author:** Westside Sage (+ Claude)
**Builds on:** the phrase engine (`static/phrase-engine.js`) and the arcade difficulty model.
**Status:** Approved (design).

---

## 1. Context & Goal

The in-game word coloring is the **legacy V1 per-word system** and is decoupled from the V2 phrase engine that drives the actual (honest, difficulty-aware) score. During play, unmatched words stay neutral; but at line-end [`_scoreLine` (player.js:1843)](../../static/player.js) reddens **every** unmatched scoreable word via `computeLineScore.missedWordIndices`, ignoring anchors and difficulty. Result: on Easy you *clear* a line on ~1 key word, yet every word the recognizer missed turns **red** — including words you were never scored on. The colors say "you failed" while the score says "you aced it."

**Goal:** make the in-game coloring a **live mirror of the phrase engine** — only the scored (anchor) words light up, and red appears only when you actually miss a line (don't meet that difficulty's bar). Visual only; scoring/honesty unchanged.

---

## 2. Behavior (when `karaokee_v2` is on)

- **Non-key words** (everything the engine doesn't treat as an anchor) render **dim/neutral, always** — never green, never red.
- **Key (anchor) words** reflect the phrase engine's own per-anchor state:
  - **Green** as soon as the engine credits the anchor as hit (`state.anchorHits[anchorIdx]` present).
  - **Red** only when the anchor's phrase has **settled** *and* did **not** clear (`status === 'settled' && lyricStatus !== 'confirmed'`). A cleared line shows **no red**, even if some of its key words went unhit.
  - **Neutral** otherwise (phrase still open, or it cleared).
- Net effect, by difficulty (automatic, via the engine's own `anchorsRequired`): **Easy** clears on a word or two → almost no red; **Expert** reds the missed key words when you genuinely fall short.

**When `karaokee_v2` is off:** coloring is unchanged (legacy V1 per-word behavior, for A/B).

---

## 3. Mechanism

1. **Tag anchor spans at render.** `renderLyricsGameMode` already emits one `.word-span` per displayed word. After building the spans, use the phrase plan to tag each anchor span with `data-phrase-id` and `data-anchor-idx` (and a `key-word` marker). Non-anchor spans are left untagged.
2. **Green, live.** In the active-line paint (`_updateWordSpans`), under V2, color a `key-word` span **green** iff its phrase state has that `anchorIdx` in `anchorHits`; otherwise leave it neutral. (Non-anchor spans are not touched under V2.) Under V1, `_updateWordSpans` is unchanged.
3. **Red, at settle.** In the existing settle pass (`_commitNewlySettled`, which already detects phrases reaching `settled`), under V2: for each newly-settled phrase whose `lyricStatus !== 'confirmed'`, add `missed` to its **un-hit** anchor spans. Cleared phrases add no red.
4. **Suppress V1 red under V2.** Guard the `missedWordIndices → 'missed'` block in `_scoreLine` so it only runs when V2 is off. (V1's score math — `weightedMatched/weightedTotal`, telemetry transitions — is untouched.)

---

## 4. The index mapping (the crux — unit-tested)

The engine's per-line word list is `normalizeWords(line.text)` = whitespace-split → normalize → drop-empties ([scoring.js:354](../../static/scoring.js)). `renderLyricsGameMode` produces one span per `line.text.split(' ')` token kept by `normalizeWord(w).length > 0` — the **same sequence, 1:1, in order** (both split on whitespace and drop punctuation-only/empty tokens; `normalizeWord` strips hyphens in place rather than sub-splitting). So a displayed span's index equals the engine's word index for that line.

For lines the engine **chunks** into multiple phrases, `anchor.wordIdx` is an index into the *chunk's* words; the chunks are contiguous slices of the line's word list. So:

```
spanIndex(anchor of phrase P) = (sum of words.length of P's line-mates with chunkIdx < P.chunkIdx) + anchor.wordIdx
```

This is computed by a new **pure** function:
- **`buildAnchorSpanIndex(phrasePlan)`** → `{ [lineIdx]: [ { wordIndex, phraseId, anchorIdx } ... ] }`, accumulating a per-line word offset as it walks the plan's phrases (which are ordered by lineIdx then chunkIdx).

Pure and `require`-able, so the mapping is golden-tested independently of the DOM.

---

## 5. Files

- **Create `static/lyric-paint-helpers.js`** — pure `buildAnchorSpanIndex(phrasePlan)`. UMD module, no DOM.
- **Create `tests/test_lyric_paint_helpers.cjs`** — golden tests (single-phrase line; chunked multi-phrase line; anchorless line).
- **Modify `static/player.html`** — add `<script src="/static/lyric-paint-helpers.js">` before `player.js`. (Reuses existing `.word-span.matched` / `.missed` CSS; no new colors.)
- **Modify `static/player.js`** — tag anchor spans in/after `renderLyricsGameMode` (store the map on the GameMode instance); V2 branch in `_updateWordSpans` (green from `anchorHits`); V2 red pass in `_commitNewlySettled` (red un-hit anchors of settled-unconfirmed phrases); guard `_scoreLine`'s red block to V1-only.

---

## 6. Testing

- **`tests/test_lyric_paint_helpers.cjs`** — build a small plan via `KaraokeePhraseEngine.buildPhrasePlan` and assert `buildAnchorSpanIndex` returns the right `{wordIndex, phraseId, anchorIdx}` per line, including a chunked line (offset applied) and a filler-only line (no anchors).
- **Regression:** all existing `.cjs` + `pytest` suites stay green; `node --check` clean.
- **Manual (browser, V2 on):** on Easy, sing a song — only key words light green, non-key words never color, and a cleared line shows no red; deliberately miss a line → its un-hit key words go red. Switch to Expert → reds appear when you fall short. Toggle V off → legacy coloring returns.

---

## 7. Out of Scope (YAGNI)

- **The "recognizer dropped a word I sang" issue** (lag/boundary) — a separate, deeper investigation. This change makes it far less visible (dim, not red), and the telemetry traces (`flowStatus`, `rejectedCandidates`, token timing) can diagnose it later.
- **No pre-highlighting** of anchors during play (no "here are the words to sing" cue mid-song) — only hit/miss feedback. A possible later tweak.
- No change to anchor selection, matching, timing, the honest %, the grade, or the anti-cheese model.
- V1 coloring is left as-is.

## 8. Open Items
- If repainting cost matters, scope the green pass to the active ± 1 lines (it already is, via `_updateWordSpans` on the active line); the red pass is per-phrase at settle. No full-song repaint loop.
