# Retire V1 Scoring (single arcade/V2 path, no `V` toggle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy V1 scoring path and the `V` toggle so the app has one scoring stack (arcade / phrase-engine "V2"), which is already the validated default.

**Architecture:** This is a **deletion-and-flatten** refactor, not a behavior change. V2 has been the live, validated path since ADR-0003; V1 is the dormant A/B alternative behind `window.KARAOKEE_V2` (default ON, press `V` to flip). We delete the V1-only code and flatten every `KARAOKEE_V2` fork to its V2 side. The V2 scoring logic is **untouched** — the golden suites (`test_scoring_session.cjs`, `test_phrase_engine.cjs`, `test_scoring.cjs`, `test_telemetry_replay.cjs`) are the characterization net proving V2 is unchanged.

**Tech Stack:** Plain browser JS (UMD helpers + DOM-bound `player.js`), Node `.cjs` golden tests, Flask dev harness + `pytest`.

**Why now / context:** Launch features shipped (interstitial, BYO-key mint, share-image) and the neural-VAD toggle bug surfaced *because* of this toggle (a browser stuck on V1 read as "neural VAD broken"). The toggle is a footgun for a shipped demo. Decided 2026-06-08; see the conversation that produced this plan and [[deployment-pivot]] memory.

---

## ⚠️ Standing gate (non-negotiable)

Per the project's scoring rule, **any change to the scoring path requires a human sing-test before merge.** This refactor only *deletes the V1 alternative* (V2 untouched), but the gate still applies. **The final task is a hand-off, not a merge.** Do NOT merge `refactor/retire-v1-scoring` to `main` until the user confirms a sing-test:
- An honest run scores ~the same honest % / grade as before, greens/ambers/reds paint correctly.
- Cheese (silence / humming / "yeah yeah" / headphones-to-mic) still scores ~0 and does not lift the multiplier.

## Keep vs. remove (read before starting)

**KEEP — untouched (shared infrastructure, used by V2):**
- `static/scoring.js` (`computeLineScore`, matching primitives) + `tests/test_scoring.cjs` — called by `scoring-session.js:818`, so shared.
- `static/phrase-engine.js`, `static/scoring-arcade.js`, `static/lyric-paint-helpers.js`, `static/commit-helpers.js`, `static/sync-helpers.js`, `static/match-helpers.js`.
- `static/vad-helpers.js` `createVadState`/`updateVad`/`calibrate` (the live adaptive RMS fallback) — but REMOVE `neuralVadToggleAction` (Task 2).
- `tests/test_telemetry_replay.cjs` + `tests/fixtures/telemetry-replay/minimal-session.json` — exercise the shared `computeLineScore` layer, not V1 specifically.
- The **`D` debug HUD** (`_renderDebugHud`, the `d`/`D` keybinding) — a separate dev tool, NOT part of V1. Leave it.

**REMOVE — V1-only:**
- The `V` keybinding + `window.KARAOKEE_V2` global + the `karaokee_v2` localStorage flag.
- `player.js`: `_updateWordSpans` (legacy live coloring), `_scoreLine` (legacy line-red), `_computeLineWeightedMatched` + the `weightedMatched`/`weightedTotal`/`matchedWords`/`perfectLines` accumulators, the legacy headline updater (the method that early-returns under V2, ~`player.js:1313`), `_renderV2Panel` (the A/B dual-display panel), the legacy end-screen branch (the `else` of `useArcade` in `showEndModal`).
- The neural-VAD **toggle** plumbing added for the toggle: `_syncNeuralVad` (`player.js`), `neuralVadToggleAction` (`vad-helpers.js`) + its `tests/test_vad_helpers.cjs` cases. (KEEP the `_startNeuralVad` double-init guard + `vadInitError` cleanup — still good hygiene.)
- `static/player.html`: the legacy end-screen DOM (`#legacyEnd` and its `#modalScore`/`#modalWords`/`#modalLines`/`#modalStreak`).
- Telemetry V1 fields: `scores.v1Pct` and the V1/V2 `mode: 'headline'|'shadow'` shadow comparison.

**SIMPLIFY — flatten always-true gates (V2 behavior preserved):**
- `static/scoring-session.js`: 5 `if (s.flags.KARAOKEE_V2)` forks (~lines 290, 727, 731, 949, 953) → unconditional; drop the `flags.KARAOKEE_V2` input.
- `static/player.js`: ~25 `window.KARAOKEE_V2` reads → keep the V2 side, delete the V1 side.
- `static/telemetry-helpers.js`: `summarizeRun` drops `v1Pct`; `karaokeeV2` becomes implicit.

**Transformation patterns** (apply consistently):
- `if (window.KARAOKEE_V2 && X) { …V2… }` → `if (X) { …V2… }`
- `if (!window.KARAOKEE_V2) return;` (guard on a V2-only method) → delete the guard line.
- `if (!window.KARAOKEE_V2) { …V1… }` / `if (window.KARAOKEE_V2) {…V2…} else {…V1…}` → keep only the V2 side; delete the V1 branch and any method it solely called.
- `if (window.KARAOKEE_V2) return;` at the top of a V1-only method → that whole method is dead; delete the method + its call sites.

---

## Task 0: Branch + green baseline

**Files:** none (git + verification only)

- [ ] **Step 1: Branch off main.**
```bash
git checkout main && git checkout -b refactor/retire-v1-scoring
```

- [ ] **Step 2: Capture the green baseline** (every suite must be green before and after).
```bash
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 && echo "ok $f" || echo "FAIL $f"; done
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```
Expected: all `.cjs` ok (23 suites), `55 passed`. If anything is red, STOP — fix the baseline first.

- [ ] **Step 3: Record the current honest behavior for the sing-test diff.** Note (from a recent telemetry JSON, e.g. `output_telemetry/2026-06-08/…`) the honest % + grade of a known song so Task 8's sing-test has a before/after reference.

---

## Task 1: Flatten the V1/V2 forks in `scoring-session.js` (highest-risk first)

**Files:**
- Modify: `static/scoring-session.js` (forks ~290, 727–733, 949, 953; the `flags` input in `createSession`)
- Test: `tests/test_scoring_session.cjs`

- [ ] **Step 1: Read the 5 fork sites + `createSession`'s `flags` handling.** Confirm each `if (s.flags.KARAOKEE_V2)` body is the V2 behavior (emit `phraseCleared` / `honestPct` / `arcade` / settle-coloring). There is no V1 `else` in these — V1 simply *didn't* emit them.

- [ ] **Step 2: Update the test contract FIRST (red).** In `tests/test_scoring_session.cjs`:
  - Delete the "no honestPct when KARAOKEE_V2 off" test (~lines 531–542).
  - Remove `flags: { KARAOKEE_V2: true }` / `flags: { KARAOKEE_V2: false }` from every session-input object (~lines 67, 80, 116, 313, 537, 744). If `createSession` still requires a `flags` arg, pass `{}` or drop the arg per Step 3's signature.

- [ ] **Step 3: Run the test to see it fail** (it references the now-changed contract).
```bash
node tests/test_scoring_session.cjs
```
Expected: FAIL (the removed/edited cases, or the unconditional `honestPct` now emitted where the old false-case expected none).

- [ ] **Step 4: Make the forks unconditional + drop the flag.** In `static/scoring-session.js`: remove the `if (s.flags.KARAOKEE_V2)` wrapper from all 5 sites (keep the bodies). Remove `flags`/`KARAOKEE_V2` from `createSession` (stop reading `s.flags.KARAOKEE_V2`). If `s.flags` held only `KARAOKEE_V2`, remove the `flags` field entirely.

- [ ] **Step 5: Run the test to verify green.**
```bash
node tests/test_scoring_session.cjs
```
Expected: PASS. Also run `node tests/test_phrase_engine.cjs` and `node tests/test_scoring_arcade.cjs` (PASS — unaffected).

- [ ] **Step 6: Commit.**
```bash
git add static/scoring-session.js tests/test_scoring_session.cjs
git commit -m "refactor(scoring-session): drop the KARAOKEE_V2 flag; V2 behavior is unconditional"
```

---

## Task 2: Remove the `V` toggle + neural-VAD toggle plumbing (`player.js`, `vad-helpers.js`)

**Files:**
- Modify: `static/player.js` (flag init ~2207; `V` handler ~2219–2225; `_syncNeuralVad`; `_startNeuralVad` ~646; the `flags:` passed to `createSession` ~200)
- Modify: `static/vad-helpers.js` (`neuralVadToggleAction`)
- Test: `tests/test_vad_helpers.cjs`

- [ ] **Step 1: Remove the `neuralVadToggleAction` tests (red→absent).** In `tests/test_vad_helpers.cjs`: delete the `var neuralVadToggleAction = …` extraction and the `testNeuralVadToggleAction` block + its call. Run `node tests/test_vad_helpers.cjs` → PASS (the remaining VAD-gate tests are unaffected).

- [ ] **Step 2: Remove `neuralVadToggleAction` from `static/vad-helpers.js`** (the function + its entry in `module.exports`). Run the test again → PASS.

- [ ] **Step 3: In `static/player.js`, delete the `V` keybinding** (~2219–2225: the `else if (e.key === 'v' || e.key === 'V')` block, including the `_renderV2Panel`/`_syncNeuralVad` calls). Leave the `d`/`D` debug block intact.

- [ ] **Step 4: Force V2 always.** Replace the flag init (~2207 `window.KARAOKEE_V2 = (localStorage.getItem('karaokee_v2') !== '0');`) — plan is to remove the global entirely as gates are flattened (Tasks 3–6). For this task, set it to a constant `true` so the app runs while later tasks flatten the reads:
```js
window.KARAOKEE_V2 = true; // V1 retired — single scoring path (flattened away in later tasks)
```
Update the `createSession` call (~200): drop `flags: { KARAOKEE_V2: … }` to match Task 1's signature.

- [ ] **Step 5: Delete `_syncNeuralVad`** (the method) and any remaining call site. In `_startNeuralVad`, remove the `if (!window.KARAOKEE_V2) { this._vadInitError = 'v2 disabled at init'; return; }` line (~646) — it's unreachable now. KEEP the double-init guard (`if (this._neuralVadActive || this._micVad) return;`) and the `this._vadInitError = null` success-clear.

- [ ] **Step 6: Syntax + suite.**
```bash
node --check static/player.js && echo OK
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
```
Expected: `OK`, no FAIL lines.

- [ ] **Step 7: Commit.**
```bash
git add static/player.js static/vad-helpers.js tests/test_vad_helpers.cjs
git commit -m "refactor(player): remove the V toggle + neural-VAD toggle re-sync (single path)"
```

---

## Task 3: Remove V1 live coloring + flatten the paint gates (`player.js`)

**Files:** Modify `static/player.js` (`_updateWordSpans`, `_scoreLine`, coloring gates ~1027, 1070, 1081, 1093, 1111)

- [ ] **Step 1: Read the coloring call sites.** Map where `_updateWordSpans` and `_scoreLine` are called and which gates select V1 vs the V2 anchor-paint (`_paintAnchorSpansLive`, `_paintPhrasePartial`, `_paintPhraseCleared`).

- [ ] **Step 2: Flatten + delete.**
  - `~1027` (`if (window.KARAOKEE_V2) { this._paintAnchorSpansLive(lineEl); return; }`): make the V2 paint unconditional; delete the V1 coloring that followed.
  - `~1070/1081/1093` (`if (!window.KARAOKEE_V2) return;` on V2 paint helpers): delete the guard lines.
  - `~1111` (`if (!window.KARAOKEE_V2) { …V1… }`): delete the V1 branch.
  - Delete `_updateWordSpans` and `_scoreLine` (V1-only) and their now-dead call sites.

- [ ] **Step 3: Syntax + suite + commit.**
```bash
node --check static/player.js && echo OK
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
git add static/player.js && git commit -m "refactor(player): remove legacy V1 word coloring; V2 anchor paint is the only path"
```
Expected: `OK`, no FAIL.

---

## Task 4: Remove the V1 headline + the A/B dual-display panel (`player.js`)

**Files:** Modify `static/player.js` (`_computeLineWeightedMatched`, `weightedMatched`/`weightedTotal`/`matchedWords`/`perfectLines`, the legacy headline updater ~1313, `_renderV2Panel` ~1328)

- [ ] **Step 1: Delete `_renderV2Panel`** (the A/B panel) and its call sites (it was called from the old `V` handler — now gone — and possibly on render). Remove the `~1328` `if (!window.KARAOKEE_V2 || …) return;` guard along with the method.

- [ ] **Step 2: Delete the legacy headline updater** (the method at ~1313 that does `if (window.KARAOKEE_V2) return;` then writes the V1 `#score-pct`). Under V2 the honest % headline is owned by `_tickArcade`/`honestPct`, so this method is dead. Remove it + its call site (likely in the `updateLyrics`/tick loop).

- [ ] **Step 3: Delete `_computeLineWeightedMatched`** and the instance accumulators it feeds (`this.weightedMatched`, `this.weightedTotal`, `this.matchedWords`, `this.perfectLines`, `this.linesScored`, `this.bestStreak` if V1-only) — but FIRST grep for each to confirm no V2/telemetry consumer remains (Task 5 removes the telemetry V1 fields; do Task 5 first if a consumer blocks deletion). Remove their initializations in the constructor/reset.

- [ ] **Step 4: Syntax + suite + commit.**
```bash
node --check static/player.js && echo OK
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
git add static/player.js && git commit -m "refactor(player): remove V1 headline + A/B dual-display panel"
```

---

## Task 5: Drop V1 telemetry fields (`player.js`, `telemetry-helpers.js`)

**Files:**
- Modify: `static/player.js` (`_buildTelemetryPayload`: `meta.karaokeeV2` ~1592, `scores.v1Pct` ~1650, `mode: 'headline'|'shadow'` ~1674)
- Modify: `static/telemetry-helpers.js` (`summarizeRun`)
- Test: `tests/test_telemetry_helpers.cjs`

- [ ] **Step 1: Update the telemetry-helpers test FIRST (red).** In `tests/test_telemetry_helpers.cjs`: drop `v1Pct` from the `scores` fixture (~line 31) and remove/repoint the `karaokeeV2: false` "v1" case (~line 88) to the single-path expectation. Run `node tests/test_telemetry_helpers.cjs` → FAIL.

- [ ] **Step 2: Update `summarizeRun`** in `static/telemetry-helpers.js` to stop reading `v1Pct` / branching on `karaokeeV2`. Keep `honestLyricPct`/`composite`/arcade fields. Run the test → PASS.

- [ ] **Step 3: Update `_buildTelemetryPayload`** in `static/player.js`: remove `scores.v1Pct`, the `mode: 'headline'|'shadow'` shadow field, and the `meta.karaokeeV2` line (or hard-set `true` if downstream still expects the key — prefer removing it and updating the schema note).

- [ ] **Step 4: Syntax + suite + commit.**
```bash
node --check static/player.js && echo OK
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
git add static/player.js static/telemetry-helpers.js tests/test_telemetry_helpers.cjs
git commit -m "refactor(telemetry): drop v1Pct + V1/V2 shadow; single-path summary"
```

---

## Task 6: Remove the legacy end-screen (`player.js` `showEndModal`, `player.html`)

**Files:**
- Modify: `static/player.js` (`showEndModal` `useArcade` else-branch ~1874–1886; `var useArcade = window.KARAOKEE_V2 && …` ~1887)
- Modify: `static/player.html` (the `#legacyEnd` block + `#modalScore`/`#modalWords`/`#modalLines`/`#modalStreak`)

- [ ] **Step 1: Flatten `useArcade`.** `var useArcade = window.KARAOKEE_V2 && this._arcadeState && …` → `var useArcade = this._arcadeState && window.KaraokeeArcade && window.KaraokeePhraseEngine && this._phraseSession;`. The arcade hero is now the only end screen.

- [ ] **Step 2: Delete the `else` branch** of `if (useArcade)` (the legacy `#modalScore`/`#modalWords`/… writes + `legacy.style.display = 'block'`). Remove the `var legacy = document.getElementById('legacyEnd');` + every `legacy.style.display` line. The share-image branch (Task: launch story) stays.
  - NOTE: if `useArcade` can ever be false (no arcade state on a degenerate run), keep a minimal guard so `showEndModal` still shows *something* — but since V2 always builds `_arcadeState`, confirm it's always truthy at song end; if so, the else is dead.

- [ ] **Step 3: Remove the `#legacyEnd` DOM** from `static/player.html`.

- [ ] **Step 4: Syntax + suite + commit.**
```bash
node --check static/player.js && echo OK
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
git add static/player.js static/player.html && git commit -m "refactor(player): remove the legacy end screen; arcade hero is the only one"
```

---

## Task 7: Flatten remaining gates + remove the global; full sweep

**Files:** Modify `static/player.js` (HUD ~242/1277; VAD ~621/1229/1238; comment ~847; any stragglers)

- [ ] **Step 1: Flatten the HUD + VAD gates.**
  - `~242` `if (window.KARAOKEE_V2 && this._arcadeState) this._renderArcadeHud(null);` → `if (this._arcadeState) …`.
  - `~1277` `if (!window.KARAOKEE_V2) { hud none; return; }` → delete the guard.
  - `~621` commit-timer gate `if (window.KARAOKEE_V2 && self._neuralVadActive) return;` → `if (self._neuralVadActive) return;`.
  - `~1229` `if (window.KARAOKEE_V2 && this._neuralVadActive && this._commitState && …)` → drop `window.KARAOKEE_V2 &&`.
  - `~1238` `if (window.KARAOKEE_V2 && this._vadState && typeof updateVad === 'function')` → drop `window.KARAOKEE_V2 &&`. **CAREFUL:** the `else` branch here is the *simple-threshold RMS fallback* (`vadRms > _energyThreshold` + baseline calibration). With `_vadState` always created (player.js ~180), the adaptive path is always taken and the simple-threshold else is dead — delete it AND the now-unused `_energyThreshold`/`_vadBaseline*` fields. Re-confirm `_vadState` is unconditionally created before deleting the fallback.

- [ ] **Step 2: Remove the `window.KARAOKEE_V2 = true` line** and grep for any remaining reference:
```bash
grep -rn "KARAOKEE_V2" static/ ; grep -rn "karaokee_v2" static/
```
Expected: only comments remain (e.g. the `vad-helpers.js` docstring — update or drop the stale mention). Flatten any straggler reads. Zero functional reads should remain.

- [ ] **Step 3: Syntax + FULL suite (JS + Python).**
```bash
node --check static/player.js && echo OK
for f in tests/*.cjs; do node "$f" >/dev/null 2>&1 && echo "ok" || echo "FAIL $f"; done | sort | uniq -c
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```
Expected: `OK`, all `.cjs` ok, `55 passed`.

- [ ] **Step 4: Commit.**
```bash
git add static/player.js static/vad-helpers.js && git commit -m "refactor(player): flatten remaining KARAOKEE_V2 gates; remove the global"
```

---

## Task 8: Browser smoke + sing-test hand-off (DO NOT MERGE YET)

**Files:** none (verification)

- [ ] **Step 1: Browser smoke (headless).** Use `webapp-testing` (Playwright + `with_server.py` on port 5000). Inject minimal `songData` into `sessionStorage`, load `/player`, confirm: no console/page errors; `gameMode` constructs; pressing `v` does nothing (no toggle); the arcade HUD path is the only one. (Pattern: the scratch verifiers used earlier this session.)

- [ ] **Step 2: Grep for dead references.**
```bash
grep -rn "V2 panel\|legacyEnd\|_updateWordSpans\|_scoreLine\|_renderV2Panel\|v1Pct\|_syncNeuralVad\|neuralVadToggleAction\|_computeLineWeightedMatched" static/ tests/
```
Expected: no matches (all removed). Stale doc comments are fine to clean up.

- [ ] **Step 3: Update docs.** `CLAUDE.md` (drop `V`/V1 mentions, the `karaokee_v2` flag, the dual-display panel; note single scoring path) and `docs/operations/deployment.md` if it references the toggle. Commit.

- [ ] **Step 4: HAND OFF the sing-test to the user** (the standing gate). Ask them to play a known song and confirm: honest % / grade ≈ the Task 0 baseline; greens/ambers/reds paint right; cheese still scores ~0 and never lifts the multiplier. **Only after they confirm**, use `superpowers:finishing-a-development-branch` to merge `refactor/retire-v1-scoring` → `main`. (Push to `main` auto-deploys to Cloudflare — confirm before pushing.)

---

## Self-review notes (already applied)

- **Shared vs V1:** `computeLineScore` (and `test_scoring.cjs`, `test_telemetry_replay.cjs`) is shared (called by `scoring-session.js:818`) → KEPT. Only player.js's V1 *aggregation* (`_computeLineWeightedMatched`) is removed.
- **`D` debug HUD** is deliberately preserved (separate from `V`).
- **VAD fallback** (Task 7 Step 1) is the one real hazard: the simple-threshold `else` is dead only because `_vadState` is always created — re-verify before deleting.
- **Ordering:** Task 1 (session) first as the highest-risk; Task 5 (telemetry) may need to precede Task 4 Step 3 if an accumulator still feeds telemetry — check the grep.
- **No automated test for `player.js` interactions** (the `.cjs` are pure-logic) — Task 8's browser smoke + the user sing-test are the integration net.
