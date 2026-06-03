# Telemetry v2 — Analysis-Ready, Auto-Saved Session Logs — Design Spec

**Date:** 2026-06-03
**Author:** Westside Sage (+ Claude)
**Status:** Approved (design).

---

## 1. Context & Goal

Karaokee already writes rich per-session telemetry (client-side `this._telemetry` in `static/player.js`): `asr[]`, `matches[]`, `promotions[]`, `transitions[]` (with per-line sync drift), Whisper counters, `finalWordSourceCounts`, and `phraseEngine.traces` + `benchmark` labels. But it has three gaps:

1. **No final scores** — neither the V1 word-recall %, the honest lyric-coverage %, nor any arcade outcome (points, grade, multiplier, streak, perfects) is recorded.
2. **No arcade data at all** — the schema predates the arcade scoring/HUD work; per-phrase commit outcomes and the multiplier progression are absent.
3. **Download-only + manual filing** — there is no server endpoint; runs are captured only when the user presses `D` and downloads, then hand-files the JSON into `output_telemetry/<date>/<session>/`. Stale `meta` (`phraseEngine.mode:'shadow'`, `gameVersion:'1.0'`, no flag state) compounds the noise.

**Goal:** make each run's telemetry **analysis-ready** (final scores + an arcade event log + a scannable summary, including a cheese/honesty correlation) and **auto-saved server-side**, without bloating routine files or risking the game loop. The data should let an engineer (human or AI) judge a run's scoring honesty, scoring economy, recognizer attribution, and sync accuracy at a glance, and drill into raw events when needed.

---

## 2. Decisions Locked (brainstorm outcomes)

| Decision | Choice |
|---|---|
| Capture model | **Auto-save every finished run** via a new `POST /telemetry` endpoint → `output_telemetry/<YYYY-MM-DD>/`. Capture no longer depends on pressing `D`. |
| File weight | **Lean by default** — auto-saved payload carries the analysis layer + per-line `transitions`; the heavy per-word arrays (`asr[]`, `matches[]`, `promotions[]`) are included **only when debug (`D`) is on**. |
| Schema evolution | **Additive** — bump `meta.schemaVersion` to `2`, add two top-level blocks (`summary`, `arcade`); do **not** restructure existing fields (70 historical v1 files must still parse). |
| Derivation logic | **New pure module `static/telemetry-helpers.js`** with `summarizeRun(inputs)` — `require`-able, golden `.cjs` tested, matching the `sync-helpers`/`scoring-arcade` isolation pattern. Keeps derivation out of the already-large `player.js`. |
| Honesty signal | Bake a `summary.honesty` block correlating `benchmark.intent` cheese labels against whether the arcade built credit — automating the core of the validation sing-test across every run. |
| Manual download | Keep the `D`-HUD download button; it serializes the same payload via the shared builder. |

---

## 3. Schema (v2)

### 3.1 `meta` — cleaned + new fields
Existing fields stay. Add / correct:
- `schemaVersion: 2` (NEW — lets analysis distinguish v1 vs v2 files).
- `karaokeeV2: <bool>` (the `window.KARAOKEE_V2` flag state at run end).
- `endedAt: <ISO string>`, `endReason: 'song_ended' | 'stopped'`, `completed: <bool>` (did playback reach the end).
- Correct `phraseEngine.mode` (`'shadow'` → `'headline'` when V2 on, else `'shadow'`) and `gameVersion` (→ `'2.0'`).

### 3.2 `summary` — the scannable run digest (NEW, always included)
```jsonc
"summary": {
  "difficulty": "hard",
  "karaokeeV2": true,
  "scores":   { "v1Pct": 61, "honestLyricPct": 68, "composite": 72 },
  "arcade":   { "points": 8400, "grade": "B", "maxMultiplier": 6, "longestStreak": 9, "perfects": 4, "clears": 17 },
  "phraseOutcomes": { "cleared": 17, "partial": 5, "missed": 8, "total": 30 },
  "recognizer":     { "clearsBySource": { "whisper": 12, "browser_sr": 5, "vad": 0 }, "finalWordSourceCounts": { … } },
  "sync":     { "medianLineDriftMs": 120, "linesEarly": 6, "linesLate": 18 },
  "honesty":  { "benchmarkIntent": "humming_cheese", "pointsBuilt": false, "maxMultiplier": 1, "suspectedCheeseInflation": false },
  "counts":   { "asr": 0, "matches": 0, "promotions": 0, "transitions": 30, "arcadeEvents": 30 }
}
```
Field derivation (pinned in tests):
- `scores` — `v1Pct` = `round(weightedMatched/weightedTotal*100)`; `honestLyricPct` = `round(getLiveScore().lyrics*100)`; `composite` = `round(getLiveScore().composite*100)`.
- `arcade` — straight from `getArcadeSummary` + `gradeFor(honestLyricPct)`.
- `phraseOutcomes` — tally `phraseTraces` by `lyricStatus` (`confirmed`→cleared, `partial`→partial, `missing`→missed); `total` = trace count.
- `recognizer.clearsBySource` — for each **cleared** phrase trace, attribute it to the **dominant source** among its `anchorHits` (ties → `whisper > browser_sr > vad`); tally. `finalWordSourceCounts` passed through from `meta`.
- `sync` — `medianLineDriftMs` = median of `|earlyMs|`/`lateMs` over transitions; `linesEarly`/`linesLate` = counts.
- `honesty` — `benchmarkIntent` from the `benchmark` label; `pointsBuilt` = `arcade.points > 0`; `maxMultiplier` from arcade; `suspectedCheeseInflation` = `intent ∈ CHEESE_INTENTS` **and** (`pointsBuilt` **or** `maxMultiplier > 1`). `CHEESE_INTENTS = {humming_cheese, silent_section_test}` (extendable).
- `counts` — array lengths (0 for raw arrays when debug off; `arcadeEvents`/`transitions` always real).

### 3.3 `arcade` — detailed arcade trace (NEW, always included)
```jsonc
"arcade": {
  "tuning": { "baseScale": 1.5, "maxMultiplier": 6 },
  "events": [
    { "phraseId":"p0", "lineIdx":0, "settledAtSec":6.2, "outcome":"clear", "perfect":false,
      "anchorsRequired":2, "anchorsTotal":4, "anchorsHit":3, "pointsAwarded":300,
      "multiplierAfter":1, "streakAfter":1, "onFire":false }
  ],
  "highScore": { "key": "hiscore_Artist::Title_hard", "previous": 7100, "isNewBest": true }
}
```
- `events[]` — one entry per `commitPhrase`, recorded live in `_commitNewlySettled` (the commit-once path), with `settledAtSec` = `audio.currentTime` at commit. Empty if V2 was off for the run (no arcade state) — captured as `[]`.
- `highScore` — the key, the previous stored value, and whether this run set a new best (computed in `showEndModal`).

### 3.4 Debug-gated heavy data
`asr[]`, `matches[]`, `promotions[]`, and `phraseEngine.traces` — included **only when `window._kDebug`** is true (traces carry bounded-but-bulky per-phrase evidence). Otherwise omitted from the payload (`counts` reports 0 for the arrays). The `summary` block's trace-derived fields (`phraseOutcomes`, `recognizer.clearsBySource`) are computed **client-side at build time** from the in-memory traces, so lean files keep the derived view without the raw traces. `transitions[]` is **always** included (per-line, small, high analytical value for sync).

---

## 4. Architecture & Files

### 4.1 New pure module — `static/telemetry-helpers.js`
UMD module (`module.exports` / `root.KaraokeeTelemetry`), no DOM. Exposes:
- `summarizeRun(inputs)` → the `summary` block (§3.2). `inputs` = `{ difficulty, karaokeeV2, scores, arcadeSummary, grade, phraseTraces, arcadeEvents, transitions, finalWordSourceCounts, benchmarkIntent, counts }`. Pure: callers pass already-read live values; the module only derives (`phraseOutcomes`, `clearsBySource`, `sync`, `honesty`).
- `CHEESE_INTENTS` — the set used by the honesty check.
- `median(nums)` — small helper (exported for testing).

### 4.2 `static/player.js`
- **Record arcade events:** in `_commitNewlySettled`, push each `commitPhrase` event (+ `settledAtSec`, `lineIdx`) into a new `this._arcadeEvents = []` (reset in `_resetSessionCounters`/`start`).
- **`_buildTelemetryPayload(endReason)`** — assembles meta (with new fields) + `arcade` block + calls `KaraokeeTelemetry.summarizeRun(...)` for `summary` + `phraseEngine` (traces/plan/benchmark, mode corrected) + `transitions`; includes `asr`/`matches`/`promotions` only if `_kDebug`. Reuses the existing Whisper-counter/`finalWordSourceCounts` assembly currently inline in `_downloadTelemetry`.
- **`_finalizeTelemetry(endReason)`** — builds the payload and `fetch('/telemetry', {POST, json})`; logs failure but never throws into the game loop. Called from the song-`ended` handler **and** from `stop()` (so manual stops are captured) — guarded so a single run finalizes **once** (`this._telemetryFinalized` flag).
- **Refactor `_downloadTelemetry`** to call `_buildTelemetryPayload('manual')` for the browser download (shared builder; no duplicated assembly).

### 4.3 `app.py`
- **`POST /telemetry`** — accept JSON body (cap at e.g. 8 MB), derive the date folder from `meta.startedAt` (fallback server date), sanitize to `output_telemetry/<YYYY-MM-DD>/karaokee-telemetry-<ts>.json`, write, return `{ok, path}`. Reject non-JSON / oversized with 400/413. Never touches the Whisper path.

### 4.4 `CLAUDE.md`
- Correct the Telemetry note: it is now auto-saved server-side via `POST /telemetry` to `output_telemetry/<date>/`, lean-by-default with raw arrays behind `D`, schema v2 with `summary`/`arcade` blocks.

---

## 5. Testing

- **`tests/test_telemetry_helpers.cjs`** (NEW, golden): `summarizeRun` outcome tallies; `clearsBySource` dominant-source + tie-break; `sync` median/early/late; **honesty** — a `humming_cheese` intent with points>0 ⇒ `suspectedCheeseInflation: true`; a `good_expert_run` with points ⇒ `false`; an honest run with 0 points and intent cheese ⇒ `false`; `median` even/odd/empty.
- **`tests/test_app.py`** — a pytest for `POST /telemetry`: valid payload writes a file under `output_telemetry/<date>/` and returns its path; oversized/non-JSON rejected. Use a temp/cleanup pattern so the suite doesn't litter real telemetry.
- **Regression:** all existing `.cjs` + `pytest` suites stay green; `node --check` clean on edited JS.
- **Manual:** one real run (V2 on) auto-saves a v2 file; inspect that `summary.scores`/`arcade.events`/`honesty` populate; a cheese run (humming) shows `pointsBuilt:false`, `maxMultiplier:1`.

---

## 6. Out of Scope (YAGNI)
- No analysis dashboard / visualization / charts.
- No database; no cross-file aggregation or trend reports.
- No auth / remote upload — local `output_telemetry/` only.
- No change to the scoring/sync algorithms themselves — this is observability only.
- No backfill of historical v1 files to the v2 schema.

## 7. Open Items
- `CHEESE_INTENTS` starts as `{humming_cheese, silent_section_test}`; widen if new benchmark intent labels are added.
- File-size cap (8 MB) is a guess; revisit if a long debug run with full raw arrays exceeds it.
