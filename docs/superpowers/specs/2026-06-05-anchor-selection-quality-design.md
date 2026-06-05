# Anchor-Selection Quality — Design

**Date:** 2026-06-05
**Status:** Design approved (brainstorming); pending implementation plan.
**Scope flag:** changes live in the phrase engine, which only drives the displayed score under `karaokee_v2` (V1 word-recall path is unaffected). The standing human sing-test gate before any `karaokee_v2` flag-flip covers these changes.
**Motivation:** telemetry analysis of real Expert runs (2026-06-05) showed the *anchor selection* layer — upstream of all the VAD/recognition work — is unfairly capping the honest score on lines the user sang correctly.

---

## 1. Problem

Two independent defects in how a line's required "key words" (anchors) are chosen, both found in `output_telemetry/2026-06-05/...19-49-14.json` (A$AP Rocky — Praise The Lord, Expert, honest 98%, 6 partial / 0 missed):

### 1A. Parenthetical adlibs become required anchors (code bug)
`classifyWord(normalizedWord, inParentheses)` ([match-helpers.js:319](../../../static/match-helpers.js)) returns `'adlib'` when `inParentheses` is true, and the design intent is explicit ([match-helpers.js:308](../../../static/match-helpers.js): "anything in parentheses … essentially never returned by speech recognizers" → weight 0). But the phrase engine's `selectAnchors` ([phrase-engine.js:84](../../../static/phrase-engine.js)) calls `classifyWord(word, false)` — **`inParentheses` hardcoded false** — and `buildPhrasePlan` ([phrase-engine.js:157](../../../static/phrase-engine.js)) feeds it `normalizedWords(line.text)`, which strips `()` ([scoring.js:351](../../../static/scoring.js)) with no paren tracking. So a parenthetical *content* word slips through as a full-weight required anchor. The V1 path (`interpolateWordTimings`, [scoring.js:401-409](../../../static/scoring.js)) already tracks parens correctly — the phrase engine just doesn't.

### 1B. One ASR-impossible word can make a line uncloseable (fairness)
`anchorsRequired = max(1, ceil(N × ratio))` ([phrase-engine.js:164](../../../static/phrase-engine.js)). When that rounds up to **all N**, a single word the recognizer never returns sinks the line even if every other anchor was sung and recognized. Concrete:
- **Line 33** `"so please believe allow the greaze"` — 4 anchors, Expert `ceil(4×0.8)=4` (all required). Hit *please, believe, allow*; **"greaze"** (rare slang) never recognized → 3/4 → partial.
- **Line 15** `"my shades dior my pants velour"` — 4 anchors, hit *shades, dior, pants*; **"velour"** unrecognizable → 3/4 → partial.

This is the "ASR coverage is the ceiling, not the threshold" finding (see [[core-loop-modernization-research]]) hitting at the anchor layer. It is a **fairness** problem (the user sang correctly), not cheese.

## 2. Goals / Non-goals

**Goals**
- 1A: parenthetical content classifies as adlib in the phrase engine → excluded from anchors.
- 1B: a line big enough to spare one anchor should not *require literally all* of them, so one ASR-impossible word can't sink a correctly-sung line.
- Preserve the cheese gate (silence/humming/"Ah" → 0 anchor hits → never clears).
- Keep pure, `.cjs`-testable functions.
- **Observability (additive):** expose per-anchor detail in phrase traces so anchor analysis — and validating these very fixes — is a direct read, not reverse-engineered from line-text-minus-hits. Backward-compatible; no schema bump.

**Non-goals (explicitly out of scope)**
- **C-precise (per-word flow-gated exemption)** — rejected. (a) Flow = "voiced sound," not "right word," so it's bypassable by humming the unknown word's slot, and the *gate* already forces genuine singing of the rest → ~zero marginal cheese-resistance. (b) The per-word window comes from `estimateSyllables` interpolation, which mistimes rap/polysyllabic words (windows 1.8–3 s) — unreliable on exactly the dense tracks where greaze/velour live. Machinery + fragile signal for no gain.
- **Merged-word LRC data** (e.g. line 11 `"chartclimbing"` = "chart climbing" with a missing space → unmatchable anchor) — a lyric-data-quality problem, separate track.
- **Repeated-word consume conflicts** (line 9 `"loaded … loaded"`) — the repeated-hook family, separate.
- **The pitch axis (Path B)** — the only thing that truly closes the ASR ceiling; this is a lyric-axis patch.

## 3. Design

### 3A. Parenthesis-aware anchor selection
Mirror the paren walk `interpolateWordTimings` already does, in the phrase-engine path:
- New pure helper `splitLyricWords(text) → [{ word, inParen }]`: split on whitespace, track `(`/`)` state across the *raw* tokens, `normalizeWord` each, drop empties. (Same logic as [scoring.js:401-409](../../../static/scoring.js), reused/extracted.)
- `buildPhrasePlan` uses it; `chunkWords` slices the object array in parallel; `chunk.words` (the string array the rest of the engine consumes) is derived via `.map(o => o.word)` so nothing downstream changes.
- `selectAnchors` receives the `{word, inParen}` objects and calls `classifyWord(word, inParen)` instead of `classifyWord(word, false)`. The existing `if (wordClass === 'adlib') continue;` then correctly excludes parenthetical content.
- **Honesty-neutral:** can only *remove* anchors that shouldn't exist; never adds or relaxes.

### 3B. Force-all relief in `anchorsRequired`
After the existing ratio computation, add a single cap:
```
anchorsRequired = max(1, ceil(N × ratio))
if (N >= 4 && anchorsRequired >= N) anchorsRequired = N - 1   // NEW: force-all relief
// (existing fast-tempo floor still applies and min()s further)
```
- **N ≥ 4 force-all → cap at N−1.** Greaze/velour lines (N=4) now need 3 → clear when the rest is sung.
- **Short lines (N = 2–3) untouched** — no collapse; you still need all of them (avoids a 2-anchor line clearing on half).
- **Lines with headroom (N ≥ 5)** already allow a drop at 0.8 — unchanged.
- **Auto-scales by difficulty for free:** force-all only occurs at high ratios, so Easy (0.20) / Medium (0.45) never trigger the cap; it bites only on Hard (0.65) / Expert (0.80) — exactly where the problem is. No new per-difficulty knob.
- **Composes with the fast-tempo floor** ([phrase-engine.js:169-171](../../../static/phrase-engine.js)): both only lower `anchorsRequired`; apply the cap first, the floor `min()`s after.
- **Clears live** (plan-time requirement) — the arcade multiplier credits fairly, no post-hoc reconciliation needed.

### Cheese-safety argument
Both changes only ever *remove* an anchor (A) or *lower a near-N requirement by one* (B). Neither credits anything. Silence / humming / "Ah" on cadence produce **zero anchor hits**, and you cannot reach a positive requirement from zero by dropping one — so the cheese probes that pass today still fail. The change strictly converts "sang all-but-one, where the one is ASR-impossible" from partial → clear.

### 3C. Observability: per-anchor trace detail (additive)
`getPhraseTrace` already holds `phrase.anchors` (each `word`/`wordClass`/`weight`) and `state.anchorHits`. Add a per-phrase array to the trace:

    anchors: [{ word, wordClass, weight, hit, bestScore }]

- `hit` = `anchorIdx` present in `anchorHits`.
- `bestScore` = best `wordsMatchScore` any candidate token reached against this anchor (0 if never meaningfully attempted). This is the **only** field needing a hot-path touch — a per-anchor running max in `addEvidence`/`candidateFor`; **drop it if not worth it** (the other four fully answer "which anchor blocked the line, and was it wrongly an adlib").
- **Purely additive — no schema bump.** Existing v2 corpus files still parse; new files just carry the extra array (debug-gated, like the other raw traces).
- **Why:** turns the by-hand analysis from this session (line-text-minus-hits to find "greaze") into a direct read, and makes validating Fix A/B at-a-glance — the array shows whether parenthetical content was correctly excluded (no `wordClass:'adlib'` anchors left in) and exactly which anchors cleared vs. blocked each line.

## 4. Module boundaries (testability)
All logic stays in pure, DOM-free, `.cjs`-tested functions in `phrase-engine.js` (+ the `splitLyricWords` helper):
- `splitLyricWords(text)` — golden tests: parens tracked across multi-word spans; nested/again; normalization.
- `selectAnchors(wordObjs, profile)` — golden tests: parenthetical content excluded; non-paren content retained.
- the `anchorsRequired` formula — golden tests: N=4 Expert → 3; N=2/3 unchanged; N=5 unchanged; Easy/Medium never capped; composition with the fast floor.
- cheese-safety unit test: 0 hits → 0 cleared regardless of the cap.
- `getPhraseTrace` per-anchor `anchors[]` — golden test: lists each anchor with correct `word`/`wordClass`/`hit`; reflects Fix A (no adlib-class anchors arising from parentheses).

## 5. Validation (the changes compound — validate together)
Fix A *reduces N* (strips phantom anchors); Fix B *reduces required-from-N*. A line at 4 anchors → 3 (A) → require 2 (B) could over-loosen, so:
1. **Automated:** all `.cjs` + pytest green, including the new golden tests above.
2. **Replay corpus (together):** re-run the 6 Praise The Lord partials + the Uproar/Vibe runs. Expect the greaze/velour-class partials to **clear**, `suspectedCheeseInflation` to stay clean, and short lines not to over-clear. Tune the exact thresholds (`N≥4`, whether to also help `N=3`) against this data + the per-line anchor counts in telemetry — not in the abstract. The new per-anchor `anchors[]` makes this a direct read (which anchors cleared/blocked, and whether parenthetical content was excluded).
3. **Live sing-test:** the standing cheese probes (silence/humming/"Ah"/finger-taps) must still score ~0; a correctly-sung greaze/velour line should now clear.

**Gate:** as with all V2 scoring changes, the human sing-test before any `karaokee_v2` flag-flip is the non-negotiable gate.

## 6. Risks
- **A+B compounding** over-loosens a short line — mitigated by the `N≥4` floor on B and the validate-together step; tune if telemetry shows it.
- **Threshold tuning** (`N≥4`) is a starting value — confirm against the 6 partials + cheese probes.
- The merged-word and repeated-word issues (§2 non-goals) will still produce occasional partials — by design, out of scope here.

## 7. Rollout
- Branch `feat/anchor-selection-quality`.
- No new flag — rides the existing `karaokee_v2` phrase-engine path; V1 unaffected.
- Sequence: pure helpers + golden tests → wire into `buildPhrasePlan`/`selectAnchors` → add per-anchor trace detail (so the validation is legible) → replay-corpus validation (A+B together) → user live sing-test → (later) part of the V2 flag-flip decision.
