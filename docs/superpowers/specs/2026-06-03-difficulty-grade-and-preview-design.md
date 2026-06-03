# Difficulty-Aware Grade Curve + Difficulty Preview — Design Spec

**Date:** 2026-06-03
**Author:** Westside Sage (+ Claude)
**Builds on:** [`2026-06-02-arcade-scoring-gameplay-design.md`](2026-06-02-arcade-scoring-gameplay-design.md) (amends the §5 grade model + §6 difficulty UI)
**Status:** Approved (design).

---

## 1. Context & Goal

Play-test feedback: a competent singer should *ace Easy near-automatically* (the Guitar Hero model — Easy has few, slow notes), with the bar to "100%" rising through Medium → Hard → Expert. A real Easy run of "Travis Scott — COFFEE BEAN" scored **honest 93% → grade A**, with all 5 missed lines caused by the **recognizer dropping the single required content word** (rare/slurred words like "foreclose", "torso"), not by singing. Easy already requires only ~1 word per line — it is at the floor — so the ASR, not the threshold, is the ceiling on raw coverage.

**Decision (locked in brainstorm):** keep the honest lyric-coverage % as the source of truth (anti-cheese gate untouched), and make the **letter grade scale with difficulty** so acing Easy is near-automatic while Expert stays demanding. Separately, **visually show what each difficulty asks for** on the difficulty gate.

**Goal:** (1) difficulty-aware grade cutoffs; (2) a per-difficulty "what you must hit" preview on the gate. Observability/feel only — no change to the phrase engine's matching or the honesty model.

---

## 2. Decisions Locked

| Decision | Choice |
|---|---|
| Honest % | **Unchanged** — stays the live headline + end-screen accuracy; remains the source of truth and the anti-cheese signal. |
| Grade | **Difficulty-aware cutoffs** — same coverage earns a higher grade on Easy than Expert. `gradeFor(pct)` → `gradeFor(pct, difficulty)`. |
| End-screen reading | GH-style **"{honest %} · Grade {letter}"** (notes-hit % + star rating). |
| Difficulty preview | A live, per-difficulty preview built from the **actual song** on the gate: the line's key (anchor) words highlighted, with the `anchorsRequired` heaviest shown as bright "targets," and a caption stating the rule (words needed + timing window). |
| Cutoffs / preview targets | **Tunable constants**, dialed by feel. |

---

## 3. Part 1 — Difficulty-aware grade curve

`static/scoring-arcade.js`: replace the single cutoff ladder in `gradeFor` with a per-difficulty table; add a `difficulty` arg (defaults to `medium` when omitted, preserving callers/tests).

```js
var GRADE_CUTOFFS = {
    easy:   { S: 80, A: 64, B: 48, C: 32 },
    medium: { S: 87, A: 73, B: 59, C: 45 },
    hard:   { S: 92, A: 81, B: 69, C: 56 },
    expert: { S: 96, A: 88, B: 77, C: 64 }
};
// gradeFor(pct, difficulty): cutoffs = GRADE_CUTOFFS[difficulty] || GRADE_CUTOFFS.medium;
//   pct >= S -> 'S'; >= A -> 'A'; >= B -> 'B'; >= C -> 'C'; else 'D'
```

Effects: **93% → S on Easy** (was A), **A on Expert**. Monotonic — for a fixed coverage, the grade never improves as difficulty rises. **Tunable starting values.**

**Call sites (pass difficulty):**
- `player.js` `showEndModal` — `KaraokeeArcade.gradeFor(pct, this._phraseDifficulty)`.
- `player.js` `_buildTelemetryPayload` — `KaraokeeArcade.gradeFor(honestLyricPct, difficulty)` (so telemetry's `summary.arcade.grade` is curved too).

Out of scope for Part 1: points/multiplier (already difficulty-scaled via `ARCADE_TUNING`), the honest %, the headline display.

---

## 4. Part 2 — Difficulty preview on the gate

The phrase engine selects the **same anchor (key) words regardless of difficulty**; only `anchorsRequired` (≈ `ratio × anchorCount`, ratio 0.20 → 0.80 Easy→Expert) changes. The preview makes that concrete.

**Behavior:**
- On the difficulty gate, below the cards, a **preview line** drawn from the loaded song: pick a representative phrase (first phrase with ≥4 words and ≥2 anchors; fall back to the longest phrase) via `KaraokeePhraseEngine.buildPhrasePlan(lyrics, {difficulty, audioDuration})`.
- Render the phrase's words: the **top `anchorsRequired` anchors by weight** render as **bright "target" notes**; the remaining anchors as **dim "also-counts"**; non-anchor (function/filler) words **faint**.
- **Caption:** `"{DIFFICULTY} — clear each line by hitting ~{anchorsRequired} of its {anchorCount} key words · ±{timingToleranceMs/1000}s timing"`.
- **Interaction:** hovering/focusing a difficulty card (and the persisted default on load) swaps the preview + caption to that difficulty, recomputing the plan. The bright-target count visibly grows Easy → Expert (the GH "more notes" feel), honestly reflecting `anchorsRequired`.
- **Honesty note (caption/help):** the bright words are *suggested targets* (the heaviest, most-recognizable anchors); the engine accepts **any** `anchorsRequired` of the highlighted words — the preview illustrates the count, not a fixed word set.
- **No-lyrics fallback:** if `lyrics` is empty, hide the preview (the gate already routes no-lyrics songs to "Just listen").

**Files:** `player.html` (preview markup under `#diffGateCards` + CSS for target/also/faint word states); `player.js` (`renderDifficultyPreview(difficulty)`, wired to the gate card hover/focus + initial paint; reuses `_markSelectedCard`'s difficulty source).

---

## 5. Testing

- **`tests/test_scoring_arcade.cjs`** — update the `gradeFor` block to the new `medium`-default cutoffs; add per-difficulty cases: `gradeFor(93,'easy')==='S'`, `gradeFor(93,'expert')==='A'`, `gradeFor(80,'easy')==='S'`, `gradeFor(79,'easy')==='A'`, `gradeFor(96,'expert')==='S'`, `gradeFor(95,'expert')==='A'`; and a monotonicity check (grade rank for a fixed pct is `easy ≥ medium ≥ hard ≥ expert`).
- **Regression:** all `.cjs` + `pytest` suites green; `node --check` clean on edited JS.
- **Manual:** re-run an Easy song → end screen shows the honest % with **Grade S** (was A); the gate preview highlights ~1 bright target on Easy and most of the line on Expert, caption updating per card.

---

## 6. Out of Scope (YAGNI)
- No change to anchor *selection*, matching, timing, or the honest % computation.
- No curving of the displayed % (only the grade curves — the % stays literally honest).
- No animated/Guitar-Hero-lane scrolling preview; a static highlighted line is enough.
- No new difficulty levels or auto-difficulty.

## 7. Open Items
- Grade cutoffs and the "bright target = top-N-by-weight" choice are tunable; calibrate against a few runs per difficulty.
