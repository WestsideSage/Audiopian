# Arcade Scoring & Gameplay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the phrase engine (Scoring V2) to the headline score and expose a difficulty selector — the validation-gated first milestone — then layer arcade points, a combo multiplier, and a grade/high-score end screen on top.

**Architecture:** A new pure `static/scoring-arcade.js` module owns the points/combo/grade state machine (Phase 2+); `static/phrase-engine.js` stays the strictness/lyric authority unchanged; `static/player.js` wires phrase-settle events to the score readout and HUD. The whole change rides the existing `karaokee_v2` flag (`V`) for A/B until a human play-test passes, then the flag flips to default-on.

**Tech Stack:** Plain ES5-style browser JS (no build step), `var`/IIFE-module pattern for Node `require()` testability, Node `.cjs` golden tests via the `loadBrowserCommonJs` shim, Flask static serving.

**Source spec:** [`docs/superpowers/specs/2026-06-02-arcade-scoring-gameplay-design.md`](../specs/2026-06-02-arcade-scoring-gameplay-design.md)

---

## File Structure

**Phase 1 (this plan, detailed):**
- Modify `static/player.html` — difficulty segmented control + header difficulty pill + their CSS.
- Modify `static/player.js` — read difficulty in `start()`; difficulty selector wiring; `_liveHonestPct()`; `_tickArcade()` driven from the 100ms loop; flag-guard `_updateRunningScore()`.

**Phases 2–3 (summarized; own plans after validation):**
- Create `static/scoring-arcade.js` — pure combo/multiplier/perfect/grade state machine.
- Create `tests/test_scoring_arcade.cjs` — golden tests.
- Modify `static/player.js` — `commitPhrase` wiring in `_tickArcade`, `_renderArcadeHud`, end-screen rework, high scores.
- Modify `static/player.html` — floating cluster markup + fire CSS; redesigned end modal + grade CSS; `<script src="/static/scoring-arcade.js">`.

---

## Phase 1 — Promote honest % + expose difficulty (flag-gated A/B)

No points yet. Goal: make the honest lyric-coverage % the headline when `karaokee_v2` is on (old V1 % when off, for A/B), and let the player pick difficulty pre-song. This is the build the human validation play-test runs against.

### Task 1: Difficulty selector + pill markup and styles

**Files:**
- Modify: `static/player.html` (header near `#v2-panel` ~line 317; controls bar near `#gameBtn` ~line 326; `<style>` block)

- [ ] **Step 1: Add the header difficulty pill** after the `#v2-panel` div (~line 317):

```html
<div class="diff-pill" id="diff-pill" style="display:none">MEDIUM</div>
```

- [ ] **Step 2: Add the segmented control** immediately after the Game button (`#gameBtn`, ~line 326):

```html
<div class="diff-select" id="diffSelect" title="Difficulty (locks when a run starts)">
    <button data-diff="easy">Easy</button>
    <button data-diff="medium" class="active">Medium</button>
    <button data-diff="hard">Hard</button>
    <button data-diff="expert">Expert</button>
</div>
```

- [ ] **Step 3: Add CSS** to the `<style>` block (after the `.score-display` rule ~line 158):

```css
.diff-pill {
    font-size: 0.72rem; color: #e6d6ff; background: #3a2a5a;
    border: 1px solid #5a3a8a; border-radius: 10px; padding: 2px 9px;
    font-weight: 700; letter-spacing: .5px; margin-left: 10px;
}
.diff-select { display: inline-flex; border: 1px solid #2a2a4a; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.diff-select button {
    width: auto; padding: 6px 10px; font-size: 0.8rem; background: #1a1a2e;
    color: #aaa; border: none; border-right: 1px solid #2a2a4a; cursor: pointer;
}
.diff-select button:last-child { border-right: none; }
.diff-select button.active { background: #7c4dff; color: #fff; }
.diff-select.locked { opacity: .55; }
.diff-select.locked button { cursor: not-allowed; }
```

- [ ] **Step 4: Verify in the browser**

Run the app (`python app.py`), open a song's player page. Expected: a four-button Easy/Medium/Hard/Expert control sits next to 🎮 Game; Medium is highlighted. (Wiring comes next — clicks do nothing yet.)

- [ ] **Step 5: Commit**

```bash
git add static/player.html
git commit -m "feat(arcade): add difficulty selector and pill markup"
```

### Task 2: Difficulty selector wiring + persistence

**Files:**
- Modify: `static/player.js` — `start()` (~line 521, before `buildPhrasePlan`); new IIFE near the bottom listeners (after the `karaokee_v2` block ~line 2545)

- [ ] **Step 1: Read the saved difficulty in `start()`** — insert immediately before the `if (window.KaraokeePhraseEngine) {` line (~521):

```javascript
        this._phraseDifficulty = localStorage.getItem('arcadeDifficulty') || 'medium';
```

- [ ] **Step 2: Add the selector wiring IIFE** after the `karaokee_v2` flag block (~line 2545):

```javascript
// Difficulty selector — persists to localStorage, locks while a run is active.
(function initDifficultySelect() {
    var sel = document.getElementById('diffSelect');
    if (!sel) return;
    function paint(d) {
        var btns = sel.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', btns[i].getAttribute('data-diff') === d);
        }
        var pill = document.getElementById('diff-pill');
        if (pill) pill.textContent = (d || 'medium').toUpperCase();
    }
    paint(localStorage.getItem('arcadeDifficulty') || 'medium');
    sel.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-diff]') : null;
        if (!btn) return;
        if (gameMode && gameMode.active) return;      // locked mid-run
        var d = btn.getAttribute('data-diff');
        localStorage.setItem('arcadeDifficulty', d);
        if (gameMode) gameMode._phraseDifficulty = d;
        paint(d);
    });
    window._paintDifficulty = paint;                  // reused by start()/stop() to refresh lock state
})();
```

- [ ] **Step 3: Lock the control while active** — at the end of `start()` (after the phrase session is built, ~line 531) add:

```javascript
        var _ds = document.getElementById('diffSelect');
        if (_ds) _ds.classList.add('locked');
        var _dp = document.getElementById('diff-pill');
        if (_dp) { _dp.textContent = (this._phraseDifficulty || 'medium').toUpperCase(); _dp.style.display = 'inline-block'; }
```

- [ ] **Step 4: Unlock on `stop()`** — find `stop()` and add near its top (so replays can re-pick):

```javascript
        var _ds2 = document.getElementById('diffSelect');
        if (_ds2) _ds2.classList.remove('locked');
```

- [ ] **Step 5: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 6: Verify in the browser**

Pick **Hard**, reload the page → Hard is still selected (persisted). Start Game → the control dims/locks and the header pill reads **HARD**. Stop → control unlocks.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): wire difficulty selector with persistence and run-lock"
```

### Task 3: Live honest-% headline behind the flag

**Files:**
- Modify: `static/player.js` — new `_liveHonestPct()` + `_tickArcade()` methods (add near `_updateRunningScore` ~line 1852); flag-guard in `_updateRunningScore()`; call `_tickArcade()` from `updateLyrics` (~line 2435)

- [ ] **Step 1: Add `_liveHonestPct()` and `_tickArcade()`** as GameMode methods (insert just before `_updateRunningScore()` at ~line 1852):

```javascript
    /**
     * "So-far" honest lyric-coverage %: of the anchors required by phrases that
     * have already passed their end (status !== 'open'), what fraction did we hit?
     * Converges to KaraokeePhraseEngine.getLiveScore().lyrics at song end (all
     * phrases settled), but reads as a real running accuracy mid-song instead of
     * crawling up from 0 against the whole-song denominator. Returns null until
     * the first phrase has occurred.
     */
    _liveHonestPct() {
        if (!this._phraseSession || !this._phraseSession.states) return null;
        var sumHit = 0, sumReq = 0;
        var states = this._phraseSession.states;
        for (var id in states) {
            var st = states[id];
            if (!st || st.status === 'open') continue;
            var req = (st.phrase && st.phrase.anchorsRequired) || 0;
            if (req <= 0) continue;
            var hit = Object.keys(st.anchorHits).length;
            if (hit > req) hit = req;
            sumHit += hit; sumReq += req;
        }
        if (sumReq === 0) return null;
        return Math.round((sumHit / sumReq) * 100);
    }

    /**
     * Driven from the 100ms updateLyrics loop so phrases settle even in silence.
     * When karaokee_v2 is on, owns the #score-pct headline (honest %); when off,
     * _updateRunningScore keeps the legacy V1 % for A/B.
     */
    _tickArcade() {
        if (!this.active || !this._phraseSession || !window.KaraokeePhraseEngine) return;
        var now = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
        try { KaraokeePhraseEngine.settlePhrases(this._phraseSession, now); } catch (e) {}
        if (window.KARAOKEE_V2) {
            var pct = this._liveHonestPct();
            var el = document.getElementById('score-pct');
            if (el && pct != null) el.textContent = pct + '%';
        }
    }
```

- [ ] **Step 2: Flag-guard `_updateRunningScore()`** so V1 doesn't fight the honest headline. Replace the body (~line 1852):

```javascript
    _updateRunningScore() {
        this._renderV2Panel();
        if (window.KARAOKEE_V2) return;          // honest % headline owned by _tickArcade()
        if (this.weightedTotal === 0) return;
        const pct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
        document.getElementById('score-pct').textContent = pct + '%';
    }
```

- [ ] **Step 3: Call `_tickArcade()` from the loop** — in `updateLyrics()` replace the hot-word line (~line 2435):

```javascript
    if (gameMode.active) { gameMode.updateHotWord(); gameMode._tickArcade(); }
```

- [ ] **Step 4: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 5: Run the existing suites (no regressions)**

Run:
```bash
node tests/test_scoring.cjs && node tests/test_phrase_engine.cjs && node tests/test_phrase_score.cjs
python -m pytest tests/test_app.py -q
```
Expected: all pass (Phase 1 touches no pure helpers or `app.py`).

- [ ] **Step 6: Verify A/B in the browser**

Start Game, sing a few lines. Press **V**: headline `#score-pct` switches between the **honest %** (V2 on — climbs with anchors you actually hit) and the **legacy V1 %** (off). Confirm honest % does *not* jump on humming/silence.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): honest lyric-coverage % as headline behind karaokee_v2"
```

---

## Validation Gate (human, blocking — do NOT proceed to Phase 2 until this passes)

This is the V2 spec's non-negotiable honesty gate. Run with `karaokee_v2` **on** (press V) and the debug HUD on (press D, exports telemetry). Protocol from [`docs/audits/2026-06-02-voice-detection-scoring-teardown.md`](../../audits/2026-06-02-voice-detection-scoring-teardown.md) §6.

- [ ] **Cheese probes must NOT build the honest %:** silent with speakers playing; humming the melody; looping a common word ("yeah yeah yeah"); mumbling. Honest % should stay low.
- [ ] **Honest variations must score fair:** on-beat clean, slightly off-beat, quiet-but-correct, monotone-but-correct, sloppy-vs-clean rap. Clean should out-score sloppy; correct-but-imperfect should not crater.
- [ ] **Difficulty behaves:** Expert is visibly stricter (needs more anchors) than Easy on the same singing.
- [ ] **Decision:** If cheese stays low AND honest scores fair → proceed to Phase 2. If not, tune the phrase-engine `DIFFICULTY` profiles / `wordsMatchScore` thresholds first and re-run. **No automated test substitutes for this.**

---

## Phase 2 — Arcade points, combo multiplier, HUD cluster (summarized)

Detailed plan authored after the validation gate (tuning constants below get calibrated against the play-test). Task outline:

1. **`static/scoring-arcade.js` (new, pure, TDD):** `createArcadeState(difficulty)`, `commitPhrase(state, {phraseId, anchorsRequired, anchorsTotal, anchorsHit, rescuedByWhisper})` → event, `gradeFor(lyricPct)`, `rampProgress(state)`, `getArcadeSummary(state)`, `ARCADE_TUNING`. Rules per spec §5: clear = `round(BASE_PER_ANCHOR·required·baseScale·(perfect?1.5:1)·multiplier)`; ramp `+1`/`+2` (perfect), `RAMP_PER_TIER=4` → +1 tier up to `maxMultiplier`; miss → reset to 1×; partial → hold; On Fire at max multiplier; commit-once via `state.committed[phraseId]`. IIFE module + `tests/test_scoring_arcade.cjs` golden cases (ramp cadence, perfect double-fill, miss-reset vs partial-hold, difficulty payout scaling, grade thresholds, expert>easy monotonicity, commit-once).
2. **Calibrate `isPerfect`** (spec §12): measure all / required+1 / ≥80%-of-anchors fire rates on honest runs in `tests/fixtures/telemetry-replay/`; pick the threshold the recognizer reliably delivers; bake into the module + a regression test.
3. **Wire into `player.js`:** add `this._arcadeState = KaraokeeArcade.createArcadeState(this._phraseDifficulty)` in `start()`; in `_tickArcade`, after `settlePhrases`, iterate `this._phrasePlan.phrases`, and for each `status === 'settled'` not yet committed, call `commitPhrase` with the uncapped `Object.keys(state.anchorHits).length` and route the event to a point-tick animation + On Fire toggle. Reset arcade state in `_resetSessionCounters`/`replayGame`.
4. **Floating cluster HUD (`player.html` + `player.js` `_renderArcadeHud`):** the option-C markup (points/multiplier/ramp bar/🔥streak) over the lyrics + thin-header % and difficulty pill; the **bold (B)** On-Fire treatment (fire-gradient active line, corner ember glow, "ON FIRE" tag) toggled by `event.onFire`. Add the `<script src="/static/scoring-arcade.js">` include before `player.js`.
5. **Verify:** all `.cjs` + `pytest` green; `node --check` clean; human spot-check that cheese never accumulates points (multiplier never leaves 1×).

## Phase 3 — End screen: grade, stats, high scores (summarized)

1. **Rework `showEndModal()` (`player.js` ~2350):** drive from `getArcadeSummary(this._arcadeState)` + final honest % (`getLiveScore().lyrics`) + `gradeFor(pct)`; populate the grade-hero (A) layout. Gate on the arcade summary, not `totalWords`.
2. **High scores:** read/write `localStorage['hiscore_' + _songKey() + '_' + difficulty]`; show the **NEW BEST** ribbon when `summary.points` beats the stored value, then store it.
3. **`player.html`:** replace the end-modal body with the grade-hero markup (letter grade, points, accuracy/maxCombo/longestStreak/perfects, NEW BEST ribbon); add grade + ribbon CSS. Keep the existing benchmark-feedback `<select>`s.
4. **Flip the flag:** once Phases 2–3 are human-validated, set `karaokee_v2` default-on (`localStorage.getItem('karaokee_v2') !== '0'`) and demote V1 to debug-only.
5. **Verify:** `node --check` clean; play a full song → grade + points + stats render; beating a prior run shows NEW BEST and persists.

---

## Self-Review

- **Spec coverage:** §3 difficulty selection → Tasks 1–2; honest %=lyric coverage → Task 3 (`_liveHonestPct`); §4.3 flag A/B → Task 3 + `_updateRunningScore` guard; §8 validation gate → gate section; §4.1 module, §5 scoring, §4.2 commit-once/settled-boundary, §6 HUD/On Fire/end screen, §10 tunables, §12 perfect calibration → Phases 2–3 outline. All spec sections map to a task.
- **Placeholder scan:** Phase 1 steps contain complete code + exact commands; Phases 2–3 are intentionally summarized (their own plans post-validation, per spec staging + project convention) — not placeholder steps within an active phase.
- **Type consistency:** `_phraseDifficulty` (existing), `localStorage['arcadeDifficulty']`, `_liveHonestPct()`, `_tickArcade()`, `window.KARAOKEE_V2`, `#diffSelect`/`#diff-pill`/`#score-pct` used consistently across Phase 1 tasks. Phase 2 names (`_arcadeState`, `commitPhrase`, `getArcadeSummary`, `gradeFor`, `ARCADE_TUNING`) match spec §4.1/§5.

## Open Items

- Perfect-phrase threshold (spec §12) — resolved at the start of Phase 2 against the telemetry-replay fixtures.
- Phase 1 ships nothing to `app.py`; the `vad_filter`/prompt work from the V2 Stage 0 is already merged and untouched here.
