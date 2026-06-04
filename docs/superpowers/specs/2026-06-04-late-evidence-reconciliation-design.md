# Late-Evidence Reconciliation — Design Spec

**Date:** 2026-06-04
**Author:** Westside Sage (+ Claude)
**Builds on:** the phrase engine (`static/phrase-engine.js`) and the recognition feed in `static/player.js`.
**Status:** Approved (design).

---

## 1. Context & Goal

Telemetry across four difficulty runs of the same song showed the **recognizer**, not the scoring thresholds, is what breaks scoring: correct-but-late recognition gets dropped. Root cause (confirmed in code): every recognition result is stamped with **arrival time** (`audioTimeSec = audio.currentTime` at the moment it lands — [player.js:760](../../static/player.js), [player.js:1083](../../static/player.js)), and the phrase engine only matches a line's anchors within a **time window around that line**. So:

- **Browser speech-rec batches ~8 lines into one late `final`** (e.g., line 12's words arrived tagged to line 20) → stamped "now" → matched to the wrong/no phrase → the actual line scores missed despite being recognized perfectly.
- We **cannot re-time per word**: browser-SR evidence is `words: []`; the realtime Whisper's `words` is empty in practice (`whisperWordsTotal: 0` in every run).

The correct words *are in the stream* — they just land outside their line's window.

**Goal:** credit recognized words to the line they were **sung** on (by content), not the line showing when the recognizer reports them — lifting the honest %, flipping wrongly-missed lines to cleared, and repainting them green. Preserve the anti-cheese model.

---

## 2. Decision (from brainstorm)

**Content-based late-evidence reconciliation.** On each late result, match its words against recently-passed, un-cleared phrases by **content over a bounded look-back**, in spoken order. Distinctive anchor words land on their real line regardless of arrival lag. Tunable look-back + threshold. Honesty preserved (real anchor words still required). The **live arcade multiplier stays commit-once** (a late reconcile lifts the honest %/grade/line color but does not retro-rewind the live multiplier — the existing "blessed divergence"). A wrongly-missed line shows red at settle and **flips to green when its batched words arrive** (~a few seconds later).

---

## 3. The reconciliation pass (phrase engine, new)

A new function **inside `phrase-engine.js`'s factory** (so it reuses the internals `evidenceTokens`, `scoring.wordsMatchScore`, `REPEATED_FILLER`/`isAdlibWord`, `updatePhraseResult`, `session.consumedTokenIds`), exported on the module:

```
reconcileLateEvidence(session, evidence, nowSec) -> [phraseId, ...]   // phrases newly reaching 'confirmed'
```

Algorithm:
1. `tokens = evidenceTokens(evidence)` (the result's words, in spoken order). Return `[]` if none.
2. **Candidate phrases** = phrases that are **not yet cleared**, have `anchorsRequired > 0`, and whose `endSec` is within `[nowSec - RECONCILE_LOOKBACK_SEC, nowSec]` — sorted by `startSec` (spoken order). `RECONCILE_LOOKBACK_SEC = 18` (tunable; sized to browser-SR batch latency).
3. **Forward-only (monotonic) attribution.** Keep a `minIdx` pointer into the (time-ordered) candidate list, starting at 0. For each token **in spoken order** (skipping tokens already in `session.consumedTokenIds`, and generic fillers via `REPEATED_FILLER`/`isAdlibWord` except against `fillerOnly` anchors): scan candidate phrases **from `minIdx` forward** for the first un-hit anchor with `scoring.wordsMatchScore(token.word, anchor.word, anchor.phonetic).score ≥ 0.75`. Credit it (`state.anchorHits[anchorIdx] = { word, source: evidence.source + '_reconciled', evidenceId, score }`), mark the token consumed, `updatePhraseResult(session, state)`, and **advance `minIdx` to that phrase's index**.

   Monotonic advancement is the key anti-inflation guard: a batch is in spoken order and phrases are in spoken order, so a line's words stay together and a **repeated anchor word cannot be pulled back to an earlier line it wasn't sung on**. It is deliberately conservative — it would rather under-credit an out-of-order word than over-credit a repeated one (under-crediting is honest; over-crediting inflates the gated %). The look-back bound + the ≥0.75 content gate are the secondary guards.
4. Return the phrase IDs that transitioned to `cleared`/`confirmed` during this pass.

This is **separate from the live `addEvidence`** path — the live path stays tight and forward-windowed (instant feedback / live multiplier); reconciliation is the content-based catch-up that runs after it.

---

## 4. Wiring (player.js)

In `_addPhraseEvidence(evidence)`, after the existing `addEvidence` + `settlePhrases`, for the **late sources only** (`evidence.source === 'browser_final' || 'whisper'`):
- `var confirmed = KaraokeePhraseEngine.reconcileLateEvidence(this._phraseSession, evidence, nowSec)`.
- For each `phraseId` in `confirmed`: **repaint its line green** under `karaokee_v2` — green every span with that `data-phrase-id` (reusing the whole-line-green rule from `_commitNewlySettled`; extract a small `_paintPhraseCleared(phraseId)` helper used by both).
- The honest % headline and end-screen update automatically (they read `anchorHits`/`getLiveScore`).

No HTML/CSS change — reuses the existing `.matched` green.

---

## 5. Files
- **Modify `static/phrase-engine.js`** — add `RECONCILE_LOOKBACK_SEC` + `reconcileLateEvidence`; export it.
- **Modify `tests/test_phrase_engine.cjs`** — golden cases for reconciliation.
- **Modify `static/player.js`** — call `reconcileLateEvidence` in `_addPhraseEvidence` for late sources; `_paintPhraseCleared(phraseId)` helper (extract from `_commitNewlySettled`) + repaint confirmed phrases.

---

## 6. Testing

Golden tests for `reconcileLateEvidence` (build a plan/session via `buildPhrasePlan`/`createPhraseSession`, then feed late evidence):
- **Catch-up:** a settled, missed early phrase whose anchor word arrives in a much-later evidence → gets credited, phrase returned as newly confirmed, `lyricStatus === 'confirmed'`.
- **No distant cross-match:** a duplicate anchor word outside the look-back window does **not** credit the old phrase.
- **Within-look-back repeated anchor (the inflation guard — first-class test):** several un-cleared phrases in the look-back share an anchor word (e.g. "fly"); feed a batch of just *one* line's words. Assert it credits **only that line**, not every phrase holding the shared word — i.e. monotonic attribution keeps the shared word with its line and does not falsely confirm the others. This is the test that decides whether monotonic is sufficient.
- **Dedup:** a token already consumed by the live path isn't re-credited; `consumedTokenIds` respected.
- **Partial → clear:** a phrase with some anchors hit reaches `confirmed` when a late word supplies the missing anchor.
- **Cheese safety:** filler/non-matching words credit nothing.
- Regression: all existing `.cjs` + `pytest` green; `node --check` clean.
- **Manual:** re-run *Let It Fly* (debug on) — previously-missed lines flip red→green a few seconds late as their batched words arrive; honest % rises; telemetry shows `*_reconciled` sources.

---

## 7. Out of Scope / Tunables / Risks
- **Tunables:** `RECONCILE_LOOKBACK_SEC` (18) and the `0.75` match threshold — calibrate against telemetry.
- **Risk — cross-match:** a repeated anchor word could credit the wrong line; mitigated by the bounded look-back + earliest-first sequence + the ≥0.75 content gate. Telemetry's `*_reconciled` tag lets us audit it.
- **Not in scope:** spoken-time stamping via Whisper's `dispatchedLineIdx` (the other brainstorm option) — a possible later precision add; recognizer-reliability work (Whisper session flakiness) is separate.
- The live arcade multiplier intentionally does **not** retro-update on reconcile (commit-once).
