# Karaokee Arcade Scoring & Gameplay — Design Spec

**Date:** 2026-06-02
**Author:** Westside Sage (+ Claude)
**Builds on:** [`2026-06-02-scoring-v2-design.md`](2026-06-02-scoring-v2-design.md) (the phrase engine this promotes)
**Status:** Approved (design). One coherent system, staged for implementation. Implementation plan to follow.

---

## 1. Context & Goal

Scoring V2 (the phrase engine, `static/phrase-engine.js`) is built and runs live in shadow mode — `getLiveScore()` returns `{lyrics, conviction, composite}` — but it is buried in a cramped `#v2-panel` behind the `V` flag (default off), and the headline `#score-pct` is still the lenient V1 word-recall ratio. Difficulty profiles (`easy/medium/hard/expert`) exist in the engine but are hardcoded to `medium` with no UI and affect only V2.

**Goal:** promote the phrase engine to *the* score, expose difficulty, and build an arcade gameplay layer on top — points, a combo multiplier, perfect-phrase bonuses, a hot-streak "On Fire" state, a letter grade, and per-song high scores — **without sacrificing the honesty** the V2 effort was built around.

**Why one spec, not two:** the moment the headline becomes *points*, that points number *is* the gameplay layer. "Promote V2 + expose difficulty" and "multipliers + hot streaks" are the same system. They are **staged** for implementation (§8), but designed as one.

---

## 2. Guiding Principle

**Points are honest base × arcade multiplier.** Base points are awarded only when the phrase engine settles a phrase as *cleared* (the singer demonstrably sang the right anchor words). No real words → no clears → no base → the multiplier never builds. The arcade layer amplifies honest play; it cannot manufacture credit from cheese. The **honest accuracy %** (lyric coverage) computes alongside as the source of truth and drives the letter grade.

---

## 3. Decisions Locked (brainstorm outcomes)

| Decision | Choice |
|---|---|
| Score model | **Points + honest %** (Rock Band hybrid): live headline is accumulating points; honest % is the truth, shown small live + on end screen |
| Difficulty role | **Stricter + bigger payout** — tunes phrase-engine strictness *and* the points economy (base scale + multiplier ceiling) |
| Combo depth | **Core + quality bonus** — multiplier ramps on consecutive clears, resets on a miss; *perfect* phrases pay a bonus and ramp faster |
| Honest % readout | **Lyric coverage only** (the engine's `lyrics` sub-score), not the composite — most intuitive "did you know the words"; conviction's spirit lives in the combo/perfect gameplay |
| HUD layout | **Floating cluster** over full-width lyrics (top-right): points · multiplier+ramp · 🔥streak; % + difficulty pill in a thin header |
| Hot-streak visual | **Bold** — active lyric line burns in a fire gradient, corner ember glow, "ON FIRE" tag; lyrics stay readable |
| End screen | **Grade hero** — big S/A/B/C/D letter grade, points, accuracy, max multiplier, longest streak, perfects; **NEW BEST** ribbon |
| Difficulty selection | **On the player, pre-song** (segmented control by the Game button); locks at song start; remembered in `localStorage` (default `medium`) |

---

## 4. Architecture & Cross-Cutting Decisions

### 4.1 New pure module — `static/scoring-arcade.js`
The combo/multiplier/perfect/streak/grade state machine lives in its own pure, CommonJS-compatible module (the established `sync-helpers` / `scoring` isolation pattern), **not** inside the already-huge `player.js` or the strictness-focused `phrase-engine.js`. It exposes a small state machine:
- `createArcadeState(difficulty)` → opaque state
- `commitPhrase(state, phraseOutcome)` → mutates state, returns `{pointsAwarded, multiplier, streak, onFire, perfect}` for the event
- `getArcadeSummary(state)` → `{points, maxMultiplier, longestStreak, perfects, ...}` for the end screen
- `gradeFor(lyricPct)` → letter grade
- `ARCADE_TUNING` — difficulty-keyed payout params (separate from the engine's strictness `DIFFICULTY`)

`phrase-engine.js` stays the strictness authority; `scoring-arcade.js` owns payout. Clean seam.

### 4.2 The judgment moment (critical — live combo vs. eventually-consistent engine)
The phrase engine is **eventually-consistent**: a late Whisper rescue can flip a phrase to `cleared` within `LATE_EVIDENCE_GRACE_MS` (1000 ms) *after* settlement, and `getLiveScore`'s lyric term counts it (that grace is deliberate — it keeps the honest % fair on laggy recognition). An arcade multiplier **cannot** be eventually-consistent: if it waited for or retro-applied late evidence, the multiplier and streak would visibly thrash.

**Rule:** the combo commits each phrase **exactly once, when the phrase first reaches `status === 'settled'`** (`endSec + difficulty.settlementMs`), reading its `cleared` / `rescuedByWhisper` / uncapped `anchorHits` state at that instant.
- Evidence arriving in the trailing grace window (settlement → settlement + grace) still updates `anchorHits` and therefore the **honest % and end-screen accuracy** — but **never retro-edits the live multiplier or points already awarded.**
- **Blessed divergence:** on laggy songs, live points may trail the honest % by a hair. Intentional. The % stays the source of truth.
- **Fairness bonus:** judging the miss at the *settled* boundary (not at phrase end) means recognizer lag cannot snap an honest streak — the rescue lands before the lock.

### 4.3 Honesty gate / feature flag
Reuse the existing `karaokee_v2` flag (`V`) for staging. During validation, **flag-off keeps the old V1 % headline** for A/B; flag-on shows the new arcade headline. The flip to "V2 is the sole headline, default on" happens only **after the human validation play-test passes** (§8) — honoring the V2 spec's non-negotiable rule that the old scorer stays default until cheese probes score low and honest-sloppy scores fair.

---

## 5. Scoring Model (detail)

All numbers below are **tunable defaults** (§10) — dialed by feel during validation, not committed as final.

**Base points (per cleared phrase, at commit):**
```
base   = BASE_PER_ANCHOR (100) × phrase.anchorsRequired × difficulty.baseScale
award  = round(base × (perfect ? 1 + PERFECT_BONUS : 1) × currentMultiplier)
```

**Multiplier ramp:** a ramp meter fills with each cleared phrase — `+1` for a bare clear, `+2` for a perfect. Reaching `RAMP_PER_TIER` (4) advances the multiplier one tier (`2× → 3× → …`) up to `difficulty.maxMultiplier`, and the meter resets. The HUD ramp bar shows progress to the next tier.

**Streak rules (evaluated at the commit / settled boundary):**
- **Cleared** (`anchorHits ≥ anchorsRequired`): award points, build ramp, `streak++`.
- **Miss** (`anchorHits == 0`): `multiplier → 1×`, ramp meter → 0, `streak → 0`.
- **Partial** (`0 < anchorHits < anchorsRequired`): **holds** — no points, no ramp, no reset. (Humane default; tunable to "resets.")

**Perfect phrase:** detected from the **uncapped** anchor-hit count (available in `getPhraseTrace().anchorsHit`; `getLiveScore` caps at `required` but the raw state does not). **Threshold pending one telemetry check** (§12): candidates are *all anchors* / *required + 1* / *≥ 80% of anchors* — chosen by measuring how often each fires on an honest good run in `tests/fixtures/telemetry-replay/`, so the multiplier economy does not silently ride on recognizer completeness.

**On Fire:** active while `multiplier === difficulty.maxMultiplier`. Drives the **bold (B)** fire treatment. Visual only by default (no extra points — keeps it honest); an optional small on-fire bonus is a tunable left off initially.

**Letter grade (end screen):** computed from the final **honest lyric-coverage %** (not points, which scale with difficulty/length): `S ≥ 95, A ≥ 85, B ≥ 72, C ≥ 58, else D`. Difficulty is shown alongside (an S on Expert is self-evidently harder); the difficulty payout reward lives in the points/high-score, not the grade.

**Difficulty payout (`ARCADE_TUNING`, separate from engine strictness):**
| | baseScale | maxMultiplier |
|---|---|---|
| easy | 1.0 | 4× |
| medium | 1.25 | 4× |
| hard | 1.5 | 6× |
| expert | 2.0 | 8× |

---

## 6. UI

- **HUD — floating cluster (C):** lyrics stay full-width and centered. A floating cluster top-right shows **points** (green), **multiplier + ramp bar** (gold), **streak 🔥**. A thin header carries the honest **%** and the **difficulty pill**.
- **On Fire — bold (B):** at max multiplier, the active lyric line renders in a fire gradient, a soft ember glow enters from the corner, and an "ON FIRE" tag appears on the cluster. Reverts on streak reset.
- **End screen — grade hero (A):** replaces the current modal. Big letter grade, points total, then accuracy / max combo / longest streak / perfects; **NEW BEST** ribbon when the run beats the stored high score. Keeps the existing benchmark-feedback `<select>`s (telemetry).
- **High scores:** persisted in `localStorage`, keyed by **song + difficulty** (`hiscore_<songKey>_<difficulty>`). This is what makes a run worth replaying.
- **Difficulty selector:** a segmented `easy/medium/hard/expert` control on the player (near the Game button), pre-song, persisted (default `medium`), feeding `buildPhrasePlan` and `createArcadeState`. Locked once a run starts.

---

## 7. Data Flow & File Touchpoints

- **`static/scoring-arcade.js`** *(new)* — pure state machine + `ARCADE_TUNING` + `gradeFor`. Imported in browser (`<script>`) and `require`d in tests.
- **`static/phrase-engine.js`** — minimal: ensure the per-phrase settled transition and uncapped `anchorHits` / `rescuedByWhisper` are readable at commit time (they already are via `getPhraseTrace`). No scoring logic added here.
- **`static/player.js`** —
  - On the render/settle loop, detect phrases newly reaching `settled` and call `commitPhrase`; route the returned event to the HUD (points tick, multiplier, ramp, streak, On Fire).
  - Render the floating cluster + On Fire state; drive the difficulty segmented control (persist, feed plan + arcade state).
  - Rework the end modal from `getArcadeSummary` + honest % + `gradeFor`; read/write high scores; show NEW BEST.
  - Behind `karaokee_v2`: arcade headline when on, legacy V1 % when off (validation A/B), until the flip.
- **`static/player.html`** — floating-cluster markup, difficulty control, fire/cluster/grade CSS, redesigned end modal; retire `#score-display`/`#v2-panel` into the new HUD; add the `<script src="/static/scoring-arcade.js">` include.
- **`tests/test_scoring_arcade.cjs`** *(new)* — golden tests via the `loadBrowserCommonJs` shim.

---

## 8. Staging & Validation Gate

1. **Stage 1 — Promote + difficulty + honest %.** Phrase engine drives the headline (honest lyric-coverage %) and the difficulty selector goes live; old V1 % remains viewable behind the flag for A/B. *No points yet* — just make V2 legible and selectable.
2. **Validation play-test (human, gating, ~15 min):** the teardown §6 protocol — hum / silence-on-speakers / mumble / common-word loop must **not** build credit; honest on-beat / off-beat / quiet / sloppy-rap must score **fair**; clean-vs-sloppy separates. Run with the dual display + telemetry export.
3. **Stage 2 — Combo juice.** Points, multiplier ramp, perfect bonus (after the §12 threshold check), streak, HUD cluster, On Fire.
4. **Stage 3 — Payoff.** End screen, letter grade, high scores / NEW BEST.
5. **Flip:** `karaokee_v2` → default on, arcade headline becomes the sole score, V1 retired (kept in debug only) — **only after step 2 passes.**

Each stage: all `.cjs` + `pytest` suites green, `node --check` clean on edited JS.

---

## 9. Testing

- **Automated:** every new pure function in `scoring-arcade.js` gets golden `.cjs` cases — multiplier ramp cadence, perfect double-fill, miss-reset vs. partial-hold, difficulty payout scaling, grade thresholds, monotonicity (expert run > easy run for identical phrase outcomes), commit-once semantics. Telemetry-replay measures aggregate deltas (regression tool, not an accuracy proof).
- **Human (gating):** §8 step 2. *No feel improvement is declared validated by automated tests* — the carried-over honesty constraint from the V2 spec.

---

## 10. Defaults & Tunables

| Knob | Default | Notes |
|---|---|---|
| `BASE_PER_ANCHOR` | 100 | base points per required anchor |
| `baseScale` | easy 1.0 / med 1.25 / hard 1.5 / expert 2.0 | difficulty payout |
| `maxMultiplier` | easy 4 / med 4 / hard 6 / expert 8 | difficulty ceiling |
| `RAMP_PER_TIER` | 4 clears | perfect fills ×2 |
| `PERFECT_BONUS` | +50% | applied to base |
| perfect threshold | **TBD** (all / required+1 / ≥80%) | §12 telemetry check |
| streak on partial | hold (no build, no reset) | tunable → reset |
| combo lock boundary | `endSec + settlementMs` (`status==='settled'`) | §4.2 |
| On Fire trigger | `multiplier === maxMultiplier` | visual only |
| grade cutoffs (honest %) | S 95 / A 85 / B 72 / C 58 / D | off lyric coverage |

---

## 11. Out of Scope

- Pitch / rhythm / onset sub-scores (teardown Stages 4–5) — research-tier, separate projects.
- Overdrive / Star-Power energy meter and named streak tiers — deferred fast-follow (the "deep/strategic" combo option), not the first cut.
- Auto-difficulty from song tempo — a later refinement; difficulty stays manual.
- Online leaderboards / accounts — high scores are local (`localStorage`) only.
- Any rewrite of capture transport, lyrics, search, or transcription.

## 12. Open Items

- **Perfect-phrase threshold** — resolve *before Stage 2* by measuring all / required+1 / ≥80%-of-anchors fire rates on honest runs in `tests/fixtures/telemetry-replay/`. Pick the definition the recognizer reliably delivers on good singing.

## 13. References

- Phrase engine + honesty constraint: [`2026-06-02-scoring-v2-design.md`](2026-06-02-scoring-v2-design.md)
- Teardown / cheese + fairness human-test protocol: [`../../audits/2026-06-02-voice-detection-scoring-teardown.md`](../../audits/2026-06-02-voice-detection-scoring-teardown.md)
- Core: `static/phrase-engine.js`, `static/scoring.js`, `static/match-helpers.js`, `static/player.js`, `static/player.html`
