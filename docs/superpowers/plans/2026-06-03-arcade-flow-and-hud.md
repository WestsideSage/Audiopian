# Arcade Flow + HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the buried, run-locked difficulty selector with a load-time **difficulty-gate overlay** (song → pick difficulty → drop into the game), and build the arcade **floating HUD** (points · multiplier + ramp · 🔥 streak · On Fire) and **grade/high-score end screen** — all behind the `karaokee_v2` flag.

**Architecture:** A new pure `static/scoring-arcade.js` owns the points/multiplier/ramp/perfect/streak/grade state machine (UMD module, `require`-able in `.cjs` tests like `phrase-engine.js`). `static/phrase-engine.js` is unchanged (still the strictness/lyric authority). `static/player.js` drives the difficulty gate, calls `commitPhrase` once per phrase at its `settled` boundary from the existing `_tickArcade` loop, renders the HUD, and reworks the end modal. The arcade HUD, grade screen, and honest-% headline are shown only when `karaokee_v2` is on (press `V`); the difficulty-gate flow itself applies regardless. The flag-flip to default-on still waits on the human validation sing-test (spec §4.3/§8).

**Tech Stack:** Plain ES5-style browser JS (no build step), UMD `(function(root, factory){...})` module pattern for Node `require()`/`loadBrowserCommonJs` testability, Node `.cjs` golden tests, Flask static serving. Author all JS with the **Write/Edit tools directly** (never via Bash subagents — backtick template literals get stripped on Windows; the new module uses string concatenation to stay clear of this entirely).

**Source spec:** [`docs/superpowers/specs/2026-06-02-arcade-scoring-gameplay-design.md`](../specs/2026-06-02-arcade-scoring-gameplay-design.md) (see §14 addendum for the flow change).

---

## File Structure

- **Create `static/scoring-arcade.js`** — pure state machine: `createArcadeState`, `commitPhrase`, `getArcadeSummary`, `gradeFor`, `rampProgress`, `isPerfect`, `ARCADE_TUNING`. No DOM, no deps.
- **Create `tests/test_scoring_arcade.cjs`** — golden assertions (run with `node tests/test_scoring_arcade.cjs`).
- **Modify `static/player.html`** — difficulty-gate overlay markup + CSS; floating-HUD markup + CSS (incl. On Fire); grade-hero end-modal markup + CSS; `<script src="/static/scoring-arcade.js">` include; remove the retired bottom-bar `#diffSelect`.
- **Modify `static/player.js`** — gate logic in `initPrepOverlay`/`toggleGameMode`/`replayGame`; remove `#diffSelect` lock/unlock + IIFE; `createArcadeState` in `start()` and reset in `_resetSessionCounters`; `commitPhrase` loop + `_renderArcadeHud` in `_tickArcade`; rework `showEndModal` + high scores.

**Build order (each phase independently verifiable):** A (flow gate — fixes the bug, no arcade dep) → B (pure module + tests) → C (wire) → D (HUD) → E (end screen).

---

## Phase A — Difficulty-gate flow

Replaces the bottom-bar segmented selector with a load-time gate built into the existing prep overlay. The gate is the single entry point to a run (load, Play Again, and 🎮 Game from passive mode). Independent of the arcade module.

### Task A1: Gate overlay markup + CSS

**Files:**
- Modify: `static/player.html` (prep overlay ~lines 317-326; `<style>` block; remove `#diffSelect` ~lines 343-348)

- [ ] **Step 1: Replace the prep overlay body** — swap the existing `#prepOverlay` block (the `.prep-box` with the single Skip button) for the gate:

```html
    <div class="prep-overlay" id="prepOverlay">
        <div class="prep-box">
            <div class="prep-song" id="prepSongTitle"></div>
            <div class="diff-gate" id="diffGate" role="group" aria-label="Choose difficulty">
                <div class="diff-gate-label">Choose your difficulty</div>
                <div class="diff-gate-cards" id="diffGateCards">
                    <button class="diff-card" data-diff="easy"><span class="dc-name">Easy</span><span class="dc-desc">Forgiving — a few key words</span></button>
                    <button class="diff-card" data-diff="medium"><span class="dc-name">Medium</span><span class="dc-desc">Balanced</span></button>
                    <button class="diff-card" data-diff="hard"><span class="dc-name">Hard</span><span class="dc-desc">Strict words &amp; timing</span></button>
                    <button class="diff-card" data-diff="expert"><span class="dc-name">Expert</span><span class="dc-desc">Nearly every word, tight</span></button>
                </div>
                <div class="prep-status">
                    <div class="prep-spinner"></div>
                    <span id="prepStatus">Preparing audio…</span>
                </div>
                <button class="diff-gate-listen ctrl-btn" onclick="justListen()">Just listen — no scoring</button>
            </div>
        </div>
    </div>
```

- [ ] **Step 2: Remove the retired bottom-bar selector** — delete the `#diffSelect` `<div class="diff-select">…</div>` block (the four Easy/Medium/Hard/Expert buttons in `.controls`, ~lines 343-348). Leave the `#diff-pill` in the header (it stays as the in-run status indicator) and the 🎮 `#gameBtn`.

- [ ] **Step 3: Add gate CSS** to the `<style>` block (after the existing `.prep-song` rule). The `.diff-select*` rules can stay or be removed (harmless once the markup is gone):

```css
        .diff-gate { display: flex; flex-direction: column; align-items: center; gap: 18px; }
        .diff-gate-label { font-size: 1rem; color: #aaa; letter-spacing: .5px; }
        .diff-gate-cards { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
        .diff-card {
            width: 150px; padding: 18px 14px; background: #1a1a2e; color: #e6d6ff;
            border: 1px solid #3a2a5a; border-radius: 12px; cursor: pointer;
            display: flex; flex-direction: column; gap: 6px; align-items: center;
            transition: transform .12s, border-color .12s, box-shadow .12s;
        }
        .diff-card:hover, .diff-card:focus-visible {
            transform: translateY(-3px); border-color: #7c4dff; box-shadow: 0 0 14px #7c4dff55; outline: none;
        }
        .diff-card .dc-name { font-size: 1.15rem; font-weight: 700; color: #fff; }
        .diff-card .dc-desc { font-size: 0.75rem; color: #9a8fae; text-align: center; line-height: 1.3; }
        .diff-card.selected { border-color: #e040fb; box-shadow: 0 0 16px #e040fb66; }
        .diff-gate-listen { width: auto; padding: 8px 16px; font-size: 0.85rem; opacity: .8; }
```

- [ ] **Step 4: Verify markup** — open `static/player.html` and confirm `#diffGate`, four `.diff-card[data-diff]` buttons, `#prepStatus`, and the `justListen()` button exist, and that `#diffSelect` is gone while `#diff-pill` and `#gameBtn` remain.

- [ ] **Step 5: Commit**

```bash
git add static/player.html
git commit -m "feat(arcade): difficulty-gate overlay markup + retire bottom selector"
```

### Task A2: Gate logic, run entry, and selector cleanup in player.js

**Files:**
- Modify: `static/player.js` — `start()` lock block (~533-540) & `stop()` unlock block (~599-605); `initPrepOverlay`/`skipPrep` (~2677-2693); `toggleGameMode` (~2695); `replayGame` (~2707); remove `initDifficultySelect` IIFE (~2604-2628)

- [ ] **Step 1: Drop the `#diffSelect` lock from `start()`** — replace the lock block (the `var _dsLock = document.getElementById('diffSelect'); … }` through the `_dpShow` pill block, ~lines 533-540) with just the pill update (the selector no longer exists):

```javascript
        var _dpShow = document.getElementById('diff-pill');
        if (_dpShow) { _dpShow.textContent = (this._phraseDifficulty || 'medium').toUpperCase(); _dpShow.style.display = 'inline-block'; }
```

- [ ] **Step 2: Drop the `#diffSelect` unlock from `stop()`** — remove the `var _dsUnlock = document.getElementById('diffSelect'); … }` block (~lines 599-604). Keep the `_dpHide` line that hides the pill.

- [ ] **Step 3: Remove the `initDifficultySelect` IIFE** (~lines 2604-2628) entirely — the gate replaces it. The persisted key `localStorage['arcadeDifficulty']` is still read in `start()` and written by the gate (next step).

- [ ] **Step 4: Add a paint helper + gate openers** — replace `initPrepOverlay`/`skipPrep` (~lines 2677-2693) with the gate flow:

```javascript
// --- Difficulty gate / loading overlay ---

function _paintDiffPill(d) {
    var pill = document.getElementById('diff-pill');
    if (pill) pill.textContent = (d || 'medium').toUpperCase();
}

function _markSelectedCard(d) {
    var cards = document.querySelectorAll('#diffGateCards .diff-card');
    for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('selected', cards[i].getAttribute('data-diff') === d);
    }
}

// Show the gate (used on load, Play Again, and 🎮 Game from passive mode).
function openDifficultyGate() {
    var overlay = document.getElementById('prepOverlay');
    if (!overlay) return;
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) document.getElementById('prepSongTitle').textContent = sd.artist + ' — ' + sd.title;
    _markSelectedCard(localStorage.getItem('arcadeDifficulty') || 'medium');
    overlayDismissed = false;
    overlay.style.display = 'flex';
}

// Begin a scored run on the chosen difficulty.
function startRunWithDifficulty(d) {
    localStorage.setItem('arcadeDifficulty', d);
    if (gameMode) gameMode._phraseDifficulty = d;
    _paintDiffPill(d);
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    if (gameMode.active) gameMode.stop();
    audio.currentTime = 0;
    audio.play().then(function () { playBtn.textContent = '⏸'; }).catch(function () {});
    gameMode.start();
}

// Escape hatch — passive karaoke, no scoring.
function justListen() {
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    audio.play().then(function () { playBtn.textContent = '⏸'; }).catch(function () {});
}

// Back-compat shim (existing callers/tests): behaves like "just listen".
function skipPrep() { justListen(); }

// Wire the gate cards once.
(function initDifficultyGate() {
    var cards = document.getElementById('diffGateCards');
    if (!cards) return;
    cards.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-diff]') : null;
        if (!btn) return;
        startRunWithDifficulty(btn.getAttribute('data-diff'));
    });
})();

function initPrepOverlay() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) document.getElementById('prepSongTitle').textContent = sd.artist + ' — ' + sd.title;
    if (lyrics.length === 0) { justListen(); return; }   // no lyrics → can't score; just play
    _markSelectedCard(localStorage.getItem('arcadeDifficulty') || 'medium');
    _paintDiffPill(localStorage.getItem('arcadeDifficulty') || 'medium');
    // Overlay stays open showing the gate; user picks a difficulty or "Just listen".
}

initPrepOverlay();
```

- [ ] **Step 5: Route 🎮 Game through the gate** — replace `toggleGameMode` (~line 2695):

```javascript
function toggleGameMode() {
    if (lyrics.length === 0) {
        alert('No lyrics available for this song — game mode requires synced lyrics.');
        return;
    }
    if (gameMode.active) {
        gameMode.stop();
    } else {
        openDifficultyGate();   // pick difficulty, then the run starts from the top
    }
}
```

- [ ] **Step 6: Make Play Again re-open the gate** — replace `replayGame` (~line 2707):

```javascript
function replayGame() {
    document.getElementById('gameModal').style.display = 'none';
    if (gameMode.active) gameMode.stop();
    openDifficultyGate();
}
```

- [ ] **Step 7: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 8: Verify in the browser** (`python app.py`, load a song)
  - On load the overlay shows four difficulty cards + "Just listen". The previously-saved difficulty card is highlighted.
  - Click **Hard** → overlay closes, audio plays from the top, the run starts, the header pill reads **HARD**. **This is the key check: difficulty is actually changeable now and carries into the run.**
  - Finish/skip to the end → end modal → **Play Again** re-shows the gate.
  - Reload, click **Just listen** → passive karaoke (no game). Press 🎮 Game → the gate re-opens.
  - Confirm there is no leftover bottom-bar selector and nothing is greyed-out/stuck.

- [ ] **Step 9: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): difficulty-gate run entry; retire bottom selector"
```

---

## Phase B — `scoring-arcade.js` pure module + golden tests (TDD)

Pure points/multiplier/ramp/perfect/streak/grade state machine per spec §5. No DOM. Commit-once per phrase. `isPerfect` defaults to "all anchors" (tunable; §12 calibration deferred — only a smoke fixture exists in `telemetry-replay/`).

### Task B1: Write the golden tests first

**Files:**
- Create: `tests/test_scoring_arcade.cjs`

- [ ] **Step 1: Write the failing test file**

```javascript
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function loadBrowserCommonJs(filePath, extraArgs) {
    var code = fs.readFileSync(filePath, 'utf8');
    var fakeModule = { exports: {} };
    var argNames = ['module', 'exports'].concat(Object.keys(extraArgs || {}));
    var argValues = [fakeModule, fakeModule.exports].concat(Object.values(extraArgs || {}));
    var fn = new Function(argNames.join(','), code);
    fn.apply(null, argValues);
    return fakeModule.exports;
}

var arcade = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'scoring-arcade.js'));

// Helper: a cleared-phrase outcome with `hit` of `total` anchors, `required` to clear.
function clear(id, required, total, hit) {
    return { phraseId: id, anchorsRequired: required, anchorsTotal: total, anchorsHit: hit };
}

// --- 1. Initial state ---
var s = arcade.createArcadeState('medium');
assert.strictEqual(s.points, 0, 'starts at 0 points');
assert.strictEqual(s.multiplier, 1, 'starts at 1x');
assert.strictEqual(s.streak, 0, 'starts at 0 streak');

// --- 2. Single bare clear (medium, required 2, not perfect: hit 2 of 4) ---
var ev = arcade.commitPhrase(s, clear('p0', 2, 4, 2));
// base = 100 * 2 * 1.25 = 250; mult 1; not perfect
assert.strictEqual(ev.pointsAwarded, 250, 'bare clear pays base*required*baseScale');
assert.strictEqual(ev.outcome, 'clear');
assert.strictEqual(ev.perfect, false);
assert.strictEqual(s.streak, 1);
assert.strictEqual(s.multiplier, 1, 'one clear does not yet tier up');

// --- 3. Ramp cadence: 4 bare clears (required 1, medium) -> tier up to 2x on the 4th ---
var r = arcade.createArcadeState('medium');
var mults = [];
for (var i = 0; i < 5; i++) {
    var e = arcade.commitPhrase(r, clear('rp' + i, 1, 3, 1));
    mults.push(e.multiplier);
}
// award uses current mult, THEN ramp advances. base = 100*1*1.25 = 125.
// clears 1-3: mult stays 1 (ramp 1,2,3). clear 4: ramp 4 -> mult 2. clear 5: mult 2.
assert.deepStrictEqual(mults, [1, 1, 1, 2, 2], 'multiplier tiers up after 4 bare clears');
// points: 125*4 (at 1x) + 125*2 (at 2x) = 500 + 250 = 750
assert.strictEqual(r.points, 750, 'ramp cadence point total');

// --- 4. Perfect double-fills the ramp (+2): 2 perfects -> tier up ---
var p = arcade.createArcadeState('medium');
var pe1 = arcade.commitPhrase(p, clear('pp0', 1, 1, 1)); // hit all -> perfect
var pe2 = arcade.commitPhrase(p, clear('pp1', 1, 1, 1));
assert.strictEqual(pe1.perfect, true, 'hitting all anchors is perfect');
assert.strictEqual(p.multiplier, 2, 'two perfects (ramp +2 each) tier up');
// each perfect: round(125 * 1.5 * 1) = 188
assert.strictEqual(pe1.pointsAwarded, 188, 'perfect pays +50%');

// --- 5. Miss resets multiplier, ramp, streak ---
var m = arcade.createArcadeState('hard');
for (var j = 0; j < 6; j++) arcade.commitPhrase(m, clear('mp' + j, 1, 2, 1));
assert.ok(m.multiplier > 1, 'built a multiplier');
var miss = arcade.commitPhrase(m, clear('mm', 2, 4, 0)); // hit 0 -> miss
assert.strictEqual(miss.outcome, 'miss');
assert.strictEqual(m.multiplier, 1, 'miss resets multiplier to 1');
assert.strictEqual(m.streak, 0, 'miss resets streak');

// --- 6. Partial holds (no points, no streak change, no reset) ---
var h = arcade.createArcadeState('medium');
arcade.commitPhrase(h, clear('hp0', 2, 4, 2)); // clear -> streak 1, ramp 1
var beforePoints = h.points, beforeStreak = h.streak, beforeRamp = h.ramp;
var part = arcade.commitPhrase(h, clear('hp1', 3, 5, 1)); // 0 < 1 < 3 -> partial
assert.strictEqual(part.outcome, 'partial');
assert.strictEqual(part.pointsAwarded, 0, 'partial awards no points');
assert.strictEqual(h.points, beforePoints, 'partial does not change points');
assert.strictEqual(h.streak, beforeStreak, 'partial holds streak');
assert.strictEqual(h.ramp, beforeRamp, 'partial holds ramp');

// --- 7. Difficulty payout monotonicity: identical clears, expert > easy ---
function totalFor(diff) {
    var st = arcade.createArcadeState(diff);
    for (var k = 0; k < 10; k++) arcade.commitPhrase(st, clear('d' + k, 2, 4, 2));
    return st.points;
}
assert.ok(totalFor('expert') > totalFor('easy'), 'expert out-pays easy for identical play');
assert.ok(totalFor('hard') > totalFor('medium'), 'hard out-pays medium');

// --- 8. Grade thresholds (off honest %) ---
assert.strictEqual(arcade.gradeFor(95), 'S');
assert.strictEqual(arcade.gradeFor(94), 'A');
assert.strictEqual(arcade.gradeFor(85), 'A');
assert.strictEqual(arcade.gradeFor(84), 'B');
assert.strictEqual(arcade.gradeFor(72), 'B');
assert.strictEqual(arcade.gradeFor(71), 'C');
assert.strictEqual(arcade.gradeFor(58), 'C');
assert.strictEqual(arcade.gradeFor(57), 'D');
assert.strictEqual(arcade.gradeFor(0), 'D');

// --- 9. Commit-once: same phraseId twice is ignored ---
var c = arcade.createArcadeState('medium');
var first = arcade.commitPhrase(c, clear('once', 2, 4, 2));
var dup = arcade.commitPhrase(c, clear('once', 2, 4, 2));
assert.ok(first && first.pointsAwarded > 0, 'first commit pays');
assert.strictEqual(dup, null, 'duplicate commit returns null');
assert.strictEqual(c.points, first.pointsAwarded, 'duplicate does not double-count');

// --- 10. Perfect threshold = "all anchors" (default) ---
assert.strictEqual(arcade.isPerfect(4, 2, 4), true, 'all anchors hit = perfect');
assert.strictEqual(arcade.isPerfect(3, 2, 4), false, 'missing one anchor != perfect');
assert.strictEqual(arcade.isPerfect(0, 0, 0), false, 'no anchors = not perfect');

// --- 11. On Fire at max multiplier; cleared by a miss ---
var f = arcade.createArcadeState('easy'); // maxMultiplier 4
for (var n = 0; n < 20; n++) arcade.commitPhrase(f, clear('fp' + n, 1, 2, 1));
assert.strictEqual(f.multiplier, 4, 'easy caps at 4x');
assert.strictEqual(f.onFire, true, 'on fire at max multiplier');
arcade.commitPhrase(f, clear('fmiss', 1, 2, 0));
assert.strictEqual(f.onFire, false, 'miss clears on fire');

// --- 12. Summary shape ---
var sum = arcade.getArcadeSummary(r);
assert.ok(typeof sum.points === 'number');
assert.ok(typeof sum.maxMultiplier === 'number');
assert.ok(typeof sum.longestStreak === 'number');
assert.ok(typeof sum.perfects === 'number');

// --- 13. rampProgress is 0..1 and full at max ---
assert.ok(arcade.rampProgress(r) >= 0 && arcade.rampProgress(r) <= 1);
assert.strictEqual(arcade.rampProgress(f), 1, 'ramp shows full at max multiplier');

console.log('test_scoring_arcade.cjs: all assertions passed');
```

- [ ] **Step 2: Run to verify it fails** (module doesn't exist yet)

Run: `node tests/test_scoring_arcade.cjs`
Expected: FAIL — `ENOENT` (no such file) or a load error for `static/scoring-arcade.js`.

### Task B2: Implement the module

**Files:**
- Create: `static/scoring-arcade.js`

- [ ] **Step 1: Write the module** (string concatenation only — no template literals):

```javascript
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeArcade = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // --- Tunables (spec §5/§10). Calibrate by feel during validation. ---
    var BASE_PER_ANCHOR = 100;   // base points per required anchor
    var RAMP_PER_TIER = 4;       // ramp units to advance one multiplier tier
    var PERFECT_BONUS = 0.5;     // +50% base on a perfect phrase
    var PERFECT_BONUS_RAMP = 2;  // ramp units a perfect adds (bare clear adds 1)

    // Perfect-phrase threshold (spec §12). Default "all" is the most resistant to
    // recognizer-completeness inflation; calibrate against real honest-run telemetry.
    var PERFECT_THRESHOLD = 'all';     // 'all' | 'requiredPlusOne' | 'ratio'
    var ANCHOR_PERFECT_RATIO = 0.8;    // used only when PERFECT_THRESHOLD === 'ratio'

    var ARCADE_TUNING = {
        easy:   { baseScale: 1.0,  maxMultiplier: 4 },
        medium: { baseScale: 1.25, maxMultiplier: 4 },
        hard:   { baseScale: 1.5,  maxMultiplier: 6 },
        expert: { baseScale: 2.0,  maxMultiplier: 8 }
    };

    function tuningFor(difficulty) {
        return ARCADE_TUNING[difficulty] || ARCADE_TUNING.medium;
    }

    function createArcadeState(difficulty) {
        return {
            difficulty: difficulty || 'medium',
            tuning: tuningFor(difficulty),
            points: 0,
            multiplier: 1,
            ramp: 0,
            streak: 0,
            longestStreak: 0,
            maxMultiplier: 1,
            perfects: 0,
            clears: 0,
            onFire: false,
            committed: {}
        };
    }

    // hit/required/total are anchor counts (UNCAPPED hit).
    function isPerfect(hit, required, total) {
        if (!total || total <= 0) return false;
        if (PERFECT_THRESHOLD === 'ratio') return hit >= Math.ceil(total * ANCHOR_PERFECT_RATIO);
        if (PERFECT_THRESHOLD === 'requiredPlusOne') return hit >= Math.min(total, (required || 0) + 1);
        return hit >= total; // 'all'
    }

    // Commit a phrase exactly once at its settled boundary. `o` = {phraseId,
    // anchorsRequired, anchorsTotal, anchorsHit, rescuedByWhisper?}. Returns the
    // event for the HUD, or null if already committed / invalid.
    function commitPhrase(state, o) {
        if (!state || !o || o.phraseId == null) return null;
        if (state.committed[o.phraseId]) return null;
        state.committed[o.phraseId] = true;

        var required = o.anchorsRequired || 0;
        var total = o.anchorsTotal || 0;
        var hit = o.anchorsHit || 0;
        var tuning = state.tuning;

        var outcome, pointsAwarded = 0, perfect = false;

        if (required > 0 && hit >= required) {
            outcome = 'clear';
            perfect = isPerfect(hit, required, total);
            var mult = state.multiplier; // award with current multiplier, then advance
            var base = BASE_PER_ANCHOR * required * tuning.baseScale;
            pointsAwarded = Math.round(base * (perfect ? 1 + PERFECT_BONUS : 1) * mult);
            state.points += pointsAwarded;
            state.clears += 1;
            if (perfect) state.perfects += 1;
            state.streak += 1;
            if (state.streak > state.longestStreak) state.longestStreak = state.streak;
            state.ramp += perfect ? PERFECT_BONUS_RAMP : 1;
            while (state.ramp >= RAMP_PER_TIER && state.multiplier < tuning.maxMultiplier) {
                state.multiplier += 1;
                state.ramp -= RAMP_PER_TIER;
            }
            if (state.multiplier >= tuning.maxMultiplier) {
                state.multiplier = tuning.maxMultiplier;
                state.ramp = RAMP_PER_TIER; // full bar at max
            }
            if (state.multiplier > state.maxMultiplier) state.maxMultiplier = state.multiplier;
        } else if (hit === 0) {
            outcome = 'miss';
            state.multiplier = 1;
            state.ramp = 0;
            state.streak = 0;
        } else {
            outcome = 'partial'; // hold — no points, no ramp, no reset
        }

        state.onFire = state.multiplier === tuning.maxMultiplier;

        return {
            phraseId: o.phraseId,
            outcome: outcome,
            perfect: perfect,
            pointsAwarded: pointsAwarded,
            points: state.points,
            multiplier: state.multiplier,
            ramp: state.ramp,
            rampPerTier: RAMP_PER_TIER,
            streak: state.streak,
            onFire: state.onFire
        };
    }

    function rampProgress(state) {
        if (!state) return 0;
        if (state.multiplier >= state.tuning.maxMultiplier) return 1;
        var p = state.ramp / RAMP_PER_TIER;
        if (p < 0) return 0;
        if (p > 1) return 1;
        return p;
    }

    function gradeFor(pct) {
        if (pct >= 95) return 'S';
        if (pct >= 85) return 'A';
        if (pct >= 72) return 'B';
        if (pct >= 58) return 'C';
        return 'D';
    }

    function getArcadeSummary(state) {
        return {
            points: state.points,
            maxMultiplier: state.maxMultiplier,
            longestStreak: state.longestStreak,
            perfects: state.perfects,
            clears: state.clears
        };
    }

    return {
        ARCADE_TUNING: ARCADE_TUNING,
        createArcadeState: createArcadeState,
        commitPhrase: commitPhrase,
        isPerfect: isPerfect,
        rampProgress: rampProgress,
        gradeFor: gradeFor,
        getArcadeSummary: getArcadeSummary
    };
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `node tests/test_scoring_arcade.cjs`
Expected: `test_scoring_arcade.cjs: all assertions passed`

- [ ] **Step 3: Syntax check**

Run: `node --check static/scoring-arcade.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add static/scoring-arcade.js tests/test_scoring_arcade.cjs
git commit -m "feat(arcade): pure scoring-arcade.js state machine + golden tests"
```

---

## Phase C — Wire the arcade state into player.js

Create the arcade state per run, reset it on replay, and commit each phrase once at its `settled` boundary from the existing `_tickArcade` loop. No HUD yet — verify via `console`/debug that points accrue only on real clears.

### Task C1: Include the script + create/reset arcade state

**Files:**
- Modify: `static/player.html` (script includes, ~line 413) and `static/player.js` (`start()` ~527; `_resetSessionCounters` ~647)

- [ ] **Step 1: Add the module include** in `player.html` — before the `player.js` `<script>` tag (after `phrase-engine.js`):

```html
    <script src="/static/scoring-arcade.js"></script>
```

- [ ] **Step 2: Create the arcade state in `start()`** — immediately after the `this._phraseSession = KaraokeePhraseEngine.createPhraseSession(this._phrasePlan);` line (~527), inside the `if (window.KaraokeePhraseEngine) {` block:

```javascript
            this._arcadeState = (window.KaraokeeArcade)
                ? KaraokeeArcade.createArcadeState(this._phraseDifficulty)
                : null;
            this._committedPhrases = {};
```

- [ ] **Step 3: Reset arcade state on `_resetSessionCounters()`** — add at the end of the method (after the existing `this.weightedMatched = 0;` block, ~line 659):

```javascript
        if (window.KaraokeeArcade && this._phraseDifficulty) {
            this._arcadeState = KaraokeeArcade.createArcadeState(this._phraseDifficulty);
        }
        this._committedPhrases = {};
```

- [ ] **Step 4: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat(arcade): include scoring-arcade.js; create/reset arcade state per run"
```

### Task C2: Commit phrases at the settled boundary in `_tickArcade`

**Files:**
- Modify: `static/player.js` (`_tickArcade` ~1897)

- [ ] **Step 1: Add the commit loop** — replace the body of `_tickArcade` (~lines 1897-1906) with:

```javascript
    _tickArcade() {
        if (!this.active || !this._phraseSession || !window.KaraokeePhraseEngine) return;
        var now = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
        try { KaraokeePhraseEngine.settlePhrases(this._phraseSession, now); } catch (e) {}

        // Commit each phrase exactly once, when it first reaches status 'settled'.
        // Reads the UNCAPPED anchor-hit count at that instant (spec §4.2): later
        // grace-window evidence still lifts the honest %, but never the live multiplier.
        if (this._arcadeState && window.KaraokeeArcade && this._phrasePlan) {
            var phrases = this._phrasePlan.phrases || [];
            for (var i = 0; i < phrases.length; i++) {
                var ph = phrases[i];
                var st = this._phraseSession.states[ph.phraseId];
                if (!st || st.status !== 'settled') continue;
                if (this._committedPhrases[ph.phraseId]) continue;
                this._committedPhrases[ph.phraseId] = true;
                var evt = KaraokeeArcade.commitPhrase(this._arcadeState, {
                    phraseId: ph.phraseId,
                    anchorsRequired: ph.anchorsRequired,
                    anchorsTotal: (ph.anchors || []).length,
                    anchorsHit: Object.keys(st.anchorHits).length,
                    rescuedByWhisper: st.rescuedByWhisper
                });
                if (evt && window.KARAOKEE_V2) this._onArcadeEvent(evt);
            }
        }

        if (window.KARAOKEE_V2) {
            var pct = this._liveHonestPct();
            var el = document.getElementById('score-pct');
            if (el && pct != null) el.textContent = pct + '%';
        }
    }

    // Placeholder until Phase D wires the HUD; logs so Phase C is verifiable.
    _onArcadeEvent(evt) {
        if (window._kDebug) console.log('[ARCADE]', evt.outcome, '+' + evt.pointsAwarded,
            'pts=' + evt.points, 'x' + evt.multiplier, evt.onFire ? 'FIRE' : '');
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 3: Run existing suites (no regressions)**

Run:
```bash
node tests/test_scoring_arcade.cjs && node tests/test_phrase_engine.cjs && node tests/test_phrase_score.cjs && node tests/test_scoring.cjs
python -m pytest tests/test_app.py -q
```
Expected: all pass.

- [ ] **Step 4: Verify in the browser** — press **V** (V2 on) and **D** (debug + console). Start a run, sing a couple of phrases. Console shows `[ARCADE] clear +N …` only when you actually clear phrases; **humming/silence shows no clears and the multiplier never leaves x1** (the honesty property — the live HUD will make this visible in Phase D).

- [ ] **Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): commit phrases at settled boundary, accrue arcade points"
```

---

## Phase D — Floating HUD cluster + On Fire

Render the top-right cluster (points · multiplier + ramp · 🔥 streak) and the bold On-Fire treatment, driven by the `_onArcadeEvent` events. Shown only when `karaokee_v2` is on and a run is active.

### Task D1: HUD markup + CSS

**Files:**
- Modify: `static/player.html` (markup after the player-header ~line 334; `<style>` block)

- [ ] **Step 1: Add the HUD markup** — immediately after the closing `</div>` of `.player-header` (~line 334):

```html
    <div class="arcade-hud" id="arcadeHud" style="display:none" aria-hidden="true">
        <div class="ah-points" id="ahPoints">0</div>
        <div class="ah-mult-row">
            <span class="ah-mult" id="ahMult">1&#215;</span>
            <div class="ah-ramp"><div class="ah-ramp-fill" id="ahRampFill"></div></div>
        </div>
        <div class="ah-streak" id="ahStreak" style="visibility:hidden">&#128293; <span id="ahStreakVal">0</span></div>
        <div class="ah-fire" id="ahFire" style="display:none">ON FIRE</div>
    </div>
```

- [ ] **Step 2: Add HUD + On-Fire CSS** to the `<style>` block:

```css
        .arcade-hud {
            position: fixed; top: 70px; right: 18px; z-index: 90;
            display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
            pointer-events: none; font-variant-numeric: tabular-nums;
        }
        .ah-points {
            font-size: 2.2rem; font-weight: 800; color: #00e676;
            text-shadow: 0 0 10px #00e67655; line-height: 1;
            transition: transform .12s;
        }
        .ah-points.bump { transform: scale(1.18); }
        .ah-mult-row { display: flex; align-items: center; gap: 8px; }
        .ah-mult { font-size: 1.3rem; font-weight: 800; color: #ffd24a; text-shadow: 0 0 8px #ffd24a55; }
        .ah-ramp { width: 90px; height: 7px; background: #2a2a4a; border-radius: 4px; overflow: hidden; }
        .ah-ramp-fill { height: 100%; width: 0%; background: linear-gradient(90deg,#ffb347,#ffd24a); transition: width .2s; }
        .ah-streak { font-size: 1rem; color: #ff8a3d; font-weight: 700; }
        .ah-fire {
            font-size: 0.95rem; font-weight: 900; letter-spacing: 2px;
            color: #fff; background: linear-gradient(90deg,#ff5252,#ff9800);
            padding: 2px 10px; border-radius: 10px; box-shadow: 0 0 16px #ff572eaa;
            animation: firePulse 0.7s ease-in-out infinite alternate;
        }
        @keyframes firePulse { from { box-shadow: 0 0 10px #ff572e88; } to { box-shadow: 0 0 22px #ff9800cc; } }

        /* On Fire — bold active-line treatment; lyrics stay readable. */
        body.arcade-onfire .lyric-line.active {
            background: linear-gradient(90deg,#ff5252,#ff9800,#ffd24a);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
            text-shadow: 0 0 18px #ff980066;
        }
        body.arcade-onfire #lyrics-container::after {
            content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 1;
            box-shadow: inset 0 -120px 120px -90px #ff6a00aa, inset 0 120px 120px -90px #ff6a0066;
        }
```

- [ ] **Step 3: Verify markup** — confirm `#arcadeHud`, `#ahPoints`, `#ahMult`, `#ahRampFill`, `#ahStreak`/`#ahStreakVal`, `#ahFire` exist.

- [ ] **Step 4: Commit**

```bash
git add static/player.html
git commit -m "feat(arcade): floating HUD cluster + On Fire markup and CSS"
```

### Task D2: Render the HUD from arcade events

**Files:**
- Modify: `static/player.js` (`_onArcadeEvent` from Phase C; `start()` ~573; `stop()` ~595; `_resetSessionCounters` ~659)

- [ ] **Step 1: Replace `_onArcadeEvent`** with a real renderer + add `_renderArcadeHud`/`_hideArcadeHud`:

```javascript
    _onArcadeEvent(evt) {
        this._renderArcadeHud(evt);
        if (window._kDebug) console.log('[ARCADE]', evt.outcome, '+' + evt.pointsAwarded,
            'pts=' + evt.points, 'x' + evt.multiplier, evt.onFire ? 'FIRE' : '');
    }

    _renderArcadeHud(evt) {
        var hud = document.getElementById('arcadeHud');
        if (!hud || !this._arcadeState || !window.KaraokeeArcade) return;
        if (!window.KARAOKEE_V2) { hud.style.display = 'none'; return; }
        hud.style.display = 'flex';

        var st = this._arcadeState;
        var ptsEl = document.getElementById('ahPoints');
        if (ptsEl) {
            ptsEl.textContent = String(st.points);
            if (evt && evt.pointsAwarded > 0) {
                ptsEl.classList.add('bump');
                setTimeout(function () { ptsEl.classList.remove('bump'); }, 130);
            }
        }
        var multEl = document.getElementById('ahMult');
        if (multEl) multEl.textContent = st.multiplier + '×';
        var fill = document.getElementById('ahRampFill');
        if (fill) fill.style.width = Math.round(KaraokeeArcade.rampProgress(st) * 100) + '%';

        var streak = document.getElementById('ahStreak');
        var streakVal = document.getElementById('ahStreakVal');
        if (streak && streakVal) {
            streakVal.textContent = String(st.streak);
            streak.style.visibility = st.streak >= 2 ? 'visible' : 'hidden';
        }
        var fire = document.getElementById('ahFire');
        if (fire) fire.style.display = st.onFire ? 'block' : 'none';
        document.body.classList.toggle('arcade-onfire', !!st.onFire);
    }

    _hideArcadeHud() {
        var hud = document.getElementById('arcadeHud');
        if (hud) hud.style.display = 'none';
        document.body.classList.remove('arcade-onfire');
    }
```

- [ ] **Step 2: Show/seed the HUD at run start** — at the end of `start()` (after `this._renderV2Panel();` ~line 577) add:

```javascript
        if (window.KARAOKEE_V2 && this._arcadeState) this._renderArcadeHud(null);
```

- [ ] **Step 3: Hide the HUD on `stop()`** — after the existing `_dpHide` line (~line 605) add:

```javascript
        this._hideArcadeHud();
```

- [ ] **Step 4: Clear On-Fire on reset** — at the end of `_resetSessionCounters()` add:

```javascript
        document.body.classList.remove('arcade-onfire');
```

- [ ] **Step 5: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 6: Verify in the browser** (V2 on) — start a run on **Easy**, sing along. The HUD points climb on clears, the multiplier ticks up with the ramp bar, 🔥 streak appears at 2+, and at max multiplier the "ON FIRE" tag shows and the active lyric line burns. A missed phrase drops the multiplier to x1 and clears the fire. Hum/stay silent → points stay 0, multiplier stays x1.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): render floating HUD + On Fire from arcade events"
```

---

## Phase E — Grade / high-score end screen

Rework the end modal into a grade hero driven by `getArcadeSummary` + honest % + `gradeFor`, with per-song high scores and a NEW BEST ribbon. Legacy modal stays when V2 is off.

### Task E1: End-screen markup + CSS

**Files:**
- Modify: `static/player.html` (`#gameModal` body ~lines 370-407; `<style>` block)

- [ ] **Step 1: Add a grade-hero block** inside `.game-modal-box`, before the existing `.game-modal-title` (so V2 can show the hero and hide the legacy stats):

```html
            <div class="grade-hero" id="gradeHero" style="display:none">
                <div class="nb-ribbon" id="nbRibbon" style="display:none">NEW BEST</div>
                <div class="grade-letter" id="gradeLetter">A</div>
                <div class="grade-points"><span id="gradePoints">0</span> pts</div>
                <div class="grade-stats">
                    <div>Accuracy <span id="gradeAcc">0%</span></div>
                    <div>Max combo <span id="gradeCombo">1&#215;</span></div>
                    <div>Longest streak <span id="gradeStreak">0</span></div>
                    <div>Perfects <span id="gradePerfects">0</span></div>
                    <div>Difficulty <span id="gradeDiff">MEDIUM</span></div>
                    <div>High score <span id="gradeHiscore">0</span></div>
                </div>
            </div>
```

- [ ] **Step 2: Wrap the legacy stats** so V2 can hide them — give the existing `.game-modal-title` + `.game-modal-score` + `.game-modal-stats` trio a wrapper `<div id="legacyEnd">…</div>` (set `display:none` from JS under V2). Keep `#benchmarkFeedback` and `.game-modal-actions` outside the wrapper (shared by both).

- [ ] **Step 3: Add CSS** to the `<style>` block:

```css
        .grade-hero { position: relative; margin-bottom: 22px; }
        .grade-letter {
            font-size: 5rem; font-weight: 900; line-height: 1;
            background: linear-gradient(135deg,#e040fb,#7c4dff,#00e676);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
        }
        .grade-points { font-size: 1.6rem; font-weight: 800; color: #00e676; margin-top: 4px; }
        .grade-stats { color: #aaa; font-size: 0.9rem; line-height: 1.9; margin-top: 14px; }
        .grade-stats span { color: #e6d6ff; font-weight: 700; }
        .nb-ribbon {
            position: absolute; top: -10px; right: -10px; transform: rotate(8deg);
            background: linear-gradient(90deg,#ff5252,#ff9800); color: #fff;
            font-weight: 900; font-size: 0.7rem; letter-spacing: 1.5px;
            padding: 4px 10px; border-radius: 8px; box-shadow: 0 0 14px #ff572eaa;
        }
```

- [ ] **Step 4: Commit**

```bash
git add static/player.html
git commit -m "feat(arcade): grade-hero end-screen markup + CSS"
```

### Task E2: Drive the end screen + high scores

**Files:**
- Modify: `static/player.js` (`showEndModal` ~2407)

- [ ] **Step 1: Rework `showEndModal`** — replace the method (~lines 2407-2418):

```javascript
    showEndModal() {
        var legacy = document.getElementById('legacyEnd');
        var hero = document.getElementById('gradeHero');
        var feedback = document.getElementById('benchmarkFeedback');
        document.getElementById('lrc-offset-control').style.display = 'none';

        var useArcade = window.KARAOKEE_V2 && this._arcadeState && window.KaraokeeArcade
            && window.KaraokeePhraseEngine;

        if (useArcade) {
            var summary = KaraokeeArcade.getArcadeSummary(this._arcadeState);
            var live = KaraokeePhraseEngine.getLiveScore(this._phraseSession);
            var pct = Math.round((live.lyrics || 0) * 100);
            var grade = KaraokeeArcade.gradeFor(pct);
            var diff = (this._phraseDifficulty || 'medium');

            // Per-song, per-difficulty high score.
            var key = 'hiscore_' + _songKey() + '_' + diff;
            var prev = parseInt(localStorage.getItem(key) || '0', 10) || 0;
            var isBest = summary.points > prev;
            if (isBest) localStorage.setItem(key, String(summary.points));

            document.getElementById('gradeLetter').textContent = grade;
            document.getElementById('gradePoints').textContent = String(summary.points);
            document.getElementById('gradeAcc').textContent = pct + '%';
            document.getElementById('gradeCombo').textContent = summary.maxMultiplier + '×';
            document.getElementById('gradeStreak').textContent = String(summary.longestStreak);
            document.getElementById('gradePerfects').textContent = String(summary.perfects);
            document.getElementById('gradeDiff').textContent = diff.toUpperCase();
            document.getElementById('gradeHiscore').textContent = String(Math.max(prev, summary.points));
            document.getElementById('nbRibbon').style.display = isBest ? 'block' : 'none';

            if (hero) hero.style.display = 'block';
            if (legacy) legacy.style.display = 'none';
        } else {
            // Legacy modal (V1 A/B). Guard against an empty run.
            if (!this.active || this.totalWords === 0) return;
            var lpct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
            document.getElementById('modalScore').textContent = lpct + '%';
            document.getElementById('modalWords').textContent = this.matchedWords + '/' + this.totalWords;
            document.getElementById('modalLines').textContent = this.perfectLines + '/' + this.linesScored;
            document.getElementById('modalStreak').textContent = this.bestStreak;
            if (hero) hero.style.display = 'none';
            if (legacy) legacy.style.display = 'block';
        }

        if (feedback) feedback.style.display = window._kDebug ? 'block' : 'none';
        document.getElementById('gameModal').style.display = 'flex';
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 3: Run all suites**

Run:
```bash
node tests/test_scoring_arcade.cjs && node tests/test_phrase_engine.cjs && node tests/test_phrase_score.cjs && node tests/test_scoring.cjs && node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs
python -m pytest tests/test_app.py -q
```
Expected: all pass.

- [ ] **Step 4: Verify in the browser** (V2 on) — play a song to the end. The grade hero shows the letter (off honest %), points, accuracy, max combo, longest streak, perfects, difficulty, and high score. Beating a prior run on the same difficulty shows **NEW BEST** and persists (reload → high score remembered). Toggle V off → the legacy modal shows instead. **Play Again** re-opens the difficulty gate.

- [ ] **Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): grade/high-score end screen driven by arcade summary"
```

---

## Validation Gate (unchanged — still blocking for the flag-flip)

Building Stages 2–3 behind the flag does **not** waive the human validation sing-test (spec §4.3/§8). Before flipping `karaokee_v2` to default-on (NOT in this plan): with V2 on + debug HUD on, confirm cheese (silence-on-speakers / humming / "yeah yeah yeah" / mumbling) never builds points or lifts the multiplier off x1, honest-but-sloppy scores fair, and Expert is visibly stricter than Easy. The live HUD makes the multiplier-never-leaves-x1-on-cheese property directly observable. **No automated test substitutes for this.**

---

## Self-Review

- **Spec coverage:** §3/§6 difficulty selection → Phase A (gate); §14 flow addendum → Phase A; §4.1 pure module → Phase B; §5 scoring model (base, ramp, streak rules, perfect, On Fire) → Phase B (`commitPhrase`) + tests; §4.2 commit-once at settled boundary → Phase C2; §6 floating HUD + bold On Fire → Phase D; §6 grade-hero end screen + high scores + NEW BEST → Phase E; §4.3 flag A/B → V2 guards in C2/D2/E2 (default headline unchanged); §8 validation gate → Validation section; §10 tunables → module constants; §12 perfect threshold → `PERFECT_THRESHOLD='all'` tunable + noted open item.
- **Placeholder scan:** every code/edit step contains complete code and exact commands. The `_onArcadeEvent` console version in C2 is intentionally interim and is fully replaced in D2 (noted in both).
- **Type/name consistency:** `_arcadeState`, `_committedPhrases`, `_phraseDifficulty`, `_phrasePlan`, `_phraseSession` (player.js); `createArcadeState`, `commitPhrase`, `getArcadeSummary`, `gradeFor`, `rampProgress`, `isPerfect`, `ARCADE_TUNING` (module, matching spec §4.1); DOM ids `#arcadeHud/#ahPoints/#ahMult/#ahRampFill/#ahStreak/#ahStreakVal/#ahFire` and `#gradeHero/#gradeLetter/#gradePoints/#gradeAcc/#gradeCombo/#gradeStreak/#gradePerfects/#gradeDiff/#gradeHiscore/#nbRibbon/#legacyEnd` consistent between the HTML tasks and the JS that reads them. `commitPhrase` outcome strings `'clear'|'miss'|'partial'` used consistently in tests and the renderer.

## Open Items

- **Perfect-phrase threshold (spec §12):** ships as `PERFECT_THRESHOLD='all'`; recalibrate against real honest-run telemetry once a corpus beyond `minimal-session.json` exists (record runs via the `D` export during validation).
- **Flag flip:** `karaokee_v2` stays default-off; flipping to default-on is a separate change after the validation sing-test passes.
