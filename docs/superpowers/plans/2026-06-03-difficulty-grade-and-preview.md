# Difficulty Grade Curve + Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the letter grade scale with difficulty (Easy aces near-automatically, Expert demands near-perfect) while the honest % stays the source of truth, and add a per-difficulty "what you must hit" preview to the difficulty gate.

**Architecture:** Phase 1 makes `gradeFor` in the pure `static/scoring-arcade.js` difficulty-aware via a cutoff table (+ updates its two `player.js` call sites and golden tests). Phase 2 adds `renderDifficultyPreview()` to `player.js` that builds a phrase plan per difficulty and highlights a sample song line's anchor words, wired to the gate cards. No change to matching, timing, the honest %, or the anti-cheese model.

**Tech Stack:** Plain ES5-style browser JS (string concatenation, no template literals), Node `.cjs` golden tests, Flask static serving. Author JS via Write/Edit directly (Windows backtick gotcha).

**Source spec:** [`docs/superpowers/specs/2026-06-03-difficulty-grade-and-preview-design.md`](../specs/2026-06-03-difficulty-grade-and-preview-design.md)

---

## File Structure

- **Modify `static/scoring-arcade.js`** — `gradeFor(pct)` → `gradeFor(pct, difficulty)` + `GRADE_CUTOFFS` table.
- **Modify `tests/test_scoring_arcade.cjs`** — update the grade block to the new medium defaults + per-difficulty + monotonicity cases.
- **Modify `static/player.js`** — pass difficulty at the two `gradeFor` call sites (Phase 1); add `renderDifficultyPreview` + gate wiring (Phase 2).
- **Modify `static/player.html`** — preview markup + CSS under the gate cards (Phase 2).

**Build order:** Phase 1 (grade curve — small, directly fixes the Easy-ace concern) → Phase 2 (preview).

---

## Phase 1 — Difficulty-aware grade curve

### Task 1: `gradeFor(pct, difficulty)` + tests

**Files:**
- Modify: `static/scoring-arcade.js` (`gradeFor` ~lines 127-133)
- Modify: `tests/test_scoring_arcade.cjs` (grade block ~lines 85-93)

- [ ] **Step 1: Update the golden tests** — replace the existing grade block (the 9 `arcade.gradeFor(...)` asserts, ~lines 85-93) with:

```javascript
// --- 8. Grade thresholds — difficulty-aware ('medium' is the default) ---
assert.strictEqual(arcade.gradeFor(90), 'S');            // medium S=87
assert.strictEqual(arcade.gradeFor(86), 'A');            // <87, >=73
assert.strictEqual(arcade.gradeFor(60), 'B');            // >=59
assert.strictEqual(arcade.gradeFor(45), 'C');            // >=45
assert.strictEqual(arcade.gradeFor(44), 'D');            // <45
// Easy aces low coverage; Expert is strict.
assert.strictEqual(arcade.gradeFor(93, 'easy'), 'S');    // easy S=80
assert.strictEqual(arcade.gradeFor(80, 'easy'), 'S');
assert.strictEqual(arcade.gradeFor(79, 'easy'), 'A');    // easy A=64
assert.strictEqual(arcade.gradeFor(32, 'easy'), 'C');    // easy C=32
assert.strictEqual(arcade.gradeFor(31, 'easy'), 'D');
assert.strictEqual(arcade.gradeFor(93, 'expert'), 'A');  // expert S=96 -> 93 is A (>=88)
assert.strictEqual(arcade.gradeFor(96, 'expert'), 'S');
assert.strictEqual(arcade.gradeFor(95, 'expert'), 'A');
// Monotonic: for a fixed pct, grade rank never improves as difficulty rises.
var gradeRank = { S: 5, A: 4, B: 3, C: 2, D: 1 };
['easy', 'medium', 'hard', 'expert'].reduce(function (prev, d) {
    var r = gradeRank[arcade.gradeFor(85, d)];
    assert.ok(r <= prev, 'grade for 85% is monotonic non-increasing across difficulty');
    return r;
}, 5);
```

- [ ] **Step 2: Run tests to verify they FAIL** (old single-ladder `gradeFor` still in place)

Run: `node tests/test_scoring_arcade.cjs`
Expected: FAIL on an `arcade.gradeFor(...)` assert (e.g. `gradeFor(93,'easy')` returns `A`, not `S`).

- [ ] **Step 3: Make `gradeFor` difficulty-aware** — replace the `gradeFor` function (~lines 127-133) in `static/scoring-arcade.js` with the cutoff table + new signature:

```javascript
    var GRADE_CUTOFFS = {
        easy:   { S: 80, A: 64, B: 48, C: 32 },
        medium: { S: 87, A: 73, B: 59, C: 45 },
        hard:   { S: 92, A: 81, B: 69, C: 56 },
        expert: { S: 96, A: 88, B: 77, C: 64 }
    };

    function gradeFor(pct, difficulty) {
        var c = GRADE_CUTOFFS[difficulty] || GRADE_CUTOFFS.medium;
        if (pct >= c.S) return 'S';
        if (pct >= c.A) return 'A';
        if (pct >= c.B) return 'B';
        if (pct >= c.C) return 'C';
        return 'D';
    }
```

- [ ] **Step 4: Run tests + syntax check**

Run: `node --check static/scoring-arcade.js && node tests/test_scoring_arcade.cjs`
Expected: `test_scoring_arcade.cjs: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add static/scoring-arcade.js tests/test_scoring_arcade.cjs
git commit -m "feat(arcade): difficulty-aware grade cutoffs (Easy aces; Expert strict)"
```

### Task 2: Pass difficulty at the call sites

**Files:**
- Modify: `static/player.js` (telemetry grade ~line 2360; `showEndModal` grade ~line 2612)

- [ ] **Step 1: Telemetry builder** — replace the line:

```javascript
        var grade = window.KaraokeeArcade ? KaraokeeArcade.gradeFor(honestLyricPct) : null;
```

with:

```javascript
        var grade = window.KaraokeeArcade ? KaraokeeArcade.gradeFor(honestLyricPct, this._phraseDifficulty || 'medium') : null;
```

- [ ] **Step 2: End screen** — replace the line:

```javascript
            var grade = KaraokeeArcade.gradeFor(pct);
```

with:

```javascript
            var grade = KaraokeeArcade.gradeFor(pct, this._phraseDifficulty || 'medium');
```

- [ ] **Step 3: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): grade end screen + telemetry by difficulty"
```

---

## Phase 2 — Difficulty preview on the gate

### Task 3: Preview markup + CSS

**Files:**
- Modify: `static/player.html` (inside `#diffGate`, after `#diffGateCards`; `<style>` block)

- [ ] **Step 1: Add the preview markup** — immediately after the `#diffGateCards` `</div>` (before the `.prep-status` div inside `#diffGate`):

```html
                <div class="diff-preview" id="diffPreview" style="display:none">
                    <div class="dp-line" id="dpLine"></div>
                    <div class="dp-caption" id="dpCaption"></div>
                </div>
```

- [ ] **Step 2: Add CSS** to the `<style>` block (after the `.diff-gate-listen` rule):

```css
        .diff-preview { max-width: 560px; margin: 2px auto 0; text-align: center; }
        .dp-line { font-size: 1.15rem; line-height: 1.8; }
        .dp-word { color: #4a4a5e; transition: color .15s; }            /* faint (non-key) */
        .dp-word.dp-anchor { color: #9a8fae; }                          /* key word, not a target */
        .dp-word.dp-target {                                            /* the notes to aim for */
            color: #fff; font-weight: 700;
            text-shadow: 0 0 8px #e040fb, 0 0 14px #7c4dff88;
        }
        .dp-caption { margin-top: 8px; font-size: 0.78rem; color: #9a8fae; letter-spacing: .3px; }
```

- [ ] **Step 3: Verify markup** — confirm `#diffPreview`, `#dpLine`, `#dpCaption` exist inside `#diffGate`.

- [ ] **Step 4: Commit**

```bash
git add static/player.html
git commit -m "feat(arcade): difficulty-preview markup + CSS on the gate"
```

### Task 4: `renderDifficultyPreview` + gate wiring

**Files:**
- Modify: `static/player.js` (`_markSelectedCard` region ~line 2885; `initDifficultyGate` ~line 2929; `initPrepOverlay` ~line 2939)

- [ ] **Step 1: Add `renderDifficultyPreview`** immediately after `_markSelectedCard` (~line 2890):

```javascript
// Show, per difficulty, a sample song line with its required "notes" (anchor words)
// highlighted — the top `anchorsRequired` anchors by weight are bright targets, other
// anchors dim, the rest faint. Illustrates the count; the engine accepts ANY of them.
function renderDifficultyPreview(d) {
    var box = document.getElementById('diffPreview');
    var lineEl = document.getElementById('dpLine');
    var capEl = document.getElementById('dpCaption');
    if (!box || !lineEl || !capEl) return;
    if (!lyrics || lyrics.length === 0 || !window.KaraokeePhraseEngine) { box.style.display = 'none'; return; }

    var plan;
    try {
        plan = KaraokeePhraseEngine.buildPhrasePlan(lyrics, {
            difficulty: d,
            audioDuration: (audio && isFinite(audio.duration)) ? audio.duration : null
        });
    } catch (e) { box.style.display = 'none'; return; }

    var phrases = (plan && plan.phrases) || [];
    if (!phrases.length) { box.style.display = 'none'; return; }
    // Representative phrase: first with >=4 words and >=2 anchors, else the longest.
    var phrase = null;
    for (var i = 0; i < phrases.length; i++) {
        if (phrases[i].words.length >= 4 && phrases[i].anchors.length >= 2) { phrase = phrases[i]; break; }
    }
    if (!phrase) {
        phrase = phrases[0];
        for (var j = 1; j < phrases.length; j++) {
            if (phrases[j].words.length > phrase.words.length) phrase = phrases[j];
        }
    }

    var anchorIdx = {};
    phrase.anchors.forEach(function (a) { anchorIdx[a.wordIdx] = true; });
    var byWeight = phrase.anchors.slice().sort(function (a, b) { return b.weight - a.weight; });
    var targetIdx = {};
    for (var t = 0; t < phrase.anchorsRequired && t < byWeight.length; t++) targetIdx[byWeight[t].wordIdx] = true;

    lineEl.innerHTML = '';
    phrase.words.forEach(function (w, wi) {
        var span = document.createElement('span');
        span.className = 'dp-word' + (targetIdx[wi] ? ' dp-target' : (anchorIdx[wi] ? ' dp-anchor' : ''));
        span.textContent = w + ' ';
        lineEl.appendChild(span);
    });

    var tolSec = ((plan.difficulty && plan.difficulty.timingToleranceMs) || 1000) / 1000;
    capEl.textContent = d.toUpperCase() + ' — hit any ' + phrase.anchorsRequired + ' of '
        + phrase.anchors.length + ' key words per line · ' + tolSec + 's timing window';
    box.style.display = 'block';
}
```

- [ ] **Step 2: Wire hover/focus + leave on the gate cards** — replace the `initDifficultyGate` IIFE (~lines 2929-2937) with one that also drives the preview:

```javascript
// Wire the gate cards once.
(function initDifficultyGate() {
    var cards = document.getElementById('diffGateCards');
    if (!cards) return;
    cards.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-diff]') : null;
        if (!btn) return;
        startRunWithDifficulty(btn.getAttribute('data-diff'));
    });
    function previewFrom(e) {
        var btn = e.target.closest ? e.target.closest('button[data-diff]') : null;
        if (btn) renderDifficultyPreview(btn.getAttribute('data-diff'));
    }
    cards.addEventListener('mouseover', previewFrom);
    cards.addEventListener('focusin', previewFrom);
    cards.addEventListener('mouseleave', function () {
        renderDifficultyPreview(localStorage.getItem('arcadeDifficulty') || 'medium');
    });
})();
```

- [ ] **Step 3: Paint the preview when the gate opens** — add a `renderDifficultyPreview(...)` call after the `_markSelectedCard(...)` line in **both** `openDifficultyGate` (~line 2898) and `initPrepOverlay` (~line 2943). In each, immediately after its `_markSelectedCard(localStorage.getItem('arcadeDifficulty') || 'medium');` line, add:

```javascript
    renderDifficultyPreview(localStorage.getItem('arcadeDifficulty') || 'medium');
```

(Note: `initPrepOverlay` only reaches that line when `lyrics.length > 0`, so the preview shows only when there are lyrics — correct.)

- [ ] **Step 4: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 5: Run all suites (no regressions)**

Run:
```bash
node tests/test_scoring_arcade.cjs && node tests/test_telemetry_helpers.cjs && node tests/test_phrase_engine.cjs && node tests/test_scoring.cjs && node tests/test_sync_helpers.cjs
python -m pytest tests/test_app.py -q
```
Expected: all pass.

- [ ] **Step 6: Verify in the browser** (`python app.py`, load a song): the gate shows a sample line; **Easy** lights ~1 bright target word, caption "EASY — hit any 1 of N key words · 1.4s timing window"; hovering **Expert** lights most of the line, caption "...hit any K of N... · 0.5s timing window". Start an Easy run to the end → end screen shows the honest % with **Grade S** (was A).

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(arcade): render per-difficulty note preview on the gate"
```

---

## Self-Review

- **Spec coverage:** §3 grade curve → Task 1 (table + `gradeFor`) + Task 2 (call sites incl. telemetry); §4 preview (per-difficulty, built from song, top-`anchorsRequired` bright targets, caption with count + timing, hover-swap, no-lyrics hide) → Tasks 3-4; §5 testing → Task 1 (grade cases + monotonicity) + Task 4 step 5/6. All mapped.
- **Placeholder scan:** every step has complete code/commands. No TBDs.
- **Type/name consistency:** `gradeFor(pct, difficulty)`, `GRADE_CUTOFFS`, `renderDifficultyPreview`, `#diffPreview`/`#dpLine`/`#dpCaption`, `.dp-word/.dp-anchor/.dp-target`, `phrase.anchors[].wordIdx`/`.weight`, `phrase.anchorsRequired`, `plan.difficulty.timingToleranceMs` all consistent and match the phrase-engine's actual shapes (`buildPhrasePlan` → `{difficulty, phrases:[{words, anchors:[{wordIdx, weight}], anchorsRequired}]}`).

## Open Items
- Grade cutoffs and the "bright target = top-N-by-weight" presentation are tunable (spec §7) — calibrate against a few runs per difficulty.
